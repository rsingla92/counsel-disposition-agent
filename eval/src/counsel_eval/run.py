"""The eval CLI: run systems against the Worker, score, write the report.

Raw per-case results go to data/private/runs/ (gitignored, they carry
message-derived excerpts). The committed report is aggregate only: counts
and rates, never case ids, message text, excerpts or justifications.

Exit codes: see EXIT_CODES_HELP.
"""

import argparse
import collections
import copy
import datetime
import json
import os
import pathlib
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import numpy as np
import pandas as pd
from sklearn import metrics

from counsel_eval import baselines
from counsel_eval import data
from counsel_eval import levels
from counsel_eval import scoring
from counsel_eval.client import RouteClient

ROOT = pathlib.Path(__file__).parents[3]
SYSTEMS = ("full", "floor", "always", "historical")
PCP_IDS = frozenset(
    ["C04", "C08", "C09", "C12", "C16", "C17", "C23", "C26", "C35", "C39"]
)
EXIT_MISSED_EMERGENCY = 1
EXIT_POLICY_MISMATCH = 2
EXIT_NO_CREDIT = 3
EXIT_CONFIG = 4
EXIT_INTERNAL = 5
EXIT_CODES_HELP = """\
exit codes:
  0  ok
  1  the full system routed a reference emergency below ed_now in any repeat
  2  Worker policy version differs from policy/policy.yaml
  3  insufficient (or unreadable) OpenRouter credit
  4  configuration or setup error (arguments, token, data, Worker unreachable,
     report not writable)
  5  internal error
"""

MODELS_CHOICES = ("sonnet", "flash", "sonnet+flash")
_SINGLE_MODELS = ("sonnet", "flash")
_OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
_OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
_DEFAULT_ENV_FILE = "~/.config/counsel-disposition-agent/openrouter.env"
_CREDIT_MARGIN = 1.2
_STAGES = (
    "scope",
    "emergency_detection",
    "emergent_vs_same_day",
    "missing_information",
    "explanation",
)
_EMERGENCY_TOP = ("call_911", "ed_now")
_SAME_DAY_UP = _EMERGENCY_TOP + ("in_person_today", "physician_contact_today")
_README = """# Reports

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
"""


# --- credit check -----------------------------------------------------------


