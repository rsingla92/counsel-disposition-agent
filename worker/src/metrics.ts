import {LEVELS, rank, type Level} from './levels';
import type {Policy} from './policy';
import {cost} from './router';

export type ScoredCase = {
  reference: Level;
  disposition: Level | null;
  status: 'routed' | 'needs_info' | 'human_review';
  flagged: boolean;
};

export type Summary = {
  n: number;
  emergencies: number;
  missed: number;
  human_review_rate: number;
  needs_info_rate: number;
  over_triage_rate: number;
  cost_score: number;
  confusion: Record<Level, Record<Level | 'human_review', number>>;
};

/** The level a case is scored as; Human review with no disposition is routine. */
export function received(c: ScoredCase): Level {
  return c.disposition ?? 'routine';
}

function share(n: number, total: number): number {
  return total === 0 ? Number.NaN : n / total;
}

/** Re-scores cases with the same definitions as the eval's scoring.py. */
export function summarize(cases: ScoredCase[], policy: Policy): Summary {
  const n = cases.length;
  const edRank = rank('ed_now');
  const columns = [...LEVELS, 'human_review'] as const;
  const confusion = Object.fromEntries(
    LEVELS.map(l => [l, Object.fromEntries(columns.map(c => [c, 0]))]),
  ) as Summary['confusion'];

  let emergencies = 0;
  let missed = 0;
  let humanReview = 0;
  let needsInfo = 0;
  let over = 0;
  let flagged = 0;
  let totalCost = 0;
  for (const c of cases) {
    const got = received(c);
    if (c.reference === 'call_911' || c.reference === 'ed_now') {
      emergencies += 1;
      if (rank(got) < edRank) missed += 1;
    }
    if (c.status === 'human_review') humanReview += 1;
    if (c.status === 'needs_info') needsInfo += 1;
    if (rank(got) > rank(c.reference)) over += 1;
    if (c.flagged) flagged += 1;
    totalCost += cost(c.reference, got, policy);
    const column = c.status === 'human_review' ? 'human_review' : got;
    confusion[c.reference][column] += 1;
  }

  return {
    n,
    emergencies,
    missed,
    human_review_rate: share(humanReview, n),
    needs_info_rate: share(needsInfo, n),
    over_triage_rate: share(over, n),
    cost_score:
      share(totalCost, n) + policy.loss.human_review_cost * share(flagged, n),
    confusion,
  };
}
