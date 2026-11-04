"""Tests for counsel_eval.client."""

import httpx
import pytest

from counsel_eval.client import RouteClient
from counsel_eval.client import SchemaMismatch
from helpers import ndjson
from helpers import VALID_RESULT

URL = "https://worker.test"


def test_client_returns_result_after_early_event(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(
      200,
      text=ndjson(
          {"event": "early", "floor": "call_911", "patient_message": "x"},
          {"event": "result", "result": VALID_RESULT},
      ),
  )
  client = RouteClient(URL, "t")
  result = client.route("m")
  assert result["disposition"] == VALID_RESULT["disposition"]
  assert client.last_meta["early"] is True
  assert client.last_meta["latency_ms"] >= 0


def test_client_without_early_event_reports_false(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(
      200, text=ndjson({"event": "result", "result": VALID_RESULT})
  )
  client = RouteClient(URL, "t")
  client.route("m")
  assert client.last_meta["early"] is False


def test_client_sends_bearer_and_mode(respx_mock):
  route = respx_mock.post(f"{URL}/v1/route").respond(
      200, text=ndjson({"event": "result", "result": VALID_RESULT})
  )
  RouteClient(URL, "tok").route("m", mode="floor_only")
  request = route.calls.last.request
  assert request.headers["authorization"] == "Bearer tok"
  assert b"floor_only" in request.content


def test_client_rejects_schema_mismatch(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(
      200, text=ndjson({"event": "result", "result": {"status": "routed"}})
  )
  with pytest.raises(SchemaMismatch):
    RouteClient(URL, "t").route("m")


def test_client_raises_on_http_error(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(503, json={"error": "x"})
  with pytest.raises(httpx.HTTPStatusError):
    RouteClient(URL, "t").route("m")


def test_client_raises_when_no_result_event(respx_mock):
  respx_mock.post(f"{URL}/v1/route").respond(
      200, text=ndjson({"event": "early", "floor": "ed_now"})
  )
  with pytest.raises(SchemaMismatch):
    RouteClient(URL, "t").route("m")


def test_policy_returns_json(respx_mock):
  respx_mock.get(f"{URL}/v1/policy").respond(
      200, json={"policy_version": "0.1.0"}
  )
  assert RouteClient(URL, "t").policy()["policy_version"] == "0.1.0"
