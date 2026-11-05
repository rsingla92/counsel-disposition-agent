import {decide} from './decide';
import {LEVELS, type Level} from './levels';
import {summarize, type ScoredCase, type Summary} from './metrics';
import type {Policy} from './policy';
import type {Votes} from './router';
import type {ReasonCode} from './schema';

/**
 * One saved case, as export_experiment.py writes it: the votes and the
 * pipeline inputs to decide(), never message text or excerpts.
 */
export type ExperimentRecord = {
  case_id: string;
  reference: Level;
  /** A Human review outcome reached before the votes; kept as saved. */
  fixed: null | {
    status: 'human_review';
    disposition: Level | null;
    reasons: ReasonCode[];
  };
  floor: Level;
  primary: Votes;
  secondary: Votes | null;
  questions: number;
  photo: boolean;
  base_reasons: ReasonCode[];
  latency_ms: number;
};

export type Experiment = {
  id: string;
  label: string;
  models: string;
  rescorable: boolean;
  records: ExperimentRecord[];
  summary: Summary;
  median_latency_ms: number;
};

function total(votes: Votes): number {
  return LEVELS.reduce((sum, l) => sum + votes[l], 0);
}

/**
 * True when the record's saved outcome stands under `policy`. A case that
 * failed only for too few valid samples is re-decided once the effective
 * min_valid is within its vote total.
 */
function keepsFixed(r: ExperimentRecord, policy: Policy): boolean {
  if (r.fixed === null) return false;
  const onlySampling =
    r.fixed.reasons.length === 1 && r.fixed.reasons[0] === 'sampling_failed';
  return !(onlySampling && total(r.primary) >= policy.sampling.min_valid);
}

function scoreRecord(r: ExperimentRecord, policy: Policy): ScoredCase {
  if (r.fixed !== null && keepsFixed(r, policy)) {
    return {
      reference: r.reference,
      disposition: r.fixed.disposition,
      status: 'human_review',
      flagged: true,
    };
  }
  // Each vote is one valid sample, so a family's total is its valid count.
  // No deployedPolicy: a what-if may show an emergency routed lower.
  const d = decide(
    {
      primary: r.primary,
      primaryValid: total(r.primary),
      secondary: r.secondary,
      secondaryValid: r.secondary ? total(r.secondary) : null,
      floor: r.floor,
      questions: r.questions,
      photo: r.photo,
      baseReasons: r.base_reasons,
    },
    policy,
  );
  return {
    reference: r.reference,
    disposition: d.disposition,
    status: d.status,
    flagged: d.flagged,
  };
}

/** Recomputes an experiment's summary under `policy` from the saved votes. */
export function rescore(exp: Experiment, policy: Policy): Summary {
  return summarize(
    exp.records.map(r => scoreRecord(r, policy)),
    policy,
  );
}
