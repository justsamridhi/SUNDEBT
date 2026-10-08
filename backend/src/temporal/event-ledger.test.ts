import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptSessionEvent } from './event-ledger.js';
import { calculateSessionReward } from './reward.js';

test('duplicate session event IDs are ignored', () => {
  const processedEventIds: string[] = [];

  assert.equal(acceptSessionEvent(processedEventIds, 'sun-check-id'), true);
  assert.equal(acceptSessionEvent(processedEventIds, 'sun-check-id'), false);
  assert.deepEqual(processedEventIds, ['sun-check-id']);
});

test('a second completion cannot trigger a second reward', () => {
  const processedEventIds: string[] = [];
  let completionReceived = false;
  const rewards: ReturnType<typeof calculateSessionReward>[] = [];
  const completion = { durationMinutes: 10, steps: 0, earnedToday: 0, sunDebt: 5 };

  for (const eventId of ['complete-one', 'complete-two']) {
    if (!acceptSessionEvent(processedEventIds, eventId, completionReceived)) continue;
    completionReceived = true;
    rewards.push(calculateSessionReward(completion));
  }

  assert.equal(rewards.length, 1);
});
