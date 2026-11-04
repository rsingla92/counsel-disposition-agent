import {z} from 'zod';
import {LEVELS, briefLabelOf, rank, tierOf, type Level} from './levels';
import type {Policy} from './policy';

const LevelSchema = z.enum(LEVELS);
const TierSchema = z.enum(['emergency', 'same_day', 'async', 'self_care']);
const BriefLabelSchema = z.enum([
  'URGENT_ESCALATION',
  'ASYNC_PHYSICIAN',
  'SELF_CARE',
]);

export const REASON_CODES = [
  'too_long',
  'non_english',
  'out_of_scope',
  'extraction_failed',
  'sampling_failed',
  'schema_invalid',
  'split_vote',
  'wide_spread',
  'family_disagreement',
  'unverified_excerpt',
  'secondary_unavailable',
  'missing_info',
  'photo_needed',
] as const;

export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/**
 * Why a physician overrode a disposition. Fixed codes, never free text, so
 * an override cannot carry patient details into the logs.
 */
export const OverrideReasonCodeSchema = z.enum([
  'under_triage',
  'over_triage',
  'missed_red_flag',
  'false_red_flag',
  'history_changes_risk',
  'needs_info_resolved',
  'other',
]);
export type OverrideReasonCode = z.infer<typeof OverrideReasonCodeSchema>;

/**
 * The structured-output schema sent to the extraction model. Every object is
 * strict and every key required, so the model must answer once per flag and
 * modifier in the policy.
 */
export function extractionSchema(policy: Policy) {
  const flags = Object.fromEntries(
    policy.red_flags.map(f => [
      f.id,
      z.strictObject({
        state: z.enum(['present', 'absent', 'unknown']),
        excerpt: z.string().nullable(),
      }),
    ]),
  );
  const modifiers = Object.fromEntries(
    policy.modifiers.map(m => [
      m.id,
      z.strictObject({present: z.boolean(), excerpt: z.string().nullable()}),
    ]),
  );
  return z.strictObject({
    language: z.string(),
    is_care_request: z.boolean(),
    red_flags: z.strictObject(flags),
    modifiers: z.strictObject(modifiers),
    questions: z.array(z.string()).max(3),
    photo_needed: z.boolean(),
    time_sensitive: z.boolean(),
  });
}

export type Extraction = z.infer<ReturnType<typeof extractionSchema>>;

export const SampleSchema = z.strictObject({
  disposition: LevelSchema,
  justification: z.string(),
  safety_net: z.string(),
});

export type Sample = z.infer<typeof SampleSchema>;

const VotesSchema = z.strictObject(
  Object.fromEntries(
    LEVELS.map(l => [l, z.number().int().nonnegative()]),
  ) as Record<Level, z.ZodNumber>,
);

export const RouteResultSchema = z
  .strictObject({
    status: z.enum(['routed', 'needs_info', 'human_review']),
    disposition: LevelSchema.nullable(),
    tier: TierSchema.nullable(),
    brief_label: BriefLabelSchema.nullable(),
    floor: LevelSchema.nullable(),
    red_flags: z.array(
      z.strictObject({
        id: z.string(),
        state: z.enum(['present', 'absent', 'unknown']),
        excerpt: z.string().nullable(),
        excerpt_verified: z.boolean(),
      }),
    ),
    modifiers: z.array(
      z.strictObject({id: z.string(), excerpt: z.string().nullable()}),
    ),
    votes: z.strictObject({
      primary: VotesSchema,
      secondary: VotesSchema.nullable(),
    }),
    confidence: z.number().min(0).max(1).nullable(),
    human_review: z.strictObject({
      flagged: z.boolean(),
      reasons: z.array(ReasonCodeSchema),
    }),
    info_requests: z.strictObject({
      questions: z.array(z.string()),
      photo: z.boolean(),
    }),
    time_sensitive: z.boolean(),
    justification: z.string(),
    safety_net: z.string(),
    patient_message: z.string(),
    trace: z.strictObject({
      input_sha256: z.string(),
      policy_version: z.string(),
      models: z.array(
        z.strictObject({model: z.string(), provider: z.string()}),
      ),
      latency_ms: z.number().nonnegative(),
      raw: z.unknown(),
    }),
  })
  .superRefine((r, ctx) => {
    if (
      r.disposition !== null &&
      r.floor !== null &&
      rank(r.disposition) < rank(r.floor)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: `disposition must not be below floor ${r.floor}`,
      });
    }
    if (r.status === 'human_review' || r.human_review.flagged) {
      if (!r.human_review.flagged) {
        ctx.addIssue({
          code: 'custom',
          path: ['human_review', 'flagged'],
          message: 'status human_review requires human_review.flagged',
        });
      }
      if (r.human_review.reasons.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['human_review', 'reasons'],
          message: 'human review requires at least one reason code',
        });
      }
    }
    if (r.disposition === null) {
      if (r.status !== 'human_review') {
        ctx.addIssue({
          code: 'custom',
          path: ['disposition'],
          message: 'null disposition requires status human_review',
        });
      }
      if (r.tier !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['tier'],
          message: 'tier must be null when disposition is null',
        });
      }
      if (r.brief_label !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['brief_label'],
          message: 'brief_label must be null when disposition is null',
        });
      }
      return;
    }
    if (r.tier !== tierOf(r.disposition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tier'],
        message: `tier must be ${tierOf(r.disposition)}`,
      });
    }
    if (r.brief_label !== briefLabelOf(r.disposition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['brief_label'],
        message: `brief_label must be ${briefLabelOf(r.disposition)}`,
      });
    }
  })
  .meta({
    description:
      'Shape only. Cross-field rules are not expressed here: null ' +
      'disposition only with status human_review, tier and brief_label ' +
      'derived from disposition, disposition never below floor, and human ' +
      'review always carrying a reason code. They are enforced by the ' +
      "Worker's RouteResultSchema (Zod).",
  });

export type RouteResult = z.infer<typeof RouteResultSchema>;
