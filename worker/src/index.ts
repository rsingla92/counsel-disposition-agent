import {Hono, type MiddlewareHandler} from 'hono';
import {cors} from 'hono/cors';
import {stream} from 'hono/streaming';
import {z} from 'zod';
import routeResultSchema from '../../schema/route-result.schema.json';
import {LEVELS} from './levels';
import {openRouterClient} from './llm';
import {overrideLine} from './log';
import {route, type Deps, type EarlyEvent} from './pipeline';
import {loadPolicy} from './policy';
import {OverrideReasonCodeSchema} from './schema';

export type Env = {
  OPENROUTER_API_KEY: string;
  ACCESS_TOKEN: string;
  PRIMARY_MODEL: string;
  PRIMARY_PROVIDER: string;
  SECONDARY_MODEL: string;
  SECONDARY_PROVIDER: string;
  ALLOWED_ORIGIN: string;
};

type App = {Bindings: Env};

const RouteBody = z.object({
  message: z.string().refine(s => s.trim() !== ''),
  mode: z.enum(['full', 'floor_only']).optional(),
});

const OverrideBody = z.strictObject({
  input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  from: z.enum(LEVELS),
  to: z.enum(LEVELS),
  reason_code: OverrideReasonCodeSchema,
});

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
              : 'message must be non-empty text',
        },
        400,
      );
    }
    if (!deps.primary.model || !deps.primary.provider) {
      return c.json({error: 'model not configured'}, 503);
    }
    const {message, mode} = parsed.data;
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
      const result = await route(message, deps, {
        mode,
        onEarly: (e: EarlyEvent) => send(e),
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
