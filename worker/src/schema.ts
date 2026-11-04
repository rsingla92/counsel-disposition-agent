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

// A blank excerpt means none. Null is still accepted on input.
const ParsedExcerpt = z
  .string()
  .nullable()
  .transform(s => (s === null || s.trim() === '' ? null : s));

const FlagStateSchema = z.enum(['present', 'absent', 'unknown']);
type FlagState = z.infer<typeof FlagStateSchema>;

// Red flags go to the model as a list of {id, state, excerpt}, not one key per
// flag: Anthropic's grammar compiler rejects a schema with a strict object per
// flag as too large.
function flagList<E extends z.ZodType>(policy: Policy, excerpt: E) {
  const ids = policy.red_flags.map(f => f.id) as [string, ...string[]];
  return z.array(
    z.strictObject({id: z.enum(ids), state: FlagStateSchema, excerpt}),
  );
}

// The parser requires every policy flag exactly once, then keys them by id.
function parsedFlags(policy: Policy) {
  return flagList(policy, ParsedExcerpt)
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      for (const e of entries) {
        if (seen.has(e.id)) ctx.addIssue(`duplicate red flag: ${e.id}`);
        seen.add(e.id);
      }
      for (const f of policy.red_flags) {
        if (!seen.has(f.id)) ctx.addIssue(`missing red flag: ${f.id}`);
      }
    })
    .transform(
      entries =>
        Object.fromEntries(
          entries.map(e => [e.id, {state: e.state, excerpt: e.excerpt}]),
        ) as Record<string, {state: FlagState; excerpt: string | null}>,
    );
}

// Every object is strict and every key required, so the model must answer
// once per flag and modifier in the policy.
function extractionShape<F extends z.ZodType, E extends z.ZodType>(
  policy: Policy,
  flags: F,
  excerpt: E,
) {
  const modifiers = Object.fromEntries(
    policy.modifiers.map(m => [
      m.id,
      z.strictObject({present: z.boolean(), excerpt}),
    ]),
  );
  return z.strictObject({
    language: z.string(),
    is_care_request: z.boolean(),
    red_flags: flags,
    modifiers: z.strictObject(modifiers),
    questions: z.array(z.string()).max(3),
    photo_needed: z.boolean(),
    time_sensitive: z.boolean(),
  });
}

const SEVERITY: Record<FlagState, number> = {unknown: 0, absent: 1, present: 2};

/**
 * Reads the red flags it can from extraction output that failed to parse, so
 * a flag the model did mark present still sets the floor. Entries with an
 * unknown id or a bad state are skipped, a flag listed twice keeps its most
 * severe state, and a missing flag is unknown. Null when there is no list.
 */
export function salvageFlags(
  policy: Policy,
  json: unknown,
): Extraction['red_flags'] | null {
  const list = (json as {red_flags?: unknown} | null)?.red_flags;
  if (!Array.isArray(list)) return null;
  const ids = policy.red_flags.map(f => f.id) as [string, ...string[]];
  const Entry = z.object({
    id: z.enum(ids),
    state: FlagStateSchema,
    excerpt: ParsedExcerpt,
  });
  const out: Extraction['red_flags'] = Object.fromEntries(
    ids.map(id => [id, {state: 'unknown' as FlagState, excerpt: null}]),
  );
  for (const item of list) {
    const e = Entry.safeParse(item);
    if (!e.success) continue;
    if (SEVERITY[e.data.state] > SEVERITY[out[e.data.id].state]) {
      out[e.data.id] = {state: e.data.state, excerpt: e.data.excerpt};
    }
  }
  return out;
}

/** Parses the extraction model's output. A blank excerpt becomes null. */
export function extractionSchema(policy: Policy) {
  return extractionShape(policy, parsedFlags(policy), ParsedExcerpt);
}

/**
 * The structured-output schema sent to the extraction model. Excerpts are
 * plain strings, empty for none, because Anthropic's strict mode allows at
 * most 16 nullable or union-typed fields and the policy has more flags.
 */
export function extractionJsonSchema(policy: Policy): Record<string, unknown> {
  const wire = extractionShape(
    policy,
    flagList(policy, z.string()),
    z.string(),
  );
  const schema = z.toJSONSchema(wire) as Record<string, unknown>;
  delete schema.$schema; // some providers reject it
  return schema;
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
      z.strictObject({
        id: z.string(),
        excerpt: z.string().nullable(),
        excerpt_verified: z.boolean(),
      }),
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
