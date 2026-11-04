"""Core baselines: always escalate, the historical labels, the rule floor.

A baseline dict has case_id, status, disposition and flagged, or case_id and
error when the call failed. Live baselines also carry meta.
"""

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

import pandas as pd

# The planner's mapping of the historical 3-way labels onto levels. ASYNC
# lands on routine and URGENT on ed_now; the report states this.
HISTORICAL_MAPPING = {
    "URGENT_ESCALATION": "ed_now",
    "ASYNC_PHYSICIAN": "routine",
    "SELF_CARE": "self_care",
}


class _Router(Protocol):

  last_meta: dict[str, Any]

  def route(self, message: str, mode: str = "full") -> dict[str, Any]:
    ...


def _baseline(case_id: str, disposition: str) -> dict[str, Any]:
  return {
      "case_id": case_id,
      "status": "routed",
      "disposition": disposition,
      "flagged": False,
  }


def always_escalate(cases: pd.DataFrame) -> list[dict[str, Any]]:
  """Sends every case to ed_now."""
  return [_baseline(c, "ed_now") for c in cases["case_id"]]


def historical(cases: pd.DataFrame) -> list[dict[str, Any]]:
  """Maps the historical label of each case through HISTORICAL_MAPPING."""
  return [
      _baseline(c, HISTORICAL_MAPPING[h])
      for c, h in zip(cases["case_id"], cases["historical"])
  ]


def rule_floor(
    cases: pd.DataFrame, client: _Router, *, concurrency: int = 4
) -> list[dict[str, Any]]:
  """Scores the Worker's deterministic floor via mode="floor_only".

  Args:
    cases: Frame with case_id and message.
    client: A RouteClient (or fake with route and last_meta).
    concurrency: Thread-pool size.

  Returns:
    One baseline dict per case, in order. A failed call is {"case_id",
    "error": <exception type name>}.
  """

  def one(row: tuple[str, str]) -> dict[str, Any]:
    case_id, message = row
    try:
      result = client.route(message, mode="floor_only")
    except Exception as e:  # pylint: disable=broad-exception-caught
      return {"case_id": case_id, "error": type(e).__name__}
    return {
        "case_id": case_id,
        "status": result["status"],
        "disposition": result["disposition"],
        "flagged": result["human_review"]["flagged"],
        "meta": dict(client.last_meta),
    }

  rows = list(zip(cases["case_id"], cases["message"]))
  with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
    return list(pool.map(one, rows))
