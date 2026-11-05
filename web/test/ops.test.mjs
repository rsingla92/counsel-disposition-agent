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
  overridesText,
  policyDefaults,
  rescoreOutcome,
  resultsPanel,
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

test('the policy default model pair sends no models override', () => {
  // Sonnet plus Flash is the deployed configuration, so it is no override.
  assert.equal(overridesFromControls(controls({models: 'sonnet+flash'}), POLICY), null);
  assert.deepEqual(
    overridesFromControls(controls({models: 'sonnet+flash', max_span: 3}), POLICY),
    {policy: {max_span: 3}},
  );
  // A stored sonnet+flash shows as the policy default.
  assert.equal(controlsFromOverrides({models: 'sonnet+flash'}, POLICY).models, 'policy');
});

test('controlsFromOverrides round-trips through overridesFromControls', () => {
  const o = {models: 'sonnet', policy: {max_span: 3, under_weights: [3, 10, 2, 5, 2, 1.5]}};
  const c = controlsFromOverrides(o, POLICY);
  assert.equal(c.models, 'sonnet');
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

test('the browser waits 150 s for a live route', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'web/app.js'), 'utf8');
  assert.match(src, /const LIVE_TIMEOUT_MS = 150_000;/);
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
  assert.equal(bannerText({models: 'sonnet'}), 'Next live message uses: Sonnet only');
  assert.equal(bannerText({models: 'flash'}), 'Next live message uses: Flash only');
  assert.equal(bannerText({models: 'sonnet+flash'}), 'Next live message uses: Sonnet + Flash');
});

test('banner text names the settings', () => {
  assert.equal(
    bannerText({models: 'sonnet', policy: {min_top_votes: 14}}),
    'Next live message uses: Sonnet only · agreement 14/20',
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
    'Next live message uses: valid samples 12/20 · spread 3 · review cost 0.40 · under-triage weights 3, 25, 2, 5, 2, 1.5',
  );
});

test('banner text is null with no overrides', () => {
  assert.equal(bannerText(null), null);
  assert.equal(bannerText(undefined), null);
  assert.equal(bannerText({}), null);
  assert.equal(bannerText({policy: {}}), null);
});

test('overridesText names the settings without a prefix', () => {
  assert.equal(
    overridesText({models: 'sonnet', policy: {min_top_votes: 14}}),
    'Sonnet only · agreement 14/20',
  );
  assert.equal(overridesText(null), null);
  assert.equal(overridesText({policy: {}}), null);
});

