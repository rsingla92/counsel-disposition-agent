import {describe, expect, it} from 'vitest';
import {LEVELS} from '../src/levels';
import {loadPolicy} from '../src/policy';
import type {Experiment, ExperimentRecord} from '../src/rescore';
import {seededRandom, stabilityCurve, subsample} from '../src/stability';
import {v} from './fixtures';

const policy = loadPolicy();

const total = (votes: ReturnType<typeof v>) =>
  LEVELS.reduce((s, l) => s + votes[l], 0);

// Synthetic records only: the repo is public.
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

function experiment(records: ExperimentRecord[]): Experiment {
  return {
    id: 'synthetic',
    label: 'Synthetic run',
    models: 'default',
    rescorable: true,
    samples_per_model: 20,
    records,
    // stabilityCurve never reads the stored summary.
    summary: undefined as unknown as Experiment['summary'],
    median_latency_ms: 1000,
  };
}

describe('subsample', () => {
  it('draws exactly k votes, never more of a level than given', () => {
    const rand = seededRandom(1);
    const votes = v({routine: 3, within_few_days: 17});
    for (let i = 0; i < 50; i++) {
      const s = subsample(votes, 5, rand);
      expect(total(s)).toBe(5);
      expect(s.routine).toBeLessThanOrEqual(3);
    }
  });

  it('returns every vote when there are fewer than k', () =>
    expect(subsample(v({routine: 3}), 5, seededRandom(1))).toEqual(
      v({routine: 3}),
    ));

  it('draws the same votes from the same seed', () => {
    const votes = v({routine: 10, within_few_days: 10});
    const a = seededRandom(7);
    const b = seededRandom(7);
    for (let i = 0; i < 10; i++) {
      expect(subsample(votes, 5, a)).toEqual(subsample(votes, 5, b));
    }
  });
});

describe('stabilityCurve', () => {
  it('agrees fully and misses nothing when every vote agrees', () => {
    const exp = experiment([
      record({}),
      record({reference: 'ed_now', floor: 'ed_now', primary: v({ed_now: 20})}),
    ]);
    for (const row of stabilityCurve(exp, policy, [3, 5, 20], 20, 1)) {
      expect(row.agreement).toBe(1);
      expect(row.missed_mean).toBe(0);
      expect(row.any_miss_rate).toBe(0);
    }
  });

  it('wavers on an even split at 3 votes but not at 20', () => {
    const exp = experiment([
      record({
        reference: 'ed_now',
        primary: v({ed_now: 10, in_person_today: 10}),
      }),
    ]);
    const [k3, k20] = stabilityCurve(exp, policy, [3, 20], 200, 1);
    expect(k3.agreement).toBeLessThan(1);
    expect(k20.agreement).toBe(1);
  });

  it('reports the thresholds scaled to each k', () => {
    const exp = experiment([record({})]);
    const [k5] = stabilityCurve(exp, policy, [5], 1, 1);
    expect(k5.k).toBe(5);
    expect(k5.min_valid).toBe(
      Math.ceil((policy.sampling.min_valid * 5) / policy.sampling.n),
    );
  });
});
