# Operations view: design

Status: draft for review, 2026-11-04. Presentation: 2026-11-12.

## Intent

The audience on Nov 12 is Ray (VP), his bosses, and Lucinda Sharif. The user
wants them to see how the agent is set up, which conditions we tested, and
what happens when a setting changes, live. The patient and physician views
show one message. The Operations view shows the system: its models, its
thresholds, and the evidence behind them.

Two ideas from brainstorming, chosen by the user ("A and B"):

- **A. Live controls.** The policy's tunable settings as sliders, plus a
  model picker. Moving a slider re-scores a saved 50-case run instantly. The
  next live message typed into the demo is routed with the chosen model and
  the slider settings.
- **B. Experiment log.** Each saved eval run is a row: the condition (models,
  calls in flight, extraction fallback) and its results. This carries the
  rate-limit story (`docs/rate-limits.md`) and the one-model versus two-model
  question.

Direction C (thresholds learned from physician overrides, approved by a
human, with floors locked) is not built. It becomes a roadmap slide and a
section in the reliability roadmap doc.

## Goals

1. A third view, "Operations", beside the physician and patient views in
   `web/`.
2. An experiment log with one row per saved run: condition label, missed
   emergencies (of 14), Human review rate, cost score, median latency.
   Selecting a row makes it the active run.
3. Sliders for the tunable settings, starting at the deployed policy's
   values:
   - agreement needed to route (`review.min_top_votes`, 12 of 20);
   - valid samples needed (`sampling.min_valid`, 15);
   - cost of a human review (`loss.human_review_cost`, 0.2);
   - the six under-triage boundary weights (`loss` boundary `under`:
     3 / 20 / 2 / 5 / 2 / 1.5).
   `review.max_span` (2) is also tunable.
4. Moving a slider re-scores the active run with no model calls and updates
   the missed-emergency count, Human review rate, cost score, over-triage
   rate and a 7×7 confusion grid (reference level against routed level).
   Each shows the change from the deployed values.
5. A model picker with three choices: Sonnet 5.5 only, Gemini 3.8 Flash only,
   Sonnet 5.5 + Flash. The next live message routed from the demo uses the
   chosen models.
6. The next live message also uses the slider settings (the user's
   decision, 2026-11-04).
7. Every result routed under a non-default model or setting says so: in the
   physician view's disposition card and in the trace.
8. A "Reset to policy" control returns every slider and the model picker to
   the deployed values.

## Non-goals

- Saving slider changes back to `policy/policy.yaml` or deploying them.
  Settings are a what-if for the session, never a policy release.
- Learning thresholds (direction C).
- Changing the number of samples per model (20) or the red-flag floors from
  this view. Both are shown read-only, with a note that changing them needs a
  new run.
- Live re-running of the 50 cases from the view. Re-scoring uses saved votes.

## Anti-goals (failure even if it works)

- **A live route that can send an emergency lower than the deployed policy
  would.** The zero-miss rule (AGENTS.md review rule 1) holds for every live
  message. Overrides apply to the router's thresholds and loss weights only.
  Red-flag floors, the early emergency event and the extraction step are
  untouched. The two emergency-guarding under-triage weights (`call_911` ↔
  `ed_now` and `ed_now` ↔ `in_person_today`) may be raised for a live route
  but never lowered below the policy value; a lower value is a 400.
