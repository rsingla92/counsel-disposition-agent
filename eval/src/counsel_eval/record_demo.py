"""Records the demo replays: each synthetic demo message through the Worker.

Usage: python -m counsel_eval.record_demo --url URL  (token in COUNSEL_TOKEN)

Writes web/replay/<id>.json ({id, label, message, recorded_at, early,
result}) and web/replay/manifest.json ([{id, label, file}]). The demo
messages are synthetic and written for this repo, so saving their text and
results in the public repo is fine. All or nothing: if any message fails,
no file is written, so the replay set stays one coherent recording.
"""

import argparse
import datetime
import json
import os
import pathlib
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from counsel_eval.client import RouteClient

ROOT = pathlib.Path(__file__).parents[3]
EXIT_FAILED = 1
EXIT_CONFIG = 4


def build_parser() -> argparse.ArgumentParser:
  p = argparse.ArgumentParser(
      prog="python -m counsel_eval.record_demo",
      description="Record the demo replays (token in COUNSEL_TOKEN).",
  )
  p.add_argument("--url", required=True, help="Worker base URL")
  p.add_argument("--messages", default=str(ROOT / "web" / "demo-messages.json"))
  p.add_argument("--out", default=str(ROOT / "web" / "replay"))
  return p


def record(
    client: Any, messages: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
  """Routes each message and returns one saved run per message.

  Raises whatever the client raises; the caller decides what to write.
  """
  now = datetime.datetime.now(datetime.timezone.utc).isoformat(
      timespec="seconds"
  )
  runs = []
  for m in messages:
    result = client.route(m["message"])
    runs.append(
        {
            "id": m["id"],
            "label": m["label"],
            "message": m["message"],
            "recorded_at": now,
            "early": client.last_early,
            "result": result,
        }
    )
  return runs


def write(runs: Sequence[Mapping[str, Any]], out: pathlib.Path) -> None:
  """Writes each run and then the manifest that lists them."""
  out.mkdir(parents=True, exist_ok=True)
  manifest = []
  for run in runs:
    name = f"{run['id']}.json"
    (out / name).write_text(
        json.dumps(run, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    manifest.append({"id": run["id"], "label": run["label"], "file": name})
  (out / "manifest.json").write_text(
      json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
  )


def main(
    argv: Sequence[str] | None = None,
    *,
    client_factory: Callable[[str, str], Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
  """Records the replays and returns an exit code (0 on success)."""
  args = build_parser().parse_args(argv)
  env = os.environ if env is None else env
  token = env.get("COUNSEL_TOKEN")
  if not token:
    print("COUNSEL_TOKEN is not set", file=sys.stderr)
    return EXIT_CONFIG
  try:
    with open(args.messages, encoding="utf-8") as f:
      messages = json.load(f)
  except (OSError, ValueError) as e:
    print(f"cannot read demo messages ({type(e).__name__})", file=sys.stderr)
    return EXIT_CONFIG

  client = (client_factory or RouteClient)(args.url, token)
  runs = []
  for m in messages:
    try:
      runs.extend(record(client, [m]))
    except Exception as e:  # pylint: disable=broad-exception-caught
      # The id only: never the error text, which could echo the message.
      print(f"failed: {m['id']} ({type(e).__name__})", file=sys.stderr)
      print("nothing written", file=sys.stderr)
      return EXIT_FAILED
    result = runs[-1]["result"]
    print(f"{m['id']}: {result['status']} {result['disposition']}")
  write(runs, pathlib.Path(args.out))
  print(f"wrote {len(runs)} replays to {args.out}")
  return 0


if __name__ == "__main__":
  sys.exit(main())
