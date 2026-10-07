import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackMission } from './sol-service.js';

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
