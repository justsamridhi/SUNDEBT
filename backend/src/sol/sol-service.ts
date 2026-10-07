import { Agent } from '@mastra/core/agent';
import { createOllama } from 'ollama-ai-provider-v2';
import { solMissionSchema, type SolMission, type SolMissionInput } from '../contracts.js';

const fallbackMissions = [
  'Spend 5 minutes outside without your phone.',
  'Notice three things you normally overlook.',
  'Take a different route today.',
  'Sit outside for 10 minutes, doing nothing.',
  'Find something growing near you.',
  'Listen to the sounds around you for 2 minutes.',
  'Walk on grass only if it is safe and comfortable.',
  'Watch the sky change for 5 minutes.',
];

export type SolGuidance = SolMission & { source: 'ai' | 'fallback' };

export function parseSolMissionResponse(response: { object?: unknown; text: string }): SolMission {
  const structured = solMissionSchema.safeParse(response.object);
  if (structured.success) return structured.data;

  const jsonText = response.text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? response.text;
  return solMissionSchema.parse(JSON.parse(jsonText));
}

export function fallbackMission(input: SolMissionInput): SolGuidance {
  const previousMissions = new Set(input.recentSessions.map(session => session.mission));
  const index = input.recentSessions.length % fallbackMissions.length;
  let missionIndex = index;
  for (let offset = 0; offset < fallbackMissions.length; offset += 1) {
    const candidateIndex = (index + offset) % fallbackMissions.length;
    if (!previousMissions.has(fallbackMissions[candidateIndex])) {
      missionIndex = candidateIndex;
      break;
    }
  }
  const mission = fallbackMissions[missionIndex];

  const recommendedDurationMinutes = Math.max(5, Math.min(
    20,
    input.sunDebt > input.sunMinutes ? 15 : 10,
  ));

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
  });
  const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';

  return new Agent({
    id: 'sundebt-sol',
    name: 'Sol',
    instructions: [
      'You are Sol, a warm, practical outdoor companion for SUNDEBT.',
      'Suggest one safe, accessible outdoor activity; adapt to the user’s recent missions,',
      'session lengths, steps, Sun Debt, Sun Minutes, local time, and optional context.',
      'Keep the mission specific and doable, the recommendation between 5 and 45 minutes,',
      'and the motivation to one short sentence.',
      'Never claim sensors prove someone is outdoors, measure health or Vitamin D, or',
      'encourage unsafe travel, exposure, trespassing, or phone use while moving.',
    ].join(' '),
    model: ollama(model),
  });
}

export async function getSolGuidance(input: SolMissionInput): Promise<SolGuidance> {
  const fallback = fallbackMission(input);
  try {
    const agent = createSolAgent();
    const response = await agent.generate(
      JSON.stringify({
        sunDebt: input.sunDebt,
        sunMinutes: input.sunMinutes,
        recentSessions: input.recentSessions,
        timeOfDay: input.timeOfDay,
        weatherContext: input.weatherContext ?? null,
        context: input.context ?? null,
      }),
      {
        structuredOutput: {
          schema: solMissionSchema,
          jsonPromptInjection: true,
        },
        abortSignal: AbortSignal.timeout(12_000),
      },
    );

    return { ...parseSolMissionResponse(response), source: 'ai' };
  } catch (error) {
    console.warn('Sol AI unavailable; using deterministic mission fallback:', error);
    return fallback;
  }
}
