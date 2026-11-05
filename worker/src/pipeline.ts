import {ExtractionInvalidError, extract} from './extract';
import {ruleFloor, verifyExcerpt, type FloorResult} from './floor';
import {
  LEVELS,
  LEVEL_LABELS,
  briefLabelOf,
  levelAtRank,
  rank,
  tierOf,
  type Level,
} from './levels';
import {LlmError, type LlmClient, type ModelSpec} from './llm';
import {traceLine} from './log';
import type {RouteOverrides} from './overrides';
import type {Policy} from './policy';
import {chooseLevel, emptyVotes, reviewReasons, type Votes} from './router';
import {drawSamples, type VoteSet} from './sample';
import {
  RouteResultSchema,
  SampleSchema,
  type Extraction,
  type ReasonCode,
  type RouteResult,
  type Sample,
} from './schema';

export {traceLine};

export type Deps = {
  llm: LlmClient;
  policy: Policy;
  primary: ModelSpec;
  secondary: ModelSpec | null;
  log: (line: string) => void;
};

export type EarlyEvent = {
  event: 'early';
  floor: Level;
  patient_message: string;
};

export type RouteOptions = {
  mode?: 'full' | 'floor_only';
  onEarly?: (e: EarlyEvent) => void;
  /**
   * The request's overrides, recorded in the trace only. The caller applies
   * them by building Deps (policy and models) before calling route().
   */
  overrides?: RouteOverrides;
  /**
   * The deployed policy, when deps.policy carries overrides. An emergency
   * the deployed policy would choose on the same votes is kept (zero-miss).
   */
  deployedPolicy?: Policy;
};

/** Patient copy for Human review when no disposition is carried. */
export const HUMAN_REVIEW_MESSAGE =
  'Thanks for your message. A Counsel physician will review it within 1 ' +
  'hour. If this is an emergency, call 911 now.';

/** Safety-netting when no sample supplied any. */
export const FALLBACK_SAFETY_NET =
  'If your symptoms get worse, or you are worried, call 911 or go to the ' +
  'nearest emergency department.';

/** Reasons that put the case in front of a physician for review. */
const REVIEW_REASONS: ReadonlySet<ReasonCode> = new Set([
  'too_long',
  'non_english',
  'out_of_scope',
  'extraction_failed',
  'sampling_failed',
  'schema_invalid',
  'split_vote',
  'wide_spread',
  'family_disagreement',
  'unverified_excerpt',
  'secondary_unavailable',
]);

const EXPLANATIONS: Record<ReasonCode, string> = {
  too_long: 'The message is longer than the intake limit.',
  non_english: 'The message is not in English.',
  out_of_scope: 'The message is not a request for care.',
  extraction_failed: 'Clinical findings could not be extracted.',
  sampling_failed: 'Too few valid disposition samples were returned.',
  schema_invalid: 'The routing result failed validation.',
  split_vote: 'The samples were split.',
  wide_spread: 'The samples spread widely.',
  family_disagreement: 'The two model families disagree on the tier.',
  unverified_excerpt:
    'A red-flag or modifier excerpt was not found in the message.',
  missing_info: 'More information is needed.',
  photo_needed: 'A photo is needed.',
  secondary_unavailable:
    'The second model family returned too few valid samples to cross-check.',
};

