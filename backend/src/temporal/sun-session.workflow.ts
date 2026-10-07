import {
  condition,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  SessionReward,
  SolMission,
  SunCheckEvidence,
} from '../contracts.js';
import type * as activities from './activities.js';
import {
  interruptedSignal,
  phoneDownSignal,
  resumedSignal,
  sessionCompletedSignal,
  sessionStateQuery,
  sunCheckCompletedSignal,
} from './signals.js';
import type { SessionCompletion } from '../contracts.js';

const { recordSessionStage, rewardSunSession } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export type SunSessionState = {
  sessionId: string;
  stage: activities.SessionStage;
  interrupted: boolean;
  sunCheck?: SunCheckEvidence;
  reward?: SessionReward;
};

export type SunSessionArgs = {
  sessionId: string;
  guidance: SolMission;
};

export async function sunSessionWorkflow({ sessionId, guidance }: SunSessionArgs): Promise<SessionReward> {
  const state: SunSessionState = { sessionId, stage: 'started', interrupted: false };
  let phoneIsDown = false;
  let completion: SessionCompletion | undefined;

  setHandler(sessionStateQuery, () => state);
  setHandler(sunCheckCompletedSignal, evidence => { state.sunCheck = evidence; });
  setHandler(phoneDownSignal, () => { phoneIsDown = true; });
  setHandler(interruptedSignal, () => { state.interrupted = true; });
  setHandler(resumedSignal, () => { state.interrupted = false; });
  setHandler(sessionCompletedSignal, input => { completion = input; });

  const record = async (stage: activities.SessionStage, details?: Record<string, unknown>) => {
    await recordSessionStage({ sessionId, stage, details });
    state.stage = stage;
  };

  await record('started', { mission: guidance.mission });
  await condition(() => state.sunCheck !== undefined);
  const sunCheck = state.sunCheck;
  if (!sunCheck) throw new Error('Sun Check evidence was not received');
  await record('sun-check-complete', { ...sunCheck });
  await condition(() => phoneIsDown);
  await record('phone-down');
  await record('outdoor-session', {
    mission: guidance.mission,
    recommendedDurationMinutes: guidance.recommendedDurationMinutes,
  });

  while (completion === undefined) {
    await condition(() => state.interrupted || completion !== undefined);
    if (completion !== undefined) break;
    await record('interrupted');
    await condition(() => !state.interrupted || completion !== undefined);
    if (completion === undefined) await record('resumed');
  }

  const completedSession = completion;
  if (!completedSession) throw new Error('Session completion signal was not received');
  await record('completed', {
    durationMinutes: completedSession.durationMinutes,
    steps: completedSession.steps,
  });
  const reward = await rewardSunSession(completedSession);
  state.reward = reward;
  await record('rewarded', reward);
  return reward;
}