def read_env_file(path: str | os.PathLike[str]) -> dict[str, str]:
  """Reads KEY=VALUE lines, ignoring blanks and comments."""
  out = {}
  with open(os.path.expanduser(path), encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line or line.startswith("#") or "=" not in line:
        continue
      key, _, value = line.partition("=")
      out[key.strip()] = value.strip().strip("'\"")
  return out


def live_calls_per_case(system: str, calls_per_case: int) -> int:
  """Returns the OpenRouter calls one case costs on a system."""
  return {"full": calls_per_case, "floor": 1}.get(system, 0)


def effective_calls_per_case(
    models: str | None, explicit: int | None, n: int
) -> int:
  """Returns the OpenRouter calls one full case costs.

  Args:
    models: The --models flag, or None.
    explicit: The --calls-per-case flag, or None. It wins when given.
    n: The policy's samples per model (sampling.n).

  One extraction, then n samples from each model sampled.
  """
  if explicit is not None:
    return explicit
  return 1 + n * (1 if models in _SINGLE_MODELS else 2)


def estimate_usd(
    systems: Sequence[str],
    n_cases: int,
    repeats: int,
    per_call_usd: float,
    calls_per_case: int,
) -> float:
  """Returns the estimated OpenRouter spend for a run."""
  calls = sum(live_calls_per_case(s, calls_per_case) for s in systems)
  return calls * n_cases * repeats * per_call_usd


def _is_number(x: object) -> bool:
  return isinstance(x, (int, float)) and not isinstance(x, bool)


def credit_check(
    estimate: float, env_file: str | os.PathLike[str]
) -> tuple[bool, str]:
  """Checks OpenRouter has at least 1.2 x the estimate left to spend.

  What is left is the smaller of the key's spend limit and the account's
  credit balance: a key with no limit still fails with 402 once the account
  is spent. The key is read from `env_file` and never printed or returned.

  Args:
    estimate: Estimated spend in USD.
    env_file: KEY=VALUE file holding OPENROUTER_API_KEY.

  Returns:
    (ok, message). A null key limit means the account balance alone counts.
  """
  try:
    key = read_env_file(env_file)["OPENROUTER_API_KEY"]
  except (OSError, KeyError):
    return False, "OPENROUTER_API_KEY not found in the env file"
  headers = {"Authorization": f"Bearer {key}"}
  try:
    response = httpx.get(_OPENROUTER_KEY_URL, headers=headers, timeout=15.0)
    response.raise_for_status()
    limit = response.json()["data"]["limit_remaining"]
    if limit is not None and not _is_number(limit):
      return False, "could not read credit balance (non-numeric limit)"
    response = httpx.get(_OPENROUTER_CREDITS_URL, headers=headers, timeout=15.0)
    response.raise_for_status()
    account = response.json()["data"]
    total, usage = account["total_credits"], account["total_usage"]
  except (httpx.HTTPError, KeyError, TypeError, ValueError) as e:
    return False, f"could not read credit balance ({type(e).__name__})"
  if not (_is_number(total) and _is_number(usage)):
    return False, "could not read credit balance (non-numeric balance)"
  remaining = total - usage
  if limit is not None:
    remaining = min(remaining, limit)
  required = _CREDIT_MARGIN * estimate
  if remaining < required:
    return False, (
        f"insufficient OpenRouter credit: ${remaining:.2f} remaining, "
        f"${required:.2f} required (1.2 x estimated ${estimate:.2f})"
    )
  return True, f"${remaining:.2f} remaining, ${required:.2f} required"


# --- running ----------------------------------------------------------------


class Pacer:
  """Starts calls at least gap_s seconds apart, across threads.

  Spacing cases keeps each model's calls under the provider's per-minute
  rate limit, so a run measures routing rather than the limit.
  """

  def __init__(
      self,
      gap_s: float,
      clock: Callable[[], float] | None = None,
      sleep: Callable[[float], None] | None = None,
  ):
    self._gap = gap_s
    self._clock = clock or time.monotonic
    self._sleep = sleep or time.sleep
    self._lock = threading.Lock()
    self._next: float | None = None

  def wait(self) -> None:
    """Blocks until gap_s after the previous start, then records this one."""
    if self._gap <= 0:
      return
    with self._lock:
      now = self._clock()
      if self._next is not None and now < self._next:
        self._sleep(self._next - now)
        now = self._next
      self._next = now + self._gap


def _call_full(
    client: Any,
    tasks: Sequence[tuple[str, str, int]],
    concurrency: int,
    models: str | None = None,
    pacer: Pacer | None = None,
) -> list[dict[str, Any]]:
  def one(task: tuple[str, str, int]) -> dict[str, Any]:
    case_id, message, repeat = task
    if pacer is not None:
      pacer.wait()
    try:
      if models is None:
        result = client.route(message)
      else:
        result = client.route(message, models=models)
    except Exception as e:  # pylint: disable=broad-exception-caught
      return {"case_id": case_id, "repeat": repeat, "error": type(e).__name__}
    return {
        "case_id": case_id,
        "repeat": repeat,
        "result": result,
        "meta": {**client.last_meta, "models": models or "default"},
    }

  with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
    return list(pool.map(one, tasks))


def _as_entry(base: Mapping[str, Any], repeat: int) -> dict[str, Any]:
  out = {"case_id": base["case_id"], "repeat": repeat}
  if "error" in base:
    out["error"] = base["error"]
    return out
  out["baseline"] = {k: base[k] for k in ("status", "disposition", "flagged")}
  if "meta" in base:
    out["meta"] = base["meta"]
  return out


def run_system(
    system: str,
    cases: pd.DataFrame,
    client: Any,
    *,
    repeat: int,
    concurrency: int,
    models: str | None = None,
    pacer: Pacer | None = None,
) -> list[dict[str, Any]]:
  """Runs one system and returns its saved-run entries.

  Args:
    system: One of SYSTEMS.
    cases: Frame with case_id and message.
    client: The route client.
    repeat: Repeats per case.
    concurrency: Worker threads.
    models: Model override for the full system only; other systems ignore it.
    pacer: Spaces the full system's case starts; other systems ignore it.
  """
  if system == "full":
    tasks = [
        (c, m, r)
        for r in range(repeat)
        for c, m in zip(cases["case_id"], cases["message"])
    ]
    return _call_full(client, tasks, concurrency, models, pacer)
  if system == "floor":
    out = []
    for r in range(repeat):
      for base in baselines.rule_floor(cases, client, concurrency=concurrency):
        out.append(_as_entry(base, r))
    return out
  fn = {
      "always": baselines.always_escalate,
      "historical": baselines.historical,
  }[system]
  return [_as_entry(b, 0) for b in fn(cases)]


# --- scoring ----------------------------------------------------------------


def _shares(votes: Mapping[str, int], keys: Sequence[str]) -> float:
  total = sum(votes.values())
  return sum(votes[k] for k in keys) / total if total else 0.0


def entries_to_frame(
    entries: Sequence[Mapping[str, Any]], reference: pd.DataFrame
) -> pd.DataFrame:
  """Builds the per-row scoring frame from saved-run entries.

  Failed calls score as Human review with no disposition (received routine,
  flagged). Cases absent from `reference` are dropped, so headline numbers
  come only from the reviewed cases.

  Args:
    entries: Saved-run entries.
    reference: Frame with case_id, level and info.
  """
  ref = reference.set_index("case_id")
  rows = []
  for e in entries:
    if e["case_id"] not in ref.index:
      continue
    row: dict[str, Any] = {
        "case_id": e["case_id"],
        "repeat": e.get("repeat", 0),
        "reference": ref.at[e["case_id"], "level"],
        "info": bool(ref.at[e["case_id"], "info"]),
        "questions": [],
        "unverified_excerpt": False,
        "http_error": False,
        "schema_mismatch": False,
        "p_emergency": np.nan,
        "p_same_day_up": np.nan,
        "early": np.nan,
        "latency_ms": np.nan,
    }
    meta = e.get("meta") or {}
    if "latency_ms" in meta:
      row["latency_ms"] = float(meta["latency_ms"])
      row["early"] = float(bool(meta.get("early")))
    if "error" in e:
      mismatch = e["error"] == "SchemaMismatch"
      row.update(
          status="human_review",
          disposition=None,
          flagged=True,
          http_error=not mismatch,
          schema_mismatch=mismatch,
      )
    elif "result" in e:
      result = e["result"]
      primary = result["votes"]["primary"]
      row.update(
          status=result["status"],
          disposition=result["disposition"],
          flagged=bool(result["human_review"]["flagged"]),
          questions=result["info_requests"]["questions"],
          unverified_excerpt=(
              "unverified_excerpt" in result["human_review"]["reasons"]
          ),
          p_emergency=_shares(primary, _EMERGENCY_TOP),
          p_same_day_up=_shares(primary, _SAME_DAY_UP),
      )
    else:
      b = e["baseline"]
      row.update(
          status=b["status"],
          disposition=b["disposition"],
          flagged=bool(b["flagged"]),
      )
    row["received"] = row["disposition"] or "routine"
    failed = row["http_error"] or row["schema_mismatch"]
    row["stage"] = None if failed else scoring.error_stage(row)
    rows.append(row)
  frame = pd.DataFrame(rows)
  frame["disposition"] = frame["disposition"].astype(object)
  frame.loc[frame["disposition"].isna(), "disposition"] = None
  return frame


def loss_sensitivity(
    frame: pd.DataFrame, policy: Mapping[str, Any]
) -> tuple[float, float, float]:
  """Returns the cost score at the policy weights, with `under` x0.5 and x2."""
  scores = []
  for factor in (1.0, 0.5, 2.0):
    scaled = copy.deepcopy(dict(policy))
    for boundary in scaled["loss"]["boundaries"]:
      boundary["under"] = boundary["under"] * factor
    scores.append(scoring.cost_score(frame, scaled))
  return scores[0], scores[1], scores[2]


def roc_auc(
    frame: pd.DataFrame, score_col: str, positive_tiers: Sequence[str]
) -> float | None:
  """Returns one-vs-rest ROC AUC, or None when a class is absent."""
  sub = frame[frame[score_col].notna()]
  if sub.empty:
    return None
  y = sub["reference"].map(levels.tier).isin(positive_tiers)
  if y.nunique() < 2:
    return None
  return float(metrics.roc_auc_score(y, sub[score_col]))


def any_repeat_gate(frame: pd.DataFrame) -> dict[str, Any]:
  """Returns the gate counting a case missed if any repeat missed it.

  n is the number of distinct emergency cases, so repeats of one message are
  not treated as independent samples.
  """
  worst = frame.loc[
      frame.groupby("case_id")["received"]
      .apply(lambda s: s.map(levels.rank).idxmin())
      .to_numpy()
  ]
  return scoring.gate(worst)


def repeatability(frame: pd.DataFrame) -> tuple[float, dict[str, float]] | None:
  """Returns mean agreement with the modal disposition and the laggards."""
  if frame.groupby("case_id").size().max() < 2:
    return None
  agreement = {}
  for case_id, group in frame.groupby("case_id"):
    modal = group["received"].mode().sort_values().iloc[0]
    agreement[case_id] = float((group["received"] == modal).mean())
  below = {c: a for c, a in agreement.items() if a < 1.0}
  return float(np.mean(list(agreement.values()))), below


# --- report -----------------------------------------------------------------


def _pct(x: float) -> str:
  return "n/a" if x is None or pd.isna(x) else f"{100 * x:.1f}%"


def _num(x: float | None, digits: int = 3) -> str:
  return "n/a" if x is None or pd.isna(x) else f"{x:.{digits}f}"


def _md_table(df: pd.DataFrame, corner: str) -> list[str]:
  header = [corner, *[str(c) for c in df.columns]]
  lines = ["| " + " | ".join(header) + " |"]
  lines.append("|" + "|".join(["---"] * len(header)) + "|")
  for index, row in df.iterrows():
    cells = [str(index), *[str(v) for v in row]]
    lines.append("| " + " | ".join(cells) + " |")
  return lines


def _system_section(
    system: str,
    entries: Sequence[Mapping[str, Any]],
    reference: pd.DataFrame,
    policy: Mapping[str, Any],
    repeat: int,
) -> list[str]:
  all_runs = entries_to_frame(entries, reference)
  out = [f"## {system}", ""]
  if all_runs.empty:
    return out + ["No scored rows.", ""]
  frame = all_runs[all_runs["repeat"] == 0]
  g = scoring.gate(frame)
  a = any_repeat_gate(all_runs)
  out += [
      "### Gate (zero-miss emergencies)",
      "",
      f"- Misses: {g['misses']} of {g['n_emergencies']} reference emergency "
      "cases routed below ed_now (first run)",
      "- 95% CI upper bound on the miss rate: " + _pct(g["ci_upper"]),
      f"- Missed in any repeat: {a['misses']} of {a['n_emergencies']} "
      "reference emergency cases",
      "- 95% CI upper bound on the any-repeat miss rate: "
      + _pct(a["ci_upper"]),
      "",
  ]
  base, half, double = loss_sensitivity(frame, policy)
  out += [
      f"Cost score (mean cost + human review penalty): {_num(base)}",
      "",
      "### Confusion matrices (rows reference, columns received)",
      "",
  ]
  for axis in ("level", "tier", "brief"):
    out += [f"**{axis}**", ""]
    out += _md_table(scoring.confusion(frame, axis), "reference") + [""]
  pc = scoring.per_class(frame)
  pc_table = pd.DataFrame(
      {
          "n": pc["n"],
          "sensitivity": pc["sensitivity"].map(_pct),
          "over-triage": pc["over_triage_rate"].map(_pct),
      }
  )
  out += ["### Per-class sensitivity and over-triage", ""]
  out += _md_table(pc_table, "level") + [""]
  ab = scoring.abstention(frame)
  out += [
      "### Abstention",
      "",
      f"- Human review rate: {_pct(ab['human_review_rate'])}",
      f"- Needs-info rate: {_pct(ab['needs_info_rate'])}",
      "",
  ]
  results = [
      e["result"] for e in entries if "result" in e and e.get("repeat", 0) == 0
  ]
  if results:
    out += [
        "### Faithfulness",
        "",
        "Share of present-flag excerpts verified: "
        + _pct(scoring.faithfulness(results)),
        "",
        "### ROC AUC (one-vs-rest, primary vote share)",
        "",
        "- Emergency: " + _num(roc_auc(frame, "p_emergency", ["emergency"])),
        "- Emergency + Same day: "
        + _num(roc_auc(frame, "p_same_day_up", ["emergency", "same_day"])),
        "",
    ]
  counts = collections.Counter(s for s in frame["stage"] if s)
  out += ["### Error counts by stage", ""]
  out += [f"- {stage}: {counts.get(stage, 0)}" for stage in _STAGES]
  out += [
      f"- HTTP errors: {int(frame['http_error'].sum())}",
      f"- Schema mismatches: {int(frame['schema_mismatch'].sum())}",
      "",
  ]
  timed = frame[frame["latency_ms"].notna()]
  if not timed.empty:
    emerg = timed[timed["reference"].isin(_EMERGENCY_TOP)]
    out += [
        "### Latency and early event (client-measured)",
        "",
        f"- Median latency: {timed['latency_ms'].median():.0f} ms",
        f"- p95 latency: {np.percentile(timed['latency_ms'], 95):.0f} ms",
        "- Early-event rate on emergency-reference cases: "
        + (_pct(emerg["early"].mean()) if len(emerg) else "n/a"),
        "",
    ]
  out += [
      "### Loss-weight sensitivity (cost score, re-scored from saved runs)",
      "",
      f"- Policy weights: {_num(base)}",
      f"- Every `under` weight x0.5: {_num(half)}",
      f"- Every `under` weight x2: {_num(double)}",
      "",
  ]
  if system == "historical":
    out += [
        "Historical mapping note: the historical labels are 3-way. The "
        "planner's mapping is URGENT_ESCALATION to ed_now, ASYNC_PHYSICIAN "
        "to routine and SELF_CARE to self_care; level-axis results for this "
        "system reflect that mapping, not a clinical judgement.",
        "",
    ]
  if repeat > 1:
    rep = repeatability(all_runs)
    out += ["### Repeatability", ""]
    if rep is None:
      out += ["n/a (single run per case)", ""]
    else:
      mean, below = rep
      out += [
          f"- Mean per-case agreement with the modal disposition: {_pct(mean)}",
          f"- Cases below 100%: {len(below)}",
          "",
      ]
  return out


def _cohort_line(cohort: str, scored: Sequence[str]) -> str:
  n = len(scored)
  noun = "case" if n == 1 else "cases"
  if cohort == "all":
    return f"Cohort: all ({n} {noun})"
  return f"Cohort: {cohort} subset ({n} {noun})"


def write_report(
    runs: Mapping[str, Sequence[Mapping[str, Any]]],
    out_dir: str | os.PathLike[str],
    *,
    reference: pd.DataFrame,
    policy: Mapping[str, Any],
    date: str | None = None,
    repeat: int = 1,
    cohort: str = "all",
) -> pathlib.Path:
  """Writes the aggregate-only markdown report and returns its path.

  The header names the cohort and the number of distinct case ids scored at
  repeat 0. Pass a `reference` restricted to the selected cases for a subset.

  Args:
    runs: System name to saved-run entries.
    out_dir: Directory for the report (and reports/README.md).
    reference: Reference labels frame.
    policy: The loaded policy dict.
    date: YYYY-MM-DD; defaults to today (UTC).
    repeat: Repeats per case in the run.
  """
  out_dir = pathlib.Path(out_dir)
  out_dir.mkdir(parents=True, exist_ok=True)
  date = date or datetime.datetime.now(datetime.timezone.utc).strftime(
      "%Y-%m-%d"
  )
  version = policy["policy_version"]
  known = set(reference["case_id"])
  scored = sorted(
      {
          e["case_id"]
          for entries in runs.values()
          for e in entries
          if e.get("repeat", 0) == 0 and e["case_id"] in known
      }
  )
  readme = out_dir / "README.md"
  if not readme.exists():
    readme.write_text(_README, encoding="utf-8")
  lines = [
      f"# Disposition eval, policy {version}",
      "",
      f"Date: {date}. Repeats per case: {repeat}.",
      "",
      _cohort_line(cohort, scored),
      "",
      *(["Subset run — not a headline result.", ""] if cohort != "all" else []),
      "Aggregate only: counts and rates. Headline metrics use the first "
      "run of each case; repeats feed the any-repeat gate line and the "
      "repeatability section only.",
      "",
  ]
  for system in SYSTEMS:
    if system in runs:
      lines += _system_section(system, runs[system], reference, policy, repeat)
  path = out_dir / f"{date}-policy-{version}.md"
  path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
  return path


# --- CLI --------------------------------------------------------------------


class _Parser(argparse.ArgumentParser):
  """Exits with EXIT_CONFIG on bad arguments (argparse's 2 is taken)."""

  def error(self, message: str):
    self.print_usage(sys.stderr)
    print(f"error: {message}", file=sys.stderr)
    sys.exit(EXIT_CONFIG)


def _non_negative(text: str) -> float:
  """An argparse type: a float of at least 0."""
  value = float(text)
  if value < 0:
    raise argparse.ArgumentTypeError("must be at least 0")
  return value


def build_parser() -> argparse.ArgumentParser:
  """Returns the CLI argument parser."""
  p = _Parser(
      prog="counsel-eval",
      description="Run the disposition eval against a Worker.",
      epilog=EXIT_CODES_HELP,
      formatter_class=argparse.RawDescriptionHelpFormatter,
  )
  p.add_argument("--url", required=True, help="Worker base URL")
  p.add_argument("--systems", default="full,floor,always,historical")
  p.add_argument("--cases", choices=["all", "pcp"], default="all")
  p.add_argument("--repeat", type=int, default=1)
  p.add_argument("--concurrency", type=int, default=4)
  p.add_argument(
      "--gap-s",
      type=_non_negative,
      default=0.0,
      help="Seconds between full-agent case starts (rate limits)",
  )
  p.add_argument("--skip-credit-check", action="store_true")
  p.add_argument("--per-call-usd", type=float, default=0.0075)
  p.add_argument(
      "--calls-per-case",
      type=int,
      default=None,
      help="credit-estimate calls per full case (default 1 + 2n, or 1 + n "
      "when --models is sonnet or flash, n being the policy's sampling.n)",
  )
  p.add_argument(
      "--models",
      choices=MODELS_CHOICES,
      default=None,
      help="run the full system with one model or both (default: Worker's)",
  )
  p.add_argument("--data-dir", default=str(ROOT / "data" / "private"))
  p.add_argument("--runs-dir", default=None)
  p.add_argument("--reports-dir", default=str(ROOT / "reports"))
  p.add_argument("--policy", default=str(ROOT / "policy" / "policy.yaml"))
  return p


def main(
    argv: Sequence[str] | None = None,
    *,
    client_factory: Callable[[str, str], Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
  """Runs the eval and returns the exit code (see EXIT_CODES_HELP)."""
  try:
    return _main(argv, client_factory, env)
  except Exception as e:  # pylint: disable=broad-exception-caught
    print(f"internal error ({type(e).__name__})", file=sys.stderr)
    return EXIT_INTERNAL


def _main(
    argv: Sequence[str] | None,
    client_factory: Callable[[str, str], Any] | None,
    env: Mapping[str, str] | None,
) -> int:
  args = build_parser().parse_args(argv)
  env = os.environ if env is None else env
  token = env.get("COUNSEL_TOKEN")
  if not token:
    print("COUNSEL_TOKEN is not set", file=sys.stderr)
    return EXIT_CONFIG
  systems = [s.strip() for s in args.systems.split(",") if s.strip()]
  unknown = [s for s in systems if s not in SYSTEMS]
  if unknown or args.repeat < 1:
    print(f"bad arguments: systems {unknown}, repeat {args.repeat}")
    return EXIT_CONFIG

  data_dir = pathlib.Path(args.data_dir)
  try:
    policy = data.load_policy(args.policy)
    _ = policy["policy_version"]
    reference = data.load_reference(data_dir / "reference_labels.csv")
    cases = data.load_cases(
        data_dir / "patient_messages_with_dispositions.xlsx"
    )
    cases = cases[cases["case_id"].isin(reference["case_id"])]
  except Exception as e:  # pylint: disable=broad-exception-caught
    return _config_error("cannot load policy or case data", e)
  if args.cases == "pcp":
    cases = cases[cases["case_id"].isin(PCP_IDS)]
  if cases.empty:
    print("no cases selected", file=sys.stderr)
    return EXIT_CONFIG
  cases = cases.reset_index(drop=True)

  factory = client_factory or RouteClient
  client = factory(args.url, token)
  try:
    served = client.policy()["policy_version"]
  except Exception as e:  # pylint: disable=broad-exception-caught
    return _config_error("cannot read the Worker policy version", e)
  if served != policy["policy_version"]:
    print(
        f"policy version mismatch: Worker {served}, local "
        f"{policy['policy_version']}",
        file=sys.stderr,
    )
    return EXIT_POLICY_MISMATCH

  estimate = estimate_usd(
      systems,
      len(cases),
      args.repeat,
      args.per_call_usd,
      effective_calls_per_case(
          args.models, args.calls_per_case, policy["sampling"]["n"]
      ),
  )
  if not args.skip_credit_check and estimate > 0:
    env_file = env.get("OPENROUTER_ENV_FILE", _DEFAULT_ENV_FILE)
    ok, message = credit_check(estimate, env_file)
    print(f"credit check: {message}")
    if not ok:
      return EXIT_NO_CREDIT

  stamp = datetime.datetime.now(datetime.timezone.utc).strftime(
      "%Y%m%dT%H%M%SZ"
  )
  runs_dir = pathlib.Path(args.runs_dir or data_dir / "runs") / stamp
  runs_dir.mkdir(parents=True, exist_ok=True)
  runs = {}
  for system in systems:
    entries = run_system(
        system,
        cases,
        client,
        repeat=args.repeat,
        concurrency=args.concurrency,
        models=args.models,
        pacer=Pacer(args.gap_s),
    )
    runs[system] = entries
    with open(runs_dir / f"{system}.jsonl", "w", encoding="utf-8") as f:
      for e in entries:
        f.write(json.dumps(e) + "\n")

  try:
    report = write_report(
        runs,
        args.reports_dir,
        reference=reference[reference["case_id"].isin(cases["case_id"])],
        policy=policy,
        repeat=args.repeat,
        cohort=args.cases,
    )
  except Exception as e:  # pylint: disable=broad-exception-caught
    return _config_error("cannot write the report", e)
  print(f"report: {report}")
  if "full" in runs:
    g = any_repeat_gate(entries_to_frame(runs["full"], reference))
    print(
        f"full gate (missed in any repeat): {g['misses']} of "
        f"{g['n_emergencies']}"
    )
    if g["misses"]:
      return EXIT_MISSED_EMERGENCY
  return 0


def _config_error(what: str, error: Exception) -> int:
  """Prints a fixed one-line message (never the error text) and returns 4."""
  print(f"error: {what} ({type(error).__name__})", file=sys.stderr)
  return EXIT_CONFIG


def cli() -> None:
  """Console-script entry point."""
  sys.exit(main())


if __name__ == "__main__":
  cli()
