import type {Level} from './levels';
import type {OverrideReasonCode, RouteResult} from './schema';

/**
 * One JSON log line for a routing result, built from an explicit metadata
 * allowlist. Excerpts, justifications, safety-netting, patient copy,
 * questions and raw model output are all left out: any of them can repeat
 * patient text (an excerpt may be the whole of a short message). The raw
 * output stays in the HTTP response's trace for traceability.
 */
export function traceLine(result: RouteResult): string {
  const present = result.red_flags.filter(f => f.state === 'present');
  return JSON.stringify({
    kind: 'route',
    ts: new Date().toISOString(),
    input_sha256: result.trace.input_sha256,
    policy_version: result.trace.policy_version,
    models: result.trace.models.map(m => ({
      model: m.model,
      provider: m.provider,
    })),
    latency_ms: result.trace.latency_ms,
    status: result.status,
    disposition: result.disposition,
    tier: result.tier,
    floor: result.floor,
    red_flags_present: present.map(f => f.id),
    unverified: present.filter(f => !f.excerpt_verified).map(f => f.id),
    modifiers_present: result.modifiers.map(m => m.id),
    votes: result.votes,
    confidence: result.confidence,
    human_review: {
      flagged: result.human_review.flagged,
      reasons: result.human_review.reasons,
    },
    info_requests: {
      count: result.info_requests.questions.length,
      photo: result.info_requests.photo,
    },
    time_sensitive: result.time_sensitive,
  });
}

export type Override = {
  input_sha256: string;
  from: Level;
  to: Level;
  reason_code: OverrideReasonCode;
};

/** One JSON log line for a physician override. No headers, no IP. */
export function overrideLine(o: Override, policyVersion: string): string {
  return JSON.stringify({
    kind: 'override',
    ts: new Date().toISOString(),
    input_sha256: o.input_sha256,
    from: o.from,
    to: o.to,
    reason_code: o.reason_code,
    policy_version: policyVersion,
  });
}
