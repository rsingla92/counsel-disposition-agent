import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  LEVELS,
  LEVEL_WINDOWS,
  OVERRIDE_REASON_LABELS,
  REASON_LABELS,
  applyPinned,
  canOverride,
  emergencyLead,
  emergencyLeads,
  failedRun,
  fallbackFor,
  formatPercent,
  highlight,
  highlightExcerpts,
  isEmergency,
  levelLabel,
  parseNdjson,
  patientBlocks,
  nextPin,
  pinFor,
  readToken,
  replayTarget,
  takeLines,
  tierOf,
  voteBars,
  voteRows,
  writeToken,
} from '../lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

const HOLDING =
  'Thanks for your message. A Counsel physician will review it within 1 ' +
  'hour. If this is an emergency, call 911 now.';

function result(over = {}) {
  return {
    status: 'routed',
    disposition: 'routine',
    patient_message: 'A Counsel physician will review your message. Rest.',
    safety_net: 'Rest.',
    ...over,
  };
}

// --- highlight -------------------------------------------------------------

test('highlight marks excerpts across whitespace and case', () => {
  const parts = highlight('My chest  feels tight today', ['chest feels tight']);
  assert.deepEqual(
    parts.filter(p => p.mark).map(p => p.text),
    ['chest  feels tight'],
  );
});

test('highlight keeps every character of the message, in order', () => {
  const msg = 'Refill please.\nAlso my FOOT is red and spreading.';
  const parts = highlight(msg, ['foot is red', 'nothing like this']);
  assert.equal(parts.map(p => p.text).join(''), msg);
  assert.deepEqual(
    parts.filter(p => p.mark).map(p => p.text),
    ['FOOT is red'],
  );
});

test('highlight matches curly quotes the way verifyExcerpt does', () => {
  const parts = highlight('He said it’s “probably nothing”.', [
    'it\'s "probably nothing"',
  ]);
  assert.deepEqual(
    parts.filter(p => p.mark).map(p => p.text),
    ['it’s “probably nothing”'],
  );
});

test('highlight merges overlapping excerpts and ignores empty ones', () => {
  const parts = highlight('fever and fewer wet diapers', [
    'fever and fewer',
    'fewer wet diapers',
    '   ',
    null,
  ]);
  assert.deepEqual(
    parts.filter(p => p.mark).map(p => p.text),
    ['fever and fewer wet diapers'],
  );
});

test('highlight marks every occurrence of an excerpt', () => {
  const parts = highlight('dizzy, then dizzy again', ['dizzy']);
  assert.equal(parts.filter(p => p.mark).length, 2);
});

test('highlight with no excerpts returns the whole message unmarked', () => {
  assert.deepEqual(highlight('hello', []), [{text: 'hello', mark: false}]);
});

test('highlightExcerpts uses only verified flag and modifier excerpts', () => {
  const r = {
    red_flags: [
      {id: 'f1', state: 'present', excerpt: 'flag ok', excerpt_verified: true},
      {id: 'f2', state: 'present', excerpt: 'flag bad', excerpt_verified: false},
      {id: 'f3', state: 'absent', excerpt: 'absent one', excerpt_verified: false},
    ],
    modifiers: [
      {id: 'm1', excerpt: 'mod ok', excerpt_verified: true},
      {id: 'm2', excerpt: 'mod bad', excerpt_verified: false},
      {id: 'm3', excerpt: null, excerpt_verified: false},
    ],
  };
  assert.deepEqual(highlightExcerpts(r), ['flag ok', 'mod ok']);
  assert.deepEqual(highlightExcerpts(null), []);
});

test('highlightExcerpts never highlights a modifier without excerpt_verified', () => {
  // An older saved run without the field must not count as verified.
  const r = {red_flags: [], modifiers: [{id: 'm', excerpt: 'text'}]};
  assert.deepEqual(highlightExcerpts(r), []);
});

// --- NDJSON ----------------------------------------------------------------

