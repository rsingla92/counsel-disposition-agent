import {describe, expect, it} from 'vitest';
import schemaJson from '../../schema/route-result.schema.json';
import worker, {appFor, workerFor, type Env} from '../src/index';
import {summarize} from '../src/metrics';
import {loadPolicy} from '../src/policy';
import type {Experiment} from '../src/rescore';
import type {LlmClient, LlmRequest} from '../src/llm';
import {route} from '../src/pipeline';
import {OverrideReasonCodeSchema, type RouteResult} from '../src/schema';
import {
  M,
  PRIMARY,
  REFILL_WITH_CHEST,
  SECONDARY,
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

/** Wraps an LlmClient to record each call's step and model. */
function recording(llm: LlmClient) {
  const calls: {step: string; model: string}[] = [];
  const client: LlmClient = {
    complete(req: LlmRequest) {
      calls.push({step: req.schemaName, model: req.spec.model});
      return llm.complete(req);
    },
  };
  return {client, calls};
}

/** The result line of a /v1/route response. */
async function resultOf(res: Response): Promise<RouteResult> {
  const events = lines(await res.text());
  return events[events.length - 1].result as RouteResult;
}

describe('POST /v1/route with overrides', () => {
  const UNDER = loadPolicy().loss.boundaries.map(b => b.under);

  function twoModelApp(opts: ScriptOpts = {}) {
    const {client, calls} = recording(scripted(opts));
    const app = appFor({...deps(client), secondary: SECONDARY});
    return {app, calls};
  }

  it('runs Sonnet only for models sonnet', async () => {
    const {app, calls} = twoModelApp();
    const res = await app.request(
      '/v1/route',
      post({message: M, overrides: {models: 'sonnet'}}),
      ENV,
    );
    expect(res.status).toBe(200);
    const result = await resultOf(res);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(c => c.model === SECONDARY.model)).toEqual([]);
    expect(result.trace.overrides).toEqual({models: 'sonnet'});
    expect(result.trace.models).toEqual([PRIMARY]);
    expect(result.votes.secondary).toBeNull();
  });

  it('sends extraction and samples to Flash only for models flash', async () => {
    const {app, calls} = twoModelApp();
    const res = await app.request(
      '/v1/route',
      post({message: M, overrides: {models: 'flash'}}),
      ENV,
    );
    expect(res.status).toBe(200);
    const result = await resultOf(res);
    expect(calls.filter(c => c.model === PRIMARY.model)).toEqual([]);
    expect(calls.filter(c => c.step === 'extraction')).toEqual([
      {step: 'extraction', model: SECONDARY.model},
    ]);
    expect(calls.filter(c => c.step !== 'extraction').length).toBe(
      loadPolicy().sampling.n,
    );
    expect(result.trace.models).toEqual([SECONDARY]);
    expect(result.trace.extraction_model).toEqual(SECONDARY);
    expect(result.votes.secondary).toBeNull();
  });

  it('runs both families for models sonnet+flash', async () => {
    const {app, calls} = twoModelApp();
    const res = await app.request(
      '/v1/route',
      post({message: M, overrides: {models: 'sonnet+flash'}}),
      ENV,
    );
    const result = await resultOf(res);
    expect(calls.some(c => c.model === SECONDARY.model)).toBe(true);
    expect(result.trace.models).toEqual([PRIMARY, SECONDARY]);
  });

  it('answers 503 for flash with no secondary configured', async () => {
    const llm = scripted({});
    const res = await appFor(deps(llm)).request(
      '/v1/route',
      post({message: M, overrides: {models: 'flash'}}),
      ENV,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error: 'model not configured'});
    expect(llm.calls).toBe(0);
  });

  it('answers 503 for sonnet+flash with no secondary configured', async () => {
    const llm = scripted({});
    const res = await appFor(deps(llm)).request(
      '/v1/route',
      post({message: M, overrides: {models: 'sonnet+flash'}}),
      ENV,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error: 'model not configured'});
    expect(llm.calls).toBe(0);
  });

  it('keeps an emergency the deployed policy would choose', async () => {
    // 3 ed_now / 17 self_care: the deployed weights choose ed_now; the
    // overridden lower weights alone would choose self_care.
    const res = await app({
      sampleFor: i => ({
        disposition: i < 3 ? 'ed_now' : 'self_care',
        justification: 'Test justification.',
        safety_net: 'Seek care sooner if it gets worse.',
      }),
    }).request(
      '/v1/route',
      post({
        message: M,
        overrides: {
          policy: {under_weights: [3, 20, 0.5, 0.5, 0.5, 0.5], max_span: 6},
        },
      }),
      ENV,
    );
    const result = await resultOf(res);
    expect(result.disposition).toBe('ed_now');
  });

  it('rejects human_review_cost on a live route', async () => {
    const {app, calls} = twoModelApp();
    const res = await app.request(
      '/v1/route',
      post({message: M, overrides: {policy: {human_review_cost: 0.5}}}),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: 'overrides invalid'});
    expect(calls).toEqual([]);
  });

  it('rejects an emergency weight below the policy without calling the LLM', async () => {
    const {app, calls} = twoModelApp();
    const res = await app.request(
      '/v1/route',
      post({
        message: M,
        overrides: {
          policy: {under_weights: UNDER.map((u, i) => (i === 1 ? 1 : u))},
        },
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: 'emergency_weight_below_policy'});
    expect(calls).toEqual([]);
  });

  it('rejects out-of-range and unknown overrides without calling the LLM', async () => {
    for (const overrides of [
      {policy: {min_valid: 30}},
      {policy: {min_valid: 15, min_top_votes: 7}},
      {policy: {min_top_votes: 7}},
      {policy: {under_weights: [1, 2, 3]}},
      {models: 'gpt'},
      {temperature: 0},
      'sonnet',
      null,
    ]) {
      const {app, calls} = twoModelApp();
      const res = await app.request(
        '/v1/route',
        post({message: M, overrides}),
        ENV,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({error: 'overrides invalid'});
      expect(calls).toEqual([]);
    }
  });

  it('applies policy overrides to the route', async () => {
    const res = await app({
      sampleFor: i => ({
        disposition: i === 0 ? 'within_few_days' : 'routine',
        justification: 'Test justification.',
        safety_net: 'Seek care sooner if it gets worse.',
      }),
    }).request(
      '/v1/route',
      post({message: M, overrides: {policy: {min_top_votes: 20}}}),
      ENV,
    );
    const result = await resultOf(res);
    expect(result.human_review.reasons).toContain('split_vote');
    expect(result.trace.overrides).toEqual({policy: {min_top_votes: 20}});
    expect(result.trace.policy_version).toBe(loadPolicy().policy_version);
  });

  it("keeps today's result with no overrides", async () => {
    const opts: ScriptOpts = {flags: {cardiac_chest_pain: 'present'}};
    const res = await app(opts).request(
      '/v1/route',
      post({message: REFILL_WITH_CHEST}),
      ENV,
    );
    const result = await resultOf(res);
    const direct = await route(REFILL_WITH_CHEST, deps(scripted(opts)));
    expect(result.trace.overrides).toBeNull();
    expect({
      ...result,
      trace: {...result.trace, latency_ms: 0},
    }).toEqual({...direct, trace: {...direct.trace, latency_ms: 0}});
  });

  it('keeps serving the loaded policy', async () => {
    const res = await app().request('/v1/policy', {headers: AUTH}, ENV);
    const body = (await res.json()) as {policy_version: string};
    expect(body.policy_version).toBe(loadPolicy().policy_version);
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

  it('logs an override of a case with no disposition as from null', async () => {
    const logged: string[] = [];
    const res = await app({}, l => logged.push(l)).request(
      '/v1/override',
      post({...body, from: null, to: 'ed_now'}),
      ENV,
    );
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"from":null');
    expect(JSON.parse(logged[0])).toMatchObject({from: null, to: 'ed_now'});
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
      {...body, from: 'none'},
      {...body, from: undefined},
      {...body, from: null, to: null},
      {...body, to: 'routine'},
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
      sampling: {n: policy.sampling.n, min_valid: policy.sampling.min_valid},
      review: {
        min_top_votes: policy.review.min_top_votes,
        max_span: policy.review.max_span,
      },
      loss: {
        human_review_cost: policy.loss.human_review_cost,
        boundaries: policy.loss.boundaries.map(b => ({
          between: b.between,
          under: b.under,
          over: b.over,
        })),
      },
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

/** A Map-backed stand-in for the EXPERIMENTS KV namespace. */
function fakeKv(
  entries: Record<string, unknown> = {},
  raw: Record<string, string> = {},
) {
  const map = new Map<string, string>([
    ...Object.entries(entries).map(([k, val]): [string, string] => [
      k,
      JSON.stringify(val),
    ]),
    ...Object.entries(raw),
  ]);
  return {get: async (key: string) => map.get(key) ?? null};
}

describe('experiment endpoints', () => {
  const policy = loadPolicy();
  // Synthetic: one routine case, 19 routine votes and 1 within_few_days.
  const records: Experiment['records'] = [
    {
      case_id: 'S01',
      reference: 'routine',
      fixed: null,
      floor: 'self_care',
      primary: {
        call_911: 0,
        ed_now: 0,
        in_person_today: 0,
        physician_contact_today: 0,
        within_few_days: 1,
        routine: 19,
        self_care: 0,
      },
      secondary: null,
      questions: 0,
      photo: false,
      base_reasons: [],
      latency_ms: 900,
    },
  ];
  const summary = summarize(
    [
      {
        reference: 'routine',
        disposition: 'routine',
        status: 'routed',
        flagged: false,
      },
    ],
    policy,
  );
  const full: Experiment = {
    id: 'run-a',
    label: 'Full system',
    models: 'default',
    rescorable: true,
    records,
    summary,
    median_latency_ms: 900,
  };
  const floor: Experiment = {
    ...full,
    id: 'run-b',
    label: 'Floor only',
    rescorable: false,
  };
  const env = {
    ...ENV,
    EXPERIMENTS: fakeKv({
      'experiments:index': ['run-a', 'run-b'],
      'experiment:run-a': full,
      'experiment:run-b': floor,
    }),
  };

  it('lists experiments without their records', async () => {
    const res = await app().request('/v1/experiments', {headers: AUTH}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      experiments: [full, floor].map(e => ({
        id: e.id,
        label: e.label,
        models: e.models,
        rescorable: e.rescorable,
        summary: e.summary,
        median_latency_ms: e.median_latency_ms,
      })),
    });
  });

  it('lists nothing from an empty KV', async () => {
    const res = await app().request(
      '/v1/experiments',
      {headers: AUTH},
      {...ENV, EXPERIMENTS: fakeKv()},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({experiments: []});
  });

  it('re-scores with the overrides applied', async () => {
    const res = await app().request(
      '/v1/experiments/run-a/rescore',
      post({policy: {min_top_votes: 20, human_review_cost: 0.5}}),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: typeof summary;
      policy_applied: unknown;
    };
    expect(body.policy_applied).toEqual({
      min_top_votes: 20,
      human_review_cost: 0.5,
    });
    // The split vote flags the case; the overridden review cost prices it.
    expect(body.summary.n).toBe(1);
    expect(body.summary.cost_score).toBeCloseTo(0.5, 9);
  });

  it('allows an emergency weight below the policy when re-scoring', async () => {
    const under = policy.loss.boundaries.map((b, i) =>
      i === 1 ? 0.5 : b.under,
    );
    const res = await app().request(
      '/v1/experiments/run-a/rescore',
      post({policy: {under_weights: under, human_review_cost: 0.5}}),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('answers 404 for an unknown id or an empty KV', async () => {
    const unknown = await app().request(
      '/v1/experiments/nope/rescore',
      post({policy: {}}),
      env,
    );
    expect(unknown.status).toBe(404);
    const empty = await app().request(
      '/v1/experiments/run-a/rescore',
      post({policy: {}}),
      {...ENV, EXPERIMENTS: fakeKv()},
    );
    expect(empty.status).toBe(404);
  });

  it('answers 409 for an experiment that cannot be re-scored', async () => {
    const res = await app().request(
      '/v1/experiments/run-b/rescore',
      post({policy: {}}),
      env,
    );
    expect(res.status).toBe(409);
  });

  it('answers 400 for invalid overrides', async () => {
    for (const body of [
      {policy: {min_valid: 30}},
      {policy: {min_top_votes: 7}},
      {policy: {under_weights: [1, 2]}},
      {policy: {temperature: 0}},
      {policy: 'loose'},
      {policy: {}, extra: true},
    ]) {
      const res = await app().request(
        '/v1/experiments/run-a/rescore',
        post(body),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({error: 'overrides invalid'});
    }
  });

  describe('with malformed KV values', () => {
    const malformed = {...full, id: 'run-c', records: 'not records'};
    const bad = {
      ...ENV,
      EXPERIMENTS: fakeKv(
        {
          'experiments:index': ['run-c', 'run-d', 'run-a', 'run-e'],
          'experiment:run-a': full,
          'experiment:run-c': malformed,
          'experiment:run-e': {...full, id: 'run-e', summary: {n: 1}},
        },
        {'experiment:run-d': '{not json'},
      ),
    };

    it('lists the valid experiments and skips the rest', async () => {
      const res = await app().request('/v1/experiments', {headers: AUTH}, bad);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {experiments: {id: string}[]};
      expect(body.experiments.map(e => e.id)).toEqual(['run-a']);
    });

    it('answers 404 when re-scoring a malformed experiment', async () => {
      for (const id of ['run-c', 'run-d', 'run-e']) {
        const res = await app().request(
          `/v1/experiments/${id}/rescore`,
          post({policy: {}}),
          bad,
        );
        expect(res.status).toBe(404);
      }
    });

    it('lists nothing for a malformed index', async () => {
      for (const index of ['{not json', '{"ids": ["run-a"]}', '[1, 2]']) {
        const res = await app().request(
          '/v1/experiments',
          {headers: AUTH},
          {
            ...ENV,
            EXPERIMENTS: fakeKv(
              {'experiment:run-a': full},
              {'experiments:index': index},
            ),
          },
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({experiments: []});
      }
    });
  });

  it('requires a bearer token', async () => {
    const list = await app().request('/v1/experiments', {}, env);
    expect(list.status).toBe(401);
    const rescore = await app().request(
      '/v1/experiments/run-a/rescore',
      post({policy: {}}, {'Content-Type': 'application/json'}),
      env,
    );
    expect(rescore.status).toBe(401);
  });
});
