// The demo page. Everything is built with DOM calls and textContent, never
// innerHTML, because messages and results are untrusted text.
import {WORKER_URL} from './config.js';
import {
  LEVELS,
  LEVEL_WINDOWS,
  OVERRIDE_REASON_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  TIER_LABELS,
  canOverride,
  applyPinned,
  emergencyLeads,
  fallbackFor,
  formatPercent,
  highlight,
  highlightExcerpts,
  levelLabel,
  parseNdjson,
  patientBlocks,
  pinFor,
  readToken,
  replayRun,
  replayTarget,
  takeLines,
  tierOf,
  voteBars,
  writeToken,
} from './lib.js';

const LIVE_TIMEOUT_MS = 90_000;
const HOLDING_WINDOW = 'Physician review within 1 hour';

const $ = id => document.getElementById(id);

const ui = {
  demo: $('demo'),
  message: $('message'),
  replay: $('replay'),
  replayNote: $('replay-note'),
  route: $('route'),
  token: $('token'),
  saveToken: $('save-token'),
  clearToken: $('clear-token'),
  status: $('status'),
  physician: $('physician'),
  patient: $('patient'),
  viewPhysician: $('view-physician'),
  viewPatient: $('view-patient'),
};

const state = {
  demos: [],
  manifest: [],
  replayCache: new Map(),
  view: 'physician',
  // The run on screen: {message, early, result, replay, synthetic}.
  run: null,
  busy: false,
  // The live Emergency instruction for a routed target, {target, early}.
  // Kept while the same demo and message text stay selected.
  pinned: null,
};

function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// --- tiny DOM builder ------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Appends children, skipping null and false (append would print "null"). */
function appendAll(node, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
}

function arrow() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M10 3v13m0 0-5-5m5 5 5-5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return el('div', {class: 'arrow'}, svg);
}

function stepHeading(num, text, id) {
  return el(
    'h2',
    {class: 'eyebrow', id},
    el('span', {class: 'num', text: num}),
    text,
  );
}

// --- shared pieces ---------------------------------------------------------

function sourceLabels(run) {
  const labels = [];
  if (run.replay) {
    labels.push(el('span', {class: 'pill replay', text: 'Replay'}));
    labels.push(
      el('span', {
        class: 'note',
        text: run.recordedAt
          ? `Saved run recorded ${run.recordedAt.slice(0, 10)}`
          : 'Saved run, not a live call',
      }),
    );
  }
  if (run.synthetic) {
    labels.push(
      el('span', {
        class: 'pill unverified',
        text: 'Synthetic fixture: hand-written, not model output',
      }),
    );
  }
  return labels.length ? el('div', {class: 'source'}, labels) : null;
}

function emergencyBox(text, forPhysician, first = true) {
  let eyebrow = 'Emergency';
  if (forPhysician) {
    eyebrow = first
      ? 'Emergency · sent to the patient first'
      : 'Emergency · also sent';
  }
  return el(
    'div',
    {class: 'emergency-lead', role: 'alert'},
    el('p', {class: 'eyebrow', text: eyebrow}),
    el('p', {class: 'instruction', text}),
  );
}

// --- physician view --------------------------------------------------------

function presentFlags(result) {
  return (result?.red_flags ?? []).filter(f => f.state === 'present');
}

function messageCard(run) {
  const result = run.result;
  const parts = highlight(run.message, highlightExcerpts(result));
  return el(
    'article',
    {class: 'card', 'aria-labelledby': 'step-1'},
    stepHeading('01', 'Patient message', 'step-1'),
    el(
      'p',
      {class: 'message-text'},
      parts.map(p => (p.mark ? el('mark', {text: p.text}) : p.text)),
    ),
    el('p', {
      class: 'note',
      text: 'Highlighted: verified red-flag and modifier excerpts, found verbatim in the message.',
    }),
  );
}

