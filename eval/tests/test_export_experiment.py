"""Tests for counsel_eval.export_experiment, on synthetic saved runs only."""

import json

import pytest

from counsel_eval import export_experiment
from counsel_eval import levels
from counsel_eval import run
from counsel_eval.data import load_policy
from helpers import entry
from helpers import make_result
from helpers import REFERENCE_LEVELS
from helpers import SENTINEL

STAMP = "20261104T000000Z"
TOP_KEYS = {
    "id",
    "label",
    "models",
    "rescorable",
    "samples_per_model",
    "records",
    "summary",
    "median_latency_ms",
}
RECORD_KEYS = {
    "case_id",
    "reference",
    "fixed",
    "floor",
    "primary",
    "secondary",
    "questions",
    "photo",
    "base_reasons",
    "latency_ms",
}
FIXED_KEYS = {"status", "disposition", "reasons"}
SUMMARY_KEYS = {
    "n",
    "emergencies",
    "missed",
    "human_review_rate",
    "needs_info_rate",
    "over_triage_rate",
    "flagged_rate",
    "cost_score",
    "confusion",
}


def _result(disposition, *, floor=None, secondary=None, photo=False, **kw):
  result = make_result(disposition, text=f"{SENTINEL} text", **kw)
  result["floor"] = floor
  result["votes"]["secondary"] = secondary
  result["info_requests"]["photo"] = photo
  return result


def _full_entries():
  empty = {level: 0 for level in levels.LEVELS}
  return [
      entry(
          "C01",
          _result("call_911", floor="call_911"),
          latency_ms=300.0,
      ),
      # Extraction failed with an emergency floor carried: no votes.
      entry(
          "C02",
          _result(
              "ed_now",
              floor="ed_now",
              status="human_review",
              flagged=True,
              reasons=("extraction_failed",),
              votes=empty,
          ),
          latency_ms=100.0,
      ),
      entry(
          "C03",
          _result(
              None,
              floor="self_care",
              status="human_review",
              flagged=True,
              reasons=("sampling_failed",),
              votes={"in_person_today": 12},
          ),
          latency_ms=200.0,
      ),
      entry(
          "C04",
          _result(
              "physician_contact_today",
              floor="within_few_days",
              status="needs_info",
              flagged=True,
              reasons=("split_vote", "unverified_excerpt", "missing_info"),
              questions=(f"{SENTINEL} question?",),
              votes={"physician_contact_today": 11, "within_few_days": 9},
          ),
          latency_ms=400.0,
      ),
      {"case_id": "C05", "repeat": 0, "error": "HTTPStatusError"},
      entry(
          "C06",
          _result(
              "routine",
              floor="self_care",
              secondary={**empty, "routine": 20},
              photo=True,
              status="needs_info",
              reasons=("photo_needed",),
          ),
          latency_ms=500.0,
      ),
      entry("C07", _result("self_care", floor="self_care"), latency_ms=600.0),
      # A repeat and an unreviewed case are left out.
      entry("C07", _result("routine", floor="self_care"), repeat=1),
      entry("C99", _result("routine", floor="self_care")),
  ]


def _floor_entries():
  return [
      {
          "case_id": case_id,
          "repeat": 0,
          "baseline": {
              "status": "routed",
              "disposition": level,
              "flagged": False,
          },
          "meta": {"early": False, "latency_ms": 50.0},
      }
      for case_id, level in REFERENCE_LEVELS.items()
  ]


@pytest.fixture(name="data_dir")
def _data_dir(tmp_path):
  data_dir = tmp_path / "data"
  data_dir.mkdir()
  lines = ["case_id,level,info,photo,time_sensitive"]
  lines += [
      f"{c},{lvl},False,False,False" for c, lvl in REFERENCE_LEVELS.items()
  ]
  (data_dir / "reference_labels.csv").write_text("\n".join(lines) + "\n")
  run_dir = data_dir / "runs" / STAMP
  run_dir.mkdir(parents=True)
  for system, entries in (
      ("full", _full_entries()),
      ("floor", _floor_entries()),
  ):
    with open(run_dir / f"{system}.jsonl", "w", encoding="utf-8") as f:
      for e in entries:
        f.write(json.dumps(e) + "\n")
  return data_dir


def _export(data_dir, out, system="full", exp_id="run-a"):
  return export_experiment.main(
      [
          "--run",
          STAMP,
          "--system",
          system,
          "--id",
          exp_id,
          "--label",
          "Synthetic run",
          "--out",
          str(out),
          "--data-dir",
          str(data_dir),
      ]
  )


