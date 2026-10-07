import { z } from 'zod';

export const recentSessionSchema = z.object({
  duration: z.number().int().min(0).max(24 * 60),
  steps: z.number().int().min(0).nullable(),
  earned: z.number().int().min(0),
  mission: z.string().max(240),
  conf: z.enum(['confirmed', 'estimated', 'unavailable']),
});

export const solMissionInputSchema = z.object({
  sunDebt: z.number().min(0),
  sunMinutes: z.number().min(0),
  recentSessions: z.array(recentSessionSchema).max(8),
  timeOfDay: z.string().min(1).max(80),
  weatherContext: z.string().max(240).optional(),
  context: z.string().max(240).optional(),
});

export const solMissionSchema = z.object({
  mission: z.string().trim().min(8).max(180),
  recommendedDurationMinutes: z.number().int().min(5).max(45),
  motivation: z.string().trim().min(4).max(140),
});

export const sessionStartSchema = z.object({
  guidance: solMissionSchema.extend({
    source: z.enum(['ai', 'fallback']).optional(),
  }),
});

export const sunCheckEvidenceSchema = z.object({
  cameraLum: z.number().min(0).max(255).nullable(),
  lightLux: z.number().min(0).nullable(),
  confidence: z.enum(['confirmed', 'estimated', 'unavailable']),
});

export const sessionCompletionSchema = z.object({
  durationMinutes: z.number().int().min(0).max(24 * 60),
  steps: z.number().int().min(0).nullable(),
  earnedToday: z.number().int().min(0).max(90),
  sunDebt: z.number().int().min(0),
});

export type SolMissionInput = z.infer<typeof solMissionInputSchema>;
export type SolMission = z.infer<typeof solMissionSchema>;
export type SunCheckEvidence = z.infer<typeof sunCheckEvidenceSchema>;
export type SessionCompletion = z.infer<typeof sessionCompletionSchema>;
export type SessionReward = {
  earned: number;
  xp: number;
  debtRepaid: number;
  sunMinutesAdded: number;
  sunDebtAfter: number;
};
