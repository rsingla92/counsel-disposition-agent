import {z} from 'zod';
import {rank} from './levels';
import type {ModelSpec} from './llm';
import type {Policy} from './policy';

/** Floats within this of a step multiple count as on the step. */
const STEP_TOLERANCE = 1e-9;

/** A number from min to max inclusive, in multiples of step. */
function stepped(min: number, max: number, step: number) {
  return z
    .number()
    .min(min)
    .max(max)
    .refine(x => {
      const k = x / step;
      return Math.abs(k - Math.round(k)) < STEP_TOLERANCE;
    });
}

/**
 * Router settings a request may change, with fixed ranges (plan, "Override
 * ranges"). Out of range fails; nothing is clamped. The schema stands alone,
 * so a saved trace parses whatever policy is deployed: the rule that
 * min_top_votes is a majority of the effective min_valid is majorityOk(),
 * checked against a given policy.
 */
export const PolicyOverridesSchema = z.strictObject({
  // 20 is sampling.n; a test pins it.
  min_valid: z.number().int().min(10).max(20).optional(),
  // 6 is a majority of the lowest min_valid; majorityOk() tightens it.
  min_top_votes: z.number().int().min(6).max(20).optional(),
  max_span: z.number().int().min(0).max(6).optional(),
  human_review_cost: stepped(0.05, 2, 0.05).optional(),
  // One per loss boundary, in policy order; a test pins the count.
  under_weights: z
    .array(stepped(0.5, 50, 0.5))
    .length(6)
    .optional(),
});

export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;

export const MODEL_CHOICES = ['sonnet', 'flash', 'sonnet+flash'] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

export const RouteOverridesSchema = z.strictObject({
  models: z.enum(MODEL_CHOICES).optional(),
  policy: PolicyOverridesSchema.optional(),
});

/**
 * Overrides a live /v1/route request may send. human_review_cost is left
 * out: the Worker never reads it, so accepting it would claim an effect
 * that does not exist. Re-scoring uses it, through PolicyOverridesSchema.
 */
export const LiveRouteOverridesSchema = z.strictObject({
  models: z.enum(MODEL_CHOICES).optional(),
  policy: PolicyOverridesSchema.omit({human_review_cost: true}).optional(),
});

/**
 * True when min_top_votes, if given, is a simple majority of the effective
 * min_valid: the override's if given, else `policy`'s.
 */
export function majorityOk(
  policy: Policy,
  o: PolicyOverrides | undefined,
): boolean {
  if (o?.min_top_votes === undefined) return true;
  const minValid = o.min_valid ?? policy.sampling.min_valid;
  return o.min_top_votes >= Math.floor(minValid / 2) + 1;
}

export type RouteOverrides = z.infer<typeof RouteOverridesSchema>;

/**
 * A deep copy of `policy` with only the overridden router fields replaced.
 * Red flags, levels, modifiers and the sample count always stay as loaded.
 */
export function applyPolicyOverrides(
  policy: Policy,
  o: PolicyOverrides | undefined,
): Policy {
  const out = structuredClone(policy);
  if (!o) return out;
  if (o.min_valid !== undefined) out.sampling.min_valid = o.min_valid;
  if (o.min_top_votes !== undefined) {
    out.review.min_top_votes = o.min_top_votes;
  }
  if (o.max_span !== undefined) out.review.max_span = o.max_span;
  if (o.human_review_cost !== undefined) {
    out.loss.human_review_cost = o.human_review_cost;
  }
  o.under_weights?.forEach((w, i) => {
    out.loss.boundaries[i].under = w;
  });
  return out;
}

/**
 * Null when the overrides may run live. An under weight on a boundary
 * whose more acute side is an emergency (call_911/ed_now and
 * ed_now/in_person_today) may not drop below the deployed policy's, so no
 * live route lands an emergency lower than the deployed policy would.
 */
export function checkLiveSafe(
  policy: Policy,
  o: PolicyOverrides | undefined,
): string | null {
  const w = o?.under_weights;
  if (!w) return null;
  const lowered = policy.loss.boundaries.some(
    (b, i) => rank(b.between[0]) >= rank('ed_now') && w[i] < b.under,
  );
  return lowered ? 'emergency_weight_below_policy' : null;
}

/**
 * The models for a request. `primary` is the env PRIMARY_* spec (Sonnet)
 * and `secondary` the env SECONDARY_* spec (Flash). Throws for flash or
 * sonnet+flash when no secondary is configured.
 */
export function selectModels(
  choice: ModelChoice | undefined,
  primary: ModelSpec,
  secondary: ModelSpec | null,
): {primary: ModelSpec; secondary: ModelSpec | null} {
  switch (choice) {
    case 'sonnet':
      return {primary, secondary: null};
    case 'flash':
      if (!secondary) throw new Error('secondary model not configured');
      return {primary: secondary, secondary: null};
    case 'sonnet+flash':
      if (!secondary) throw new Error('secondary model not configured');
      return {primary, secondary};
    default:
      return {primary, secondary};
  }
}