test('parseNdjson returns events in order', () => {
  assert.deepEqual(
    parseNdjson('{"event":"early"}\n{"event":"result"}\n').map(e => e.event),
    ['early', 'result'],
  );
});

test('parseNdjson skips blank lines and accepts CRLF', () => {
  assert.equal(parseNdjson('\r\n{"a":1}\r\n\n{"a":2}').length, 2);
});

test('parseNdjson throws on a malformed line', () => {
  assert.throws(() => parseNdjson('{"a":1}\nnot json\n'));
});

test('takeLines returns complete events and keeps the partial line', () => {
  const first = takeLines('{"event":"early"}\n{"event":"res');
  assert.deepEqual(
    first.events.map(e => e.event),
    ['early'],
  );
  assert.equal(first.rest, '{"event":"res');
  const second = takeLines(first.rest + 'ult"}\n');
  assert.deepEqual(
    second.events.map(e => e.event),
    ['result'],
  );
  assert.equal(second.rest, '');
});

// --- levels and labels -----------------------------------------------------

test('levelLabel matches LEVEL_LABELS in worker/src/levels.ts', () => {
  const src = read('worker/src/levels.ts');
  const block = /LEVEL_LABELS[^{]*\{([^}]*)\}/.exec(src)[1];
  const pairs = [...block.matchAll(/(\w+):\s*'([^']*)'/g)];
  assert.equal(pairs.length, 7);
  for (const [, level, label] of pairs) {
    assert.equal(levelLabel(level), label);
  }
});

test('levelLabel of null or an unknown level never invents a level', () => {
  assert.equal(levelLabel(null), 'No disposition');
  assert.equal(levelLabel('bogus'), 'bogus');
});

test('LEVELS and tiers match the schema and levels.ts', () => {
  const schema = JSON.parse(read('schema/route-result.schema.json'));
  const levels = schema.properties.disposition.anyOf.find(a => a.enum).enum;
  assert.deepEqual(LEVELS, levels);
  assert.equal(tierOf('call_911'), 'emergency');
  assert.equal(tierOf('ed_now'), 'emergency');
  assert.equal(tierOf('in_person_today'), 'same_day');
  assert.equal(tierOf('physician_contact_today'), 'same_day');
  assert.equal(tierOf('within_few_days'), 'async');
  assert.equal(tierOf('routine'), 'async');
  assert.equal(tierOf('self_care'), 'self_care');
  assert.equal(tierOf(null), null);
});

test('LEVEL_WINDOWS match physician_window in policy.yaml', () => {
  const yaml = read('policy/policy.yaml');
  for (const level of LEVELS) {
    const m = new RegExp(
      `\\n  ${level}:\\n    physician_window: "([^"]*)"`,
    ).exec(yaml);
    assert.ok(m, `no physician_window for ${level}`);
    assert.equal(LEVEL_WINDOWS[level], m[1]);
  }
});

test('REASON_LABELS covers every ReasonCode in the schema', () => {
  const schema = JSON.parse(read('schema/route-result.schema.json'));
  const codes =
    schema.properties.human_review.properties.reasons.items.enum;
  assert.ok(codes.includes('secondary_unavailable'));
  assert.deepEqual(Object.keys(REASON_LABELS).sort(), [...codes].sort());
  for (const code of codes) {
    assert.ok(REASON_LABELS[code].length > 0);
    assert.notEqual(REASON_LABELS[code], code);
  }
  assert.equal(REASON_LABELS.secondary_unavailable, 'Second model unavailable');
  assert.equal(REASON_LABELS.split_vote, 'Split vote');
  assert.equal(REASON_LABELS.unverified_excerpt, 'Excerpt not verified');
});

