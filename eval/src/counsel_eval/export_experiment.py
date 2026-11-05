"""Exports one saved run as an Experiment for the Worker's Operations view.

The output holds per-case votes and pipeline inputs, so the Worker can
re-score the run under other router settings without calling a model. It
never holds message text, justifications, excerpts, questions, raw model
output or patient replies. It is written outside any git checkout (the repo
is public); the Worker reads it from KV.

Usage:
  python -m counsel_eval.export_experiment --run <stamp> --system full|floor \
      --id <id> --label <text> --out <path outside any checkout>

Exit codes: 0 ok, 2 --out inside the repo or any git checkout, 4 bad
arguments or data.
"""

import argparse
import json
import os
import pathlib
import re
import statistics
import sys
from collections.abc import Mapping, Sequence
from typing import Any

import pandas as pd

from counsel_eval import data
from counsel_eval import levels
from counsel_eval import run
from counsel_eval import scoring

EXIT_OUT_IN_REPO = 2
EXIT_CONFIG = 4

# Matches EXPERIMENT_ID in worker/src/index.ts.
_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# A Human review for one of these reasons happened before the votes, so a
# re-score keeps it (sampling_failed alone is re-decided by the Worker).
_FIXED_REASONS = frozenset(
    [
        "extraction_failed",
        "sampling_failed",
        "too_long",
        "non_english",
        "out_of_scope",
        "schema_invalid",
    ]
)
# Reasons the Worker's decide() derives from the votes and the extraction.
_DERIVED_REASONS = frozenset(
    [
        "split_vote",
        "wide_spread",
        "family_disagreement",
        "secondary_unavailable",
        "missing_info",
        "photo_needed",
        "sampling_failed",
    ]
)


def _empty_votes() -> dict[str, int]:
  return {level: 0 for level in levels.LEVELS}


def _votes(raw: Mapping[str, Any] | None) -> dict[str, int] | None:
  if raw is None:
    return None
  return {level: int(raw.get(level, 0)) for level in levels.LEVELS}


def _latency(e: Mapping[str, Any]) -> float | None:
  meta = e.get("meta") or {}
  return float(meta["latency_ms"]) if "latency_ms" in meta else None


def _human_review(disposition: str | None, reasons: list[str]) -> dict:
  return {
      "status": "human_review",
      "disposition": disposition,
      "reasons": reasons,
  }


def in_checkout(path: pathlib.Path) -> bool:
  """True when `path` or an ancestor holds a .git directory or file.

  A worktree's .git is a file, and a worktree can sit inside the main
  checkout, so the nearest repo root alone is not enough.

  Args:
    path: An absolute, resolved path.
  """
  return any(os.path.lexists(p / ".git") for p in (path, *path.parents))


def record(e: Mapping[str, Any], reference: str) -> dict[str, Any]:
  """Returns the Experiment record for one saved-run entry.

  Args:
    e: A saved-run entry with result, baseline (floor system) or error.
    reference: The case's reference level.
  """
  out: dict[str, Any] = {
      "case_id": e["case_id"],
      "reference": reference,
      "fixed": None,
      "floor": "self_care",
      "primary": _empty_votes(),
      "secondary": None,
      "questions": 0,
      "photo": False,
      "base_reasons": [],
      "latency_ms": _latency(e) or 0.0,
  }
  if "result" in e:
    result = e["result"]
    reasons = list(result["human_review"]["reasons"])
    primary = _votes(result["votes"]["primary"])
    out.update(
        floor=result["floor"] or "self_care",
        primary=primary,
        secondary=_votes(result["votes"]["secondary"]),
        questions=len(result["info_requests"]["questions"]),
        photo=bool(result["info_requests"]["photo"]),
        base_reasons=[r for r in reasons if r not in _DERIVED_REASONS],
    )
    no_votes = sum(primary.values()) == 0
    if result["status"] == "human_review" and (
        no_votes or _FIXED_REASONS.intersection(reasons)
    ):
      out["fixed"] = _human_review(result["disposition"], reasons)
  elif "baseline" in e:
    b = e["baseline"]
    out["floor"] = b["disposition"] or "self_care"
    if b["status"] == "human_review":
      out["fixed"] = _human_review(b["disposition"], [])
  else:
    # A failed call scores as Human review with no disposition.
    out["fixed"] = _human_review(None, [])
  return out


