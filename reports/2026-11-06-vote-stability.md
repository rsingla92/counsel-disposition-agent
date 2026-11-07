# Vote-count stability, policy 0.3.0

Date: 2026-11-06. Aggregate only: counts and rates, no case ids.

## Question

How many votes per model does routing need? Policy 0.2.0 drew 20 from
each model. Under back-to-back cases, the provider's per-minute rate limit
refused about half of them (HTTP 429 after four retries), and 92 to 96% of
cases went to Human review in every 0.2.0 run, with 0 of 14 emergencies
missed. Fewer votes means fewer calls.

## Method

`npm run stability` (worker) reads an exported experiment, which holds
votes and no message text. For each k, it draws k votes per model without
replacement from every saved case, 500 times with seed 1, and re-decides
each case with the policy's thresholds scaled to k, rounding up. "Same
level as full run" compares each draw with the run's own 20 votes,
re-scored the same way.

The draw assumes all k votes come back. So the curve is meaningful only on
a run where they did: a run that lost votes to rate limits sent cases to
Human review for missing votes, and a 5-vote draw from what survived
routes them, which shows up as disagreement that measures throughput, not
stability.

## The models rarely disagree with themselves

Across the four saved Sonnet + Flash and Sonnet-only runs, Sonnet gave all
its votes to one level on 192 of 195 cases. Flash did on about 90%.

## Result: Sonnet + Flash, 2026-11-05 (50 cases, every Sonnet vote returned on 49)

| Votes per model | Valid needed | Agreeing needed | Missed emergencies (mean) | Draws with a miss | Same level as full run | Flagged | Human review | Cost score (mean) | Cost score (p90) |
|---|---|---|---|---|---|---|---|---|---|
| 3 | 3 | 2 | 0.00 | 0.0% | 100.0% | 11.7% | 0.0% | 0.803 | 0.804 |
| 4 | 4 | 3 | 0.00 | 0.0% | 100.0% | 12.0% | 0.0% | 0.804 | 0.804 |
| 5 | 4 | 3 | 0.00 | 0.0% | 100.0% | 11.9% | 0.0% | 0.804 | 0.804 |
| 6 | 5 | 4 | 0.00 | 0.0% | 100.0% | 12.0% | 0.0% | 0.804 | 0.804 |
| 8 | 7 | 5 | 0.00 | 0.0% | 100.0% | 12.0% | 0.0% | 0.804 | 0.804 |
| 10 | 8 | 6 | 0.00 | 0.0% | 100.0% | 12.0% | 0.0% | 0.804 | 0.804 |
| 12 | 10 | 8 | 0.00 | 0.0% | 100.0% | 14.0% | 0.0% | 0.808 | 0.808 |
| 15 | 12 | 9 | 0.00 | 0.0% | 100.0% | 14.0% | 0.0% | 0.808 | 0.808 |
| 20 | 16 | 12 | 0.00 | 0.0% | 100.0% | 14.0% | 0.0% | 0.808 | 0.808 |

From 3 to 20 votes: no emergency missed in any draw, the same level on
every case, and the same cost score within 0.005. The flag rate falls
from 14% to 12% below 12 votes because a Flash cross-check that returned
few of its 20 votes counts as enough at the lower thresholds.

## Choice: 5 votes per model

Three votes would route these cases the same, but a split of 2 against 1
is too coarse to flag real uncertainty. At 5, a case needs 3 agreeing
votes to route without a flag and 4 valid votes to route at all. A
Sonnet + Flash case drops from 41 calls to 11; five people sending at once
make about 30 Sonnet calls, not about 205.

## Runs left out

These runs lost votes to rate limits, so their "same level" column
measures that loss (see Method):

- Sonnet + Flash, 3 in flight (2026-11-04): 93.5% at 5 votes; some cases
  lost Sonnet votes.
- Sonnet only, 3 in flight (2026-11-05): 28%; 49 cases lost Sonnet votes.
- Sonnet + Flash, 6 in flight (2026-11-04): failed extractions decide
  most of its outcomes before any voting.
- The three policy 0.2.0 runs (2026-11-06): 8 to 15 valid votes of 20 per
  case.

## Limits

- One clean run of 50 cases and one rater. The curve says 20 votes add
  nothing on these cases; it cannot show a rare case where they would.
- The re-score is not a live test. The 0.3.0 eval runs at 5 votes live.
