import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractJsonObject,
  fallbackMission,
  parseSolMissionResponse,
} from './sol-service.js';

test('Sol validates JSON text when Mastra does not provide a structured object', () => {
  const mission = {
    mission: 'Walk a quiet path for ten minutes.',
    recommendedDurationMinutes: 10,
    motivation: 'A little fresh air can reset your day.',
  };

  assert.deepEqual(
    parseSolMissionResponse({
      object: undefined,
      text: `\`\`\`json\n${JSON.stringify(mission)}\n\`\`\``,
    }),
    mission,
  );
});

test('Sol accepts a valid structured response object', () => {
  const mission = {
    mission: 'Walk a quiet path for ten minutes.',
    recommendedDurationMinutes: 10,
    motivation: 'A little fresh air can reset your day.',
  };

  assert.deepEqual(
    parseSolMissionResponse({
      object: mission,
      text: '',
    }),
    mission,
  );
});

test('Sol rejects empty model output with a clear error', () => {
  assert.throws(
    () => parseSolMissionResponse({ object: undefined, text: ' \n ' }),
    /Sol model returned empty output/,
  );
});

test('Sol rejects output without a JSON object with a clear error', () => {
  assert.throws(
    () => extractJsonObject('The model did not return structured data.'),
    /Sol model returned no JSON object/,
  );
});

test('Sol rejects malformed JSON when an object-shaped substring exists', () => {
  assert.throws(
    () => parseSolMissionResponse({ object: undefined, text: '{"mission": "Walk outside",}' }),
    /Sol model returned malformed JSON/,
  );
});

test('Sol mission validation rejects risky or medical output', () => {
  const unsafeMission = {
    mission: 'Climb onto a roof alone after dark.',
    recommendedDurationMinutes: 10,
    motivation: 'It is good for your health.',
  };
  assert.throws(() => parseSolMissionResponse({
    object: unsafeMission,
    text: JSON.stringify(unsafeMission),
  }));
});

test('Sol rejects unsafe location and medical word variants', () => {
  for (const phrase of ['roads', 'streets', 'bridges', 'treatment', 'diagnosis', 'prescription', 'supplements']) {
    const mission = {
      mission: `Spend ten minutes considering ${phrase}.`,
      recommendedDurationMinutes: 10,
      motivation: 'A little fresh air can reset your day.',
    };
    assert.throws(() => parseSolMissionResponse({
      object: mission,
      text: JSON.stringify(mission),
    }), phrase);
  }
});

test('Sol clamps model duration recommendations to the supported range', () => {
  const response = (recommendedDurationMinutes: number) => ({
    object: {
      mission: 'Walk a quiet path for ten minutes.',
      recommendedDurationMinutes,
      motivation: 'A little fresh air can refresh your focus.',
    },
    text: '',
  });

  assert.equal(parseSolMissionResponse(response(120)).recommendedDurationMinutes, 60);
  assert.equal(parseSolMissionResponse(response(0)).recommendedDurationMinutes, 5);
  assert.equal(parseSolMissionResponse(response(-10)).recommendedDurationMinutes, 5);
});

test('fallback mission is deterministic and avoids the previous mission when possible', () => {
  const input = {
    sunDebt: 15,
    sunMinutes: 0,
    recentSessions: [{
      duration: 10,
      steps: 800,
      earned: 10,
      mission: 'Notice three things you normally overlook.',
      conf: 'estimated' as const,
    }],
    timeOfDay: 'afternoon',
  };

  assert.deepEqual(fallbackMission(input), fallbackMission(input));
  assert.notEqual(fallbackMission(input).mission, input.recentSessions[0].mission);
  assert.equal(fallbackMission(input).recommendedDurationMinutes, 15);
  assert.equal(fallbackMission(input).source, 'fallback');
});
