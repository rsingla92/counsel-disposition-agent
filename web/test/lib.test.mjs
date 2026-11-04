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
  emergencyLead,
  formatPercent,
  highlight,
  isEmergency,
  levelLabel,
  parseNdjson,
  patientBlocks,
  readToken,
  takeLines,
  tierOf,
  voteBars,
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
