# Reports

Eval reports in this directory are aggregate only: counts and rates. They
contain no case ids, no patient text, no message excerpts and no model
justification text. Raw per-case results live under `data/private/runs/`,
which is gitignored.

Headline metrics use the first run of each case. The gate also reports
cases missed in any repeat. `counsel-eval` exit codes:

- 0 ok
- 1 the full system routed a reference emergency below ed_now in any repeat
- 2 Worker policy version differs from `policy/policy.yaml`
- 3 insufficient (or unreadable) OpenRouter credit
- 4 configuration or setup error
- 5 internal error
