# Rate limits in the live run

Notes for the presentation and for the reliability roadmap.

## What happened

The agent makes 41 model calls per case: one extraction, then 20 samples from
each of two models. Both models run on Google Vertex through OpenRouter, which
is the zero-data-retention route.

- **First run, 4 cases at a time, Workers free plan.** Almost every case failed.
  Vertex returned HTTP 429 for both models (20 to 25 per case), and the
  retries ran into the free plan's cap of 50 outbound requests per Worker
  request.
- **Workers Paid, 4 cases at a time.** The cap went away, but each case drew
  about 155 rate-limit responses. The OpenRouter account sustains about 6
  calls in flight.
- **Workers Paid, one case at a time, 6 calls in flight per case.** On
  2026-11-04, 22 of 50 cases still ended at Human review with
  `sampling_failed` (too few valid samples), and 4 with `extraction_failed`.
  One of those extraction failures was an emergency case, so the full agent
  missed 1 of 14 emergencies. The rule floor alone missed none, because it
  makes one call per case.

- **Workers Paid, one case at a time, 3 calls in flight, extraction
  fallback.** Later on 2026-11-04 the full agent missed 0 of 14 emergencies,
  with 12% Human review and a cost score of 0.80. Median latency rose from
  45 s to 79 s. Partway through, the OpenRouter account ran out of credit and
  calls began returning HTTP 402, so that run's rule-floor numbers were
  rerun after a top-up.

- **Sonnet + Flash under the stricter extraction rule, 3 calls in flight.**
  On 2026-11-05 the full agent missed 0 of 14 emergencies, with 0% Human
  review, Needs info on 74% of cases, a cost score of 0.808 and a median
  latency of 83 s. No extraction failed in this run. The full results are
  in the [2026-11-05 report](../reports/2026-11-05-policy-0.1.0.md).

On the cases that got enough samples, the router behaved as designed. The
failures come from throughput, not from model judgement.

The 402s are a second lesson. The eval's pre-run credit check read the API
key's spend limit, which was unset, so it passed while the account itself
was empty. It now checks the smaller of the key limit and the account
balance.

## Why it matters

Every failure ends at Human review, which is safe for the patient but costs
physician time. The cost score counts Human review as a routine visit, so the
full agent scored 1.92, against 1.19 for the rule floor alone.

A total extraction failure is the dangerous case. With no extraction there are
no red flags, so no floor, so no early 911 or ED message. The patient gets
only the Human review message ("if this is an emergency, call 911").

## What changed

- At most 3 calls in flight per case, down from 6 (replaced on 2026-11-05,
  below).
- **2026-11-05:** a queue per model, because Vertex limits each model
  separately: Sonnet 2 and Flash 4 in flight, at most 6 in all. Sonnet alone
  had drawn 429s at 3. Flash also runs at reasoning effort `low`: by default
  it reasons, and a sample call took 7.4 s against 2.7 s at `low`. On nine
  made-up messages, both models took 40 to 66 s (from a median of 83 s),
  and Sonnet alone got 19 or 20 valid samples every time. A few 429s still
  come back from both models, and their retries add time.
- Extraction gets the same rate-limit retries as sampling: 4, with backoff
  from 1 s. It used to get 1.
- When the primary model's extraction fails (an error, or output that failed
  validation), the secondary model extracts, but the case always ends at
  Human review. The secondary's extraction only carries red-flag floors; red
  flags read from invalid output still set the floor, and across both
  attempts each flag keeps its most severe state.
- Each failed extraction call logs the model, error code and HTTP status, so
  the next run shows whether failures are 429s or timeouts. Logs carry no
  message text.
- The trace records which model's extraction was used
  (`trace.extraction_model`).
- Sampling stays at 20 calls per model.

## Roadmap

- Bring-your-own provider keys on OpenRouter, or a provisioned-throughput
  contract with Vertex, to raise the account's rate limit.
- A shared retry budget per case, so retries back off together.
- A queue (Cloudflare Queues) in place of synchronous routing, so a rate-limit
  spike delays a case instead of failing it.
- Primary-first priority in the request queue, so the extraction and the
  primary's samples go ahead of the secondary's.
- Alerting on the Human review rate and on 429 counts, from the log lines
  above and OpenRouter traces.
- One deadline for extraction across both models, so the early 911 or ED
  message is never more than about 20 s late. The fallback can double that
  today.
- Alerting on account credit, since a 402 fails every call at once.
- A deterministic keyword backstop for emergencies when extraction fails
  entirely.