function flagsCard(run) {
  const result = run.result;
  const card = el(
    'article',
    {class: 'card', 'aria-labelledby': 'step-2'},
    stepHeading('02', 'Red flags found', 'step-2'),
  );
  if (!result) {
    appendAll(
      card,
      el('p', {
        class: 'empty',
        text: run.failed
          ? 'No result: the live call failed.'
          : 'Waiting for the result.',
      }),
    );
    return card;
  }
  const flags = presentFlags(result);
  if (flags.length === 0) {
    appendAll(card, el('p', {class: 'empty', text: 'No red flags found.'}));
  } else {
    appendAll(card, 
      el(
        'ul',
        {class: 'flags'},
        flags.map(f =>
          el(
            'li',
            {},
            el(
              'div',
              {class: 'flag-head'},
              el('span', {class: 'mono', text: f.id}),
              f.excerpt_verified
                ? null
                : el('span', {class: 'pill unverified', text: 'unverified'}),
            ),
            f.excerpt
              ? el('q', {text: f.excerpt})
              : el('span', {class: 'note', text: 'No excerpt given.'}),
          ),
        ),
      ),
    );
  }
  const mods = result.modifiers ?? [];
  if (mods.length) {
    appendAll(card, 
      el('h3', {class: 'subhead', text: 'Modifiers'}),
      el(
        'ul',
        {class: 'flags'},
        mods.map(m =>
          el(
            'li',
            {class: 'modifier'},
            el(
              'div',
              {class: 'flag-head'},
              el('span', {class: 'mono', text: m.id}),
              m.excerpt_verified === true
                ? null
                : el('span', {class: 'pill unverified', text: 'unverified'}),
            ),
            m.excerpt
              ? el('q', {text: m.excerpt})
              : el('span', {class: 'note', text: 'No excerpt given.'}),
          ),
        ),
      ),
    );
  }
  return card;
}

function voteBlock(title, model, votes, chosen) {
  const bars = voteBars(votes);
  if (!bars) return null;
  return el(
    'div',
    {class: 'votes'},
    el('p', {class: 'model'}, `${title}: `, el('span', {class: 'mono', text: model ?? 'unnamed model'})),
    bars.map(b =>
      el(
        'div',
        {class: `vote-row${b.level === chosen ? ' chosen' : ''}`},
        el('span', {class: 'level', text: levelLabel(b.level)}),
        el(
          'span',
          {
            class: 'bar',
            role: 'img',
            'aria-label': `${b.count} votes for ${levelLabel(b.level)}`,
          },
          el('span', {
            class: 'fill',
            style: `width: ${(b.share * 100).toFixed(1)}%; display: block`,
          }),
        ),
        el('span', {class: 'count', 'aria-hidden': 'true', text: String(b.count)}),
      ),
    ),
  );
}

function row(term, ...value) {
  return [el('dt', {text: term}), el('dd', {}, ...value)];
}

