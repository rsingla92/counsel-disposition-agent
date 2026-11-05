# Architecture

[Back to the README](../README.md)

## The three parts

| Part | Where | What it does |
|---|---|---|
| API Worker | [`worker/`](../worker/) | Routes a message. All routing logic lives here, once, in TypeScript. |
| Web Worker | [`web/`](../web/) | The demo page: static files, no server code. Physician, Patient and Operations views. |
| Eval | [`eval/`](../eval/) | Python. Sends the 50 reviewed cases to the API Worker and scores the results. |

The demo and the eval both call `POST /v1/route` on the same API Worker. So
the demo runs exactly the routing logic the eval measures.

Both Workers run on Cloudflare Workers Paid:

- API: `https://counsel-disposition-agent.counsel-demo.workers.dev`. Every
  endpoint needs the access token except the public
  [result schema](https://counsel-disposition-agent.counsel-demo.workers.dev/v1/schema).
- Demo: <https://counsel-disposition-web.counsel-demo.workers.dev>

The clinical rules (red flags, risk factors, cost weights, thresholds and
patient wording) live in one versioned file,
[`policy/policy.yaml`](../policy/policy.yaml). The Worker bundles a copy at
build time and the eval reads the same file. [Policy](policy.md) explains
it.

## The pipeline

[`worker/src/pipeline.ts`](../worker/src/pipeline.ts) runs eight steps in
this order.

1. **Intake.** A message longer than 4,000 characters goes to Human review
   (`too_long`).
2. **Extraction.** One call to the primary model (Claude Sonnet 5.5) reads
   the message and answers every red flag in the policy as present, absent
   or unknown, each with a quote from the message. It also marks risk
   factors (such as pregnancy or a blood thinner), lists questions a
   physician would ask, and says whether a photo is needed, the message is in
   English, and it is a request for care.
   - If the primary's extraction fails (an error, a timeout, or output that
     fails validation), the secondary model (Gemini 3.8 Flash) tries once.
     When a live route runs one model only (Sonnet only or Flash only), the
     other model is kept as an extraction-only backup and tries instead; it
     never samples or cross-checks. The backup is skipped when the primary's invalid output already
     marked a red flag present, since that flag sets the floor. The case
     still ends at Human review (`extraction_failed`), even when the
     backup succeeds. The backup's reading is used only to set the red-flag
     floor and send the early emergency message.
   - Red flags marked present in invalid output still count. Across both
     attempts, each flag keeps its most severe answer.
3. **Rule floor.** Each red flag marked present sets a minimum level. The
   floor is the highest of those. One present risk factor raises the floor
   by one level, never above In person today, and never when a flag already
   covers that risk factor. If the floor is ED now or Call 911, the patient
   gets the emergency instructions now, before any sampling, as an early
   event on the response stream.
4. **Scope.** A message that is not in English, or is not a request for care,
   goes to Human review (`non_english`, `out_of_scope`). The floor is kept if
   it is an emergency.
5. **Floor only.** The eval can stop here (`mode: "floor_only"`) to score the
   rule floor alone as a baseline. Live routes never stop here.
6. **Sampling.** 20 answers from each model, in parallel, at temperature 0.7.
   Each answer is a level, a justification and safety-netting text. Any
   answer below the floor is raised to the floor.
7. **Decide** ([`decide.ts`](../worker/src/decide.ts),
   [`router.ts`](../worker/src/router.ts)).
   - Fewer than 15 valid primary answers: Human review (`sampling_failed`).
   - Otherwise the valid primary answers are treated as a probability for each
     level. The router picks the level, at or above the floor, with the lowest
     expected cost under the policy's cost weights. Ties go to the more
     acute level.
   - The case stays routed but is flagged for a physician to check if fewer
     than 12 of the valid primary answers agree, if the answers spread more
     than 2 levels apart, if the two
     models' most common answers fall in different tiers, if the secondary
     returned too few valid answers to cross-check, or if a quote did not
     match the message.
   - If extraction listed questions or asked for a photo, the status is
     Needs info. The level still stands.
8. **Explain.** The justification comes from a sample that proposed the
   chosen level. If none did, a fixed sentence explains the choice from the
   floor or the expected cost. Safety-netting comes from the same sample, or
   from the most acute sample that has some, or a fixed line.

Finally the result is checked against its schema
([`schema/route-result.schema.json`](../schema/route-result.schema.json)).
A result that fails goes to Human review (`schema_invalid`). `route()` never
throws.

## Failure handling

Every failure ends at Human review or higher, never lower.

- Human review carries the floor as the level when the floor is ED now or
  Call 911. The patient gets the emergency message, not the holding message.
- Otherwise the patient gets a fixed holding message: a physician will
  review within 1 hour, and call 911 if this is an emergency.
- If even building a Human review result fails, a hand-built last-resort
  result does the same.
- A failing log call or a failing stream listener never changes the result.

## Quotes are checked

