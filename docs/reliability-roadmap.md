# Reliability roadmap

[Back to the README](../README.md)

V0 is built to be safe when it fails: every failure ends with a physician,
and an emergency floor is never lowered. It is not yet built to fail
rarely. This page lists where V0 can break and the work, in four phases,
that would make it dependable at Counsel's scale.
[Rate limits](rate-limits.md) has the live-run evidence behind much of it.

## V0's real single points of failure

- **OpenRouter, and one pinned provider per model family.** Both models run
  on Google Vertex through one OpenRouter account, with fallbacks off. An
  outage, a rate limit or an empty account at either one stops every case.
  An HTTP 402 (out of credit) fails every call at once; this happened in a
  live run on 2026-11-04.
- **Emergency detection depends on the LLM.** The red-flag floor is
  deterministic, but it reads flags from a model's extraction. If extraction
  fails on both models, there is no floor and no early emergency message.
  The patient gets only the holding message ("if this is an emergency, call
  911").
- **Requests are synchronous and stateless.** A case lives only inside one
  HTTP request. If the request dies, the case is gone: there is no queue,
  no retry later, and no record of where it stopped.
- **41 model calls per message.** 1 extraction plus 20 samples from each of
  two models. That multiplies every rate limit, cost and latency problem by
  41.

## Phase 1: survive outages

- **A deterministic last-resort keyword screen.** When extraction fails
  entirely, a fixed list of emergency phrases (chest pain, can't breathe,
  and similar) still sets an emergency floor and sends the early message.
  It can only raise a level, never lower one.
- **A static channel fallback.** If the Worker or the models are down, the
  intake channel answers with a fixed message: a physician will review, and
  call 911 now in an emergency.
- **Gate-validated fallback models.** Keep a tested backup model per family
  and switch to it only as a versioned policy change, after it passes the
  zero-miss gate. Never an automatic, untested failover.
- **Circuit breakers.** Stop calling a provider that is failing, and send
  cases straight to Human review with the floor kept, instead of waiting on
  timeouts.
- **Hedged sampling.** When a sample is slow, send a duplicate request and
  take whichever answers first, so a few slow calls don't push a case under
  `min_valid`.
- **One extraction deadline across both models.** Today the secondary's
  attempt starts only after the primary's fails, so the early 911 or ED
  message can arrive about 40 seconds late instead of 20. One shared
  deadline caps it.
- **Alerting on account credit**, well before it runs out, since a 402
  fails every call at once.
- **More throughput:** bring-your-own provider keys on OpenRouter or a
  provisioned-throughput contract with Vertex, a shared retry budget per
  case, and giving the extraction and the primary's samples priority over
  the secondary's.

The rate-limit finding to design for: one model alone is not cheaper to
run. With Sonnet only, Sonnet gets all 3 slots per case and is called about
twice as fast, so it hit HTTP 429 on every failed sample and 96% of cases
went to Human review. Capacity planning has to be per model, not per case.

## Phase 2: durability

- **Queue-based async intake** (for example Cloudflare Queues). A message
  is accepted and acknowledged at once, then routed by a worker that can
  retry. A rate-limit spike delays a case instead of failing it.
- **Per-case state.** Each case records which step it reached, so a retry
  resumes instead of starting over, and nothing is lost if a request dies.
- **Idempotency keys.** A resent message, or a retried step, never creates
  a second case or a second patient message.
- **Durable overrides.** Physician overrides go to a database, not only to
  logs, so they can feed a regular policy review.

## Phase 3: observability

- **SLOs** (targets the service commits to):
  - p99 time to emergency instructions, from message received to the early
    911 or ED message;
  - response-window compliance: the share of cases a physician reviews
    within the level's window (1 hour for In person today, 2 to 4 hours for
    Physician contact today, and so on);
  - flag rate: the share of cases sent to or flagged for a physician.
- **A live emergency canary.** A synthetic emergency message routed every
  few minutes in production. If it does not come back as an emergency, or
  comes back slowly, someone is paged.
- **Alerts** on the Human review rate and on 429 counts, from the
  `sample_errors` and `llm_error` log lines.
- **A CI gate on every policy change.** A pull request that edits
  `policy/policy.yaml` runs the eval, and fails if any emergency is missed.
- **Shadow deploys and rollback.** A new policy or model routes real
  traffic in the background, without its answers going to patients, and is
  compared with the live one before it takes over. Any release can be
  rolled back to the previous version in one step.
- **Per-request LLM tracing, later.** OpenRouter can export traces to
  Langfuse, Datadog or LangSmith. V0 skips this on purpose: it would copy
  every prompt and response, including patient text, to another vendor,
  against the zero-data-retention rule. The Worker's own trace log covers
  V0. If tracing is adopted, use a self-hosted Langfuse or metadata-only
  traces.

## Phase 4: scale

- **Adaptive sampling.** Stop early when the first answers agree strongly,
  and draw more only when they split. Most cases would need far fewer than
  41 calls.
- **Extraction caching.** Reuse an extraction when the same message is
  routed again, for example on a retry.
- **Quotas and back-pressure.** Limit how much one source can send, and slow
  intake gracefully under load instead of failing cases.
- **Data residency.** Keep patient data, and the model providers that see
  it, in the required region.

## Housekeeping after the presentation

- Delete the Workers KV namespace `EXPERIMENTS` after 2026-11-12
  (`wrangler kv namespace delete`). It holds the stripped per-case records
  behind the Operations view.
