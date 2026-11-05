import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  LEVELS,
  OVERRIDE_RANGES,
  bannerText,
  confusionGrid,
  controlsFromOverrides,
  delta,
  isWhatIf,
  liveOverrides,
  minTopVotes,
  overridesFromControls,
  policyDefaults,
  routingBanner,
  validStoredOverrides,
} from '../lib.js';

// The deployed policy's tunable values (policy/policy.yaml), flattened.
const POLICY = {
  min_valid: 15,
  min_top_votes: 12,
  max_span: 2,
  human_review_cost: 0.2,
  under_weights: [3, 20, 2, 5, 2, 1.5],
};

function controls(over = {}) {
  return {
    models: 'policy',
    ...POLICY,
    under_weights: [...POLICY.under_weights],
    ...over,
  };
}

// --- policyDefaults --------------------------------------------------------

test('policyDefaults flattens the /v1/policy response', () => {
  const api = {
    policy_version: 'v1',
    sampling: {n: 20, min_valid: 15},
    review: {min_top_votes: 12, max_span: 2},
    loss: {
      human_review_cost: 0.2,
      boundaries: [3, 20, 2, 5, 2, 1.5].map(under => ({
        between: ['a', 'b'],
        under,
        over: 1,
      })),
    },
  };
  assert.deepEqual(policyDefaults(api), POLICY);
});

test('policyDefaults is null for a response without the tunable fields', () => {
  assert.equal(policyDefaults({policy_version: 'v1'}), null);
  assert.equal(policyDefaults(null), null);
});

// --- overridesFromControls -------------------------------------------------

test('unchanged controls give null', () => {
  assert.equal(overridesFromControls(controls(), POLICY), null);
});

test('overridesFromControls keeps only the fields that differ', () => {
  assert.deepEqual(
    overridesFromControls(controls({models: 'sonnet', min_top_votes: 14}), POLICY),
    {models: 'sonnet', policy: {min_top_votes: 14}},
  );
});

test('overridesFromControls sends all six weights when one changes', () => {
  const c = controls({under_weights: [3, 25, 2, 5, 2, 1.5]});
  assert.deepEqual(overridesFromControls(c, POLICY), {
    policy: {under_weights: [3, 25, 2, 5, 2, 1.5]},
  });
});

test('a model choice alone gives no policy object', () => {
  assert.deepEqual(overridesFromControls(controls({models: 'flash'}), POLICY), {
    models: 'flash',
  });
});

test('controlsFromOverrides round-trips through overridesFromControls', () => {
  const o = {models: 'sonnet+flash', policy: {max_span: 3, under_weights: [3, 10, 2, 5, 2, 1.5]}};
  const c = controlsFromOverrides(o, POLICY);
  assert.equal(c.models, 'sonnet+flash');
  assert.equal(c.max_span, 3);
  assert.equal(c.min_valid, 15);
  assert.deepEqual(overridesFromControls(c, POLICY), o);
  assert.deepEqual(controlsFromOverrides(null, POLICY), controls());
});

// --- validStoredOverrides --------------------------------------------------

test('a stored object with min_valid: 30 gives null', () => {
  assert.equal(validStoredOverrides({policy: {min_valid: 30}}, POLICY), null);
});

test('validStoredOverrides keeps a valid stored object', () => {
  const o = {models: 'sonnet', policy: {min_top_votes: 14, human_review_cost: 0.4}};
  assert.deepEqual(validStoredOverrides(o, POLICY), o);
});

test('validStoredOverrides drops every malformed shape', () => {
  const bad = [
    null,
    'sonnet',
    [],
    {},
    {models: 'gpt'},
    {models: 'sonnet', extra: 1},
    {policy: {}},
    {policy: {unknown: 1}},
    {policy: {min_valid: 15.5}},
    {policy: {max_span: 7}},
    {policy: {human_review_cost: 0.07}},
    {policy: {human_review_cost: 0}},
    {policy: {under_weights: [3, 20, 2, 5, 2]}},
    {policy: {under_weights: [3, 20, 2, 5, 2, 51]}},
    {policy: {under_weights: [3, 20.2, 2, 5, 2, 1.5]}},
    {policy: {under_weights: [3, '20', 2, 5, 2, 1.5]}},
    // Not a majority of the policy's min_valid (15 needs 8).
    {policy: {min_top_votes: 7}},
    // Not a majority of the stored min_valid (20 needs 11).
    {policy: {min_valid: 20, min_top_votes: 10}},
  ];
  for (const s of bad) {
    assert.equal(validStoredOverrides(s, POLICY), null, JSON.stringify(s));
  }
});

