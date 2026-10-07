import { useState, useEffect, useRef, useCallback } from 'react';
import { useStepCounter, useVisibility, useLightSensor, useCameraCheck } from './hooks';
import {
  completeSunSession, localGuidance, requestSolGuidance, sendSessionEvent, startSunSession,
  type SessionEvent, type SolGuidance,
} from './backend';
import {
  loadWallet, saveWallet, getSolStage, computeConfidence,
  CAP, STEP_BONUS_DIVISOR,
  type Wallet, type SessionLog,
} from './wallet';

const SITES: Record<string, string> = {
  Instagram: 'https://www.instagram.com/',
  TikTok: 'https://www.tiktok.com/',
  YouTube: 'https://www.youtube.com/',
};

type Tab = 'earn' | 'gate' | 'debrief' | 'spike';
type SessionPhase = 'idle' | 'suncheck' | 'conditions' | 'active' | 'complete';

export default function App() {
  const [tab, setTab] = useState<Tab>('earn');
  const [w, _setW] = useState<Wallet>(loadWallet);
  const setW = useCallback((fn: (prev: Wallet) => Wallet) => {
    _setW(prev => { const next = fn(prev); saveWallet(next); return next; });
  }, []);
  const [guidance, setGuidance] = useState<SolGuidance>(() => localGuidance(w));

  // ─── Sensors ───
  const stepper = useStepCounter();
  const vis = useVisibility();
  const light = useLightSensor();
  const camera = useCameraCheck();

  // ─── Session State ───
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [camLum, setCamLum] = useState<number | null>(null);
  const [workflowWarning, setWorkflowWarning] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const elapsedBeforeSegment = useRef(0);
  const activeSegmentStart = useRef(0);
  const workflowIdRef = useRef<string | null>(null);
  const workflowSetupRef = useRef<Promise<void>>(Promise.resolve());
  const workflowActionsRef = useRef<Promise<void>>(Promise.resolve());
  const currentMission = guidance.mission;

  // Elapsed timer during active session
  useEffect(() => {
    if (phase === 'active' && !isPaused) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((elapsedBeforeSegment.current + Date.now() - activeSegmentStart.current) / 1000));
      }, 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [phase, isPaused]);

  useEffect(() => {
    if (phase !== 'suncheck' || !camera.supported || !videoRef.current) return;
    let cancelled = false;
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;
    const video = videoRef.current;
    void camera.startCamera(video).then(ok => {
      if (cancelled) {
        if (ok) camera.stopCamera();
        return;
      }
      if (ok) {
        captureTimeout = setTimeout(() => {
          if (!cancelled) setCamLum(camera.measureLuminance());
        }, 3000);
      }
    });
    return () => {
      cancelled = true;
      if (captureTimeout) clearTimeout(captureTimeout);
    };
  }, [phase, camera.supported, camera.startCamera, camera.stopCamera, camera.measureLuminance]);

  const queueWorkflowEvent = (event: SessionEvent) => {
    workflowActionsRef.current = workflowActionsRef.current
      .then(async () => {
        await workflowSetupRef.current;
        const workflowId = workflowIdRef.current;
        if (workflowId) await sendSessionEvent(workflowId, event);
      })
      .catch(error => {
        console.warn('Temporal session event could not be recorded:', error);
        setWorkflowWarning('Durable session updates are unavailable; this session continues locally.');
      });
  };

  // ─── Session Flow ───
  const beginSunCheck = () => {
    if (camera.supported && videoRef.current) {
      void camera.startCamera(videoRef.current);
    }
    setPhase('suncheck');
    setCamLum(null);
    setWorkflowWarning(null);
    workflowIdRef.current = null;
    workflowActionsRef.current = Promise.resolve();
    workflowSetupRef.current = (async () => {
      const nextGuidance = await requestSolGuidance(w);
      setGuidance(nextGuidance);
      try {
        workflowIdRef.current = await startSunSession(nextGuidance);
      } catch (error) {
        console.warn('Temporal session unavailable; continuing locally:', error);
        setWorkflowWarning('Durable session unavailable; your Sun Session can still run locally.');
      }
    })();
  };

  const proceedToConditions = () => {
    camera.stopCamera();
    queueWorkflowEvent({
      type: 'sun-check',
      evidence: {
        cameraLum: camLum,
        lightLux: light.lux,
        confidence: computeConfidence(light.lux, camLum),
      },
    });
    setPhase('conditions');
  };

  const startActiveSession = () => {
    elapsedBeforeSegment.current = 0;
    activeSegmentStart.current = Date.now();
    setElapsed(0);
    setIsPaused(false);
    queueWorkflowEvent({ type: 'phone-down' });
    void stepper.start();
    vis.start();
    light.start();
    setPhase('active');
  };

  const pauseSession = () => {
    elapsedBeforeSegment.current += Date.now() - activeSegmentStart.current;
    setElapsed(Math.floor(elapsedBeforeSegment.current / 1000));
    stepper.stop();
    vis.stop();
    light.stop();
    setIsPaused(true);
    queueWorkflowEvent({ type: 'interrupted' });
  };

  const resumeSession = () => {
    activeSegmentStart.current = Date.now();
    void stepper.start(false);
    vis.start(false);
    light.start();
    setIsPaused(false);
    queueWorkflowEvent({ type: 'resumed' });
  };

  const completeSession = () => {
    if (!isPaused) elapsedBeforeSegment.current += Date.now() - activeSegmentStart.current;
    const durationMins = Math.max(0, Math.floor(elapsedBeforeSegment.current / 60000));
    stepper.stop();
    vis.stop();
    light.stop();
    clearInterval(timerRef.current);

    const earned = Math.min(durationMins, CAP - w.earnedToday);
    const scrollBonus = Math.floor(stepper.steps / STEP_BONUS_DIVISOR);
    const totalEarned = Math.min(earned + scrollBonus, CAP - w.earnedToday);
    const conf = computeConfidence(light.lux, camLum);
    const visData = vis.getSeconds();
    const xp = totalEarned * 2;

    const log: SessionLog = {
      duration: durationMins,
      earned: totalEarned,
      xp,
      conf,
      date: new Date().toLocaleString(),
      steps: stepper.supported ? stepper.steps : null,
      stepsSupported: stepper.supported,
      screenVisible: visData.visible,
      screenHidden: visData.hidden,
      lux: light.lux,
      cameraLum: camLum,
      mission: currentMission,
    };

    const newDebt = Math.max(0, w.sunDebt - totalEarned);
    const debtPaid = w.sunDebt - newDebt;
    const afterDebt = totalEarned - debtPaid;

    setW(prev => ({
      ...prev,
      sunMinutes: prev.sunMinutes + afterDebt,
      sunDebt: newDebt,
      earnedToday: prev.earnedToday + totalEarned,
      solXP: prev.solXP + xp,
      sessions: [log, ...prev.sessions].slice(0, 20),
    }));
    setGuidance(localGuidance({ ...w, sessions: [log, ...w.sessions] }));

    workflowActionsRef.current = workflowActionsRef.current
      .then(async () => {
        await workflowSetupRef.current;
        const workflowId = workflowIdRef.current;
        if (workflowId) {
          await completeSunSession(workflowId, {
            durationMinutes: durationMins,
            steps: stepper.supported ? stepper.steps : null,
            earnedToday: w.earnedToday,
            sunDebt: w.sunDebt,
          });
        }
      })
      .catch(error => {
        console.warn('Temporal reward could not be recorded; local reward was applied:', error);
        setWorkflowWarning('The durable reward record is unavailable; your local Sun Minutes and Sol XP were saved.');
      });

    setPhase('idle');
    setIsPaused(false);
    setTab('debrief');
  };

  // ─── Gate State ───
  const [gateApp, setGateApp] = useState('');
  const [gateStep, setGateStep] = useState(0); // 0=pick, 1=breathe, 2=rotate, 3=choose
  const [breathCount, setBreathCount] = useState(10);
  const [gateSpend, setGateSpend] = useState(1);
  const [rotStatus, setRotStatus] = useState<'waiting' | 'done' | 'skip'>('waiting');

  const openGate = (app: string) => {
    if (w.sunMinutes < 1) return;
    setGateApp(app);
    setGateStep(1);
    setBreathCount(10);
    setGateSpend(1);
    setRotStatus('waiting');
  };

  // Breathing countdown
  useEffect(() => {
    if (gateStep !== 1) return;
    const iv = setInterval(() => {
      setBreathCount(c => {
        if (c <= 1) { clearInterval(iv); setGateStep(2); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [gateStep]);

  // Rotation check
  useEffect(() => {
    if (gateStep !== 2) return;
    setRotStatus('waiting');
    let a0: number | null = null;
    let resolved = false;
    const handler = (e: DeviceOrientationEvent) => {
      if (resolved) return;
      if (e.alpha === null) { setRotStatus('skip'); resolved = true; return; }
      if (a0 === null) { a0 = e.alpha; return; }
      let d = Math.abs(e.alpha - a0);
      if (d > 180) d = 360 - d;
      if (d >= 90) { setRotStatus('done'); resolved = true; setGateStep(3); }
    };
    window.addEventListener('deviceorientation', handler);
    const timeout = setTimeout(() => { if (!resolved) { setRotStatus('skip'); resolved = true; } }, 5000);
    return () => { window.removeEventListener('deviceorientation', handler); clearTimeout(timeout); };
  }, [gateStep]);

  const spendAndGo = () => {
    const spend = Math.min(gateSpend, w.sunMinutes);
    setW(prev => ({
      ...prev,
      sunMinutes: prev.sunMinutes - spend,
      spentToday: prev.spentToday + spend,
      sunDebt: prev.spentToday + spend > prev.earnedToday ? (prev.spentToday + spend - prev.earnedToday) : prev.sunDebt,
      gateLog: [{ app: gateApp, mins: spend, date: new Date().toLocaleString() }, ...prev.gateLog].slice(0, 30),
    }));
    setGateStep(0);
    window.open(SITES[gateApp], '_blank');
  };

  // ─── Spike State ───
  const [spikeLog, setSpikeLog] = useState<string[]>([]);
  const addLog = (msg: string) => setSpikeLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));

  const testCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      addLog('Camera: ✅ stream acquired');
      stream.getTracks().forEach(t => t.stop());
    } catch (e: any) { addLog(`Camera: ❌ ${e.message}`); }
  };
  const testMotion = () => {
    if (typeof DeviceMotionEvent === 'undefined') return addLog('DeviceMotion: ❌ unsupported');
    const h = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      addLog(`DeviceMotion: ✅ x=${a?.x?.toFixed(1)} y=${a?.y?.toFixed(1)} z=${a?.z?.toFixed(1)}`);
      window.removeEventListener('devicemotion', h);
    };
    window.addEventListener('devicemotion', h);
    setTimeout(() => addLog('DeviceMotion: ⏳ waiting for event…'), 100);
  };
  const testOrientation = () => {
    if (typeof DeviceOrientationEvent === 'undefined') return addLog('DeviceOrientation: ❌ unsupported');
    const h = (e: DeviceOrientationEvent) => {
      addLog(`DeviceOrientation: ✅ α=${e.alpha?.toFixed(0)} β=${e.beta?.toFixed(0)} γ=${e.gamma?.toFixed(0)}`);
      window.removeEventListener('deviceorientation', h);
    };
    window.addEventListener('deviceorientation', h);
    setTimeout(() => addLog('DeviceOrientation: ⏳ waiting…'), 100);
  };
  const testLight = () => {
    if (!('AmbientLightSensor' in window)) return addLog('AmbientLight: ❌ unsupported');
    try {
      // @ts-ignore
      const s = new AmbientLightSensor({ frequency: 1 });
      s.addEventListener('reading', () => { addLog(`AmbientLight: ✅ ${s.illuminance} lux`); s.stop(); });
      s.addEventListener('error', (e: any) => addLog(`AmbientLight: ❌ ${e.error.message}`));
      s.start();
    } catch (e: any) { addLog(`AmbientLight: ❌ ${e.message}`); }
  };
  const testAudio = () => {
    try {
      const ctx = new AudioContext();
      addLog(`WebAudio: ✅ state=${ctx.state} sampleRate=${ctx.sampleRate}`);
      ctx.close();
    } catch (e: any) { addLog(`WebAudio: ❌ ${e.message}`); }
  };
  const testVisibility = () => {
    addLog(`PageVisibility: ✅ hidden=${document.hidden} state=${document.visibilityState}`);
  };

  // ─── Renders ───
  const sol = getSolStage(w.solXP);
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Session overlay
  if (phase === 'suncheck') {
    return (
      <div className="session-overlay suncheck-bg">
        <h2>Sun Check</h2>
        <p className="sub" style={{ position: 'relative', zIndex: 2 }}>
          {camera.supported ? 'Point your camera toward the sky for 3 seconds.' : 'Camera unavailable. We\'ll credit your time.'}
        </p>
        <p className="note" style={{ position: 'relative', zIndex: 2 }}>
          Sensor readings are optional context, not proof that you are outdoors or a health measurement.
        </p>
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', maxWidth: 300, borderRadius: 16, position: 'relative', zIndex: 2, display: camera.supported ? 'block' : 'none' }} />
        {camera.error && (
          <p className="note" style={{ position: 'relative', zIndex: 2 }}>
            Camera unavailable ({camera.error}). You can continue without it.
          </p>
        )}
        {camLum !== null && (
          <p style={{ position: 'relative', zIndex: 2, marginTop: 16 }}>
            Luminance: <b>{camLum.toFixed(0)}</b>/255 {camLum > 180 ? '— bright ☀️' : camLum > 100 ? '— moderate' : '— low'}
          </p>
        )}
        <button onClick={proceedToConditions} style={{ marginTop: 24, position: 'relative', zIndex: 2 }}>
          {camLum !== null || !camera.supported ? 'Continue' : 'Skip Check'}
        </button>
      </div>
    );
  }

  if (phase === 'conditions') {
    return (
      <div className="session-overlay">
        <h2>Before You Go</h2>
        <div className="card" style={{ textAlign: 'left', maxWidth: 340, margin: '24px auto', background: 'rgba(255,255,255,0.3)' }}>
          <p style={{ margin: 0 }}>🌿 <b>Mission:</b> {currentMission}</p>
          <p style={{ margin: '8px 0 0' }}>Suggested duration: <b>{guidance.recommendedDurationMinutes} minutes</b></p>
          <p style={{ margin: '8px 0 0' }}>{guidance.motivation}</p>
        </div>
        {guidance.source === 'fallback' && (
          <p className="note">Sol is using a deterministic offline mission.</p>
        )}
        {workflowWarning && <p className="note">{workflowWarning}</p>}
        <p className="note">Step estimates may need device permission and are optional; the session works without them.</p>
        <p className="sub" style={{ position: 'relative', zIndex: 2 }}>
          Your timer starts now. Put the phone down and enjoy the outdoors. Sensor readings are optional and do not verify exposure.
        </p>
        <button className="primary" onClick={startActiveSession} style={{ marginTop: 24, position: 'relative', zIndex: 2 }}>
          Start Session
        </button>
      </div>
    );
  }

  if (phase === 'active') {
    return (
      <div className="session-overlay">
        <div className="session-sun-icon">☀️</div>
        <h1>PUT YOUR PHONE AWAY.</h1>
        <p>GO GET SOME FRESH AIR.</p>
        <div className="session-timer">{fmtTime(elapsed)}</div>
        {isPaused && <p className="note">Session paused. Resume when you are ready to continue.</p>}
        {workflowWarning && <p className="note">{workflowWarning}</p>}
        {light.error && <p className="note">Ambient light reading unavailable: {light.error}</p>}
        <button onClick={isPaused ? resumeSession : pauseSession} style={{ position: 'relative', zIndex: 2, marginTop: 32 }}>
          {isPaused ? 'Resume Session' : 'Pause Session'}
        </button>
        <button onClick={completeSession} style={{ position: 'relative', zIndex: 2, marginTop: 12 }}>
          Complete Session
        </button>
      </div>
    );
  }

  return (
    <>
      <main>
        <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" style={{ display: 'none' }} />
        <header className="app-header">
          <img src="/icon.svg" alt="SUNDEBT" className="app-logo" />
          <h1>SUNDEBT</h1>
          <p className="sub">Earn Your Screen Time.</p>
        </header>

        {/* ─── DASHBOARD ─── */}
        {tab === 'earn' && (
          <section className="page-section">
            <div className="sun-balance-container">
              <div className="sun-orb">
                <b>{w.sunMinutes.toFixed(0)}</b>
                <span>Sun Minutes</span>
              </div>
            </div>

            <div className="metrics-row">
              <div className="metric">
                <b>{w.earnedToday}</b>
                <span>Earned</span>
              </div>
              <div className="metric">
                <b>{w.spentToday}</b>
                <span>Spent</span>
              </div>
              <div className="metric">
                <b className={w.sunDebt > 0 ? 'debt-color' : ''}>{w.sunDebt}</b>
                <span>Debt</span>
              </div>
            </div>

            <div className="card sol-card">
              <div className="sol-avatar">{sol.emoji}</div>
              <div className="sol-info">
                <h3>Sol · {sol.name}</h3>
                <p className="sub">{sol.desc}</p>
                <div className="xp-bar-track">
                  <div className="xp-bar-fill" style={{ width: `${Math.min(100, (w.solXP / 250) * 100)}%` }} />
                </div>
                <p className="xp-label">{w.solXP} XP</p>
              </div>
            </div>

            <div className="card mission-card">
              <span className="mission-tag">Today's Mission</span>
              <p className="mission-text">{currentMission}</p>
            </div>

            <div className="action-buttons">
              <button className="primary" onClick={beginSunCheck}>☀️ GET SUN</button>
              <button className="secondary" onClick={() => setTab('gate')}>🔓 USE MY MINUTES</button>
            </div>

            <div className="limitations">
              <b>Web Limitations:</b> Browser sensors may be unavailable or paused in the background.
              We cannot block other apps system-wide. Step counts are estimates from DeviceMotion.
              Sensor evidence is not medical or scientific proof of sunlight exposure.
              Unsupported capabilities are never faked.
            </div>
          </section>
        )}

        {/* ─── SCROLL GATE ─── */}
        {tab === 'gate' && (
          <section className="page-section">
            {gateStep === 0 ? (
              <>
                <div className="section-header">
                  <h2>Scroll Gate</h2>
                  <p className="sub">
                    Web-level friction, not system-wide blocking.<br />
                    Balance: <b>{w.sunMinutes} mins</b>
                  </p>
                </div>
                <div className="gate-apps">
                  {Object.keys(SITES).map(app => (
                    <button
                      key={app}
                      className="secondary gate-btn"
                      disabled={w.sunMinutes < 1}
                      onClick={() => openGate(app)}
                    >
                      {app}
                    </button>
                  ))}
                </div>
                {w.sunMinutes < 1 && (
                  <p className="sub" style={{ textAlign: 'center', marginTop: 16 }}>
                    No minutes available. <b onClick={() => setTab('earn')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Go earn some sun.</b>
                  </p>
                )}
                {w.gateLog.length > 0 && (
                  <div className="card" style={{ marginTop: 24 }}>
                    <h3>Recent Usage</h3>
                    {w.gateLog.slice(0, 5).map((g, i) => (
                      <p key={i} className="sub">{g.app} — {g.mins} min — {g.date}</p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="gate-flow">
                {gateStep === 1 && (
                  <div className="gate-step-content">
                    <h3>Breathe.</h3>
                    <p className="sub">Slow down before you scroll.</p>
                    <div className="breath-circle" style={{ transform: breathCount % 4 < 2 ? 'scale(1.15)' : 'scale(1)' }}>
                      {breathCount}
                    </div>
                  </div>
                )}
                {gateStep === 2 && (
                  <div className="gate-step-content">
                    <h3>Rotate Phone 90°</h3>
                    <p className="sub">A small physical check.</p>
                    {rotStatus === 'skip' && (
                      <>
                        <p className="note" style={{ color: 'var(--amber)', marginTop: 24 }}>
                          Orientation unavailable or timed out.
                        </p>
                        <button className="secondary" onClick={() => setGateStep(3)} style={{ marginTop: 16 }}>
                          Continue Anyway
                        </button>
                      </>
                    )}
                  </div>
                )}
                {gateStep === 3 && (
                  <div className="gate-step-content">
                    <h3>How long?</h3>
                    <p className="sub">Choose minutes of {gateApp}.</p>
                    <div className="gate-spend-display">{gateSpend}</div>
                    <input
                      type="range"
                      min="1"
                      max={Math.max(1, w.sunMinutes)}
                      value={gateSpend}
                      onChange={e => setGateSpend(+e.target.value)}
                      className="gate-slider"
                    />
                    <button className="primary" onClick={spendAndGo} style={{ marginTop: 24 }}>
                      Unlock {gateApp}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ─── DEBRIEF ─── */}
        {tab === 'debrief' && (
          <section className="page-section">
            <div className="section-header">
              <h2>Session Debrief</h2>
              <p className="sub">Welcome back.</p>
            </div>
            {workflowWarning && <div className="card note" role="status">{workflowWarning}</div>}
            {w.sessions.length === 0 ? (
              <div className="card" style={{ textAlign: 'center' }}>
                <p className="sol-avatar" style={{ margin: '0 auto 16px', fontSize: 48 }}>🌱</p>
                <p className="sub">No sessions yet.</p>
                <button className="primary" onClick={() => setTab('earn')} style={{ marginTop: 16 }}>Go Earn Sun Minutes</button>
              </div>
            ) : (() => {
              const last = w.sessions[0];
              return (
                <>
                  <div className="debrief-hero">
                    <div className="debrief-number">+{last.earned}</div>
                    <div className="debrief-label">Sun Minutes Earned</div>
                    <div className="debrief-number secondary-number">{last.duration}</div>
                    <div className="debrief-label">Minutes in Session</div>
                  </div>

                  <div className="card debrief-details">
                    <div className="debrief-row">
                      <span>Steps</span>
                      <b>{last.stepsSupported ? `~${last.steps} (estimated)` : 'Unavailable'}</b>
                    </div>
                    <div className="debrief-row">
                      <span>Sensor Evidence</span>
                      <b className={last.conf === 'unavailable' ? 'muted' : ''}>
                        {last.conf === 'confirmed' ? 'bright reading (not proof)' : last.conf}
                      </b>
                    </div>
                    <div className="debrief-row">
                      <span>Sol XP</span>
                      <b>+{last.xp}</b>
                    </div>
                    <div className="debrief-row">
                      <span>Screen Visible</span>
                      <b>{last.screenVisible}s</b>
                    </div>
                    <div className="debrief-row">
                      <span>Screen Hidden</span>
                      <b>{last.screenHidden}s</b>
                    </div>
                    <div className="debrief-row">
                      <span>Mission</span>
                      <b style={{ textAlign: 'right', maxWidth: '60%' }}>{last.mission}</b>
                    </div>
                    {last.lux !== null && (
                      <div className="debrief-row">
                        <span>Ambient Lux</span>
                        <b>{last.lux.toFixed(0)}</b>
                      </div>
                    )}
                    {last.cameraLum !== null && (
                      <div className="debrief-row">
                        <span>Camera Luminance</span>
                        <b>{last.cameraLum.toFixed(0)}/255</b>
                      </div>
                    )}
                  </div>

                  {w.sessions.length > 1 && (
                    <div className="card" style={{ marginTop: 16 }}>
                      <h3>History</h3>
                      {w.sessions.slice(1, 6).map((s, i) => (
                        <p key={i} className="sub">
                          {s.date} — {s.duration} min — +{s.earned} SM — {s.conf === 'confirmed' ? 'bright reading (not proof)' : s.conf}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </section>
        )}

        {/* ─── SPIKE ─── */}
        {tab === 'spike' && (
          <section className="page-section">
            <div className="section-header">
              <h2>Diagnostic Spike</h2>
              <p className="sub">Test real browser capabilities before relying on them.</p>
            </div>
            <div className="spike-grid">
              <button className="secondary" onClick={testCamera}>📷 Camera</button>
              <button className="secondary" onClick={testMotion}>📱 DeviceMotion</button>
              <button className="secondary" onClick={testOrientation}>🧭 DeviceOrientation</button>
              <button className="secondary" onClick={testLight}>💡 AmbientLight</button>
              <button className="secondary" onClick={testAudio}>🔊 Web Audio</button>
              <button className="secondary" onClick={testVisibility}>👁 Page Visibility</button>
            </div>
            <div className="spike-log">
              {spikeLog.length === 0 ? (
                <p className="sub">Tap a button above to test.</p>
              ) : (
                spikeLog.map((line, i) => <div key={i}>{line}</div>)
              )}
            </div>
          </section>
        )}
      </main>

      <nav>
        {([
          { id: 'earn' as Tab, icon: '☀️', label: 'Earn' },
          { id: 'gate' as Tab, icon: '🔓', label: 'Gate' },
          { id: 'debrief' as Tab, icon: '📊', label: 'Debrief' },
          { id: 'spike' as Tab, icon: '🧪', label: 'Spike' },
        ]).map(t => (
          <button key={t.id} className={`nav-btn ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            <span className="nav-icon">{t.icon}</span>
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
