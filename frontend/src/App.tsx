import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Camera, Compass, Eye, Leaf, Lightbulb,
  LockKeyhole, Smartphone, Sprout, Sun, Volume2,
} from 'lucide-react';
import { useStepCounter, useVisibility, useLightSensor, useCameraCheck } from './hooks';
import {
  completeSunSession, createMissionContext, localGuidance, sendSessionEvent, startSunSession,
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

const BRAND_ART = {
  earn: '/assets/sundebt/sundebt-earn.png',
  gate: '/assets/sundebt/sundebt-gate.png',
  spike: '/assets/sundebt/sundebt-spike.png',
  debrief: '/assets/sundebt/sundebt-debrief.png',
} as const;

function BrandArtwork({ kind, alt }: { kind: keyof typeof BRAND_ART; alt: string }) {
  return <img className={`brand-art brand-art-${kind}`} src={BRAND_ART[kind]} alt={alt} />;
}

const FALLING_LEAVES = [
  ['01', 'leaf-a'],
  ['02', 'leaf-b'],
  ['03', 'leaf-c'],
  ['04', 'leaf-d'],
  ['05', 'leaf-e'],
  ['01', 'leaf-f'],
  ['03', 'leaf-g'],
  ['04', 'leaf-h'],
  ['02', 'leaf-i'],
  ['05', 'leaf-j'],
  ['01', 'leaf-k'],
] as const;

function FallingLeaves() {
  return (
    <div className="falling-leaves" aria-hidden="true">
      {FALLING_LEAVES.map(([asset, position]) => (
        <img
          key={position}
          className={`falling-leaf ${position}`}
          src={`/assets/sundebt/sundebt-leaf-${asset}.png`}
          alt=""
        />
      ))}
      <img className="falling-sparkle sparkle-a" src="/assets/sundebt/sundebt-sparkle-01.png" alt="" />
      <img className="falling-sparkle sparkle-b" src="/assets/sundebt/sundebt-sparkle-01.png" alt="" />
    </div>
  );
}

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
  const [startPending, setStartPending] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const elapsedBeforeSegment = useRef(0);
  const activeSegmentStart = useRef(0);
  const workflowSetupRef = useRef<Promise<string | null>>(Promise.resolve(null));
  const workflowActionsRef = useRef<Promise<void>>(Promise.resolve());
  const missionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const missionResolvedRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const currentMission = guidance.mission;

  useEffect(() => () => clearTimeout(missionTimerRef.current), []);

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
    const setup = workflowSetupRef.current;
    workflowActionsRef.current = workflowActionsRef.current
      .then(async () => {
        const workflowId = await setup;
        if (workflowId) await sendSessionEvent(workflowId, event);
      })
      .catch(error => {
        console.warn('Temporal session event could not be recorded:', error);
        setWorkflowWarning('Durable session updates are unavailable; this session continues locally.');
      });
  };

  // ─── Session Flow ───
  const beginSunCheck = () => {
    if (sessionIdRef.current || startPending) return;
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    setStartPending(true);
    if (camera.supported && videoRef.current) {
      void camera.startCamera(videoRef.current);
    }
    setPhase('suncheck');
    setCamLum(null);
    setWorkflowWarning(null);
    workflowActionsRef.current = Promise.resolve();
    missionResolvedRef.current = false;
    sessionStartedRef.current = false;
    clearTimeout(missionTimerRef.current);
    missionTimerRef.current = setTimeout(() => {
      if (!missionResolvedRef.current && !sessionStartedRef.current) {
        setGuidance(localGuidance(w));
        missionResolvedRef.current = true;
      }
    }, 20_000);
    workflowSetupRef.current = (async () => {
      try {
        const result = await startSunSession(sessionId, createMissionContext(w));
        if (result.guidance && !missionResolvedRef.current && !sessionStartedRef.current) {
          clearTimeout(missionTimerRef.current);
          setGuidance(result.guidance);
          missionResolvedRef.current = true;
        }
        return result.workflowId;
      } catch (error) {
        console.warn('Temporal session unavailable; continuing locally:', error);
        setWorkflowWarning('Durable session unavailable; your Sun Session can still run locally.');
        return null;
      } finally {
        setStartPending(false);
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
    if (!missionResolvedRef.current) {
      clearTimeout(missionTimerRef.current);
      setGuidance(localGuidance(w));
      missionResolvedRef.current = true;
    }
    sessionStartedRef.current = true;
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

    const setup = workflowSetupRef.current;
    workflowActionsRef.current = workflowActionsRef.current
      .then(async () => {
        const workflowId = await setup;
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

    sessionIdRef.current = null;
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
  const sensorError = (error: unknown) => {
    const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
    return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission denied' : 'failed';
  };

  const testCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return addLog('Camera: ❌ unsupported');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      addLog('Camera: ✅ stream acquired');
      stream.getTracks().forEach(t => t.stop());
    } catch (error) {
      addLog(`Camera: ❌ ${sensorError(error)}${error instanceof Error ? ` (${error.message})` : ''}`);
    }
  };
  const testMotion = async () => {
    if (typeof DeviceMotionEvent === 'undefined') return addLog('DeviceMotion: ❌ unsupported');
    const permissionAwareEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (permissionAwareEvent.requestPermission) {
      try {
        if (await permissionAwareEvent.requestPermission() !== 'granted') {
          addLog('DeviceMotion: ❌ permission denied');
          return;
        }
      } catch (error) {
        addLog(`DeviceMotion: ❌ ${sensorError(error)}`);
        return;
      }
    }
    let resolved = false;
    const h = (e: DeviceMotionEvent) => {
      resolved = true;
      const a = e.accelerationIncludingGravity;
      addLog(`DeviceMotion: ✅ x=${a?.x?.toFixed(1)} y=${a?.y?.toFixed(1)} z=${a?.z?.toFixed(1)}`);
      window.removeEventListener('devicemotion', h);
    };
    window.addEventListener('devicemotion', h);
    setTimeout(() => {
      if (!resolved) {
        window.removeEventListener('devicemotion', h);
        addLog('DeviceMotion: ❌ failed (no event received)');
      }
    }, 5_000);
  };
  const testOrientation = async () => {
    if (typeof DeviceOrientationEvent === 'undefined') return addLog('DeviceOrientation: ❌ unsupported');
    const permissionAwareEvent = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (permissionAwareEvent.requestPermission) {
      try {
        if (await permissionAwareEvent.requestPermission() !== 'granted') {
          addLog('DeviceOrientation: ❌ permission denied');
          return;
        }
      } catch (error) {
        addLog(`DeviceOrientation: ❌ ${sensorError(error)}`);
        return;
      }
    }
    let resolved = false;
    const h = (e: DeviceOrientationEvent) => {
      resolved = true;
      addLog(`DeviceOrientation: ✅ α=${e.alpha?.toFixed(0)} β=${e.beta?.toFixed(0)} γ=${e.gamma?.toFixed(0)}`);
      window.removeEventListener('deviceorientation', h);
    };
    window.addEventListener('deviceorientation', h);
    setTimeout(() => {
      if (!resolved) {
        window.removeEventListener('deviceorientation', h);
        addLog('DeviceOrientation: ❌ failed (no event received)');
      }
    }, 5_000);
  };
  const testLight = () => {
    if (!('AmbientLightSensor' in window)) return addLog('AmbientLight: ❌ unsupported');
    try {
      // @ts-ignore
      const s = new AmbientLightSensor({ frequency: 1 });
      s.addEventListener('reading', () => { addLog(`AmbientLight: ✅ ${s.illuminance} lux`); s.stop(); });
      s.addEventListener('error', (event: Event) => {
        const sensorEvent = event as Event & { error?: DOMException };
        addLog(`AmbientLight: ❌ ${sensorError(sensorEvent.error)}${sensorEvent.error?.message ? ` (${sensorEvent.error.message})` : ''}`);
      });
      s.start();
    } catch (error) {
      addLog(`AmbientLight: ❌ ${sensorError(error)}${error instanceof Error ? ` (${error.message})` : ''}`);
    }
  };
  const testAudio = () => {
    if (!('AudioContext' in window)) return addLog('WebAudio: ❌ unsupported');
    try {
      const ctx = new AudioContext();
      addLog(`WebAudio: ✅ state=${ctx.state} sampleRate=${ctx.sampleRate}`);
      ctx.close();
    } catch (error) {
      addLog(`WebAudio: ❌ ${sensorError(error)}${error instanceof Error ? ` (${error.message})` : ''}`);
    }
  };
  const testVisibility = () => {
    addLog(`PageVisibility: ✅ hidden=${document.hidden} state=${document.visibilityState}`);
  };
  const sensorChecks = [
    { key: 'Camera', label: 'Camera', icon: Camera, test: testCamera },
    { key: 'DeviceMotion', label: 'Motion', icon: Smartphone, test: testMotion },
    { key: 'DeviceOrientation', label: 'Orientation', icon: Compass, test: testOrientation },
    { key: 'AmbientLight', label: 'Light', icon: Lightbulb, test: testLight },
    { key: 'WebAudio', label: 'Audio', icon: Volume2, test: testAudio },
    { key: 'PageVisibility', label: 'Visibility', icon: Eye, test: testVisibility },
  ];
  const sensorStatus = (key: string) => {
    const latest = spikeLog.find(line => line.includes(`] ${key}:`));
    if (!latest) return { label: 'Not tested', className: 'untested' };
    if (latest.includes('✅')) return { label: 'Available', className: 'available' };
    if (latest.includes('permission denied')) return { label: 'Permission needed', className: 'permission' };
    if (latest.includes('unsupported')) return { label: 'Unavailable', className: 'unavailable' };
    return { label: 'Needs attention', className: 'attention' };
  };
  const runAllChecks = async () => {
    setSpikeLog([]);
    await testCamera();
    await testMotion();
    await testOrientation();
    testLight();
    testAudio();
    testVisibility();
  };
  const testedCount = sensorChecks.filter(sensor => sensorStatus(sensor.key).className !== 'untested').length;

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
        {!missionResolvedRef.current && <p className="note" style={{ position: 'relative', zIndex: 2 }}>Sol is thinking…</p>}
        <BrandArtwork kind="earn" alt="" />
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', maxWidth: 300, borderRadius: 16, position: 'relative', zIndex: 2, display: camera.supported ? 'block' : 'none' }} />
        {camera.error && (
          <p className="note" style={{ position: 'relative', zIndex: 2 }}>
            Camera unavailable ({camera.error}). You can continue without it.
          </p>
        )}
        {camLum !== null && (
          <p style={{ position: 'relative', zIndex: 2, marginTop: 16 }}>
            Luminance: <b>{camLum.toFixed(0)}</b>/255 {camLum > 180 ? '— bright' : camLum > 100 ? '— moderate' : '— low'}
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
        <BrandArtwork kind="earn" alt="" />
        <div className="card" style={{ textAlign: 'left', maxWidth: 340, margin: '24px auto', background: 'rgba(255,255,255,0.3)' }}>
          <p style={{ margin: 0 }}><Leaf size={16} strokeWidth={1.8} className="inline-icon" aria-hidden="true" /> <b>Mission:</b> {currentMission}</p>
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
        <div className="session-sun-icon" aria-hidden="true"><Sun size={74} strokeWidth={1.2} /></div>
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
      <main
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const shift = ((event.clientX - bounds.left) / bounds.width - 0.5) * 10;
          event.currentTarget.style.setProperty('--pointer-shift', `${shift.toFixed(1)}px`);
        }}
      >
        <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" style={{ display: 'none' }} />
        <FallingLeaves />
        <header className="app-header">
          <img src="/assets/sundebt/sundebt-logo.png" alt="SUNDEBT" className="app-logo" />
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
              <div className="sol-avatar" aria-hidden="true"><Sprout size={30} strokeWidth={1.5} /></div>
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
              <div className="mission-heading">
                <span className="mission-tag">Today's Mission</span>
                <span className={`source-badge ${guidance.source}`}>
                  {guidance.source === 'ai' ? 'Sol · AI' : 'Offline mission'}
                </span>
              </div>
              <p className="mission-text">{currentMission}</p>
            </div>

            <div className="action-buttons">
              <button className="primary" onClick={beginSunCheck} disabled={startPending}>
                {startPending ? 'Starting Session…' : <><Sun size={17} strokeWidth={1.8} /> GET SUN</>}
              </button>
              <button className="secondary" onClick={() => setTab('gate')}><LockKeyhole size={16} strokeWidth={1.8} /> USE MY MINUTES</button>
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
                <BrandArtwork kind="gate" alt="Illustration of a botanical threshold" />
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
            <BrandArtwork kind="debrief" alt="Illustration of a field-journal debrief" />
            {workflowWarning && <div className="card note" role="status">{workflowWarning}</div>}
            {w.sessions.length === 0 ? (
              <div className="card" style={{ textAlign: 'center' }}>
                <p className="sol-avatar" style={{ margin: '0 auto 16px' }} aria-hidden="true"><Sprout size={42} strokeWidth={1.4} /></p>
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
              <p className="sub">See what your browser can contribute to a Sun Session.</p>
            </div>
            <BrandArtwork kind="spike" alt="Illustration of a sunlit sensor crystal" />
            <div className="spike-intro card">
              <div>
                <b>{testedCount === sensorChecks.length ? 'Ready for a Sun Session' : 'Sensor readiness'}</b>
                <p className="sub">Optional evidence only — sensors never prove that you are outdoors.</p>
              </div>
              <span className="spike-count">{testedCount}/{sensorChecks.length}</span>
            </div>
            <div className="spike-actions">
              <button className="primary" onClick={() => void runAllChecks()}>
                Run all checks
              </button>
              <button className="secondary" onClick={() => setSpikeLog([])} disabled={spikeLog.length === 0}>
                Clear results
              </button>
            </div>
            <div className="spike-grid">
              {sensorChecks.map(sensor => {
                const Icon = sensor.icon;
                const status = sensorStatus(sensor.key);
                return (
                  <button key={sensor.key} className={`sensor-check ${status.className}`} onClick={() => void sensor.test()}>
                    <span className="sensor-check-icon"><Icon size={17} /></span>
                    <span className="sensor-check-copy"><b>{sensor.label}</b><small>{status.label}</small></span>
                  </button>
                );
              })}
            </div>
            <div className="spike-log">
              {spikeLog.length === 0 ? (
                <p className="sub">Run a check to see the browser evidence available on this device.</p>
              ) : (
                spikeLog.map((line, i) => <div key={i}>{line}</div>)
              )}
            </div>
            <p className="honesty-note">Bright readings, motion events, and visibility changes are estimates. They do not verify outdoor presence or measure Vitamin D.</p>
          </section>
        )}
      </main>

      <nav>
        {([
          { id: 'earn' as Tab, art: 'earn' as const, label: 'Earn' },
          { id: 'gate' as Tab, art: 'gate' as const, label: 'Gate' },
          { id: 'debrief' as Tab, art: 'debrief' as const, label: 'Debrief' },
          { id: 'spike' as Tab, art: 'spike' as const, label: 'Spike' },
        ]).map(t => {
          return (
            <button key={t.id} className={`nav-btn ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              <img className="nav-art" src={BRAND_ART[t.art]} alt="" aria-hidden="true" />
              <span className="nav-label">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
