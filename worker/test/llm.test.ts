import {describe, expect, it, vi} from 'vitest';
import {openRouterClient, type LlmRequest} from '../src/llm';
import {okJson, okText} from './fixtures';

const req: LlmRequest = {
  spec: {model: 'anthropic/test', provider: 'anthropic'},
  system: 'sys',
  user: 'usr',
  schemaName: 'extraction',
  jsonSchema: {type: 'object'},
  temperature: 0,
  timeoutMs: 8000,
};

describe('openRouterClient', () => {
  it('pins the provider and disables fallbacks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({a: 1}));
    await openRouterClient('k', fetchMock).complete(req);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.provider).toEqual({
      order: ['anthropic'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
    });
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('posts the documented request and parses the content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({a: 1}));
    const res = await openRouterClient('k', fetchMock).complete(req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer k',
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('anthropic/test');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      {role: 'system', content: 'sys'},
      {role: 'user', content: 'usr'},
    ]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {name: 'extraction', strict: true, schema: {type: 'object'}},
    });
    expect(res.json).toEqual({a: 1});
    expect(res.raw).toBe('{"a":1}');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  const body200 = (b: unknown) =>
    Promise.resolve(new Response(JSON.stringify(b), {status: 200}));

  it.each([
    [() => Promise.reject(new DOMException('t', 'TimeoutError')), 'timeout'],
    [() => Promise.reject(new DOMException('a', 'AbortError')), 'timeout'],
    [() => Promise.reject(new TypeError('network')), 'provider_error'],
    [() => Promise.resolve(new Response('x', {status: 502})), 'provider_error'],
    [() => body200({error: {message: 'boom'}}), 'provider_error'],
    [() => body200({choices: []}), 'provider_error'],
    [() => body200({choices: [{message: {content: null}}]}), 'provider_error'],
    [
      () => Promise.resolve(new Response('<html>', {status: 200})),
      'provider_error',
    ],
    [() => Promise.resolve(okText('not json')), 'invalid_json'],
  ])(
    'maps failures to LlmError codes',
    async (impl, code) =>
      await expect(
        openRouterClient('k', vi.fn(impl)).complete(req),
      ).rejects.toMatchObject({code}),
  );
});
