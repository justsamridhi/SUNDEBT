import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationFailure } from '@temporalio/common';
import type { SolMissionInput } from '../contracts.js';
import { generateSolMissionActivity } from './sol-activity.js';
import { SolGenerationError } from '../sol/sol-service.js';

const input: SolMissionInput = {
  sunDebt: 12,
  sunMinutes: 4,
  recentSessionDurations: [8, 12, 6],
  timeOfDay: 'afternoon',
};

test('Sol Activity returns validated Mastra guidance from the allowed context', async () => {
  let received: SolMissionInput | undefined;
  const result = await generateSolMissionActivity(input, async context => {
    received = context;
    return {
      mission: 'Walk comfortably along a familiar path.',
      recommendedDurationMinutes: 15,
      motivation: 'A few minutes outdoors can refresh your focus.',
      source: 'ai',
    };
  });

  assert.deepEqual(received, input);
  assert.equal(result.source, 'ai');
  assert.equal(result.recommendedDurationMinutes, 15);
});

test('Sol Activity failures can retry once before deterministic fallback', async () => {
  let attempts = 0;
  const retryableGenerator = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new SolGenerationError('Sol model returned malformed JSON', 'parse', '{"mission":');
    }
    return {
      mission: 'Walk comfortably along a familiar path.',
      recommendedDurationMinutes: 15,
      motivation: 'A few minutes outdoors can refresh your focus.',
      source: 'ai' as const,
    };
  };

  const retried = await generateSolMissionActivity(input, retryableGenerator);
  assert.equal(attempts, 2);
  assert.equal(retried.source, 'ai');

  let malformedAttempts = 0;
  const malformedGenerator = async () => {
    malformedAttempts += 1;
    throw new SolGenerationError('Sol model returned malformed JSON', 'parse', '{"mission":');
  };
  const fallback = await generateSolMissionActivity(input, malformedGenerator);
  assert.equal(malformedAttempts, 2);
  assert.equal(fallback.source, 'fallback');
  assert.ok(fallback.mission.length > 0);
});

test('Sol Activity retries empty output once before deterministic fallback', async () => {
  let attempts = 0;
  const fallback = await generateSolMissionActivity(input, async () => {
    attempts += 1;
    throw new SolGenerationError('Sol model returned empty output', 'empty');
  });

  assert.equal(attempts, 2);
  assert.equal(fallback.source, 'fallback');
  assert.ok(fallback.mission.length > 0);
});

test('Sol Activity does not retry timeout, schema, safety, or provider failures', async () => {
  for (const reason of ['timeout', 'schema', 'safety', 'provider'] as const) {
    let attempts = 0;
    const result = await generateSolMissionActivity(input, async () => {
      attempts += 1;
      throw new SolGenerationError(`Sol ${reason} failure`, reason);
    });
    assert.equal(attempts, 1);
    assert.equal(result.source, 'fallback');
    assert.ok(result.mission.length > 0);
  }
});

test('Sol Activity marks invalid context as non-retryable', async () => {
  const isNonRetryable = (error: unknown) => error instanceof ApplicationFailure && error.nonRetryable;
  await assert.rejects(generateSolMissionActivity({
    ...input,
    recentSessionDurations: [1, 2, 3, 4],
  }), isNonRetryable);
  await assert.rejects(generateSolMissionActivity({
    ...input,
    history: 'free-text history must not be accepted',
  }), isNonRetryable);
});
