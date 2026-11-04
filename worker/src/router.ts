import {LEVELS, rank, tierOf, type Level} from './levels';
import type {Policy} from './policy';
import type {ReasonCode} from './schema';

export type Votes = Record<Level, number>;

/** Costs closer than this are treated as tied. */
const TIE_TOLERANCE = 1e-9;

export function emptyVotes(): Votes {
  return Object.fromEntries(LEVELS.map(l => [l, 0])) as Votes;
}

function total(votes: Votes): number {
  return LEVELS.reduce((sum, l) => sum + votes[l], 0);
}

/**
 * The loss of choosing `chosen` when `trueLevel` is right: the sum of `under`
 * (chosen is less acute) or `over` (chosen is more acute) across each boundary
 * strictly between the two.
 */
export function cost(trueLevel: Level, chosen: Level, policy: Policy): number {
  const t = rank(trueLevel);
  const c = rank(chosen);
  if (t === c) return 0;
  const under = c < t;
  let sum = 0;
  for (const b of policy.loss.boundaries) {
    // Boundary sits between rank(lower) and rank(higher) = rank(lower) + 1.
    const lo = rank(b.between[1]);
    const hi = rank(b.between[0]);
    if (lo >= Math.min(t, c) && hi <= Math.max(t, c)) {
      sum += under ? b.under : b.over;
    }
  }
  return sum;
}

export function expectedCost(
  votes: Votes,
  chosen: Level,
  policy: Policy,
): number {
  const n = total(votes);
  return LEVELS.reduce(
    (sum, t) => sum + (votes[t] / n) * cost(t, chosen, policy),
    0,
  );
}

/**
 * The level at or above `floor` with the lowest expected cost. Ties go to the
 * more acute level. Throws if there are no votes: no evidence must fail loudly.
 */
export function chooseLevel(votes: Votes, floor: Level, policy: Policy): Level {
  if (total(votes) <= 0) {
    throw new RangeError('cannot choose a level from zero votes');
  }
  let best: Level | null = null;
  let bestCost = Infinity;
  // LEVELS is most acute first, so strict improvement beyond the tolerance
  // keeps the more acute level on ties.
  for (const l of LEVELS) {
    if (rank(l) < rank(floor)) continue;
    const c = expectedCost(votes, l, policy);
    if (best === null || c < bestCost - TIE_TOLERANCE) {
      best = l;
      bestCost = c;
    }
  }
  return best as Level;
}

/** The most-voted level; ties go to the more acute. Null when no votes. */
function mode(votes: Votes): Level | null {
  let best: Level | null = null;
  for (const l of LEVELS) {
    if (votes[l] > 0 && (best === null || votes[l] > votes[best])) best = l;
  }
  return best;
}

export function reviewReasons(
  primary: Votes,
  secondary: Votes | null,
  policy: Policy,
): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  const top = Math.max(...LEVELS.map(l => primary[l]));
  if (top < policy.review.min_top_votes) reasons.push('split_vote');

  const voted = LEVELS.filter(l => primary[l] > 0).map(rank);
  if (
    voted.length > 0 &&
    Math.max(...voted) - Math.min(...voted) > policy.review.max_span
  ) {
    reasons.push('wide_spread');
  }

  if (policy.review.family_tier_disagreement && secondary !== null) {
    const a = mode(primary);
    const b = mode(secondary);
    if (a !== null && b !== null && tierOf(a) !== tierOf(b)) {
      reasons.push('family_disagreement');
    }
  }
  return reasons;
}
