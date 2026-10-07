import { getMission, type Wallet } from './wallet';

export type SolGuidance = {
  mission: string;
  recommendedDurationMinutes: number;
  motivation: string;
  source: 'ai' | 'fallback';
};

type MissionContext = {
  sunDebt: number;
  sunMinutes: number;
  recentSessions: {
    duration: number;
    steps: number | null;
    earned: number;
    mission: string;
    conf: 'confirmed' | 'estimated' | 'unavailable';
  }[];
  timeOfDay: string;
};

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';
  return `${base.replace(/\/$/, '')}${path}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SUNDEBT API returned ${response.status}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function createMissionContext(wallet: Wallet): MissionContext {
  return {
    sunDebt: wallet.sunDebt,
    sunMinutes: wallet.sunMinutes,
    recentSessions: wallet.sessions.slice(0, 8).map(session => ({
      duration: session.duration,
      steps: session.steps,
      earned: session.earned,
      mission: session.mission,
      conf: session.conf,
    })),
    timeOfDay: new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date()),
  };
}

export function localGuidance(wallet: Wallet): SolGuidance {
  return {
    mission: getMission(wallet.sessions.length),
    recommendedDurationMinutes: 10,
    motivation: 'A short break outdoors is a good place to start.',
    source: 'fallback',
  };
}

export async function requestSolGuidance(wallet: Wallet): Promise<SolGuidance> {
  const fallback = localGuidance(wallet);
  try {
    const guidance = await postJson<SolGuidance>('/api/sol/mission', createMissionContext(wallet));
    if (
      typeof guidance.mission !== 'string' ||
      typeof guidance.motivation !== 'string' ||
      !Number.isInteger(guidance.recommendedDurationMinutes) ||
      (guidance.source !== 'ai' && guidance.source !== 'fallback')
    ) {
      throw new Error('SUNDEBT API returned invalid mission guidance');
    }
    return guidance;
  } catch (error) {
    console.warn('Sol guidance unavailable; using local mission fallback:', error);
    return fallback;
  }
}

export async function startSunSession(guidance: SolGuidance): Promise<string> {
  const result = await postJson<{ workflowId: string }>('/api/sessions/start', { guidance });
  if (typeof result.workflowId !== 'string' || !result.workflowId.startsWith('sundebt-session-')) {
    throw new Error('SUNDEBT API returned an invalid workflow id');
  }
  return result.workflowId;
}

export type SessionEvent =
  | {
      type: 'sun-check';
      evidence: {
        cameraLum: number | null;
        lightLux: number | null;
        confidence: 'confirmed' | 'estimated' | 'unavailable';
      };
    }
  | { type: 'phone-down' }
  | { type: 'interrupted' }
  | { type: 'resumed' };

export function sendSessionEvent(workflowId: string, event: SessionEvent): Promise<{ accepted: boolean }> {
  return postJson(`/api/sessions/${encodeURIComponent(workflowId)}/events`, event);
}

export function completeSunSession(
  workflowId: string,
  completion: { durationMinutes: number; steps: number | null; earnedToday: number; sunDebt: number },
): Promise<{ accepted: boolean }> {
  return postJson(`/api/sessions/${encodeURIComponent(workflowId)}/complete`, completion);
}
