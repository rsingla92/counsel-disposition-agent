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

/** One bar per level, most acute first; null when there are no votes. */
export function voteBars(votes) {
  if (!votes) return null;
  const total = LEVELS.reduce((n, l) => n + (votes[l] ?? 0), 0);
  return LEVELS.map(level => {
    const count = votes[level] ?? 0;
    return {level, count, share: total > 0 ? count / total : 0};
  });
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
