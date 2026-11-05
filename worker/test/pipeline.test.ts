import {describe, expect, it, vi} from 'vitest';
import type {Level} from '../src/levels';
import {
  FALLBACK_SAFETY_NET,
  fallbackJustification,
  route,
  traceLine,
  type EarlyEvent,
} from '../src/pipeline';
import {LlmError} from '../src/llm';
import {applyPolicyOverrides, selectModels} from '../src/overrides';
import {loadPolicy} from '../src/policy';
import {RouteResultSchema, type Sample} from '../src/schema';
import {
  M,
  PRIMARY,
  REFILL_WITH_CHEST,
  SECONDARY,
  SECRET_MSG,
  deferred,
  deps,
  scripted,
  tick,
} from './pipeline-fixtures';
import {validResult, type WireExtraction} from './fixtures';

const policy = loadPolicy();
const HR_MESSAGE =
  'Thanks for your message. A Counsel physician will review it within 1 ' +
  'hour. If this is an emergency, call 911 now.';

describe('route', () => {
  it('buried red flag beats unanimous routine samples', async () => {
    const onEarly = vi.fn();
    const r = await route(
      REFILL_WITH_CHEST,
      deps(
        scripted({flags: {cardiac_chest_pain: 'present'}, samples: 'routine'}),
      ),
      {onEarly},
    );
    expect(r.disposition).toBe('call_911');
    expect(onEarly).toHaveBeenCalledWith(
      expect.objectContaining({floor: 'call_911'}),
    );
  });

  it('emits the early event before sampling resolves', async () => {
    const gate = deferred();
    const order: string[] = [];
    const p = route(
      M,
      deps(
        scripted({
          flags: {fever_neck_stiffness: 'present'},
          samplesAwait: gate.promise,
          onSample: () => order.push('sample'),
        }),
      ),
      {onEarly: () => order.push('early')},
    );
    await tick();
    expect(order).toEqual(['early']);
    gate.resolve();
    await p;
  });

  it.each([
    [
      'extraction timeout',
      scripted({extractError: 'timeout'}),
      'extraction_failed',
      null,
    ],
    [
      'non-English, emergency floor',
      scripted({language: 'es', flags: {anaphylaxis: 'present'}}),
      'non_english',
      'call_911',
    ],
    ['not a care request', scripted({care: false}), 'out_of_scope', null],
    [
      '6 of 20 samples fail',
      scripted({sampleFailures: 6, samples: 'routine'}),
      'sampling_failed',
      null,
    ],
  ])('%s → human_review', async (_, llm, reason, disp) => {
    const r = await route(M, deps(llm));
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toContain(reason);
    expect(r.disposition).toBe(disp);
  });

  it('routes on 17 valid samples when 3 fail', async () =>
    expect(
      (await route(M, deps(scripted({sampleFailures: 3, samples: 'routine'}))))
        .disposition,
    ).toBe('routine'));

  it('too_long makes no LLM call', async () => {
    const llm = scripted({});
    const r = await route('x'.repeat(4001), deps(llm));
    expect(r.human_review.reasons).toEqual(['too_long']);
    expect(llm.calls).toBe(0);
  });

  it('needs_info carries a provisional disposition', async () => {
    const r = await route(
      M,
      deps(scripted({questions: ['Any fever?'], samples: 'in_person_today'})),
    );
    expect(r.status).toBe('needs_info');
    expect(r.disposition).toBe('in_person_today');
  });

  it('logs no message text on success or failure', async () => {
    for (const llm of [
      scripted({samples: 'routine'}),
      scripted({extractError: 'provider_error'}),
    ]) {
      const lines: string[] = [];
      await route(SECRET_MSG, {...deps(llm), log: l => lines.push(l)});
      expect(lines.join()).not.toContain(SECRET_MSG);
      const routeLine = lines
        .map(l => JSON.parse(l))
        .find(l => l.kind === 'route');
      expect(routeLine.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('logs neither a partial excerpt nor the message', async () => {
    const excerpt = 'itchy rash on my forearm';
    expect(SECRET_MSG).toContain(excerpt);
    const lines: string[] = [];
    const llm = scripted({flags: {diabetic_foot_redness: 'present'}, excerpt});
    await route(SECRET_MSG, {...deps(llm), log: l => lines.push(l)});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(excerpt);
    expect(lines[0]).not.toContain(SECRET_MSG);
    expect(JSON.parse(lines[0]).red_flags_present).toEqual([
      'diabetic_foot_redness',
    ]);
  });

  it('does not log a short message quoted whole as the excerpt', async () => {
    const short = 'Crushing chest pressure into my jaw.';
    const lines: string[] = [];
    const llm = scripted({
      flags: {cardiac_chest_pain: 'present'},
      // A sample that repeats the message must not reach the log either.
      sampleFor: () => ({
        disposition: 'call_911',
        justification: `The patient wrote: ${short}`,
        safety_net: `Because "${short}", call 911.`,
      }),
    });
    const r = await route(short, {...deps(llm), log: l => lines.push(l)});
    // The excerpt equals the entire message, and it is in the response.
    expect(r.red_flags.find(f => f.id === 'cardiac_chest_pain')?.excerpt).toBe(
      short,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(short);
    expect(lines[0]).not.toContain('Crushing');
  });
});

describe('route: result details', () => {
  it('builds a schema-valid routed result', async () => {
    const r = await route(M, deps(scripted({samples: 'routine'})));
    expect(RouteResultSchema.safeParse(r).success).toBe(true);
    expect(r.status).toBe('routed');
    expect(r.confidence).toBe(1);
    expect(r.votes.primary.routine).toBe(20);
    expect(r.votes.secondary).toBeNull();
    expect(r.human_review).toEqual({flagged: false, reasons: []});
    expect(r.justification).toBe('Test justification for routine.');
    expect(r.safety_net).toBe('Seek care sooner if it gets worse.');
    expect(r.patient_message).toBe(
      `${policy.levels.routine.patient_message} Seek care sooner if it gets worse.`,
    );
    expect(r.trace.models).toEqual([PRIMARY]);
    expect(r.trace.policy_version).toBe(policy.policy_version);
    const raw = r.trace.raw as {primary: string[]; secondary: unknown};
    expect(raw.primary).toHaveLength(20);
    expect(raw.secondary).toBeNull();
  });

  it('hashes the original message with SHA-256', async () => {
    const r = await route('abc', deps(scripted({})));
    expect(r.trace.input_sha256).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('lists every policy flag in order with verified excerpts', async () => {
    const r = await route(
      REFILL_WITH_CHEST,
      deps(scripted({flags: {cardiac_chest_pain: 'present'}})),
    );
    expect(r.red_flags.map(f => f.id)).toEqual(policy.red_flags.map(f => f.id));
    const chest = r.red_flags.find(f => f.id === 'cardiac_chest_pain');
    expect(chest).toEqual({
      id: 'cardiac_chest_pain',
      state: 'present',
      excerpt: REFILL_WITH_CHEST,
      excerpt_verified: true,
    });
    const others = r.red_flags.filter(f => f.id !== 'cardiac_chest_pain');
    expect(others.every(f => f.state === 'absent' && !f.excerpt_verified)).toBe(
      true,
    );
  });

  it('adds a flag instruction to the early and final messages', async () => {
    const onEarly = vi.fn<(e: EarlyEvent) => void>();
    const r = await route(
      M,
      deps(scripted({flags: {suicidal_plan_or_intent: 'present'}})),
      {onEarly},
    );
    const expected =
      `${policy.levels.call_911.patient_message} ` +
      'Call 911 or the 988 Suicide & Crisis Lifeline now.';
    expect(onEarly).toHaveBeenCalledWith({
      event: 'early',
      floor: 'call_911',
      patient_message: expected,
    });
    expect(r.patient_message.startsWith(expected)).toBe(true);
  });

  it('does not emit early below Emergency', async () => {
    const onEarly = vi.fn();
    await route(M, deps(scripted({mods: ['anticoagulation']})), {onEarly});
    expect(onEarly).not.toHaveBeenCalled();
  });

  it('flags an unverified excerpt but keeps the floor', async () => {
    const llm = scripted({flags: {fever_neck_stiffness: 'present'}});
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      const res = await inner(req);
      if (req.schemaName !== 'extraction') return res;
      const ex = res.json as WireExtraction;
      ex.red_flags.find(f => f.id === 'fever_neck_stiffness')!.excerpt =
        'a paraphrase not in it';
      return {...res, raw: JSON.stringify(ex)};
    };
    const r = await route(M, deps(llm));
    expect(r.disposition).toBe('ed_now');
    expect(r.human_review.flagged).toBe(true);
    expect(r.human_review.reasons).toContain('unverified_excerpt');
    expect(r.red_flags.find(f => f.id === 'fever_neck_stiffness')).toEqual(
      expect.objectContaining({state: 'present', excerpt_verified: false}),
    );
  });

  it('flags an unverified modifier excerpt but keeps the floor', async () => {
    const verified = await route(
      M,
      deps(scripted({mods: ['age_65_plus'], samples: 'self_care'})),
    );
    const llm = scripted({mods: ['age_65_plus'], samples: 'self_care'});
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      const res = await inner(req);
      if (req.schemaName !== 'extraction') return res;
      const ex = res.json as {modifiers: Record<string, {excerpt: string}>};
      ex.modifiers.age_65_plus.excerpt = 'a paraphrase not in it';
      return {...res, raw: JSON.stringify(ex)};
    };
    const r = await route(M, deps(llm));
    expect(r.modifiers).toEqual([
      {
        id: 'age_65_plus',
        excerpt: 'a paraphrase not in it',
        excerpt_verified: false,
      },
    ]);
    expect(r.human_review.flagged).toBe(true);
    expect(r.human_review.reasons).toContain('unverified_excerpt');
    // The modifier still counts toward the floor.
    expect(r.floor).toBe('routine');
    expect(r.floor).toBe(verified.floor);
    expect(r.disposition).toBe(verified.disposition);
  });

  it('does not flag a modifier whose excerpt verifies', async () => {
    const r = await route(
      M,
      deps(scripted({mods: ['age_65_plus'], samples: 'self_care'})),
    );
    expect(r.modifiers).toEqual([
      expect.objectContaining({id: 'age_65_plus', excerpt_verified: true}),
    ]);
    expect(r.human_review.reasons).not.toContain('unverified_excerpt');
    expect(r.human_review.flagged).toBe(false);
  });

  it('human review without a disposition uses the fixed message', async () => {
    const r = await route(M, deps(scripted({care: false})));
    expect(r.patient_message).toBe(HR_MESSAGE);
    expect(r.safety_net).toBe('');
    expect(r.justification).not.toBe('');
    expect(r.tier).toBeNull();
    expect(r.human_review.flagged).toBe(true);
    expect(RouteResultSchema.safeParse(r).success).toBe(true);
  });

  it('carries an Emergency floor through sampling failure', async () => {
    const r = await route(
      REFILL_WITH_CHEST,
      deps(
        scripted({
          flags: {cardiac_chest_pain: 'present'},
          sampleFailures: 6,
        }),
      ),
    );
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toEqual(['sampling_failed']);
    expect(r.disposition).toBe('call_911');
    expect(r.votes.primary.call_911).toBe(14);
  });

  it('drops a non-Emergency floor on human review', async () => {
    const r = await route(
      M,
      deps(scripted({mods: ['anticoagulation'], language: 'fr'})),
    );
    expect(r.floor).not.toBeNull();
    expect(r.disposition).toBeNull();
  });

  it('returns schema_invalid on an unexpected exception', async () => {
    // min_valid 0 lets zero votes reach chooseLevel, which throws.
    const d = deps(
      scripted({flags: {anaphylaxis: 'present'}, sampleFailures: 20}),
    );
    d.policy = {...policy, sampling: {...policy.sampling, min_valid: 0}};
    const lines: string[] = [];
    d.log = l => lines.push(l);
    const r = await route(M, d);
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toEqual(['schema_invalid']);
    expect(r.disposition).toBe('call_911');
    // The sample_errors line for the 20 failed samples, then the trace line.
    expect(lines.map(l => JSON.parse(l).kind)).toEqual([
      'sample_errors',
      'route',
    ]);
  });

  it('never throws when the log or onEarly throws', async () => {
    const d = deps(scripted({flags: {anaphylaxis: 'present'}}));
    d.log = () => {
      throw new Error('log down');
    };
    const r = await route(M, d, {
      onEarly: () => {
        throw new Error('stream closed');
      },
    });
    expect(r.disposition).toBe('call_911');
  });
});

describe('route: fallback justification', () => {
  const net = (level: Level, safety_net: string): Sample => ({
    disposition: level,
    justification: `Argues for ${level}.`,
    safety_net,
  });

  it('explains a red-flag floor over routine samples', async () => {
    const r = await route(
      REFILL_WITH_CHEST,
      deps(
        scripted({
          flags: {cardiac_chest_pain: 'present'},
          sampleFor: i =>
            i % 4 === 3
              ? net('within_few_days', `Acute net ${i}`)
              : net('routine', 'Routine net'),
        }),
      ),
    );
    expect(r.disposition).toBe('call_911');
    expect(r.justification).toBe(
      'Red flag(s) cardiac_chest_pain set a minimum of Call 911. The ' +
        'samples proposed Routine below that, so the floor applies. This is ' +
        'the most urgent level.',
    );
    expect(r.safety_net).toBe('Acute net 3');
    expect(r.patient_message).toBe(
      `${policy.levels.call_911.patient_message} Acute net 3`,
    );
  });

  it('uses the fixed safety net when no sample gave one', async () => {
    const r = await route(
      REFILL_WITH_CHEST,
      deps(
        scripted({
          flags: {cardiac_chest_pain: 'present'},
          sampleFor: () => net('routine', ''),
        }),
      ),
    );
    expect(r.safety_net).toBe(FALLBACK_SAFETY_NET);
    expect(r.safety_net).toBe(
      'If your symptoms get worse, or you are worried, call 911 or go to ' +
        'the nearest emergency department.',
    );
    expect(r.patient_message).toBe(
      `${policy.levels.call_911.patient_message} ${FALLBACK_SAFETY_NET}`,
    );
  });

  it('uses the fixed safety net when unanimous samples give blank nets', async () => {
    const r = await route(
      M,
      deps(scripted({sampleFor: () => net('routine', '  ')})),
    );
    expect(r.status).toBe('routed');
    expect(r.disposition).toBe('routine');
    expect(r.human_review.flagged).toBe(false);
    expect(r.justification).toBe('Argues for routine.');
    expect(r.safety_net).toBe(FALLBACK_SAFETY_NET);
    expect(r.patient_message).toBe(
      `${policy.levels.routine.patient_message} ${FALLBACK_SAFETY_NET}`,
    );
  });

  it("falls back to another sample's net when the chosen one is blank", async () => {
    const r = await route(
      M,
      deps(
        scripted({
          sampleFor: i =>
            i === 5
              ? net('within_few_days', 'Few days net')
              : net('routine', ' '),
        }),
      ),
    );
    expect(r.disposition).toBe('routine');
    expect(r.justification).toBe('Argues for routine.');
    expect(r.safety_net).toBe('Few days net');
    expect(r.patient_message).toBe(
      `${policy.levels.routine.patient_message} Few days net`,
    );
  });

  it('skips whitespace-only nets when choosing a fallback', async () => {
    const r = await route(
      M,
      deps(
        scripted({
          sampleFor: i =>
            i === 1
              ? net('within_few_days', ' \n\t ')
              : i === 2
                ? net('routine', 'Later routine net')
                : net('routine', '\t'),
        }),
      ),
    );
    expect(r.disposition).toBe('routine');
    expect(r.safety_net).toBe('Later routine net');
  });

  it('says why not one level higher below call_911', async () => {
    const r = await route(
      M,
      deps(
        scripted({
          flags: {orthopnea_or_leg_swelling: 'present'},
          samples: 'routine',
        }),
      ),
    );
    expect(r.disposition).toBe('in_person_today');
    expect(r.justification).toBe(
      'Red flag(s) orthopnea_or_leg_swelling set a minimum of In person ' +
        'today. The samples proposed Routine below that, so the floor ' +
        'applies. Not ED now because no red flag or sample supports it.',
    );
  });

  it('explains a modifier-raised minimum over lower samples', async () => {
    const r = await route(
      M,
      deps(scripted({mods: ['age_65_plus'], samples: 'self_care'})),
    );
    expect(r.floor).toBe('routine');
    expect(r.disposition).toBe('routine');
    expect(r.justification).toContain('age_65_plus');
    expect(r.justification).toContain('Routine');
    expect(r.justification).not.toContain('split between');
    expect(r.justification).toBe(
      'Risk factor age_65_plus raises the minimum to Routine. The samples ' +
        'proposed Self-care below that, so the minimum applies. Not Within ' +
        'a few days because no red flag or sample supports it.',
    );
  });

  it('does not claim the floor applies when routed above it', async () => {
    // Floor in_person_today from a flag; 2 x call_911 and 18 x routine
    // proposed. The router picks ed_now, above the floor, and no sample
    // proposed it.
    const r = await route(
      M,
      deps(
        scripted({
          flags: {orthopnea_or_leg_swelling: 'present'},
          sampleFor: i =>
            i < 2 ? net('call_911', 'Urgent net') : net('routine', 'R'),
        }),
      ),
    );
    expect(r.floor).toBe('in_person_today');
    expect(r.disposition).toBe('ed_now');
    expect(r.justification).not.toContain('floor applies');
    expect(r.justification).toBe(
      'Routed by expected cost: the samples split between Call 911 (2) and ' +
        'Routine (18), and under-triage costs more than over-triage at this ' +
        'boundary. Not Call 911 because too few samples supported it.',
    );
  });

  it('says "all proposed" when the samples agreed on one level', () => {
    // Not reachable through route(): one agreed level is either chosen or
    // clamped to a flag or modifier floor. Checked directly.
    const floor = {
      floor: 'self_care' as const,
      drivers: [],
      modifier_applied: null,
      unverified: [],
    };
    const samples = Array.from({length: 20}, () => net('routine', ''));
    expect(fallbackJustification('ed_now', floor, samples)).toBe(
      'Routed by expected cost: the samples all proposed Routine (20), and ' +
        'under-triage costs more than over-triage at this boundary. Not ' +
        'Call 911 because too few samples supported it.',
    );
  });

  it('explains an expected-cost choice no sample proposed', async () => {
    // 4 x call_911 and 16 x routine: the router picks ed_now, which no
    // sample proposed.
    const r = await route(
      M,
      deps(
        scripted({
          sampleFor: i =>
            i < 4 ? net('call_911', `Urgent net ${i}`) : net('routine', 'R'),
        }),
      ),
    );
    expect(r.disposition).toBe('ed_now');
    expect(r.justification).toBe(
      'Routed by expected cost: the samples split between Call 911 (4) and ' +
        'Routine (16), and under-triage costs more than over-triage at this ' +
        'boundary. Not Call 911 because too few samples supported it.',
    );
    expect(r.safety_net).toBe('Urgent net 0');
    expect(r.human_review.reasons).toContain('wide_spread');
  });
});

describe('route: floor_only mode', () => {
  it('skips sampling and routes at the floor', async () => {
    const llm = scripted({flags: {thunderclap_headache: 'present'}});
    const r = await route(M, deps(llm), {mode: 'floor_only'});
    expect(llm.calls).toBe(1);
    expect(r.status).toBe('routed');
    expect(r.disposition).toBe('ed_now');
    expect(r.confidence).toBeNull();
    expect(Object.values(r.votes.primary).every(n => n === 0)).toBe(true);
    expect(r.votes.secondary).toBeNull();
    expect(r.justification).toBe('Rule floor: thunderclap_headache.');
    expect(RouteResultSchema.safeParse(r).success).toBe(true);
  });

  it('says none when no flag drives the floor', async () => {
    const r = await route(M, deps(scripted({})), {mode: 'floor_only'});
    expect(r.disposition).toBe('self_care');
    expect(r.justification).toBe('Rule floor: none.');
  });

  it('still applies scope rules first', async () => {
    const r = await route(M, deps(scripted({care: false})), {
      mode: 'floor_only',
    });
    expect(r.human_review.reasons).toEqual(['out_of_scope']);
  });
});

describe('route: secondary model', () => {
  it('records both families and flags a tier disagreement', async () => {
    const d = {
      ...deps(scripted({samples: 'routine', secondary: 'ed_now'})),
      secondary: SECONDARY,
    };
    const r = await route(M, d);
    expect(r.trace.models).toEqual([PRIMARY, SECONDARY]);
    expect(r.votes.secondary?.ed_now).toBe(20);
    expect(r.human_review.reasons).toContain('family_disagreement');
    expect(r.human_review.flagged).toBe(true);
    expect(r.disposition).toBe('routine');
  });

  it('flags a configured secondary that failed, keeping the disposition', async () => {
    const d = {
      ...deps(scripted({samples: 'routine', secondary: 'fail'})),
      secondary: SECONDARY,
    };
    const r = await route(M, d);
    expect(r.status).toBe('routed');
    expect(r.disposition).toBe('routine');
    expect(r.human_review.flagged).toBe(true);
    expect(r.human_review.reasons).toEqual(['secondary_unavailable']);
    expect(r.patient_message).toContain(policy.levels.routine.patient_message);
    expect(r.votes.secondary).toEqual(
      expect.objectContaining({routine: 0, ed_now: 0}),
    );
    expect((r.trace.raw as {secondary: string[]}).secondary).toEqual([]);
  });
});

describe('route: overrides', () => {
  it('gives Human review when both models fail to extract in one-model mode', async () => {
    const llm = scripted({extractError: 'provider_error'});
    const models = selectModels('flash', PRIMARY, SECONDARY);
    const r = await route(
      REFILL_WITH_CHEST,
      {...deps(llm), ...models},
      {overrides: {models: 'flash'}},
    );
    expect(models.secondary).toBeNull();
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.disposition).toBeNull();
    // Flash, then Sonnet as the extraction backup.
    expect(llm.calls).toBe(2);
    expect(r.trace.models).toEqual([SECONDARY, PRIMARY]);
    expect(r.trace.extraction_model).toBeNull();
    expect(r.trace.overrides).toEqual({models: 'flash'});
  });

  it.each([
    // [choice, model that times out, backup model]
    ['flash', SECONDARY, PRIMARY],
    ['sonnet', PRIMARY, SECONDARY],
  ] as const)(
    'models %s: the other model backs up a failed extraction, floors only',
    async (choice, only, backup) => {
      const onEarly = vi.fn();
      const llm = scripted({
        extractError: 'timeout',
        extractErrorOn: only === PRIMARY ? 'primary' : 'secondary',
        flags: {cardiac_chest_pain: 'present'},
        samples: 'routine',
      });
      const models = selectModels(choice, PRIMARY, SECONDARY);
      expect(models.secondary).toBeNull();
      expect(models.extractionFallback).toEqual(backup);
      const r = await route(
        REFILL_WITH_CHEST,
        {...deps(llm), ...models},
        {overrides: {models: choice}, onEarly},
      );
      expect(r.status).toBe('human_review');
      expect(r.human_review.reasons).toEqual(['extraction_failed']);
      expect(r.floor).toBe('call_911');
      expect(r.disposition).toBe('call_911');
      expect(onEarly).toHaveBeenCalledWith(
        expect.objectContaining({floor: 'call_911'}),
      );
      expect(r.trace.models).toEqual([only, backup]);
      expect(r.trace.extraction_model).toEqual(backup);
      // One extraction each, and the backup never samples.
      expect(llm.requests).toEqual([
        {schemaName: 'extraction', model: only.model},
        {schemaName: 'extraction', model: backup.model},
      ]);
      expect(r.votes.secondary).toBeNull();
    },
  );

  it('one-model mode never calls the backup when extraction succeeds', async () => {
    const llm = scripted({samples: 'routine'});
    const models = selectModels('flash', PRIMARY, SECONDARY);
    const r = await route(M, {...deps(llm), ...models});
    expect(r.status).toBe('routed');
    expect(r.trace.models).toEqual([SECONDARY]);
    expect(r.trace.extraction_model).toEqual(SECONDARY);
    expect(llm.requests.every(q => q.model === SECONDARY.model)).toBe(true);
    expect(r.votes.secondary).toBeNull();
  });

  it('keeps an emergency the deployed policy would choose', async () => {
    // Deployed weights: ed_now costs 4.25, self_care 4.575, so ed_now.
    // Overridden: self_care costs 3.3, so self_care without the guard.
    const o = {under_weights: [3, 20, 0.5, 0.5, 0.5, 0.5], max_span: 6};
    const sampleFor = (i: number): Sample => ({
      disposition: i < 3 ? 'ed_now' : 'self_care',
      justification: 'Test justification.',
      safety_net: 'Seek care sooner if it gets worse.',
    });
    const effective = applyPolicyOverrides(policy, o);
    const unguarded = await route(M, {
      ...deps(scripted({sampleFor})),
      policy: effective,
    });
    expect(unguarded.disposition).toBe('self_care');

    const r = await route(
      M,
      {...deps(scripted({sampleFor})), policy: effective},
      {overrides: {policy: o}, deployedPolicy: policy},
    );
    expect(r.votes.primary.ed_now).toBe(3);
    expect(r.votes.primary.self_care).toBe(17);
    expect(r.disposition).toBe('ed_now');
    expect(r.patient_message).toContain(policy.levels.ed_now.patient_message);
  });

  it('lets the override choose when the deployed choice is below ed_now', async () => {
    // 8 within_few_days / 12 routine. Deployed: within_few_days (0.6 vs
    // 0.8). With the routine boundary's under weight at 0.5: routine (0.2).
    const o = {under_weights: [3, 20, 2, 5, 0.5, 1.5]};
    const sampleFor = (i: number): Sample => ({
      disposition: i < 8 ? 'within_few_days' : 'routine',
      justification: 'Test justification.',
      safety_net: 'Seek care sooner if it gets worse.',
    });
    const base = await route(M, deps(scripted({sampleFor})));
    expect(base.disposition).toBe('within_few_days');
    const r = await route(
      M,
      {
        ...deps(scripted({sampleFor})),
        policy: applyPolicyOverrides(policy, o),
      },
      {overrides: {policy: o}, deployedPolicy: policy},
    );
    expect(r.disposition).toBe('routine');
  });

  it('flags a 19/1 split under an overridden min_top_votes', async () => {
    const o = {min_top_votes: 20};
    const sampleFor = (i: number): Sample => ({
      disposition: i === 0 ? 'within_few_days' : 'routine',
      justification: 'Test justification.',
      safety_net: 'Seek care sooner if it gets worse.',
    });
    const base = await route(M, deps(scripted({sampleFor})));
    expect(base.human_review.reasons).not.toContain('split_vote');
    expect(base.trace.overrides).toBeNull();

    const r = await route(
      M,
      {
        ...deps(scripted({sampleFor})),
        policy: applyPolicyOverrides(policy, o),
      },
      {overrides: {policy: o}},
    );
    expect(r.votes.primary.routine).toBe(19);
    expect(r.human_review.reasons).toContain('split_vote');
    expect(r.human_review.flagged).toBe(true);
    expect(r.disposition).toBe(base.disposition);
    expect(r.trace.overrides).toEqual({policy: o});
    expect(r.trace.policy_version).toBe(policy.policy_version);
  });
});

describe('route: extraction fallback', () => {
  it('ends at Human review but carries the secondary floor when the primary fails', async () => {
    const onEarly = vi.fn();
    const llm = scripted({
      extractError: 'provider_error',
      extractErrorOn: 'primary',
      flags: {cardiac_chest_pain: 'present'},
      samples: 'routine',
    });
    const r = await route(
      REFILL_WITH_CHEST,
      {...deps(llm), secondary: SECONDARY},
      {onEarly},
    );
    expect(r.status).toBe('human_review');
    expect(r.human_review.flagged).toBe(true);
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(r.disposition).toBe('call_911');
    expect(onEarly).toHaveBeenCalledWith(
      expect.objectContaining({floor: 'call_911'}),
    );
    expect(r.trace.models).toEqual([PRIMARY, SECONDARY]);
    expect(r.trace.extraction_model).toEqual(SECONDARY);
    // Two extraction calls, no sampling.
    expect(llm.calls).toBe(2);
  });

  it('ends at Human review when the primary times out and the secondary finds no flag', async () => {
    // Codex's scenario: sampling would vote self_care for every sample.
    const llm = scripted({
      extractError: 'timeout',
      extractErrorOn: 'primary',
      samples: 'self_care',
    });
    const r = await route(M, {...deps(llm), secondary: SECONDARY});
    expect(r.status).toBe('human_review');
    expect(r.human_review.flagged).toBe(true);
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.disposition).toBeNull();
    expect(r.trace.extraction_model).toEqual(SECONDARY);
    expect(llm.calls).toBe(2);
  });

  it('records the primary as the extraction model when it succeeds', async () => {
    const r = await route(M, {...deps(scripted({})), secondary: SECONDARY});
    expect(r.trace.extraction_model).toEqual(PRIMARY);
  });

  it('gives Human review when both models fail to extract', async () => {
    const lines: string[] = [];
    const llm = scripted({extractError: 'timeout'});
    const r = await route(SECRET_MSG, {
      ...deps(llm),
      secondary: SECONDARY,
      log: l => lines.push(l),
    });
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.disposition).toBeNull();
    expect(r.trace.extraction_model).toBeNull();
    expect(llm.calls).toBe(2);
    // Each failed extraction is logged by model and error code, without text.
    const errors = lines
      .map(l => JSON.parse(l))
      .filter(l => l.kind === 'llm_error');
    expect(errors).toEqual([
      {
        kind: 'llm_error',
        step: 'extraction',
        model: PRIMARY.model,
        code: 'timeout',
      },
      {
        kind: 'llm_error',
        step: 'extraction',
        model: SECONDARY.model,
        code: 'timeout',
      },
    ]);
    expect(lines.join('\n')).not.toContain('SYNTHETIC-SECRET');
  });

  describe('sample_errors log', () => {
    // Fails the first 3 primary sample calls with a 429 and 2 with a timeout.
    function failingSamples() {
      const llm = scripted({samples: 'routine'});
      const inner = llm.complete.bind(llm);
      let n = 0;
      llm.complete = async req => {
        if (req.schemaName === 'extraction' || req.spec.model !== PRIMARY.model)
          return inner(req);
        const i = n++;
        if (i < 3) throw new LlmError('provider_error', 'limited', 429);
        if (i < 5) throw new LlmError('timeout', 'timed out');
        return inner(req);
      };
      return llm;
    }

    it('logs one line per model with failures, without text', async () => {
      const lines: string[] = [];
      const r = await route(SECRET_MSG, {
        ...deps(failingSamples()),
        secondary: SECONDARY,
        log: l => lines.push(l),
      });
      expect(r.status).toBe('routed');
      const errs = lines
        .map(l => JSON.parse(l))
        .filter(l => l.kind === 'sample_errors');
      expect(errs).toEqual([
        {
          kind: 'sample_errors',
          model: PRIMARY.model,
          valid: 15,
          n: 20,
          failures: {'provider_error:429': 3, timeout: 2},
        },
      ]);
      expect(lines.join('\n')).not.toContain('SYNTHETIC-SECRET');
    });

    it('logs nothing when no sample failed', async () => {
      const lines: string[] = [];
      await route(M, {...deps(scripted({})), log: l => lines.push(l)});
      expect(lines.some(l => JSON.parse(l).kind === 'sample_errors')).toBe(
        false,
      );
    });

    it('a throwing logger does not change the result', async () => {
      const ok = await route(M, deps(failingSamples()));
      const r = await route(M, {
        ...deps(failingSamples()),
        log: () => {
          throw new Error('log down');
        },
      });
      expect(r.disposition).toBe(ok.disposition);
      expect(r.status).toBe(ok.status);
    });
  });

  // Replaces the red_flags of the named model's extraction output.
  function editFlags(
    llm: ReturnType<typeof scripted>,
    model: string,
    edit: (flags: WireExtraction['red_flags']) => unknown,
  ) {
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      const res = await inner(req);
      if (req.schemaName !== 'extraction' || req.spec.model !== model) {
        return res;
      }
      const ex = res.json as WireExtraction;
      const json = {...ex, red_flags: edit(ex.red_flags)};
      return {...res, json, raw: JSON.stringify(json)};
    };
    return llm;
  }

  it('asks the secondary when the primary returns an empty flag list', async () => {
    const llm = editFlags(
      scripted({flags: {cardiac_chest_pain: 'present'}}),
      PRIMARY.model,
      () => [],
    );
    const r = await route(REFILL_WITH_CHEST, {
      ...deps(llm),
      secondary: SECONDARY,
    });
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(r.trace.extraction_model).toEqual(SECONDARY);
    expect(llm.calls).toBe(2);
  });

  it('asks the secondary when the primary output has no flag list', async () => {
    const llm = editFlags(
      scripted({flags: {cardiac_chest_pain: 'present'}}),
      PRIMARY.model,
      () => undefined,
    );
    const r = await route(REFILL_WITH_CHEST, {
      ...deps(llm),
      secondary: SECONDARY,
    });
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(r.trace.extraction_model).toEqual(SECONDARY);
    expect(llm.calls).toBe(2);
  });

  it('floors salvaged flags from the secondary after a primary error', async () => {
    const llm = editFlags(
      scripted({
        extractError: 'timeout',
        extractErrorOn: 'primary',
        flags: {cardiac_chest_pain: 'present'},
      }),
      SECONDARY.model,
      f => f.filter(e => e.id !== 'anaphylaxis'),
    );
    const r = await route(REFILL_WITH_CHEST, {
      ...deps(llm),
      secondary: SECONDARY,
    });
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(r.disposition).toBe('call_911');
    expect(r.trace.extraction_model).toEqual(SECONDARY);
  });

  it('keeps the floor when the logger throws', async () => {
    const onEarly = vi.fn();
    const llm = editFlags(
      scripted({flags: {cardiac_chest_pain: 'present'}}),
      PRIMARY.model,
      f => f.filter(e => e.id !== 'anaphylaxis'),
    );
    const r = await route(
      REFILL_WITH_CHEST,
      {
        ...deps(llm),
        secondary: SECONDARY,
        log: () => {
          throw new Error('broken sink');
        },
      },
      {onEarly},
    );
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(onEarly).toHaveBeenCalled();
  });

  it('logs the HTTP status of a failed extraction with no secondary', async () => {
    const lines: string[] = [];
    const llm = scripted({extractError: 'provider_error', extractStatus: 429});
    const r = await route(M, {...deps(llm), log: l => lines.push(l)});
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(llm.calls).toBe(1);
    const errors = lines
      .map(l => JSON.parse(l))
      .filter(l => l.kind === 'llm_error');
    expect(errors).toEqual([
      {
        kind: 'llm_error',
        step: 'extraction',
        model: PRIMARY.model,
        code: 'provider_error',
        status: 429,
      },
    ]);
  });

  it('keeps salvaged flags from the primary without a fallback call', async () => {
    const llm = scripted({flags: {cardiac_chest_pain: 'present'}});
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      const res = await inner(req);
      if (req.schemaName !== 'extraction') return res;
      const ex = res.json as {red_flags: {id: string}[]};
      const json = {
        ...ex,
        red_flags: ex.red_flags.filter(f => f.id !== 'anaphylaxis'),
      };
      return {...res, json, raw: JSON.stringify(json)};
    };
    const r = await route(REFILL_WITH_CHEST, {
      ...deps(llm),
      secondary: SECONDARY,
    });
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.floor).toBe('call_911');
    expect(r.trace.extraction_model).toEqual(PRIMARY);
    expect(llm.calls).toBe(1);
  });
});

