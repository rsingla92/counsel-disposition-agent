# Five Votes Per Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route with 5 votes per model instead of 20, so 5 people can use the live demo at once without Vertex per-minute rate limits, and show the vote-count stability curve that justifies it.

**Architecture:** Policy 0.3.0 sets `sampling.n` 5, `min_valid` 4 and `min_top_votes` 3. Thresholds stay counts in units of the policy's `n`. Re-scoring a saved run made with more votes scales the count thresholds to that run's votes per model, rounding up. A new pure module subsamples saved votes to measure routing stability for any k, with a CLI that writes an aggregate report.

**Tech Stack:** TypeScript (Cloudflare Worker, vitest, tsx), plain JS web (node --test), Python eval (pytest, uv).

**Spec:** No written spec. The design comes from the user's 2026-11-06 instructions in session: "For the live demo, cut down the number of calls/votes to say 5", "show a certain cutoff for number of calls needed for stability from 5-20", "Compute the stability curve, pick the smallest number of votes and policy change. I expect 5 people in the room. Make reasonable assumptions for the rest." Decisions below are the planner's calls.

## Evidence (2026-11-06)

- Policy 0.2.0 evals: Sonnet + Flash 96% Human review, Sonnet only 96%, Flash only 92%, 0 of 14 emergencies missed in each. The Worker log shows every lost sample is an HTTP 429 that outlasted 4 retries. The cause is the per-minute provider limit under back-to-back cases.
- Saved 20-vote runs: Sonnet unanimous on 192 of 195 cases, Flash on about 90%. Subsampling to 3 to 20 votes changes no emergency outcome and agrees with the 20-vote route on 99.5 to 100% of cases.

## Decisions (planner's calls)

| Decision | Choice | Why |
|---|---|---|
| Votes per model | 5 | Smallest k where a split is still meaningful (3 of 5 must agree); 3 votes reduces a split to 2 against 1 |
| `min_valid` | 4 of 5 | One lost sample tolerated, as 15 of 20 tolerated five |
| `min_top_votes` | 3 of 5 | A simple majority, as 12 of 20 was 60% |
| Saved 20-vote runs | Re-scored with thresholds scaled to the run's votes per model, rounding up: `ceil(x * n_run / n_policy)` | Experiment log rows stay comparable; rounding up never loosens a check |
| Override ranges | Schema `min_valid` and `min_top_votes` 1 to 20; a live route also rejects either above `sampling.n` | The schema stands alone for saved traces; above `n`, every route would be Human review |
| Override units | Counts in the current policy's `n`; the web sliders run 1 to `n` | One scale everywhere; re-scoring scales them with the policy |
| Eval credit estimate | `2n+1` calls (two models) or `n+1` (one), from the policy | Was hardcoded 41 and 21 |

## Global Constraints

- AGENTS.md review order holds: zero-miss gate; every failure path at Human review or higher; a present red flag always sets its floor; excerpts verbatim; no Counsel data, message text or secrets in the repo; hermetic tests.
- Reports and docs hold aggregate numbers only, no case ids.
- `docs/policy.md` and `policy/policy.yaml` agree; bump `policy_version` to 0.3.0.
- Commits end with the session's Co-Authored-By and Claude-Session lines.

## Review Focus

1. A KV experiment saved with 20 votes, re-scored under the 5-vote policy, must use 16 and 12, not 4 and 3. Test in Task 1.
2. Overrides a browser stored under 0.2.0 (`min_valid` 15) must be dropped, not sent forever and rejected. Test in Task 4.
3. A live override with `min_valid` or `min_top_votes` above `n` is rejected with its own error code. Test in Task 3.
4. With 5 votes, a failed sampling step still sends an emergency floor (`decide` already does; pin it with n=5). Test in Task 3.
5. The eval's credit estimate at n=5 is 11 calls per two-model case. Test in Task 5.

---

### Task 1: Scale thresholds when re-scoring a run with more votes

**Files:**
- Modify: `worker/src/rescore.ts`
- Test: `worker/test/rescore.test.ts`

