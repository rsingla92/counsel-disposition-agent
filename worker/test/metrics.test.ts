import {describe, expect, it} from 'vitest';
import fixture from '../../schema/fixtures/metrics-parity.json';
import {received, summarize, type ScoredCase} from '../src/metrics';
import {loadPolicy, type Policy} from '../src/policy';

const policy = {...loadPolicy(), loss: fixture.policy_loss} as Policy;
const cases = fixture.cases as ScoredCase[];

describe('metrics parity with the eval', () => {
  const s = summarize(cases, policy);

  it('matches the Python-computed summary', () => {
    const e = fixture.expected;
    expect(s.n).toBe(e.n);
    expect(s.emergencies).toBe(e.emergencies);
    expect(s.missed).toBe(e.missed);
    expect(s.human_review_rate).toBeCloseTo(e.human_review_rate, 9);
    expect(s.needs_info_rate).toBeCloseTo(e.needs_info_rate, 9);
    expect(s.over_triage_rate).toBeCloseTo(e.over_triage_rate, 9);
    expect(s.cost_score).toBeCloseTo(e.cost_score, 9);
  });

  it('puts Human review in its own confusion column', () => {
    // S04: ed_now, human_review with no disposition.
    expect(s.confusion.ed_now.human_review).toBe(1);
    expect(s.confusion.ed_now.in_person_today).toBe(1);
    expect(s.confusion.call_911.call_911).toBe(1);
  });

  it('scores a null disposition as routine', () => {
    expect(received({...cases[3]!, disposition: null})).toBe('routine');
  });
});
