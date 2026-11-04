import {describe, expect, it} from 'vitest';
import schemaJson from '../../schema/route-result.schema.json';
import worker, {appFor, workerFor, type Env} from '../src/index';
import {loadPolicy} from '../src/policy';
import {OverrideReasonCodeSchema} from '../src/schema';
import {
  M,
  REFILL_WITH_CHEST,
  deferred,
  deps,
  scripted,
  type ScriptOpts,
} from './pipeline-fixtures';

const TOKEN = 'test-token-0123456789';
const ORIGIN = 'https://demo.example.org';
const ENV: Env = {
  OPENROUTER_API_KEY: 'unused',
  ACCESS_TOKEN: TOKEN,
  PRIMARY_MODEL: 'test/primary',
  PRIMARY_PROVIDER: 'test-a',
  SECONDARY_MODEL: '',
  SECONDARY_PROVIDER: '',
  ALLOWED_ORIGIN: ORIGIN,
};
const AUTH = {Authorization: `Bearer ${TOKEN}`};
const JSON_AUTH = {...AUTH, 'Content-Type': 'application/json'};

function app(opts: ScriptOpts = {}, log: (line: string) => void = () => {}) {
  return appFor({...deps(scripted(opts)), log});
}

function post(body: unknown, headers: Record<string, string> = JSON_AUTH) {
  return {method: 'POST', headers, body: JSON.stringify(body)};
}

function lines(text: string): {event: string; [k: string]: unknown}[] {
  return text
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l));
}

describe('POST /v1/route', () => {
  it('rejects empty messages with 400', async () => {
    const llm = scripted({});
    const res = await appFor(deps(llm)).request(
      '/v1/route',
      post({message: ''}),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: 'message must be non-empty text'});
    expect(llm.calls).toBe(0);

    for (const body of [{message: 42}, {}, {message: '   '}]) {
      const r = await app().request('/v1/route', post(body), ENV);
      expect(r.status).toBe(400);
    }
    const bad = await app().request(
      '/v1/route',
      {method: 'POST', headers: JSON_AUTH, body: '{not json'},
      ENV,
    );
    expect(bad.status).toBe(400);
  });

  it('requires a bearer token', async () => {
    const llm = scripted({});
    const res = await appFor(deps(llm)).request(
      '/v1/route',
      post({message: M}, {'Content-Type': 'application/json'}),
      ENV,
    );
    expect(res.status).toBe(401);
    expect(llm.calls).toBe(0);

    for (const headers of [
      {Authorization: 'Bearer wrong-token-0123456789'},
      {Authorization: `Bearer ${TOKEN}x`},
      {Authorization: TOKEN},
    ]) {
      const r = await app().request(
        '/v1/route',
        post({message: M}, headers),
        ENV,
      );
      expect(r.status).toBe(401);
    }
    const noSecret = await app().request(
      '/v1/route',
      post({message: M}, {Authorization: 'Bearer '}),
      {...ENV, ACCESS_TOKEN: ''},
    );
    expect(noSecret.status).toBe(401);
  });

  it('streams early then result as NDJSON', async () => {
    const gate = deferred();
    const res = await app({
      flags: {cardiac_chest_pain: 'present'},
      samplesAwait: gate.promise,
    }).request('/v1/route', post({message: REFILL_WITH_CHEST}), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    // The early line arrives while every sample is still pending.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n')) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
    const [early] = lines(text);
    expect(early).toEqual({
      event: 'early',
      floor: 'call_911',
      patient_message: loadPolicy().levels.call_911.patient_message,
    });

    gate.resolve();
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
    const events = lines(text);
    expect(events.map(e => e.event)).toEqual(['early', 'result']);
    const result = events[1].result as {disposition: string};
    expect(result.disposition).toBe('call_911');
  });

  it('sends only the result line below Emergency', async () => {
    const res = await app().request(
      '/v1/route',
      post({message: M, mode: 'floor_only'}),
      ENV,
    );
    const events = lines(await res.text());
    expect(events.map(e => e.event)).toEqual(['result']);
  });

  it('rejects an unknown mode', async () => {
    const res = await app().request(
      '/v1/route',
      post({message: M, mode: 'fast'}),
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when the model is not configured', async () => {
    const res = await worker.fetch(
      new Request('http://w/v1/route', post({message: M})),
      {...ENV, PRIMARY_MODEL: ''},
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error: 'model not configured'});
  });
});

