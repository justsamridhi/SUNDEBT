import type { SessionCompletion, SessionReward } from '../contracts.js';
import { calculateSessionReward } from './reward.js';

export { fallbackSolMissionActivity, generateSolMissionActivity } from './sol-activity.js';

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
  stage: SessionStage;
}): Promise<{ stage: SessionStage; recordedAt: string }> {
  const recordedAt = new Date().toISOString();
  console.info('Temporal Sun Session stage:', input.stage);
  return { stage: input.stage, recordedAt };
}

export async function rewardSunSession(input: SessionCompletion): Promise<SessionReward> {
  return calculateSessionReward(input);
}
