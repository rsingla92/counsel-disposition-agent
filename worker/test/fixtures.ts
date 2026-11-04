import {LEVELS, type Level} from '../src/levels';
import type {LlmClient, LlmRequest} from '../src/llm';
import type {Policy} from '../src/policy';
import {emptyVotes, type Votes} from '../src/router';
import type {Extraction, RouteResult} from '../src/schema';

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
    policy_version: '0.1.0',
    models: [{model: 'test-model', provider: 'test'}],
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

/** An LlmClient that returns json, records the last request, counts calls. */
export function stubLlm(json: unknown): LlmClient & {
  lastRequest: LlmRequest;
  calls: number;
} {
  const stub = {
    calls: 0,
    lastRequest: undefined as unknown as LlmRequest,
    async complete(req: LlmRequest) {
      stub.calls++;
      stub.lastRequest = req;
      return {json, raw: JSON.stringify(json), latencyMs: 1};
    },
  };
  return stub;
}