/** State shared by every exit from route(). */
type Run = {
  message: string;
  deps: Deps;
  start: number;
  hash: Promise<string>;
  models: ModelSpec[];
  extractionModel: ModelSpec | null;
  overrides: RouteOverrides | null;
  raw: {
    extraction: string | null;
    primary: string[];
    secondary: string[] | null;
  };
  extraction: Extraction | null;
  floor: FloorResult | null;
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function isEmergency(l: Level): boolean {
  return rank(l) >= rank('ed_now');
}

/** Instructions of present flags, in policy order. */
function instructions(run: Run): string[] {
  const ex = run.extraction;
  if (!ex) return [];
  return run.deps.policy.red_flags
    .filter(f => ex.red_flags[f.id]?.state === 'present' && f.instruction)
    .map(f => f.instruction as string);
}

function levelMessage(run: Run, level: Level, safetyNet = ''): string {
  return [
    run.deps.policy.levels[level].patient_message,
    ...instructions(run),
    safetyNet,
  ]
    .filter(s => s !== '')
    .join(' ');
}

function floorJustification(run: Run): string {
  const drivers = run.floor?.drivers ?? [];
  return `Rule floor: ${drivers.length ? drivers.join(', ') : 'none'}.`;
}

/**
 * Present modifiers with their excerpt checked against the message. The
 * one place modifier excerpts are verified: the result and the review
 * flag both read excerpt_verified from here.
 */
function modifierResults(run: Run): RouteResult['modifiers'] {
  const ex = run.extraction;
  return run.deps.policy.modifiers
    .filter(m => ex?.modifiers[m.id]?.present === true)
    .map(m => {
      const excerpt = ex?.modifiers[m.id]?.excerpt ?? null;
      return {
        id: m.id,
        excerpt,
        excerpt_verified:
          excerpt !== null && verifyExcerpt(run.message, excerpt),
      };
    });
}

/** The fields every result shares, derived from the run so far. */
function common(run: Run) {
  const ex = run.extraction;
  const message = run.message;
  return {
    floor: run.floor?.floor ?? null,
    red_flags: run.deps.policy.red_flags.map(f => {
      const got = ex?.red_flags[f.id];
      const state = got?.state ?? 'unknown';
      const excerpt = got?.excerpt ?? null;
      return {
        id: f.id,
        state,
        excerpt,
        excerpt_verified:
          state === 'present' &&
          excerpt !== null &&
          verifyExcerpt(message, excerpt),
      };
    }),
    modifiers: modifierResults(run),
    info_requests: {
      questions: ex?.questions ?? [],
      photo: ex?.photo_needed ?? false,
    },
    time_sensitive: ex?.time_sensitive ?? false,
  };
}

type Outcome = {
  status: RouteResult['status'];
  disposition: Level | null;
  votes: RouteResult['votes'];
  confidence: number | null;
  reasons: ReasonCode[];
  justification: string;
  safety_net: string;
  patient_message: string;
};

async function assemble(run: Run, o: Outcome): Promise<RouteResult> {
  return {
    status: o.status,
    disposition: o.disposition,
    tier: o.disposition ? tierOf(o.disposition) : null,
    brief_label: o.disposition ? briefLabelOf(o.disposition) : null,
    ...common(run),
    votes: o.votes,
    confidence: o.confidence,
    human_review: {
      flagged:
        o.status === 'human_review' ||
        o.reasons.some(r => REVIEW_REASONS.has(r)),
      reasons: o.reasons,
    },
    justification: o.justification,
    safety_net: o.safety_net,
    patient_message: o.patient_message,
    trace: {
      input_sha256: await run.hash,
      policy_version: run.deps.policy.policy_version,
      models: run.models,
      extraction_model: run.extractionModel,
      overrides: run.overrides,
      latency_ms: Date.now() - run.start,
      raw: run.raw,
    },
  };
}

/**
 * Human review. Carries the floor as the disposition only when it is
 * Emergency; otherwise no disposition and the fixed holding message.
 */
function humanReview(
  run: Run,
  reason: ReasonCode,
  votes: RouteResult['votes'] = {primary: emptyVotes(), secondary: null},
): Promise<RouteResult> {
  const floor = run.floor?.floor ?? null;
  const carried = floor !== null && isEmergency(floor) ? floor : null;
  return assemble(run, {
    status: 'human_review',
    disposition: carried,
    votes,
    confidence: null,
    reasons: [reason],
    justification: carried
      ? `${EXPLANATIONS[reason]} ${floorJustification(run)} Emergency floor kept.`
      : EXPLANATIONS[reason],
    safety_net: '',
    patient_message: carried
      ? levelMessage(run, carried)
      : HUMAN_REVIEW_MESSAGE,
  });
}

/**
 * The valid samples as the model proposed them, before the floor clamp, in
 * call order. drawSamples keeps each clamped sample's original text, so the
 * justification must come from a sample that argued for the chosen level.
 */
function proposals(set: VoteSet): Sample[] {
  const out: Sample[] = [];
  for (const raw of set.raw) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const s = SampleSchema.safeParse(json);
    if (s.success) out.push(s.data);
  }
  return out;
}