def _records(exp):
  return {r["case_id"]: r for r in exp["records"]}


def test_writes_only_the_allowed_keys(data_dir, tmp_path):
  out = tmp_path / "out" / "exp.json"
  assert _export(data_dir, out) == 0
  text = out.read_text()
  assert SENTINEL not in text
  exp = json.loads(text)
  assert set(exp) == TOP_KEYS
  assert set(exp["summary"]) == SUMMARY_KEYS
  for r in exp["records"]:
    assert set(r) == RECORD_KEYS
    if r["fixed"] is not None:
      assert set(r["fixed"]) == FIXED_KEYS
  assert exp["id"] == "run-a"
  assert exp["label"] == "Synthetic run"
  assert exp["rescorable"] is True


def test_records_one_per_reviewed_case_at_repeat_zero(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  _export(data_dir, out)
  exp = json.loads(out.read_text())
  assert sorted(_records(exp)) == sorted(REFERENCE_LEVELS)
  assert _records(exp)["C07"]["primary"]["self_care"] == 20


def test_fixed_and_base_reasons(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  _export(data_dir, out)
  r = _records(json.loads(out.read_text()))
  assert r["C01"]["fixed"] is None
  assert r["C02"]["fixed"] == {
      "status": "human_review",
      "disposition": "ed_now",
      "reasons": ["extraction_failed"],
  }
  assert r["C03"]["fixed"] == {
      "status": "human_review",
      "disposition": None,
      "reasons": ["sampling_failed"],
  }
  assert r["C03"]["primary"]["in_person_today"] == 12
  assert r["C03"]["base_reasons"] == []
  assert r["C04"]["fixed"] is None
  assert r["C04"]["base_reasons"] == ["unverified_excerpt"]
  assert r["C04"]["questions"] == 1
  assert r["C04"]["floor"] == "within_few_days"
  # A failed HTTP call: Human review with no votes and nothing to re-decide.
  assert r["C05"]["fixed"] == {
      "status": "human_review",
      "disposition": None,
      "reasons": [],
  }
  assert sum(r["C05"]["primary"].values()) == 0
  assert r["C06"]["photo"] is True
  assert r["C06"]["base_reasons"] == []
  assert r["C06"]["secondary"]["routine"] == 20
  assert r["C01"]["secondary"] is None


def test_summary_uses_the_eval_scoring(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  _export(data_dir, out)
  exp = json.loads(out.read_text())
  s = exp["summary"]
  assert s["n"] == 7
  assert s["emergencies"] == 2
  assert s["missed"] == 0
  assert s["human_review_rate"] == pytest.approx(3 / 7)
  assert s["needs_info_rate"] == pytest.approx(2 / 7)
  # C02, C03, C04 (split vote) and C05 (failed call) are flagged.
  assert s["flagged_rate"] == pytest.approx(4 / 7)
  # C03 and C05 score as routine, below their references: under, not over.
  assert s["over_triage_rate"] == pytest.approx(0.0)
  assert s["confusion"]["ed_now"]["human_review"] == 1
  assert s["confusion"]["call_911"]["call_911"] == 1
  assert (
      s["confusion"]["physician_contact_today"]["physician_contact_today"] == 1
  )
  assert set(s["confusion"]) == set(levels.LEVELS)
  assert set(s["confusion"]["routine"]) == {*levels.LEVELS, "human_review"}
  # Median of the timed repeat-0 entries: 100 to 600 ms.
  assert exp["median_latency_ms"] == pytest.approx(350.0)


def test_floor_system_is_not_rescorable(data_dir, tmp_path):
  out = tmp_path / "floor.json"
  assert _export(data_dir, out, system="floor", exp_id="run-b") == 0
  exp = json.loads(out.read_text())
  assert set(exp) == TOP_KEYS
  assert exp["rescorable"] is False
  assert exp["summary"]["n"] == 7
  for r in exp["records"]:
    assert set(r) == RECORD_KEYS


def test_refuses_an_out_inside_the_repo(data_dir):
  out = run.ROOT / "experiment-must-not-exist.json"
  assert _export(data_dir, out) == 2
  assert not out.exists()


def test_refuses_a_bad_id(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  assert _export(data_dir, out, exp_id="bad id/..") != 0
  assert not out.exists()


def test_reports_a_missing_run(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  (data_dir / "runs" / STAMP / "full.jsonl").unlink()
  assert _export(data_dir, out) != 0
  assert not out.exists()


def _git_tree(root, git_file=False):
  """Makes a directory that looks like a checkout (or a worktree)."""
  root.mkdir(parents=True)
  if git_file:
    (root / ".git").write_text("gitdir: /elsewhere/.git/worktrees/x\n")
  else:
    (root / ".git").mkdir()
  return root


def test_refuses_an_out_inside_a_git_checkout(data_dir, tmp_path):
  out = _git_tree(tmp_path / "checkout") / "exp.json"
  assert _export(data_dir, out) == 2
  assert not out.exists()


def test_refuses_an_out_below_a_worktree_git_file(data_dir, tmp_path):
  tree = _git_tree(tmp_path / "worktree", git_file=True)
  out = tree / "nested" / "deeper" / "exp.json"
  assert _export(data_dir, out) == 2
  assert not out.exists()


def test_refuses_a_relative_out_into_a_checkout(
    data_dir, tmp_path, monkeypatch
):
  checkout = _git_tree(tmp_path / "checkout")
  inner = checkout / "a" / "b"
  inner.mkdir(parents=True)
  monkeypatch.chdir(inner)
  assert _export(data_dir, "../../exp.json") == 2
  assert not (checkout / "exp.json").exists()


def test_refuses_a_symlink_into_a_checkout(data_dir, tmp_path):
  checkout = _git_tree(tmp_path / "checkout")
  (checkout / "sub").mkdir()
  link = tmp_path / "outside" / "link"
  link.parent.mkdir()
  link.symlink_to(checkout / "sub", target_is_directory=True)
  assert _export(data_dir, link / "exp.json") == 2
  assert not (checkout / "sub" / "exp.json").exists()


def test_accepts_a_plain_directory(data_dir, tmp_path):
  out = tmp_path / "plain" / "exp.json"
  assert _export(data_dir, out) == 0
  assert out.exists()


def _sampling_failed(*, flag=None, modifier=None, reasons=("sampling_failed",)):
  """A sampling_failed result; flag/modifier give excerpt_verified, or None."""
  result = _result(
      None,
      floor="self_care",
      status="human_review",
      flagged=True,
      reasons=reasons,
      votes={"routine": 12},
  )
  result["red_flags"] = [
      {
          "id": "synthetic_flag",
          "state": "present" if flag is not None else "absent",
          "excerpt": "synthetic" if flag is not None else None,
          "excerpt_verified": bool(flag),
      },
      # Not present, so its unverified excerpt does not count.
      {
          "id": "other_flag",
          "state": "unknown",
          "excerpt": None,
          "excerpt_verified": False,
      },
  ]
  result["modifiers"] = (
      []
      if modifier is None
      else [
          {
              "id": "synthetic_modifier",
              "excerpt": "synthetic",
              "excerpt_verified": modifier,
          }
      ]
  )
  return result


@pytest.mark.parametrize(
    "kwargs, expected",
    [
        ({"flag": False}, ["unverified_excerpt"]),
        ({"modifier": False}, ["unverified_excerpt"]),
        ({"flag": True, "modifier": True}, []),
        ({}, []),
        (
            {"flag": False, "reasons": ("unverified_excerpt", "split_vote")},
            ["unverified_excerpt"],
        ),
    ],
)
def test_recovers_unverified_excerpt(kwargs, expected):
  out = export_experiment.record(
      entry("C06", _sampling_failed(**kwargs)), "routine"
  )
  assert out["base_reasons"] == expected


def _restamp(data_dir, version):
  """Rewrites the saved run as if made under policy `version`."""
  path = data_dir / "runs" / STAMP / "full.jsonl"
  lines = []
  for line in path.read_text(encoding="utf-8").splitlines():
    e = json.loads(line)
    if isinstance(e.get("result"), dict):
      e["result"]["trace"]["policy_version"] = version
    lines.append(json.dumps(e))
  path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_samples_per_model_is_the_current_policy_n(data_dir, tmp_path):
  out = tmp_path / "exp.json"
  assert _export(data_dir, out) == 0
  n = load_policy(run.ROOT / "policy" / "policy.yaml")["sampling"]["n"]
  assert json.loads(out.read_text())["samples_per_model"] == n


def test_samples_per_model_is_20_before_policy_0_3_0(data_dir, tmp_path):
  _restamp(data_dir, "0.2.0")
  out = tmp_path / "exp.json"
  assert _export(data_dir, out) == 0
  assert json.loads(out.read_text())["samples_per_model"] == 20


def test_refuses_an_unknown_policy_version(data_dir, tmp_path):
  _restamp(data_dir, "9.9.9")
  assert _export(data_dir, tmp_path / "exp.json") == 4
