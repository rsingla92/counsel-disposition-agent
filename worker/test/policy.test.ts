import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {LEVELS, rank, type Level} from '../src/levels';
import {PolicySchema, loadPolicy} from '../src/policy';

const policy = loadPolicy();

describe('policy', () => {
  it('has a semver policy_version', () =>
    expect(policy.policy_version).toMatch(/^\d+\.\d+\.\d+$/));

  it('has unique red flag ids', () => {
    const ids = policy.red_flags.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique modifier ids', () => {
    const ids = policy.modifiers.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has one boundary per adjacent level pair, in order', () =>
    expect(policy.loss.boundaries.map(b => b.between)).toEqual(
      LEVELS.slice(0, -1).map((l, i) => [l, LEVELS[i + 1]]),
    ));

  it('subsumes the postpartum modifier on case-39 harm thoughts', () => {
    const f = policy.red_flags.find(f => f.id === 'postpartum_harm_thoughts')!;
    expect(f.min_level).toBe('physician_contact_today');
    expect(f.subsumes_modifiers).toContain('postpartum');
  });

  it('only subsumes modifiers that exist', () => {
    const mods = new Set(policy.modifiers.map(m => m.id));
    for (const f of policy.red_flags)
      for (const m of f.subsumes_modifiers) expect(mods).toContain(m);
  });

  it('rejects a flag with an unknown min_level', () =>
    expect(() =>
      PolicySchema.parse({
        ...policy,
        red_flags: [{...policy.red_flags[0], min_level: 'urgent'}],
      }),
    ).toThrow());

  it('defines every level with windows and a patient message', () => {
    for (const l of LEVELS) {
      expect(policy.levels[l].physician_window).not.toBe('');
      expect(policy.levels[l].patient_window).not.toBe('');
      expect(policy.levels[l].patient_message).not.toBe('');
    }
  });

  it('pins the ids that later tasks refer to', () => {
    const flagIds = new Set(policy.red_flags.map(f => f.id));
    for (const id of [
      'cardiac_chest_pain',
      'anaphylaxis',
      'fever_neck_stiffness',
      'diabetic_foot_redness',
      'hyperglycemia_vomiting',
      'anticoagulated_head_injury',
      'older_adult_fall_no_weight_bearing',
      'one_sided_calf_swelling',
      'suicidal_thoughts',
      'suicidal_plan_or_intent',
      'postpartum_harm_thoughts',
      'postpartum_psychosis_signs',
      'airway_breathing_compromise',
      'altered_consciousness',
      'seizure_ongoing',
    ])
      expect(flagIds).toContain(id);
    const modIds = new Set(policy.modifiers.map(m => m.id));
    for (const id of [
      'age_65_plus',
      'diabetes',
      'anticoagulation',
      'immunosuppression',
      'under_3_months',
      'sickle_cell',
      'pregnant',
      'postpartum',
    ])
      expect(modIds).toContain(id);
  });

  it('keeps the three forced-Call-911 additions at call_911 with no cases', () => {
    for (const id of [
      'airway_breathing_compromise',
      'altered_consciousness',
      'seizure_ongoing',
    ]) {
      const f = policy.red_flags.find(f => f.id === id)!;
      expect(f.min_level).toBe('call_911');
      expect(f.cases).toEqual([]);
    }
  });

  it('makes every obstetric flag subsume the postpartum modifier', () => {
    for (const f of policy.red_flags.filter(f => f.group === 'obstetric'))
      expect(f.subsumes_modifiers).toContain('postpartum');
  });

  it('caps modifiers at in_person_today', () =>
    expect(policy.modifier_cap).toBe('in_person_today'));

  it('has positive loss ratios and human review cost', () => {
    for (const b of policy.loss.boundaries) {
      expect(b.under).toBeGreaterThan(0);
      expect(b.over).toBeGreaterThan(0);
    }
    expect(policy.loss.human_review_cost).toBeGreaterThan(0);
  });

  it('has cost fixtures consistent with the loss boundaries', () => {
    const rows = JSON.parse(
      readFileSync(
        new URL('../../policy/cost_fixtures.json', import.meta.url),
        'utf8',
      ),
    ) as {true: Level; chosen: Level; cost: number}[];
    expect(rows).toHaveLength(7);
    // A miss costs the sum of the boundaries it crosses.
    const cost = (t: Level, c: Level) => {
      let sum = 0;
      for (const b of policy.loss.boundaries) {
        const upper = rank(b.between[0]);
        const lower = rank(b.between[1]);
        const lo = Math.min(rank(t), rank(c));
        const hi = Math.max(rank(t), rank(c));
        if (lower >= lo && upper <= hi) {
          sum += rank(c) < rank(t) ? b.under : b.over;
        }
      }
      return sum;
    };
    for (const r of rows) expect(cost(r.true, r.chosen)).toBeCloseTo(r.cost);
  });
});