function countByLevel(samples: Sample[]): Votes {
  const n = emptyVotes();
  for (const s of samples) n[s.disposition]++;
  return n;
}

function joinAnd(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * A deterministic justification for when no sample proposed the chosen level.
 * The floor texts are used only when they are true: the router stayed at the
 * floor and the samples mostly proposed a lower level. Every other case,
 * including a choice above the floor, is explained by expected cost.
 * Exported for tests.
 */
export function fallbackJustification(
  chosen: Level,
  floor: FloorResult,
  samples: Sample[],
): string {
  const label = (l: Level) => LEVEL_LABELS[l];
  const ending = (because: string) =>
    chosen === 'call_911'
      ? 'This is the most urgent level.'
      : `Not ${label(levelAtRank(rank(chosen) + 1))} because ${because}.`;
  const n = countByLevel(samples);
  // Most-voted proposal; LEVELS is most acute first, so ties go acute.
  const top = LEVELS.reduce((a, b) => (n[b] > n[a] ? b : a));
  const floorHeld = chosen === floor.floor && rank(top) < rank(floor.floor);
  if (floorHeld && floor.drivers.length > 0) {
    return (
      `Red flag(s) ${floor.drivers.join(', ')} set a minimum of ` +
      `${label(floor.floor)}. The samples proposed ${label(top)} below ` +
      `that, so the floor applies. ${ending('no red flag or sample supports it')}`
    );
  }
  if (floorHeld && floor.modifier_applied !== null) {
    return (
      `Risk factor ${floor.modifier_applied} raises the minimum to ` +
      `${label(floor.floor)}. The samples proposed ${label(top)} below ` +
      `that, so the minimum applies. ${ending('no red flag or sample supports it')}`
    );
  }
  const proposed = LEVELS.filter(l => n[l] > 0).map(
    l => `${label(l)} (${n[l]})`,
  );
  const how =
    proposed.length === 1
      ? `all proposed ${proposed[0]}`
      : `split between ${joinAnd(proposed)}`;
  return (
    `Routed by expected cost: the samples ${how}, ` +
    'and under-triage costs more than over-triage at this boundary. ' +
    ending('too few samples supported it')
  );
}

/**
 * The safety-netting of the most acute proposal whose safety_net is not
 * blank after trimming (ties go to the first in call order), else the fixed
 * fallback line.
 */
function fallbackSafetyNet(samples: Sample[]): string {
  let best: Sample | null = null;
  for (const s of samples) {
    if (s.safety_net.trim() === '') continue;
    if (best === null || rank(s.disposition) > rank(best.disposition)) best = s;
  }
  return best?.safety_net ?? FALLBACK_SAFETY_NET;
}

function addSpec(run: Run, spec: ModelSpec): void {
  if (
    !run.models.some(
      m => m.model === spec.model && m.provider === spec.provider,
    )
  ) {
    run.models.push(spec);
  }
}

/**
 * Sets the rule floor from run.extraction and, for an emergency floor, sends
 * the early event without waiting for sampling.
 */
function setFloor(run: Run, opts: RouteOptions): FloorResult {
  const floor = ruleFloor(run.extraction!, run.message, run.deps.policy);
  run.floor = floor;
  if (isEmergency(floor.floor) && opts.onEarly) {
    try {
      opts.onEarly({
        event: 'early',
        floor: floor.floor,
        patient_message: levelMessage(run, floor.floor),
      });
    } catch {
      // A failed listener must not stop routing.
    }
  }
  return floor;
}

/**
 * A log line for a failed extraction call: the model, error code and HTTP
 * status only.
 */
function extractionErrorLine(spec: ModelSpec, e: unknown): string {
  return JSON.stringify({
    kind: 'llm_error',
    step: 'extraction',
    model: spec.model,
    code: e instanceof LlmError ? e.code : 'unknown',
    status: e instanceof LlmError ? e.status : undefined,
  });
}

/** Salvaged flags from two attempts: each flag keeps its most severe state. */
function mergeFlags(
  a: Extraction['red_flags'] | null,
  b: Extraction['red_flags'],
): Extraction['red_flags'] {
  if (!a) return b;
  const severity = {unknown: 0, absent: 1, present: 2};
  return Object.fromEntries(
    Object.entries(b).map(([id, f]) => [
      id,
      severity[a[id].state] >= severity[f.state] ? a[id] : f,
    ]),
  );
}

/** An extraction holding only salvaged red flags: no modifiers or questions. */
function salvagedExtraction(
  flags: Extraction['red_flags'],
  policy: Policy,
): Extraction {
  return {
    language: 'en',
    is_care_request: true,
    red_flags: flags,
    modifiers: Object.fromEntries(
      policy.modifiers.map(m => [m.id, {present: false, excerpt: null}]),
    ),
    questions: [],
    photo_needed: false,
    time_sensitive: false,
  };
}

async function pipeline(run: Run, opts: RouteOptions): Promise<RouteResult> {
  const {deps, message} = run;
  const {policy} = deps;

  // 1. Intake.
  if (message.length > policy.intake.max_chars) {
    return humanReview(run, 'too_long');
  }

  // 2. Extraction (an LlmError is the only failure extract() reports). When
  // the primary marks no flag present, the secondary tries once.
  let ex: Extraction | null = null;
  let salvaged: Extraction['red_flags'] | null = null;
  for (const spec of [deps.primary, deps.secondary]) {
    if (!spec) continue;
    addSpec(run, spec);
    try {
      const got = await extract(message, spec, deps.llm, policy);
      ex = got.extraction;
      run.raw.extraction = got.raw;
      run.extractionModel = spec;
      break;
    } catch (e) {
      try {
        deps.log(extractionErrorLine(spec, e));
      } catch {
        // Logging must not change the patient's outcome.
      }
      if (e instanceof ExtractionInvalidError && e.flags) {
        run.raw.extraction = e.raw;
        run.extractionModel = spec;
        salvaged = mergeFlags(salvaged, e.flags);
        if (Object.values(salvaged).some(f => f.state === 'present')) break;
      }
    }
  }
  if (!ex) {
    // Output that missed or repeated a flag still floors the flags it did
    // mark present; the case goes to a physician either way.
    if (salvaged) {
      run.extraction = salvagedExtraction(salvaged, policy);
      setFloor(run, opts);
    }
    return humanReview(run, 'extraction_failed');
  }
  run.extraction = ex;

  // 3. Rule floor, and emergency instructions without waiting for sampling.
  const floor = setFloor(run, opts);

  // 4. Scope.
  if (ex.language !== 'en') return humanReview(run, 'non_english');
  if (!ex.is_care_request) return humanReview(run, 'out_of_scope');

  const reasons: ReasonCode[] = [];
  // A present modifier whose excerpt is not in the message still counts
  // toward the floor (ruleFloor), but a physician checks it, as for flags.
  const unverifiedModifier = modifierResults(run).some(
    m => !m.excerpt_verified,
  );
  if (floor.unverified.length > 0 || unverifiedModifier) {
    reasons.push('unverified_excerpt');
  }

  // 5. Floor only.
  if (opts.mode === 'floor_only') {
    return assemble(run, {
      status: 'routed',
      disposition: floor.floor,
      votes: {primary: emptyVotes(), secondary: null},
      confidence: null,
      reasons,
      justification: floorJustification(run),
      safety_net: '',
      patient_message: levelMessage(run, floor.floor),
    });
  }

  // 6. Sampling, both families in parallel. drawSamples never throws.
  const draw = (spec: ModelSpec) =>
    drawSamples(message, ex, floor.floor, spec, deps.llm, policy);
  const [primary, secondary] = await Promise.all([
    draw(deps.primary),
    deps.secondary ? draw(deps.secondary) : Promise.resolve(null),
  ]);
  if (deps.secondary) addSpec(run, deps.secondary);
  run.raw.primary = primary.raw;
  run.raw.secondary = secondary?.raw ?? null;
  const votes = {primary: primary.votes, secondary: secondary?.votes ?? null};
  if (primary.valid < policy.sampling.min_valid) {
    return humanReview(run, 'sampling_failed', votes);
  }

  // 7. Choose and flag.
  let disposition = chooseLevel(primary.votes, floor.floor, policy);
  if (opts.deployedPolicy) {
    // Overridden weights may not route below an emergency the deployed
    // policy would choose (AGENTS.md rule 1).
    const deployed = chooseLevel(
      primary.votes,
      floor.floor,
      opts.deployedPolicy,
    );
    if (isEmergency(deployed) && rank(disposition) < rank(deployed)) {
      disposition = deployed;
    }
  }
  // A configured secondary with too few valid samples cannot cross-check
  // the primary. The primary's disposition stands, but a physician looks:
  // a failed cross-check must not pass silently as an agreeing one.
  const secondaryFailed =
    secondary !== null && secondary.valid < policy.sampling.min_valid;
  const secondaryVotes: Votes | null =
    secondary && !secondaryFailed ? secondary.votes : null;
  const crossCheck: ReasonCode[] = secondaryFailed
    ? ['secondary_unavailable']
    : [];
  reasons.unshift(
    ...reviewReasons(primary.votes, secondaryVotes, policy),
    ...crossCheck,
  );
  const needsInfo = ex.questions.length > 0 || ex.photo_needed;
  if (ex.questions.length > 0) reasons.push('missing_info');
  if (ex.photo_needed) reasons.push('photo_needed');
  const top = Math.max(...LEVELS.map(l => primary.votes[l]));

  // 8. Explain.
  const proposed = proposals(primary);
  const chosen = proposed.find(s => s.disposition === disposition);
  // A blank net from the chosen-level proposer must not leave the patient
  // without escalation instructions.
  const safetyNet =
    chosen && chosen.safety_net.trim() !== ''
      ? chosen.safety_net
      : fallbackSafetyNet(proposed);
  return assemble(run, {
    status: needsInfo ? 'needs_info' : 'routed',
    disposition,
    votes,
    confidence: top / primary.valid,
    reasons,
    justification: chosen
      ? chosen.justification
      : fallbackJustification(disposition, floor, proposed),
    safety_net: safetyNet,
    patient_message: levelMessage(run, disposition, safetyNet),
  });
}

/**
 * Routes one patient message through the 8-step pipeline (PRD p. 5). Never
 * throws: every failure ends at Human review, carrying an Emergency floor.
 * Logs one trace line per call, without the message text.
 */
export async function route(
  message: string,
  deps: Deps,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const run: Run = {
    message,
    deps,
    start: Date.now(),
    // Started now, awaited only when the result is assembled, so hashing
    // never delays the early event.
    hash: sha256Hex(message).catch(() => ''),
    models: [],
    extractionModel: null,
    overrides: opts.overrides ?? null,
    raw: {extraction: null, primary: [], secondary: null},
    extraction: null,
    floor: null,
  };

  let result: RouteResult;
  try {
    const candidate = await pipeline(run, opts);
    const parsed = RouteResultSchema.safeParse(candidate);
    result = parsed.success
      ? parsed.data
      : await humanReview(run, 'schema_invalid');
  } catch {
    result = await humanReview(run, 'schema_invalid').catch(() =>
      lastResort(run),
    );
  }

  try {
    deps.log(traceLine(result));
  } catch {
    // Logging must not change the patient's outcome.
  }
  return result;
}

/** Hand-built Human review for when even assembling a result failed. */
function lastResort(run: Run): RouteResult {
  const floor = run.floor?.floor ?? null;
  const carried = floor !== null && isEmergency(floor) ? floor : null;
  let patientMessage = HUMAN_REVIEW_MESSAGE;
  try {
    if (carried) patientMessage = levelMessage(run, carried);
  } catch {
    // Keep the holding message.
  }
  return {
    status: 'human_review',
    disposition: carried,
    tier: carried ? tierOf(carried) : null,
    brief_label: carried ? briefLabelOf(carried) : null,
    floor,
    red_flags: [],
    modifiers: [],
    votes: {primary: emptyVotes(), secondary: null},
    confidence: null,
    human_review: {flagged: true, reasons: ['schema_invalid']},
    info_requests: {questions: [], photo: false},
    time_sensitive: false,
    justification: EXPLANATIONS.schema_invalid,
    safety_net: '',
    patient_message: patientMessage,
    trace: {
      input_sha256: '',
      policy_version: run.deps.policy?.policy_version ?? '',
      models: run.models,
      extraction_model: run.extractionModel,
      overrides: run.overrides,
      latency_ms: Date.now() - run.start,
      raw: null,
    },
  };
}
