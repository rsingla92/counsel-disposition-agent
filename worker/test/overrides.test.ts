import {describe, expect, it} from 'vitest';
import {
  LiveRouteOverridesSchema,
  MODEL_CHOICES,
  PolicyOverridesSchema,
  RouteOverridesSchema,
  applyPolicyOverrides,
  checkLiveSafe,
  majorityOk,
  selectModels,
} from '../src/overrides';
import {loadPolicy} from '../src/policy';
import {RouteResultSchema} from '../src/schema';
import {validResult} from './fixtures';
import {PRIMARY, SECONDARY} from './pipeline-fixtures';

const policy = loadPolicy();
const UNDER = policy.loss.boundaries.map(b => b.under);

function ok(o: unknown): boolean {
  return PolicyOverridesSchema.safeParse(o).success;
}

describe('applyPolicyOverrides', () => {
  it('replaces only the named field and does not mutate the input', () => {
    const before = structuredClone(policy);
    const out = applyPolicyOverrides(policy, {min_top_votes: 14});
    expect(out.review.min_top_votes).toBe(14);
    expect({...out, review: {...out.review, min_top_votes: 12}}).toEqual({
      ...policy,
      review: {...policy.review, min_top_votes: 12},
    });
    expect(out.red_flags).toEqual(policy.red_flags);
    expect(out.loss.boundaries.map(b => b.over)).toEqual(
      policy.loss.boundaries.map(b => b.over),
    );
    expect(policy).toEqual(before);
    expect(out).not.toBe(policy);
    expect(out.red_flags).not.toBe(policy.red_flags);
  });

  it('returns an equal copy for no overrides', () => {
    expect(applyPolicyOverrides(policy, undefined)).toEqual(policy);
    expect(applyPolicyOverrides(policy, {})).toEqual(policy);
    expect(applyPolicyOverrides(policy, undefined)).not.toBe(policy);
  });

  it('maps every field to its policy key', () => {
    const out = applyPolicyOverrides(policy, {
      min_valid: 12,
      min_top_votes: 10,
      max_span: 4,
      human_review_cost: 0.5,
    });
    expect(out.sampling).toEqual({...policy.sampling, min_valid: 12});
    expect(out.review).toEqual({
      ...policy.review,
      min_top_votes: 10,
      max_span: 4,
    });
    expect(out.loss.human_review_cost).toBe(0.5);
    expect(out.sampling.n).toBe(policy.sampling.n);
    expect(out.levels).toEqual(policy.levels);
    expect(out.modifiers).toEqual(policy.modifiers);
  });

  it('maps under_weights in order onto loss.boundaries[i].under', () => {
    const w = [4, 25, 3, 6, 2.5, 0.5];
    const out = applyPolicyOverrides(policy, {under_weights: w});
    expect(out.loss.boundaries.map(b => b.under)).toEqual(w);
    expect(out.loss.boundaries.map(b => b.between)).toEqual(
      policy.loss.boundaries.map(b => b.between),
    );
    expect(out.loss.boundaries.map(b => b.over)).toEqual(
      policy.loss.boundaries.map(b => b.over),
    );
  });
});

describe('PolicyOverridesSchema', () => {
  it('requires exactly six under_weights', () => {
    expect(ok({under_weights: UNDER})).toBe(true);
    expect(ok({under_weights: UNDER.slice(0, 5)})).toBe(false);
    expect(ok({under_weights: [...UNDER, 1]})).toBe(false);
  });

  it('accepts min_valid 10 to 20', () => {
    expect(ok({min_valid: 10})).toBe(true);
    expect(ok({min_valid: 20})).toBe(true);
    expect(ok({min_valid: 9})).toBe(false);
    expect(ok({min_valid: 21})).toBe(false);
    expect(ok({min_valid: 15.5})).toBe(false);
  });

  it('bounds min_top_votes below by 6 on its own', () => {
    expect(ok({min_top_votes: 5})).toBe(false);
    expect(ok({min_top_votes: 6})).toBe(true);
  });

  it('accepts min_top_votes up to 20', () => {
    expect(ok({min_top_votes: 20})).toBe(true);
    expect(ok({min_top_votes: 21})).toBe(false);
    expect(ok({min_valid: 10, min_top_votes: 20})).toBe(true);
  });

  it('accepts max_span 0 to 6', () => {
    expect(ok({max_span: 0})).toBe(true);
    expect(ok({max_span: 6})).toBe(true);
    expect(ok({max_span: -1})).toBe(false);
    expect(ok({max_span: 7})).toBe(false);
  });

  it('accepts human_review_cost 0.05 to 2 in steps of 0.05', () => {
    expect(ok({human_review_cost: 0.05})).toBe(true);
    expect(ok({human_review_cost: 2})).toBe(true);
    expect(ok({human_review_cost: 0.2})).toBe(true);
    expect(ok({human_review_cost: 0.1 + 0.2})).toBe(true);
    expect(ok({human_review_cost: 0})).toBe(false);
    expect(ok({human_review_cost: 2.05})).toBe(false);
    expect(ok({human_review_cost: 0.07})).toBe(false);
  });

  it('accepts each under weight 0.5 to 50 in steps of 0.5', () => {
    const at = (i: number, x: number) =>
      ok({under_weights: UNDER.map((u, j) => (j === i ? x : u))});
    for (let i = 0; i < 6; i++) {
      expect(at(i, 0.5)).toBe(true);
      expect(at(i, 50)).toBe(true);
      expect(at(i, 0)).toBe(false);
      expect(at(i, 50.5)).toBe(false);
      expect(at(i, 1.25)).toBe(false);
    }
  });

  it('rejects unknown fields and non-numbers', () => {
    expect(ok({})).toBe(true);
    expect(ok({sampling_n: 10})).toBe(false);
    expect(ok({red_flags: []})).toBe(false);
    expect(ok({min_valid: '15'})).toBe(false);
  });
});