**Interfaces:**
- Produces: `samplesPerModel(exp: Experiment, policy: Policy): number` (the largest vote total in any record's primary or secondary, or `policy.sampling.n` when none); `policyForSamples(policy: Policy, n: number): Policy` (copy with `sampling.n = n`, `min_valid = ceil(min_valid * n / policy.sampling.n)`, `min_top_votes = ceil(min_top_votes * n / policy.sampling.n)`, others unchanged); `scoreRecords(records: ExperimentRecord[], policy: Policy): ScoredCase[]`. `rescore(exp, policy)` uses `policyForSamples(policy, samplesPerModel(exp, policy))`.

- [ ] **Step 1: Failing tests** — `policyForSamples(p5, 20)` gives n 20, min_valid 16, min_top_votes 12 where `p5` has 5/4/3; `policyForSamples(p, p.sampling.n)` equals `p`; a 20-vote experiment with one record of `routine: 15` re-scored under `p5` is Human review (`sampling_failed`), one with `routine: 16` is routed.
- [ ] **Step 2: Run** `npx vitest run test/rescore.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement** the three functions; keep `keepsFixed` comparing against the scaled `min_valid`.
- [ ] **Step 4: Run** the file, then `npm test`; all pass.
- [ ] **Step 5: Commit.**

### Task 2: Vote-count stability module and CLI

**Files:**
- Create: `worker/src/stability.ts`, `worker/scripts/stability.ts`
- Test: `worker/test/stability.test.ts`

**Interfaces:**
- Consumes: `policyForSamples`, `scoreRecords` (Task 1); `summarize` (`metrics.ts`).
- Produces: `subsample(votes: Votes, k: number, rand: () => number): Votes`; `seededRandom(seed: number): () => number` (mulberry32); `type StabilityRow = {k, min_valid, min_top_votes, missed_mean, any_miss_rate, agreement, flagged_rate, human_review_rate, cost_mean, cost_p90}`; `stabilityCurve(exp: Experiment, policy: Policy, ks: number[], draws: number, seed: number): StabilityRow[]`. Agreement is the share of cases whose disposition matches the experiment re-scored at its own votes per model. Fixed records keep their outcome in every draw.
- CLI: `tsx scripts/stability.ts --draws 500 --seed 1 <experiment.json>...` prints one markdown table per experiment (label, then rows for k in 3, 4, 5, 6, 8, 10, 12, 15, 20). Aggregates only.

- [ ] **Step 1: Failing tests** — `subsample` returns exactly k votes, never more of a level than given, and all votes when the total is below k; the same seed gives the same draws; unanimous synthetic records give agreement 1 and missed 0 at every k; a record split 10/10 between `ed_now` and `in_person_today` gives agreement below 1 at k 3 and 1 at k 20.
- [ ] **Step 2: Run** `npx vitest run test/stability.test.ts`; expect failures.
- [ ] **Step 3: Implement** module and CLI (CLI reads files with `readFileSync`, validates with `ExperimentSchema`).
- [ ] **Step 4: Run** tests and `npm run lint`; pass.
- [ ] **Step 5: Commit.**

### Task 3: Policy 0.3.0 and override ranges

**Files:**
- Modify: `policy/policy.yaml`, `worker/src/overrides.ts`, `worker/src/index.ts` (live route error code)
- Test: `worker/test/policy.test.ts`, `worker/test/overrides.test.ts`, `worker/test/api.test.ts`, and any pipeline test that assumes 20 samples

**Interfaces:**
- Produces: `checkLiveSafe` also returns `'min_valid_above_samples'` and `'min_top_votes_above_samples'`. Schema ranges `min_valid` 1 to 20, `min_top_votes` 1 to 20.

- [ ] **Step 1: Failing tests** — policy is 0.3.0 with n 5, min_valid 4, min_top_votes 3 (replaces "has 20 samples"); schema accepts min_valid 1 and 20; live route with min_valid 6 returns 400 `min_valid_above_samples`; with min_top_votes 6 returns `min_top_votes_above_samples`; at n 5, a case with 3 valid primary votes and an `ed_now` floor is Human review with disposition `ed_now`.
- [ ] **Step 2: Run**; expect failures.
- [ ] **Step 3: Implement**; fix tests that relied on n 20 by deriving counts from `policy.sampling.n`.
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run typecheck`; pass.
- [ ] **Step 5: Commit.**

### Task 4: Operations view uses the policy's vote count

**Files:**
- Modify: `web/lib.js`, `web/ops.js`
- Test: `web/test/*.test.mjs`

**Interfaces:**
- `policyDefaults(api)` adds `samples` (from `api.sampling.n`; null result if missing). `SAMPLES` is removed. Sliders for `min_valid` and `min_top_votes` run 1 to `policy.samples`. `validStoredOverrides` drops either above `policy.samples`. `liveOverrides` caps both at `policy.samples`. Labels read "x of `samples`".

- [ ] **Step 1: Failing tests** — stored `{policy: {min_valid: 15}}` under a 5-sample policy is dropped; `policyDefaults` returns `samples: 5`; the summary line reads "agreement 3/5".
- [ ] **Step 2: Run** `node --test web/test/*.test.mjs`; expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web tests; pass.
- [ ] **Step 5: Commit.**

### Task 5: Eval credit estimate from the policy

**Files:**
- Modify: `eval/src/counsel_eval/run.py`
- Test: `eval/tests/test_run.py`

- [ ] **Step 1: Failing test** — `effective_calls_per_case("sonnet+flash", None, n=5) == 11`, `("sonnet", None, n=5) == 6`, and an explicit value still wins.
- [ ] **Step 2–4:** implement (`2n+1` / `n+1`, n read from the loaded policy), `uv run pytest`, pyink, pylint.
- [ ] **Step 5: Commit.**

### Task 6: Stability report and docs

**Files:**
- Create: `reports/2026-11-06-vote-stability.md` (from the Task 2 CLI over the saved 20-vote experiments; aggregates and labels only)
- Modify: `docs/policy.md` (thresholds, version), `docs/decisions.md` (0.3.0 row; 2026-11-05 "2 Sonnet in flight" note), `docs/eval.md` (0.2.0 results, stability section, call count), `docs/rate-limits.md` (2026-11-06 entry), `docs/architecture.md` and `README.md` (call counts)

- [ ] **Step 1:** generate the report; check it has no case ids.
- [ ] **Step 2:** update docs; grep for "41 calls", "20 answers", "of 20" and fix each.
- [ ] **Step 3: Commit.**

### Task 7: Ship and verify live

- [ ] Final whole-branch review (fresh reviewer) plus `@codex review`; fix findings.
- [ ] Merge, deploy API (and web if Task 4 changed it); note the version ids.
- [ ] Burst test: 5 made-up messages sent at once to the deployed Worker; expect all routed, valid votes at least 4 of 5 per model, log 429s.
- [ ] Eval under 0.3.0: Sonnet + Flash, Sonnet only, Flash only, and floor; expect 0 of 14 missed and Human review near the 0.1.0 level. Report, docs, experiment log export to KV.
- [ ] If the burst test fails, stop and investigate (systematic-debugging) before changing retries.
