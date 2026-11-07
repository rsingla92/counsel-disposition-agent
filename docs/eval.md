# Eval

[Back to the README](../README.md)

The eval ([`eval/`](../eval/), Python) sends each reviewed case to the
deployed Worker, scores the results and writes an aggregate report to
[`reports/`](../reports/). The latest is
[policy 0.1.0, 2026-11-05](../reports/2026-11-05-policy-0.1.0.md). The
[2026-11-04 report](../reports/2026-11-04-policy-0.1.0.md) is kept as
history, and the policy 0.2.0 runs and the
[vote-stability report](../reports/2026-11-06-vote-stability.md) are
described [below](#policy-020-and-the-move-to-5-votes).

## The cases

- **50 real patient messages from Counsel.** They are not in this repo. The
  eval reads them from `data/private/`, which is gitignored.
- **Reference labels:** the author, a physician, labelled all 50 blind. These
  are the ground truth. 14 cases are emergencies (4 Call 911, 10 ED now).
- **Historical labels:** the real-world dispositions, on the brief's 3-way
  scale. They agree with the reference on 38 of 50. On 4 cases the reference
  is ED now or Call 911 and the historical label was not.

## What is compared

| System | What it is |
|---|---|
| Full agent | The whole pipeline: extraction, floor, 5 + 5 samples (20 + 20 before policy 0.3.0), router |
| Rule floor only | Extraction and the red-flag floor, no sampling (1 model call) |
| Always escalate | Every case sent to ED now |
| Historical | The real-world dispositions, mapped to levels |

The historical mapping is the planner's: urgent escalation to ED now, async
physician to Routine, self-care to Self-care. It is still open for the
author ([decisions](decisions.md#v0-calls)).

## Metrics

1. **Zero-miss gate.** No case whose reference is Call 911 or ED now may be
   routed below ED now. This is a pass or fail, not a score to trade. The
   eval exits with code 1 if the full agent misses one in any repeat.
2. **Cost score.** The mean cost of each case under the
   [policy's cost weights](policy.md#cost-weights), plus 0.2 times the share
   of cases flagged for a physician. Lower is better. A Human review with no
   level is scored as Routine.
3. **Secondary outcomes:** confusion matrices (7 levels, 4 tiers, the
   brief's 3 labels); sensitivity and over-triage per level; Human review and
   Needs info rates; share of quotes verified; ROC AUC for "emergency" and
   "needs care today", using the primary model's vote share; errors by stage;
   latency; whether the early emergency message fired; and how the cost
   score moves when every under-triage weight is halved or doubled.

Headline numbers use the first run of each case.

## Results, policy 0.1.0

The full agent's numbers come from the 2026-11-05 run, Sonnet + Flash as
deployed, with the stricter extraction rule. The baselines come from the
2026-11-04 runs. The other rows are earlier conditions from the Operations
view's experiment log, which now has five rows, with "Sonnet + Flash, as
deployed (stricter extraction)" first.

"Sent to Human review" counts only cases the agent did not route. Routed
cases flagged for a physician to check are counted in the cost score, and
shown as the "Flagged for physician review" rate in the Operations view.

| Condition | Missed emergencies | Sent to Human review (not routed) | Cost score | Median time |
|---|---|---|---|---|
| **Sonnet + Flash, as deployed (stricter extraction), 2026-11-05** | **0 of 14** | **0%** | **0.808** | **83 s** |
| Sonnet + Flash, 3 calls in flight, before the stricter extraction rule (2026-11-04) | 0 of 14 | 12% | 0.80 | 79 s |
| Sonnet + Flash, 6 calls in flight | 1 of 14 | 52% | 1.92 | 45 s |
| Sonnet only, 3 calls in flight | 0 of 14 | 96% | 2.29 | 38 s |
| Rule floor only | 0 of 14 | 0% | 1.190 | 9.5 s |
| Always escalate | 0 of 14 | 0% | 2.520 | n/a |
| Historical | 4 of 14 | 0% | 4.120 | n/a |

Human review fell from 12% to 0% between the two Sonnet + Flash runs
because no extraction failed this time, not because of the stricter rule.
The rule can only send more cases to Human review, never fewer: it turns
a failed primary extraction into Human review even when the backup model's
extraction works.

More from the 2026-11-05 full-agent run, quoted from the report:

- ROC AUC 0.972 for emergency, 0.920 for emergency or same day.
- Every quote for a present red flag was verified (100%).
- The early emergency message fired on every emergency case (100%).
- Needs info on 74% of cases. Median latency 83.2 s, p95 99.1 s.
- Sensitivity was 100% for Call 911, ED now, Physician contact today and
  Self-care; 92.9% for Routine; 75% for In person today; 71.4% for Within a
  few days.
- Cost score 0.548 with every under-triage weight halved, 1.328 with every
  one doubled. The full agent beats the rule floor (0.595 and 2.380) at
  both.
- From the experiment log (the same run, re-scored in the Worker): 14% of
  cases flagged for physician review, and 18% over-triage.

## Policy 0.2.0 and the move to 5 votes

Every policy 0.2.0 run, at 20 samples per model, sent most cases to Human
review because the provider's per-minute rate limit refused about half the
samples ([rate limits](rate-limits.md)). No emergency was missed.

| Condition (policy 0.2.0, 2026-11-06; reports dated 2026-11-07 UTC) | Missed emergencies | Sent to Human review | Cost score | Median time |
|---|---|---|---|---|
| Sonnet + Flash | 0 of 14 | 96% | 2.256 | 40 s |
| Sonnet only | 0 of 14 | 96% | 2.232 | 37 s |
| Flash only | 0 of 14 | 92% | 2.164 | 32 s |
| Rule floor only | 0 of 14 | 0% | 1.190 | 9.8 s |

The [vote-stability report](../reports/2026-11-06-vote-stability.md)
re-scores the clean 2026-11-05 run with 3 to 20 votes per model, drawn
from its saved votes: every case lands at the same level, with no
emergency missed and the same cost score. Sonnet put all its votes on one
level in 192 of 195 saved cases. Policy 0.3.0 therefore draws 5 votes per
model. Its eval runs live at 5 votes; results to follow.

## What the conditions taught us

- **The failures were throughput, not judgement.** At 6 calls in flight,
  Google Vertex rate-limited the account and too few samples came back, so
  52% of cases went to Human review. One extraction failure was an
  emergency, which the agent missed. Dropping to 3 in flight fixed both.
  The full story is in [rate limits](rate-limits.md).
- **One model alone hit rate limits harder.** With Sonnet only, every
  failed sample was a Sonnet HTTP 429 (79 across a 10-case check). Alone,
  Sonnet gets all 3 slots, so it is called about twice as fast. Re-scoring
  that run with "valid answers needed" at 10 drops Human review from 96% to
  12%. That is a re-score only: live routes cannot lower valid answers
  needed below the policy's 15.
- **Flash alone sampled well but extracted slowly.** In a 10-case check,
  17 to 20 of 20 samples came back valid, but 3 of 10 extractions timed out
  at the 20-second limit.
- The live demo routes with Sonnet + Flash.

## Limits

- **14 emergencies is a small number.** 0 misses in 14 still allows a true
  miss rate up to 23.2% (95% confidence upper bound). The gate is
  necessary, not proof of safety.
- **One rater.** The reference is one physician's labels. Planned user
  testing with 5 primary care physicians will show how much physicians
  disagree with each other.
- **One run per case.** Sampling makes the result stable rather than
  strictly identical. A repeatability run on all 50 cases (`--repeat`) is
  planned, not yet done.
- **The rule floor alone under-triages quiet cases.** Without sampling, any
  case with no red flag or risk factor lands at Self-care, so the rule floor
  catches 0% of Routine cases. Its low cost score comes from never missing
  an emergency, not from routing the rest well.
- **The flag rate is not in the report yet.** The report gives the Human
  review rate. The wider share flagged for a physician (14% in the
  2026-11-05 run) feeds the cost score and is shown in the Operations view,
  but the report does not print it.

## Running it

```sh
cd eval
uv sync
COUNSEL_TOKEN=... uv run counsel-eval --url <Worker URL>
```

`COUNSEL_TOKEN` (the Worker's access token) must be set. The credit check
reads `OPENROUTER_API_KEY` from
`~/.config/counsel-disposition-agent/openrouter.env` (or the file named by
`$OPENROUTER_ENV_FILE`); without it the eval exits 3. Pass
`--skip-credit-check` to skip it.

Options: `--systems full,floor,always,historical`, `--cases all|pcp`,
`--repeat N`, `--models sonnet|flash|sonnet+flash`, `--concurrency N`.

Before a run the eval checks OpenRouter has 1.2 times the estimated spend
left, as the smaller of the key's limit and the account balance. A full
case is 1 + 2n calls, n being the policy's samples per model: 11 at 5.

| Exit code | Meaning |
|---|---|
| 0 | OK |
| 1 | The full agent routed a reference emergency below ED now in any repeat |
| 2 | The Worker's policy version differs from `policy/policy.yaml` |
| 3 | Not enough OpenRouter credit, or the balance could not be read |
| 4 | Configuration or setup error |
| 5 | Internal error |

Raw per-case results go to `data/private/runs/` (gitignored), since they
hold quotes from the messages. Committed reports hold aggregate numbers
only. `uv run python -m counsel_eval.export_experiment` strips a saved run to votes
and labels for the Operations view, and refuses to write inside a git
checkout.

The tests (`uv run pytest`) are hermetic: the Worker and OpenRouter are
mocked.
