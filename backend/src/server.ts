import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  sessionCompletionSchema,
  sessionStartSchema,
  solMissionInputSchema,
  sunCheckEvidenceSchema,
} from './contracts.js';
import { getSolGuidance } from './sol/sol-service.js';
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
const workflowIdSchema = z.string().regex(/^sundebt-session-[0-9a-f-]{36}$/i);
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

app.post('/api/sol/mission', async (request, response) => {
  const input = solMissionInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: 'Invalid mission context', details: input.error.issues });
    return;
  }

  response.json(await getSolGuidance(input.data));
});

app.post('/api/sessions/start', async (request, response, next) => {
  const body = sessionStartSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Invalid session start', details: body.error.issues });
    return;
  }

  const workflowId = `sundebt-session-${randomUUID()}`;
  try {
    const client = await getTemporalClient();
    await client.workflow.start('sunSessionWorkflow', {
      workflowId,
      taskQueue: getTaskQueue(),
      args: [{ sessionId: workflowId, guidance: body.data.guidance }],
    });
    response.status(201).json({ workflowId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/:id/events', async (request, response, next) => {
  const workflowId = parseWorkflowId(request.params.id, response);
  if (!workflowId) return;
  const eventSchema = expressEventSchema.safeParse(request.body);
  if (!eventSchema.success) {
    response.status(400).json({ error: 'Invalid session event', details: eventSchema.error.issues });
    return;
  }

  try {
    const client = await getTemporalClient();
    const workflow = client.workflow.getHandle(workflowId);
    switch (eventSchema.data.type) {
      case 'sun-check':
        await workflow.signal(sunCheckCompletedSignal, eventSchema.data.evidence);
        break;
      case 'phone-down':
        await workflow.signal(phoneDownSignal);
        break;
      case 'interrupted':
        await workflow.signal(interruptedSignal);
        break;
      case 'resumed':
        await workflow.signal(resumedSignal);
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
  const completion = sessionCompletionSchema.safeParse(request.body);
  if (!completion.success) {
    response.status(400).json({ error: 'Invalid session completion', details: completion.error.issues });
    return;
  }

  try {
    const client = await getTemporalClient();
    const workflow = client.workflow.getHandle(workflowId);
    await workflow.signal(sessionCompletedSignal, completion.data);

    const rewardPromise: Promise<SessionReward> = workflow.result();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>(resolve => {
      timeout = setTimeout(() => resolve(undefined), 1_200);
    });
    const reward = await Promise.race([rewardPromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    response.status(reward ? 200 : 202).json({ accepted: true, reward });
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

const expressEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sun-check'),
    evidence: sunCheckEvidenceSchema,
  }),
  z.object({ type: z.literal('phone-down') }),
  z.object({ type: z.literal('interrupted') }),
  z.object({ type: z.literal('resumed') }),
]);

const handleApiError: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error('SUNDEBT API request failed:', error);
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
app.listen(port, () => {
  console.info(`SUNDEBT API listening on http://localhost:${port}`);
});
