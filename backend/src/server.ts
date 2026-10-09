import 'dotenv/config';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Response } from 'express';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { z } from 'zod';
import {
  sessionCompletionEventSchema,
  sessionEventSchema,
  sessionStartSchema,
} from './contracts.js';
import { getTaskQueue, getTemporalClient } from './temporal/client.js';
import {
  interruptedSignal,
  phoneDownSignal,
  resumedSignal,
  sessionCompletedSignal,
  sessionStateQuery,
  sunCheckCompletedSignal,
} from './temporal/signals.js';
import type { SessionReward } from './contracts.js';

const app = express();
const workflowIdSchema = z.string().regex(/^sundebt-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const allowedOrigins = process.env.CORS_ORIGIN
  ?.split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : true }));
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    modelProvider: 'ollama',
  });
});

app.post('/api/sessions/start', async (request, response, next) => {
  const body = sessionStartSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Invalid session start', details: body.error.issues });
    return;
  }

  const workflowId = `sundebt-session-${body.data.sessionId}`;
  try {
    const client = await getTemporalClient();
    try {
      await client.workflow.start('sunSessionWorkflow', {
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        taskQueue: getTaskQueue(),
        args: [{
          sessionId: workflowId,
          missionContext: body.data.missionContext,
        }],
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') {
        const workflow = client.workflow.getHandle(workflowId);
        const state = await workflow.query(sessionStateQuery);
        response.status(200).json({ workflowId, guidance: state.guidance });
        return;
      }
      throw error;
    }

    const workflow = client.workflow.getHandle(workflowId);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await workflow.query(sessionStateQuery);
      if (state.guidance) {
        response.status(200).json({ workflowId, guidance: state.guidance });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    response.status(202).json({ workflowId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/:id/events', async (request, response, next) => {
  const workflowId = parseWorkflowId(request.params.id, response);
  if (!workflowId) return;
  const event = sessionEventSchema.safeParse(request.body);
  if (!event.success) {
    response.status(400).json({ error: 'Invalid session event', details: event.error.issues });
    return;
  }

  try {
    const client = await getTemporalClient();
    const workflow = client.workflow.getHandle(workflowId);
    switch (event.data.type) {
      case 'sun-check':
        await workflow.signal(sunCheckCompletedSignal, {
          eventId: event.data.eventId,
          data: event.data.evidence,
        });
        break;
      case 'phone-down':
        await workflow.signal(phoneDownSignal, { eventId: event.data.eventId, data: undefined });
        break;
      case 'interrupted':
        await workflow.signal(interruptedSignal, { eventId: event.data.eventId, data: undefined });
        break;
      case 'resumed':
        await workflow.signal(resumedSignal, { eventId: event.data.eventId, data: undefined });
        break;
    }
    response.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/:id/complete', async (request, response, next) => {
  const workflowId = parseWorkflowId(request.params.id, response);
  if (!workflowId) return;
  const completion = sessionCompletionEventSchema.safeParse(request.body);
  if (!completion.success) {
    response.status(400).json({ error: 'Invalid session completion', details: completion.error.issues });
    return;
  }

  try {
    const client = await getTemporalClient();
    const workflow = client.workflow.getHandle(workflowId);
    const currentState = await workflow.query(sessionStateQuery);
    if (currentState.reward) {
      response.status(200).json({ status: 'already-completed' });
      return;
    }
    const { eventId, ...completionData } = completion.data;
    try {
      await workflow.signal(sessionCompletedSignal, { eventId, data: completionData });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['WorkflowExecutionAlreadyCompletedError', 'WorkflowNotFoundError'].includes(error.name)
      ) {
        throw error;
      }
      const completedState = await workflow.query(sessionStateQuery);
      if (!completedState.reward) throw error;
      response.status(200).json({ status: 'already-completed' });
      return;
    }

    const rewardPromise: Promise<SessionReward> = workflow.result();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>(resolve => {
      timeout = setTimeout(() => resolve(undefined), 1_200);
    });
    const reward = await Promise.race([rewardPromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    response.status(reward ? 200 : 202).json(reward ? { accepted: true, reward } : { accepted: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sessions/:id', async (request, response, next) => {
  const workflowId = parseWorkflowId(request.params.id, response);
  if (!workflowId) return;
  try {
    const client = await getTemporalClient();
    const workflow = client.workflow.getHandle(workflowId);
    response.json(await workflow.query(sessionStateQuery));
  } catch (error) {
    next(error);
  }
});

const handleApiError: ErrorRequestHandler = (error, request, response, _next) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[api] 503 route=${request.path} message=${message}`);
  if (response.headersSent) return;
  response.status(503).json({
    error: 'Session workflow is temporarily unavailable. The frontend can continue locally.',
  });
};

function parseWorkflowId(value: string, response: Response): string | undefined {
  const parsed = workflowIdSchema.safeParse(value);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid workflow id' });
    return undefined;
  }
  return parsed.data;
}

app.use(handleApiError);

const port = Number(process.env.PORT ?? 8787);
function warmUpOllama(): void {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/api';
  const model = process.env.OLLAMA_MODEL ?? 'llama3:latest';
  void fetch(`${baseUrl.replace(/\/$/, '')}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: 'Reply with OK.',
      stream: false,
      options: { num_predict: 1, num_ctx: 256 },
    }),
  })
    .then(response => {
      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }
    })
    .catch(error => {
      console.warn('[sol] Ollama warm-up unavailable:', error instanceof Error ? error.message : String(error));
    });
}
warmUpOllama();
app.listen(port, () => {
  console.info(`SUNDEBT API listening on http://localhost:${port}`);
});
