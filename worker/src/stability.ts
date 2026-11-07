import {LEVELS, type Level} from './levels';
import {summarize} from './metrics';
import type {Policy} from './policy';
import {
  policyForSamples,
  samplesPerModel,
  scoreRecords,
  type Experiment,
  type ExperimentRecord,
} from './rescore';
import {emptyVotes, type Votes} from './router';

/** A seeded uniform generator on [0, 1) (mulberry32), for repeatable draws. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k of the votes, drawn without replacement; all of them if fewer than k. */
export function subsample(votes: Votes, k: number, rand: () => number): Votes {
  const pool: Level[] = LEVELS.flatMap(l => Array<Level>(votes[l]).fill(l));
  // Partial Fisher-Yates: the first k places end up a uniform draw.
  for (let i = 0; i < Math.min(k, pool.length); i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = emptyVotes();
  for (const l of pool.slice(0, k)) out[l]++;
  return out;
}

export type StabilityRow = {
  /** Votes per model. */
  k: number;
  min_valid: number;
  min_top_votes: number;
  /** Mean reference emergencies routed below ed_now, per draw. */
  missed_mean: number;
  /** Share of draws with at least one such miss. */
  any_miss_rate: number;
  /** Mean share of cases routed to the same level as the full run. */
  agreement: number;
  flagged_rate: number;
  human_review_rate: number;
  cost_mean: number;
  cost_p90: number;
};

/**
 * How routing holds up with k votes per model instead of the run's own:
 * each draw subsamples k votes from every saved case, both models, and
 * re-decides with the thresholds scaled to k. Reads votes only.
 */
export function stabilityCurve(
  exp: Experiment,
  policy: Policy,
  ks: number[],
  draws: number,
  seed: number,
): StabilityRow[] {
  const rand = seededRandom(seed);
  const full = scoreRecords(
    exp.records,
    policyForSamples(policy, samplesPerModel(exp)),
  );
  return ks.map(k => {
    const p = policyForSamples(policy, k);
    let missed = 0;
    let anyMiss = 0;
    let agreement = 0;
    let flagged = 0;
    let humanReview = 0;
    const costs: number[] = [];
    for (let d = 0; d < draws; d++) {
      const records: ExperimentRecord[] = exp.records.map(r => ({
        ...r,
        primary: subsample(r.primary, k, rand),
        secondary: r.secondary ? subsample(r.secondary, k, rand) : null,
      }));
      const cases = scoreRecords(records, p);
      const s = summarize(cases, p);
      missed += s.missed;
      if (s.missed > 0) anyMiss++;
      flagged += s.flagged_rate;
      humanReview += s.human_review_rate;
      costs.push(s.cost_score);
      const same = cases.filter(
        (c, i) => c.disposition === full[i].disposition,
      ).length;
      agreement += cases.length ? same / cases.length : 1;
    }
    costs.sort((a, b) => a - b);
    return {
      k,
      min_valid: p.sampling.min_valid,
      min_top_votes: p.review.min_top_votes,
      missed_mean: missed / draws,
      any_miss_rate: anyMiss / draws,
      agreement: agreement / draws,
      flagged_rate: flagged / draws,
      human_review_rate: humanReview / draws,
      cost_mean: costs.reduce((a, b) => a + b, 0) / draws,
      cost_p90: costs[Math.min(draws - 1, Math.floor(0.9 * draws))],
    };
  });
}