test('validStoredOverrides is null without a loaded policy', () => {
  assert.equal(validStoredOverrides({models: 'sonnet'}, null), null);
});

test('min_top_votes may exceed min_valid (every routed case then splits)', () => {
  const o = {policy: {min_valid: 10, min_top_votes: 20}};
  assert.deepEqual(validStoredOverrides(o, POLICY), o);
});

test('minTopVotes is a simple majority of min_valid', () => {
  assert.equal(minTopVotes(15), 8);
  assert.equal(minTopVotes(10), 6);
  assert.equal(minTopVotes(20), 11);
});

test('the ranges table matches the plan', () => {
  assert.deepEqual(OVERRIDE_RANGES.min_valid, {min: 10, max: 20, step: 1});
  assert.deepEqual(OVERRIDE_RANGES.min_top_votes, {min: 6, max: 20, step: 1});
  assert.deepEqual(OVERRIDE_RANGES.max_span, {min: 0, max: 6, step: 1});
  assert.deepEqual(OVERRIDE_RANGES.human_review_cost, {min: 0.05, max: 2, step: 0.05});
  assert.deepEqual(OVERRIDE_RANGES.under_weight, {min: 0.5, max: 50, step: 0.5});
});

test('the ranges table matches worker/src/overrides.ts, the authority', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'worker/src/overrides.ts'), 'utf8');
  const r = OVERRIDE_RANGES;
  for (const needle of [
    `min_valid: z.number().int().min(${r.min_valid.min}).max(${r.min_valid.max})`,
    `min_top_votes: z.number().int().min(${r.min_top_votes.min}).max(${r.min_top_votes.max})`,
    `max_span: z.number().int().min(${r.max_span.min}).max(${r.max_span.max})`,
    `human_review_cost: stepped(${r.human_review_cost.min}, ${r.human_review_cost.max}, ${r.human_review_cost.step})`,
    `.array(stepped(${r.under_weight.min}, ${r.under_weight.max}, ${r.under_weight.step}))`,
  ]) {
    assert.ok(src.includes(needle), needle);
  }
});

// --- banner ----------------------------------------------------------------

test('banner text for each model choice', () => {
  assert.equal(bannerText({models: 'sonnet'}), 'Routing with: Sonnet only');
  assert.equal(bannerText({models: 'flash'}), 'Routing with: Flash only');
  assert.equal(bannerText({models: 'sonnet+flash'}), 'Routing with: Sonnet + Flash');
});

test('banner text names the settings', () => {
  assert.equal(
    bannerText({models: 'sonnet', policy: {min_top_votes: 14}}),
    'Routing with: Sonnet only · agreement 14/20',
  );
  assert.equal(
    bannerText({
      policy: {
        min_valid: 12,
        max_span: 3,
        human_review_cost: 0.4,
        under_weights: [3, 25, 2, 5, 2, 1.5],
      },
    }),
    'Routing with: valid samples 12/20 · spread 3 · review cost 0.40 · under-triage weights 3, 25, 2, 5, 2, 1.5',
  );
});

test('banner text is null with no overrides', () => {
  assert.equal(bannerText(null), null);
  assert.equal(bannerText(undefined), null);
  assert.equal(bannerText({}), null);
  assert.equal(bannerText({policy: {}}), null);
});

test('a replay never claims the overrides were used', () => {
  const o = {models: 'sonnet'};
  assert.equal(routingBanner(o, true), 'Replay: saved result');
  assert.equal(routingBanner(o, false), 'Routing with: Sonnet only');
  assert.equal(routingBanner(null, true), null);
  assert.equal(routingBanner(null, false), null);
});

// --- what-if and the live clamp --------------------------------------------

test('isWhatIf is true at under_weights[1] = 10 and false at 25', () => {
  const w = x => ({policy: {under_weights: [3, x, 2, 5, 2, 1.5]}});
  assert.equal(isWhatIf(w(10), POLICY), true);
  assert.equal(isWhatIf(w(25), POLICY), false);
  assert.equal(isWhatIf({policy: {under_weights: [2.5, 20, 2, 5, 2, 1.5]}}, POLICY), true);
  // Lowering a non-emergency weight is not a what-if.
  assert.equal(isWhatIf({policy: {under_weights: [3, 20, 0.5, 5, 2, 1.5]}}, POLICY), false);
  assert.equal(isWhatIf(null, POLICY), false);
  assert.equal(isWhatIf({models: 'sonnet'}, POLICY), false);
});