test('OVERRIDE_REASON_LABELS covers OverrideReasonCodeSchema', () => {
  const src = read('worker/src/schema.ts');
  const block = /OverrideReasonCodeSchema = z\.enum\(\[([^\]]*)\]/.exec(src)[1];
  const codes = [...block.matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.equal(codes.length, 7);
  assert.deepEqual(
    Object.keys(OVERRIDE_REASON_LABELS).sort(),
    [...codes].sort(),
  );
});

// --- numbers ---------------------------------------------------------------

test('formatPercent rounds and shows a dash for null', () => {
  assert.equal(formatPercent(0.85), '85%');
  assert.equal(formatPercent(0.666), '67%');
  assert.equal(formatPercent(null), '—');
});

test('voteBars lists all seven levels with shares of the total', () => {
  const bars = voteBars({
    call_911: 0,
    ed_now: 0,
    in_person_today: 0,
    physician_contact_today: 0,
    within_few_days: 15,
    routine: 5,
    self_care: 0,
  });
  assert.deepEqual(
    bars.map(b => b.level),
    LEVELS,
  );
  assert.equal(bars[4].share, 0.75);
  assert.equal(bars[5].count, 5);
  assert.equal(voteBars(null), null);
  assert.ok(voteBars(Object.fromEntries(LEVELS.map(l => [l, 0]))).every(
    b => b.share === 0,
  ));
});

// --- combined vote chart ---------------------------------------------------

const zeroVotes = () => Object.fromEntries(LEVELS.map(l => [l, 0]));
const withVotes = o => ({...zeroVotes(), ...o});
const REFILL = {
  primary: withVotes({physician_contact_today: 3, within_few_days: 16, routine: 1}),
  secondary: withVotes({physician_contact_today: 5, within_few_days: 14, routine: 1}),
};

test('voteRows gives one row per level, most acute first, with both families', () => {
  const v = voteRows(REFILL, 'within_few_days');
  assert.deepEqual(v.series, ['primary', 'secondary']);
  assert.deepEqual(v.rows.map(r => r.level), LEVELS);
  assert.equal(v.rows[0].label, 'Call 911');
  const few = v.rows.find(r => r.level === 'within_few_days');
  assert.deepEqual(few.primary, {count: 16, pct: 80, lead: true});
  assert.deepEqual(few.secondary, {count: 14, pct: 70, lead: true});
  const contact = v.rows.find(r => r.level === 'physician_contact_today');
  assert.equal(contact.primary.lead, false);
  assert.equal(contact.secondary.count, 5);
});

test('voteRows marks each family modal level separately; ties go to the more acute', () => {
  const v = voteRows(
    {
      primary: withVotes({ed_now: 10, routine: 10}),
      secondary: withVotes({routine: 12, self_care: 8}),
    },
    'routine',
  );
  const lead = fam => v.rows.filter(r => r[fam].lead).map(r => r.level);
  assert.deepEqual(lead('primary'), ['ed_now']);
  assert.deepEqual(lead('secondary'), ['routine']);
});

test('voteRows uses one shared max across both families', () => {
  const v = voteRows(
    {primary: withVotes({routine: 20}), secondary: withVotes({routine: 12, self_care: 8})},
    'routine',
  );
  assert.equal(v.max, 20);
  const v2 = voteRows(
    {primary: withVotes({routine: 6}), secondary: withVotes({routine: 9})},
    'routine',
  );
  assert.equal(v2.max, 9);
});

test('voteRows flags the chosen disposition, which may differ from the modal vote', () => {
  const v = voteRows(REFILL, 'physician_contact_today');
  assert.deepEqual(v.rows.filter(r => r.chosen).map(r => r.level), [
    'physician_contact_today',
  ]);
  assert.equal(v.rows.find(r => r.level === 'within_few_days').primary.lead, true);
  assert.equal(voteRows(REFILL, null).rows.some(r => r.chosen), false);
});

test('voteRows with no secondary is single-series', () => {
  const v = voteRows({primary: REFILL.primary, secondary: null}, 'within_few_days');
  assert.deepEqual(v.series, ['primary']);
  assert.ok(v.rows.every(r => r.secondary === undefined));
  assert.equal(v.max, 16);
  const v2 = voteRows({primary: REFILL.primary}, 'within_few_days');
  assert.deepEqual(v2.series, ['primary']);
});

test('voteRows reports all-zero and missing votes as empty', () => {
  assert.equal(voteRows({primary: zeroVotes(), secondary: zeroVotes()}, null).empty, true);
  assert.equal(voteRows({primary: zeroVotes(), secondary: null}, null).empty, true);
  assert.equal(voteRows(null, null).empty, true);
  assert.equal(voteRows(REFILL, 'routine').empty, false);
  // A zero family never gets a lead.
  const v = voteRows({primary: REFILL.primary, secondary: zeroVotes()}, 'routine');
  assert.ok(v.rows.every(r => r.secondary.lead === false));
});

// --- emergency leads -------------------------------------------------------

test('isEmergency is true only for call_911 and ed_now', () => {
  assert.deepEqual(
    LEVELS.filter(isEmergency),
    ['call_911', 'ed_now'],
  );
  assert.equal(isEmergency(null), false);
});

test('emergencyLead shows the early message before the result arrives', () => {
  const early = {event: 'early', floor: 'ed_now', patient_message: 'Go now.'};
  assert.equal(emergencyLead(null, early), 'Go now.');
});

test('emergencyLead leads for Emergency whatever the status', () => {
  for (const status of ['routed', 'needs_info', 'human_review']) {
    const r = result({status, disposition: 'call_911', patient_message: 'Call 911 now.'});
    assert.equal(emergencyLead(r, null), 'Call 911 now.');
  }
});

test('emergencyLead keeps the early instruction if the result lacks one', () => {
  const early = {event: 'early', floor: 'call_911', patient_message: 'Call 911.'};
  const r = result({status: 'human_review', disposition: null, patient_message: HOLDING});
  assert.equal(emergencyLead(r, early), 'Call 911.');
});

test('emergencyLead is null for non-Emergency results', () => {
  assert.equal(emergencyLead(result(), null), null);
  assert.equal(emergencyLead(null, null), null);
});

test('patientBlocks puts the Emergency instruction first, even for needs_info', () => {
  const r = result({
    status: 'needs_info',
    disposition: 'ed_now',
    patient_message: 'Go to the nearest emergency department now. Watch for drowsiness.',
    safety_net: 'Watch for drowsiness.',
  });
  const blocks = patientBlocks(r, null);
  assert.equal(blocks[0].kind, 'emergency');
  assert.equal(blocks[0].text, 'Go to the nearest emergency department now.');
  assert.deepEqual(blocks[1], {kind: 'safety_net', text: 'Watch for drowsiness.'});
});

test('patientBlocks shows only the early instruction while waiting', () => {
  const early = {event: 'early', floor: 'call_911', patient_message: 'Call 911 now.'};
  assert.deepEqual(patientBlocks(null, early), [
    {kind: 'emergency', text: 'Call 911 now.'},
    {kind: 'pending', text: 'Checking the rest of your message.'},
  ]);
});

test('patientBlocks never drops an early instruction the result lacks', () => {
  const early = {event: 'early', floor: 'call_911', patient_message: 'Call 911 now.'};
  const r = result({status: 'human_review', disposition: null, patient_message: HOLDING, safety_net: ''});
  const blocks = patientBlocks(r, early);
  assert.deepEqual(blocks[0], {kind: 'emergency', text: 'Call 911 now.'});
  assert.deepEqual(blocks[1], {kind: 'message', text: HOLDING});
});

test('patientBlocks marks Self-care as a draft awaiting sign-off', () => {
  const r = result({
    disposition: 'self_care',
    patient_message: 'Home care is appropriate for now. Drink fluids.',
    safety_net: 'Drink fluids.',
  });
  const blocks = patientBlocks(r, null);
  assert.deepEqual(blocks[0], {
    kind: 'draft',
    text: 'Draft — awaiting physician sign-off',
  });
  assert.equal(blocks[1].kind, 'message');
  assert.equal(blocks[2].kind, 'safety_net');
});

test('patientBlocks shows the holding message for Human review', () => {
  const r = result({status: 'human_review', disposition: null, patient_message: HOLDING, safety_net: ''});
  assert.deepEqual(patientBlocks(r, null), [{kind: 'message', text: HOLDING}]);
});

test('patientBlocks keeps a safety net not found at the end of the message', () => {
  const r = result({patient_message: 'See you soon.', safety_net: 'Call if worse.'});
  assert.deepEqual(patientBlocks(r, null), [
    {kind: 'message', text: 'See you soon.'},
    {kind: 'safety_net', text: 'Call if worse.'},
  ]);
});

// --- token storage ---------------------------------------------------------

test('token storage round-trips through storage under one key', () => {
  const map = new Map();
  const storage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k),
  };
  assert.equal(readToken(storage), '');
  writeToken(storage, 'abc');
  assert.equal(readToken(storage), 'abc');
  assert.equal(map.size, 1);
  writeToken(storage, '');
  assert.equal(map.size, 0);
});

