"""Tests for counsel_eval.run."""

import json
import pathlib

import httpx
import pandas as pd
import pytest

from counsel_eval import run
from counsel_eval.data import load_policy
from helpers import cases_frame
from helpers import entry
from helpers import fake_runs
from helpers import make_result
from helpers import reference_frame
from helpers import REFERENCE_LEVELS
from helpers import SENTINEL

ROOT = pathlib.Path(__file__).parents[2]
POLICY_PATH = ROOT / "policy" / "policy.yaml"
POLICY = load_policy(POLICY_PATH)
KEY_URL = "https://openrouter.ai/api/v1/key"
CREDITS_URL = "https://openrouter.ai/api/v1/credits"


def _report(runs, tmp_path, **kwargs):
  return run.write_report(
      runs,
      tmp_path,
      reference=reference_frame(),
      policy=POLICY,
      date="2026-11-03",
      **kwargs,
  )


def test_report_has_no_message_text(tmp_path):
  runs = fake_runs()
  assert SENTINEL in json.dumps(runs)  # the fake run does carry the sentinel
  path = _report(runs, tmp_path)
  text = path.read_text()
  assert SENTINEL not in text
  assert path.name == "2026-11-03-policy-0.1.0.md"


def test_report_sections_and_gate(tmp_path):
  text = _report(fake_runs(miss="C02"), tmp_path).read_text()
  assert "## full" in text
  assert "## always" in text
  assert "Misses: 1" in text
  assert "C02" in text
  assert "Loss-weight sensitivity" in text
  assert "ROC AUC" in text
  assert "HTTP errors: 0" in text
  assert "URGENT_ESCALATION" in text  # brief confusion matrix


def test_report_zero_miss_gate(tmp_path):
  text = _report(fake_runs(), tmp_path).read_text()
  assert "Misses: 0 of 2" in text


def test_report_writes_readme(tmp_path):
  _report(fake_runs(), tmp_path)
  assert "no patient text" in (tmp_path / "README.md").read_text().lower()


def test_report_notes_historical_mapping(tmp_path):
  runs = fake_runs()
  runs["historical"] = [
      {
          "case_id": c,
          "repeat": 0,
          "baseline": {
              "disposition": "routine",
              "status": "routed",
              "flagged": False,
          },
      }
      for c in REFERENCE_LEVELS
  ]
  text = _report(runs, tmp_path).read_text()
  assert "ASYNC_PHYSICIAN" in text
  assert "planner" in text


def test_http_error_scores_as_human_review_routine(tmp_path):
  runs = fake_runs()
  runs["full"][1] = {"case_id": "C02", "repeat": 0, "error": "ConnectError"}
  frame = run.entries_to_frame(runs["full"], reference_frame())
  row = frame[frame["case_id"] == "C02"].iloc[0]
  assert row["received"] == "routine"
  assert bool(row["flagged"]) is True
  assert row["status"] == "human_review"
  assert row["disposition"] is None
  text = _report(runs, tmp_path).read_text()
  assert "HTTP errors: 1" in text
  assert "Misses: 1" in text  # ed_now reference received as routine


def test_repeatability_reports_cases_below_full_agreement(tmp_path):
  runs = fake_runs()
  runs["full"] += [
      entry("C06", make_result("routine"), repeat=1),
      entry("C06", make_result("self_care"), repeat=2),
      entry("C07", make_result("self_care"), repeat=1),
      entry("C07", make_result("self_care"), repeat=2),
  ]
  # C06 has three runs: routine, routine, self_care -> 2/3 agreement.
  text = _report(runs, tmp_path, repeat=3).read_text()
  assert "Repeatability" in text
  assert "C06" in text


def test_loss_weight_sensitivity_rescores_under_weights():
  frame = run.entries_to_frame(fake_runs(miss="C02")["full"], reference_frame())
  base, half, double = run.loss_sensitivity(frame, POLICY)
  assert half < base < double


def test_roc_auc_is_na_when_class_absent():
  frame = pd.DataFrame(
      {
          "reference": ["routine", "self_care"],
          "p_emergency": [0.1, 0.0],
          "p_same_day_up": [0.1, 0.0],
      }
  )
  assert run.roc_auc(frame, "p_emergency", ["emergency"]) is None


# --- credit check -----------------------------------------------------------


def _env_file(tmp_path, key="sk-test-key"):
  path = tmp_path / "openrouter.env"
  path.write_text(f"# comment\nOPENROUTER_API_KEY={key}\nOTHER=1\n")
  return path