def summary(frame: pd.DataFrame, policy: Mapping[str, Any]) -> dict[str, Any]:
  """Returns the Worker's Summary from a scoring frame.

  The definitions match worker/src/metrics.ts and
  schema/fixtures/metrics-parity.json.

  Args:
    frame: A run.entries_to_frame frame, one row per case.
    policy: The loaded policy dict.
  """
  g = scoring.gate(frame)
  rates = scoring.abstention(frame)
  over = [
      levels.rank(got) > levels.rank(ref)
      for got, ref in zip(frame["received"], frame["reference"])
  ]
  columns = [*levels.LEVELS, "human_review"]
  confusion = {ref: {c: 0 for c in columns} for ref in levels.LEVELS}
  for ref, got, status in zip(
      frame["reference"], frame["received"], frame["status"]
  ):
    confusion[ref]["human_review" if status == "human_review" else got] += 1
  return {
      "n": len(frame),
      "emergencies": g["n_emergencies"],
      "missed": g["misses"],
      "human_review_rate": rates["human_review_rate"],
      "needs_info_rate": rates["needs_info_rate"],
      "over_triage_rate": sum(over) / len(over),
      "flagged_rate": float(frame["flagged"].astype(bool).mean()),
      "cost_score": scoring.cost_score(frame, policy),
      "confusion": confusion,
  }


def experiment(
    entries: Sequence[Mapping[str, Any]],
    reference: pd.DataFrame,
    policy: Mapping[str, Any],
    *,
    system: str,
    exp_id: str,
    label: str,
) -> dict[str, Any]:
  """Builds the Experiment from the repeat-0 entries of reviewed cases."""
  levels_by_case = dict(zip(reference["case_id"], reference["level"]))
  first = [
      e
      for e in entries
      if e.get("repeat", 0) == 0 and e["case_id"] in levels_by_case
  ]
  if not first:
    raise ValueError("no reviewed cases at repeat 0")
  frame = run.entries_to_frame(first, reference)
  timed = [t for t in map(_latency, first) if t is not None]
  models = sorted(
      {(e.get("meta") or {}).get("models", "default") for e in first}
  )
  return {
      "id": exp_id,
      "label": label,
      "models": "floor_only" if system == "floor" else "+".join(models),
      "rescorable": system == "full",
      "records": [record(e, levels_by_case[e["case_id"]]) for e in first],
      "summary": summary(frame, policy),
      "median_latency_ms": float(statistics.median(timed)) if timed else 0.0,
  }


def build_parser() -> argparse.ArgumentParser:
  """Returns the CLI argument parser."""
  p = argparse.ArgumentParser(
      prog="python -m counsel_eval.export_experiment",
      description="Export a saved run as an Experiment for the Worker.",
  )
  p.add_argument("--run", required=True, help="saved run stamp")
  p.add_argument("--system", required=True, choices=["full", "floor"])
  p.add_argument("--id", required=True)
  p.add_argument("--label", required=True)
  p.add_argument(
      "--out", required=True, help="output path outside any checkout"
  )
  p.add_argument("--data-dir", default=str(run.ROOT / "data" / "private"))
  p.add_argument("--runs-dir", default=None, help="default: <data-dir>/runs")
  p.add_argument("--policy", default=str(run.ROOT / "policy" / "policy.yaml"))
  return p


def main(argv: Sequence[str] | None = None) -> int:
  """Writes the Experiment JSON and returns the exit code."""
  args = build_parser().parse_args(argv)
  out = pathlib.Path(args.out).resolve()
  # resolve() follows symlinks, so a link into a checkout is caught too.
  if out.is_relative_to(run.ROOT.resolve()) or in_checkout(out):
    print("error: --out must be outside any git checkout", file=sys.stderr)
    return EXIT_OUT_IN_REPO
  if not _ID.match(args.id):
    print("error: --id must match [A-Za-z0-9._-]{1,64}", file=sys.stderr)
    return EXIT_CONFIG
  data_dir = pathlib.Path(args.data_dir)
  runs_dir = pathlib.Path(args.runs_dir or data_dir / "runs")
  try:
    policy = data.load_policy(args.policy)
    reference = data.load_reference(data_dir / "reference_labels.csv")
    path = runs_dir / args.run / f"{args.system}.jsonl"
    with open(path, encoding="utf-8") as f:
      entries = [json.loads(line) for line in f if line.strip()]
    exp = experiment(
        entries,
        reference,
        policy,
        system=args.system,
        exp_id=args.id,
        label=args.label,
    )
  except (OSError, ValueError, KeyError, TypeError) as e:
    # A fixed message: never the error text, which may quote saved data.
    print(f"error: cannot export the run ({type(e).__name__})", file=sys.stderr)
    return EXIT_CONFIG
  out.parent.mkdir(parents=True, exist_ok=True)
  out.write_text(json.dumps(exp, allow_nan=False) + "\n", encoding="utf-8")
  print(f"wrote {out}")
  return 0


if __name__ == "__main__":
  sys.exit(main())