describe('route: secondary below min_valid', () => {
  it('flags a secondary under min_valid and skips the disagreement check', async () => {
    // 6 of 20 secondary calls fail (14 valid < 15); the 14 valid ones
    // disagree on tier but must not count as a family disagreement.
    let n = 0;
    const llm = scripted({samples: 'routine', secondary: 'ed_now'});
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      if (req.spec.model === SECONDARY.model && n++ < 6) {
        throw new Error('secondary down');
      }
      return inner(req);
    };
    const r = await route(M, {...deps(llm), secondary: SECONDARY});
    expect(r.votes.secondary?.ed_now).toBe(14);
    expect(r.human_review.reasons).toEqual(['secondary_unavailable']);
    expect(r.human_review.flagged).toBe(true);
    expect(r.disposition).toBe('routine');
  });

  it('does not flag when no secondary is configured', async () => {
    const r = await route(M, deps(scripted({samples: 'routine'})));
    expect(r.votes.secondary).toBeNull();
    expect(r.human_review).toEqual({flagged: false, reasons: []});
  });

  it('keeps an Emergency floor when the secondary fails', async () => {
    const r = await route(REFILL_WITH_CHEST, {
      ...deps(
        scripted({
          flags: {cardiac_chest_pain: 'present'},
          samples: 'routine',
          secondary: 'fail',
        }),
      ),
      secondary: SECONDARY,
    });
    expect(r.disposition).toBe('call_911');
    expect(r.human_review.reasons).toEqual(['secondary_unavailable']);
  });
});

