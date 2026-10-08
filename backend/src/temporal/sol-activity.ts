import { ApplicationFailure } from '@temporalio/common';
import {
  solMissionInputSchema,
  type SolGuidance,
  type SolMissionInput,
} from '../contracts.js';
import {
  fallbackMission,
  generateSolGuidance,
  SolGenerationError,
  type SolFailureReason,
} from '../sol/sol-service.js';

export type SolMissionGenerator = (input: SolMissionInput) => Promise<SolGuidance>;

export async function generateSolMissionActivity(
  input: unknown,
  generate: SolMissionGenerator = generateSolGuidance,
): Promise<SolGuidance> {
  const parsed = solMissionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable('Invalid Sol mission input', 'InvalidSolMissionInput');
  }
  let attempt = 0;
  while (true) {
    try {
      return await generate(parsed.data);
    } catch (error) {
      const reason: SolFailureReason =
        error instanceof SolGenerationError ? error.reason : 'provider';
      const message = error instanceof Error ? error.message : String(error);
      const rawText = error instanceof SolGenerationError ? error.rawText : '';
      console.error(
        `[sol] fallback reason=${reason} message=${message} rawLength=${rawText.length} rawPreview=${rawText.slice(0, 200).replace(/\s+/g, ' ')}`,
      );
      if (attempt === 0 && (reason === 'empty' || reason === 'parse')) {
        attempt += 1;
        continue;
      }
      return fallbackMission(parsed.data);
    }
  }
}

export async function fallbackSolMissionActivity(input: unknown): Promise<SolGuidance> {  const parsed = solMissionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable('Invalid Sol mission input', 'InvalidSolMissionInput');
  }
  return fallbackMission(parsed.data);
}
