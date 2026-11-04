import {describe, expect, it} from 'vitest';
import {
  LEVELS,
  briefLabelOf,
  levelAtRank,
  maxLevel,
  rank,
  tierOf,
  type Level,
} from '../src/levels';

describe('levels', () => {
  it('orders levels by acuity', () => {
    expect(rank('call_911')).toBe(6);
    expect(rank('self_care')).toBe(0);
    expect(maxLevel('routine', 'ed_now')).toBe('ed_now');
  });

  it.each([
    ['call_911', 'emergency', 'URGENT_ESCALATION'],
    ['physician_contact_today', 'same_day', 'URGENT_ESCALATION'],
    ['within_few_days', 'async', 'ASYNC_PHYSICIAN'],
    ['self_care', 'self_care', 'SELF_CARE'],
  ])('%s is tier %s, label %s', (l, tier, label) => {
    expect(tierOf(l as Level)).toBe(tier);
    expect(briefLabelOf(l as Level)).toBe(label);
  });

  it('lists levels most acute first and round-trips ranks', () => {
    expect(LEVELS[0]).toBe('call_911');
    expect(LEVELS[LEVELS.length - 1]).toBe('self_care');
    for (const l of LEVELS) expect(levelAtRank(rank(l))).toBe(l);
  });

  it('maps every level to the right tier and label', () => {
    expect(LEVELS.map(tierOf)).toEqual([
      'emergency',
      'emergency',
      'same_day',
      'same_day',
      'async',
      'async',
      'self_care',
    ]);
    expect(LEVELS.map(briefLabelOf)).toEqual([
      'URGENT_ESCALATION',
      'URGENT_ESCALATION',
      'URGENT_ESCALATION',
      'URGENT_ESCALATION',
      'ASYNC_PHYSICIAN',
      'ASYNC_PHYSICIAN',
      'SELF_CARE',
    ]);
  });

  it('rejects ranks outside 0..6', () => {
    expect(() => levelAtRank(7)).toThrow();
    expect(() => levelAtRank(-1)).toThrow();
  });
});
