import {
  condition,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  SolGuidance,
  SessionReward,
  SolMissionInput,
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
import { acceptSessionEvent } from './event-ledger.js';

const { generateSolMissionActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '40 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 2,
  },
});

const { fallbackSolMissionActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 seconds',
  retry: { maximumAttempts: 1 },
});

const { recordSessionStage, rewardSunSession } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export type SunSessionState = {
  sessionId: string;
  stage: activities.SessionStage;
  interrupted: boolean;
  processedEventIds: string[];
  sunCheck?: SunCheckEvidence;
  guidance?: SolGuidance;
  reward?: SessionReward;
};

export type SunSessionArgs = {
  sessionId: string;
  missionContext: SolMissionInput;
};

export async function sunSessionWorkflow({ sessionId, missionContext }: SunSessionArgs): Promise<SessionReward> {
  const state: SunSessionState = {
    sessionId,
    stage: 'started',
    interrupted: false,
    processedEventIds: [],
  };
  let phoneIsDown = false;
  let completion: SessionCompletion | undefined;

  setHandler(sessionStateQuery, () => state);
  setHandler(sunCheckCompletedSignal, event => {
    if (acceptSessionEvent(state.processedEventIds, event.eventId)) state.sunCheck = event.data;
  });
  setHandler(phoneDownSignal, event => {
    if (acceptSessionEvent(state.processedEventIds, event.eventId)) phoneIsDown = true;
  });
  setHandler(interruptedSignal, event => {
    if (acceptSessionEvent(state.processedEventIds, event.eventId)) state.interrupted = true;
  });
  setHandler(resumedSignal, event => {
    if (acceptSessionEvent(state.processedEventIds, event.eventId)) state.interrupted = false;
  });
  setHandler(sessionCompletedSignal, event => {
    if (acceptSessionEvent(state.processedEventIds, event.eventId, completion !== undefined)) {
      completion = event.data;
    }
  });

  const record = async (stage: activities.SessionStage) => {
    await recordSessionStage({ stage });
    state.stage = stage;
  };

  await record('started');
  try {
    state.guidance = await generateSolMissionActivity(missionContext);
  } catch {
    state.guidance = await fallbackSolMissionActivity(missionContext);
  }

  await condition(() => state.sunCheck !== undefined);
  const sunCheck = state.sunCheck;
  if (!sunCheck) throw new Error('Sun Check evidence was not received');
  await record('sun-check-complete');
  await condition(() => phoneIsDown);
  await record('phone-down');
  await record('outdoor-session');

  while (completion === undefined) {
    await condition(() => state.interrupted || completion !== undefined);
    if (completion !== undefined) break;
    await record('interrupted');
    await condition(() => !state.interrupted || completion !== undefined);
    if (completion === undefined) await record('resumed');
  }

  const completedSession = completion;
  if (!completedSession) throw new Error('Session completion signal was not received');
  await record('completed');
  const reward = await rewardSunSession(completedSession);
  state.reward = reward;
  await record('rewarded');
  return reward;
}