test('token storage survives storage that throws', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  const storage = {getItem: boom, setItem: boom, removeItem: boom};
  assert.equal(readToken(storage), '');
  assert.doesNotThrow(() => writeToken(storage, 'abc'));
  assert.equal(readToken(undefined), '');
});

// --- failure state, replay target, override guard --------------------------

test('failedRun keeps the early Emergency instruction and marks failure', () => {
  const early = {event: 'early', floor: 'ed_now', patient_message: 'Go now.'};
  const run = failedRun('msg A', early);
  assert.deepEqual(run, {
    message: 'msg A',
    early,
    result: null,
    replay: false,
    failed: true,
  });
  assert.equal(emergencyLead(run.result, run.early), 'Go now.');
  assert.equal(patientBlocks(run.result, run.early, true)[0].kind, 'emergency');
});

test('a failed run is not shown as still pending in the patient view', () => {
  const blocks = patientBlocks(null, null, true);
  assert.ok(blocks.every(b => b.kind !== 'pending'));
  assert.deepEqual(blocks.at(-1), {
    kind: 'failed',
    text: 'We could not finish checking your message. A Counsel physician will review it. If this is an emergency, call 911 now.',
  });
});

test('replayTarget matches the routed message, not whatever is selected now', () => {
  const demos = [
    {id: 'a', message: 'message A'},
    {id: 'b', message: 'message B'},
  ];
  assert.equal(replayTarget(demos, {demoId: 'a', message: 'message A'}).id, 'a');
  // Demo id and text must agree: an edited message has no saved run.
  assert.equal(replayTarget(demos, {demoId: 'a', message: 'message A, edited'}), null);
  assert.equal(replayTarget(demos, {demoId: 'b', message: 'message A'}), null);
  assert.equal(replayTarget(demos, {demoId: '', message: 'message A'}), null);
});