describe('policy pins', () => {
  it('has 20 samples', () => {
    // overrides.ts caps min_valid at 20 assuming sampling.n is 20.
    expect(policy.sampling.n).toBe(20);
  });

  it('has 6 loss boundaries', () => {
    // overrides.ts requires exactly 6 under_weights, one per boundary.
    expect(policy.loss.boundaries.length).toBe(6);
  });
});

describe('majorityOk', () => {
  it('bounds min_top_votes by a majority of the effective min_valid', () => {
    const at = (o: object) => majorityOk(policy, o);
    expect(at({min_valid: 15, min_top_votes: 7})).toBe(false);
    expect(at({min_valid: 15, min_top_votes: 8})).toBe(true);
    expect(at({min_valid: 10, min_top_votes: 5})).toBe(false);
    expect(at({min_valid: 10, min_top_votes: 6})).toBe(true);
    expect(at({min_valid: 20, min_top_votes: 10})).toBe(false);
    expect(at({min_valid: 20, min_top_votes: 11})).toBe(true);
    // Without min_valid, the given policy's (15 here) applies.
    expect(policy.sampling.min_valid).toBe(15);
    expect(at({min_top_votes: 7})).toBe(false);
    expect(at({min_top_votes: 8})).toBe(true);
    expect(at({min_valid: 10})).toBe(true);
    expect(majorityOk(policy, undefined)).toBe(true);
  });

  it('uses the policy it is given', () => {
    const p = structuredClone(policy);
    p.sampling.min_valid = 10;
    expect(majorityOk(p, {min_top_votes: 6})).toBe(true);
    expect(majorityOk(policy, {min_top_votes: 6})).toBe(false);
  });
});

describe('trace overrides', () => {
  it('parse without reference to the loaded policy', () => {
    const r = {
      ...validResult,
      trace: {...validResult.trace, overrides: {policy: {min_top_votes: 6}}},
    };
    expect(RouteResultSchema.safeParse(r).success).toBe(true);
  });
});

describe('LiveRouteOverridesSchema', () => {
  it('rejects human_review_cost, which live routes do not use', () => {
    expect(
      PolicyOverridesSchema.safeParse({human_review_cost: 0.5}).success,
    ).toBe(true);
    expect(
      LiveRouteOverridesSchema.safeParse({policy: {human_review_cost: 0.5}})
        .success,
    ).toBe(false);
    expect(
      LiveRouteOverridesSchema.safeParse({
        models: 'flash',
        policy: {min_valid: 12, max_span: 3, under_weights: UNDER},
      }).success,
    ).toBe(true);
    expect(
      LiveRouteOverridesSchema.safeParse({policy: {bogus: 1}}).success,
    ).toBe(false);
  });
});

describe('RouteOverridesSchema', () => {
  it('accepts the three model choices only', () => {
    for (const models of MODEL_CHOICES) {
      expect(RouteOverridesSchema.safeParse({models}).success).toBe(true);
    }
    expect(RouteOverridesSchema.safeParse({models: 'gpt'}).success).toBe(false);
    expect(RouteOverridesSchema.safeParse({extra: 1}).success).toBe(false);
    expect(
      RouteOverridesSchema.safeParse({policy: {min_valid: 30}}).success,
    ).toBe(false);
  });
});

describe('checkLiveSafe', () => {
  const at = (i: number, x: number) => ({
    under_weights: UNDER.map((u, j) => (j === i ? x : u)),
  });

  it('rejects an emergency under weight below the policy', () => {
    expect(UNDER[1]).toBe(20);
    expect(checkLiveSafe(policy, at(1, 19))).toBe(
      'emergency_weight_below_policy',
    );
    expect(checkLiveSafe(policy, at(0, UNDER[0] - 0.5))).toBe(
      'emergency_weight_below_policy',
    );
  });

  it('allows emergency weights at or above the policy', () => {
    expect(checkLiveSafe(policy, at(1, 25))).toBeNull();
    expect(checkLiveSafe(policy, at(1, 20))).toBeNull();
    expect(checkLiveSafe(policy, {under_weights: UNDER})).toBeNull();
  });

  it('guards only indices 0 and 1', () => {
    expect(checkLiveSafe(policy, at(2, 0.5))).toBeNull();
    expect(checkLiveSafe(policy, at(5, 0.5))).toBeNull();
  });

  it('allows no overrides and overrides without weights', () => {
    expect(checkLiveSafe(policy, undefined)).toBeNull();
    expect(checkLiveSafe(policy, {min_valid: 10})).toBeNull();
  });
});

describe('selectModels', () => {
  it('maps each choice onto the env specs', () => {
    expect(selectModels('sonnet', PRIMARY, SECONDARY)).toEqual({
      primary: PRIMARY,
      secondary: null,
    });
    expect(selectModels('flash', PRIMARY, SECONDARY)).toEqual({
      primary: SECONDARY,
      secondary: null,
    });
    expect(selectModels('sonnet+flash', PRIMARY, SECONDARY)).toEqual({
      primary: PRIMARY,
      secondary: SECONDARY,
    });
    expect(selectModels(undefined, PRIMARY, SECONDARY)).toEqual({
      primary: PRIMARY,
      secondary: SECONDARY,
    });
    expect(selectModels(undefined, PRIMARY, null)).toEqual({
      primary: PRIMARY,
      secondary: null,
    });
  });

  it('throws for flash or sonnet+flash with no secondary configured', () => {
    expect(() => selectModels('flash', PRIMARY, null)).toThrow();
    expect(() => selectModels('sonnet+flash', PRIMARY, null)).toThrow();
  });
});
