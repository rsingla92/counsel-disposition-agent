"""Tests for counsel_eval.baselines."""

import pandas as pd

from counsel_eval.baselines import always_escalate
from counsel_eval.baselines import historical
from counsel_eval.baselines import rule_floor
from helpers import make_result


def test_historical_baseline_mapping():
  out = historical(
      pd.DataFrame({"case_id": ["C1"], "historical": ["ASYNC_PHYSICIAN"]})
  )
  assert out[0]["disposition"] == "routine"


def test_historical_maps_all_labels():
  cases = pd.DataFrame(
      {
          "case_id": ["A", "B", "C"],
          "historical": ["URGENT_ESCALATION", "ASYNC_PHYSICIAN", "SELF_CARE"],
      }
  )
  got = [r["disposition"] for r in historical(cases)]
  assert got == ["ed_now", "routine", "self_care"]


def test_always_escalate_is_ed_now_for_every_case():
  cases = pd.DataFrame({"case_id": ["A", "B"]})
  out = always_escalate(cases)
  assert [r["case_id"] for r in out] == ["A", "B"]
  assert {r["disposition"] for r in out} == {"ed_now"}
  assert {r["status"] for r in out} == {"routed"}
  assert not any(r["flagged"] for r in out)


class _FloorClient:

  def __init__(self):
    self.modes = []
    self.last_meta = {"early": False, "latency_ms": 5.0}

  def route(self, message, mode="full"):
    self.modes.append(mode)
    if message == "boom":
      raise RuntimeError("down")
    return make_result("in_person_today")


def test_rule_floor_uses_floor_only_mode_and_records_errors():
  client = _FloorClient()
  cases = pd.DataFrame({"case_id": ["A", "B"], "message": ["ok", "boom"]})
  out = rule_floor(cases, client, concurrency=1)
  assert set(client.modes) == {"floor_only"}
  assert out[0]["disposition"] == "in_person_today"
  assert out[0]["status"] == "routed"
  assert out[1]["error"] == "RuntimeError"
