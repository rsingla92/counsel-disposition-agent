// Compiles policy/policy.yaml to src/generated/policy.json (gitignored).
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';

const source = fileURLToPath(new URL('../../policy/policy.yaml', import.meta.url));
const outDir = fileURLToPath(new URL('../src/generated/', import.meta.url));

const policy = parse(readFileSync(source, 'utf8'));
mkdirSync(outDir, {recursive: true});
writeFileSync(`${outDir}policy.json`, `${JSON.stringify(policy, null, 2)}\n`);
