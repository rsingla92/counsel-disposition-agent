"""Tests for repeat handling, exit-code mapping and error accounting."""

import collections
import json
import re
import threading

import httpx
import pytest

from counsel_eval import run
from counsel_eval.client import SchemaMismatch
from helpers import fake_runs
from helpers import make_result
from helpers import reference_frame
from helpers import SENTINEL
from test_run import _argv
from test_run import _env_file
from test_run import _report
from test_run import ENV
from test_run import FakeClient
from test_run import KEY_URL


class FlakyOnThirdCall(FakeClient):
  """Routes C02 below ed_now only on its third (repeat 2) call."""

  def __init__(self):
    super().__init__()
    self._seen = collections.Counter()
    self._lock = threading.Lock()

  def route(self, message, mode="full"):
    case_id = message.split()[-1]
    with self._lock:
      self._seen[case_id] += 1
      nth = self._seen[case_id]
    if case_id == "C02" and nth == 3:
      return make_result("routine")
    return super().route(message, mode)


def _run_cli(tmp_path, client, *extra, env=None):
  return run.main(
      _argv(tmp_path, "--systems", "full", "--skip-credit-check", *extra),
      client_factory=lambda url, token: client,
      env=ENV if env is None else env,
  )


def _full_rows(tmp_path):
  stamp = next((tmp_path / "runs").iterdir())
  return [
      json.loads(x) for x in (stamp / "full.jsonl").read_text().splitlines()
  ]


def _read_report(tmp_path):
  return next((tmp_path / "reports").glob("*-policy-*.md")).read_text()


# --- item 1: repeats --------------------------------------------------------


def test_repeat_headline_uses_first_run_and_any_repeat_gate_is_stricter(
    tmp_path,
):
  code = _run_cli(
      tmp_path, FlakyOnThirdCall(), "--repeat", "3", "--concurrency", "1"
  )
  assert code == 1
  report = _read_report(tmp_path)
  assert "Misses: 0 of 2 reference emergency cases" in report
  assert "of 6" not in report
  assert "Missed in any repeat: 1 of 2" in report
  assert "miss ids" not in report
  assert re.search(r"C\d\d", report) is None
  assert "headline metrics use the first run" in report.lower()
  assert "case-runs" not in report


def test_repeat_one_gates_are_identical(tmp_path):
  text = _report(fake_runs(miss="C02"), tmp_path).read_text()
  assert "Misses: 1 of 2" in text
  assert "Missed in any repeat: 1 of 2" in text


# --- item 2: exit codes -----------------------------------------------------


def test_unreachable_worker_exits_config(respx_mock, tmp_path):
  respx_mock.get("https://worker.test/v1/policy").mock(
      side_effect=httpx.ConnectError("down")
  )
  code = run.main(
      _argv(tmp_path, "--systems", "full", "--skip-credit-check"), env=ENV
  )
  assert code == 4


def test_worker_bad_status_exits_config(respx_mock, tmp_path):
  respx_mock.get("https://worker.test/v1/policy").respond(401)
  code = run.main(
      _argv(tmp_path, "--systems", "full", "--skip-credit-check"), env=ENV
  )
  assert code == 4


def test_missing_policy_version_exits_config(tmp_path, capsys):
  class NoVersion(FakeClient):

    def policy(self):
      return {}

  assert _run_cli(tmp_path, NoVersion()) == 4
  assert "KeyError" in capsys.readouterr().err


def test_missing_data_files_exit_config(tmp_path):
  argv = [
      "--url",
      "https://worker.test",
      "--data-dir",
      str(tmp_path / "nowhere"),
      "--systems",
      "always",
  ]
  code = run.main(argv, client_factory=lambda u, t: FakeClient(), env=ENV)
  assert code == 4


def test_report_write_failure_exits_config(tmp_path):
  _argv(tmp_path)  # create the synthetic data
  (tmp_path / "reports").write_text("a file, not a directory")
  assert _run_cli(tmp_path, FakeClient()) == 4


def test_unexpected_exception_exits_internal(tmp_path, monkeypatch, capsys):
  def boom(*args, **kwargs):
    raise RuntimeError(f"{SENTINEL} leak")

  monkeypatch.setattr(run, "run_system", boom)
  assert _run_cli(tmp_path, FakeClient()) == 5
  err = capsys.readouterr().err
  assert "internal error (RuntimeError)" in err
  assert SENTINEL not in err


def test_bad_arguments_exit_4():
  with pytest.raises(SystemExit) as info:
    run.build_parser().parse_args(["--cases", "nonsense", "--url", "u"])
  assert info.value.code == 4


def test_help_lists_exit_codes(capsys):
  with pytest.raises(SystemExit) as info:
    run.build_parser().parse_args(["--help"])
  assert info.value.code == 0
  out = capsys.readouterr().out
  for code in "012345":
    assert f"  {code}  " in out


@pytest.mark.parametrize(
    "body",
    [
        {"data": {"limit_remaining": "abc"}},
        {"data": {}},
        {"data": None},
        [],
        {"data": {"limit_remaining": True}},
    ],
)
def test_credit_check_fails_closed_on_malformed_balance(
    respx_mock, tmp_path, body
):
  respx_mock.get(KEY_URL).respond(200, json=body)
  ok, message = run.credit_check(1.0, _env_file(tmp_path))
  assert not ok
  assert "could not read credit balance" in message
  assert "sk-test-key" not in message


def test_cli_malformed_balance_exits_no_credit(respx_mock, tmp_path):
  respx_mock.get(KEY_URL).respond(
      200, json={"data": {"limit_remaining": "abc"}}
  )
  client = FakeClient()
  code = run.main(
      _argv(tmp_path, "--systems", "full"),
      client_factory=lambda url, token: client,
      env={**ENV, "OPENROUTER_ENV_FILE": str(_env_file(tmp_path))},
  )
  assert code == 3
  assert not client.calls


# --- item 3: schema mismatches ----------------------------------------------


def test_schema_mismatch_counted_separately_from_http_errors(tmp_path):
  class Mismatch(FakeClient):

    def route(self, message, mode="full"):
      if message.endswith("C05"):
        raise SchemaMismatch("bad")
      return super().route(message, mode)

  assert _run_cli(tmp_path, Mismatch()) == 0
  rows = _full_rows(tmp_path)
  assert {"case_id": "C05", "repeat": 0, "error": "SchemaMismatch"} in rows
  report = _read_report(tmp_path)
  assert "HTTP errors: 0" in report
  assert "Schema mismatches: 1" in report


def test_schema_mismatch_scores_as_human_review_routine():
  runs = fake_runs()
  runs["full"][4] = {"case_id": "C05", "repeat": 0, "error": "SchemaMismatch"}
  frame = run.entries_to_frame(runs["full"], reference_frame())
  row = frame[frame["case_id"] == "C05"].iloc[0]
  assert row["received"] == "routine"
  assert bool(row["flagged"]) is True
  assert bool(row["schema_mismatch"]) is True
  assert bool(row["http_error"]) is False