describe('traceLine', () => {
  it('is a route log line without the message', async () => {
    const r = await route(SECRET_MSG, deps(scripted({})));
    const line = JSON.parse(traceLine(r));
    expect(line.kind).toBe('route');
    expect(Date.parse(line.ts)).not.toBeNaN();
    expect(line.input_sha256).toBe(r.trace.input_sha256);
    expect(traceLine(r)).not.toContain(SECRET_MSG);
  });

  it('logs exactly the metadata allowlist', async () => {
    const r = await route(
      REFILL_WITH_CHEST,
      deps(
        scripted({
          flags: {cardiac_chest_pain: 'present'},
          mods: ['age_65_plus'],
          questions: ['How long has it lasted?'],
        }),
      ),
    );
    const line = JSON.parse(traceLine(r));
    expect(Object.keys(line).sort()).toEqual(
      [
        'kind',
        'ts',
        'input_sha256',
        'policy_version',
        'models',
        'latency_ms',
        'status',
        'disposition',
        'tier',
        'floor',
        'red_flags_present',
        'unverified',
        'modifiers_present',
        'votes',
        'confidence',
        'human_review',
        'info_requests',
        'time_sensitive',
        'overridden',
        'guard_raised',
      ].sort(),
    );
    expect(line).toEqual({
      kind: 'route',
      ts: expect.any(String),
      input_sha256: r.trace.input_sha256,
      policy_version: r.trace.policy_version,
      models: r.trace.models,
      latency_ms: r.trace.latency_ms,
      status: 'needs_info',
      disposition: 'call_911',
      tier: 'emergency',
      floor: 'call_911',
      red_flags_present: ['cardiac_chest_pain'],
      unverified: [],
      modifiers_present: ['age_65_plus'],
      votes: r.votes,
      confidence: r.confidence,
      human_review: r.human_review,
      info_requests: {count: 1, photo: false},
      time_sensitive: false,
      overridden: false,
      guard_raised: false,
    });
    expect(traceLine(r)).not.toContain('How long has it lasted?');
  });

  it('marks overridden routes and a guard raise in the logged line', async () => {
    // As in "keeps an emergency the deployed policy would choose".
    const o = {under_weights: [3, 20, 0.5, 0.5, 0.5, 0.5], max_span: 6};
    const sampleFor = (i: number): Sample => ({
      disposition: i < 3 ? 'ed_now' : 'self_care',
      justification: 'Test justification.',
      safety_net: 'Seek care sooner if it gets worse.',
    });
    const logged = async (opts: Parameters<typeof route>[2]) => {
      const lines: string[] = [];
      const r = await route(
        SECRET_MSG,
        {
          ...deps(scripted({sampleFor})),
          policy: applyPolicyOverrides(policy, o),
          log: l => lines.push(l),
        },
        opts,
      );
      const raw = lines.find(l => JSON.parse(l).kind === 'route') as string;
      expect(raw).not.toContain(SECRET_MSG);
      return {r, line: JSON.parse(raw)};
    };

    const guarded = await logged({
      overrides: {policy: o},
      deployedPolicy: policy,
    });
    expect(guarded.r.disposition).toBe('ed_now');
    expect(guarded.line.overridden).toBe(true);
    expect(guarded.line.guard_raised).toBe(true);

    // Overridden, but with no deployed policy the guard cannot raise.
    const unguarded = await logged({overrides: {policy: o}});
    expect(unguarded.r.disposition).toBe('self_care');
    expect(unguarded.line.overridden).toBe(true);
    expect(unguarded.line.guard_raised).toBe(false);

    const plain = await route(M, deps(scripted({})));
    expect(JSON.parse(traceLine(plain))).toEqual(
      expect.objectContaining({overridden: false, guard_raised: false}),
    );
  });

  it('lists present flags whose excerpt did not verify', () => {
    const r = {
      ...validResult,
      red_flags: [
        {
          id: 'a_flag',
          state: 'present' as const,
          excerpt: 'x',
          excerpt_verified: false,
        },
        {
          id: 'b_flag',
          state: 'present' as const,
          excerpt: 'y',
          excerpt_verified: true,
        },
        {
          id: 'c_flag',
          state: 'absent' as const,
          excerpt: null,
          excerpt_verified: false,
        },
      ],
    };
    const line = JSON.parse(traceLine(r));
    expect(line.red_flags_present).toEqual(['a_flag', 'b_flag']);
    expect(line.unverified).toEqual(['a_flag']);
  });

  it('lists modifiers whose excerpt did not verify, by id only', () => {
    const r = {
      ...validResult,
      modifiers: [
        {id: 'age_65_plus', excerpt: 'secret words', excerpt_verified: false},
        {id: 'diabetes', excerpt: 'other words', excerpt_verified: true},
      ],
    };
    const raw = traceLine(r);
    const line = JSON.parse(raw);
    expect(line.unverified).toEqual(['age_65_plus']);
    expect(line.modifiers_present).toEqual(['age_65_plus', 'diabetes']);
    expect(raw).not.toContain('secret words');
  });
});