test('canOverride needs a different level, a known reason and no block', () => {
  const ok = {from: 'routine', to: 'ed_now', reason: 'under_triage', blocked: null};
  assert.equal(canOverride(ok), true);
  assert.equal(canOverride({...ok, to: 'routine'}), false);
  assert.equal(canOverride({...ok, to: null}), false);
  assert.equal(canOverride({...ok, to: 'bogus'}), false);
  assert.equal(canOverride({...ok, reason: ''}), false);
  assert.equal(canOverride({...ok, reason: 'bogus'}), false);
  assert.equal(canOverride({...ok, blocked: 'replay'}), false);
});

test('canOverride allows any level when there is no disposition', () => {
  const none = {from: null, to: 'ed_now', reason: 'under_triage', blocked: null};
  assert.equal(canOverride(none), true);
  assert.equal(canOverride({...none, to: null}), false);
  assert.equal(canOverride({...none, from: 'none'}), false);
  assert.equal(canOverride({...none, blocked: 'replay'}), false);
});

// --- fallback after a failed live call --------------------------------------

function savedRun(disposition, patientMessage) {
  return {
    id: 'demo',
    message: 'saved message',
    early: null,
    synthetic_fixture: true,
    recorded_at: '2026-11-03T00:00:00+00:00',
    result: result({disposition, patient_message: patientMessage, safety_net: ''}),
  };
}

