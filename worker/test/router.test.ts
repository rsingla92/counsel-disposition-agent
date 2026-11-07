import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Level} from '../src/levels';
import {chooseLevel, cost, expectedCost, reviewReasons} from '../src/router';
import {policy20, v} from './fixtures';

const policy = policy20;

interface CostFixture {
  true: Level;
  chosen: Level;
  cost: number;
}

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../policy/cost_fixtures.json', import.meta.url),
    'utf8',
  ),
) as CostFixture[];

describe('cost', () => {
  it.each(fixtures)('cost($true, $chosen) = $cost', f =>
    expect(cost(f.true, f.chosen, policy)).toBeCloseTo(f.cost),
  );

  it('agrees with a hand computation across several boundaries', () => {
    // call_911 -> routine crosses 5 boundaries: 3 + 20 + 2 + 5 + 2 = 32 (under).
    expect(cost('call_911', 'routine', policy)).toBeCloseTo(32);
    // self_care -> in_person_today crosses 4 boundaries: 1 + 1 + 1 + 1 = 4 (over).
    expect(cost('self_care', 'in_person_today', policy)).toBeCloseTo(4);
  });
});

describe('expectedCost', () => {
  it('weights each vote by its share of the total', () => {
    // 3 of 4 votes ed_now, 1 of 4 in_person_today; choose in_person_today.
    // 0.75 * 20 (under, ed_now/in_person_today) + 0.25 * 0 = 15.
    expect(
      expectedCost(
        v({ed_now: 3, in_person_today: 1}),
        'in_person_today',
        policy,
      ),
    ).toBeCloseTo(15);
  });
});

describe('chooseLevel', () => {
  it.each([
    ['call_911', 'ed_now', 5],
    ['ed_now', 'in_person_today', 1],
    ['in_person_today', 'physician_contact_today', 7],
    ['physician_contact_today', 'within_few_days', 4],
    ['within_few_days', 'routine', 7],
    ['routine', 'self_care', 8],
  ] as const)('%s over %s needs %i of 20 votes', (hi, lo, k) => {
    expect(chooseLevel(v({[hi]: k, [lo]: 20 - k}), 'self_care', policy)).toBe(
      hi,
    );
    expect(
      chooseLevel(v({[hi]: k - 1, [lo]: 21 - k}), 'self_care', policy),
    ).toBe(lo);
  });

  it('never chooses below the floor', () =>
    expect(chooseLevel(v({routine: 20}), 'ed_now', policy)).toBe('ed_now'));

  it('counts votes below the floor in the expected cost', () => {
    expect(
      chooseLevel(v({call_911: 11, self_care: 9}), 'in_person_today', policy),
    ).toBe('call_911');
  });

  it('throws on zero votes', () =>
    expect(() => chooseLevel(v({}), 'self_care', policy)).toThrow(RangeError));
});

describe('reviewReasons', () => {
  it('flags split, spread and family disagreement', () => {
    expect(
      reviewReasons(v({routine: 11, within_few_days: 9}), null, policy),
    ).toEqual(['split_vote']);
    expect(
      reviewReasons(v({routine: 19, in_person_today: 1}), null, policy),
    ).toEqual(['wide_spread']);
    expect(
      reviewReasons(v({routine: 20}), v({in_person_today: 20}), policy),
    ).toEqual(['family_disagreement']);
    expect(
      reviewReasons(
        v({routine: 12, within_few_days: 8}),
        v({within_few_days: 20}),
        policy,
      ),
    ).toEqual([]);
  });

  it('ignores a secondary vote set with no votes', () =>
    expect(reviewReasons(v({routine: 20}), v({}), policy)).toEqual([]));

  it('resolves modal ties to the more acute level', () => {
    // Primary mode ties routine/within_few_days -> within_few_days (async);
    // secondary in_person_today (same_day) differs.
    expect(
      reviewReasons(
        v({routine: 10, within_few_days: 10}),
        v({in_person_today: 20}),
        policy,
      ),
    ).toContain('family_disagreement');
    // Secondary tie routine/within_few_days -> within_few_days: same tier as
    // primary routine, so no disagreement.
    expect(
      reviewReasons(
        v({routine: 20}),
        v({routine: 10, within_few_days: 10}),
        policy,
      ),
    ).not.toContain('family_disagreement');
  });
});
