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
  One of those extraction failures was an emergency (C02), so the full agent
  missed 1 of 14 emergencies. The rule floor alone missed none, because it
  makes one call per case.

On the cases that got enough samples, the router behaved as designed. The
failures come from throughput, not from model judgement.

## Why it matters

Every failure ends at Human review, which is safe for the patient but costs
physician time. The cost score counts Human review as a routine visit, so the
full agent scored 1.92, against 1.19 for the rule floor alone.

A total extraction failure is the dangerous case. With no extraction there are
no red flags, so no floor, so no early 911 or ED message. The patient gets
only the Human review message ("if this is an emergency, call 911").

## What changed

- At most 3 calls in flight per case, down from 6.
- Extraction gets the same rate-limit retries as sampling: 4, with backoff
  from 1 s. It used to get 1.
- When the primary model's extraction fails outright, the secondary model
  extracts instead. If the primary returned output that failed validation but
  still had a readable flag list, those flags set the floor and no fallback is
  made.
- Each failed extraction call logs the model, error code and HTTP status, so
  the next run shows whether failures are 429s or timeouts. Logs carry no
  message text.
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
- A deterministic keyword backstop for emergencies when extraction fails
  entirely.
