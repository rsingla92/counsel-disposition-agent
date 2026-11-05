// Pure helpers for the demo page. No DOM access here, so node --test can
// cover them (web/test/lib.test.mjs).

/** The seven dispositions, most acute first (worker/src/levels.ts). */
export const LEVELS = [
  'call_911',
  'ed_now',
  'in_person_today',
  'physician_contact_today',
  'within_few_days',
  'routine',
  'self_care',
];

const LEVEL_LABELS = {
  call_911: 'Call 911',
  ed_now: 'ED now',
  in_person_today: 'In person today',
  physician_contact_today: 'Physician contact today',
  within_few_days: 'Within a few days',
  routine: 'Routine',
  self_care: 'Self-care',
};

const TIERS = {
  call_911: 'emergency',
  ed_now: 'emergency',
  in_person_today: 'same_day',
  physician_contact_today: 'same_day',
  within_few_days: 'async',
  routine: 'async',
  self_care: 'self_care',
};

export const TIER_LABELS = {
  emergency: 'Emergency',
  same_day: 'Same day',
  async: 'Async',
  self_care: 'Self-care',
};

export const STATUS_LABELS = {
  routed: 'Routed',
  needs_info: 'Needs info',
  human_review: 'Human review',
};

/** Physician response windows (policy/policy.yaml, physician_window). */
export const LEVEL_WINDOWS = {
  call_911: 'Notified in parallel',
  ed_now: 'Notified in parallel',
  in_person_today: 'Within 1 hour',
  physician_contact_today: 'Within 2-4 hours',
  within_few_days: 'Within 24 hours',
  routine: 'Standard queue',
  self_care: 'Standard queue, for sign-off',
};

/** Human labels for every ReasonCode (worker/src/schema.ts). */
export const REASON_LABELS = {
  too_long: 'Message too long',
  non_english: 'Not in English',
  out_of_scope: 'Not a care request',
  extraction_failed: 'Extraction failed',
  sampling_failed: 'Too few valid samples',
  schema_invalid: 'Result failed validation',
  split_vote: 'Split vote',
  wide_spread: 'Wide vote spread',
  family_disagreement: 'Model families disagree',
  unverified_excerpt: 'Excerpt not verified',
  secondary_unavailable: 'Second model unavailable',
  missing_info: 'Missing information',
  photo_needed: 'Photo needed',
};

/** Human labels for OverrideReasonCodeSchema. Fixed codes, never free text. */
export const OVERRIDE_REASON_LABELS = {
  under_triage: 'Under-triaged: level too low',
  over_triage: 'Over-triaged: level too high',
  missed_red_flag: 'Missed a red flag',
  false_red_flag: 'Red flag not actually present',
  history_changes_risk: 'History changes the risk',
  needs_info_resolved: 'Missing information resolved',
  other: 'Other',
};

export const TOKEN_KEY = 'counsel-demo-token';

export function levelLabel(level) {
  if (level === null || level === undefined) return 'No disposition';
  return LEVEL_LABELS[level] ?? String(level);
}

export function tierOf(level) {
  return TIERS[level] ?? null;
}

export function isEmergency(level) {
  return tierOf(level) === 'emergency';
}

// --- highlighting ----------------------------------------------------------

const SINGLE_QUOTES = /[‘’‚‛′]/;
const DOUBLE_QUOTES = /[“”„‟″]/;

/**
 * Normalises like the Worker's verifyExcerpt (lowercase, straight quotes,
 * whitespace runs collapsed) and remembers, for each output character, the
 * span of the input it came from.
 */
function normaliseWithMap(s) {
  let out = '';
  const from = [];
  const to = [];
  let i = 0;
  for (const ch of s) {
    const start = i;
    i += ch.length;
    if (/\s/.test(ch)) {
      if (out.endsWith(' ')) {
        to[to.length - 1] = i;
      } else {
        out += ' ';
        from.push(start);
        to.push(i);
      }
      continue;
    }
    let mapped = ch.toLowerCase();
    if (SINGLE_QUOTES.test(ch)) mapped = "'";
    else if (DOUBLE_QUOTES.test(ch)) mapped = '"';
    for (const c of mapped) {
      out += c;
      from.push(start);
      to.push(i);
    }
  }
  return {out, from, to};
}

/**
 * Splits `message` into parts, marking every place an excerpt occurs.
 * Matching ignores case and whitespace differences, as verifyExcerpt does.
 * Joining the parts' text gives back the message unchanged.
 */
