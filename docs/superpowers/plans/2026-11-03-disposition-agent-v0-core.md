# Disposition Agent V0 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that turns one async patient message into a validated disposition (concept extraction → rule floor → 20-sample expected-cost router), a Python eval harness that scores it against the reference labels behind a zero-miss gate, and a minimal physician/patient demo view on GitHub Pages that calls the same endpoint.

**Architecture:** All routing logic lives once, in TypeScript, in the Worker (`worker/`). The demo (`web/`) and the eval (`eval/`, Python) both call `POST /v1/route` over HTTP, so there is one code path. Red flags, modifiers, the loss matrix and thresholds live in `policy/policy.yaml`; the Worker bundles a JSON copy generated at build time, and the eval reads the YAML directly.

**Tech Stack:** TypeScript 5, Hono 4.13, Zod 4.6 (`z.toJSONSchema`), Wrangler 4.157, Vitest 5, gts 7, `yaml` 2.9 · Python 3.11 via uv: pandas, openpyxl, httpx, jsonschema, PyYAML, scipy, scikit-learn; pytest, respx, pyink, pylint · OpenRouter chat completions over `fetch` · GitHub Actions, GitHub Pages.

**Spec:** `docs/brief/PRD.pdf` (text copy: `docs/brief/PRD.txt`). Labels: `docs/brief/Labels.txt`. Both are gitignored and exist only on the author's machine; executors read them locally. Page numbers below refer to the PRD.

**Scope of this plan.** The PRD's core items plus cross-model disagreement: PRD tasks T1, T2, T4, T5, T6, T8, T9, T11, the core part of T10 (always-escalate, rule-floor, historical rungs), the replay part of T13, and the README part of T15. Follow-up plans, written after this one merges: (a) adversarial set T7, synthetic and public benchmarks T17, policy expansion T16; (b) RF and logistic-regression rungs (rest of T10); (c) clarifier T18 and context interface T19. User testing (T14) and slides are not code and are out of scope.

## Global Constraints

