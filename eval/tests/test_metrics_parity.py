"""Pins the eval metrics to the fixture the Worker's TypeScript port also uses."""

import json
import pathlib

import pandas as pd
import pytest

from counsel_eval import levels
from counsel_eval.data import load_policy
from counsel_eval.scoring import abstention
from counsel_eval.scoring import cost_score
from counsel_eval.scoring import gate
from counsel_eval.scoring import received

FIXTURE = (
    pathlib.Path(__file__).parents[2]
    / "schema"
    / "fixtures"
    / "metrics-parity.json"
)
POLICY = pathlib.Path(__file__).parents[2] / "policy" / "policy.yaml"


def test_python_metrics_match_parity_fixture():
  fixture = json.loads(FIXTURE.read_text())
  expected = fixture["expected"]
  policy = {**load_policy(POLICY), "loss": fixture["policy_loss"]}
  df = pd.DataFrame(
      [
          {
              "case_id": c["id"],
              "reference": c["reference"],
              "received": received(c),
              "flagged": c["flagged"],
              "status": c["status"],
          }
          for c in fixture["cases"]
      ]
  )
  g = gate(df)
  rates = abstention(df)
  over = sum(
      levels.rank(got) > levels.rank(ref)
      for got, ref in zip(df["received"], df["reference"])
  ) / len(df)

  assert len(df) == expected["n"]
  assert g["n_emergencies"] == expected["emergencies"]
  assert g["misses"] == expected["missed"]
  assert rates["human_review_rate"] == pytest.approx(
      expected["human_review_rate"], abs=1e-9
  )
  assert rates["needs_info_rate"] == pytest.approx(
      expected["needs_info_rate"], abs=1e-9
  )
  assert over == pytest.approx(expected["over_triage_rate"], abs=1e-9)
  assert float(df["flagged"].astype(bool).mean()) == pytest.approx(
      expected["flagged_rate"], abs=1e-9
  )
  assert cost_score(df, policy) == pytest.approx(
      expected["cost_score"], abs=1e-9
  )
