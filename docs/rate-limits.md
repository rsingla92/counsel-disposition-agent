# Rate limits in the live run

Notes for the presentation and for the reliability roadmap.

## What happened

Until policy 0.3.0 the agent made 41 model calls per case: one extraction,
then 20 samples from each of two models. It now makes 11 (5 samples each).
Both models run on Google Vertex through OpenRouter, which is the
zero-data-retention route.

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
- **Policy 0.2.0, queue per model (Sonnet 2, Flash 4), 20 samples.** On
  2026-11-06, every run sent most cases to Human review: Sonnet + Flash
  96%, Sonnet only 96%, Flash only 92%, each with 0 of 14 emergencies
  missed. The Worker log showed why: every lost sample was an HTTP 429
  that outlasted its 4 retries, for both models. The limit is per minute,
  not per connection. Cases now finished in about 40 s instead of 83 s, so
  back-to-back cases sent twice as many calls per minute. Single test
  messages had passed because the limit refilled between them. Reports:
  [Sonnet + Flash](../reports/2026-11-07-policy-0.2.0.md),
  [Sonnet only](../reports/2026-11-07-policy-0.2.0-sonnet.md),
  [Flash only](../reports/2026-11-07-policy-0.2.0-flash.md).

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
- **2026-11-06, policy 0.3.0:** 5 samples per model instead of 20, so a
  case makes 11 calls, not 41. Re-scoring the clean 20-vote run at 3 to 20
  votes routed every case the same
  ([stability report](../reports/2026-11-06-vote-stability.md)).
- **2026-11-06, burst test on 0.3.0.** Five made-up messages sent at once
  all routed, in about 30 s. A second burst 30 s later failed extraction on
  all five, for both models, so the chest-pain message got no early 911
  message. After 90 s idle, a third burst routed four of five (chest pain to
  Call 911, all votes in, 19 s); one went to Human review with too few
  votes. The limit refills, but over more than a minute.
- **Extraction waits out the limit.** The primary model's extraction now
  retries a 429 up to 6 times (about 63 s of backoff) instead of 4 (about
  15 s), because extraction sets the red-flag floor and the early Emergency
  message. Under load that message arrives late, not never: up to about
  90 s when the primary finally succeeds, and about 2 minutes when it fails
  and the backup (which keeps the default 4 retries) sets the floor. The
  slowest full case, a late extraction followed by rate-limited sampling,
  takes about 140 s, so the web page now waits 210 s instead of 150 s and
  says when it gave up waiting.
- **The page says it is still working.** After 10 s the status line counts
  up in steps of 10 s and says the message is queued, not lost, and the patient view says
  the message arrived and to call 911 if this is an emergency.

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
- One deadline per case, across extraction and sampling. Under a rate limit
  the early 911 or ED message can now be about 90 s late, or about 2 minutes
  when the backup sets the floor. A higher provider limit is the real fix.
- Alerting on account credit, since a 402 fails every call at once.
- A deterministic keyword backstop for emergencies when extraction fails
  entirely.
