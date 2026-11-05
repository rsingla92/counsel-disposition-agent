import {Hono, type MiddlewareHandler} from 'hono';
import {cors} from 'hono/cors';
import {stream} from 'hono/streaming';
import {z} from 'zod';
import routeResultSchema from '../../schema/route-result.schema.json';
import {LEVELS} from './levels';
import {openRouterClient} from './llm';
import {overrideLine} from './log';
import {
  LiveRouteOverridesSchema,
  PolicyOverridesSchema,
  applyPolicyOverrides,
  checkLiveSafe,
  majorityOk,
  selectModels,
} from './overrides';
import {route, type Deps, type EarlyEvent} from './pipeline';
import {loadPolicy} from './policy';
import {
  ExperimentIndexSchema,
  ExperimentSchema,
  rescore,
  type Experiment,
} from './rescore';
import {OverrideReasonCodeSchema} from './schema';

/** The read side of a Workers KV namespace, all the Worker uses. */
export type ExperimentStore = {get(key: string): Promise<string | null>};

export type Env = {
  OPENROUTER_API_KEY: string;
  ACCESS_TOKEN: string;
  PRIMARY_MODEL: string;
  PRIMARY_PROVIDER: string;
  SECONDARY_MODEL: string;
  SECONDARY_PROVIDER: string;
  ALLOWED_ORIGIN: string;
  /** Saved eval runs for the Operations view; absent reads as empty. */
  EXPERIMENTS?: ExperimentStore;
};

type App = {Bindings: Env};

const RouteBody = z.object({
  message: z.string().refine(s => s.trim() !== ''),
  mode: z.enum(['full', 'floor_only']).optional(),
  overrides: LiveRouteOverridesSchema.optional(),
});

/** A re-score of a saved run: the full override range, no live check. */
const RescoreBody = z.strictObject({
  policy: PolicyOverridesSchema.optional(),
});

/** Experiment ids as export_experiment.py writes them. */
const EXPERIMENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Reads a KV value that parses as `schema`; null when the store or key is
 * absent, or the value is not JSON or does not match.
 */