Every red flag and risk factor marked present comes with a quote. The
Worker checks that the quote appears word for word in the message, ignoring
case, curly quotes and extra spaces
([`floor.ts`](../worker/src/floor.ts)). An unverified quote still counts
toward the floor, because dropping a real red flag is the worse error, but
the case is flagged `unverified_excerpt` for a physician to check.

## Models and limits

- Both models are reached through OpenRouter, with the provider pinned to
  Google Vertex, fallbacks off and data collection denied (zero data
  retention).
- Primary: `anthropic/claude-sonnet-5.5`. Secondary:
  `google/gemini-3.8-flash`.
- Each message makes 41 model calls: 1 extraction and 20 samples from each
  model. Each model has its own queue, because Vertex rate-limits each
  model separately: at most 2 Sonnet calls and 4 Flash calls in flight per
  case, and never more than 6 connections in all (the Worker limit).
- Flash is called with reasoning effort `low`. It reasons by default, which
  roughly tripled its call time and timed out some extractions.
- Each sample is asked to keep its justification to at most 40 words,
  since output length sets a sample's latency. Nothing enforces the cap.
- Only HTTP 429 (rate limited) is retried: up to 4 times, with backoff
  doubling from 1 second.
- Time limits: 20 seconds for extraction, 15 seconds per sample.

[Rate limits](rate-limits.md) tells the story of why the limit is 3.

## API

| Endpoint | Token | What it does |
|---|---|---|
| `POST /v1/route` | yes | Routes one message. Streams newline-delimited JSON: an optional `early` event, then the `result`. |
| `POST /v1/override` | yes | Logs a physician's change of level, with a reason code. |
| `GET /v1/policy` | yes | The deployed policy version, levels, red flags and tunable settings. |
| `GET /v1/experiments` | yes | The Operations view's experiment log. |
| `POST /v1/experiments/:id/rescore` | yes | Re-scores a saved run under other settings, with no model calls. |
| `GET /v1/schema` | no | The result's JSON schema. |

The token is a bearer token, compared in constant time. Only the demo's
origin may call the API from a browser.

## The Operations view

The third view in the demo shows the system rather than one message. Its
design is in
[the Operations view spec](superpowers/specs/2026-11-04-operations-view-design.md).

- **Experiment log.** Saved eval runs, one row each: condition, missed
  emergencies, Human review rate, cost score and median time. It has five
  rows, with "Sonnet + Flash, as deployed (stricter extraction)" first.
- **Sliders.** Agreement needed (12 of 20), valid answers needed (15),
  widest spread (2), cost of a Human review (0.2), and the six under-triage
  weights. Moving one re-scores the selected run in the Worker from its
  stored votes, using the same `decide()` function live routing uses.
- **Model picker.** Policy default (Sonnet with Flash as a cross-check, as
  deployed), Sonnet only, or Flash only. With one model there is no
  cross-check, but the other model still backs up a failed extraction.
- **Live routes** sent from the demo use the chosen models and settings,
  through `overrides` on `POST /v1/route`. The cost of a Human review is a
  re-score setting only: the Worker never reads it when routing, so it is
  never sent on a live route.

Safety rules for live overrides:

- A live route never lands an emergency lower than the deployed policy
  would. The two weights that guard emergencies can only go up. When
  overrides are sent, the Worker also picks a level with the deployed policy
  and never goes below it when that level is ED now or Call 911.
- Valid answers needed (`min_valid`) can only go up on a live route. Below
  the deployed value the Worker answers 400 `min_valid_below_policy`; the
  demo raises it to the policy value before sending.
- Sonnet only and Flash only keep the other model as an extraction-only
  backup, so a failed extraction still sets red-flag floors and sends the
  early emergency message. The case still ends at Human review.
- Red-flag floors, the early emergency event and the sample count cannot be
  changed from the view.
- Re-scoring can lower the emergency weights and valid answers needed, to
  show what would happen. The view marks these settings "What-if only".

Saved runs live in a Workers KV namespace (`EXPERIMENTS`) as stripped
per-case records: votes, floor, reason codes and reference level. They hold
no message text. The namespace is deleted after the 2026-11-12
presentation.

**Replay mode.** The demo can also show saved runs of its synthetic
messages ([`web/replay/`](../web/replay/)) without calling the Worker.
Overrides are disabled in replay, since nothing is sent.

## Logging and privacy

Logs are JSON lines built from an allowlist
([`log.ts`](../worker/src/log.ts)). They never contain message text, quotes,
justifications, model output or IP addresses.

| Line (`kind`) | Fields (complete list, from `log.ts` and `pipeline.ts`) |
|---|---|
| `route` | Timestamp, SHA-256 of the message, policy version, models, latency, status, level, tier, floor, present red flag and modifier ids, ids with unverified quotes, vote counts, confidence, review flag and reasons, question count, photo needed, time sensitive |
| `override` | Timestamp, message SHA-256, from and to levels, reason code, policy version |
| `llm_error` | step, model, error code, HTTP status (failed extraction calls) |
| `sample_errors` | model, valid count, total, failure counts by error |

The full trace, including raw model output, goes back only in the HTTP
response, so the caller can inspect it. It is not logged.
