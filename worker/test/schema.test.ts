import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {type Level} from '../src/levels';
import {loadPolicy} from '../src/policy';
import {
  RouteResultSchema,
  SampleSchema,
  extractionJsonSchema,
  extractionSchema,
  salvageFlags,
} from '../src/schema';
import {fakeExtraction, toWire, validResult} from './fixtures';

const policy = loadPolicy();

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

describe('extractionSchema', () => {
  const s = extractionSchema(policy);
  const ok = toWire(fakeExtraction(policy));
  const first = policy.red_flags[0].id;

  it('parses the list form into flags keyed by id', () => {
    expect(s.parse(ok)).toEqual(fakeExtraction(policy));
  });

  it('requires every policy flag exactly once', () => {
    const missing = ok.red_flags.filter(f => f.id !== first);
    expect(s.safeParse({...ok, red_flags: missing}).success).toBe(false);
    const twice = [...ok.red_flags, {...ok.red_flags[0], state: 'present'}];
    expect(s.safeParse({...ok, red_flags: twice}).success).toBe(false);
    const unknown = [
      ...ok.red_flags,
      {id: 'not_a_flag', state: 'absent', excerpt: ''},
    ];
    expect(s.safeParse({...ok, red_flags: unknown}).success).toBe(false);
  });

  it('requires every modifier and rejects unknown keys', () => {
    const rest = {...ok.modifiers};
    delete rest[policy.modifiers[0].id];
    expect(s.safeParse({...ok, modifiers: rest}).success).toBe(false);
    expect(s.safeParse({...ok, extra: 1}).success).toBe(false);
  });

  it('allows at most three questions', () => {
    expect(s.safeParse({...ok, questions: ['a', 'b', 'c']}).success).toBe(true);
    expect(s.safeParse({...ok, questions: ['a', 'b', 'c', 'd']}).success).toBe(
      false,
    );
  });

  it('reads a blank excerpt as no excerpt', () => {
    const mod = policy.modifiers[0].id;
    const withFirst = (excerpt: string | null) => ({
      ...ok,
      red_flags: ok.red_flags.map(f =>
        f.id === first ? {id: first, state: 'present', excerpt} : f,
      ),
      modifiers: {...ok.modifiers, [mod]: {present: true, excerpt}},
    });
    for (const excerpt of ['', '  ', null]) {
      const parsed = s.parse(withFirst(excerpt));
      expect(parsed.red_flags[first].excerpt).toBeNull();
      expect(parsed.modifiers[mod].excerpt).toBeNull();
    }
    expect(s.parse(withFirst('my chest')).red_flags[first].excerpt).toBe(
      'my chest',
    );
  });
});

describe('extractionJsonSchema', () => {
  const schema = extractionJsonSchema(policy) as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, unknown> & {
      red_flags: {
        type: string;
        items: {properties: Record<string, {type?: string; enum?: string[]}>};
      };
    };
  };

  it('serialises strictly with every key required', () => {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":true');
    expect(schema).not.toHaveProperty('$schema');
  });

  // Anthropic's strict mode rejects a schema with more than 16 fields that are
  // nullable or union-typed (seen live on Vertex, 2026-11-03).
  it('stays under the strict-mode limit on union-typed fields', () => {
    let unions = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if ('anyOf' in o || 'oneOf' in o || Array.isArray(o.type)) unions++;
      Object.values(o).forEach(walk);
    };
    walk(schema);
    expect(unions).toBeLessThanOrEqual(16);
  });

  it('asks for red flags as a list of policy ids with string excerpts', () => {
    const flags = schema.properties.red_flags;
    expect(flags.type).toBe('array');
    expect(flags.items.properties.id.enum).toEqual(
      policy.red_flags.map(f => f.id),
    );
    expect(flags.items.properties.excerpt).toEqual({type: 'string'});
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

  it('requires excerpt_verified on every modifier', () => {
    const mod = {id: 'age_65_plus', excerpt: 'I am 70'};
    expect(
      RouteResultSchema.safeParse({...validResult, modifiers: [mod]}).success,
    ).toBe(false);
    expect(
      RouteResultSchema.safeParse({
        ...validResult,
        modifiers: [{...mod, excerpt_verified: true}],
      }).success,
    ).toBe(true);
  });

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

  it('accepts secondary_unavailable as a reason code', () => {
    const r = RouteResultSchema.safeParse({
      ...validResult,
      human_review: {flagged: true, reasons: ['secondary_unavailable']},
    });
    expect(r.success).toBe(true);
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

describe('salvageFlags', () => {
  const ok = toWire(fakeExtraction(policy));
  const ids = policy.red_flags.map(f => f.id);

  it('keeps present flags and reads missing ones as unknown', () => {
    const list = [
      {id: 'cardiac_chest_pain', state: 'present', excerpt: 'my chest'},
    ];
    const out = salvageFlags(policy, {...ok, red_flags: list})!;
    expect(Object.keys(out)).toEqual(ids);
    expect(out.cardiac_chest_pain).toEqual({
      state: 'present',
      excerpt: 'my chest',
    });
    expect(out.anaphylaxis).toEqual({state: 'unknown', excerpt: null});
  });

  it('keeps the most severe state of a repeated flag', () => {
    const list = [
      {id: 'anaphylaxis', state: 'present', excerpt: 'throat closing'},
      {id: 'anaphylaxis', state: 'absent', excerpt: ''},
      {id: 'anaphylaxis', state: 'unknown', excerpt: ''},
    ];
    expect(salvageFlags(policy, {red_flags: list})!.anaphylaxis).toEqual({
      state: 'present',
      excerpt: 'throat closing',
    });
  });

  it('skips entries it cannot read', () => {
    const list = [
      {id: 'not_a_flag', state: 'present', excerpt: ''},
      {id: 'anaphylaxis', state: 'maybe', excerpt: ''},
      'anaphylaxis',
      null,
    ];
    const out = salvageFlags(policy, {red_flags: list})!;
    expect(Object.values(out).every(f => f.state === 'unknown')).toBe(true);
  });

  it.each([[null], ['text'], [{}], [{red_flags: 'x'}]])(
    'returns null without a flag list (%j)',
    json => {
      expect(salvageFlags(policy, json)).toBeNull();
    },
  );
});