async function readKv<T>(
  store: ExperimentStore | undefined,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = store ? await store.get(key) : null;
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function readExperiment(
  store: ExperimentStore | undefined,
  id: string,
): Promise<Experiment | null> {
  if (!EXPERIMENT_ID.test(id)) return Promise.resolve(null);
  return readKv(store, `experiment:${id}`, ExperimentSchema);
}

/**
 * A physician override. `from` is null when the case had no disposition
 * (Human review), which is where a physician most needs to assign a level.
 * An override to the level the case already had is not an override.
 */
const OverrideBody = z
  .strictObject({
    input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    from: z.enum(LEVELS).nullable(),
    to: z.enum(LEVELS),
    reason_code: OverrideReasonCodeSchema,
  })
  .refine(o => o.from !== o.to);

/** Compares two strings in time that depends only on their lengths. */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

const bearerAuth: MiddlewareHandler<App> = async (c, next) => {
  if (c.req.method === 'GET' && c.req.path === '/v1/schema') return next();
  const expected = c.env?.ACCESS_TOKEN ?? '';
  const m = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  if (expected === '' || !m || !sameToken(m[1], expected)) {
    return c.json({error: 'unauthorized'}, 401);
  }
  return next();
};

/** Reads a JSON body; undefined when it is not JSON. */
async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** The Worker's HTTP API around injected dependencies. */
export function appFor(deps: Deps): Hono<App> {
  const app = new Hono<App>();

  app.use(
    '*',
    cors({
      origin: (origin, c) => {
        const allowed = (c.env as Env | undefined)?.ALLOWED_ORIGIN ?? '';
        return allowed !== '' && origin === allowed ? origin : null;
      },
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
    }),
  );
  app.use('*', bearerAuth);

  app.get('/v1/schema', c => c.json(routeResultSchema));

  app.get('/v1/policy', c => {
    const {policy} = deps;
    return c.json({
      policy_version: policy.policy_version,
      levels: policy.levels,
      red_flags: policy.red_flags.map(f => ({
        id: f.id,
        description: f.description,
        min_level: f.min_level,
      })),
      // The tunable router settings, so the Operations view starts its
      // sliders at the deployed values.
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
  });

  app.post('/v1/route', async c => {
    const parsed = RouteBody.safeParse(await body(c.req.raw));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return c.json(
        {
          error:
            field === 'mode'
              ? 'mode must be full or floor_only'
              : field === 'overrides'
                ? 'overrides invalid'
                : 'message must be non-empty text',
        },
        400,
      );
    }
    const {message, mode, overrides} = parsed.data;
    if (!majorityOk(deps.policy, overrides?.policy)) {
      return c.json({error: 'overrides invalid'}, 400);
    }
    const unsafe = checkLiveSafe(deps.policy, overrides?.policy);
    if (unsafe) return c.json({error: unsafe}, 400);
    let models: Pick<Deps, 'primary' | 'secondary' | 'extractionFallback'>;
    try {
      models = selectModels(overrides?.models, deps.primary, deps.secondary);
    } catch {
      return c.json({error: 'model not configured'}, 503);
    }
    if (!models.primary.model || !models.primary.provider) {
      return c.json({error: 'model not configured'}, 503);
    }
    // Without overrides the loaded Deps are used as they are.
    const routeDeps: Deps = overrides
      ? {
          ...deps,
          ...models,
          policy: applyPolicyOverrides(deps.policy, overrides.policy),
        }
      : deps;
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-store');
    return stream(c, async s => {
      // Each line is written as soon as it exists, so the early event reaches
      // the client while sampling is still running.
      let pending: Promise<unknown> = Promise.resolve();
      const send = (event: object) => {
        pending = pending
          .then(() => s.write(`${JSON.stringify(event)}\n`))
          .catch(() => {});
      };
      const result = await route(message, routeDeps, {
        mode,
        onEarly: (e: EarlyEvent) => send(e),
        overrides,
        deployedPolicy: overrides ? deps.policy : undefined,
      });
      send({event: 'result', result});
      await pending;
    });
  });

  app.post('/v1/override', async c => {
    const parsed = OverrideBody.safeParse(await body(c.req.raw));
    if (!parsed.success) {
      return c.json({error: 'invalid override'}, 400);
    }
    deps.log(overrideLine(parsed.data, deps.policy.policy_version));
    return c.body(null, 204);
  });

  app.get('/v1/experiments', async c => {
    const store = c.env?.EXPERIMENTS;
    const ids =
      (await readKv(store, 'experiments:index', ExperimentIndexSchema)) ?? [];
    const experiments = [];
    for (const id of ids) {
      const e = await readExperiment(store, id);
      if (!e) continue;
      experiments.push({
        id: e.id,
        label: e.label,
        models: e.models,
        rescorable: e.rescorable,
        summary: e.summary,
        median_latency_ms: e.median_latency_ms,
      });
    }
    return c.json({experiments});
  });

  app.post('/v1/experiments/:id/rescore', async c => {
    const parsed = RescoreBody.safeParse(await body(c.req.raw));
    if (!parsed.success || !majorityOk(deps.policy, parsed.data.policy)) {
      return c.json({error: 'overrides invalid'}, 400);
    }
    const exp = await readExperiment(c.env?.EXPERIMENTS, c.req.param('id'));
    if (!exp) return c.json({error: 'experiment not found'}, 404);
    if (!exp.rescorable) {
      return c.json({error: 'experiment cannot be re-scored'}, 409);
    }
    const applied = parsed.data.policy ?? {};
    return c.json({
      summary: rescore(exp, applyPolicyOverrides(deps.policy, applied)),
      policy_applied: applied,
    });
  });

  app.notFound(c => c.json({error: 'not found'}, 404));
  app.onError((_, c) => c.json({error: 'internal error'}, 500));
  return app;
}

/** Builds Deps from the Worker environment, once per request. */
export function depsFromEnv(env: Env): Deps {
  const secondary =
    env.SECONDARY_MODEL && env.SECONDARY_PROVIDER
      ? {model: env.SECONDARY_MODEL, provider: env.SECONDARY_PROVIDER}
      : null;
  return {
    llm: openRouterClient(env.OPENROUTER_API_KEY),
    policy: loadPolicy(),
    primary: {
      model: env.PRIMARY_MODEL ?? '',
      provider: env.PRIMARY_PROVIDER ?? '',
    },
    secondary,
    log: line => console.log(line),
  };
}

/**
 * The Worker entry point. Deps are built per request outside the Hono app,
 * so a failure there (such as a policy that does not parse) is caught here
 * and answered with a bare 503: no details, and only a minimal log line.
 */
export function workerFor(
  makeDeps: (env: Env) => Deps = depsFromEnv,
  log: (line: string) => void = line => console.log(line),
) {
  return {
    fetch(req: Request, env: Env, ctx?: unknown): Response | Promise<Response> {
      let deps: Deps;
      try {
        deps = makeDeps(env);
      } catch {
        try {
          log(
            JSON.stringify({
              kind: 'error',
              ts: new Date().toISOString(),
              where: 'deps',
            }),
          );
        } catch {
          // Logging must not change the response.
        }
        return new Response(JSON.stringify({error: 'service misconfigured'}), {
          status: 503,
          headers: {'Content-Type': 'application/json'},
        });
      }
      const app = appFor(deps);
      return app.fetch(req, env, ctx as Parameters<typeof app.fetch>[2]);
    },
  };
}

export default workerFor();
