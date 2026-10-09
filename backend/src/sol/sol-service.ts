import { Agent } from '@mastra/core/agent';
import { createOllama } from 'ollama-ai-provider-v2';
import {
  solMissionInputSchema,
  solMissionOutputSchema,
  solMissionSchema,
  type SolGuidance,
  type SolMission,
  type SolMissionInput,
} from '../contracts.js';

const fallbackMissions = [
  'Spend 5 minutes outside without your phone.',
  'Notice three things you normally overlook.',
  'Take a short walk in a familiar, comfortable place.',
  'Sit somewhere comfortable outdoors for 10 minutes.',
  'Notice a plant or tree from a safe public place.',
  'Listen to the sounds around you for 2 minutes.',
  'Walk on grass only if it is safe and comfortable.',
  'Watch the sky change for 5 minutes.',
];

type FallbackMissionInput = Pick<SolMissionInput, 'sunDebt' | 'sunMinutes'>
  & Partial<Pick<SolMissionInput, 'recentSessionDurations'>>
  & {
    recentSessions?: {
      duration?: number;
      steps?: number | null;
      earned?: number;
      mission: string;
      conf?: 'confirmed' | 'estimated' | 'unavailable';
    }[];
    timeOfDay?: string;
  };

export type SolFailureReason = 'empty' | 'timeout' | 'parse' | 'schema' | 'safety' | 'provider';

export class SolGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: SolFailureReason,
    readonly rawText = '',
  ) {
    super(message);
    this.name = 'SolGenerationError';
  }
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!trimmed) throw new SolGenerationError('Sol model returned empty output', 'empty');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new SolGenerationError('Sol model returned no JSON object', 'parse', text);
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new SolGenerationError(
      `Sol model returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      'parse',
      text,
    );
  }
}

export function parseSolMissionResponse(response: { object?: unknown; text: string }): SolMission {
  const raw = response.text;
  const parsed = raw.trim()
    ? extractJsonObject(raw)
    : response.object !== undefined
      ? response.object
      : extractJsonObject(raw);
  const output = solMissionOutputSchema.safeParse(parsed);
  if (!output.success) {
    throw new SolGenerationError('Sol model returned invalid mission schema', 'schema', raw);
  }
  const mission = solMissionSchema.safeParse({
    ...output.data,
    recommendedDurationMinutes: Math.max(5, Math.min(60, output.data.recommendedDurationMinutes)),
  });
  if (!mission.success) {
    const safetyFailure = mission.error.issues.some(issue => issue.code === 'custom');
    throw new SolGenerationError(
      safetyFailure ? 'Sol model returned unsafe mission content' : 'Sol model returned invalid mission schema',
      safetyFailure ? 'safety' : 'schema',
      raw,
    );
  }
  return mission.data;
}

export function fallbackMission(input: FallbackMissionInput): SolGuidance {
  const previousMissions = new Set(input.recentSessions?.map(session => session.mission) ?? []);
  const index = (input.recentSessionDurations?.length ?? input.recentSessions?.length ?? 0) % fallbackMissions.length;
  let missionIndex = index;
  for (let offset = 0; offset < fallbackMissions.length; offset += 1) {
    const candidateIndex = (index + offset) % fallbackMissions.length;
    if (!previousMissions.has(fallbackMissions[candidateIndex])) {
      missionIndex = candidateIndex;
      break;
    }
  }
  const mission = fallbackMissions[missionIndex];

  const recommendedDurationMinutes = Math.max(5, Math.min(60, input.sunDebt > input.sunMinutes ? 15 : 10));

  return {
    mission,
    recommendedDurationMinutes,
    motivation: 'A short break outdoors is a good place to start.',
    source: 'fallback',
  };
}

function createSolAgent() {
  const ollama = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/api',
    compatibility: 'strict',
  });
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

  return new Agent({
    id: 'sundebt-sol',
    name: 'Sol',
    instructions: [
      'You are Sol, a warm, practical outdoor companion for SUNDEBT.',
      'Use only Sun Minutes, Sun Debt, the last few session durations, and time of day.',
      'Suggest one safe, generic, accessible outdoor activity without risky locations.',
      'Never tell someone to go outside alone after dark or give medical advice or claims.',
      'Keep the mission specific and doable, the recommendation between 5 and 60 minutes,',
      'and the motivation to one short sentence.',
      'Reply with the JSON object only, exactly matching this shape and no other fields:',
      '{"mission":"Sit outside in a comfortable safe place for 10 minutes.","recommendedDurationMinutes":10,"motivation":"A short break can refresh your focus."}',
      'Do not include markdown or surrounding prose.',
    ].join(' '),
    model: ollama(model),
  });
}

export async function generateSolGuidance(input: SolMissionInput): Promise<SolGuidance> {
  const validatedInput = solMissionInputSchema.parse(input);
  const agent = createSolAgent();
  let rawText = '';
  const startedAt = Date.now();
  try {
    const response = await agent.generate(
      JSON.stringify({
        sunMinutes: validatedInput.sunMinutes,
        sunDebt: validatedInput.sunDebt,
        recentSessionDurations: validatedInput.recentSessionDurations.slice(0, 3),
        timeOfDay: validatedInput.timeOfDay,
      }) + '\nReply with the JSON object only.',
      {
        modelSettings: { temperature: 0 },
        providerOptions: { ollama: { options: { num_ctx: 2048 } } },
        abortSignal: AbortSignal.timeout(15_000),
      },
    );
    rawText = response.text;
    const mission = parseSolMissionResponse(response);
    console.info(`[sol] ai ok durationMs=${Date.now() - startedAt}`);
    return { ...mission, source: 'ai' };
  } catch (error) {
    const reason: SolFailureReason =
      error instanceof SolGenerationError
        ? error.reason
        : error instanceof DOMException && error.name === 'TimeoutError'
          ? 'timeout'
          : 'provider';
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sol] fallback reason=${reason} message=${message} rawLength=${rawText.length} rawPreview=${rawText.slice(0, 200).replace(/\s+/g, ' ')}`,
    );
    throw error;
  }
}
