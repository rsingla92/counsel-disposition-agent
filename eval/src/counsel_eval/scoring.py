"""Pure scoring functions for the disposition eval.

Per-row frames have columns case_id, reference, received, flagged (bool),
status, disposition (str | None, the result's raw disposition before the
routine substitution) and, where relevant, questions (list).
"""

from collections.abc import Iterable, Mapping
from typing import Any, Literal

import pandas as pd
from scipy import stats

from counsel_eval import levels

_EMERGENCY_REFERENCES = ("call_911", "ed_now")
_ED_RANK = levels.rank("ed_now")
_SAME_DAY_OR_ABOVE = ("emergency", "same_day")


def cost(true: str, chosen: str, policy: Mapping[str, Any]) -> float:
  """Returns the asymmetric loss of choosing `chosen` when `true` was right.

  Under-triage sums `under` and over-triage sums `over` across every loss
  boundary crossed, the same rule as the Worker.

  Args:
    true: The reference level.
    chosen: The level the agent chose.
    policy: The loaded policy dict.
  """
  true_rank = levels.rank(true)
  chosen_rank = levels.rank(chosen)
  total = 0.0
  for boundary in policy["loss"]["boundaries"]:
    high, low = boundary["between"]
    if chosen_rank < true_rank:
      crossed = (
          levels.rank(high) <= true_rank and levels.rank(low) >= chosen_rank
      )
      if crossed:
        total += boundary["under"]
    elif chosen_rank > true_rank:
      crossed = (
          levels.rank(high) <= chosen_rank and levels.rank(low) >= true_rank
      )
      if crossed:
        total += boundary["over"]
  return float(total)


def received(result: Mapping[str, Any]) -> str:
  """Returns the level a result is scored as.

  Human review with no disposition scores as routine.
  """
  return result["disposition"] or "routine"


def zero_count_ci(n: int) -> float:
  """Returns the 95% exact upper bound on a rate with 0 events in n trials."""
  return 1 - 0.025 ** (1 / n)


def gate(df: pd.DataFrame) -> dict[str, Any]:
  """Computes the zero-miss emergency gate.

  Args:
    df: Frame with case_id, reference and received.

  Returns:
    n_emergencies, misses, miss_ids and ci_upper (the exact Clopper-Pearson
    95% upper bound on the miss rate).
  """
  emergencies = df[df["reference"].isin(_EMERGENCY_REFERENCES)]
  missed = emergencies[emergencies["received"].map(levels.rank) < _ED_RANK]
  n = len(emergencies)
  x = len(missed)
  if n == 0:
    ci_upper = float("nan")
  elif x == 0:
    ci_upper = zero_count_ci(n)
  elif x == n:
    ci_upper = 1.0
  else:
    ci_upper = float(stats.beta.ppf(0.975, x + 1, n - x))
  return {
      "n_emergencies": n,
      "misses": x,
      "miss_ids": missed["case_id"].tolist(),
      "ci_upper": ci_upper,
  }


def cost_score(df: pd.DataFrame, policy: Mapping[str, Any]) -> float:
  """Returns mean cost plus the human review penalty.

  Args:
    df: Frame with reference, received and flagged (bool).
    policy: The loaded policy dict.
  """
  costs = [cost(t, c, policy) for t, c in zip(df["reference"], df["received"])]
  mean_cost = sum(costs) / len(costs)
  review = policy["loss"]["human_review_cost"]
  return mean_cost + review * float(df["flagged"].astype(bool).mean())


def confusion(
    df: pd.DataFrame, axis: Literal["level", "tier", "brief"]
) -> pd.DataFrame:
  """Returns a reference-by-received count matrix.

  Args:
    df: Frame with reference and received.
    axis: Granularity: the seven levels, the four tiers or the brief labels.
  """
  if axis == "level":
    order = list(levels.LEVELS)
    mapper = str
  elif axis == "tier":
    order = list(dict.fromkeys(levels.tier(x) for x in levels.LEVELS))
    mapper = levels.tier
  elif axis == "brief":
    order = list(dict.fromkeys(levels.brief_label(x) for x in levels.LEVELS))
    mapper = levels.brief_label
  else:
    raise ValueError(f"unknown axis: {axis}")
  ref = pd.Categorical(df["reference"].map(mapper), categories=order)
  got = pd.Categorical(df["received"].map(mapper), categories=order)
  matrix = pd.crosstab(
      pd.Series(ref, name="reference"),
      pd.Series(got, name="received"),
      dropna=False,
  )
  return matrix


def per_class(df: pd.DataFrame) -> pd.DataFrame:
  """Returns per-reference-level sensitivity and over-triage rate.

  Sensitivity is the share received at or above the reference level; the
  over-triage rate is the share received strictly above it.

  Args:
    df: Frame with reference and received.

  Returns:
    A frame indexed by level with columns n, sensitivity, over_triage_rate.
  """
  rows = {}
  for level in levels.LEVELS:
    sub = df[df["reference"] == level]
    ranks = sub["received"].map(levels.rank)
    ref_rank = levels.rank(level)
    n = len(sub)
    rows[level] = {
        "n": n,
        "sensitivity": float((ranks >= ref_rank).mean()) if n else float("nan"),
        "over_triage_rate": (
            float((ranks > ref_rank).mean()) if n else float("nan")
        ),
    }
  return pd.DataFrame.from_dict(rows, orient="index")


def abstention(df: pd.DataFrame) -> dict[str, float]:
  """Returns the human review and needs-info rates.

  Args:
    df: Frame with status.
  """
  return {
      "human_review_rate": float((df["status"] == "human_review").mean()),
      "needs_info_rate": float((df["status"] == "needs_info").mean()),
  }


def faithfulness(results: Iterable[Mapping[str, Any]]) -> float:
  """Returns the share of present-flag excerpts that were verified.

  Args:
    results: Worker result dicts. Returns 1.0 when no flag is present.
  """
  flags = [
      flag
      for result in results
      for flag in result.get("red_flags", [])
      if flag["state"] == "present"
  ]
  if not flags:
    return 1.0
  return sum(bool(f["excerpt_verified"]) for f in flags) / len(flags)


def error_stage(row: Mapping[str, Any]) -> str | None:
  """Attributes a miss to a pipeline stage, or None if there is no error.

  Args:
    row: Mapping with the per-row frame fields status, disposition (the
      result's raw disposition or None, before the routine substitution),
      reference and received, plus optionally info (reference needs info),
      questions and unverified_excerpt.

  Returns:
    One of scope, emergency_detection, emergent_vs_same_day,
    missing_information, explanation, or None.

  Raises:
    KeyError: If the row has no disposition key.
  """
  disposition = row["disposition"]
  if row["status"] == "human_review" and disposition is None:
    return "scope"
  reference, got = row["reference"], row["received"]
  if reference in _EMERGENCY_REFERENCES and levels.rank(got) < _ED_RANK:
    return "emergency_detection"
  tiers = (levels.tier(reference), levels.tier(got))
  if (
      tiers[0] in _SAME_DAY_OR_ABOVE
      and tiers[1] in _SAME_DAY_OR_ABOVE
      and tiers[0] != tiers[1]
  ):
    return "emergent_vs_same_day"
  if row.get("info") and not row.get("questions"):
    return "missing_information"
  if row.get("unverified_excerpt"):
    return "explanation"
  return None
