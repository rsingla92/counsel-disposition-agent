"""Tests for counsel_eval.data (private-data tests skip when absent)."""

import pathlib

import pytest

from counsel_eval.data import load_cases
from counsel_eval.data import load_reference
from counsel_eval.levels import brief_label

ROOT = pathlib.Path(__file__).parents[2]
XLSX = ROOT / "data" / "private" / "patient_messages_with_dispositions.xlsx"
REF = ROOT / "data" / "private" / "reference_labels.csv"

needs_private_data = pytest.mark.skipif(
    not (XLSX.exists() and REF.exists()),
    reason="private data not available",
)


@needs_private_data
def test_reference_label_counts():
  ref = load_reference(REF)
  assert ref.level.value_counts().to_dict() == {
      "call_911": 4,
      "ed_now": 10,
      "in_person_today": 8,
      "physician_contact_today": 2,
      "within_few_days": 7,
      "routine": 14,
      "self_care": 5,
  }
  assert set(ref[ref["info"]].case_id) == {
      "C05",
      "C12",
      "C16",
      "C33",
      "C44",
      "C49",
  }
  assert set(ref[ref.photo].case_id) == {"C11", "C30", "C36"}
  assert set(ref[ref.time_sensitive].case_id) == {"C24"}


@needs_private_data
def test_cases_load_with_expected_columns():
  cases = load_cases(XLSX)
  assert list(cases.columns) == ["case_id", "message", "historical"]
  assert len(cases) == 50
  assert cases.case_id.iloc[0] == "C01"


@needs_private_data
def test_reference_vs_historical_agreement():
  m = load_cases(XLSX).merge(load_reference(REF), on="case_id")
  brief_rank = {"URGENT_ESCALATION": 2, "ASYNC_PHYSICIAN": 1, "SELF_CARE": 0}
  ours = m.level.map(brief_label).map(brief_rank)
  theirs = m.historical.map(brief_rank)
  assert (ours == theirs).sum() == 38
  assert (ours > theirs).sum() == 9
  assert (ours < theirs).sum() == 3
