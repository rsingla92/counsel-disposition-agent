"""Loading of cases, reference labels and the policy."""

import os
from typing import Any

import pandas as pd
import yaml

_BOOL_COLUMNS = ("info", "photo", "time_sensitive")


def load_cases(path: str | os.PathLike[str]) -> pd.DataFrame:
  """Loads the reviewed cases workbook.

  Args:
    path: Path to patient_messages_with_dispositions.xlsx.

  Returns:
    A frame with columns case_id, message and historical (the historical
    label).
  """
  raw = pd.read_excel(path)
  cases = raw.rename(columns={"id": "case_id", "disposition": "historical"})
  return cases[["case_id", "message", "historical"]]


def load_reference(path: str | os.PathLike[str]) -> pd.DataFrame:
  """Loads the author's reference labels.

  Args:
    path: Path to reference_labels.csv.

  Returns:
    A frame with columns case_id, level, info, photo and time_sensitive
    (the last three are bool).
  """
  ref = pd.read_csv(path, dtype={"case_id": str, "level": str})
  for column in _BOOL_COLUMNS:
    ref[column] = ref[column].astype(str).str.lower().eq("true")
  return ref[["case_id", "level", *_BOOL_COLUMNS]]


def load_policy(path: str | os.PathLike[str]) -> dict[str, Any]:
  """Loads policy.yaml into a dict."""
  with open(path, encoding="utf-8") as f:
    return yaml.safe_load(f)