describe('worker entry', () => {
  it('returns 503 when building deps throws', async () => {
    const logged: string[] = [];
    const w = workerFor(
      () => {
        throw new Error('policy failed to parse: secret detail');
      },
      l => logged.push(l),
    );
    const res = await w.fetch(
      new Request('http://w/v1/route', post({message: M})),
      ENV,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error: 'service misconfigured'});
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toEqual({
      kind: 'error',
      ts: expect.any(String),
      where: 'deps',
    });
    expect(logged[0]).not.toContain('secret detail');
  });
});

describe('POST /v1/override', () => {
  const body = {
    input_sha256: 'a'.repeat(64),
    from: 'routine',
    to: 'in_person_today',
    reason_code: 'under_triage',
  };

  it('logs overrides without client IP', async () => {
    const logged: string[] = [];
    const res = await app({}, l => logged.push(l)).request(
      '/v1/override',
      post(body, {
        ...JSON_AUTH,
        'cf-connecting-ip': '203.0.113.77',
        'x-forwarded-for': '203.0.113.77',
      }),
      ENV,
    );
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain('203.0.113.77');
    expect(logged[0]).not.toContain(TOKEN);
    const line = JSON.parse(logged[0]);
    expect(line).toEqual({
      kind: 'override',
      ts: expect.any(String),
      input_sha256: body.input_sha256,
      from: 'routine',
      to: 'in_person_today',
      reason_code: 'under_triage',
      policy_version: loadPolicy().policy_version,
    });
  });

  it('accepts every reason code', async () => {
    for (const reason_code of OverrideReasonCodeSchema.options) {
      const res = await app().request(
        '/v1/override',
        post({...body, reason_code}),
        ENV,
      );
      expect(res.status).toBe(204);
    }
  });

  it('rejects free text, unknown codes and bad hashes', async () => {
    for (const bad of [
      {...body, reason: 'Exam needed for the rash.'},
      {...body, note: 'Patient said more on the phone.'},
      {...body, reason_code: 'rash_needs_exam'},
      {...body, reason_code: undefined},
      {...body, to: 'urgent'},
      {...body, input_sha256: 'xyz'},
      {...body, input_sha256: 'A'.repeat(64)},
    ]) {
      const logged: string[] = [];
      const res = await app({}, l => logged.push(l)).request(
        '/v1/override',
        post(bad),
        ENV,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({error: 'invalid override'});
      expect(logged).toEqual([]);
    }
  });

  it('requires a bearer token', async () => {
    const res = await app().request(
      '/v1/override',
      post(body, {'Content-Type': 'application/json'}),
      ENV,
    );
    expect(res.status).toBe(401);
  });
});

describe('GET endpoints', () => {
  it('serves the policy summary with a token', async () => {
    const policy = loadPolicy();
    const res = await app().request('/v1/policy', {headers: AUTH}, ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      policy_version: policy.policy_version,
      levels: policy.levels,
      red_flags: policy.red_flags.map(f => ({
        id: f.id,
        description: f.description,
        min_level: f.min_level,
      })),
    });
    expect((await app().request('/v1/policy', {}, ENV)).status).toBe(401);
  });

  it('serves the schema without a token', async () => {
    const res = await app().request('/v1/schema', {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(schemaJson);
  });

  it('allows the configured origin only', async () => {
    const ok = await app().request(
      '/v1/schema',
      {headers: {Origin: ORIGIN}},
      ENV,
    );
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await app().request(
      '/v1/schema',
      {headers: {Origin: 'https://evil.example.com'}},
      ENV,
    );
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await app().request(
      '/v1/route',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      ENV,
    );
    expect(preflight.status).toBe(204);
  });
});
