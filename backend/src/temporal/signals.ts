import {
  defineQuery,
  defineSignal,
} from '@temporalio/workflow';
import type {
  SessionCompletion,
  SunCheckEvidence,
} from '../contracts.js';
import type { SunSessionState } from './sun-session.workflow.js';

export const sunCheckCompletedSignal = defineSignal<[SunCheckEvidence]>('sunCheckCompleted');
export const phoneDownSignal = defineSignal('phoneDown');
export const interruptedSignal = defineSignal('sessionInterrupted');
export const resumedSignal = defineSignal('sessionResumed');
export const sessionCompletedSignal = defineSignal<[SessionCompletion]>('sessionCompleted');
export const sessionStateQuery = defineQuery<SunSessionState>('sessionState');
