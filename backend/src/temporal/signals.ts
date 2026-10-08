import {
  defineQuery,
  defineSignal,
} from '@temporalio/workflow';
import type {
  SessionCompletion,
  SunCheckEvidence,
} from '../contracts.js';
import type { SunSessionState } from './sun-session.workflow.js';

export type IdentifiedSessionEvent<T = undefined> = {
  eventId: string;
  data: T;
};

export const sunCheckCompletedSignal = defineSignal<[IdentifiedSessionEvent<SunCheckEvidence>]>('sunCheckCompleted');
export const phoneDownSignal = defineSignal<[IdentifiedSessionEvent]>('phoneDown');
export const interruptedSignal = defineSignal<[IdentifiedSessionEvent]>('sessionInterrupted');
export const resumedSignal = defineSignal<[IdentifiedSessionEvent]>('sessionResumed');
export const sessionCompletedSignal = defineSignal<[IdentifiedSessionEvent<SessionCompletion>]>('sessionCompleted');
export const sessionStateQuery = defineQuery<SunSessionState>('sessionState');