function dispositionCard(run) {
  const result = run.result;
  const card = el(
    'article',
    {class: 'card', 'aria-labelledby': 'step-3'},
    stepHeading('03', 'Disposition', 'step-3'),
  );
  if (!result) {
    const floor = run.early?.floor;
    appendAll(card, 
      el('p', {
        class: 'empty',
        text: run.failed
          ? 'The live call failed before the full result. A physician must review this message.'
          : 'Sampling is still running.',
      }),
      floor
        ? el('p', {}, 'Rule floor already known: ', el('strong', {text: levelLabel(floor)}))
        : null,
    );
    return card;
  }
  const tier = tierOf(result.disposition);
  const tierClass = tier ?? 'none';
  const drivers = presentFlags(result).map(f => f.id);
  const window = result.disposition
    ? LEVEL_WINDOWS[result.disposition]
    : HOLDING_WINDOW;
  const reasons = result.human_review?.reasons ?? [];
  const questions = result.info_requests?.questions ?? [];
  const photo = result.info_requests?.photo === true;
  const models = result.trace?.models ?? [];

  appendAll(card, 
    el(
      'div',
      {class: 'disposition'},
      el('span', {class: `name ${tierClass}`, text: levelLabel(result.disposition)}),
      el('span', {
        class: `tier-pill ${tierClass}`,
        text: tier ? TIER_LABELS[tier] : 'Human review',
      }),
    ),
  );

  const dl = el(
    'dl',
    {class: 'rows'},
    row('Status', STATUS_LABELS[result.status] ?? result.status),
    row('Tier', tier ? TIER_LABELS[tier] : 'None: a physician decides'),
    row(
      'Confidence',
      formatPercent(result.confidence),
      result.confidence === null
        ? el('span', {class: 'note', text: ' (no vote)'})
        : el('span', {class: 'note', text: ' top vote share'}),
    ),
    row(
      'Floor',
      result.floor ? levelLabel(result.floor) : 'None',
      drivers.map(d => el('span', {class: 'mono', text: d})),
    ),
    row('Response window', window),
    row(
      'Review',
      reasons.length
        ? el(
            'div',
            {class: 'pills'},
            reasons.map(r =>
              el('span', {class: 'pill review', title: r, text: REASON_LABELS[r] ?? r}),
            ),
          )
        : 'None',
      result.human_review?.flagged
        ? el('p', {class: 'note', text: 'Flagged for physician review.'})
        : null,
    ),
    row(
      'Info requests',
      questions.length || photo
        ? [
            questions.length
              ? el('ol', {class: 'questions'}, questions.map(q => el('li', {text: q})))
              : null,
            photo ? el('p', {text: 'Photo requested.'}) : null,
          ]
        : 'None',
    ),
  );
  appendAll(card, dl);

  const primary = voteBlock(
    'Primary',
    models[0]?.model,
    result.votes?.primary,
    result.disposition,
  );
  const secondary = voteBlock(
    'Secondary',
    models[1]?.model,
    result.votes?.secondary,
    result.disposition,
  );
  appendAll(card, 
    el('h3', {class: 'subhead', text: 'Votes'}),
    primary ?? el('p', {class: 'empty', text: 'No votes.'}),
    secondary ??
      el('p', {class: 'note', text: 'No second-model votes for this result.'}),
    el('h3', {class: 'subhead', text: 'Justification'}),
    el('p', {class: 'prose', text: result.justification || '—'}),
    el('h3', {class: 'subhead', text: 'Safety-netting'}),
    el('p', {class: 'prose', text: result.safety_net || '—'}),
    el(
      'p',
      {class: 'note trace'},
      'Policy ',
      el('span', {class: 'mono', text: result.trace?.policy_version ?? '?'}),
      ' · input ',
      el('span', {class: 'mono', text: (result.trace?.input_sha256 ?? '').slice(0, 12) || '?'}),
    ),
  );
  return card;
}

