/** The seven dispositions, most acute first. */
export const LEVELS = [
  'call_911',
  'ed_now',
  'in_person_today',
  'physician_contact_today',
  'within_few_days',
  'routine',
  'self_care',
] as const;

export type Level = (typeof LEVELS)[number];
export type Tier = 'emergency' | 'same_day' | 'async' | 'self_care';
export type BriefLabel = 'URGENT_ESCALATION' | 'ASYNC_PHYSICIAN' | 'SELF_CARE';

const TIERS: Record<Level, Tier> = {
  call_911: 'emergency',
  ed_now: 'emergency',
  in_person_today: 'same_day',
  physician_contact_today: 'same_day',
  within_few_days: 'async',
  routine: 'async',
  self_care: 'self_care',
};

const BRIEF_LABELS: Record<Tier, BriefLabel> = {
  emergency: 'URGENT_ESCALATION',
  same_day: 'URGENT_ESCALATION',
  async: 'ASYNC_PHYSICIAN',
  self_care: 'SELF_CARE',
};

/** Acuity rank: self_care is 0, call_911 is 6. */
export function rank(l: Level): number {
  return LEVELS.length - 1 - LEVELS.indexOf(l);
}

export function levelAtRank(r: number): Level {
  const l = LEVELS[LEVELS.length - 1 - r];
  if (!Number.isInteger(r) || l === undefined) {
    throw new RangeError(`rank out of range: ${r}`);
  }
  return l;
}

export function maxLevel(a: Level, b: Level): Level {
  return rank(a) >= rank(b) ? a : b;
}

export function tierOf(l: Level): Tier {
  return TIERS[l];
}

export function briefLabelOf(l: Level): BriefLabel {
  return BRIEF_LABELS[tierOf(l)];
}