- **A what-if miss that looks real.** Re-scoring a saved run may lower those
  two weights (the user's decision, 2026-11-04), so the view can show missed
  emergencies rising. When it does, the sliders sit in a marked "what-if
  only" zone, the missed count turns to a warning with an icon and a label,
  and live routing stays at the policy floor for those weights. The view
  says so in words, not color alone.
- **Counsel data in the public repo.** Re-scoring needs per-case votes and
  reference labels, which come from Counsel's cases. None of it is committed
  or bundled into the static site (see Data handling).
- **A re-score that disagrees with the Worker.** If the view says 12% Human
  review under some setting, routing those cases live under that setting
  must give the same answer. One implementation of the router, not two.
- **Any caller choosing an arbitrary model.** The Worker accepts only the
  three model choices above.

## Constraints

- Repo is public. Never commit `docs/brief/`, `data/private/`, Counsel's
  messages, labels, or any excerpt from them.
- Logs never contain message text or IP addresses.
- Every `/v1/*` call except `/v1/schema` needs the `ACCESS_TOKEN` bearer token; `/v1/policy` needs it too (corrected 2026-11-05).
- Every failure path still ends at Human review or higher (AGENTS.md rule 2).
- Tests are hermetic, with the LLM mocked.
- OpenRouter: provider pinned to `google-vertex`, no fallbacks, at most 3
  calls in flight per case. The model choices keep that pinning.
- The web app is plain ES modules with no bundler (`web/app.js`, `web/lib.js`)
  and `node --test` tests. Keep it that way.
- Ready, deployed and rehearsed before 2026-11-12.

## How it works (decided)

### Live routing with overrides

`POST /v1/route` gains an optional `overrides` object:

```json
{
  "message": "...",
  "overrides": {
    "models": "sonnet" | "flash" | "sonnet+flash",
    "policy": {
      "min_top_votes": 14,
      "min_valid": 15,
      "max_span": 2,
      "human_review_cost": 0.2,
      "under_weights": [3, 20, 2, 5, 2, 1.5]
    }
  }
}
```

- `models` maps to fixed `ModelSpec`s held in the Worker; any other value is
  a 400. "sonnet" and "flash" run one model (no secondary, so no
  cross-check, which the pipeline already handles at
  `worker/src/pipeline.ts:512-540`). Extraction falls back only when a
  secondary exists.
- Each policy field has a fixed allowed range, validated with Zod; out of
  range is a 400, never silently clamped. Ranges are the builder's call,
  but `min_valid` can never exceed the sample count and `min_top_votes` can
  never be below a simple majority of `min_valid`.
- The Worker builds an effective policy by copying the loaded policy and
  replacing only those fields. Floors, red flags, levels and sampling count
  come from the loaded policy, always.
- The result's `trace` gains `overrides` (the object as applied, or null).
  `trace.policy_version` stays the deployed version. The eval client's
  policy-version check is unaffected.
- No overrides means today's behaviour exactly.

### Re-scoring saved runs

The Worker re-scores, using the same router functions the pipeline uses
(`chooseLevel`, `reviewReasons` and the cost scoring). This keeps one
implementation.

- `GET /v1/experiments` returns the experiment log rows (labels and summary
  numbers).
- `POST /v1/experiments/:id/rescore` with a `policy` object (same shape and
  validation as `overrides.policy`) returns the summary numbers and the
  confusion grid under those settings.
- Cases that ended before sampling (extraction failed, sampling failed for
  lack of valid samples under the original run) keep their original outcome,
  except that a lower `min_valid` can turn a `sampling_failed` case back into
  a routed one when its stored votes reach it.

### Data handling

A local script reads a saved run under `data/private/runs/<stamp>/` and
writes a stripped file: per case, the case id, reference level, both models'
vote counts, the floor, whether extraction asked questions or a photo, and
latency. No message text, justification, excerpt, raw model output or
patient reply. The script uploads it to a Workers KV namespace bound to the
API Worker (the user's decision, 2026-11-04), read only behind the access
token. It is never written inside the repo. The namespace and its contents
are deleted after the Nov 12 presentation; the plan includes that step.

### The view

- A third button in the existing view switcher.
- Top: experiment log table. Bottom left: model picker, sliders, reset.
  Bottom right: the metrics with deltas and the confusion grid.
- Slider changes re-score after a short debounce.
- The chosen models and settings are held in page state, and in
  `localStorage` per viewer (wrapped in try/catch), so a reload keeps them.
  Every live route from the physician or patient view sends them as
  `overrides`.
- A visible banner on the physician and patient views whenever overrides
  are active: "Routing with: Sonnet only · agreement 14/20".
- Replays are unaffected; they show saved results.

### Experiment log contents for Nov 12

1. Rule floor only (rerun 2026-11-04 after the credit top-up).
2. Sonnet + Flash, 6 calls in flight (run 1).
3. Sonnet + Flash, 3 in flight, extraction fallback (run 2).
4. Sonnet only, 3 in flight. Needs the `models` override, so it runs after
   the Worker change ships. The eval CLI gains `--models`.

## Calls made by Claude after the builder check (check these)

- **Fixed cases.** A case whose saved outcome did not come from the router
  keeps that outcome under every setting. That covers an early emergency
  event, extraction failure, and sampling failure. The exception: a lower
  `min_valid` re-routes a `sampling_failed` case whose stored votes reach it.
  The stripped record therefore carries `base_reasons` (the reason codes not
  produced by `reviewReasons`, such as `unverified_excerpt`,
  `secondary_unavailable`, `missing_info` and `photo_needed`), an
  `early_event` flag, and the saved status.
- **Saved runs.** All three saved full-agent runs (2026-11-04 06:59, 13:47
  and 15:55 UTC) store votes for all 50 cases. The rule-floor row has no
  votes, so it is shown but cannot be re-scored; its sliders are disabled.
- **Scoring.** The Worker gets a TypeScript port of the eval's metrics:
  missed emergencies, Human review rate, over-triage rate and `cost_score`
  from `eval/src/counsel_eval/scoring.py`, with the same definitions. Shared
  synthetic fixtures run through both the Python and TypeScript code and must
  give identical numbers. No Counsel data goes in the fixtures.
- **Confusion grid.** Seven reference rows by eight columns: the seven
  levels plus Human review. A needs-info case counts at its disposition.
- **Model roles.** Re-scoring uses the primary's votes, as `chooseLevel`
  does; the secondary only feeds `family_disagreement`. In "Flash only",
  Flash is the primary and there is no secondary. If Flash's extraction
  fails, the case ends at Human review (`extraction_failed`), which gets a
  test.
- **Deploying.** Claude deploys with the existing wrangler login. There is
  no staging Worker; with no overrides sent, behaviour is unchanged, so
  rehearsal runs against production.

## Left to the builder

- Exact slider ranges and steps, within the rules above.
- Layout details, chart rendering for the confusion grid (follow the dataviz
  skill; cells need a table fallback).
- Whether re-score results are cached per settings.
- KV key layout and the upload script's interface.
- How the eval CLI records the condition label in run metadata.
