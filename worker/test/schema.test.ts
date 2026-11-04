import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {type Level} from '../src/levels';
import {loadPolicy} from '../src/policy';
import {RouteResultSchema, SampleSchema, extractionSchema} from '../src/schema';
import {fakeExtraction, validResult} from './fixtures';

const policy = loadPolicy();

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

describe('extractionSchema', () => {
  it('requires every policy flag in an extraction', () => {
    const s = extractionSchema(policy);
    const ok = fakeExtraction(policy);
    expect(s.safeParse(ok).success).toBe(true);
    const rest = {...ok.red_flags};
    delete rest[policy.red_flags[0].id];
    expect(s.safeParse({...ok, red_flags: rest}).success).toBe(false);
  });

  it('requires every modifier and rejects unknown keys', () => {
    const s = extractionSchema(policy);
    const ok = fakeExtraction(policy);
    const rest = {...ok.modifiers};
    delete rest[policy.modifiers[0].id];
    expect(s.safeParse({...ok, modifiers: rest}).success).toBe(false);
    expect(s.safeParse({...ok, extra: 1}).success).toBe(false);
  });

  it('allows at most three questions', () => {
    const s = extractionSchema(policy);
    const ok = fakeExtraction(policy);
    expect(s.safeParse({...ok, questions: ['a', 'b', 'c']}).success).toBe(true);
    expect(s.safeParse({...ok, questions: ['a', 'b', 'c', 'd']}).success).toBe(
      false,
    );
  });

  it('serialises strictly with every key required', () => {
    const schema = z.toJSONSchema(extractionSchema(policy)) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":true');
  });
});

describe('SampleSchema', () => {
  it('accepts a valid sample and rejects an unknown level', () => {
    const s = {disposition: 'routine', justification: 'x.', safety_net: 'y.'};
    expect(SampleSchema.safeParse(s).success).toBe(true);
    expect(SampleSchema.safeParse({...s, disposition: 'nope'}).success).toBe(
      false,
    );
  });
});

describe('RouteResultSchema', () => {
  it('accepts the valid fixture', () =>
    expect(RouteResultSchema.safeParse(validResult).success).toBe(true));

  it('requires null disposition to pair with human_review', () =>
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        status: 'routed',
        disposition: null,
      }).success,
    ).toBe(false));

  it('accepts null disposition with null tier and label on human_review', () =>
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        status: 'human_review',
        disposition: null,
        tier: null,
        brief_label: null,
        human_review: {flagged: true, reasons: ['split_vote']},
      }).success,
    ).toBe(true));

  it('rejects null disposition with a non-null tier', () =>
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        status: 'human_review',
        disposition: null,
        brief_label: null,
      }).success,
    ).toBe(false));

  it('accepts a non-null disposition with any status', () => {
    const flagged = {flagged: true, reasons: ['split_vote']};
    for (const status of ['routed', 'needs_info', 'human_review']) {
      const human_review =
        status === 'human_review' ? flagged : validResult.human_review;
      expect(
        RouteResultSchema.safeParse({...validResult, status, human_review})
          .success,
      ).toBe(true);
    }
  });

  it('rejects a tier or label that does not match the disposition', () => {
    expect(
      RouteResultSchema.safeParse({...validResult, tier: 'emergency'}).success,
    ).toBe(false);
    expect(
      RouteResultSchema.safeParse({...validResult, brief_label: 'SELF_CARE'})
        .success,
    ).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(
      RouteResultSchema.safeParse({...validResult, confidence: 1.1}).success,
    ).toBe(false);
    expect(
      RouteResultSchema.safeParse({...validResult, confidence: null}).success,
    ).toBe(true);
  });

  it('requires votes for every level with non-negative integers', () => {
    const partial: Partial<Record<Level, number>> = {
      ...validResult.votes.primary,
    };
    delete partial.routine;
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        votes: {primary: partial, secondary: null},
      }).success,
    ).toBe(false);
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        votes: {
          primary: {...validResult.votes.primary, routine: -1},
          secondary: null,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown reason codes and unknown top-level keys', () => {
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        human_review: {flagged: true, reasons: ['bogus']},
      }).success,
    ).toBe(false);
    expect(
      RouteResultSchema.safeParse({...validResult, extra: 1}).success,
    ).toBe(false);
  });

  it('rejects a disposition below the floor', () => {
    const r = RouteResultSchema.safeParse({...validResult, floor: 'ed_now'});
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(['disposition']);
  });

  it('accepts a disposition at or above the floor', () => {
    for (const floor of ['routine', 'self_care', null]) {
      expect(RouteResultSchema.safeParse({...validResult, floor}).success).toBe(
        true,
      );
    }
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        disposition: 'ed_now',
        tier: 'emergency',
        brief_label: 'URGENT_ESCALATION',
        floor: 'in_person_today',
      }).success,
    ).toBe(true);
  });

  it('requires a reason code and the flag when status is human_review', () => {
    const hr = {
      ...validResult,
      status: 'human_review',
      disposition: null,
      tier: null,
      brief_label: null,
    };
    const noFlag = RouteResultSchema.safeParse({
      ...hr,
      human_review: {flagged: false, reasons: ['split_vote']},
    });
    expect(noFlag.success).toBe(false);
    expect(noFlag.error?.issues[0].path).toEqual(['human_review', 'flagged']);
    const noReason = RouteResultSchema.safeParse({
      ...hr,
      human_review: {flagged: true, reasons: []},
    });
    expect(noReason.success).toBe(false);
    expect(noReason.error?.issues[0].path).toEqual(['human_review', 'reasons']);
    expect(
      RouteResultSchema.safeParse({
        ...hr,
        human_review: {flagged: true, reasons: ['split_vote']},
      }).success,
    ).toBe(true);
  });

  it('requires a reason code whenever human review is flagged', () => {
    const r = RouteResultSchema.safeParse({
      ...validResult,
      human_review: {flagged: true, reasons: []},
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(['human_review', 'reasons']);
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        human_review: {flagged: true, reasons: ['wide_spread']},
      }).success,
    ).toBe(true);
  });

  it('exported JSON schema file matches the current Zod export', () =>
    expect(readJson('../../schema/route-result.schema.json')).toEqual(
      z.toJSONSchema(RouteResultSchema),
    ));
});