test('the live clamp raises a what-if under_weights[1] of 10 to 20', () => {
  const o = {models: 'sonnet', policy: {under_weights: [1, 10, 0.5, 5, 2, 1.5]}};
  assert.deepEqual(liveOverrides(o, POLICY), {
    models: 'sonnet',
    policy: {under_weights: [3, 20, 0.5, 5, 2, 1.5]},
  });
  // The input is not changed.
  assert.deepEqual(o.policy.under_weights, [1, 10, 0.5, 5, 2, 1.5]);
});

test('the live clamp keeps raised emergency weights', () => {
  const o = {policy: {under_weights: [4, 30, 2, 5, 2, 1.5]}};
  assert.deepEqual(liveOverrides(o, POLICY), o);
});

test('live overrides never include human_review_cost', () => {
  assert.deepEqual(
    liveOverrides({models: 'flash', policy: {human_review_cost: 0.5, max_span: 3}}, POLICY),
    {models: 'flash', policy: {max_span: 3}},
  );
  assert.equal(liveOverrides({policy: {human_review_cost: 0.5}}, POLICY), null);
});

test('live overrides drop weights the clamp returns to the policy', () => {
  assert.equal(
    liveOverrides({policy: {under_weights: [3, 10, 2, 5, 2, 1.5]}}, POLICY),
    null,
  );
  assert.equal(liveOverrides(null, POLICY), null);
  assert.equal(liveOverrides({models: 'sonnet'}, null), null);
});

// --- delta -----------------------------------------------------------------

test('delta formats percentages, decimals and counts', () => {
  assert.equal(delta(0.18, 0.12, 'percent'), '12% → 18%');
  assert.equal(delta(0.86, 0.8, 'decimal'), '0.80 → 0.86');
  assert.equal(delta(2, 0, 'count'), '0 → 2');
});

test('delta says when nothing changed', () => {
  assert.equal(delta(0.12, 0.12, 'percent'), '12%, no change');
  assert.equal(delta(0.8004, 0.8, 'decimal'), '0.80, no change');
});

test('delta without a baseline shows the value alone', () => {
  assert.equal(delta(0.12, null, 'percent'), '12%');
  assert.equal(delta(Number.NaN, 0.1, 'percent'), '10% → —');
});

// --- confusion grid --------------------------------------------------------

function confusion(cells = {}) {
  const cols = [...LEVELS, 'human_review'];
  const out = {};
  for (const r of LEVELS) out[r] = Object.fromEntries(cols.map(c => [c, 0]));
  for (const [key, n] of Object.entries(cells)) {
    const [r, c] = key.split('>');
    out[r][c] = n;
  }
  return out;
}

test('confusionGrid is 7 rows by 8 columns with shared shading steps', () => {
  const now = confusion({'ed_now>ed_now': 6, 'ed_now>human_review': 3, 'routine>routine': 1});
  const base = confusion({'ed_now>ed_now': 8, 'ed_now>human_review': 1, 'routine>routine': 1});
  const g = confusionGrid(now, base);
  assert.equal(g.rows.length, 7);
  assert.ok(g.rows.every(r => r.cells.length === 8));
  assert.equal(g.columns.at(-1).label, 'Human review');
  assert.equal(g.max, 6);
  const ed = g.rows[1];
  assert.equal(ed.label, 'ED now');
  assert.deepEqual(
    {count: ed.cells[1].count, base: ed.cells[1].base, step: ed.cells[1].step, diagonal: ed.cells[1].diagonal},
    {count: 6, base: 8, step: 7, diagonal: true},
  );
  assert.equal(ed.cells[7].count, 3);
  assert.equal(ed.cells[7].step, 4);
  // Zero is step 0 (no fill); any case at all is at least step 1.
  assert.equal(ed.cells[2].step, 0);
  assert.equal(g.rows[5].cells[5].step, 2);
});

test('confusionGrid tolerates a missing grid and a missing baseline', () => {
  const g = confusionGrid(undefined, undefined);
  assert.equal(g.max, 0);
  assert.ok(g.rows.every(r => r.cells.every(c => c.count === 0 && c.base === null && c.step === 0)));
});
