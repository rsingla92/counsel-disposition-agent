# Operations View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Operations view in the demo web app with an experiment log, policy sliders that re-score saved runs, and a model picker. Live routes honour the chosen models and settings.

**Architecture:**
- `POST /v1/route` accepts an optional `overrides` object.
- The Worker builds an effective policy from the loaded one, replacing only allowlisted router fields, and picks models from a fixed three-way choice.
- Re-scoring runs in the Worker over stripped per-case records held in Workers KV. It uses the same decision function the pipeline uses, plus a TypeScript port of the eval's metrics, kept identical to the Python by shared fixtures.
- The web app gains a third view.

**Tech Stack:** Cloudflare Workers, Hono, Zod 4, Vitest (`worker/`); plain ES modules with `node --test` (`web/`); Python 3.11, uv, pytest, respx (`eval/`).

**Spec:** `docs/superpowers/specs/2026-11-04-operations-view-design.md`

## Global Constraints

- **Public repo.** Never commit `docs/brief/`, `data/private/`, Counsel's messages, reference labels, per-case votes, or any excerpt from them. Test fixtures are synthetic.
- **Logs.** They never contain message text or IP addresses.
- **Zero-miss.** No live route may land an emergency lower than the deployed policy would (AGENTS.md rule 1). Red-flag floors, the early event and extraction are never changed by overrides.
- **Failures.** Every failure path ends at Human review or higher (AGENTS.md rule 2).
- **Tests.** Hermetic, with the LLM mocked.
- **Auth.** Every new endpoint needs the `ACCESS_TOKEN` bearer token, like `/v1/route`.
- **Models.** OpenRouter provider stays pinned to `google-vertex`, with no fallbacks; `MAX_IN_FLIGHT` stays 3.
- **No overrides means no change.** A request without `overrides` behaves exactly as today.
- **Web.** No bundler. `localStorage` reads and writes are wrapped in try/catch.
- **Commits** end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01VAufmSxzgofBsWvb4bpXS7`
- **Test commands.**
  - Worker: `npm test` in `worker/`.
  - Eval: `uv run pytest -q` in `eval/`.
  - Web: `node --test ../web/test/*.mjs` from `worker/`.

### Override ranges (pinned here; used by Tasks 1, 4 and 5)

| Field | Policy key | Range | Step |
|---|---|---|---|
| `min_valid` | `sampling.min_valid` | 10 to 20 (never above `sampling.n`) | 1 |
| `min_top_votes` | `review.min_top_votes` | `floor(min_valid / 2) + 1` to 20 | 1 |
| `max_span` | `review.max_span` | 0 to 6 | 1 |
| `human_review_cost` | `loss.human_review_cost` | 0.05 to 2 | 0.05 |
| `under_weights[i]` | `loss.boundaries[i].under`, in policy order | 0.5 to 50 | 0.5 |

- **Live routes.** `under_weights[0]` (`call_911`↔`ed_now`) and `under_weights[1]` (`ed_now`↔`in_person_today`) must be at least the loaded policy's values. A lower value is a 400 with error `emergency_weight_below_policy`.
- **Re-score.** Re-scoring allows the full range.
- **Out of range.** Any field outside its range is a 400, never clamped.
- **Partial overrides.** Every field is optional; omitted fields keep the policy value.

## Review Focus

1. **Stale slider state after a policy change.** If `localStorage` holds overrides from an older policy that now fail validation, the live route must not 400 forever. The web app drops invalid stored overrides on load (Task 5 test).
2. **One-model mode with a failed extraction.** "flash" has no secondary, so a Flash extraction failure must end at Human review `extraction_failed` (Task 1 test).
3. **`min_top_votes` greater than the valid samples.** For example `min_valid` 10 with `min_top_votes` 20 is allowed by the ranges. Every routed case would then flag `split_vote`, which is valid behaviour, but it must not throw (Task 4 test).
4. **A re-score request for an unknown experiment id, or with KV empty.** It returns 404, not 500 (Task 4 test).
5. **A replay viewed while overrides are active.** The replay shows its saved result, and the banner does not claim the replay used the overrides (Task 5 test).

---

### Task 1: Live overrides on `/v1/route`

**Files:**
- Create: `worker/src/overrides.ts`
- Modify: `worker/src/index.ts`, `worker/src/pipeline.ts` (pass overrides into the trace), `worker/src/schema.ts` (trace `overrides`)
- Regenerate: `schema/route-result.schema.json` (`npm run -s export-schema`)
- Test: `worker/test/overrides.test.ts`, `worker/test/api.test.ts`, `worker/test/pipeline.test.ts`

**Interfaces:**
- Produces, in `overrides.ts`:
  - `PolicyOverridesSchema`: a Zod strict object with the five optional fields and ranges above, plus a refinement for the `min_top_votes` lower bound against the effective `min_valid`.
  - `type PolicyOverrides`.
  - `MODEL_CHOICES = ['sonnet', 'flash', 'sonnet+flash'] as const` and `type ModelChoice`.
  - `RouteOverridesSchema = z.strictObject({models: z.enum(MODEL_CHOICES).optional(), policy: PolicyOverridesSchema.optional()})` and `type RouteOverrides`.
  - `applyPolicyOverrides(policy: Policy, o: PolicyOverrides | undefined): Policy`. Returns a deep copy with only those fields replaced. It never touches `red_flags`, `levels`, `sampling.n` or `modifiers`.
  - `checkLiveSafe(policy: Policy, o: PolicyOverrides | undefined): string | null`. Returns `'emergency_weight_below_policy'` or null.
  - `selectModels(choice: ModelChoice | undefined, primary: ModelSpec, secondary: ModelSpec | null): {primary: ModelSpec; secondary: ModelSpec | null}`:
    - `sonnet` gives `{primary, secondary: null}`;
    - `flash` gives `{primary: secondary, secondary: null}`, and throws if `secondary` is null;
    - `sonnet+flash` gives both;
    - undefined gives the env default.
    - Here `primary` is env `PRIMARY_*` (Sonnet) and `secondary` is env `SECONDARY_*` (Flash).
- Produces, on the route result: `trace.overrides: RouteOverrides | null`, optional in the schema so saved results still parse. It holds the object as applied.
- Request body: `RouteBody` gains `overrides: RouteOverridesSchema.optional()`.
  - Validation failure is a 400 `{error: 'overrides invalid'}`.
  - A `checkLiveSafe` failure is a 400 `{error: 'emergency_weight_below_policy'}`.
  - `flash` with no secondary configured is a 503 `{error: 'model not configured'}`.

- [ ] **Step 1: Write failing tests in `worker/test/overrides.test.ts`**
  - `applyPolicyOverrides` with `{min_top_votes: 14}` changes only `review.min_top_votes`. A deep-equal against the loaded policy shows every other key, including `red_flags` and `loss.boundaries[*].over`, unchanged, and the input policy object is not mutated.
  - `under_weights` of length 6 maps in order onto `loss.boundaries[i].under`. A length other than 6 fails `PolicyOverridesSchema`.
  - For each field, the range edges pass and edge ± one step fails. Examples: `min_valid` 9 and 21 fail; `min_top_votes` 7 with `min_valid` 15 fails (lower bound 8) and 8 passes.
  - `checkLiveSafe`:
    - `under_weights[1] = 19` (policy 20) returns `'emergency_weight_below_policy'`;
    - `under_weights[1] = 25` returns null;
    - `under_weights[2] = 0.5` returns null, because only indices 0 and 1 are guarded.
  - `selectModels` covers all four inputs, and `flash` with a null secondary throws.

- [ ] **Step 2: Run them and confirm they fail** (module missing). Command: `npm test -- overrides`.

- [ ] **Step 3: Implement `worker/src/overrides.ts`** to the interfaces above.

- [ ] **Step 4: Write failing API and pipeline tests**
  - `api.test.ts`:
    - a route with `overrides.models = 'sonnet'` makes no secondary calls (count calls by model on the stub LLM) and returns `trace.overrides.models === 'sonnet'`;
    - `'flash'` sends extraction and samples to the Flash spec only;
    - `under_weights[1] = 1` returns 400 `emergency_weight_below_policy` and makes no LLM call;
    - `min_valid: 30` returns 400 `overrides invalid`;
    - no overrides gives `trace.overrides === null` and the same result as before (an existing fixture case).
  - `pipeline.test.ts`:
    - with `secondary: null` and the primary's extraction erroring, the result is `human_review` with `extraction_failed`;
    - with the policy override `min_top_votes: 20` and a 19/1 vote split, the result is flagged `split_vote` (shows the effective policy reaches `reviewReasons`).

- [ ] **Step 5: Run them and confirm they fail.**

- [ ] **Step 6: Wire it up.** In `index.ts`, parse `overrides`, run `checkLiveSafe`, then build per-request `Deps` with `policy: applyPolicyOverrides(...)` and `selectModels(...)`. Pass the overrides to `route` through `RouteOptions.overrides` so `assemble` writes `trace.overrides`. `/v1/policy` keeps serving the loaded policy.

- [ ] **Step 7: Regenerate the JSON schema and run the full Worker suite.** Command: `npm run -s export-schema && npm test`. Expected: all pass.

- [ ] **Step 8: Run the eval suite**, since saved results must still parse. Command: `uv run pytest -q` in `eval/`. Expected: all pass.

- [ ] **Step 9: Commit:** `feat(worker): per-request model choice and router overrides on /v1/route`.

### Task 2: Eval `--models` flag

**Files:**
- Modify: `eval/src/counsel_eval/client.py`, `eval/src/counsel_eval/run.py`
- Test: `eval/tests/test_client.py`, `eval/tests/test_run.py`

**Interfaces:**
- Consumes: Task 1's request field `overrides.models`.
- Produces:
  - `RouteClient.route(message, mode="full", models=None)`. When `models` is given, the body carries `{"overrides": {"models": models}}`.
  - CLI `--models {sonnet,flash,sonnet+flash}`, default none, passed through to every full-system route.
  - Each run entry's `meta` gains `"models"`: the flag value, or `"default"`.
  - The credit estimate uses 21 calls per case when `--models` is `sonnet` or `flash`, unless `--calls-per-case` is given explicitly.

- [ ] **Step 1: Write failing tests**
  - respx asserts the JSON body has `overrides.models == "sonnet"` when passed, and no `overrides` key when not.
  - The CLI with `--models sonnet --skip-credit-check` writes `meta.models == "sonnet"` in `full.jsonl`.
  - `estimate_usd` for `--models flash` uses 21 calls per case.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with the full eval suite.
- [ ] **Step 5: Commit:** `feat(eval): --models runs the agent with one model or both`.

**After Tasks 1 and 2 merge and deploy (controller, not an implementer):**
- Run `counsel-eval --systems full --models sonnet --cases all --concurrency 1` against the deployed Worker, with the credit check on.
- Record the run stamp in the ledger.

### Task 3: TypeScript port of the eval metrics, with parity fixtures

**Files:**
- Create: `worker/src/metrics.ts`, `schema/fixtures/metrics-parity.json` (synthetic)
- Test: `worker/test/metrics.test.ts`, `eval/tests/test_metrics_parity.py`

**Interfaces:**
- Produces, in `metrics.ts`:
  - `type ScoredCase = {reference: Level; disposition: Level | null; status: 'routed' | 'needs_info' | 'human_review'; flagged: boolean}`.
  - `received(c: ScoredCase): Level`, which returns `disposition ?? 'routine'`, matching `scoring.received`.
  - `summarize(cases: ScoredCase[], policy: Policy): Summary`, where
    `Summary = {n: number; emergencies: number; missed: number; human_review_rate: number; needs_info_rate: number; over_triage_rate: number; cost_score: number; confusion: Record<Level, Record<Level | 'human_review', number>>}`.
- Definitions match `eval/src/counsel_eval/scoring.py` exactly:
  - **missed:** reference in `call_911` or `ed_now` and `rank(received) < rank('ed_now')`, as in `gate`;
  - **cost_score:** mean `cost(reference, received)` plus `human_review_cost × mean(flagged)`;
  - **human_review_rate and needs_info_rate:** as in `abstention`;
  - **over_triage_rate:** the share of all cases with `rank(received) > rank(reference)`;
  - **confusion:** reference row by column. The column is `'human_review'` when status is `human_review`, otherwise the disposition.
- The fixture file is `{"policy_loss": <copy of policy.yaml loss block>, "cases": [...ScoredCase], "expected": {...Summary minus confusion}}`, with at least 12 synthetic cases covering every status, a miss, an over-triage and a Human review with null disposition.

- [ ] **Step 1: Write the fixture.** Compute `expected` with the Python functions via a one-off script. The script is not committed; the fixture is.
- [ ] **Step 2: Write `eval/tests/test_metrics_parity.py`.** It loads the fixture, runs `scoring.gate`, `cost_score`, `abstention` and the over-triage computation, and asserts equality with `expected` (tolerance 1e-9). It passes immediately, because it pins Python as the source of truth.
- [ ] **Step 3: Write `worker/test/metrics.test.ts`.** It loads the same fixture and asserts `summarize` matches `expected` (`toBeCloseTo`, 9 digits), and checks one hand-computed confusion cell.
- [ ] **Step 4: Run it and confirm it fails** (module missing).
- [ ] **Step 5: Implement `metrics.ts`**, reusing `cost` from `router.ts`.
- [ ] **Step 6: Run both suites and confirm they pass.**
- [ ] **Step 7: Commit:** `feat(worker): eval metrics in TypeScript, pinned to the Python by shared fixtures`.

### Task 4: Shared decision function, re-scoring, experiment endpoints, export script

**Files:**
- Create: `worker/src/decide.ts`, `worker/src/rescore.ts`, `eval/src/counsel_eval/export_experiment.py`
- Modify: `worker/src/pipeline.ts` (step 7 calls `decide`), `worker/src/index.ts` (endpoints, KV binding type), `worker/wrangler.toml` (`[[kv_namespaces]] binding = "EXPERIMENTS"`; the id is filled in by the controller in Task 6)
- Test: `worker/test/decide.test.ts`, `worker/test/rescore.test.ts`, `worker/test/api.test.ts`, `eval/tests/test_export_experiment.py`

**Interfaces:**
- Produces, in `decide.ts`:
  - `decide(input: {primary: Votes; primaryValid: number; secondary: Votes | null; secondaryValid: number | null; floor: Level; questions: number; photo: boolean; baseReasons: ReasonCode[]}, policy: Policy): {status: 'routed' | 'needs_info' | 'human_review'; disposition: Level | null; reasons: ReasonCode[]; flagged: boolean}`.
  - This is pipeline steps 6 to 7 moved verbatim:
    - the `min_valid` check, giving `sampling_failed`;
    - `chooseLevel`;
    - the `secondary_unavailable` cross-check;
    - `reviewReasons`;
    - `missing_info` and `photo_needed`;
    - the needs-info status.
  - `baseReasons` are reasons the pipeline added before step 6 (for example `unverified_excerpt`). `pipeline.ts` must call it, so live routing and re-scoring share one implementation.
- Produces, in `rescore.ts`:
  - `type ExperimentRecord = {case_id: string; reference: Level; fixed: null | {status: 'human_review'; disposition: Level | null; reasons: ReasonCode[]}; floor: Level; primary: Votes; secondary: Votes | null; questions: number; photo: boolean; base_reasons: ReasonCode[]; latency_ms: number}`.
  - `type Experiment = {id: string; label: string; models: string; rescorable: boolean; records: ExperimentRecord[]; summary: Summary; median_latency_ms: number}`.
  - `rescore(exp: Experiment, policy: Policy): Summary`.
  - A record with `fixed` set keeps its saved outcome, except when `fixed.reasons` is exactly `['sampling_failed']` and the primary's vote total reaches the effective `min_valid`. That record then goes through `decide`.
- Endpoints, both token-gated:
  - `GET /v1/experiments` returns `{experiments: [{id, label, models, rescorable, summary, median_latency_ms}]}` from KV key `experiments:index` plus `experiment:<id>`.
  - `POST /v1/experiments/:id/rescore` takes body `{policy: PolicyOverrides}` (full range, no `checkLiveSafe`) and returns `{summary: Summary, policy_applied: PolicyOverrides}`.
    - An unknown id, or empty KV, is a 404.
    - `rescorable: false` is a 409.
    - Invalid overrides are a 400.
- Produces `export_experiment.py`:
  - `python -m counsel_eval.export_experiment --run <stamp> --system full|floor --id <id> --label <text> --out <path outside repo>`.
  - It writes one `Experiment` JSON. It refuses an `--out` inside the repo root (exit 2).
  - `fixed` is set when the saved status is `human_review` and the saved votes are empty or the reasons include `extraction_failed`, `sampling_failed`, `too_long`, `non_english`, `out_of_scope` or `schema_invalid`.
  - `base_reasons` are the saved reasons minus `split_vote`, `wide_spread`, `family_disagreement`, `secondary_unavailable`, `missing_info`, `photo_needed` and `sampling_failed`.
  - `questions` is `len(result.info_requests.questions)`. `photo` is `result.info_requests.photo`.
  - The floor system exports with `rescorable: false`.
  - `summary` is computed by the eval's own scoring.
  - No message text, justification, excerpt, raw output or patient reply is written. A test asserts that the output's set of keys equals the allowed set.

- [ ] **Step 1: Write failing `decide.test.ts`.** Cover each branch above with synthetic votes:
  - fewer than `min_valid` gives `sampling_failed`;
  - a split vote;
  - a wide span;
  - family disagreement;
  - a failed secondary;
  - questions give needs-info;
  - `min_valid` 10 with `min_top_votes` 20 does not throw (Review Focus 3).
- [ ] **Step 2: Run it and confirm it fails. Move steps 6 to 7 from `pipeline.ts` into `decide.ts` and call it.** The whole existing `pipeline.test.ts` must pass unchanged. That is the refactor's proof.
- [ ] **Step 3: Write failing `rescore.test.ts`** on a synthetic experiment of 6 records:
  - with no overrides, `rescore` equals the stored summary;
  - raising `min_top_votes` raises `human_review_rate`;
  - a `fixed` `extraction_failed` record never changes;
  - a `fixed` `sampling_failed` record with 12 primary votes is re-routed when `min_valid` is 12;
  - lowering `under_weights[1]` to 0.5 on a record with reference `ed_now`, votes `ed_now` 8 and `in_person_today` 12, and floor `self_care` raises `missed` from 0 to 1. This is the what-if case the spec allows in re-scoring only.
- [ ] **Step 4: Implement `rescore.ts`. Write failing API tests, then add the endpoints.**
  - The tests use a Map-backed fake `KVNamespace` in the test env.
  - They cover 200, 404 (unknown id), 404 (empty KV), 409 (floor), 400 (bad overrides) and 401 (no token).
- [ ] **Step 5: Write failing `test_export_experiment.py`** on a synthetic run dir in `tmp_path`:
  - the key-set assertion;
  - `fixed` and `base_reasons` derivation;
  - refusal of an `--out` inside the repo;
  - floor gives `rescorable: false`.
- [ ] **Step 6: Implement it.**
- [ ] **Step 7: Run all three suites and confirm they pass.**
- [ ] **Step 8: Commit,** in two commits:
  - `refactor(worker): one decide() for live routing and re-scoring`;
  - `feat: experiment log and re-score endpoints, export script`.

### Task 5: The Operations view

**Files:**
- Create: `web/ops.js` (view rendering and state), `web/test/ops.test.mjs`
- Modify: `web/index.html` (third view button `#view-ops` and container), `web/app.js` (view switch; send `overrides` on live routes; banner), `web/lib.js` (pure helpers below), `web/style.css`

**Interfaces:**
- Consumes: Task 1's `overrides` request field and its error codes; Task 4's endpoints and the `Summary` shape; `GET /v1/policy` for defaults. `/v1/policy` must also return `sampling.min_valid`, `review` and `loss`. Add those fields to its response, with a Worker test, if they are missing.
- Produces, in `lib.js` (pure, tested with `node --test`):
  - `overridesFromControls(controls, policy) -> object | null`: only fields that differ from the policy; null when nothing differs.
  - `validStoredOverrides(stored, policy) -> object | null`: drops a stored object that fails the ranges table. This answers Review Focus 1.
  - `bannerText(overrides) -> string | null`, for example `"Routing with: Sonnet only · agreement 14/20"`; null when there are no overrides.
  - `isWhatIf(overrides, policy) -> boolean`: true when `under_weights[0]` or `under_weights[1]` is below the policy value.
  - `delta(now, base, kind) -> string`, formatting for example `"12% → 18%"` and `"0.80 → 0.86"`.
- Behaviour:
  - **Experiment log.** A table with label, missed of 14, Human review %, cost, and median seconds. Rows are clickable and keyboard-selectable. The floor row shows "not re-scorable" and disables the sliders.
  - **Controls.** A model picker (three options plus "Policy default"), sliders per the ranges table, and "Reset to policy". Re-score fires 250 ms after the last slider change.
  - **What-if zone.** When `isWhatIf` is true:
    - a warning icon plus the text "What-if only: live messages use the policy value for emergency weights";
    - the missed count is shown with a warning icon and label, not color alone.
  - **Live routes.** They send `overrides` with every emergency weight raised to at least the policy value, so a what-if setting never 400s a live route.
  - **Metrics and grid.** Metrics with deltas against the deployed policy. A confusion grid of 7 rows by 8 columns, with a "Show as table" fallback.
  - **Banner.** It shows on the physician and patient views whenever `bannerText` is non-null, except on a replay, which shows "Replay: saved result" instead (Review Focus 5).
  - **Persistence.** Chosen settings persist in `localStorage` (try/catch) and are read back through `validStoredOverrides`.

- [ ] **Step 1: Write failing `web/test/ops.test.mjs`** for each `lib.js` helper. Cases:
  - unchanged controls give null;
  - a stored object with `min_valid: 30` gives null;
  - the banner text for each model choice;
  - `isWhatIf` true at `under_weights[1] = 10` and false at 25;
  - the live clamp raises a what-if `under_weights[1]` of 10 to 20.
- [ ] **Step 2: Run it and confirm it fails. Implement the helpers. Run it and confirm it passes.**
- [ ] **Step 3: Build the view and wiring** in `ops.js`, `app.js`, `index.html` and `style.css`. Follow the dataviz skill for the grid: sequential single-hue cells, a table fallback, and text in text tokens.
- [ ] **Step 4: Run the web, Worker and eval suites.**
- [ ] **Step 5: Check it in a browser** with the gstack `browse` skill against a local `wrangler dev` with a seeded fake KV. Screenshot at 820 px wide and at 390 px (phone) and confirm no horizontal scroll.
- [ ] **Step 6: Commit:** `feat(web): Operations view with experiment log, sliders and model picker`.

### Task 6: Seed, deploy, rehearse (controller)

No implementer. These are outward-facing steps, and the controller runs them.

- [ ] **Create the KV namespace:** `npx wrangler kv namespace create EXPERIMENTS`. Put its id in `worker/wrangler.toml`. Commit only the id; it is not a secret.
- [ ] **Export each experiment** to the scratchpad (outside the repo) with `export_experiment.py`:
  - run 1 (`20261104T065900Z`): "Sonnet + Flash, 6 in flight";
  - run 2 (`20261104T155545Z`): "Sonnet + Flash, 3 in flight, fallback";
  - the floor rerun (`20261104T234354Z --system floor`): "Rule floor only";
  - the Sonnet-only run: "Sonnet only, 3 in flight".
  - Upload each with `wrangler kv key put --remote`, then write `experiments:index`.
- [ ] **Deploy the Worker and the web Worker.**
- [ ] **Smoke test:**
  - `GET /v1/experiments` lists 4 rows;
  - re-scoring run 2 with no overrides matches the report (0 of 14 missed, 12% Human review, cost 0.80);
  - one live route with `models: sonnet` shows the banner and `trace.overrides`.
- [ ] **Add a deletion step** to `docs/decisions.md` (Task 12 docs) and to the ledger: after 2026-11-12, run `wrangler kv namespace delete` for EXPERIMENTS.
