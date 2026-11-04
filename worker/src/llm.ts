export type ModelSpec = {model: string; provider: string};

export type LlmRequest = {
  spec: ModelSpec;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  temperature: number;
  timeoutMs: number;
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
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function isTimeout(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'TimeoutError' || e.name === 'AbortError')
  );
}

/**
 * OpenRouter chat-completions client. The provider is pinned with fallbacks
 * off and zero-data-retention only. Messages are never logged.
 */
export function openRouterClient(
  apiKey: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): LlmClient {
  return {
    async complete(req) {
      const body = JSON.stringify({
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
        throw new LlmError('provider_error', `LLM provider returned ${status}`);
      }
      const p = payload as
        | {error?: unknown; choices?: {message?: {content?: unknown}}[]}
        | null
        | undefined;
      const content = p?.choices?.[0]?.message?.content;
      if (p?.error !== undefined || typeof content !== 'string') {
        throw new LlmError(
          'provider_error',
          'LLM provider returned no content',
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw new LlmError('invalid_json', 'LLM content was not valid JSON');
      }
      return {json, raw: content, latencyMs};
    },
  };
}
