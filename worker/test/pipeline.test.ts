import {describe, expect, it, vi} from 'vitest';
import type {Level} from '../src/levels';
import {
  FALLBACK_SAFETY_NET,
  route,
  traceLine,
  type EarlyEvent,
} from '../src/pipeline';
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
      expect(JSON.parse(lines[0]).trace.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('logs a present excerpt but not the full message', async () => {
    const excerpt = 'itchy rash on my forearm';
    expect(SECRET_MSG).toContain(excerpt);
    const lines: string[] = [];
    const llm = scripted({flags: {diabetic_foot_redness: 'present'}, excerpt});
    await route(SECRET_MSG, {...deps(llm), log: l => lines.push(l)});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(excerpt);
    expect(lines[0]).not.toContain(SECRET_MSG);
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
      const ex = res.json as {red_flags: Record<string, {excerpt: string}>};
      ex.red_flags.fever_neck_stiffness.excerpt = 'a paraphrase not in it';
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
    expect(lines).toHaveLength(1);
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

  it('treats a failed secondary as absent but records its votes', async () => {
    const d = {
      ...deps(scripted({samples: 'routine', secondary: 'fail'})),
      secondary: SECONDARY,
    };
    const r = await route(M, d);
    expect(r.status).toBe('routed');
    expect(r.human_review.reasons).toEqual([]);
    expect(r.votes.secondary).toEqual(
      expect.objectContaining({routine: 0, ed_now: 0}),
    );
    expect((r.trace.raw as {secondary: string[]}).secondary).toEqual([]);
  });
});

describe('traceLine', () => {
  it('is a route log line without the message', async () => {
    const r = await route(SECRET_MSG, deps(scripted({})));
    const line = JSON.parse(traceLine(r));
    expect(line.kind).toBe('route');
    expect(Date.parse(line.ts)).not.toBeNaN();
    expect(line.trace.input_sha256).toBe(r.trace.input_sha256);
    expect(traceLine(r)).not.toContain(SECRET_MSG);
  });
});
