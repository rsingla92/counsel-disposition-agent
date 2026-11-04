"""Tests for counsel_eval.record_demo. Hermetic: the Worker is mocked."""

import hashlib
import json
import pathlib

import httpx
import jsonschema

from counsel_eval import record_demo
from counsel_eval.client import RouteClient
from helpers import make_result
from helpers import ndjson

URL = "https://worker.test"
ROOT = pathlib.Path(__file__).parents[2]
LEVELS = (
    "call_911",
    "ed_now",
    "in_person_today",
    "physician_contact_today",
    "within_few_days",
    "routine",
    "self_care",
)

MESSAGES = [
    {"id": "first", "label": "First", "message": "synthetic one"},
    {"id": "second", "label": "Second", "message": "synthetic two"},
]


def _write_messages(tmp_path: pathlib.Path) -> pathlib.Path:
  path = tmp_path / "demo-messages.json"
  path.write_text(json.dumps(MESSAGES), encoding="utf-8")
  return path


def _respond(request: httpx.Request) -> httpx.Response:
  message = json.loads(request.content)["message"]
  if message == "synthetic one":
    events = [
        {"event": "early", "floor": "call_911", "patient_message": "Call."},
        {"event": "result", "result": make_result("call_911")},
    ]
  else:
    events = [{"event": "result", "result": make_result("routine")}]
  return httpx.Response(200, text=ndjson(*events))


def test_client_keeps_the_early_event(respx_mock):
  respx_mock.post(f"{URL}/v1/route").mock(side_effect=_respond)
  client = RouteClient(URL, "t")
  client.route("synthetic one")
  assert client.last_early == {
      "event": "early",
      "floor": "call_911",
      "patient_message": "Call.",
  }
  client.route("synthetic two")
  assert client.last_early is None


def test_main_records_each_message_and_the_manifest(respx_mock, tmp_path):
  respx_mock.post(f"{URL}/v1/route").mock(side_effect=_respond)
  out = tmp_path / "replay"
  code = record_demo.main(
      [
          "--url",
          URL,
          "--messages",
          str(_write_messages(tmp_path)),
          "--out",
          str(out),
      ],
      env={"COUNSEL_TOKEN": "tok"},
  )
  assert code == 0
  manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
  assert manifest == [
      {"id": "first", "label": "First", "file": "first.json"},
      {"id": "second", "label": "Second", "file": "second.json"},
  ]
  first = json.loads((out / "first.json").read_text(encoding="utf-8"))
  assert first["message"] == "synthetic one"
  assert first["early"]["floor"] == "call_911"
  assert first["result"]["disposition"] == "call_911"
  assert "synthetic_fixture" not in first
  second = json.loads((out / "second.json").read_text(encoding="utf-8"))
  assert second["early"] is None
  request = respx_mock.calls.last.request
  assert request.headers["authorization"] == "Bearer tok"


def test_main_without_token_records_nothing(respx_mock, tmp_path):
  route = respx_mock.post(f"{URL}/v1/route").mock(side_effect=_respond)
  out = tmp_path / "replay"
  code = record_demo.main(
      ["--url", URL, "--messages", str(_write_messages(tmp_path))]
      + ["--out", str(out)],
      env={},
  )
  assert code != 0
  assert not route.called
  assert not out.exists()


def test_a_failed_message_writes_nothing(respx_mock, tmp_path, capsys):
  def flaky(request: httpx.Request) -> httpx.Response:
    if json.loads(request.content)["message"] == "synthetic two":
      return httpx.Response(503, json={"error": "x"})
    return _respond(request)

  respx_mock.post(f"{URL}/v1/route").mock(side_effect=flaky)
  out = tmp_path / "replay"
  out.mkdir()
  (out / "manifest.json").write_text("[]", encoding="utf-8")
  code = record_demo.main(
      ["--url", URL, "--messages", str(_write_messages(tmp_path))]
      + ["--out", str(out)],
      env={"COUNSEL_TOKEN": "tok"},
  )
  assert code != 0
  assert sorted(p.name for p in out.iterdir()) == ["manifest.json"]
  assert (out / "manifest.json").read_text(encoding="utf-8") == "[]"
  err = capsys.readouterr().err
  assert "second" in err
  assert "synthetic two" not in err


# --- the committed demo content ---------------------------------------------


def test_demo_messages_are_eight_synthetic_with_one_per_level():
  messages = json.loads(
      (ROOT / "web" / "demo-messages.json").read_text(encoding="utf-8")
  )
  assert len(messages) == 8
  assert len({m["id"] for m in messages}) == 8
  intended = [m["intended_level"] for m in messages]
  assert sorted(l for l in intended if l) == sorted(LEVELS)
  assert intended.count(None) == 1
  assert all(m["message"].strip() and m["label"] for m in messages)


def test_committed_replays_match_the_schema_and_their_message():
  schema = json.loads(
      (ROOT / "schema" / "route-result.schema.json").read_text(encoding="utf-8")
  )
  validator = jsonschema.Draft202012Validator(schema)
  replay = ROOT / "web" / "replay"
  manifest = json.loads((replay / "manifest.json").read_text(encoding="utf-8"))
  messages = {
      m["id"]: m["message"]
      for m in json.loads(
          (ROOT / "web" / "demo-messages.json").read_text(encoding="utf-8")
      )
  }
  assert manifest
  for entry in manifest:
    saved = json.loads((replay / entry["file"]).read_text(encoding="utf-8"))
    assert saved["id"] == entry["id"]
    assert saved["message"] == messages[entry["id"]]
    validator.validate(saved["result"])
    digest = hashlib.sha256(saved["message"].encode("utf-8")).hexdigest()
    assert saved["result"]["trace"]["input_sha256"] == digest
