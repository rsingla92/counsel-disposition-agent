import {describe, expect, it} from 'vitest';
import {ruleFloor, verifyExcerpt} from '../src/floor';
import {loadPolicy} from '../src/policy';
import {fakeExtraction, withExcerpt, withFlags} from './fixtures';

const policy = loadPolicy();
const MSG =
  'Refill please. Also my chest feels tight, like pressure going into my left arm.';
const ex = (
  flags: Record<string, 'present' | 'unknown'>,
  mods: string[] = [],
) => withFlags(fakeExtraction(policy), flags, mods, MSG);

describe('ruleFloor', () => {
  it('defaults to self_care with no flags', () =>
    expect(ruleFloor(ex({}), MSG, policy).floor).toBe('self_care'));

  it('takes the highest present minimum', () =>
    expect(
      ruleFloor(
        ex({cardiac_chest_pain: 'present', diabetic_foot_redness: 'present'}),
        MSG,
        policy,
      ).floor,
    ).toBe('call_911'));

  it('ignores unknown flags', () =>
    expect(
      ruleFloor(ex({cardiac_chest_pain: 'unknown'}), MSG, policy).floor,
    ).toBe('self_care'));

  it('raises one level in total for several modifiers', () =>
    expect(
      ruleFloor(
        ex({}, ['age_65_plus', 'diabetes', 'anticoagulation']),
        MSG,
        policy,
      ).floor,
    ).toBe('routine'));

  it('never lets a modifier pass in_person_today', () => {
    expect(
      ruleFloor(
        ex({one_sided_calf_swelling: 'present'}, ['age_65_plus']),
        MSG,
        policy,
      ).floor,
    ).toBe('in_person_today');
    expect(
      ruleFloor(
        ex({older_adult_fall_no_weight_bearing: 'present'}, ['age_65_plus']),
        MSG,
        policy,
      ).floor,
    ).toBe('ed_now');
  });

  it('does not double count a subsumed modifier (case 39)', () =>
    expect(
      ruleFloor(
        ex({postpartum_harm_thoughts: 'present'}, ['postpartum']),
        MSG,
        policy,
      ).floor,
    ).toBe('physician_contact_today'));

  it('raises physician_contact_today to in_person_today with an unsubsumed modifier', () =>
    expect(
      ruleFloor(
        ex({suicidal_thoughts: 'present'}, ['age_65_plus']),
        MSG,
        policy,
      ).floor,
    ).toBe('in_person_today'));

  it('keeps an unverified present flag in the floor', () => {
    const r = ruleFloor(
      withExcerpt(
        ex({cardiac_chest_pain: 'present'}),
        'cardiac_chest_pain',
        'chest agony',
      ),
      MSG,
      policy,
    );
    expect(r.floor).toBe('call_911');
    expect(r.unverified).toEqual(['cardiac_chest_pain']);
  });

  it('flags a null excerpt as unverified', () => {
    const r = ruleFloor(
      withExcerpt(
        ex({cardiac_chest_pain: 'present'}),
        'cardiac_chest_pain',
        null,
      ),
      MSG,
      policy,
    );
    expect(r.unverified).toEqual(['cardiac_chest_pain']);
  });

  it.each([[''], ['  \n']])(
    'treats excerpt %j as unverified but still floors',
    e => {
      const r = ruleFloor(
        withExcerpt(
          ex({cardiac_chest_pain: 'present'}),
          'cardiac_chest_pain',
          e,
        ),
        MSG,
        policy,
      );
      expect(r.floor).toBe('call_911');
      expect(r.unverified).toEqual(['cardiac_chest_pain']);
    },
  );

  it('reports drivers and the modifier applied', () => {
    const r = ruleFloor(
      ex({suicidal_thoughts: 'present'}, ['age_65_plus']),
      MSG,
      policy,
    );
    expect(r.drivers).toEqual(['suicidal_thoughts']);
    expect(r.modifier_applied).toBe('age_65_plus');
    expect(r.unverified).toEqual([]);
  });

  it('reports no modifier when the floor is at the cap', () =>
    expect(
      ruleFloor(
        ex({older_adult_fall_no_weight_bearing: 'present'}, ['age_65_plus']),
        MSG,
        policy,
      ).modifier_applied,
    ).toBeNull());
});

describe('fixture helpers', () => {
  it('throw on an unknown id', () => {
    expect(() => ex({not_a_flag: 'present'})).toThrow();
    expect(() => ex({}, ['not_a_modifier'])).toThrow();
    expect(() =>
      withExcerpt(fakeExtraction(policy), 'not_a_flag', 'x'),
    ).toThrow();
  });
});

describe('verifyExcerpt', () => {
  it.each([
    ['my chest feels tight', true],
    ['My  chest feels\ntight', true],
    ['chest feels “tight”', false],
    ['my chest hurts', false],
  ])('verifyExcerpt(%j) is %s', (e, ok) =>
    expect(verifyExcerpt(MSG, e)).toBe(ok),
  );

  it.each([[''], ['  \n']])('rejects empty excerpt %j', e =>
    expect(verifyExcerpt(MSG, e)).toBe(false),
  );

  it('verifies curly-apostrophe excerpts against straight source', () =>
    expect(verifyExcerpt("I can't breathe", 'I can’t breathe')).toBe(true));
});
