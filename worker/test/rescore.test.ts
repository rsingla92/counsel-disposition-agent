import {describe, expect, it} from 'vitest';
import {summarize, type ScoredCase} from '../src/metrics';
import {applyPolicyOverrides} from '../src/overrides';
import {loadPolicy} from '../src/policy';
import {
  policyForSamples,
  rescore,
  samplesPerModel,
  type Experiment,
  type ExperimentRecord,
} from '../src/rescore';
import {v} from './fixtures';

const policy = loadPolicy();

function record(over: Partial<ExperimentRecord>): ExperimentRecord {
  return {
    case_id: 'S00',
    reference: 'routine',
    fixed: null,
    floor: 'self_care',
    primary: v({routine: 20}),
    secondary: null,
    questions: 0,
    photo: false,
    base_reasons: [],
    latency_ms: 1000,
    ...over,
  };
}

// Synthetic records only: the repo is public.
const RECORDS: ExperimentRecord[] = [
  record({case_id: 'S01', questions: 1}),
  record({
    case_id: 'S02',
    reference: 'within_few_days',
    primary: v({within_few_days: 13, routine: 7}),
  }),
  record({
    case_id: 'S03',
    reference: 'in_person_today',
    fixed: {
      status: 'human_review',
      disposition: null,
      reasons: ['extraction_failed'],
    },
    primary: v({}),
  }),
  record({
    case_id: 'S04',
    fixed: {
      status: 'human_review',
      disposition: null,
      reasons: ['sampling_failed'],
    },
    primary: v({routine: 12}),
  }),
  record({
    case_id: 'S05',
    reference: 'ed_now',
    primary: v({ed_now: 8, in_person_today: 12}),
  }),
  record({
    case_id: 'S06',
    reference: 'call_911',
    floor: 'call_911',
    primary: v({call_911: 20}),
  }),
];

/** The outcomes the deployed policy gave each record, in order. */
const SAVED: ScoredCase[] = [
  {
    reference: 'routine',
    disposition: 'routine',
    status: 'needs_info',
    flagged: false,
  },
  {
    reference: 'within_few_days',
    disposition: 'within_few_days',
    status: 'routed',
    flagged: false,
  },
  {
    reference: 'in_person_today',
    disposition: null,
    status: 'human_review',
    flagged: true,
  },
  {
    reference: 'routine',
    disposition: null,
    status: 'human_review',
    flagged: true,
  },
  {
    reference: 'ed_now',
    disposition: 'ed_now',
    status: 'routed',
    flagged: false,
  },
  {
    reference: 'call_911',
    disposition: 'call_911',
    status: 'routed',
    flagged: false,
  },
];

function experiment(records = RECORDS, saved = SAVED): Experiment {
  return {
    id: 'synthetic',
    label: 'Synthetic run',
    models: 'default',
    rescorable: true,
    records,
    summary: summarize(saved, policy),
    median_latency_ms: 1000,
  };
}

const UNDER = policy.loss.boundaries.map(b => b.under);

