import {describe, expect, it} from 'vitest';
import {decide, type DecideInput} from '../src/decide';
import {applyPolicyOverrides} from '../src/overrides';
import {policy20, v} from './fixtures';

const policy = policy20;

/** A unanimous 20-vote routine case with no secondary and nothing flagged. */
function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    primary: v({routine: 20}),
    primaryValid: 20,
    secondary: null,
    secondaryValid: null,
    floor: 'self_care',
    questions: 0,
    photo: false,
    baseReasons: [],
    ...over,
  };
}

describe('decide', () => {
  it('keeps an emergency floor when too few of 5 votes come back', () => {
    const n5 = {
      ...policy,
      sampling: {...policy.sampling, n: 5, min_valid: 4},
      review: {...policy.review, min_top_votes: 3},
    };
    const d = decide(
      input({primary: v({ed_now: 3}), primaryValid: 3, floor: 'ed_now'}),
      n5,
    );
    expect(d.status).toBe('human_review');
    expect(d.disposition).toBe('ed_now');
    expect(d.reasons).toEqual(['sampling_failed']);
  });

  it('routes a unanimous case with no reasons', () => {
    expect(decide(input(), policy)).toEqual({
      status: 'routed',
      disposition: 'routine',
      reasons: [],
      flagged: false,
      guardRaised: false,
    });
  });

  it('sends fewer than min_valid samples to Human review', () => {
    const d = decide(
      input({primary: v({routine: 14}), primaryValid: 14}),
      policy,
    );
    expect(d).toEqual({
      status: 'human_review',
      disposition: null,
      reasons: ['sampling_failed'],
      flagged: true,
      guardRaised: false,
    });
  });

  it('carries an emergency floor on sampling_failed', () => {
    const d = decide(
      input({primary: v({ed_now: 3}), primaryValid: 3, floor: 'ed_now'}),
      policy,
    );
    expect(d.status).toBe('human_review');
    expect(d.disposition).toBe('ed_now');
  });

  it('flags a split vote', () => {
    const d = decide(
      input({primary: v({routine: 11, within_few_days: 9}), primaryValid: 20}),
      policy,
    );
    expect(d.reasons).toEqual(['split_vote']);
    expect(d.flagged).toBe(true);
    expect(d.status).toBe('routed');
  });

  it('flags a wide span', () => {
    const d = decide(
      input({primary: v({routine: 19, in_person_today: 1}), primaryValid: 20}),
      policy,
    );
    expect(d.reasons).toContain('wide_spread');
  });

  it('flags family disagreement', () => {
    const d = decide(
      input({secondary: v({in_person_today: 20}), secondaryValid: 20}),
      policy,
    );
    expect(d.reasons).toEqual(['family_disagreement']);
    expect(d.flagged).toBe(true);
  });

  it('flags a failed secondary and keeps the primary disposition', () => {
    const d = decide(
      input({secondary: v({in_person_today: 4}), secondaryValid: 4}),
      policy,
    );
    expect(d.reasons).toEqual(['secondary_unavailable']);
    expect(d.disposition).toBe('routine');
    expect(d.flagged).toBe(true);
  });

  it('gives needs-info for questions and a photo, after base reasons', () => {
    const d = decide(
      input({questions: 2, photo: true, baseReasons: ['unverified_excerpt']}),
      policy,
    );
    expect(d.status).toBe('needs_info');
    expect(d.disposition).toBe('routine');
    expect(d.reasons).toEqual([
      'unverified_excerpt',
      'missing_info',
      'photo_needed',
    ]);
    expect(d.flagged).toBe(true);
  });

  it('does not flag needs-info alone', () => {
    const d = decide(input({questions: 1}), policy);
    expect(d.status).toBe('needs_info');
    expect(d.flagged).toBe(false);
  });

  it('does not throw when min_top_votes exceeds min_valid', () => {
    const p = applyPolicyOverrides(policy, {min_valid: 10, min_top_votes: 20});
    const d = decide(input({primary: v({routine: 10}), primaryValid: 10}), p);
    expect(d.status).toBe('routed');
    expect(d.reasons).toEqual(['split_vote']);
  });

  it('keeps the deployed emergency only when given the deployed policy', () => {
    // 3 ed_now / 17 self_care: the deployed weights choose ed_now.
    const lowered = applyPolicyOverrides(policy, {
      under_weights: [3, 0.5, 0.5, 0.5, 0.5, 0.5],
      max_span: 6,
    });
    const votes = input({primary: v({ed_now: 3, self_care: 17})});
    expect(decide(votes, lowered).disposition).not.toBe('ed_now');
    expect(decide(votes, lowered).guardRaised).toBe(false);
    const guarded = decide({...votes, deployedPolicy: policy}, lowered);
    expect(guarded.disposition).toBe('ed_now');
    expect(guarded.guardRaised).toBe(true);
  });

  it('reports no guard raise when the override already routes as high', () => {
    // Raised weights choose ed_now on their own, so the guard does nothing.
    const raised = applyPolicyOverrides(policy, {
      under_weights: [3, 40, 2, 5, 2, 1.5],
    });
    const d = decide(
      {
        ...input({primary: v({ed_now: 3, self_care: 17})}),
        deployedPolicy: policy,
      },
      raised,
    );
    expect(d.disposition).toBe('ed_now');
    expect(d.guardRaised).toBe(false);
  });
});
