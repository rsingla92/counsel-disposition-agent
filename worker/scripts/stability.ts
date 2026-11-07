// Vote-count stability for saved experiments: one markdown table each.
// Usage: npm run stability -- [--draws 500] [--seed 1] <experiment.json>...
// The files are exported experiments (votes only, no message text); the
// output holds aggregate numbers only.
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {loadPolicy} from '../src/policy';
import {ExperimentSchema} from '../src/rescore';
import {stabilityCurve} from '../src/stability';

const KS = [3, 4, 5, 6, 8, 10, 12, 15, 20];

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    draws: {type: 'string', default: '500'},
    seed: {type: 'string', default: '1'},
  },
});
const draws = Number(values.draws);
const seed = Number(values.seed);
if (!Number.isInteger(draws) || draws < 1 || !Number.isInteger(seed)) {
  console.error('--draws must be a positive integer and --seed an integer');
  process.exit(4);
}
if (positionals.length === 0) {
  console.error('give at least one exported experiment file');
  process.exit(4);
}

const policy = loadPolicy();
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(
  `Policy ${policy.policy_version}; ${draws} draws per k, seed ${seed}.\n`,
);
for (const file of positionals) {
  const exp = ExperimentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  console.log(`### ${exp.label} (${exp.records.length} cases)\n`);
  console.log(
    '| Votes per model | Valid needed | Agreeing needed | Missed emergencies (mean) | Draws with a miss | Same level as full run | Flagged | Human review | Cost score (mean) | Cost score (p90) |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of stabilityCurve(exp, policy, KS, draws, seed)) {
    console.log(
      `| ${r.k} | ${r.min_valid} | ${r.min_top_votes} | ${r.missed_mean.toFixed(2)} | ${pct(r.any_miss_rate)} | ${pct(r.agreement)} | ${pct(r.flagged_rate)} | ${pct(r.human_review_rate)} | ${r.cost_mean.toFixed(3)} | ${r.cost_p90.toFixed(3)} |`,
    );
  }
  console.log('');
}