describe('rescore', () => {
  it('equals the stored summary with no overrides', () => {
    const exp = experiment();
    expect(rescore(exp, policy)).toEqual(exp.summary);
  });

  it('raises flagged_rate when min_top_votes rises', () => {
    // S01 (20), S02 (13) and S05 (12 top votes). Overrides count in the
    // policy's votes: 4 of 5 is 16 of 20, which splits S02 and S05.
    // A split vote flags a case without the human_review status.
    const base = rescore(experiment(), policy);
    const raised = rescore(
      experiment(),
      applyPolicyOverrides(policy, {min_top_votes: 4}),
    );
    expect(raised.cost_score - base.cost_score).toBeCloseTo(
      (policy.loss.human_review_cost * 2) / 6,
      9,
    );
    expect(base.flagged_rate).toBeCloseTo(2 / 6, 9);
    expect(raised.flagged_rate).toBeCloseTo(4 / 6, 9);
    expect(raised.human_review_rate).toBe(base.human_review_rate);
  });

  it('never changes a fixed extraction_failed record', () => {
    const exp = experiment([RECORDS[2]], [SAVED[2]]);
    for (const o of [
      {},
      {min_valid: 10},
      {min_valid: 5, min_top_votes: 5},
      {max_span: 0, under_weights: UNDER.map(() => 0.5)},
    ]) {
      const s = rescore(exp, applyPolicyOverrides(policy, o));
      expect(s.confusion.in_person_today.human_review).toBe(1);
      expect(s.human_review_rate).toBe(1);
    }
  });

  it('re-routes a fixed sampling_failed record once min_valid is reached', () => {
    const exp = experiment([RECORDS[3]], [SAVED[3]]);
    expect(rescore(exp, policy).confusion.routine.human_review).toBe(1);
    const s = rescore(exp, applyPolicyOverrides(policy, {min_valid: 3}));
    expect(s.confusion.routine.human_review).toBe(0);
    expect(s.confusion.routine.routine).toBe(1);
    expect(s.human_review_rate).toBe(0);
  });

  it('keeps an unverified excerpt flagged when re-routing sampling_failed', () => {
    const unverified: ExperimentRecord = {
      ...RECORDS[3],
      base_reasons: ['unverified_excerpt'],
    };
    const exp = experiment([unverified], [SAVED[3]]);
    const s = rescore(exp, applyPolicyOverrides(policy, {min_valid: 3}));
    expect(s.human_review_rate).toBe(0);
    expect(s.confusion.routine.routine).toBe(1);
    expect(s.flagged_rate).toBe(1);
  });

  it('sends a routed record to Human review when min_valid rises past its votes', () => {
    const exp = experiment([RECORDS[3]], [SAVED[3]]);
    const routed = {...exp, records: [{...RECORDS[3], fixed: null}]};
    const s = rescore(routed, applyPolicyOverrides(policy, {min_valid: 4}));
    expect(s.human_review_rate).toBe(1);
  });

  it('can show a missed emergency when an emergency weight is lowered', () => {
    // The what-if re-scoring allows and the live route refuses.
    const exp = experiment();
    expect(rescore(exp, policy).missed).toBe(0);
    const lowered = UNDER.map((u, i) => (i === 1 ? 0.5 : u));
    const s = rescore(
      exp,
      applyPolicyOverrides(policy, {under_weights: lowered}),
    );
    expect(s.missed).toBe(1);
    expect(s.confusion.ed_now.in_person_today).toBe(1);
  });
});

describe('re-scoring a run made with more votes than the policy draws', () => {
  // A five-vote policy, whatever the checked-in policy says.
  const p5 = {
    ...policy,
    sampling: {...policy.sampling, n: 5, min_valid: 4},
    review: {...policy.review, min_top_votes: 3},
  };

  it('scales the count thresholds up to the run, rounding up', () => {
    const p = policyForSamples(p5, 20);
    expect(p.sampling.n).toBe(20);
    expect(p.sampling.min_valid).toBe(16);
    expect(p.review.min_top_votes).toBe(12);
    expect(p.review.max_span).toBe(p5.review.max_span);
  });

  it('leaves the policy as is at its own vote count', () =>
    expect(policyForSamples(p5, 5)).toEqual(p5));

  it('reads the votes per model from the run, defaulting to 20', () => {
    expect(samplesPerModel({...experiment(), samples_per_model: 5})).toBe(5);
    // Every run saved before samples_per_model existed drew 20.
    expect(samplesPerModel(experiment())).toBe(20);
  });

  it('needs 16 of 20 valid votes under a 4-of-5 policy', () => {
    const run = (votes: number) =>
      rescore(
        experiment([
          record({primary: v({routine: 20})}),
          record({primary: v({routine: votes})}),
        ]),
        p5,
      ).human_review_rate;
    expect(run(15)).toBe(0.5);
    expect(run(16)).toBe(0);
  });
});
