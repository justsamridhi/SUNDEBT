import { getMission, type Wallet } from './wallet';

export type SolGuidance = {
  mission: string;
  recommendedDurationMinutes: number;
  motivation: string;
  source: 'ai' | 'fallback';
};

export type MissionContext = {
  sunDebt: number;
  sunMinutes: number;
  recentSessionDurations: number[];
  timeOfDay: string;
};

const sessionStartRequests = new Map<string, Promise<{ workflowId: string; guidance?: SolGuidance }>>();

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';
  return `${base.replace(/\/$/, '')}${path}`;
}

async function postJson<T>(path: string, body: unknown, timeoutMs = 3_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    recentSessionDurations: wallet.sessions.slice(0, 3).map(session => session.duration),
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

export async function startSunSession(
  sessionId: string,
  missionContext: MissionContext,
): Promise<{ workflowId: string; guidance?: SolGuidance }> {
  const existingRequest = sessionStartRequests.get(sessionId);
  if (existingRequest) return existingRequest;

  const request = postJson<{ workflowId: string; guidance?: SolGuidance }>(
    '/api/sessions/start',
    { sessionId, missionContext },
    25_000,
  ).then(result => {
  if (typeof result.workflowId !== 'string' || !result.workflowId.startsWith('sundebt-session-')) {
    throw new Error('SUNDEBT API returned an invalid workflow id');
  }
  if (
    result.guidance &&
    (typeof result.guidance.mission !== 'string' ||
      typeof result.guidance.motivation !== 'string' ||
      !Number.isInteger(result.guidance.recommendedDurationMinutes) ||
      result.guidance.recommendedDurationMinutes < 5 ||
      result.guidance.recommendedDurationMinutes > 60 ||
      (result.guidance.source !== 'ai' && result.guidance.source !== 'fallback'))
  ) {
    throw new Error('SUNDEBT API returned invalid mission guidance');
  }
  return result;
  });
  sessionStartRequests.set(sessionId, request);
  return request;
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
  return postJson(`/api/sessions/${encodeURIComponent(workflowId)}/events`, {
    ...event,
    eventId: crypto.randomUUID(),
  });
}

export function completeSunSession(
  workflowId: string,
  completion: { durationMinutes: number; steps: number | null; earnedToday: number; sunDebt: number },
): Promise<{ accepted: boolean }> {
  return postJson(`/api/sessions/${encodeURIComponent(workflowId)}/complete`, {
    ...completion,
    eventId: crypto.randomUUID(),
  });
}
