import {mkdirSync, writeFileSync} from 'node:fs';
import {z} from 'zod';
import {RouteResultSchema} from '../src/schema';

const out = new URL('../../schema/route-result.schema.json', import.meta.url);
mkdirSync(new URL('./', out), {recursive: true});
writeFileSync(
  out,
  `${JSON.stringify(z.toJSONSchema(RouteResultSchema), null, 2)}\n`,
);
