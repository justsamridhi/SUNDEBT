import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSessionReward } from './reward.js';

test('session reward pays down Sun Debt before adding spendable Sun Minutes', () => {
  assert.deepEqual(
    calculateSessionReward({
      durationMinutes: 12,
      steps: 250,
      earnedToday: 0,
      sunDebt: 8,
    }),
    {
      earned: 14,
      xp: 28,
      debtRepaid: 8,
      sunMinutesAdded: 6,
      sunDebtAfter: 0,
    },
  );
});

test('session reward respects the daily cap, including step bonuses', () => {
  assert.deepEqual(
    calculateSessionReward({
      durationMinutes: 20,
      steps: 2_000,
      earnedToday: 88,
      sunDebt: 20,
    }),
    {
      earned: 2,
      xp: 4,
      debtRepaid: 2,
      sunMinutesAdded: 0,
      sunDebtAfter: 18,
    },
  );
});

test('session reward cannot exceed the daily cap after it is reached', () => {
  assert.deepEqual(
    calculateSessionReward({
      durationMinutes: 10,
      steps: 500,
      earnedToday: 90,
      sunDebt: 5,
    }),
    {
      earned: 0,
      xp: 0,
      debtRepaid: 0,
      sunMinutesAdded: 0,
      sunDebtAfter: 5,
    },
  );
});