describe('route with invalid extraction output', () => {
  type Flags = WireExtraction['red_flags'];

  // Runs scripted() with a present chest-pain flag, then edits the flag list.
  function broken(edit: (flags: Flags) => unknown) {
    const llm = scripted({
      flags: {cardiac_chest_pain: 'present'},
      samples: 'routine',
    });
    const inner = llm.complete.bind(llm);
    llm.complete = async req => {
      const res = await inner(req);
      if (req.schemaName !== 'extraction') return res;
      const ex = res.json as WireExtraction;
      const json = {...ex, red_flags: edit(ex.red_flags)};
      return {...res, json, raw: JSON.stringify(json)};
    };
    return llm;
  }

  it.each([
    ['a missing flag', (f: Flags) => f.filter(e => e.id !== 'anaphylaxis')],
    [
      'a repeated flag',
      (f: Flags) => [
        ...f,
        {id: 'cardiac_chest_pain', state: 'absent', excerpt: ''},
      ],
    ],
    [
      'an unknown flag id',
      (f: Flags) => [...f, {id: 'not_a_flag', state: 'present', excerpt: ''}],
    ],
  ])('keeps a present emergency flag despite %s', async (_name, edit) => {
    const onEarly = vi.fn();
    const llm = broken(edit);
    const r = await route(REFILL_WITH_CHEST, deps(llm), {onEarly});
    expect(r.status).toBe('human_review');
    expect(r.human_review.reasons).toEqual(['extraction_failed']);
    expect(r.disposition).toBe('call_911');
    expect(r.floor).toBe('call_911');
    expect(onEarly).toHaveBeenCalledWith(
      expect.objectContaining({floor: 'call_911'}),
    );
    expect(r.red_flags.find(f => f.id === 'cardiac_chest_pain')?.state).toBe(
      'present',
    );
    // No samples are drawn after a failed extraction.
    expect(llm.calls).toBe(1);
  });

  it('gives plain Human review when no flag list can be read', async () => {
    const onEarly = vi.fn();
    const r = await route(REFILL_WITH_CHEST, deps(broken(() => 'not a list')), {
      onEarly,
    });
    expect(r.disposition).toBeNull();
    expect(r.floor).toBeNull();
    expect(onEarly).not.toHaveBeenCalled();
  });
});