export function highlight(message, excerpts) {
  const hay = normaliseWithMap(message);
  const ranges = [];
  for (const excerpt of excerpts ?? []) {
    if (typeof excerpt !== 'string') continue;
    const needle = normaliseWithMap(excerpt).out.trim();
    if (needle === '') continue;
    let at = hay.out.indexOf(needle);
    while (at !== -1) {
      ranges.push([hay.from[at], hay.to[at + needle.length - 1]]);
      at = hay.out.indexOf(needle, at + needle.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const parts = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) parts.push({text: message.slice(pos, start), mark: false});
    parts.push({text: message.slice(start, end), mark: true});
    pos = end;
  }
  if (pos < message.length || parts.length === 0) {
    parts.push({text: message.slice(pos), mark: false});
  }
  return parts;
}

/**
 * The excerpts to highlight in the message: present red flags and
 * modifiers whose excerpt the Worker verified. An unverified excerpt, or a
 * modifier from an older result without the field, is never highlighted.
 */
export function highlightExcerpts(result) {
  const flags = (result?.red_flags ?? []).filter(
    f => f.state === 'present' && f.excerpt_verified === true && f.excerpt,
  );
  const mods = (result?.modifiers ?? []).filter(
    m => m.excerpt_verified === true && m.excerpt,
  );
  return [...flags, ...mods].map(x => x.excerpt);
}

// --- NDJSON ----------------------------------------------------------------

/** Parses newline-delimited JSON. Throws on a malformed line. */
export function parseNdjson(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
}

/**
 * For a streaming read: parses the complete lines in `buffer` and returns the
 * trailing partial line as `rest`, to be prefixed to the next chunk.
 */
export function takeLines(buffer) {
  const cut = buffer.lastIndexOf('\n');
  if (cut === -1) return {events: [], rest: buffer};
  return {
    events: parseNdjson(buffer.slice(0, cut)),
    rest: buffer.slice(cut + 1),
  };
}

// --- numbers ---------------------------------------------------------------

export function formatPercent(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '—';
  return `${Math.round(x * 100)}%`;
}

/**
 * Data for the combined vote chart: one row per level, most acute first.
 * Counts are clamped to non-negative integers. Each family's lead is its
 * modal level (ties go to the more acute one); a family with no votes has
 * none. `max` is shared so equal counts draw equal bars. `empty` is true
 * when there are no votes at all.
 */
export function voteRows(votes, disposition) {
  const families = ['primary'];
  if (votes?.secondary) families.push('secondary');
  const counts = {};
  const totals = {};
  const tops = {};
  for (const fam of families) {
    counts[fam] = LEVELS.map(l => {
      const n = votes?.[fam]?.[l];
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    });
    totals[fam] = counts[fam].reduce((a, b) => a + b, 0);
    tops[fam] = Math.max(...counts[fam]);
  }
  const max = Math.max(...families.map(f => tops[f]));
  const rows = LEVELS.map((level, i) => {
    const row = {level, label: levelLabel(level), chosen: level === disposition};
    for (const fam of families) {
      const count = counts[fam][i];
      const lead = count > 0 && counts[fam].indexOf(tops[fam]) === i;
      row[fam] = {
        count,
        pct: totals[fam] > 0 ? Math.round((count / totals[fam]) * 100) : 0,
        lead,
      };
    }
    return row;
  });
  return {
    series: families,
    max,
    totals,
    rows,
    empty: families.every(f => totals[f] === 0),
  };
}

// --- what leads ------------------------------------------------------------

/** Acuity rank: self_care is 0, call_911 is 6; -1 for no level. */
function rank(level) {
  const i = LEVELS.indexOf(level);
  return i === -1 ? -1 : LEVELS.length - 1 - i;
}

/**
 * Orders Emergency instructions, given as {level, text, live}: most acute
 * first, a live instruction first at the same level, duplicates dropped.
 */
function orderLeads(candidates) {
  const sorted = candidates
    .filter(c => isEmergency(c.level) && c.text)
    .sort((a, b) => rank(b.level) - rank(a.level) || Number(b.live) - Number(a.live));
  const seen = new Set();
  return sorted.filter(c => {
    const key = c.text.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every Emergency instruction that must lead both views, most acute first:
 * the result's own message when its disposition is Emergency (whatever its
 * status) and the live early event's. Neither ever displaces the other.
 */
export function emergencyLeads(result, early) {
  return orderLeads([
    {level: result?.disposition, text: result?.patient_message, live: false},
    {level: early?.floor, text: early?.patient_message, live: true},
  ]).map(c => c.text);
}

/** The first Emergency instruction, or null. */
export function emergencyLead(result, early) {
  return emergencyLeads(result, early)[0] ?? null;
}

const FAILED_MESSAGE =
  'We could not finish checking your message. A Counsel physician will ' +
  'review it. If this is an emergency, call 911 now.';

/**
 * The run to show when a live call failed with no saved run to fall back
 * on. Keeps any early Emergency event so its instruction still leads.
 */
export function failedRun(message, early) {
  return {message, early: early ?? null, result: null, replay: false, failed: true};
}

/** The run to show for a saved replay file. */
export function replayRun(saved) {
  return {
    message: saved.message,
    early: saved.early ?? null,
    result: saved.result,
    replay: true,
    synthetic: saved.synthetic_fixture === true,
    recordedAt: saved.recorded_at ?? null,
  };
}

/**
 * What to show after a live call failed. Once a live early event arrived,
 * the call never falls back to a saved run: a recording could be less
 * acute than the live floor, or carry a different Emergency instruction.
 * The failed run keeps the live instruction leading. Only a call that
 * produced no early event falls back to its saved run, if there is one.
 */
export function fallbackFor(message, liveEarly, saved) {
  if (liveEarly) return failedRun(message, liveEarly);
  if (saved) return replayRun(saved);
  return failedRun(message, null);
}

/**
 * The pinned live Emergency instruction ({target, early}) if it belongs to
 * `target` (same demo id and same message text), else null. Editing the
 * message or choosing another demo therefore clears the pin.
 */
export function pinFor(pinned, target) {
  if (!pinned || !target) return null;
  return pinned.target.demoId === target.demoId &&
    pinned.target.message === target.message
    ? pinned
    : null;
}

/**
 * The pin after a live early event `early` for `target`. For the same
 * target the more acute early event is kept (a later, less acute event never
 * lowers the floor; at the same level the newer one wins). Another target
 * replaces the pin.
 */
export function nextPin(pinned, target, early) {
  const pin = pinFor(pinned, target);
  if (pin && rank(pin.early.floor) > rank(early.floor)) return pin;
  return {target, early};
}

/**
 * Applies a pinned live Emergency instruction to a run about to be shown
 * for `target`. Returns {run, hidden, replaced}. For the pinned target, a
 * run whose disposition is less acute than the pinned floor (or that has
 * none) is replaced by the failed run led by the live instruction: replaced
 * is then true, and hidden is true when that hid a saved replay. A run at or above the floor is shown with
 * the live instruction kept among its leads. Other targets are unchanged.
 */
export function applyPinned(pinned, target, run) {
  const pin = pinFor(pinned, target);
  if (!pin) return {run, hidden: false, replaced: false};
  const disposition = run?.result?.disposition ?? null;
  if (disposition !== null && rank(disposition) >= rank(pin.early.floor)) {
    return {run: {...run, early: pin.early}, hidden: false, replaced: false};
  }
  return {
    run: failedRun(target.message, pin.early),
    hidden: run?.replay === true,
    replaced: true,
  };
}

/**
 * The demo whose saved run belongs to `routed` ({demoId, message}, captured
 * when the call started), or null. Id and text must both match, so an
 * edited message, or a demo picked after the call began, never borrows
 * another message's run.
 */
export function replayTarget(demos, routed) {
  const demo = (demos ?? []).find(d => d.id === routed?.demoId);
  return demo && demo.message === routed.message ? demo : null;
}

/**
 * True when an override can be sent: a different level and a known reason.
 * `from` is null for a case with no disposition (Human review); any level
 * can then be assigned.
 */
export function canOverride({from, to, reason, blocked}) {
  return (
    !blocked &&
    (from === null || LEVELS.includes(from)) &&
    LEVELS.includes(to) &&
    to !== from &&
    Object.hasOwn(OVERRIDE_REASON_LABELS, reason)
  );
}

/** Splits a trailing safety net off the patient message, if it is there. */
function splitSafetyNet(message, safetyNet) {
  const net = (safetyNet ?? '').trim();
  const text = (message ?? '').trim();
  if (net === '') return {body: text, net: ''};
  if (text.endsWith(net)) {
    return {body: text.slice(0, text.length - net.length).trim(), net};
  }
  return {body: text, net};
}

/**
 * The patient view, as ordered blocks of {kind, text}. kind is one of
 * emergency, draft, message, safety_net, pending. An Emergency instruction
 * always comes first; Self-care is a draft until a physician signs it off.
 */
export function patientBlocks(result, early, failed = false) {
  const blocks = [];
  if (!result) {
    for (const text of emergencyLeads(null, early)) {
      blocks.push({kind: 'emergency', text});
    }
    blocks.push(
      failed
        ? {kind: 'failed', text: FAILED_MESSAGE}
        : {kind: 'pending', text: 'Checking the rest of your message.'},
    );
    return blocks;
  }
  const {body, net} = splitSafetyNet(result.patient_message, result.safety_net);
  const leads = orderLeads([
    {level: result.disposition, text: body, live: false},
    {level: early?.floor, text: early?.patient_message, live: true},
  ]);
  for (const c of leads) blocks.push({kind: 'emergency', text: c.text});
  if (!isEmergency(result.disposition)) {
    if (result.disposition === 'self_care') {
      blocks.push({kind: 'draft', text: 'Draft — awaiting physician sign-off'});
    }
    if (body !== '') blocks.push({kind: 'message', text: body});
  }
  if (net !== '') blocks.push({kind: 'safety_net', text: net});
  return blocks;
}

// --- token -----------------------------------------------------------------

/** Reads the access token; '' when storage is missing or throws. */
export function readToken(storage) {
  try {
    return storage?.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Stores the token, or removes it when empty. Never throws. */
export function writeToken(storage, token) {
  try {
    if (token) storage?.setItem(TOKEN_KEY, token);
    else storage?.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage: the token lasts for this page only.
  }
}

// --- operations view: overrides ----------------------------------------------

/** Samples drawn per model (policy sampling.n); fixed, read-only here. */
export const SAMPLES = 20;

/**
 * Allowed ranges for router overrides. A copy of the plan's "Override
 * ranges" table: worker/src/overrides.ts (PolicyOverridesSchema) is the
 * authority, and the Worker rejects anything outside it. min_top_votes is
 * further bounded below by minTopVotes(min_valid).
 */
export const OVERRIDE_RANGES = {
  min_valid: {min: 10, max: 20, step: 1},
  min_top_votes: {min: 6, max: 20, step: 1},
  max_span: {min: 0, max: 6, step: 1},
  human_review_cost: {min: 0.05, max: 2, step: 0.05},
  under_weight: {min: 0.5, max: 50, step: 0.5},
};

/** The model choices the Worker accepts (worker/src/overrides.ts). */
export const MODEL_CHOICES = ['sonnet', 'flash', 'sonnet+flash'];

/** Short labels, for the banner. */
export const MODEL_LABELS = {
  sonnet: 'Sonnet only',
  flash: 'Flash only',
  'sonnet+flash': 'Sonnet + Flash',
};

/**
 * Under-triage weights a live route may raise but never lower: the
 * boundaries call_911/ed_now and ed_now/in_person_today, in policy order
 * (checkLiveSafe in worker/src/overrides.ts).
 */
export const EMERGENCY_WEIGHTS = [0, 1];

const POLICY_FIELDS = ['min_valid', 'min_top_votes', 'max_span', 'human_review_cost'];
const WEIGHT_COUNT = 6;

/** The lowest min_top_votes allowed: a simple majority of min_valid. */
export function minTopVotes(minValid) {
  return Math.floor(minValid / 2) + 1;
}

/**
 * The deployed policy's tunable values from a GET /v1/policy response,
 * flattened: {min_valid, min_top_votes, max_span, human_review_cost,
 * under_weights}. Null when the response lacks them.
 */
export function policyDefaults(api) {
  const weights = api?.loss?.boundaries?.map(b => b?.under);
  const out = {
    min_valid: api?.sampling?.min_valid,
    min_top_votes: api?.review?.min_top_votes,
    max_span: api?.review?.max_span,
    human_review_cost: api?.loss?.human_review_cost,
    under_weights: weights,
  };
  const ok =
    POLICY_FIELDS.every(f => Number.isFinite(out[f])) &&
    Array.isArray(weights) &&
    weights.length === WEIGHT_COUNT &&
    weights.every(Number.isFinite);
  return ok ? out : null;
}

function onStep(x, {min, max, step}) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    return false;
  }
  const k = x / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

/**
 * Slider and picker state for `overrides` (null for none): every field
 * filled from the policy where the overrides leave it out. `models` is
 * 'policy' for the deployed default.
 */
export function controlsFromOverrides(overrides, policy) {
  const p = overrides?.policy ?? {};
  return {
    models: overrides?.models ?? 'policy',
    min_valid: p.min_valid ?? policy.min_valid,
    min_top_votes: p.min_top_votes ?? policy.min_top_votes,
    max_span: p.max_span ?? policy.max_span,
    human_review_cost: p.human_review_cost ?? policy.human_review_cost,
    under_weights: [...(p.under_weights ?? policy.under_weights)],
  };
}

/**
 * The overrides for `controls`: only the fields that differ from the
 * policy, with all six weights when any one differs. Null when nothing
 * differs.
 */
export function overridesFromControls(controls, policy) {
  const out = {};
  if (MODEL_CHOICES.includes(controls.models)) out.models = controls.models;
  const p = {};
  for (const f of POLICY_FIELDS) {
    if (controls[f] !== policy[f]) p[f] = controls[f];
  }
  if (controls.under_weights.some((w, i) => w !== policy.under_weights[i])) {
    p.under_weights = [...controls.under_weights];
  }
  if (Object.keys(p).length) out.policy = p;
  return Object.keys(out).length ? out : null;
}

/**
 * `stored` if it is a well-formed overrides object inside the ranges
 * table, else null. Overrides saved under an older policy that no longer
 * validate are dropped here, so a live route never 400s on them forever.
 */
export function validStoredOverrides(stored, policy) {
  if (!policy || !stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const keys = Object.keys(stored);
  if (keys.length === 0 || keys.some(k => k !== 'models' && k !== 'policy')) {
    return null;
  }
  if ('models' in stored && !MODEL_CHOICES.includes(stored.models)) return null;
  if ('policy' in stored) {
    const p = stored.policy;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const pk = Object.keys(p);
    if (pk.length === 0) return null;
    for (const k of pk) {
      if (k === 'under_weights') {
        const w = p.under_weights;
        if (
          !Array.isArray(w) ||
          w.length !== WEIGHT_COUNT ||
          !w.every(x => onStep(x, OVERRIDE_RANGES.under_weight))
        ) {
          return null;
        }
      } else if (!POLICY_FIELDS.includes(k) || !onStep(p[k], OVERRIDE_RANGES[k])) {
        return null;
      }
    }
    if (
      p.min_top_votes !== undefined &&
      p.min_top_votes < minTopVotes(p.min_valid ?? policy.min_valid)
    ) {
      return null;
    }
  }
  return stored;
}

/** True when an emergency-guarding weight is below the policy's. */
export function isWhatIf(overrides, policy) {
  const w = overrides?.policy?.under_weights;
  if (!w || !policy) return false;
  return EMERGENCY_WEIGHTS.some(i => w[i] < policy.under_weights[i]);
}

/**
 * The overrides a live /v1/route may send: human_review_cost removed (the
 * Worker rejects it live) and each emergency weight raised to at least the
 * policy's, so a what-if setting never 400s a live route. Null when
 * nothing is left.
 */
export function liveOverrides(overrides, policy) {
  if (!overrides || !policy) return null;
  const out = {};
  if (overrides.models) out.models = overrides.models;
  const p = {...(overrides.policy ?? {})};
  delete p.human_review_cost;
  if (p.under_weights) {
    const w = p.under_weights.map((x, i) =>
      EMERGENCY_WEIGHTS.includes(i) ? Math.max(x, policy.under_weights[i]) : x,
    );
    if (w.every((x, i) => x === policy.under_weights[i])) delete p.under_weights;
    else p.under_weights = w;
  }
  if (Object.keys(p).length) out.policy = p;
  return Object.keys(out).length ? out : null;
}

/**
 * The overrides named in one line, such as "Sonnet only · agreement
 * 14/20". Null when there are none.
 */
export function overridesText(overrides) {
  if (!overrides) return null;
  const parts = [];
  if (overrides.models) parts.push(MODEL_LABELS[overrides.models] ?? overrides.models);
  const p = overrides.policy ?? {};
  if (p.min_top_votes !== undefined) parts.push(`agreement ${p.min_top_votes}/${SAMPLES}`);
  if (p.min_valid !== undefined) parts.push(`valid samples ${p.min_valid}/${SAMPLES}`);
  if (p.max_span !== undefined) parts.push(`spread ${p.max_span}`);
  if (p.human_review_cost !== undefined) {
    parts.push(`review cost ${p.human_review_cost.toFixed(2)}`);
  }
  if (p.under_weights) parts.push(`under-triage weights ${p.under_weights.join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The banner line for the settings the next live route will send, such as
 * "Next live message uses: Sonnet only · agreement 14/20". It describes
 * the settings, not the result on screen. Null when there are none.
 */
export function bannerText(overrides) {
  const text = overridesText(overrides);
  return text ? `Next live message uses: ${text}` : null;
}

/**
 * The banner over the physician and patient views. A replay shows its
 * saved result, so while overrides are active it says that instead of
 * claiming the overrides were used.
 */
export function routingBanner(overrides, replay) {
  const text = bannerText(overrides);
  if (!text) return null;
  return replay ? 'Replay: saved result' : text;
}

function formatMetric(x, kind) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '—';
  if (kind === 'percent') return formatPercent(x);
  if (kind === 'decimal') return x.toFixed(2);
  return String(x);
}

/** "12% → 18%", "0.80 → 0.86" or "0 → 2", from the baseline to now. */
export function delta(now, base, kind) {
  const n = formatMetric(now, kind);
  if (base === null || base === undefined) return n;
  const b = formatMetric(base, kind);
  return b === n ? `${n}, no change` : `${b} → ${n}`;
}

/**
 * True for a re-score Summary from the Worker. An error object such as
 * {error: 0} is not one, so it is never shown as numbers.
 */
function isSummary(x) {
  return (
    x !== null &&
    typeof x === 'object' &&
    Number.isFinite(x.n) &&
    Number.isFinite(x.emergencies) &&
    Number.isFinite(x.missed) &&
    x.confusion !== null &&
    typeof x.confusion === 'object'
  );
}

/** One plain reason for a failed re-score, by HTTP status (0: no reply). */
function rescoreErrorText(status) {
  if (status === 0) return 'Couldn’t reach the Worker. Check the connection.';
  if (status === 404) return 'This run is no longer stored on the Worker.';
  if (status === 409) return 'This run cannot be re-scored.';
  if (status === 400) return 'The Worker rejected these settings.';
  if (status === 401) return 'The access token was rejected.';
  return `The Worker returned an error (HTTP ${status}).`;
}

/**
 * Turns a re-score reply ({ok, status, data}, status 0 for a network
 * failure) into exactly one of {summary} or {error: message}. Failure is
 * decided by ok and by the shape of the summary, never by the truthiness
 * of a status, so status 0 is always an error.
 */
export function rescoreOutcome(res) {
  if (res?.ok !== true) {
    return {error: rescoreErrorText(Number.isInteger(res?.status) ? res.status : 0)};
  }
  const summary = res.data?.summary;
  return isSummary(summary) ? {summary} : {error: 'The Worker sent an unreadable result.'};
}

/**
 * What the results panel shows. A failed re-score never keeps the previous
 * numbers on screen: they would read as the result of settings the
 * sliders no longer show.
 */
export function resultsPanel({summary, error, rescoring}) {
  if (typeof error === 'string' && error !== '') {
    return {
      kind: 'error',
      summary: null,
      text: `Couldn’t re-score these settings — ${error} Move a slider or Reset to try again.`,
    };
  }
  if (isSummary(summary)) return {kind: 'metrics', summary, busy: rescoring === true};
  if (rescoring) return {kind: 'loading', summary: null, text: 'Re-scoring…'};
  return {kind: 'empty', summary: null, text: 'No result yet.'};
}

/** Shading steps for the confusion grid; 0 is no fill. */
export const GRID_STEPS = 7;

/**
 * The confusion grid: one row per reference level, one column per routed
 * level plus Human review. Each cell has its count, the baseline count
 * (null without one) and a shading step from 0 (none) to GRID_STEPS,
 * scaled to the largest count on the grid.
 */
export function confusionGrid(confusion, base) {
  const columns = [
    ...LEVELS.map(level => ({key: level, label: levelLabel(level)})),
    {key: 'human_review', label: 'Human review'},
  ];
  const count = (grid, r, c) => {
    const n = grid?.[r]?.[c];
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  let max = 0;
  for (const r of LEVELS) {
    for (const c of columns) max = Math.max(max, count(confusion, r, c.key));
  }
  const rows = LEVELS.map(level => ({
    level,
    label: levelLabel(level),
    cells: columns.map(c => {
      const n = count(confusion, level, c.key);
      return {
        key: c.key,
        label: c.label,
        count: n,
        base: base ? count(base, level, c.key) : null,
        step: n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * GRID_STEPS)),
        diagonal: c.key === level,
      };
    }),
  }));
  return {columns, rows, max};
}
