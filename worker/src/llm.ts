export type ModelSpec = {model: string; provider: string};

export type LlmRequest = {
  spec: ModelSpec;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  temperature: number;
  timeoutMs: number;
  /** Retries after HTTP 429. Defaults to MAX_RETRIES. */
  maxRetries?: number;
};

export type LlmResponse = {json: unknown; raw: string; latencyMs: number};

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorCode = 'timeout' | 'provider_error' | 'invalid_json';

/** The only way the client fails; it never invents a result. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    /** The HTTP status, when the provider answered with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Default requests in flight per model, per case. The provider rate-limits
 * each model separately, so each model gets its own queue. The client queues
 * requests itself so that each timeout measures the provider's time, not the
 * wait for a connection.
 */
export const MAX_IN_FLIGHT = 3;

/** A Cloudflare Worker request may hold six connections open at once. */
export const WORKER_CONNECTIONS = 6;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Per-model call settings, keyed by model id in openRouterClient. */
export type ModelTuning = {
  /** This model's queue size; defaults to the client's maxInFlight. */
  maxInFlight?: number;
  /** Sent as OpenRouter's reasoning.effort; omitted when unset. */
  reasoningEffort?: ReasoningEffort;
};

/**
 * Reads a model's tuning from its env vars. A limit must be a whole number
 * from 1 to WORKER_CONNECTIONS and an effort one of REASONING_EFFORTS;
 * anything else is ignored, leaving the default.
 */
export function tuningFromEnv(
  maxInFlight: string | undefined,
  effort: string | undefined,
): ModelTuning {
  const tuning: ModelTuning = {};
  const n = Number(maxInFlight);
  if (maxInFlight && Number.isInteger(n) && n >= 1 && n <= WORKER_CONNECTIONS) {
    tuning.maxInFlight = n;
  }
  const e = REASONING_EFFORTS.find(x => x === effort);
  if (e) tuning.reasoningEffort = e;
  return tuning;
}

/**
 * Retries for a rate-limited (HTTP 429) request; nothing else is retried.
 * Backoff doubles from 1 s, so four retries wait about 15 s in all. A case
 * stays far inside the Workers Paid subrequest limit.
 */
export const MAX_RETRIES = 4;

/**
 * Retries for the primary's extraction, which sets the red-flag floor and
 * the early Emergency event: six retries wait about 63 s in all, long enough
 * for a per-minute rate limit to refill.
 */
export const EXTRACTION_MAX_RETRIES = 6;

/** Runs at most `max` tasks at a time, in the order they arrive. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next task, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function isTimeout(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'TimeoutError' || e.name === 'AbortError')
  );
}

/**
 * OpenRouter chat-completions client. The provider is pinned with fallbacks
 * off and zero-data-retention only. Messages are never logged. Each model
 * has its own queue, and all models together hold at most
 * WORKER_CONNECTIONS connections.
 */
export function openRouterClient(
  apiKey: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  maxInFlight = MAX_IN_FLIGHT,
  sleep: (ms: number) => Promise<void> = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
  tuning: Record<string, ModelTuning> = {},
): LlmClient {
  const connections = limiter(WORKER_CONNECTIONS);
  const gates = new Map<string, ReturnType<typeof limiter>>();
  const gateFor = (model: string) => {
    let gate = gates.get(model);
    if (!gate) {
      gate = limiter(tuning[model]?.maxInFlight ?? maxInFlight);
      gates.set(model, gate);
    }
    return gate;
  };
  return {
    async complete(req) {
      const gate = gateFor(req.spec.model);
      const effort = tuning[req.spec.model]?.reasoningEffort;
      // A rate-limited request rejoins the back of the queue after a backoff,
      // so it does not hold a connection while it waits.
      for (let attempt = 0; ; attempt++) {
        try {
          return await gate(() =>
            connections(() => send(apiKey, fetchImpl, req, effort)),
          );
        } catch (e) {
          const limited = e instanceof LlmError && e.status === 429;
          if (!limited || attempt >= (req.maxRetries ?? MAX_RETRIES)) throw e;
          await sleep(1000 * 2 ** attempt + Math.random() * 500);
        }
      }
    },
  };
}

async function send(
  apiKey: string,
  fetchImpl: typeof fetch,
  req: LlmRequest,
  effort: ReasoningEffort | undefined,
): Promise<LlmResponse> {
  const body = JSON.stringify({
    ...(effort ? {reasoning: {effort}} : {}),
    model: req.spec.model,
    messages: [
      {role: 'system', content: req.system},
      {role: 'user', content: req.user},
    ],
    temperature: req.temperature,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: req.schemaName,
        strict: true,
        schema: req.jsonSchema,
      },
    },
    provider: {
      order: [req.spec.provider],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
    },
  });
  const start = Date.now();
  let payload: unknown;
  let ok: boolean;
  let status: number;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    ok = res.ok;
    status = res.status;
    const text = await res.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  } catch (e) {
    if (isTimeout(e)) {
      throw new LlmError('timeout', 'LLM request timed out');
    }
    throw new LlmError('provider_error', 'LLM request failed');
  }
  const latencyMs = Date.now() - start;
  if (!ok) {
    throw new LlmError(
      'provider_error',
      `LLM provider returned ${status}`,
      status,
    );
  }
  const p = payload as
    | {error?: unknown; choices?: {message?: {content?: unknown}}[]}
    | null
    | undefined;
  const content = p?.choices?.[0]?.message?.content;
  if (p?.error !== undefined || typeof content !== 'string') {
    throw new LlmError('provider_error', 'LLM provider returned no content');
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new LlmError('invalid_json', 'LLM content was not valid JSON');
  }
  return {json, raw: content, latencyMs};
}
