"""Tests for counsel_eval.scoring."""

import json
import pathlib

import pandas as pd
import pytest

from counsel_eval.data import load_policy
from counsel_eval.scoring import abstention
from counsel_eval.scoring import confusion
from counsel_eval.scoring import cost
from counsel_eval.scoring import cost_score
from counsel_eval.scoring import error_stage
from counsel_eval.scoring import faithfulness
from counsel_eval.scoring import gate
from counsel_eval.scoring import per_class
from counsel_eval.scoring import received
from counsel_eval.scoring import zero_count_ci

POLICY = pathlib.Path(__file__).parents[2] / "policy" / "policy.yaml"
FIXTURES = pathlib.Path(__file__).parents[2] / "policy" / "cost_fixtures.json"


def _frame(rows):
  return pd.DataFrame(
      rows, columns=["case_id", "reference", "received", "flagged"]
  )


def test_cost_matches_shared_fixtures():
  policy = load_policy(POLICY)
  for f in json.loads(FIXTURES.read_text()):
    assert cost(f["true"], f["chosen"], policy) == pytest.approx(f["cost"])


def test_zero_count_ci_for_14_emergencies():
  assert zero_count_ci(14) == pytest.approx(0.2316, abs=1e-4)


def test_gate_counts_a_miss_below_ed():
  df = pd.DataFrame(
      {
          "case_id": ["C08", "C02"],
          "reference": ["ed_now", "call_911"],
          "received": ["in_person_today", "ed_now"],
      }
  )
  assert gate(df)["miss_ids"] == ["C08"]


def test_gate_zero_misses_uses_zero_count_ci():
  df = pd.DataFrame(
      {
          "case_id": ["C02", "C08", "C01"],
          "reference": ["call_911", "ed_now", "self_care"],
          "received": ["call_911", "call_911", "self_care"],
      }
  )
  g = gate(df)
  assert g["n_emergencies"] == 2
  assert g["misses"] == 0
  assert g["ci_upper"] == pytest.approx(zero_count_ci(2))


def test_gate_ci_with_a_miss_is_clopper_pearson():
  df = pd.DataFrame(
      {
          "case_id": ["a", "b"],
          "reference": ["ed_now", "ed_now"],
          "received": ["routine", "ed_now"],
      }
  )
  # Exact upper bound for 1 of 2 at 95%.
  assert gate(df)["ci_upper"] == pytest.approx(0.9874, abs=1e-4)


def test_received_treats_bare_human_review_as_routine():
  assert received({"status": "human_review", "disposition": None}) == "routine"
  assert received({"status": "routed", "disposition": "ed_now"}) == "ed_now"


def test_cost_score_adds_human_review_penalty():
  policy = load_policy(POLICY)
  df = _frame(
      [
          ("a", "ed_now", "ed_now", True),
          ("b", "routine", "self_care", False),
      ]
  )
  # mean cost = (0 + 1.5) / 2; flagged share = 0.5; penalty = 0.2 * 0.5.
  assert cost_score(df, policy) == pytest.approx(0.75 + 0.1)


def test_confusion_axes():
  df = _frame(
      [
          ("a", "call_911", "ed_now", False),
          ("b", "routine", "within_few_days", False),
      ]
  )
  by_level = confusion(df, "level")
  assert by_level.loc["call_911", "ed_now"] == 1
  by_tier = confusion(df, "tier")
  assert by_tier.loc["emergency", "emergency"] == 1
  by_brief = confusion(df, "brief")
  assert by_brief.loc["ASYNC_PHYSICIAN", "ASYNC_PHYSICIAN"] == 1


def test_per_class_sensitivity_and_over_triage():
  df = _frame(
      [
          ("a", "ed_now", "call_911", False),
          ("b", "ed_now", "ed_now", False),
          ("c", "ed_now", "routine", False),
          ("d", "ed_now", "in_person_today", False),
      ]
  )
  row = per_class(df).loc["ed_now"]
  assert row["n"] == 4
  assert row["sensitivity"] == pytest.approx(0.5)
  assert row["over_triage_rate"] == pytest.approx(0.25)


def test_abstention_rates():
  df = pd.DataFrame(
      {"status": ["routed", "human_review", "needs_info", "routed"]}
  )
  a = abstention(df)
  assert a["human_review_rate"] == pytest.approx(0.25)
  assert a["needs_info_rate"] == pytest.approx(0.25)


def test_faithfulness_counts_present_flags_only():
  results = [
      {
          "red_flags": [
              {
                  "id": "x",
                  "state": "present",
                  "excerpt": "a",
                  "excerpt_verified": True,
              },
              {
                  "id": "y",
                  "state": "present",
                  "excerpt": "b",
                  "excerpt_verified": False,
              },
              {
                  "id": "z",
                  "state": "absent",
                  "excerpt": None,
                  "excerpt_verified": False,
              },
          ]
      }
  ]
  assert faithfulness(results) == pytest.approx(0.5)
  assert faithfulness([{"red_flags": []}]) == 1.0


@pytest.mark.parametrize(
    "row,expected",
    [
        (
            {
                "status": "human_review",
                "disposition": None,
                "reference": "routine",
                "received": "routine",
            },
            "scope",
        ),
        (
            {
                "status": "routed",
                "reference": "ed_now",
                "received": "in_person_today",
            },
            "emergency_detection",
        ),
        (
            {
                "status": "routed",
                "reference": "in_person_today",
                "received": "ed_now",
            },
            "emergent_vs_same_day",
        ),
        (
            {
                "status": "needs_info",
                "reference": "routine",
                "received": "routine",
                "info": True,
                "questions": [],
            },
            "missing_information",
        ),
        (
            {
                "status": "routed",
                "reference": "routine",
                "received": "routine",
                "unverified_excerpt": True,
            },
            "explanation",
        ),
        (
            {"status": "routed", "reference": "routine", "received": "routine"},
            None,
        ),
    ],
)
def test_error_stage(row, expected):
  assert error_stage(row) == expected
