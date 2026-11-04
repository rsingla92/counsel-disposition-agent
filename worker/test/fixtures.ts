import {LEVELS, type Level} from '../src/levels';
import type {LlmClient, LlmRequest} from '../src/llm';
import type {Policy} from '../src/policy';
import type {Extraction, RouteResult} from '../src/schema';

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
