import {LEVELS, type Level} from '../src/levels';
import {LlmError, type LlmClient, type LlmRequest} from '../src/llm';
import {loadPolicy, type Policy} from '../src/policy';
import {policyForSamples} from '../src/rescore';
import {emptyVotes, type Votes} from '../src/router';
import type {Extraction, RouteResult, Sample} from '../src/schema';

/**
 * The checked-in policy at 20 votes per model (thresholds scaled up, 16 and
 * 12), for tests of routing mechanics written with 20-vote splits.
 */
export const policy20: Policy = policyForSamples(loadPolicy(), 20);

/** Votes with the given counts; levels not named get 0. */
export function v(partial: Partial<Votes>): Votes {
  return {...emptyVotes(), ...partial};
}

/** An extraction in which nothing is flagged. */
export function fakeExtraction(policy: Policy): Extraction {
  return {
    language: 'en',
    is_care_request: true,
    red_flags: Object.fromEntries(
      policy.red_flags.map(f => [f.id, {state: 'absent', excerpt: null}]),
    ),
    modifiers: Object.fromEntries(
      policy.modifiers.map(m => [m.id, {present: false, excerpt: null}]),
    ),
    questions: [],
    photo_needed: false,
    time_sensitive: false,
  } as Extraction;
}

/** An extraction as the model returns it: red flags as a list. */
export type WireExtraction = Omit<Extraction, 'red_flags'> & {
  red_flags: {id: string; state: string; excerpt: string}[];
};

/**
 * Converts `ex` to the form the extraction model returns: red flags as a
 * list, and an empty string for no excerpt.
 */
export function toWire(ex: Extraction): WireExtraction {
  return {
    ...ex,
    red_flags: Object.entries(ex.red_flags).map(([id, f]) => ({
      id,
      state: f.state,
      excerpt: f.excerpt ?? '',
    })),
    modifiers: Object.fromEntries(
      Object.entries(ex.modifiers).map(([id, m]) => [
        id,
        {present: m.present, excerpt: m.excerpt ?? ''},
      ]),
    ) as unknown as Extraction['modifiers'],
  };
}

function counts(top: Level, n: number): Record<Level, number> {
  return Object.fromEntries(LEVELS.map(l => [l, l === top ? n : 0])) as Record<
    Level,
    number
  >;
}

/**
 * Returns a copy of `ex` with the named flags set and the named modifiers
 * present. A present flag or modifier cites the whole message, so it verifies.
 * Throws on an id the extraction does not have.
 */
export function withFlags(
  ex: Extraction,
  flags: Record<string, 'present' | 'unknown'>,
  mods: string[],
  message: string,
): Extraction {
  const out = structuredClone(ex);
  for (const [id, state] of Object.entries(flags)) {
    if (!(id in out.red_flags)) throw new Error(`unknown flag id: ${id}`);
    out.red_flags[id] = {
      state,
      excerpt: state === 'present' ? message : null,
    };
  }
  for (const id of mods) {
    if (!(id in out.modifiers)) throw new Error(`unknown modifier id: ${id}`);
    out.modifiers[id] = {present: true, excerpt: message};
  }
  return out;
}

/** Returns a copy of `ex` with one flag's excerpt replaced. */
export function withExcerpt(
  ex: Extraction,
  flagId: string,
  excerpt: string | null,
): Extraction {
  if (!(flagId in ex.red_flags)) throw new Error(`unknown flag id: ${flagId}`);
  const out = structuredClone(ex);
  out.red_flags[flagId] = {...out.red_flags[flagId], excerpt};
  return out;
}

/** A RouteResult that passes the schema. */
export const validResult: RouteResult = {
  status: 'routed',
  disposition: 'routine',
  tier: 'async',
  brief_label: 'ASYNC_PHYSICIAN',
  floor: null,
  red_flags: [],
  modifiers: [],
  votes: {primary: counts('routine', 5), secondary: null},
  confidence: 1,
  human_review: {flagged: false, reasons: []},
  info_requests: {questions: [], photo: false},
  time_sensitive: false,
  justification: 'This looks routine. A physician will review it.',
  safety_net: 'Call your clinic if it gets worse.',
  patient_message: 'A physician will reply within a week.',
  trace: {
    input_sha256: 'a'.repeat(64),
    policy_version: loadPolicy().policy_version,
    models: [{model: 'test-model', provider: 'test'}],
    extraction_model: {model: 'test-model', provider: 'test'},
    latency_ms: 10,
    raw: null,
  },
};

/** A 2xx Response in OpenRouter's chat-completions shape, content a string. */
export function okText(text: string): Response {
  return new Response(
    JSON.stringify({choices: [{message: {role: 'assistant', content: text}}]}),
    {status: 200, headers: {'Content-Type': 'application/json'}},
  );
}

/** A 2xx Response whose message content is the JSON encoding of obj. */
export function okJson(obj: unknown): Response {
  return okText(JSON.stringify(obj));
}

/** A valid Sample JSON proposing the given level. */
export function sample(level: Level): Sample {
  return {
    disposition: level,
    justification: `Test justification for ${level}.`,
    safety_net: 'Seek care sooner if it gets worse.',
  };
}

/**
 * An LlmClient whose first `fail` calls reject with a timeout, next `invalid`
 * calls return schema-invalid JSON, and the rest return `ok`.
 */
export function flakyLlm(opts: {
  fail: number;
  invalid: number;
  ok: unknown;
}): LlmClient {
  let n = 0;
  return {
    async complete() {
      const i = n++;
      if (i < opts.fail) throw new LlmError('timeout', 'timed out');
      const json = i < opts.fail + opts.invalid ? {bogus: true} : opts.ok;
      return {json, raw: JSON.stringify(json), latencyMs: 1};
    },
  };
}

/**
 * An LlmClient that returns json, records the last request, counts calls and
 * tracks the most calls in flight at once (each call yields a macrotask).
 */
export function stubLlm(json: unknown): LlmClient & {
  lastRequest: LlmRequest;
  calls: number;
  maxConcurrent: number;
} {
  let inFlight = 0;
  const stub = {
    calls: 0,
    maxConcurrent: 0,
    lastRequest: undefined as unknown as LlmRequest,
    async complete(req: LlmRequest) {
      stub.calls++;
      stub.lastRequest = req;
      inFlight++;
      stub.maxConcurrent = Math.max(stub.maxConcurrent, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
      return {json, raw: JSON.stringify(json), latencyMs: 1};
    },
  };
  return stub;
}