def test_estimate_live_calls():
  est = run.estimate_usd(["full", "floor", "always"], 10, 2, 0.01, 41)
  assert est == pytest.approx((41 + 1) * 10 * 2 * 0.01)


def _balances(respx_mock, limit, total=10_000.0, usage=0.0):
  """Mocks the key's spend limit and the account's credit balance."""
  key = respx_mock.get(KEY_URL).respond(
      200, json={"data": {"limit_remaining": limit}}
  )
  credits = respx_mock.get(CREDITS_URL).respond(
      200, json={"data": {"total_credits": total, "total_usage": usage}}
  )
  return key, credits


def test_credit_check_passes(respx_mock, tmp_path):
  _balances(respx_mock, 100)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert ok, message


def test_credit_check_refuses_and_names_both_numbers(respx_mock, tmp_path):
  _balances(respx_mock, 1.0)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert not ok
  assert "1.00" in message and "1.20" in message
  assert "sk-test-key" not in message


def test_credit_check_null_limit_passes(respx_mock, tmp_path):
  _balances(respx_mock, None)
  ok, _ = run.credit_check(1000.0, _env_file(tmp_path))
  assert ok


def test_credit_check_refuses_on_empty_account_with_no_key_limit(
    respx_mock, tmp_path
):
  # The 2026-11-04 run: the key had no limit but the account was spent, so
  # every call returned 402.
  _balances(respx_mock, None, total=50.0, usage=49.5)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert not ok
  assert "0.50" in message and "1.20" in message


def test_credit_check_uses_the_smaller_of_key_and_account(
    respx_mock, tmp_path
):
  _balances(respx_mock, 100.0, total=50.0, usage=45.0)
  ok, message = run.credit_check(10.0, _env_file(tmp_path))
  assert not ok
  assert "5.00" in message


def test_credit_check_refuses_when_account_unreadable(respx_mock, tmp_path):
  respx_mock.get(KEY_URL).respond(200, json={"data": {"limit_remaining": None}})
  respx_mock.get(CREDITS_URL).respond(500)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert not ok
  assert "could not read" in message


@pytest.mark.parametrize(
    "body",
    [
        {"data": {"total_credits": "50", "total_usage": 1.0}},
        {"data": {"total_credits": 50.0}},
        {"data": {"total_credits": 50.0, "total_usage": True}},
        {"data": None},
    ],
)
def test_credit_check_fails_closed_on_malformed_account(
    respx_mock, tmp_path, body
):
  respx_mock.get(KEY_URL).respond(200, json={"data": {"limit_remaining": None}})
  respx_mock.get(CREDITS_URL).respond(200, json=body)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert not ok
  assert "could not read credit balance" in message


def test_credit_check_sends_bearer(respx_mock, tmp_path):
  key, credits = _balances(respx_mock, None)
  run.credit_check(1.0, _env_file(tmp_path, "sk-abc"))
  assert key.calls.last.request.headers["authorization"] == "Bearer sk-abc"
  assert credits.calls.last.request.headers["authorization"] == "Bearer sk-abc"


# --- CLI --------------------------------------------------------------------


class FakeClient:
  """Stands in for RouteClient. Answers by case id parsed from the message."""

  def __init__(self, version="0.1.0", answers=None):
    self.version = version
    self.answers = answers or {}
    self.last_meta = {"early": False, "latency_ms": 1.0}
    self.calls = []

  def policy(self):
    return {"policy_version": self.version}

  def route(self, message, mode="full"):
    case_id = message.split()[-1]
    self.calls.append((case_id, mode))
    level = self.answers.get(case_id, REFERENCE_LEVELS[case_id])
    return make_result(level)


def _setup(tmp_path):
  data = tmp_path / "data"
  data.mkdir()
  cases = cases_frame().rename(
      columns={"case_id": "id", "historical": "disposition"}
  )
  cases.to_excel(data / "patient_messages_with_dispositions.xlsx", index=False)
  reference_frame().to_csv(data / "reference_labels.csv", index=False)
  return data


def _argv(tmp_path, *extra):
  if not (tmp_path / "data").exists():
    _setup(tmp_path)
  return [
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
      *extra,
  ]


ENV = {"COUNSEL_TOKEN": "tok"}


