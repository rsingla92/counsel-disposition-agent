import {rank, type Level} from './levels';
import type {Policy} from './policy';
import {chooseLevel, reviewReasons, type Votes} from './router';
import type {ReasonCode} from './schema';

/** Reasons that put the case in front of a physician for review. */
export const REVIEW_REASONS: ReadonlySet<ReasonCode> = new Set([
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
]);

export type DecideInput = {
  primary: Votes;
  primaryValid: number;
  /** Null when no secondary family is configured. */
  secondary: Votes | null;
  secondaryValid: number | null;
  floor: Level;
  questions: number;
  photo: boolean;
  /** Reasons found before sampling, such as unverified_excerpt. */
  baseReasons: ReasonCode[];
  /**
   * The deployed policy, when `policy` carries live overrides. An emergency
   * the deployed policy would choose on the same votes is kept (zero-miss).
   * Re-scoring never passes it, so a what-if can show misses rising.
   */
  deployedPolicy?: Policy;
};

export type Decision = {
  status: 'routed' | 'needs_info' | 'human_review';
  disposition: Level | null;
  reasons: ReasonCode[];
  flagged: boolean;
};

function isEmergency(l: Level): boolean {
  return rank(l) >= rank('ed_now');
}

/**
 * Pipeline steps 6 to 7 from the votes on: the min_valid check, the choice,
 * the secondary cross-check and the review and info reasons. Live routing
 * and re-scoring both call this, so they cannot drift apart.
 */
export function decide(input: DecideInput, policy: Policy): Decision {
  const {primary, secondary, floor} = input;
  if (input.primaryValid < policy.sampling.min_valid) {
    return {
      status: 'human_review',
      disposition: isEmergency(floor) ? floor : null,
      reasons: ['sampling_failed'],
      flagged: true,
    };
  }

  let disposition = chooseLevel(primary, floor, policy);
  if (input.deployedPolicy) {
    // Overridden weights may not route below an emergency the deployed
    // policy would choose (AGENTS.md rule 1).
    const deployed = chooseLevel(primary, floor, input.deployedPolicy);
    if (isEmergency(deployed) && rank(disposition) < rank(deployed)) {
      disposition = deployed;
    }
  }
  // A configured secondary with too few valid samples cannot cross-check
  // the primary. The primary's disposition stands, but a physician looks:
  // a failed cross-check must not pass silently as an agreeing one.
  const secondaryFailed =
    secondary !== null &&
    (input.secondaryValid ?? 0) < policy.sampling.min_valid;
  const reasons: ReasonCode[] = [
    ...reviewReasons(primary, secondaryFailed ? null : secondary, policy),
    ...(secondaryFailed ? (['secondary_unavailable'] as const) : []),
    ...input.baseReasons,
  ];
  const needsInfo = input.questions > 0 || input.photo;
  if (input.questions > 0) reasons.push('missing_info');
  if (input.photo) reasons.push('photo_needed');
  return {
    status: needsInfo ? 'needs_info' : 'routed',
    disposition,
    reasons,
    flagged: reasons.some(r => REVIEW_REASONS.has(r)),
  };
}
