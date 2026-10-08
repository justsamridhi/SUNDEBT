import { z } from 'zod';

export const solMissionInputSchema = z.object({
  sunDebt: z.number().min(0),
  sunMinutes: z.number().min(0),
  recentSessionDurations: z.array(z.number().int().min(0).max(24 * 60)).max(3),
  timeOfDay: z.string().min(1).max(80),
}).strict();

const solMissionTextFieldsSchema = z.object({
  mission: z.string().trim().min(8).max(180),
  motivation: z.string().trim().min(4).max(140),
});

export const solMissionOutputSchema = solMissionTextFieldsSchema.extend({
  recommendedDurationMinutes: z.number().int(),
});

const safeMissionRefinement = ({ mission, motivation }: {
  mission: string;
  motivation: string;
}) => {
  const text = `${mission} ${motivation}`;
  const unsafeLocation = /\b(roof\w*|cliff\w*|highway\w*|road\w*|street\w*|traffic\w*|construction site\w*|abandoned building\w*|private property\w*|trespass\w*|railroad\w*|train tracks\w*|bridge\w*|quarry\w*|riverbank\w*|waterfall\w*)\b/i.test(text);
  const nighttime = /\b(after dark|at night|after sunset|after sundown|after dusk|when it gets dark)\b/i.test(text);
  const alone = /\b(alone|by yourself|on your own|solo)\b/i.test(text);
  const medical = /\b(vitamin d|cure\w*|treat\w*|diagnos\w*|medical\w*|therapy\w*|health\w*|prescri\w*|supplement\w*)\b/i.test(text);
  return !unsafeLocation && !(nighttime && alone) && !medical;
};

export const solMissionSchema = solMissionTextFieldsSchema.extend({
  recommendedDurationMinutes: z.number().int().min(5).max(60),
}).refine(safeMissionRefinement, 'Mission and motivation must be safe, generic, and free of medical claims');

export const solGuidanceSchema = solMissionTextFieldsSchema.extend({
  recommendedDurationMinutes: z.number().int().min(5).max(60),
  source: z.enum(['ai', 'fallback']),
}).refine(safeMissionRefinement, 'Mission and motivation must be safe, generic, and free of medical claims');

export const sessionStartSchema = z.object({
  sessionId: z.string().uuid(),
  missionContext: solMissionInputSchema,
});

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sun-check'),
    eventId: z.string().uuid(),
    evidence: z.object({
      cameraLum: z.number().min(0).max(255).nullable(),
      lightLux: z.number().min(0).nullable(),
      confidence: z.enum(['confirmed', 'estimated', 'unavailable']),
    }),
  }),
  z.object({ type: z.literal('phone-down'), eventId: z.string().uuid() }),
  z.object({ type: z.literal('interrupted'), eventId: z.string().uuid() }),
  z.object({ type: z.literal('resumed'), eventId: z.string().uuid() }),
]);

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

export const sessionCompletionEventSchema = sessionCompletionSchema.extend({
  eventId: z.string().uuid(),
});

export type SolMissionInput = z.infer<typeof solMissionInputSchema>;
export type SolMission = z.infer<typeof solMissionSchema>;
export type SolGuidance = z.infer<typeof solGuidanceSchema>;
export type SunCheckEvidence = z.infer<typeof sunCheckEvidenceSchema>;
export type SessionCompletion = z.infer<typeof sessionCompletionSchema>;
export type SessionReward = {
  earned: number;
  xp: number;
  debtRepaid: number;
  sunMinutesAdded: number;
  sunDebtAfter: number;
};
