# Disposition agent

This agent reads one asynchronous patient message and picks one of seven
urgency levels, from Call 911 to Self-care, with a justification a physician
can check against the patient's own words. It never routes an emergency
lower than its safety rules allow. Cases it cannot route (a failure, or a
message out of scope) go to Human review. Cases where its answers split or
disagree are still routed, but flagged for a physician to check.

- **Live demo (synthetic messages only):**
  <https://counsel-disposition-web.counsel-demo.workers.dev>
- **Design docs:** [architecture](docs/architecture.md),
  [policy](docs/policy.md), [eval](docs/eval.md),
  [decisions](docs/decisions.md),
  [reliability roadmap](docs/reliability-roadmap.md),
  [rate limits](docs/rate-limits.md)

## How it works

A Cloudflare Worker runs every message through the same steps. The demo and
the Python eval both call this one Worker, so the demo shows exactly what
the eval measures.

```mermaid
flowchart TD
  A["Patient message"] --> B{"1. Intake:<br/>over 4,000 characters?"}
  B -- yes --> HR["Human review"]
  B -- no --> C["2. Extraction: one model call reads<br/>every red flag and risk factor"]
  C -- fails --> HR
  C --> D["3. Rule floor: red flags set<br/>the lowest allowed level"]
  D -- floor is ED now or Call 911 --> E["Emergency instructions<br/>sent at once"]
  D --> F{"4. Scope:<br/>English? a care request?"}
  F -- no --> HR
  F -- yes --> G["6. Sampling: 20 answers from Sonnet<br/>and 20 from Gemini Flash, in parallel"]
  G --> H["7. Decide: lowest expected cost at or above<br/>the floor; flag split or disagreeing answers"]
  H -- too few valid answers --> HR
  H --> I["8. Explain: justification,<br/>safety-netting, patient message"]
  I --> R["Result: level, flags, excerpts, votes, trace"]
```

Step 5 is a floor-only exit that the eval uses as a baseline. Every failure
ends at Human review. If the floor was already ED now or Call 911, Human
review keeps it, so a failure never lowers an emergency. The main gap left:
if extraction fails on both models, there is no floor and no early emergency
message ([reliability roadmap](docs/reliability-roadmap.md)).
[Architecture](docs/architecture.md) has the detail.

## Results

From [the policy 0.1.0 report](reports/2026-11-04-policy-0.1.0.md): 50
cases reviewed blind by a physician, 14 of them emergencies (Call 911 or
ED now). Aggregate numbers only.

<!-- RERUN -->
<!-- The full-agent row comes from run 2 (2026-11-04 15:55 UTC), before the
stricter extraction rule. Update it from the 50-case rerun. -->

| System | Missed emergencies | Sent to Human review (not routed) | Cost score (lower is better) |
|---|---|---|---|
| **Full agent** (Sonnet + Flash) | **0 of 14** | **12%** | **0.80** |
| Rule floor only | 0 of 14 | 0% | 1.19 |
| Always escalate to ED | 0 of 14 | 0% | 2.52 |
| Historical dispositions | 4 of 14 | 0% | 4.12 |

From the 2026-11-04 run, before the stricter extraction rule; a rerun is in
progress.

<!-- /RERUN -->

The cost score is the average cost per case of routing mistakes, weighted
so under-triage costs more than over-triage, plus 0.2 for every case flagged
for a physician. The "Sent to Human review" column counts only cases the
agent did not route. The wider share, Human review plus routed cases flagged
for a check, is the "Flagged for physician review" rate in the demo's
Operations view. With 14 emergencies, 0 misses still allows a true miss
rate of up to 23% (95% confidence). [Eval](docs/eval.md) explains the
metrics, the other conditions tested and their limits.

## Run it

Needs Node 22 and [uv](https://docs.astral.sh/uv/) with Python 3.11.

```sh
# Tests (hermetic: every model call is mocked)
cd worker && npm ci && npm test && cd ..
node --test 'web/test/*.test.mjs'
cd eval && uv sync && uv run pytest && cd ..

# The Worker locally. worker/.dev.vars (gitignored) holds
# OPENROUTER_API_KEY=... and ACCESS_TOKEN=...
cd worker && npm run build-policy && npx wrangler dev

# The eval against it (needs Counsel's cases in data/private/). COUNSEL_TOKEN
# must be set. The credit check reads OPENROUTER_API_KEY from
# ~/.config/counsel-disposition-agent/openrouter.env (or $OPENROUTER_ENV_FILE);
# without it the eval exits 3, unless you pass --skip-credit-check.
cd eval && COUNSEL_TOKEN=... uv run counsel-eval --url http://localhost:8787
```

## Data notice

Counsel's patient messages and labels are not in this repo and never will
be. The eval reads them from a local, gitignored folder, and committed
reports hold aggregate numbers only. Every message in the demo was written
for this project and is synthetic. The demo is not medical advice. Logs
never contain message text or IP addresses.
