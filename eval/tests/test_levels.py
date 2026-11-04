"""Tests for counsel_eval.levels."""

import pathlib

from counsel_eval import data
from counsel_eval import levels

POLICY = pathlib.Path(__file__).parents[2] / "policy" / "policy.yaml"


def test_rank_runs_from_self_care_to_call_911():
  assert levels.rank("self_care") == 0
  assert levels.rank("call_911") == 6
  assert levels.rank("ed_now") == 5


def test_tier_and_brief_label():
  assert levels.tier("ed_now") == "emergency"
  assert levels.tier("physician_contact_today") == "same_day"
  assert levels.tier("routine") == "async"
  assert levels.brief_label("in_person_today") == "URGENT_ESCALATION"
  assert levels.brief_label("within_few_days") == "ASYNC_PHYSICIAN"
  assert levels.brief_label("self_care") == "SELF_CARE"


def test_levels_match_policy_boundary_order():
  boundaries = data.load_policy(POLICY)["loss"]["boundaries"]
  implied = [boundaries[0]["between"][0]]
  implied += [b["between"][1] for b in boundaries]
  for prev, b in zip(implied, boundaries):
    assert b["between"][0] == prev
  assert tuple(implied) == levels.LEVELS
