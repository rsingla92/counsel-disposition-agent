"""Synthetic fixtures for the runner tests. No real messages."""

import json
from typing import Any

import pandas as pd

from counsel_eval import levels

SENTINEL = "SECRET MESSAGE"


def make_result(
    disposition: str | None,
    *,
    status: str = "routed",
    flagged: bool = False,
    reasons: tuple[str, ...] = (),
    questions: tuple[str, ...] = (),
    text: str = "synthetic",
    votes: dict[str, int] | None = None,
) -> dict[str, Any]:
  """Builds a RouteResult that satisfies the JSON schema."""
  primary = {level: 0 for level in levels.LEVELS}
  if votes is not None:
    primary.update(votes)
  elif disposition is not None:
    primary[disposition] = 20
  return {
      "status": status,
      "disposition": disposition,
      "tier": levels.tier(disposition) if disposition else None,
      "brief_label": levels.brief_label(disposition) if disposition else None,
      "floor": None,
      "red_flags": [
          {
              "id": "synthetic_flag",
              "state": "present",
              "excerpt": text,
              "excerpt_verified": True,
          }
      ],
      "modifiers": [],
      "votes": {"primary": primary, "secondary": None},
      "confidence": 0.9 if disposition else None,
      "human_review": {"flagged": flagged, "reasons": list(reasons)},
      "info_requests": {"questions": list(questions), "photo": False},
      "time_sensitive": False,
      "justification": text,
      "safety_net": text,
      "patient_message": text,
      "trace": {
          "input_sha256": "0" * 64,
          "policy_version": "0.1.0",
          "models": [{"model": "m", "provider": "p"}],
          "latency_ms": 12.0,
          "raw": {"note": text},
      },
  }


VALID_RESULT = make_result("ed_now")

REFERENCE_LEVELS = {
    "C01": "call_911",
    "C02": "ed_now",
    "C03": "in_person_today",
    "C04": "physician_contact_today",
    "C05": "within_few_days",
    "C06": "routine",
    "C07": "self_care",
}


def reference_frame() -> pd.DataFrame:
  """Returns a synthetic reference frame, one case per level."""
  return pd.DataFrame(
      {
          "case_id": list(REFERENCE_LEVELS),
          "level": list(REFERENCE_LEVELS.values()),
          "info": [False] * 7,
          "photo": [False] * 7,
          "time_sensitive": [False] * 7,
      }
  )


def cases_frame() -> pd.DataFrame:
  """Returns synthetic cases; the message is a harmless stand-in."""
  return pd.DataFrame(
      {
          "case_id": list(REFERENCE_LEVELS),
          "message": [f"{SENTINEL} {c}" for c in REFERENCE_LEVELS],
          "historical": [
              "URGENT_ESCALATION",
              "URGENT_ESCALATION",
              "URGENT_ESCALATION",
              "ASYNC_PHYSICIAN",
              "ASYNC_PHYSICIAN",
              "ASYNC_PHYSICIAN",
              "SELF_CARE",
          ],
      }
  )


def entry(
    case_id: str, result: dict[str, Any], repeat: int = 0, **meta: Any
) -> dict[str, Any]:
  """Builds one saved-run entry."""
  return {
      "case_id": case_id,
      "repeat": repeat,
      "result": result,
      "meta": {"early": False, "latency_ms": 100.0, **meta},
  }


def fake_runs(miss: str | None = None) -> dict[str, list[dict[str, Any]]]:
  """Returns saved runs for full and always; `miss` is routed as routine."""
  full = []
  for case_id, level in REFERENCE_LEVELS.items():
    got = "routine" if case_id == miss else level
    full.append(
        entry(
            case_id,
            make_result(got, text=f"{SENTINEL} {case_id}"),
            early=level in ("call_911", "ed_now"),
        )
    )
  always = [
      {
          "case_id": c,
          "repeat": 0,
          "baseline": {
              "disposition": "ed_now",
              "status": "routed",
              "flagged": False,
          },
      }
      for c in REFERENCE_LEVELS
  ]
  return {"full": full, "always": always}


def ndjson(*events: dict[str, Any]) -> str:
  """Encodes events as an NDJSON body."""
  return "".join(json.dumps(e) + "\n" for e in events)
