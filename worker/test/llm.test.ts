import {describe, expect, it, vi} from 'vitest';
import {
  MAX_IN_FLIGHT,
  MAX_RETRIES,
  openRouterClient,
  type LlmRequest,
} from '../src/llm';
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

describe('openRouterClient concurrency', () => {
  // A fetch that resolves after `ms` and records how many calls overlap.
  function slowFetch(ms: number) {
    const state = {active: 0, peak: 0};
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(init.signal!.reason);
          });
        });
        return okJson({a: 1});
      } finally {
        state.active--;
      }
    });
    return {impl, state};
  }

  it('keeps at most six requests in flight by default', async () => {
    const {impl, state} = slowFetch(5);
    const client = openRouterClient('k', impl);
    await Promise.all(Array.from({length: 20}, () => client.complete(req)));
    expect(impl).toHaveBeenCalledTimes(20);
    expect(state.peak).toBe(MAX_IN_FLIGHT);
    expect(MAX_IN_FLIGHT).toBe(6);
  });

  it('starts the timeout when a request leaves the queue', async () => {
    const {impl, state} = slowFetch(30);
    const client = openRouterClient('k', impl, 1);
    const quick = {...req, timeoutMs: 100};
    // Four calls in series take ~120 ms, longer than each call's timeout.
    const results = await Promise.allSettled(
      Array.from({length: 4}, () => client.complete(quick)),
    );
    expect(results.map(r => r.status)).toEqual(Array(4).fill('fulfilled'));
    expect(state.peak).toBe(1);
  });

  it('frees the slot when a request fails', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValue(okJson({a: 1}));
    const client = openRouterClient('k', impl, 1);
    const [first, second] = await Promise.allSettled([
      client.complete(req),
      client.complete(req),
    ]);
    expect(first).toMatchObject({
      status: 'rejected',
      reason: {code: 'provider_error'},
    });
    expect(second.status).toBe('fulfilled');
  });
});

describe('openRouterClient retries', () => {
  const tooMany = () => Promise.resolve(new Response('{}', {status: 429}));
  const noSleep = vi.fn(async () => {});

  it('retries a 429 up to twice, then succeeds', async () => {
    const impl = vi
      .fn()
      .mockImplementationOnce(tooMany)
      .mockImplementationOnce(tooMany)
      .mockResolvedValue(okJson({a: 1}));
    const sleep = vi.fn(async () => {});
    const res = await openRouterClient('k', impl, 6, sleep).complete(req);
    expect(res.json).toEqual({a: 1});
    expect(impl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_RETRIES retries', async () => {
    const impl = vi.fn(tooMany);
    await expect(
      openRouterClient('k', impl, 6, noSleep).complete(req),
    ).rejects.toMatchObject({code: 'provider_error', status: 429});
    expect(impl).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it.each([500, 400, 401])('does not retry a %i', async status => {
    const impl = vi.fn(() => Promise.resolve(new Response('{}', {status})));
    await expect(
      openRouterClient('k', impl, 6, noSleep).complete(req),
    ).rejects.toMatchObject({code: 'provider_error', status});
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timeout', async () => {
    const impl = vi.fn(() =>
      Promise.reject(new DOMException('t', 'TimeoutError')),
    );
    await expect(
      openRouterClient('k', impl, 6, noSleep).complete(req),
    ).rejects.toMatchObject({code: 'timeout'});
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('waits longer before the second retry', async () => {
    const impl = vi.fn(tooMany);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await openRouterClient('k', impl, 6, sleep)
      .complete(req)
      .catch(() => {});
    const [first, second] = sleep.mock.calls.map(c => c[0]);
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(second).toBeGreaterThanOrEqual(2000);
  });
});

describe('openRouterClient retry limits', () => {
  const tooMany = () => Promise.resolve(new Response('{}', {status: 429}));

  it('honours a request-level retry cap', async () => {
    const impl = vi.fn(tooMany);
    await expect(
      openRouterClient('k', impl, 6, async () => {}).complete({
        ...req,
        maxRetries: 1,
      }),
    ).rejects.toMatchObject({status: 429});
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('gives up its slot while it backs off', async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => (release = resolve));
    const impl = vi
      .fn()
      .mockImplementationOnce(tooMany)
      .mockImplementation(() => Promise.resolve(okJson({a: 1})));
    const client = openRouterClient('k', impl, 1, () => held);
    const order: string[] = [];
    const first = client.complete(req).then(() => order.push('first'));
    // Let the first request fail and start its backoff.
    await new Promise(resolve => setTimeout(resolve, 5));
    await client.complete(req).then(() => order.push('second'));
    release();
    await first;
    expect(order).toEqual(['second', 'first']);
  });
});