function overrideCard(run) {
  const result = run.result;
  const card = el(
    'article',
    {class: 'card', 'aria-labelledby': 'override-h'},
    el('h2', {class: 'eyebrow', id: 'override-h', text: 'Physician override'}),
  );
  if (!result) return null;
  const from = result.disposition;
  const sha = result.trace?.input_sha256 ?? '';
  let blocked = null;
  if (run.replay) {
    blocked = 'Overrides are disabled in replay: nothing would be sent.';
  } else if (!from) {
    blocked = 'No disposition to override. Assign a level in the physician queue.';
  } else if (!/^[0-9a-f]{64}$/.test(sha)) {
    blocked = 'This result has no input hash, so an override cannot be logged.';
  }

  let to = null;
  const reason = el(
    'select',
    {id: 'override-reason', required: true, disabled: blocked !== null},
    el('option', {value: '', text: 'Choose a reason'}),
    Object.entries(OVERRIDE_REASON_LABELS).map(([code, label]) =>
      el('option', {value: code, text: label}),
    ),
  );
  const submit = el('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    text: 'Submit override',
  });
  const feedback = el('p', {class: 'status', role: 'status', 'aria-live': 'polite'});
  // The current level is shown but cannot be chosen: an override to the
  // same level is not an override.
  const buttons = LEVELS.map(level => {
    const isCurrent = level === from;
    return el(
      'button',
      {
        type: 'button',
        class: 'secondary',
        'aria-pressed': 'false',
        'aria-disabled': isCurrent ? 'true' : null,
        disabled: blocked !== null || isCurrent,
        onclick: () => {
          if (isCurrent) return;
          to = level;
          for (const b of buttons) {
            b.setAttribute('aria-pressed', String(b.dataset.level === level));
          }
          refresh();
        },
        'data-level': level,
      },
      levelLabel(level),
      isCurrent ? el('span', {class: 'current', text: 'Current'}) : null,
    );
  });
  const ready = () => canOverride({from, to, reason: reason.value, blocked});
  const refresh = () => {
    submit.disabled = !ready();
  };
  reason.addEventListener('change', refresh);
  submit.addEventListener('click', async () => {
    if (!ready()) return;
    submit.disabled = true;
    feedback.textContent = 'Sending…';
    try {
      const res = await fetch(`${WORKER_URL}/v1/override`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken()}`,
        },
        body: JSON.stringify({input_sha256: sha, from, to, reason_code: reason.value}),
      });
      feedback.textContent = res.ok
        ? `Override logged: ${levelLabel(from)} to ${levelLabel(to)}, ${OVERRIDE_REASON_LABELS[reason.value]}.`
        : `Override not logged (HTTP ${res.status}).`;
    } catch {
      feedback.textContent = 'Override not logged: the Worker could not be reached.';
    }
    refresh();
  });

  appendAll(card, 
    el('p', {class: 'note', text: 'Pick the level you would assign and a reason. Only the codes are logged, never free text.'}),
    el('div', {class: 'levels', role: 'group', 'aria-label': 'Override level'}, buttons),
    el('label', {for: 'override-reason', text: 'Reason (required)'}),
    reason,
    el('div', {class: 'row'}, submit),
    blocked ? el('p', {class: 'note', text: blocked}) : null,
    feedback,
  );
  return card;
}

function renderPhysician(run) {
  const root = ui.physician;
  root.replaceChildren();
  if (!run) {
    root.append(el('p', {class: 'empty', text: 'Pick a demo message or type one, then route it.'}));
    return;
  }
  const leads = emergencyLeads(run.result, run.early);
  const stack = el(
    'div',
    {class: 'stack'},
    messageCard(run),
    arrow(),
    flagsCard(run),
    arrow(),
    dispositionCard(run),
  );
  root.append(
    ...[
      sourceLabels(run),
      ...leads.flatMap((text, i) => [
        emergencyBox(text, true, i === 0),
        el('div', {style: 'height: 16px'}),
      ]),
      stack,
      run.result ? el('div', {style: 'height: 16px'}) : null,
      overrideCard(run),
    ].filter(Boolean),
  );
}

// --- patient view ----------------------------------------------------------

function renderPatient(run) {
  const root = ui.patient;
  root.replaceChildren();
  if (!run) {
    root.append(el('p', {class: 'empty', text: 'No message routed yet.'}));
    return;
  }
  const blocks = patientBlocks(run.result, run.early, run.failed === true);
  const reply = el(
    'div',
    {class: 'reply'},
    blocks.map(b => {
      if (b.kind === 'emergency') return emergencyBox(b.text, false);
      if (b.kind === 'safety_net') {
        return el(
          'div',
          {class: 'block safety_net'},
          el('h3', {text: 'If things change'}),
          el('p', {text: b.text}),
        );
      }
      const isDraftBody =
        b.kind === 'message' && run.result?.disposition === 'self_care';
      return el('div', {
        class: `block ${b.kind}${isDraftBody ? ' draft-body' : ''}`,
        text: b.text,
      });
    }),
  );
  root.append(
    el(
      'div',
      {class: 'phone'},
      sourceLabels(run),
      el(
        'article',
        {class: 'card', 'aria-labelledby': 'patient-h'},
        el('h2', {class: 'eyebrow', id: 'patient-h', text: 'Your message'}),
        el('p', {class: 'bubble from-patient', text: run.message}),
        el('h2', {class: 'eyebrow', text: 'Our reply'}),
        reply,
      ),
    ),
  );
}

function render() {
  renderPhysician(state.run);
  renderPatient(state.run);
}

// --- views -----------------------------------------------------------------

function setView(view) {
  state.view = view;
  ui.physician.hidden = view !== 'physician';
  ui.patient.hidden = view !== 'patient';
  ui.viewPhysician.setAttribute('aria-pressed', String(view === 'physician'));
  ui.viewPatient.setAttribute('aria-pressed', String(view === 'patient'));
}

// --- token -----------------------------------------------------------------

let sessionToken = '';

function currentToken() {
  return sessionToken || readToken(storage());
}

// --- replay ----------------------------------------------------------------

async function loadJson(path) {
  const res = await fetch(path, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function replayFor(id) {
  const entry = state.manifest.find(m => m.id === id);
  if (!entry) return null;
  if (!state.replayCache.has(id)) {
    state.replayCache.set(id, await loadJson(`replay/${entry.file}`));
  }
  return state.replayCache.get(id);
}

function selectedDemo() {
  return state.demos.find(d => d.id === ui.demo.value) ?? null;
}

/** What is being routed, captured once so later UI changes cannot alter it. */
function currentTarget() {
  return {demoId: ui.demo.value, message: ui.message.value};
}

/**
 * Loads the saved run for `routed` ({demoId, message}, captured when the
 * call started). Returns {saved} on success, or {saved: null, why}.
 */
async function loadSaved(routed) {
  const demo = replayTarget(state.demos, routed);
  if (!demo) {
    return {saved: null, why: 'Replay only has saved runs for the unedited demo messages.'};
  }
  try {
    const saved = await replayFor(demo.id);
    return saved ? {saved} : {saved: null, why: 'No saved run for this message yet.'};
  } catch {
    return {saved: null, why: 'Could not load the saved run.'};
  }
}

const HIDDEN_NOTE =
  'Saved run hidden: a live Emergency instruction was issued for this message.';

/**
 * Shows `run` for `routed`, after applying any pinned live Emergency
 * instruction for that target (applyPinned). Returns true if a saved run
 * was hidden because it was less acute than the live floor.
 */
function showRun(routed, run) {
  const shown = applyPinned(state.pinned, routed, run);
  state.run = shown.run;
  render();
  return shown.hidden;
}

/** Replay mode: shows the saved run for `routed`, or nothing. */
async function showReplay(routed) {
  const {saved, why} = await loadSaved(routed);
  const hidden = showRun(routed, saved ? replayRun(saved) : null);
  if (hidden) setStatus(HIDDEN_NOTE, true);
  else if (why) setStatus(why, true);
}

function updateReplayUi() {
  const replay = ui.replay.checked;
  ui.message.readOnly = replay || state.busy;
  ui.route.textContent = replay ? 'Show saved run' : 'Route message';
  if (!WORKER_URL) {
    ui.replay.disabled = true;
    ui.replayNote.textContent =
      'No Worker is configured, so this page shows saved runs only.';
  } else {
    ui.replay.disabled = state.busy;
    ui.replayNote.textContent = replay
      ? 'Showing saved runs. Turn replay off to call the Worker live.'
      : '';
  }
}

/** Locks the inputs that define the routed message while a call runs. */
function setBusy(busy) {
  state.busy = busy;
  ui.route.disabled = busy;
  ui.demo.disabled = busy;
  updateReplayUi();
}

// --- live ------------------------------------------------------------------

class LiveError extends Error {}

let callSeq = 0;

async function routeLive(routed) {
  const token = currentToken();
  if (!token) {
    setStatus('Enter the access token first (Access token, above).', true);
    document.getElementById('token-box').open = true;
    ui.token.focus();
    return;
  }
  const call = ++callSeq;
  // Events for any call but the latest are dropped, so a late answer for a
  // message no longer on screen never renders.
  const current = () => call === callSeq;
  const run = {message: routed.message, early: null, result: null, replay: false};
  // While waiting, a pinned live instruction for this message keeps leading.
  const pin = pinFor(state.pinned, routed);
  state.run = pin ? {...run, early: pin.early} : run;
  render();
  setStatus('Routing…');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_URL}/v1/route`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({message: routed.message}),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      throw new LiveError(
        res.status === 401 ? 'access token rejected' : `HTTP ${res.status}`,
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = events => {
      for (const e of events) {
        if (e.event === 'early') {
          run.early = e;
          if (current()) {
            state.pinned = {target: routed, early: e};
            state.run = run;
            render();
          }
        } else if (e.event === 'result') {
          run.result = e.result;
        }
      }
    };
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      const got = takeLines(buffer + decoder.decode(value, {stream: true}));
      buffer = got.rest;
      handle(got.events);
    }
    handle(parseNdjson(buffer + decoder.decode()));
    if (!run.result) throw new LiveError('no result in the stream');
    if (!current()) return;
    showRun(routed, run);
    setStatus('Live result.');
  } catch (e) {
    if (!current()) return;
    const why = e instanceof LiveError ? e.message : 'the Worker could not be reached';
    // After a live early event the call never falls back to a saved run
    // (fallbackFor), so none is loaded and replay is not switched on: the
    // live instruction stays pinned for this message.
    if (!run.early) {
      ui.replay.checked = true;
      updateReplayUi();
    }
    const saved = run.early ? null : (await loadSaved(routed)).saved;
    if (!current()) return;
    showRun(routed, fallbackFor(routed.message, run.early, saved));
    setStatus(
      state.run.replay
        ? `Live call failed (${why}). Switched to replay.`
        : run.early
          ? `Live call failed (${why}) after the Emergency instruction; the full result did not arrive. A physician must review it.`
          : `Live call failed (${why}). No saved run for this message; a physician must review it.`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- wiring ----------------------------------------------------------------

async function onRoute() {
  if (state.busy) return;
  const routed = currentTarget();
  if (routed.message.trim() === '') {
    setStatus('Type a message or pick a demo message first.', true);
    return;
  }
  setBusy(true);
  try {
    if (ui.replay.checked) {
      setStatus('');
      callSeq++;
      await showReplay(routed);
    } else {
      await routeLive(routed);
    }
  } finally {
    setBusy(false);
  }
}

function fillDemos() {
  ui.demo.replaceChildren(
    el('option', {value: '', text: 'Type your own message'}),
    ...state.demos.map(d => {
      const saved = state.manifest.some(m => m.id === d.id);
      return el('option', {
        value: d.id,
        text: saved ? d.label : `${d.label} (no saved run yet)`,
      });
    }),
  );
}

/** Drops the pinned live instruction once its demo or text is changed. */
function refreshPin() {
  state.pinned = pinFor(state.pinned, currentTarget());
}

function onDemoChange() {
  const demo = selectedDemo();
  ui.message.value = demo ? demo.message : '';
  refreshPin();
  setStatus('');
  if (ui.replay.checked && demo) onRoute();
}

async function init() {
  ui.viewPhysician.addEventListener('click', () => setView('physician'));
  ui.viewPatient.addEventListener('click', () => setView('patient'));
  ui.route.addEventListener('click', onRoute);
  ui.demo.addEventListener('change', onDemoChange);
  ui.replay.addEventListener('change', () => {
    updateReplayUi();
    setStatus('');
  });
  ui.saveToken.addEventListener('click', () => {
    sessionToken = ui.token.value.trim();
    writeToken(storage(), sessionToken);
    ui.token.value = '';
    setStatus(sessionToken ? 'Token saved in this browser.' : 'Token cleared.');
  });
  ui.clearToken.addEventListener('click', () => {
    sessionToken = '';
    ui.token.value = '';
    writeToken(storage(), '');
    setStatus('Token cleared.');
  });
  ui.message.addEventListener('input', () => {
    const demo = selectedDemo();
    if (demo && ui.message.value !== demo.message) ui.demo.value = '';
    refreshPin();
  });

  ui.replay.checked = !WORKER_URL;
  updateReplayUi();
  setView('physician');

  try {
    state.demos = await loadJson('demo-messages.json');
  } catch {
    state.demos = [];
    setStatus('Could not load the demo messages.', true);
  }
  try {
    state.manifest = await loadJson('replay/manifest.json');
  } catch {
    state.manifest = [];
  }
  fillDemos();
  const first =
    state.demos.find(d => state.manifest.some(m => m.id === d.id)) ??
    state.demos[0];
  if (first) {
    ui.demo.value = first.id;
    ui.message.value = first.message;
  }
  render();
  if (ui.replay.checked && first) await onRoute();
}

init();