test('a replay never claims the overrides were used', () => {
  const o = {models: 'sonnet'};
  assert.equal(routingBanner(o, true), 'Replay: saved result');
  assert.equal(routingBanner(o, false), 'Next live message uses: Sonnet only');
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

test('isWhatIf covers min_valid below the policy', () => {
  assert.equal(isWhatIf({policy: {min_valid: 14}}, POLICY), true);
  assert.equal(isWhatIf({policy: {min_valid: 10}}, POLICY), true);
  assert.equal(isWhatIf({policy: {min_valid: 15}}, POLICY), false);
  assert.equal(isWhatIf({policy: {min_valid: 16}}, POLICY), false);
  assert.equal(isWhatIf({policy: {min_valid: 14}}, null), false);
});

test('the live clamp raises min_valid to the policy value', () => {
  // Raised to 15, the policy value, so the field is dropped.
  const o = {models: 'flash', policy: {min_valid: 12, max_span: 3}};
  assert.deepEqual(liveOverrides(o, POLICY), {models: 'flash', policy: {max_span: 3}});
  // Raising past the policy keeps the override.
  assert.deepEqual(liveOverrides({policy: {min_valid: 18}}, POLICY), {policy: {min_valid: 18}});
  // The input is not changed.
  assert.equal(o.policy.min_valid, 12);
});

test('the live clamp keeps agreement a majority of the clamped min_valid', () => {
  // min_valid 10 clamps to 15, so agreement 6 would fail the Worker's
  // majority check (15 needs 8). It is raised to 8.
  const live = liveOverrides({policy: {min_valid: 10, min_top_votes: 6}}, POLICY);
  assert.deepEqual(live, {policy: {min_top_votes: 8}});
  assert.ok(!bannerText(live).includes('agreement 6'));
  assert.equal(bannerText(live), 'Next live message uses: agreement 8/20');
  // An agreement already above the majority (9 ≥ 8) is left alone.
  assert.deepEqual(liveOverrides({policy: {min_valid: 10, min_top_votes: 9}}, POLICY), {
    policy: {min_top_votes: 9},
  });
  // Raised to exactly the policy value, it is dropped.
  const p13 = {...POLICY, min_top_votes: 8};
  assert.equal(liveOverrides({policy: {min_valid: 10, min_top_votes: 6}}, p13), null);
});

test('the live clamp drops min_valid when it lands on the policy', () => {
  assert.equal(liveOverrides({policy: {min_valid: 10}}, POLICY), null);
  assert.deepEqual(liveOverrides({models: 'sonnet', policy: {min_valid: 15}}, POLICY), {
    models: 'sonnet',
  });
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

// --- results panel -----------------------------------------------------------

const SUM = {n: 50, emergencies: 14, missed: 0, confusion: {}};

test('a failed re-score shows the error, never the old numbers', () => {
  const p = resultsPanel({summary: SUM, error: 'The Worker rejected these settings.', rescoring: false});
  assert.equal(p.kind, 'error');
  assert.equal(p.summary, null);
  assert.equal(
    p.text,
    'Couldn’t re-score these settings — The Worker rejected these settings. Move a slider or Reset to try again.',
  );
});

test('results panel states', () => {
  assert.deepEqual(resultsPanel({summary: SUM, error: '', rescoring: false}), {kind: 'metrics', summary: SUM, busy: false});
  assert.deepEqual(resultsPanel({summary: SUM, error: '', rescoring: true}), {kind: 'metrics', summary: SUM, busy: true});
  assert.deepEqual(resultsPanel({summary: null, error: '', rescoring: true}), {kind: 'loading', summary: null, text: 'Re-scoring…'});
  assert.deepEqual(resultsPanel({summary: null, error: '', rescoring: false}), {kind: 'empty', summary: null, text: 'No result yet.'});
});

// --- re-score outcomes -------------------------------------------------------

const GOOD = {n: 50, emergencies: 14, missed: 0, confusion: {}};

test('a network failure (status 0) is the connection error, never a summary', () => {
  assert.deepEqual(rescoreOutcome({ok: false, status: 0, data: null}), {
    error: 'Couldn’t reach the Worker. Check the connection.',
  });
});

test('an {error: 0} object is never treated as a summary', () => {
  for (const data of [{error: 0}, {summary: {error: 0}}, {summary: null}, null, {}]) {
    const out = rescoreOutcome({ok: true, status: 200, data});
    assert.ok(!('summary' in out), JSON.stringify(data));
    assert.equal(out.error, 'The Worker sent an unreadable result.');
  }
});

test('rescoreOutcome maps each status to one plain reason', () => {
  const err = status => rescoreOutcome({ok: false, status, data: null}).error;
  assert.equal(err(404), 'This run is no longer stored on the Worker.');
  assert.equal(err(409), 'This run cannot be re-scored.');
  assert.equal(err(400), 'The Worker rejected these settings.');
  assert.equal(err(401), 'The access token was rejected.');
  assert.equal(err(503), 'The Worker returned an error (HTTP 503).');
  assert.deepEqual(rescoreOutcome({ok: true, status: 200, data: {summary: GOOD}}), {summary: GOOD});
});

test('a connection error reaches the results panel as an error', () => {
  const {error} = rescoreOutcome({ok: false, status: 0, data: null});
  const p = resultsPanel({summary: null, error, rescoring: false});
  assert.equal(p.kind, 'error');
  assert.match(p.text, /Couldn’t reach the Worker/);
});

test('resultsPanel treats only a non-empty message as an error', () => {
  assert.equal(resultsPanel({summary: GOOD, error: 0, rescoring: false}).kind, 'metrics');
  assert.equal(resultsPanel({summary: GOOD, error: null, rescoring: false}).kind, 'metrics');
  assert.equal(resultsPanel({summary: GOOD, error: '', rescoring: false}).kind, 'metrics');
  // A summary that is really an error object is not shown as numbers.
  assert.equal(resultsPanel({summary: {error: 0}, error: null, rescoring: false}).kind, 'empty');
});