- Every failure path ends at a physician or at a higher disposition, never a lower one (PRD p. 9).
- A red flag marked present forces at least its minimum disposition, whatever the LLM says (Req. 3).
- Seven levels, most to least acute: `call_911`, `ed_now`, `in_person_today`, `physician_contact_today`, `within_few_days`, `routine`, `self_care`; statuses `needs_info`, `human_review`.
- Brief's labels: the first four levels → `URGENT_ESCALATION`; `within_few_days`, `routine` → `ASYNC_PHYSICIAN`; `self_care` → `SELF_CARE`.
- Zero-miss gate: no case referenced `call_911` or `ed_now` may be routed below `ed_now`.
- Human review with no disposition scores as `routine`.
- Justification cites the flags and says why not one level higher or lower. No length limit (author decision 2026-11-03, overriding PRD Req. 4's three-sentence cap).
- Every excerpt for a present flag must be checked as a verbatim substring of the message.
- Models are reached through OpenRouter with the provider pinned, `allow_fallbacks: false`, zero-data-retention only (D9).
- Logs record input SHA-256, policy version, model, provider, latency and raw output; never the message text or an IP address (Req. 9, Privacy).
- Tests are hermetic with the LLM mocked; live-model runs belong to the eval harness (D12).
- Style: gts for TypeScript; pyink (line length 80) and pylint with Google's `pylintrc` for Python; type hints and Google-format docstrings. Enforced in CI.
- Git: one branch and PR per task, PR linked to an issue, PR description ≤ 5 lines (summary, what, why, how tested). Commit subject imperative, ~50 chars, body explains why (D12).
- Second opinion: every task PR gets a Codex review (comment `@codex review` on the PR) in addition to the fresh Claude reviewer. Triage its findings with superpowers:receiving-code-review before merging. Task 1 adds `AGENTS.md` with Codex's review guidelines: the zero-miss gate, fail-safe paths, the verbatim-excerpt rule, and no Counsel data in the repo.
- **Never commit** `docs/brief/`, `data/private/`, Counsel's messages, or any excerpt from them. The repo is public. Demo and replay content is synthetic only.
- Headline numbers come only from the 50 reviewed cases.

## Review Focus

1. **A red flag buried in a routine request** ("refill please, also my chest feels tight"): the floor must win even when all 20 samples say `routine`, and the early emergency event must fire. Test in Task 7.
2. **Several modifiers at once** (age 70, diabetes, warfarin): the floor rises one level in total, not one per modifier, and never above `in_person_today`. Test in Task 3.
3. **Excerpts that differ only in curly quotes, case or whitespace** must still verify; a paraphrased excerpt must fail verification while the flag stays present and the case is flagged `unverified_excerpt`. Test in Task 3.
4. **Some samples fail**: 3 of 20 timeouts still route on the 17 valid samples; 6 of 20 timeouts fall below `min_valid` (15) and return Human review, carrying the floor only if it is Emergency. Tests in Tasks 6 and 7.
5. **Logs never contain the message text or client IP**, even on failure paths. Test in Task 7.

## File Structure

```
policy/policy.yaml              versioned red flags, modifiers, levels, loss, thresholds
policy/cost_fixtures.json       shared cost cases, tested by both TS and Python
schema/route-result.schema.json generated from Zod; the eval validates against it
worker/
  package.json, tsconfig.json, wrangler.toml, vitest.config.ts
  scripts/build-policy.mjs      policy.yaml → src/generated/policy.json (gitignored)
  scripts/export-schema.ts      writes ../schema/route-result.schema.json
  src/levels.ts                 level order, rank, tier, brief label
  src/policy.ts                 Zod PolicySchema, loadPolicy()
  src/schema.ts                 Extraction, Sample, RouteResult schemas, reason codes
  src/floor.ts                  ruleFloor(), verifyExcerpt()
  src/router.ts                 cost(), expectedCost(), chooseLevel(), reviewReasons()
  src/llm.ts                    LlmClient interface, openRouterClient(), LlmError
  src/extract.ts                extraction prompt and call
  src/sample.ts                 drawSamples()
  src/pipeline.ts               route(): the 8-step pipeline
  src/log.ts                    traceLine()
  src/index.ts                  Hono app: /v1/route, /v1/override, /v1/schema, /v1/policy
  test/*.test.ts
eval/
  pyproject.toml, .pylintrc
  src/counsel_eval/levels.py, data.py, scoring.py, client.py, baselines.py, run.py, record_demo.py
  tests/test_*.py
web/
  index.html, app.js, lib.js, style.css, config.js
  demo-messages.json            synthetic demo messages
  replay/manifest.json, replay/<id>.json
  test/lib.test.mjs
data/private/                   gitignored: Counsel xlsx, reference_labels.csv, runs/
reports/                        aggregate eval reports (no message text)
.github/workflows/ci.yml, pages.yml
```

**Task order.** Task 1 → Task 2, then Tasks 3, 4, 5 and 8 in parallel; 6 after 5; 7 after 3–6; 9 after 7 and 8; 10 after 7; 11 after 9 and 10; 12 last. Tasks 1 and 2 stop for the author's review before merging, because the PRD says the author writes the policy and schema before any agent starts.

---

### Task 1: Scaffold, CI and `policy.yaml` (PRD T1)

**Files:**
- Create: `AGENTS.md` (Codex review guidelines, under a `## Review guidelines` heading), `policy/policy.yaml`, `policy/cost_fixtures.json`, `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/scripts/build-policy.mjs`, `worker/src/levels.ts`, `worker/src/policy.ts`, `.github/workflows/ci.yml`
- Modify: `.gitignore` (add `worker/src/generated/`, `node_modules/`, `.wrangler/`)
- Test: `worker/test/policy.test.ts`, `worker/test/levels.test.ts`

**Interfaces:**
- Produces:
  - `LEVELS: readonly Level[]` (most acute first, as in Global Constraints); `type Level`; `type Tier = 'emergency'|'same_day'|'async'|'self_care'`; `type BriefLabel = 'URGENT_ESCALATION'|'ASYNC_PHYSICIAN'|'SELF_CARE'`
  - `rank(l: Level): number` (`self_care` = 0 … `call_911` = 6), `levelAtRank(r: number): Level`, `maxLevel(a: Level, b: Level): Level`, `tierOf(l: Level): Tier`, `briefLabelOf(l: Level): BriefLabel`
  - `PolicySchema` (Zod), `type Policy = z.infer<typeof PolicySchema>`, `loadPolicy(): Policy` (imports `./generated/policy.json`, parses with `PolicySchema`)

`policy.yaml` shape (top-level keys fixed; one `red_flags` entry per row of the adult, pediatric and obstetric tables on PRD pp. 11–14):

```yaml
policy_version: "0.1.0"
intake: {max_chars: 4000}
sampling: {n: 20, temperature: 0.7, min_valid: 15, timeout_ms: 8000}
review: {min_top_votes: 12, max_span: 2, family_tier_disagreement: true}
modifier_cap: in_person_today
loss:
  human_review_cost: 0.2
  boundaries:            # adjacent pairs, most acute first; under : over
    - {between: [call_911, ed_now], under: 3, over: 1}
    - {between: [ed_now, in_person_today], under: 20, over: 1}
    - {between: [in_person_today, physician_contact_today], under: 2, over: 1}
    - {between: [physician_contact_today, within_few_days], under: 5, over: 1}
    - {between: [within_few_days, routine], under: 2, over: 1}
    - {between: [routine, self_care], under: 1.5, over: 1}
levels:
  call_911:
    physician_window: "Notified in parallel"
    patient_window: "Ambulance now"
    patient_message: "Call 911 now. Do not drive yourself. A Counsel physician has been notified."
  # ... one entry per level; windows copied from the PRD p. 8 table
red_flags:
  - id: cardiac_chest_pain
    group: adult
    description: "Cardiac-sounding chest pain: pressure, spreading to arm or jaw, sweating"
    min_level: call_911
    subsumes_modifiers: []
    cases: [2]
  - id: suicidal_thoughts
    group: adult
    description: "Suicidal thoughts without a stated plan or intent"
    min_level: physician_contact_today
    cases: [5]
  - id: suicidal_plan_or_intent
    group: adult
    description: "Suicidal thoughts with a plan or intent"
    min_level: call_911
    instruction: "Call 911 or the 988 Suicide & Crisis Lifeline now."
    cases: []
  # ...
modifiers:
  - {id: age_65_plus, group: adult, description: "Age 65 or older"}
  # ... one per modifier on PRD p. 14
```

Copy rules for the remaining entries:
- Rows with a conditional minimum split into two flags, as `suicidal_thoughts` does above. Postpartum harm thoughts (case 39) becomes `postpartum_harm_thoughts` (`physician_contact_today`, `subsumes_modifiers: [postpartum]`) plus `postpartum_psychosis_signs` (confusion, hallucinations or no sleep → `ed_now`).
- Flags that name their condition subsume that modifier: `diabetic_foot_redness` and `hyperglycemia_vomiting` subsume `diabetes`; `anticoagulated_head_injury` subsumes `anticoagulation`; `older_adult_fall_no_weight_bearing` subsumes `age_65_plus`; `infant_fever_under_3_months` subsumes `under_3_months`; pediatric `fever_sickle_or_immunosuppressed` subsumes `sickle_cell` and `immunosuppression`; every obstetric flag subsumes `pregnant` and `postpartum`.
- Obstetric `ed_now` flags at or after 20 weeks carry `instruction: "Go to labour and delivery triage at your hospital now."`; the ingestion flag carries `instruction: "Call Poison Control at 1-800-222-1222 on the way."`
- Add three adult flags that the forced-Call-911 list (PRD p. 15) names but no table row covers: `airway_breathing_compromise`, `altered_consciousness`, `seizure_ongoing`, each `call_911`, `cases: []`.
- Later tests refer to these ids, so use them exactly: `cardiac_chest_pain`, `anaphylaxis`, `fever_neck_stiffness`, `diabetic_foot_redness`, `hyperglycemia_vomiting`, `anticoagulated_head_injury`, `older_adult_fall_no_weight_bearing`, `one_sided_calf_swelling`, `suicidal_thoughts`, `suicidal_plan_or_intent`, `postpartum_harm_thoughts`, `postpartum_psychosis_signs`; modifiers `age_65_plus`, `diabetes`, `anticoagulation`, `immunosuppression`, `under_3_months`, `sickle_cell`, `pregnant`, `postpartum`. Name the rest in the same snake_case style.
- `in_person_today` vs `physician_contact_today` has no ratio in the PRD. Use 2 : 1, which the author confirmed on 2026-11-03.

`cost_fixtures.json`: an array of `{"true": Level, "chosen": Level, "cost": number}`, containing exactly these rows: `call_911/ed_now 3`, `ed_now/in_person_today 20`, `call_911/routine 32`, `routine/call_911 5`, `routine/self_care 1.5`, `self_care/routine 1`, `ed_now/ed_now 0`.

- [ ] **Step 1: Write the failing tests**

```ts
// worker/test/levels.test.ts
it('orders levels by acuity', () => {
  expect(rank('call_911')).toBe(6);
  expect(rank('self_care')).toBe(0);
  expect(maxLevel('routine', 'ed_now')).toBe('ed_now');
});
it.each([
  ['call_911', 'emergency', 'URGENT_ESCALATION'],
  ['physician_contact_today', 'same_day', 'URGENT_ESCALATION'],
  ['within_few_days', 'async', 'ASYNC_PHYSICIAN'],
  ['self_care', 'self_care', 'SELF_CARE'],
])('%s is tier %s, label %s', (l, tier, label) => {
  expect(tierOf(l as Level)).toBe(tier);
  expect(briefLabelOf(l as Level)).toBe(label);
});

// worker/test/policy.test.ts
const policy = loadPolicy();
it('has a semver policy_version', () =>
  expect(policy.policy_version).toMatch(/^\d+\.\d+\.\d+$/));
it('has unique red flag ids', () => {
  const ids = policy.red_flags.map(f => f.id);
  expect(new Set(ids).size).toBe(ids.length);
});
it('has one boundary per adjacent level pair, in order', () =>
  expect(policy.loss.boundaries.map(b => b.between)).toEqual(
    LEVELS.slice(0, -1).map((l, i) => [l, LEVELS[i + 1]])));
it('subsumes the postpartum modifier on case-39 harm thoughts', () => {
  const f = policy.red_flags.find(f => f.id === 'postpartum_harm_thoughts')!;
  expect(f.min_level).toBe('physician_contact_today');
  expect(f.subsumes_modifiers).toContain('postpartum');
});
it('only subsumes modifiers that exist', () => {
  const mods = new Set(policy.modifiers.map(m => m.id));
  for (const f of policy.red_flags)
    for (const m of f.subsumes_modifiers) expect(mods).toContain(m);
});
it('rejects a flag with an unknown min_level', () =>
  expect(() => PolicySchema.parse({...policy, red_flags: [
    {...policy.red_flags[0], min_level: 'urgent'}]})).toThrow());
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npm install && npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `levels.ts`, `policy.ts`, `build-policy.mjs` and write `policy.yaml`, `cost_fixtures.json`**

`build-policy.mjs` parses the YAML with `yaml` and writes `src/generated/policy.json`; wire it as `prebuild`, `pretest` and `predeploy` npm scripts. `subsumes_modifiers` defaults to `[]` and `instruction` is optional in `PolicySchema`. npm scripts: `test` (vitest run), `lint` (gts lint), `typecheck` (tsc --noEmit).

- [ ] **Step 4: Run tests and lint to verify they pass**

Run: `cd worker && npm test && npm run lint && npm run typecheck`
Expected: all PASS, no lint errors.

- [ ] **Step 5: Add CI**

`.github/workflows/ci.yml` runs on push and PR, with two jobs: `worker` (Node 22: `npm ci`, `lint`, `typecheck`, `test`) and `eval` (added in Task 8; leave a commented placeholder).

- [ ] **Step 6: Commit, open issue and PR, stop for the author's review of `policy.yaml`**

```bash
git add .gitignore policy/ worker/ .github/
git commit -m "Add policy.yaml, level helpers and CI"
```

---

### Task 2: Output schemas (PRD T2)

**Files:**
- Create: `worker/src/schema.ts`, `worker/scripts/export-schema.ts`, `schema/route-result.schema.json` (generated, committed)
- Test: `worker/test/schema.test.ts`

**Interfaces:**
- Consumes: `LEVELS`, `Policy` (Task 1)
- Produces:
  - `ReasonCode = 'too_long'|'non_english'|'out_of_scope'|'extraction_failed'|'sampling_failed'|'schema_invalid'|'split_vote'|'wide_spread'|'family_disagreement'|'unverified_excerpt'|'missing_info'|'photo_needed'`
  - `extractionSchema(policy: Policy)`: a Zod object `{language: string, is_care_request: boolean, red_flags: {<every flag id>: {state: 'present'|'absent'|'unknown', excerpt: string|null}}, modifiers: {<every modifier id>: {present: boolean, excerpt: string|null}}, questions: string[] (max 3), photo_needed: boolean, time_sensitive: boolean}`, with every key required, so structured outputs force one entry per flag
  - `type Extraction`
  - `SampleSchema`: `{disposition: Level, justification: string, safety_net: string}`; `type Sample`
  - `RouteResultSchema`, `type RouteResult`:
    `{status: 'routed'|'needs_info'|'human_review', disposition: Level|null, tier: Tier|null, brief_label: BriefLabel|null, floor: Level|null, red_flags: {id, state, excerpt, excerpt_verified}[], modifiers: {id, excerpt}[], votes: {primary: Record<Level, number>, secondary: Record<Level, number>|null}, confidence: number|null, human_review: {flagged: boolean, reasons: ReasonCode[]}, info_requests: {questions: string[], photo: boolean}, time_sensitive: boolean, justification: string, safety_net: string, patient_message: string, trace: {input_sha256, policy_version, models: {model, provider}[], latency_ms, raw: unknown}}`
  - Safety invariants (superRefine): `disposition` is never below `floor` when both are set; `status === 'human_review'` or `human_review.flagged` implies flagged with at least one reason code
  - `schema/route-result.schema.json` = `z.toJSONSchema(RouteResultSchema)`

- [ ] **Step 1: Write the failing tests**

```ts
it('requires every policy flag in an extraction', () => {
  const s = extractionSchema(policy);
  const ok = fakeExtraction(policy);            // test helper: all absent
  expect(s.safeParse(ok).success).toBe(true);
  const {[policy.red_flags[0].id]: _, ...rest} = ok.red_flags;
  expect(s.safeParse({...ok, red_flags: rest}).success).toBe(false);
});
it('requires null disposition to pair with human_review', () =>
  expect(RouteResultSchema.safeParse(
    {...validResult, status: 'routed', disposition: null}).success).toBe(false));
it('exported JSON schema is up to date', () =>
  expect(readJson('../schema/route-result.schema.json'))
    .toEqual(z.toJSONSchema(RouteResultSchema)));
```

`fakeExtraction` and `validResult` go in `worker/test/fixtures.ts` for reuse by later tasks.

- [ ] **Step 2: Run to verify fail** — `npm test -- schema`, FAIL.
- [ ] **Step 3: Implement `schema.ts` and `export-schema.ts`** (script: `npm run export-schema`).
- [ ] **Step 4: Run to verify pass** — `npm run export-schema && npm test`, PASS.
- [ ] **Step 5: Commit, open PR, and stop for the author's review of the schema.**

---

### Task 3: Rule floor (PRD T4)

**Files:**
- Create: `worker/src/floor.ts`
- Test: `worker/test/floor.test.ts`

**Interfaces:**
- Consumes: `Policy`, `Extraction`, `rank`, `levelAtRank`, `maxLevel`
- Produces:
  - `verifyExcerpt(message: string, excerpt: string): boolean`: true when `excerpt` is a substring of `message` after normalising both (lowercase; curly quotes and apostrophes → straight; runs of whitespace → one space; trim)
  - `ruleFloor(ex: Extraction, message: string, policy: Policy): FloorResult`, where `FloorResult = {floor: Level, drivers: string[], modifier_applied: string|null, unverified: string[]}`

Algorithm: `floor` = the highest `min_level` among flags whose `state` is `present`, or `self_care` if none. Present modifiers that a present flag doesn't subsume raise `floor` by exactly one level in total when `rank(floor) < rank(policy.modifier_cap)`. `drivers` lists the present flag ids. `unverified` lists present flags whose excerpt fails `verifyExcerpt` or is null. An unverified flag **still counts** toward the floor. `unknown` and `absent` flags never affect the floor.

- [ ] **Step 1: Write the failing tests**

```ts
const ex = (flags: Record<string, 'present'|'unknown'>, mods: string[] = []) =>
  withFlags(fakeExtraction(policy), flags, mods, MSG);   // fixtures helper
const MSG = 'Refill please. Also my chest feels tight, like pressure going into my left arm.';

it('defaults to self_care with no flags', () =>
  expect(ruleFloor(ex({}), MSG, policy).floor).toBe('self_care'));
it('takes the highest present minimum', () =>
  expect(ruleFloor(ex({cardiac_chest_pain: 'present', diabetic_foot_redness: 'present'}), MSG, policy).floor).toBe('call_911'));
it('ignores unknown flags', () =>
  expect(ruleFloor(ex({cardiac_chest_pain: 'unknown'}), MSG, policy).floor).toBe('self_care'));
it('raises one level in total for several modifiers', () =>
  expect(ruleFloor(ex({}, ['age_65_plus', 'diabetes', 'anticoagulation']), MSG, policy).floor).toBe('routine'));
it('never lets a modifier pass in_person_today', () => {
  expect(ruleFloor(ex({one_sided_calf_swelling: 'present'}, ['age_65_plus']), MSG, policy).floor).toBe('in_person_today');
  expect(ruleFloor(ex({older_adult_fall_no_weight_bearing: 'present'}, ['age_65_plus']), MSG, policy).floor).toBe('ed_now');
});
it('does not double count a subsumed modifier (case 39)', () =>
  expect(ruleFloor(ex({postpartum_harm_thoughts: 'present'}, ['postpartum']), MSG, policy).floor).toBe('physician_contact_today'));
it('raises physician_contact_today to in_person_today with an unsubsumed modifier', () =>
  expect(ruleFloor(ex({suicidal_thoughts: 'present'}, ['age_65_plus']), MSG, policy).floor).toBe('in_person_today'));
it.each([
  ['my chest feels tight', true],
  ['My  chest feels\ntight', true],
  ['chest feels “tight”', false],     // quotes not in source
  ['my chest hurts', false],          // paraphrase
])('verifyExcerpt(%j) is %s', (e, ok) => expect(verifyExcerpt(MSG, e)).toBe(ok));
it('verifies curly-apostrophe excerpts against straight source', () =>
  expect(verifyExcerpt("I can't breathe", 'I can’t breathe')).toBe(true));
it('keeps an unverified present flag in the floor', () => {
  const r = ruleFloor(withExcerpt(ex({cardiac_chest_pain: 'present'}), 'cardiac_chest_pain', 'chest agony'), MSG, policy);
  expect(r.floor).toBe('call_911');
  expect(r.unverified).toEqual(['cardiac_chest_pain']);
});
```

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass** (`npm test -- floor`).
- [ ] **Step 5: Commit** — `Add rule floor with verbatim excerpt check`.

---

### Task 4: Expected-cost router and review flags (PRD T9)

**Files:**
- Create: `worker/src/router.ts`
- Test: `worker/test/router.test.ts`

**Interfaces:**
- Consumes: `Policy`, `LEVELS`, `rank`, `tierOf`
- Produces:
  - `type Votes = Record<Level, number>`; `emptyVotes(): Votes`
  - `cost(trueLevel: Level, chosen: Level, policy: Policy): number`: if `chosen` is under, the sum of `under` across crossed boundaries; if over, the sum of `over`; otherwise 0
  - `expectedCost(votes: Votes, chosen: Level, policy: Policy): number`: Σ (votes[t] / total) · cost(t, chosen)
  - `chooseLevel(votes: Votes, floor: Level, policy: Policy): Level`: the minimum expected cost over levels with `rank ≥ rank(floor)`; ties within 1e-9 go to the **more acute** level
  - `reviewReasons(primary: Votes, secondary: Votes|null, policy: Policy): ReasonCode[]`: `split_vote` if the top count < `min_top_votes`; `wide_spread` if `rank(max voted) − rank(min voted) > max_span`; `family_disagreement` if `secondary` is non-null and the two modal tiers differ (ties in the mode resolve to the more acute level)

- [ ] **Step 1: Write the failing tests**

```ts
const fixtures = readJson('../policy/cost_fixtures.json');
it.each(fixtures)('cost($true, $chosen) = $cost', f =>
  expect(cost(f.true, f.chosen, policy)).toBeCloseTo(f.cost));

it.each([
  ['call_911', 'ed_now', 5],
  ['ed_now', 'in_person_today', 1],
  ['in_person_today', 'physician_contact_today', 7],
  ['physician_contact_today', 'within_few_days', 4],
  ['within_few_days', 'routine', 7],
  ['routine', 'self_care', 8],
])('%s over %s needs %i of 20 votes', (hi, lo, k) => {
  expect(chooseLevel(v({[hi]: k, [lo]: 20 - k}), 'self_care', policy)).toBe(hi);
  expect(chooseLevel(v({[hi]: k - 1, [lo]: 21 - k}), 'self_care', policy)).toBe(lo);
});
it('never chooses below the floor', () =>
  expect(chooseLevel(v({routine: 20}), 'ed_now', policy)).toBe('ed_now'));
it('flags split, spread and family disagreement', () => {
  expect(reviewReasons(v({routine: 11, within_few_days: 9}), null, policy)).toEqual(['split_vote']);
  expect(reviewReasons(v({routine: 19, in_person_today: 1}), null, policy)).toEqual(['wide_spread']);
  expect(reviewReasons(v({routine: 20}), v({in_person_today: 20}), policy)).toEqual(['family_disagreement']);
  expect(reviewReasons(v({routine: 12, within_few_days: 8}), v({within_few_days: 20}), policy)).toEqual([]);
});
```

The rows for `call_911/ed_now` (5 votes) and `in_person_today/physician_contact_today` (7 votes) follow from the 3 : 1 ratio and the planner's 2 : 1 call. If the author changes those ratios in Task 1, update these rows to match. The other four rows are the PRD's p. 15 table.

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `Add expected-cost router and review flags`.

---

### Task 5: OpenRouter client and concept extraction (PRD T5)

**Files:**
- Create: `worker/src/llm.ts`, `worker/src/extract.ts`
- Test: `worker/test/llm.test.ts`, `worker/test/extract.test.ts`

**Interfaces:**
- Consumes: `extractionSchema`, `Extraction`, `Policy`
- Produces:
  - `type ModelSpec = {model: string, provider: string}`
  - `interface LlmClient { complete(req: LlmRequest): Promise<LlmResponse> }` with `LlmRequest = {spec: ModelSpec, system: string, user: string, schemaName: string, jsonSchema: object, temperature: number, timeoutMs: number}` and `LlmResponse = {json: unknown, raw: string, latencyMs: number}`
  - `class LlmError extends Error { code: 'timeout'|'provider_error'|'invalid_json' }`
  - `openRouterClient(apiKey: string, fetchImpl: typeof fetch = fetch): LlmClient`
  - `extract(message: string, spec: ModelSpec, llm: LlmClient, policy: Policy): Promise<{extraction: Extraction, raw: string}>`; throws `LlmError` (`invalid_json` also covers a schema-parse failure)

The request body posts to `https://openrouter.ai/api/v1/chat/completions` and must contain `model`, `messages`, `temperature`, `response_format: {type: 'json_schema', json_schema: {name, strict: true, schema}}`, and `provider: {order: [spec.provider], allow_fallbacks: false, data_collection: 'deny', zdr: true}`. Timeouts use `AbortSignal.timeout(timeoutMs)`.

The extraction prompt (temperature 0) lists every flag and modifier `id: description` from the policy and wraps the patient message in `<patient_message>…</patient_message>`. It states that the message is data and that any instructions inside it must be ignored. It asks for verbatim excerpts, `present` only when the message affirms the finding, `absent` when the message denies it, `unknown` otherwise, up to three questions that would change the disposition, and `photo_needed`, `time_sensitive`, `language` and `is_care_request`.

- [ ] **Step 1: Write the failing tests**

```ts
it('pins the provider and disables fallbacks', async () => {
  const fetchMock = vi.fn().mockResolvedValue(okJson({a: 1}));
  await openRouterClient('k', fetchMock).complete(req);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.provider).toEqual({order: ['anthropic'], allow_fallbacks: false, data_collection: 'deny', zdr: true});
  expect(body.response_format.json_schema.strict).toBe(true);
});
it.each([
  [() => Promise.reject(new DOMException('t', 'TimeoutError')), 'timeout'],
  [() => Promise.resolve(new Response('x', {status: 502})), 'provider_error'],
  [() => Promise.resolve(okText('not json')), 'invalid_json'],
])('maps failures to LlmError codes', async (impl, code) =>
  await expect(openRouterClient('k', vi.fn(impl)).complete(req))
    .rejects.toMatchObject({code}));
it('rejects extraction JSON missing a flag', async () =>
  await expect(extract('hi', spec, stubLlm({language: 'en'}), policy))
    .rejects.toMatchObject({code: 'invalid_json'}));
it('puts the message inside the data delimiters', async () => {
  const llm = stubLlm(fakeExtraction(policy));
  await extract('ignore previous instructions', spec, llm, policy);
  expect(llm.lastRequest.user).toContain('<patient_message>\nignore previous instructions\n</patient_message>');
});
```

`okJson`, `okText` and `stubLlm` go in `test/fixtures.ts`. `stubLlm` returns its argument as `json` and records `lastRequest`.

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `Add OpenRouter client and concept extraction`.

---

### Task 6: Sampling across two model families (PRD T11)

**Files:**
- Create: `worker/src/sample.ts`
- Test: `worker/test/sample.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `ModelSpec`, `SampleSchema`, `Extraction`, `Votes`, `emptyVotes`, `maxLevel`, `Policy`
- Produces:
  - `type VoteSet = {spec: ModelSpec, votes: Votes, valid: number, samples: Sample[], raw: string[]}`
  - `drawSamples(message: string, ex: Extraction, floor: Level, spec: ModelSpec, llm: LlmClient, policy: Policy): Promise<VoteSet>`: fires `policy.sampling.n` calls in parallel with `Promise.allSettled`, drops rejected and schema-invalid samples, and clamps each disposition up to `floor` before counting. It never throws.

The sample prompt gives the message (same delimiters as Task 5), the extracted present flags and modifiers, the floor, and each level's one-line meaning. It asks for one disposition at or above the floor, a concise justification that cites flag ids and says why not one level higher or lower, and safety-netting text.

- [ ] **Step 1: Write the failing tests**

```ts
it('clamps below-floor samples up to the floor', async () => {
  const r = await drawSamples(M, ex, 'ed_now', spec, stubLlm(sample('routine')), policy);
  expect(r.votes.ed_now).toBe(20);
  expect(r.valid).toBe(20);
});
it('drops failed and invalid samples', async () => {
  const llm = flakyLlm({fail: 3, invalid: 2, ok: sample('routine')}); // 3 throw, 2 bad JSON
  const r = await drawSamples(M, ex, 'self_care', spec, llm, policy);
  expect(r.valid).toBe(15);
  expect(r.votes.routine).toBe(15);
});
it('makes exactly n calls in parallel', async () => {
  const llm = stubLlm(sample('routine'));
  await drawSamples(M, ex, 'self_care', spec, llm, policy);
  expect(llm.calls).toBe(20);
  expect(llm.maxConcurrent).toBe(20);
});
```

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `Add parallel sampling with floor clamp`.

---

### Task 7: Pipeline and Worker API

**Files:**
- Create: `worker/src/pipeline.ts`, `worker/src/log.ts`, `worker/src/index.ts`, `worker/wrangler.toml`
- Test: `worker/test/pipeline.test.ts`, `worker/test/api.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces:
  - `type Deps = {llm: LlmClient, policy: Policy, primary: ModelSpec, secondary: ModelSpec|null, log: (line: string) => void}`
  - `type EarlyEvent = {event: 'early', floor: Level, patient_message: string}`
  - `route(message: string, deps: Deps, opts?: {mode?: 'full'|'floor_only', onEarly?: (e: EarlyEvent) => void}): Promise<RouteResult>`: never throws
  - `traceLine(result: RouteResult): string` (JSON; no message text)
  - HTTP (Hono, CORS for the Pages origin, `Authorization: Bearer <ACCESS_TOKEN>` on all routes except `GET /v1/schema`):
    - `POST /v1/route` with body `{message: string, mode?: 'full'|'floor_only'}` → `application/x-ndjson`: an optional `EarlyEvent` line, then `{"event":"result","result":RouteResult}`. A non-string or empty message gets 400 `{"error":"message must be non-empty text"}`. A missing or bad token gets 401.
    - `POST /v1/override` with body `{input_sha256, from: Level, to: Level, reason: string (non-empty)}` → 204, and writes a log line with `kind: 'override'`
    - `GET /v1/policy` → `{policy_version, levels, red_flags: {id, description, min_level}[]}`
    - `GET /v1/schema` → `schema/route-result.schema.json`
  - `wrangler.toml` vars: `PRIMARY_MODEL`, `PRIMARY_PROVIDER`, `SECONDARY_MODEL`, `SECONDARY_PROVIDER` (empty means off), `ALLOWED_ORIGIN`. Secrets: `OPENROUTER_API_KEY`, `ACCESS_TOKEN`.

Pipeline steps, in order (PRD p. 5):
1. If the message is longer than `intake.max_chars`, return Human review `too_long` with no disposition and make no LLM call.
2. Run `extract`. On an `LlmError`, return Human review `extraction_failed` with no disposition.
3. Run `ruleFloor`. If `rank(floor) ≥ rank('ed_now')`, call `onEarly` now with the level's `patient_message` plus any present flag's `instruction`.
4. Scope: if `language` isn't `en`, return Human review `non_english`; if `is_care_request` is false, return `out_of_scope`. Either way, carry `disposition = floor` if the floor is Emergency, otherwise null.
5. If `mode === 'floor_only'`, return `routed` with `disposition = floor` and empty votes.
6. Run `drawSamples` for the primary and secondary models in parallel. If primary `valid < sampling.min_valid`, return Human review `sampling_failed` (disposition handled as in step 4).
7. `disposition = chooseLevel(primary.votes, floor)`. Reasons are `reviewReasons(...)`, plus `unverified_excerpt` if `floor.unverified` is non-empty. `status` is `needs_info` (reasons `missing_info` and/or `photo_needed`) when there are questions or `photo_needed`; otherwise `routed`. `confidence` = top vote share.
8. The justification and safety-netting come from the first primary sample whose disposition equals the chosen level. If none matches, use `Rule floor: <driver ids>. No sample proposed this level; routed by expected cost.` `patient_message` = the level template + flag instructions + safety-netting. Validate with `RouteResultSchema`; on failure, return Human review `schema_invalid`, carrying the floor if it is Emergency. Then `deps.log(traceLine(result))`.

- [ ] **Step 1: Write the failing tests**

```ts
// pipeline.test.ts — scripted LLM: first call = extraction, rest = samples
it('buried red flag beats unanimous routine samples', async () => {
  const onEarly = vi.fn();
  const r = await route(REFILL_WITH_CHEST, deps(scripted({flags: {cardiac_chest_pain: 'present'}, samples: 'routine'})), {onEarly});
  expect(r.disposition).toBe('call_911');
  expect(onEarly).toHaveBeenCalledWith(expect.objectContaining({floor: 'call_911'}));
});
it('emits the early event before sampling resolves', async () => {
  const gate = deferred();
  const order: string[] = [];
  const p = route(M, deps(scripted({flags: {fever_neck_stiffness: 'present'}, samplesAwait: gate.promise, onSample: () => order.push('sample')})),
    {onEarly: () => order.push('early')});
  await tick(); expect(order).toEqual(['early']);
  gate.resolve(); await p;
});
it.each([
  ['extraction timeout', scripted({extractError: 'timeout'}), 'extraction_failed', null],
  ['non-English, emergency floor', scripted({language: 'es', flags: {anaphylaxis: 'present'}}), 'non_english', 'call_911'],
  ['not a care request', scripted({care: false}), 'out_of_scope', null],
  ['6 of 20 samples fail', scripted({sampleFailures: 6, samples: 'routine'}), 'sampling_failed', null],
])('%s → human_review', async (_, llm, reason, disp) => {
  const r = await route(M, deps(llm));
  expect(r.status).toBe('human_review');
  expect(r.human_review.reasons).toContain(reason);
  expect(r.disposition).toBe(disp);
});
it('routes on 17 valid samples when 3 fail', async () =>
  expect((await route(M, deps(scripted({sampleFailures: 3, samples: 'routine'})))).disposition).toBe('routine'));
it('too_long makes no LLM call', async () => {
  const llm = scripted({});
  const r = await route('x'.repeat(4001), deps(llm));
  expect(r.human_review.reasons).toEqual(['too_long']);
  expect(llm.calls).toBe(0);
});
it('needs_info carries a provisional disposition', async () => {
  const r = await route(M, deps(scripted({questions: ['Any fever?'], samples: 'in_person_today'})));
  expect(r.status).toBe('needs_info');
  expect(r.disposition).toBe('in_person_today');
});
it('logs no message text on success or failure', async () => {
  for (const llm of [scripted({samples: 'routine'}), scripted({extractError: 'provider_error'})]) {
    const lines: string[] = [];
    await route(SECRET_MSG, {...deps(llm), log: l => lines.push(l)});
    expect(lines.join()).not.toContain(SECRET_MSG);
    expect(JSON.parse(lines[0]).trace.input_sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

// api.test.ts — app.request() with a stub env and an injected stub LLM
it('rejects empty messages with 400', ...);       // body {message: ''} → 400 + error text
it('requires a bearer token', ...);               // no header → 401
it('streams early then result as NDJSON', ...);   // two lines, events 'early' then 'result'
it('logs overrides without client IP', ...);      // send cf-connecting-ip; log line lacks it
```

Spell out the four `api.test.ts` cases in full, following the comments. Expose an `appFor(deps)` factory from `index.ts` so tests can inject the LLM.

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass** (`npm test && npm run lint`).
- [ ] **Step 5: Local smoke test** — `npx wrangler dev`, then `curl -N -H "Authorization: Bearer $TOKEN" -d '{"message":""}' localhost:8787/v1/route` → 400.
- [ ] **Step 6: Commit** — `Add routing pipeline and Worker API`.

---

### Task 8: Eval data loading and scoring (PRD T6)

**Files:**
- Create: `eval/pyproject.toml`, `eval/.pylintrc` (Google's, from `google/styleguide`), `eval/src/counsel_eval/{__init__,levels,data,scoring}.py`, `data/private/reference_labels.csv` (gitignored)
- Modify: `.github/workflows/ci.yml` (add the `eval` job: `uv sync`, `pyink --check`, `pylint`, `pytest`)
- Test: `eval/tests/test_levels.py`, `eval/tests/test_scoring.py`, `eval/tests/test_data.py` (skipped when `data/private/` is absent, so CI stays green)

**Interfaces:**
- Consumes: `policy/policy.yaml`, `policy/cost_fixtures.json`
- Produces:
  - `levels.py`: `LEVELS: tuple[str, ...]`, `rank(level) -> int`, `brief_label(level) -> str`, `tier(level) -> str`
  - `data.py`: `load_cases(path) -> pd.DataFrame` (columns `case_id`, `message`, `historical`), `load_reference(path) -> pd.DataFrame` (columns `case_id`, `level`, `info: bool`, `photo: bool`, `time_sensitive: bool`), `load_policy(path) -> dict`
  - `scoring.py`:
    - `cost(true, chosen, policy) -> float`
    - `received(result: dict) -> str` (`result['disposition'] or 'routine'`)
    - `gate(df) -> dict` with `{n_emergencies, misses, miss_ids, ci_upper}`, where `df` has `case_id`, `reference`, `received`
    - `zero_count_ci(n) -> float` (exact Clopper-Pearson upper bound for 0 of n, 95%)
    - `cost_score(df, policy) -> float` (mean of cost + `human_review_cost` × flagged)
    - `confusion(df, axis: Literal['level','tier','brief']) -> pd.DataFrame`
    - `per_class(df) -> pd.DataFrame` (sensitivity and over-triage rate per level)
    - `abstention(df) -> dict` (`human_review_rate`, `needs_info_rate`)
    - `faithfulness(results) -> float` (share of present-flag excerpts with `excerpt_verified`)
    - `error_stage(row) -> str|None`: `'scope'` if Human review with no disposition; `'emergency_detection'` if the reference is Emergency and `received` is lower; `'emergent_vs_same_day'` if both are in Emergency/Same day with different tiers; `'missing_information'` if the reference has `info` and the result has no questions; `'explanation'` if any excerpt is unverified; else None

`reference_labels.csv` is transcribed by hand from `docs/brief/Labels.txt`: `case_id` as `C01`…`C50` to match the xlsx; `level` from "Your label" (`Routine (admin)` → `routine`); `info` when the label says "+ info"; `photo` when it says "+ photo"; `time_sensitive` true only for C24. Case 16 is `in_person_today`, `info=true` (pediatrics is in scope per the PRD; this overrides the note in Labels.txt).

- [ ] **Step 1: Write the failing tests**

```python
def test_cost_matches_shared_fixtures():
  policy = load_policy(POLICY)
  for f in json.loads(FIXTURES.read_text()):
    assert cost(f["true"], f["chosen"], policy) == pytest.approx(f["cost"])

def test_zero_count_ci_for_14_emergencies():
  assert zero_count_ci(14) == pytest.approx(0.2316, abs=1e-4)

def test_gate_counts_a_miss_below_ed():
  df = pd.DataFrame({"case_id": ["C08", "C02"],
                     "reference": ["ed_now", "call_911"],
                     "received": ["in_person_today", "ed_now"]})
  assert gate(df)["miss_ids"] == ["C08"]

def test_received_treats_bare_human_review_as_routine():
  assert received({"status": "human_review", "disposition": None}) == "routine"

@needs_private_data
def test_reference_label_counts():
  ref = load_reference(REF)
  assert ref.level.value_counts().to_dict() == {
      "call_911": 4, "ed_now": 10, "in_person_today": 8,
      "physician_contact_today": 2, "within_few_days": 7,
      "routine": 14, "self_care": 5}
  assert set(ref[ref.info].case_id) == {"C05", "C12", "C16", "C33", "C44", "C49"}
  assert set(ref[ref.photo].case_id) == {"C11", "C30", "C36"}

@needs_private_data
def test_reference_vs_historical_agreement():
  m = load_cases(XLSX).merge(load_reference(REF), on="case_id")
  brief_rank = {"URGENT_ESCALATION": 2, "ASYNC_PHYSICIAN": 1, "SELF_CARE": 0}
  ours = m.level.map(brief_label).map(brief_rank)
  theirs = m.historical.map(brief_rank)
  assert (ours == theirs).sum() == 38
  assert (ours > theirs).sum() == 9
  assert (ours < theirs).sum() == 3
```

- [ ] **Step 2: Verify fail** — `cd eval && uv run pytest`, FAIL.
- [ ] **Step 3: Implement and transcribe the CSV.**
- [ ] **Step 4: Verify pass** — `uv run pytest && uv run pyink --check src tests && uv run pylint src`, all PASS, with the private-data tests running locally rather than skipped.
- [ ] **Step 5: Commit (not the CSV)** — `Add eval data loading and scoring`.

---

### Task 9: Eval runner, core baselines and report (PRD T6, T10 core)

**Files:**
- Create: `eval/src/counsel_eval/{client,baselines,run}.py`
- Test: `eval/tests/test_client.py`, `eval/tests/test_baselines.py`, `eval/tests/test_run.py`

**Interfaces:**
- Consumes: Task 7 HTTP API; Task 8 scoring
- Produces:
  - `client.py`: `RouteClient(base_url: str, token: str)` with `.route(message: str, mode: str = "full") -> dict`, which reads the NDJSON, returns the `result` object, and validates it against `schema/route-result.schema.json` with `jsonschema` (raising `SchemaMismatch`); `.policy() -> dict`
  - `baselines.py`: `always_escalate(cases) -> list[dict]` (every case `ed_now`), `historical(cases) -> list[dict]` (`URGENT_ESCALATION → ed_now`, `ASYNC_PHYSICIAN → routine`, `SELF_CARE → self_care`: the planner's mapping, stated in the report), `rule_floor(cases, client) -> list[dict]` (endpoint with `mode="floor_only"`, so the floor logic isn't duplicated)
  - `run.py` CLI: `uv run counsel-eval --url URL --systems full,floor,always,historical [--cases all|pcp] [--repeat N]`
    - Before running, asserts `client.policy()["policy_version"]` equals the local `policy.yaml` version
    - Writes every raw result to `data/private/runs/<timestamp>/<system>.jsonl`
    - Writes `reports/<date>-policy-<version>.md` containing, per system: the gate (misses, miss ids, CI upper bound), cost score, the three confusion matrices, per-class sensitivity and over-triage, abstention rates, faithfulness, ROC AUC (scikit-learn, one-vs-rest for Emergency and for Emergency + Same day, scored by vote share), error counts by stage, median and p95 latency, the cost score re-computed with every `under` weight halved and doubled (loss-weight sensitivity, D7; re-scored from saved runs, no new calls), and the historical mapping note. Case ids only: no message text, no excerpts.
    - `--repeat N` runs the chosen cases N times and reports per-case agreement with the modal disposition. Repeatability runs on all 50 cases (the author's call, 2026-11-03; cost isn't a concern for V0). `--cases pcp` (C04, C08, C09, C12, C16, C17, C23, C26, C35, C39) stays available for quick checks.
    - Exits non-zero when the `full` system misses any emergency

- [ ] **Step 1: Write the failing tests** (respx mocks the Worker)

```python
def test_client_returns_result_after_early_event(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(
      200, text=ndjson({"event": "early", "floor": "call_911", "patient_message": "x"},
                       {"event": "result", "result": VALID_RESULT}))
  assert RouteClient(URL, "t").route("m")["disposition"] == VALID_RESULT["disposition"]

def test_client_rejects_schema_mismatch(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(200, text=ndjson({"event": "result", "result": {"status": "routed"}}))
  with pytest.raises(SchemaMismatch):
    RouteClient(URL, "t").route("m")

def test_historical_baseline_mapping():
  out = historical(pd.DataFrame({"case_id": ["C1"], "historical": ["ASYNC_PHYSICIAN"]}))
  assert out[0]["disposition"] == "routine"

def test_report_has_no_message_text(tmp_path, fake_runs):
  path = write_report(fake_runs, tmp_path)
  assert "SECRET MESSAGE" not in path.read_text()

def test_cli_exits_nonzero_on_policy_version_mismatch(...)
def test_cli_exits_nonzero_on_missed_emergency(...)
```

Write the last two in full: a fake client whose `.policy()` returns `0.0.0`, and a fake run where C08 is received as `routine`.

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `Add eval runner, core baselines and report`.

---

### Task 10: Physician and patient views with replay (PRD T8, T13 replay)

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/lib.js`, `web/style.css`, `web/config.js`, `web/demo-messages.json`, `web/replay/manifest.json`, `eval/src/counsel_eval/record_demo.py`, `.github/workflows/pages.yml`
- Test: `web/test/lib.test.mjs` (`node --test`, added to the CI worker job)

**Interfaces:**
- Consumes: the Task 7 API and the `RouteResult` shape
- Produces:
  - `lib.js`: `highlight(message: string, excerpts: string[]) -> {text, mark: boolean}[]` (case- and whitespace-insensitive match, matching `verifyExcerpt`), `parseNdjson(text) -> object[]`, `levelLabel(level) -> string`
  - `demo-messages.json`: 8 synthetic messages written for this repo, one per level plus one non-English. They include the PRD personas (Priya's 6-month-old with fever and fewer wet diapers; Walt, 70, on warfarin, hit his head yesterday, "probably nothing") and one buried-flag refill. Never Counsel's messages.
  - `record_demo.py`: runs each demo message through the live endpoint and saves `web/replay/<id>.json` and `manifest.json`

Page behaviour:
- **Physician view:** pick a demo message or type one, then see the disposition badge, tier, confidence (top vote share), the floor and its driver flags, the message with excerpts highlighted, primary and secondary vote bars, review reasons, info requests, the justification, and override buttons (one per level, plus a required reason field) that POST `/v1/override`.
- **Patient view:** `patient_message` and safety-netting, under a persistent banner: "Synthetic demo. Not medical advice. In an emergency call 911." A Self-care result shows "Draft — awaiting physician sign-off".
- **Visual design:** the author's DebriefMD/WhiteCoat system (screenshots of debriefmd.ca; tokens copied from `~/dev/interview-prototype/frontend/tailwind.tokens.js`), as CSS custom properties in `style.css` with no Tailwind build. It uses the look only, never the DebriefMD or WhiteCoat name or logo.
  - Fonts (Google Fonts): display `"Source Serif 4"` for headings and the disposition name; body `"DM Sans"`; `"JetBrains Mono"` for uppercase, letter-spaced eyebrow labels, flag ids and vote counts.
  - Colors: `--accent #1B6B5A`, `--accent-light #238C74`, `--accent-subtle #E8F5F0`, `--bg #FAFAF8`, `--surface #F5F5F0`, `--border #E8E6E1`, `--muted #6B6560`, `--text #2D2926`, `--error #B91C1C`, `--warning #C4841D`, `--success #2D7A4F`, `--gold-subtle #FBF5E8`, `--gold-text #7F6124`.
  - Tier colors: Emergency `--error`; Same day `--warning` (fills and large type only, never body text, since it is 3.06 : 1); Async `--accent`; Self-care `--muted`.
  - Layout: white cards on `--bg`, 1px `--border`, 12px radius. The physician view is the DebriefMD three-step card stack: `01 PATIENT MESSAGE` (excerpts highlighted in `--accent-subtle`), `02 RED FLAGS FOUND` (green-dot list), `03 DISPOSITION` (label/value rows: tier, confidence, floor, response window; pill tags for review reasons). Down-arrows connect the cards. Primary buttons are solid accent; secondary buttons are white with a border.
  - The synthetic-demo banner uses `--gold-subtle` with `--gold-text`.
- **Replay:** a toggle, switched on automatically when a live call fails, that serves saved runs and labels them "Replay". The access token is typed in and kept in `localStorage`, with reads and writes wrapped in try/catch.

- [ ] **Step 1: Write the failing tests**

```js
test('highlight marks excerpts across whitespace and case', () => {
  const parts = highlight('My chest  feels tight today', ['chest feels tight']);
  assert.deepEqual(parts.filter(p => p.mark).map(p => p.text), ['chest  feels tight']);
});
test('parseNdjson returns events in order', () => {
  assert.deepEqual(parseNdjson('{"event":"early"}\n{"event":"result"}\n').map(e => e.event), ['early', 'result']);
});
```

- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass** (`node --test web/test`).
- [ ] **Step 5: Manual check** — `npx serve web` with replay on: each demo message renders in both views at 375 px and 1280 px, and the banner is always visible.
- [ ] **Step 6: Commit** — `Add physician and patient demo views with replay`.

---

### Task 11: Deploy, record the demo, first live eval

**Files:**
- Modify: `worker/wrangler.toml` (model slugs), `web/config.js` (Worker URL), `web/replay/*`
- Create: `reports/<date>-policy-<version>.md`

- [ ] **Step 1: Pick and verify the models.** Query `https://openrouter.ai/api/v1/models` and the endpoints list for each candidate. The primary is the latest Claude Sonnet; the secondary is a current Gemini or GPT model from a different family. Both need a pinned provider with zero data retention and structured-output support. Record the slugs and providers in `wrangler.toml`.
- [ ] **Step 2: Deploy.** The author sets a credit cap on the OpenRouter key, then: `npx wrangler secret put OPENROUTER_API_KEY`, `npx wrangler secret put ACCESS_TOKEN`, `npx wrangler deploy`. Enable GitHub Pages from Actions. Check: `curl` the deployed `/v1/route` with an empty message → 400; with no token → 401.
- [ ] **Step 3: Record the replays** — `uv run python -m counsel_eval.record_demo --url $URL`. Spot-check that each saved run's disposition is plausible.
- [ ] **Step 4: Run the eval** — `uv run counsel-eval --url $URL --systems full,floor,always,historical`, then `--cases all --repeat 10`.
  Expected: `full` has 0 missed emergencies (exit 0); `historical` shows misses on C08, C17, C23 and C35.
- [ ] **Step 5: If the gate fails,** stop and use superpowers:systematic-debugging. Tag each miss by stage. Any policy or prompt change bumps `policy_version` and is logged in the PR description, because changes tuned on the 50 dev cases have to be disclosed in the deck.
- [ ] **Step 6: Backup video.** The author screen-records the demo against the live Worker (both views, three messages), then repeats one message with the network off to show replay. The file stays out of git.
- [ ] **Step 7: Commit** — `Record demo replays and first eval report` (the report and replays only).

---

### Task 12: README and docs (PRD T15)

**Files:**
- Create: `README.md` (one page), `docs/architecture.md`, `docs/policy.md`, `docs/eval.md`, `docs/decisions.md`, `docs/reliability-roadmap.md`

`reliability-roadmap.md` covers four parts.
- **V0's real single points of failure:** OpenRouter and one pinned provider per family; LLM-dependent emergency detection; synchronous, stateless requests; 41 calls per message.
- **Phase 1, survive outages:** a deterministic last-resort keyword screen, a static channel fallback, gate-validated fallback models switched as versioned policy changes, circuit breakers and hedged sampling.
- **Phase 2, durability:** a queue-based async intake with per-case state, idempotency keys, and durable overrides.
- **Phase 3 and 4, observability and scale:** SLOs (p99 time to emergency instructions, response-window compliance, flag rate), a live emergency canary, CI gate on every policy change, shadow deploys and rollback, and per-request LLM tracing as a later consideration (OpenRouter's trace export to Langfuse, Datadog or LangSmith). V0 skips tracing because it would copy every prompt and response to another vendor, against the zero-data-retention rule; the Worker's trace log covers V0. If adopted, use a self-hosted Langfuse or metadata-only traces. Then adaptive sampling, extraction caching, quotas and back-pressure, and data residency.

- [ ] **Step 1: Write the README.** Cover what it does in two sentences; a pipeline diagram (Mermaid); the headline numbers from the Task 11 report (gate, cost score against each baseline, flag rate); links to the demo and to `/docs`; how to run tests, the eval and the Worker locally; and the data notice (Counsel's cases aren't in the repo, and the demo is synthetic).
- [ ] **Step 2: Write the docs pages.** `decisions.md` summarises D1–D14 in one line each. Then list the V0 calls: confirmed by the author on 2026-11-03 are the 2 : 1 ratio for `in_person_today` vs `physician_contact_today`, the one-level modifier cap, the three added Call 911 flags, and repeatability on all 50 cases. Still open for the author are `min_valid` 15, temperature 0.7, `max_chars` 4000, the historical-baseline mapping, `human_review_cost` 0.2, and unverified excerpts keeping their flag.
- [ ] **Step 3: Verify** — every README link resolves (`npx markdown-link-check README.md`).
- [ ] **Step 4: Commit** — `Add README and design docs`.
