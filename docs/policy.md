# Policy

[Back to the README](../README.md)

Every clinical rule the agent follows lives in one file,
[`policy/policy.yaml`](../policy/policy.yaml), version 0.3.0. It is a draft
for physician review. The Worker bundles a copy at build time
(`npm run build-policy`), and the eval reads the same file. The eval refuses
to run if the deployed Worker reports a different version (exit code 2).

To change the policy: edit the file, bump `policy_version`, run the tests,
rerun the eval, and deploy. Nothing in the demo can change it. Live
overrides from the Operations view apply to one request and never change
the file.

## The seven levels

Most acute first. The patient message for each level is in the policy file.

| Level | Tier | Physician sees it | Patient is told |
|---|---|---|---|
| Call 911 | Emergency | Notified in parallel | Ambulance now |
| ED now | Emergency | Notified in parallel | Emergency department now (labour and delivery triage from 20 weeks of pregnancy) |
| In person today | Same day | Within 1 hour | In person within about 6 hours |
| Physician contact today | Same day | Within 2 to 4 hours | A physician conversation today; virtual is fine |
| Within a few days | Async | Within 24 hours | Assessed within 72 hours |
| Routine | Async | Standard queue | As needed |
| Self-care | Self-care | Standard queue, for sign-off | Home care now, with safety-netting |

Two statuses sit beside the levels:

- **Needs info.** The agent routed the case but names questions, or a photo,
  a physician should get. The level still stands.
- **Human review.** The agent did not route the case. A physician decides.
  If the red-flag floor was already an emergency, that level and its
  instructions go out anyway.

## Red flags

53 red flags, each with a minimum level. A flag marked present forces at
least that level, whatever the models say.

| Group | Call 911 | ED now | In person today | Physician contact today | Within a few days | Total |
|---|---|---|---|---|---|---|
| Adult | 9 | 11 | 4 | 1 | 2 | 27 |
| Pediatric | 2 | 8 | 3 | 0 | 0 | 13 |
| Obstetric | 2 | 6 | 4 | 1 | 0 | 13 |

Examples: cardiac-sounding chest pain and stroke signs happening now are Call
911; a sudden worst-ever headache and a blow to the head on a blood thinner
are ED now; pain and swelling in one calf is In person today.

Heavy bleeding outside pregnancy and the six weeks after birth has two
tiers (added in 0.2.0): with lightheadedness, fainting, a racing heart or
pale, clammy skin it is ED now; heavy menstrual bleeding (a pad or tampon
soaked every hour for two hours or more, or clots the size of a quarter or
larger) is In person today.

Five flags add a specific instruction to the patient message: the 988
crisis line for suicidal thoughts with a plan, Poison Control for a possible
ingestion by a child, and labour and delivery triage for three pregnancy
flags.

## Risk factors (modifiers)

12 risk factors, such as age 65 or older, diabetes, a blood thinner, a weak
immune system (adults and children), a baby under 3 months, and pregnancy.
If any is present, the floor rises by one level in total, not one per
factor, and never above In person today. A flag that already names the risk factor (for example a head
injury on a blood thinner) does not get an extra level for that factor.

## Cost weights

The router picks the level with the lowest expected cost. Each boundary
between two neighbouring levels has a cost for landing below the right
level (under-triage) and above it (over-triage). Crossing several
boundaries adds their costs.

| Boundary | Under : over |
|---|---|
| Call 911 / ED now | 3 : 1 |
| ED now / In person today | 20 : 1 |
| In person today / Physician contact today | 2 : 1 |
| Physician contact today / Within a few days | 5 : 1 |
| Within a few days / Routine | 2 : 1 |
| Routine / Self-care | 1.5 : 1 |

So sending a true ED-now case to In person today costs 20, and sending a
routine case to Call 911 costs 5.

A worked example. Say 3 of 5 answers say Routine and 2 say In person
today, with no floor. Choosing Routine is wrong for the 2, at a cost of 9
each (2 + 5 + 2), for an expected 3.6. Choosing Physician contact today
costs 2 for each of the 3 (two boundaries over) and 2 for each of the 2 (one
boundary under), for an expected 2.0. Choosing In person today costs 3 for
each of the 3 (three boundaries over), for an expected 1.8, the lowest. The
router picks In person today, though most answers said Routine. That is the
point: when some answers see a same-day problem, the cheaper mistake is to
look sooner.

The shared test file [`policy/cost_fixtures.json`](../policy/cost_fixtures.json)
pins the cost rule, so the Worker (TypeScript) and the eval (Python) cannot
drift apart.

## Thresholds

| Setting | Value | What it does |
|---|---|---|
| `intake.max_chars` | 4000 | Longer messages go to Human review |
| `sampling.n` | 5 | Answers per model (20 before 0.3.0; see the [stability report](../reports/2026-11-06-vote-stability.md)) |
| `sampling.temperature` | 0.7 | Spread in the answers, so they show uncertainty |
| `sampling.min_valid` | 4 | Fewer valid primary answers: Human review |
| `sampling.timeout_ms` | 15000 | Per answer |
| `extraction.timeout_ms` | 20000 | Per extraction call |
| `review.min_top_votes` | 3 | Fewer agreeing answers: flagged for a physician |
| `review.max_span` | 2 | Answers spread over more levels: flagged |
| `review.family_tier_disagreement` | true | The two models' top answers in different tiers: flagged |
| `modifier_cap` | In person today | Highest level a risk factor can raise the floor to |
| `loss.human_review_cost` | 0.2 | Added to the eval's cost score for each flagged case |

Which of these the author has confirmed and which are still open is listed
in [decisions](decisions.md#v0-calls).