test('fallbackFor: a live ed_now early event never falls back to a lower saved run', () => {
  const early = {event: 'early', floor: 'ed_now', patient_message: 'Go to the ED now.'};
  const run = fallbackFor('live message', early, savedRun('within_few_days', 'Within 72 hours.'));
  assert.equal(run.failed, true);
  assert.equal(run.replay, false);
  assert.equal(run.result, null);
  assert.equal(run.message, 'live message');
  assert.equal(emergencyLead(run.result, run.early), 'Go to the ED now.');
  const blocks = patientBlocks(run.result, run.early, run.failed);
  assert.deepEqual(blocks[0], {kind: 'emergency', text: 'Go to the ED now.'});
  assert.ok(blocks.every(b => !b.text.includes('72 hours')));
});

test('fallbackFor: a live call_911 early event is not replaced by a saved ed_now', () => {
  const early = {event: 'early', floor: 'call_911', patient_message: 'Call 911 now.'};
  const run = fallbackFor('live message', early, savedRun('ed_now', 'Go to the ED now.'));
  assert.equal(run.failed, true);
  assert.equal(run.result, null);
  assert.equal(emergencyLead(run.result, run.early), 'Call 911 now.');
});

test('fallbackFor: with no early event the saved run is shown as a replay', () => {
  const saved = savedRun('within_few_days', 'Within 72 hours.');
  const run = fallbackFor('saved message', null, saved);
  assert.equal(run.replay, true);
  assert.equal(run.failed, undefined);
  assert.equal(run.result, saved.result);
  assert.equal(run.synthetic, true);
  assert.equal(run.recordedAt, '2026-11-03T00:00:00+00:00');
});

test('fallbackFor: no early event and nothing saved is a failed run', () => {
  assert.deepEqual(fallbackFor('m', null, null), failedRun('m', null));
});

// --- pinned live Emergency instruction --------------------------------------

const TARGET = {demoId: 'refill', message: 'the routed message'};
const ED_EARLY = {event: 'early', floor: 'ed_now', patient_message: 'LIVE: go to the ED now.'};
const PIN = {target: TARGET, early: ED_EARLY};

function replayOf(disposition, patientMessage) {
  return {
    message: TARGET.message,
    early: null,
    result: result({disposition, patient_message: patientMessage, safety_net: ''}),
    replay: true,
    synthetic: true,
    recordedAt: null,
  };
}

test('applyPinned hides a less acute replay for the pinned target', () => {
  const {run, hidden} = applyPinned(PIN, TARGET, replayOf('within_few_days', 'Within 72 hours.'));
  assert.equal(hidden, true);
  assert.deepEqual(run, failedRun(TARGET.message, ED_EARLY));
  assert.deepEqual(emergencyLeads(run.result, run.early), ['LIVE: go to the ED now.']);
  const blocks = patientBlocks(run.result, run.early, run.failed);
  assert.deepEqual(blocks[0], {kind: 'emergency', text: 'LIVE: go to the ED now.'});
  assert.ok(blocks.every(b => !b.text.includes('72 hours')));
});

test('applyPinned hides a replay with no disposition, and stands in for a missing run', () => {
  const none = replayOf(null, 'Holding message.');
  none.result.status = 'human_review';
  assert.equal(applyPinned(PIN, TARGET, none).run.failed, true);
  assert.deepEqual(applyPinned(PIN, TARGET, null).run, failedRun(TARGET.message, ED_EARLY));
});

