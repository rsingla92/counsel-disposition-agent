"""The seven dispositions, mirroring worker/src/levels.ts."""

# Most acute first. Must match LEVELS in worker/src/levels.ts and the loss
# boundary order in policy/policy.yaml (enforced by tests).
LEVELS: tuple[str, ...] = (
    "call_911",
    "ed_now",
    "in_person_today",
    "physician_contact_today",
    "within_few_days",
    "routine",
    "self_care",
)

_TIERS = {
    "call_911": "emergency",
    "ed_now": "emergency",
    "in_person_today": "same_day",
    "physician_contact_today": "same_day",
    "within_few_days": "async",
    "routine": "async",
    "self_care": "self_care",
}

_BRIEF_LABELS = {
    "emergency": "URGENT_ESCALATION",
    "same_day": "URGENT_ESCALATION",
    "async": "ASYNC_PHYSICIAN",
    "self_care": "SELF_CARE",
}


def rank(level: str) -> int:
  """Returns the acuity rank: self_care is 0, call_911 is 6.

  Args:
    level: A disposition level name.

  Raises:
    ValueError: If the level is unknown.
  """
  return len(LEVELS) - 1 - LEVELS.index(level)


def tier(level: str) -> str:
  """Returns the tier (emergency, same_day, async or self_care)."""
  return _TIERS[level]


def brief_label(level: str) -> str:
  """Returns the brief's three-way label for a level."""
  return _BRIEF_LABELS[tier(level)]
