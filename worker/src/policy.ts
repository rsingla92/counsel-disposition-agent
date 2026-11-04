import {z} from 'zod';
import {LEVELS} from './levels';
import policyJson from './generated/policy.json';

const LevelSchema = z.enum(LEVELS);
const GroupSchema = z.enum(['adult', 'pediatric', 'obstetric']);
const IdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

const LevelCopySchema = z.object({
  physician_window: z.string().min(1),
  patient_window: z.string().min(1),
  patient_message: z.string().min(1),
});

export const PolicySchema = z.object({
  policy_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  intake: z.object({max_chars: z.number().int().positive()}),
  sampling: z.object({
    n: z.number().int().positive(),
    temperature: z.number().min(0),
    min_valid: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
  review: z.object({
    min_top_votes: z.number().int().positive(),
    max_span: z.number().int().nonnegative(),
    family_tier_disagreement: z.boolean(),
  }),
  modifier_cap: LevelSchema,
  loss: z.object({
    human_review_cost: z.number().positive(),
    boundaries: z.array(
      z.object({
        between: z.tuple([LevelSchema, LevelSchema]),
        under: z.number().positive(),
        over: z.number().positive(),
      }),
    ),
  }),
  levels: z.object(
    Object.fromEntries(LEVELS.map(l => [l, LevelCopySchema])) as Record<
      (typeof LEVELS)[number],
      typeof LevelCopySchema
    >,
  ),
  red_flags: z.array(
    z.object({
      id: IdSchema,
      group: GroupSchema,
      description: z.string().min(1),
      min_level: LevelSchema,
      subsumes_modifiers: z.array(IdSchema).default([]),
      instruction: z.string().min(1).optional(),
      cases: z.array(z.number().int().positive()),
    }),
  ),
  modifiers: z.array(
    z.object({
      id: IdSchema,
      group: GroupSchema,
      description: z.string().min(1),
    }),
  ),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Parses the generated policy JSON; throws if it does not match the schema. */
export function loadPolicy(): Policy {
  return PolicySchema.parse(policyJson);
}