def test_cli_exits_nonzero_on_policy_version_mismatch(tmp_path):
  client = FakeClient(version="0.0.0")
  code = run.main(
      _argv(tmp_path, "--systems", "full", "--skip-credit-check"),
      client_factory=lambda url, token: client,
      env=ENV,
  )
  assert code == 2
  assert not client.calls


def test_cli_exits_nonzero_on_missed_emergency(tmp_path):
  client = FakeClient(answers={"C02": "routine"})
  code = run.main(
      _argv(tmp_path, "--systems", "full,always", "--skip-credit-check"),
      client_factory=lambda url, token: client,
      env=ENV,
  )
  assert code == 1
  assert list((tmp_path / "reports").glob("*-policy-0.1.0.md"))


def test_cli_ok_writes_runs_and_report(tmp_path):
  client = FakeClient()
  code = run.main(
      _argv(
          tmp_path,
          "--systems",
          "full,floor,always,historical",
          "--skip-credit-check",
          "--concurrency",
          "2",
      ),
      client_factory=lambda url, token: client,
      env=ENV,
  )
  assert code == 0
  stamps = list((tmp_path / "runs").iterdir())
  assert len(stamps) == 1
  names = sorted(p.name for p in stamps[0].iterdir())
  assert names == [
      "always.jsonl",
      "floor.jsonl",
      "full.jsonl",
      "historical.jsonl",
  ]
  lines = (stamps[0] / "full.jsonl").read_text().splitlines()
  assert len(lines) == 7
  assert {json.loads(x)["case_id"] for x in lines} == set(REFERENCE_LEVELS)
  assert ("C01", "floor_only") in client.calls
  report = next((tmp_path / "reports").glob("*-policy-*.md")).read_text()
  assert SENTINEL not in report


def test_cli_pcp_selects_subset(tmp_path):
  client = FakeClient()
  code = run.main(
      _argv(
          tmp_path,
          "--systems",
          "full",
          "--cases",
          "pcp",
          "--skip-credit-check",
      ),
      client_factory=lambda url, token: client,
      env=ENV,
  )
  # Of the synthetic ids only C04 is in the pcp list.
  assert code == 0
  assert client.calls == [("C04", "full")]


def test_cli_repeat_runs_each_case_n_times(tmp_path):
  client = FakeClient()
  run.main(
      _argv(
          tmp_path, "--systems", "full", "--repeat", "3", "--skip-credit-check"
      ),
      client_factory=lambda url, token: client,
      env=ENV,
  )
  assert len(client.calls) == 21
  report = next((tmp_path / "reports").glob("*-policy-*.md")).read_text()
  assert "Repeatability" in report


def test_cli_refuses_on_insufficient_credit(respx_mock, tmp_path):
  _balances(respx_mock, 1.0)
  env_file = _env_file(tmp_path)
  client = FakeClient()
  code = run.main(
      _argv(tmp_path, "--systems", "full"),
      client_factory=lambda url, token: client,
      env={**ENV, "OPENROUTER_ENV_FILE": str(env_file)},
  )
  assert code == 3
  assert not client.calls


def test_cli_credit_ok_proceeds(respx_mock, tmp_path):
  _balances(respx_mock, 500)
  env_file = _env_file(tmp_path)
  client = FakeClient()
  code = run.main(
      _argv(tmp_path, "--systems", "full"),
      client_factory=lambda url, token: client,
      env={**ENV, "OPENROUTER_ENV_FILE": str(env_file)},
  )
  assert code == 0


def test_cli_records_http_errors_without_crashing(tmp_path):
  class Flaky(FakeClient):

    def route(self, message, mode="full"):
      if message.endswith("C05"):
        raise httpx.ConnectError("down")
      return super().route(message, mode)

  code = run.main(
      _argv(tmp_path, "--systems", "full", "--skip-credit-check"),
      client_factory=lambda url, token: Flaky(),
      env=ENV,
  )
  assert code == 0
  stamp = next((tmp_path / "runs").iterdir())
  rows = [
      json.loads(x) for x in (stamp / "full.jsonl").read_text().splitlines()
  ]
  assert [r for r in rows if "error" in r] == [
      {"case_id": "C05", "repeat": 0, "error": "ConnectError"}
  ]
  report = next((tmp_path / "reports").glob("*-policy-*.md")).read_text()
  assert "HTTP errors: 1" in report


def test_cli_requires_token(tmp_path):
  code = run.main(
      _argv(tmp_path, "--systems", "always", "--skip-credit-check"),
      client_factory=lambda url, token: FakeClient(),
      env={},
  )
  assert code == 4
