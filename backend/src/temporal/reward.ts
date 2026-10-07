import type { SessionCompletion, SessionReward } from '../contracts.js';

export const DAILY_EARNING_CAP = 90;
export const STEP_BONUS_DIVISOR = 100;

export function calculateSessionReward(input: SessionCompletion): SessionReward {
  const remainingDailyAllowance = Math.max(0, DAILY_EARNING_CAP - input.earnedToday);
  const durationEarnings = Math.min(input.durationMinutes, remainingDailyAllowance);
  const stepBonus = Math.floor((input.steps ?? 0) / STEP_BONUS_DIVISOR);
  const earned = Math.min(durationEarnings + stepBonus, remainingDailyAllowance);
  const debtRepaid = Math.min(input.sunDebt, earned);

  return {
    earned,
    xp: earned * 2,
    debtRepaid,
    sunMinutesAdded: earned - debtRepaid,
    sunDebtAfter: input.sunDebt - debtRepaid,
  };
}
