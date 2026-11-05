"""Tests that the report names the evaluated cohort and its size."""

import re

import pandas as pd

from counsel_eval import levels
from counsel_eval import run
from helpers import make_result
from helpers import SENTINEL
from test_run import ENV
from test_run import FakeClient
from test_run import POLICY_PATH


def _fifty(tmp_path):
  """Writes 50 synthetic cases cycling through the seven levels."""
  ids = [f"C{i:02d}" for i in range(1, 51)]
  lv = {c: levels.LEVELS[i % 7] for i, c in enumerate(ids)}
  data = tmp_path / "data"
  data.mkdir()
  pd.DataFrame(
      {
          "id": ids,
          "message": [f"{SENTINEL} {c}" for c in ids],
          "disposition": ["ASYNC_PHYSICIAN"] * 50,
      }
  ).to_excel(data / "patient_messages_with_dispositions.xlsx", index=False)
  pd.DataFrame(
      {
          "case_id": ids,
          "level": [lv[c] for c in ids],
          "info": False,
          "photo": False,
          "time_sensitive": False,
      }
  ).to_csv(data / "reference_labels.csv", index=False)
  return lv


class _Client(FakeClient):

  def __init__(self, lv):
    super().__init__()
    self.lv = lv

  def route(self, message, mode="full"):
    case_id = message.split()[-1]
    self.calls.append((case_id, mode))
    return make_result(self.lv[case_id])


def _run(tmp_path, cases):
  lv = _fifty(tmp_path)
  code = run.main(
      [
          "--url",
          "https://worker.test",
          "--data-dir",
          str(tmp_path / "data"),
          "--runs-dir",
          str(tmp_path / "runs"),
          "--reports-dir",
          str(tmp_path / "reports"),
          "--policy",
          str(POLICY_PATH),
          "--systems",
          "full,always",
          "--cases",
          cases,
          "--skip-credit-check",
      ],
      client_factory=lambda url, token: _Client(lv),
      env=ENV,
  )
  assert code == 0
  return next((tmp_path / "reports").glob("*-policy-*.md")).read_text()


def test_pcp_report_names_subset_and_warns(tmp_path):
  text = _run(tmp_path, "pcp")
  assert "Cohort: pcp subset (10 cases)" in text
  assert re.search(r"C\d\d", text) is None
  assert "Subset run — not a headline result." in text
  assert "Reviewed cases: 50" not in text
  for n in re.findall(r"of (\d+) reference emergency cases", text):
    assert int(n) <= 10


def test_all_report_says_fifty_and_has_no_warning(tmp_path):
  text = _run(tmp_path, "all")
  assert "Cohort: all (50 cases)" in text
  assert "Subset run" not in text
