"""HTTP client for the Worker's /v1/route and /v1/policy endpoints."""

import json
import pathlib
import threading
import time
from typing import Any

import httpx
import jsonschema

_SCHEMA_PATH = (
    pathlib.Path(__file__).parents[3] / "schema" / "route-result.schema.json"
)


class SchemaMismatch(Exception):
  """The Worker's result does not match route-result.schema.json."""


def _load_schema() -> dict[str, Any]:
  with open(_SCHEMA_PATH, encoding="utf-8") as f:
    return json.load(f)


class RouteClient:
  """Calls the Worker and validates each result against the shared schema.

  Attributes:
    last_meta: For the calling thread's most recent `route` call,
      {"early": bool, "latency_ms": float}. The latency is measured by the
      client around the whole request.
  """

  def __init__(
      self,
      base_url: str,
      token: str,
      *,
      # The stream is silent while 40 samples share six connections, with
      # 15 s per call and 429 retries; live cases take 30-55 s.
      timeout_s: float = 300.0,
      transport: httpx.BaseTransport | None = None,
  ):
    self._base_url = base_url.rstrip("/")
    self._http = httpx.Client(
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout_s,
        transport=transport,
    )
    self._validator = jsonschema.Draft202012Validator(_load_schema())
    self._local = threading.local()

  @property
  def last_meta(self) -> dict[str, Any]:
    return getattr(self._local, "meta", {"early": False, "latency_ms": 0.0})

  @property
  def last_early(self) -> dict[str, Any] | None:
    """The calling thread's most recent early event, or None if it had none.

    Kept apart from last_meta so the eval's saved runs keep their shape.
    """
    return getattr(self._local, "early", None)

  def route(
      self, message: str, mode: str = "full", models: str | None = None
  ) -> dict[str, Any]:
    """Routes one message and returns the result object.

    Args:
      message: The patient message.
      mode: "full" or "floor_only".
      models: Optional override of which models run: "sonnet", "flash" or
        "sonnet+flash". None sends no overrides (the Worker default).

    Raises:
      SchemaMismatch: If the stream has no result or it fails the schema.
      httpx.HTTPError: On transport failure or a non-2xx status.
    """
    body: dict[str, Any] = {"message": message, "mode": mode}
    if models is not None:
      body["overrides"] = {"models": models}
    started = time.perf_counter()
    early = False
    early_event = None
    result = None
    self._local.early = None
    with self._http.stream(
        "POST",
        f"{self._base_url}/v1/route",
        json=body,
    ) as response:
      response.raise_for_status()
      for line in response.iter_lines():
        if not line.strip():
          continue
        event = json.loads(line)
        if event.get("event") == "early":
          early = True
          early_event = event
        elif event.get("event") == "result":
          result = event.get("result")
    self._local.meta = {
        "early": early,
        "latency_ms": (time.perf_counter() - started) * 1000.0,
    }
    self._local.early = early_event
    if result is None:
      raise SchemaMismatch("stream ended without a result event")
    errors = sorted(
        self._validator.iter_errors(result), key=lambda e: list(e.path)
    )
    if errors:
      first = errors[0]
      where = "/".join(str(p) for p in first.path) or "<root>"
      raise SchemaMismatch(f"result invalid at {where}: {first.validator}")
    return result

  def policy(self) -> dict[str, Any]:
    """Returns the Worker's /v1/policy document."""
    response = self._http.get(f"{self._base_url}/v1/policy")
    response.raise_for_status()
    return response.json()
