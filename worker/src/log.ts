import type {Level} from './levels';
import type {OverrideReasonCode, RouteResult} from './schema';

/**
 * One JSON log line for a routing result. RouteResult never holds the message
 * text (excerpts only), so neither does this line.
 */
export function traceLine(result: RouteResult): string {
  return JSON.stringify({
    kind: 'route',
    ts: new Date().toISOString(),
    ...result,
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
