import type { SessionCompletion, SessionReward } from '../contracts.js';
import { calculateSessionReward } from './reward.js';

export type SessionStage =
  | 'started'
  | 'sun-check-complete'
  | 'phone-down'
  | 'outdoor-session'
  | 'interrupted'
  | 'resumed'
  | 'completed'
  | 'rewarded';

export async function recordSessionStage(input: {
  sessionId: string;
  stage: SessionStage;
  details?: Record<string, unknown>;
}): Promise<{ stage: SessionStage; recordedAt: string }> {
  const event = { ...input, recordedAt: new Date().toISOString() };
  console.info('Temporal Sun Session activity:', JSON.stringify(event));
  return { stage: input.stage, recordedAt: event.recordedAt };
}

export async function rewardSunSession(input: SessionCompletion): Promise<SessionReward> {
  return calculateSessionReward(input);
}