test('applyPinned shows a more acute replay with both leads, most acute first', () => {
  const saved = replayOf('call_911', 'SAVED: call 911 now.');
  const {run, hidden} = applyPinned(PIN, TARGET, saved);
  assert.equal(hidden, false);
  assert.equal(run.replay, true);
  assert.equal(run.result, saved.result);
  assert.deepEqual(emergencyLeads(run.result, run.early), [
    'SAVED: call 911 now.',
    'LIVE: go to the ED now.',
  ]);
  const kinds = patientBlocks(run.result, run.early).map(b => b.kind);
  assert.deepEqual(kinds.slice(0, 2), ['emergency', 'emergency']);
});

test('applyPinned keeps the pinned live lead first at the same level', () => {
  const {run} = applyPinned(PIN, TARGET, replayOf('ed_now', 'SAVED: go to the ED.'));
  assert.deepEqual(emergencyLeads(run.result, run.early), [
    'LIVE: go to the ED now.',
    'SAVED: go to the ED.',
  ]);
});

test('applyPinned leaves runs for a different target unchanged', () => {
  const saved = replayOf('within_few_days', 'Within 72 hours.');
  for (const other of [
    {demoId: 'other', message: TARGET.message},
    {demoId: TARGET.demoId, message: 'edited text'},
  ]) {
    const {run, hidden} = applyPinned(PIN, other, saved);
    assert.equal(run, saved);
    assert.equal(hidden, false);
  }
  assert.equal(applyPinned(null, TARGET, saved).run, saved);
});

test('pinFor keeps the pin for the same target and clears it otherwise', () => {
  assert.equal(pinFor(PIN, {...TARGET}), PIN);
  assert.equal(pinFor(PIN, {...TARGET, message: 'the routed message!'}), null);
  assert.equal(pinFor(PIN, {...TARGET, demoId: ''}), null);
  assert.equal(pinFor(null, TARGET), null);
});

test('nextPin keeps the most acute early event for the same target', () => {
  const call911 = {event: 'early', floor: 'call_911', patient_message: 'LIVE: call 911.'};
  const pin911 = {target: TARGET, early: call911};
  assert.equal(nextPin(pin911, {...TARGET}, ED_EARLY), pin911);
  assert.deepEqual(nextPin(PIN, TARGET, call911), {target: TARGET, early: call911});
  const again = {...ED_EARLY, patient_message: 'LIVE: newer ED text.'};
  assert.deepEqual(nextPin(PIN, TARGET, again), {target: TARGET, early: again});
  const other = {demoId: 'other', message: 'another message'};
  assert.deepEqual(nextPin(pin911, other, ED_EARLY), {target: other, early: ED_EARLY});
  assert.deepEqual(nextPin(null, TARGET, ED_EARLY), PIN);
});

test('applyPinned reports when it replaced a live run', () => {
  const live = {...replayOf('within_few_days', 'Within 72 hours.'), replay: false};
  const less = applyPinned(PIN, TARGET, live);
  assert.equal(less.replaced, true);
  assert.equal(less.hidden, false);
  assert.deepEqual(less.run, failedRun(TARGET.message, ED_EARLY));
  assert.equal(applyPinned(PIN, TARGET, {...live, result: {...live.result, disposition: 'ed_now'}}).replaced, false);
  assert.equal(applyPinned(PIN, TARGET, replayOf('within_few_days', 'x')).replaced, true);
  assert.equal(applyPinned(null, TARGET, live).replaced, false);
});

test('emergencyLeads drops duplicates and non-Emergency levels', () => {
  const r = result({disposition: 'ed_now', patient_message: 'Go now.'});
  assert.deepEqual(
    emergencyLeads(r, {event: 'early', floor: 'ed_now', patient_message: 'Go now.'}),
    ['Go now.'],
  );
  assert.deepEqual(emergencyLeads(result(), null), []);
});
