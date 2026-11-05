# Decisions

[Back to the README](../README.md)

## The fourteen design decisions

Settled in the PRD before the build. D13 and D14 were stretch goals.

| # | Topic | Decision | In V0 |
|---|---|---|---|
| D1 | Levels | Seven plain-language levels from Call 911 to Self-care, plus the statuses Needs info and Human review. | Built |
| D2 | Architecture | Extract clinical findings first, apply a rule floor, then route, so explanations rest on what the message says. | Built |
| D3 | Final level | An expected-cost router picks the level, never below the rule floor. | Built |
| D4 | Uncertainty | 20 samples from each of two model families; low agreement or disagreement between families sends the case to a physician. | Built |
| D5 | Autonomy | Asymmetric: emergency instructions go out at once, while lower levels wait for physician sign-off. | Built |
| D6 | Ground truth | The author's blind review of all 50 cases is the reference, with the historical labels kept beside it. | Built |
| D7 | Headline metric | A zero-miss gate on emergencies first, then a cost-weighted score, with confusion matrices, ROC and subscores as secondary outcomes. | Built |
| D8 | Stack | A static demo page plus a Cloudflare Worker, using existing libraries (Hono, Zod, pandas, scikit-learn). | Changed: the demo is served by a second Cloudflare Worker instead of GitHub Pages |
| D9 | Model access | OpenRouter with the provider pinned, fallbacks off, and zero-data-retention providers only. | Built |
| D10 | Baselines | A ladder of simpler systems to show what each layer adds. | Core rungs built (always escalate, rule floor, historical); random forest and logistic regression rungs not built |
| D11 | User testing | 5 primary care physicians and 5 lay testers, with hypotheses set in advance. | Planned |
| D12 | Repo workflow | One reviewed pull request per task, short and plain, with hermetic tests. | Followed |
| D13 | Clarifying questions | A bounded agent that asks up to three questions below Emergency (stretch). | Not built; V0 names the questions only |
| D14 | Patient context | A retriever for problem list, medications and allergies that can add risk factors but never lower a floor (stretch). | Not built; V0 routes on the message alone |

## V0 calls

Calls the planner made where the PRD left a gap.

**Confirmed by the author on 2026-11-03:**

- The under : over ratio between In person today and Physician contact
  today is 2 : 1. The PRD gave none.
- A risk factor raises the floor by one level in total, never above In
  person today.
- Three Call 911 red flags were added that the PRD's forced-911 list names
  but its table did not cover: airway or breathing compromise, altered
  consciousness, and an ongoing seizure.
- Repeatability is measured on all 50 cases, not a subset.

**Still open for the author:**

- `min_valid` 15: how many of 20 primary answers must be valid to route.
- Temperature 0.7 for the samples.
- `max_chars` 4000 at intake.
- The historical-baseline mapping: urgent escalation to ED now, async
  physician to Routine, self-care to Self-care.
- `human_review_cost` 0.2 in the cost score.
- Red flags with an unverified quote keep their flag (and count toward the
  floor), and the case is flagged for review.

## Later decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-03 | Justifications have no length limit. | Overrides the PRD's three-sentence cap; a physician needs the reasoning for one level up and one down. |
| 2026-11-04 | At most 3 model calls in flight per case. | At 6, rate limits sent half the cases to Human review. See [rate limits](rate-limits.md). |
| 2026-11-04 | Stripped per-case records (votes, floor, reason codes, reference level; no message text) live in Workers KV namespace `EXPERIMENTS`, for the Operations view. | Re-scoring needs per-case votes, and they must never sit in the public repo. **Delete the namespace after the 2026-11-12 presentation** (`wrangler kv namespace delete`). |
| 2026-11-04 | Live routes in the demo honour the Operations view's model and settings, but can never land an emergency below the deployed policy. | Lets the audience see a setting change live without any safety cost. |
| 2026-11-05 | If the primary model's extraction fails, the case ends at Human review even when the secondary's extraction succeeds. The secondary's reading only sets red-flag floors and the early emergency message. | The user's decision after a Codex review finding. A failed primary extraction is a failure, so it ends with a physician. |
| 2026-11-05 | The live demo routes with Sonnet + Flash. | Sonnet alone hit rate limits; Flash alone timed out on extraction. |
| V0 | No per-request LLM tracing to an outside vendor. | It would copy every prompt and response to another company, against the zero-data-retention rule. The Worker's own trace covers V0. See the [roadmap](reliability-roadmap.md#phase-3-observability). |
