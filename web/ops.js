// The Operations view: the experiment log, the router settings as sliders,
// a model picker, and the re-scored metrics with a confusion grid. The
// chosen settings feed live routes from the other views (liveOverrides).
import {appendAll, el, storage, warnIcon} from './dom.js';
import {
  EMERGENCY_WEIGHTS,
  GRID_STEPS,
  OVERRIDE_RANGES,
  SAMPLES,
  confusionGrid,
  controlsFromOverrides,
  delta,
  formatPercent,
  isWhatIf,
  levelLabel,
  liveOverrides,
  minTopVotes,
  overridesFromControls,
  overridesText,
  policyDefaults,
  resultsPanel,
  validStoredOverrides,
} from './lib.js';

const OVERRIDES_KEY = 'counsel-demo-overrides';
const EXPERIMENT_KEY = 'counsel-demo-experiment';
const RESCORE_DEBOUNCE_MS = 250;

export const WHAT_IF_TEXT =
  'What-if only: live messages use the policy value for emergency weights';

const MODEL_OPTIONS = [
  {value: 'policy', label: 'Policy default', hint: 'Sonnet 5.5 with Gemini 3.8 Flash as a cross-check'},
  {value: 'sonnet', label: 'Sonnet 5.5 only', hint: 'One model, no cross-check'},
  {value: 'flash', label: 'Gemini 3.8 Flash only', hint: 'One model, no cross-check'},
  {value: 'sonnet+flash', label: 'Sonnet 5.5 + Flash', hint: 'Both models, as deployed'},
];

/** Short column heads for the grid; full names are in the readout and table. */
const SHORT_LEVELS = {
  call_911: '911',
  ed_now: 'ED',
  in_person_today: 'In person',
  physician_contact_today: 'Phys. today',
  within_few_days: 'Few days',
  routine: 'Routine',
  self_care: 'Self-care',
  human_review: 'Human review',
};

function readJson(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value === null || value === undefined) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage: the settings last for this page only.
  }
}

function seconds(ms) {
  if (!Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Builds the view into `root`. `getToken` returns the access token,
 * `onChange` runs whenever the live overrides may have changed, and
 * `onNeedToken` sends the user to the token box.
 */
export function createOps({root, workerUrl, getToken, onChange, onNeedToken}) {
  const s = {
    loaded: false,
    loading: false,
    problem: null,
    policy: null,
    boundaries: [],
    experiments: [],
    selected: null,
    overrides: null,
    controls: null,
    baseline: new Map(),
    summary: null,
    base: null,
    rescoring: false,
    rescoreError: '',
    seq: 0,
    timer: null,
    readout: '',
  };

  const header = el('div', {class: 'ops-head'});
  const logCard = el('section', {class: 'card ops-log', 'aria-labelledby': 'ops-log-h'});
  const controlsCard = el('section', {class: 'card ops-controls', 'aria-labelledby': 'ops-controls-h'});
  const resultsCard = el('section', {class: 'card ops-results', 'aria-labelledby': 'ops-results-h', 'aria-busy': 'false'});
  const body = el('div', {class: 'ops-body'}, controlsCard, resultsCard);

  async function api(path, init = {}) {
    try {
      const res = await fetch(`${workerUrl}${path}`, {
        ...init,
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`},
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return {ok: res.ok, status: res.status, data};
    } catch {
      return {ok: false, status: 0, data: null};
    }
  }

  function problemFor(status, what) {
    if (status === 401) return 'The access token was rejected. Enter it again in the Physician view.';
    if (status === 0) return `Could not reach the Worker to load ${what}.`;
    return `Could not load ${what} (HTTP ${status}).`;
  }

  // --- state changes ---------------------------------------------------------

  function selectedExperiment() {
    return s.experiments.find(e => e.id === s.selected) ?? null;
  }

  function setControls(controls) {
    s.controls = controls;
    s.overrides = overridesFromControls(controls, s.policy);
    writeJson(OVERRIDES_KEY, s.overrides);
    onChange();
  }

  function scheduleRescore() {
    clearTimeout(s.timer);
    s.timer = setTimeout(rescore, RESCORE_DEBOUNCE_MS);
  }

  async function baselineFor(exp) {
    if (s.baseline.has(exp.id)) return s.baseline.get(exp.id);
    const res = await api(`/v1/experiments/${encodeURIComponent(exp.id)}/rescore`, {
      method: 'POST',
      body: JSON.stringify({policy: {}}),
    });
    if (!res.ok) return {error: res.status};
    s.baseline.set(exp.id, res.data.summary);
    return res.data.summary;
  }

  async function rescore() {
    clearTimeout(s.timer);
    const exp = selectedExperiment();
    const seq = ++s.seq;
    s.rescoreError = '';
    if (!exp) {
      s.summary = null;
      s.base = null;
      renderResults();
      return;
    }
    if (!exp.rescorable) {
      s.summary = exp.summary;
      s.base = null;
      s.rescoring = false;
      renderResults();
      return;
    }
    s.rescoring = true;
    renderResults();
    const base = await baselineFor(exp);
    let summary = null;
    let error = base?.error ?? null;
    if (!error) {
      const policy = s.overrides?.policy ?? {};
      if (Object.keys(policy).length === 0) {
        summary = base;
      } else {
        const res = await api(`/v1/experiments/${encodeURIComponent(exp.id)}/rescore`, {
          method: 'POST',
          body: JSON.stringify({policy}),
        });
        if (res.ok) summary = res.data.summary;
        else error = res.status;
      }
    }
    if (seq !== s.seq) return;
    s.rescoring = false;
    if (error) {
      s.rescoreError =
        error === 404
          ? 'This run is no longer stored on the Worker.'
          : error === 409
            ? 'This run cannot be re-scored.'
            : error === 400
              ? 'The Worker rejected these settings.'
              : error === 401
                ? 'The access token was rejected.'
                : error === 0
                  ? 'The Worker could not be reached.'
                  : `The Worker returned an error (HTTP ${error}).`;
      // Never leave the previous numbers under settings they do not match.
      s.summary = null;
      s.base = null;
    } else {
      s.summary = summary;
      s.base = base;
    }
    renderResults();
  }

  function select(id) {
    if (s.selected === id) return;
    s.selected = id;
    writeJson(EXPERIMENT_KEY, id);
    s.summary = null;
    s.base = null;
    renderLog();
    renderControls();
    rescore();
  }

  function reset() {
    setControls(controlsFromOverrides(null, s.policy));
    renderControls();
    rescore();
  }

  function clearOverrides() {
    if (!s.policy) return;
    reset();
  }

  async function load() {
    if (s.loading) return;
    if (!workerUrl) {
      s.problem = 'No Worker is configured, so the Operations view is unavailable.';
      render();
      return;
    }
    if (!getToken()) {
      s.problem = 'token';
      render();
      return;
    }
    s.loading = true;
    s.problem = null;
    render();
    const pol = await api('/v1/policy');
    const defaults = pol.ok ? policyDefaults(pol.data) : null;
    if (!defaults) {
      s.loading = false;
      s.problem = pol.ok
        ? 'The Worker did not return the policy settings.'
        : problemFor(pol.status, 'the policy');
      render();
      return;
    }
    s.policy = defaults;
    s.boundaries = pol.data.loss.boundaries.map(b => b.between);
    const stored = readJson(OVERRIDES_KEY);
    s.overrides = validStoredOverrides(stored, s.policy);
    // Settings saved under an older policy that no longer validate are
    // dropped, so a live route never 400s on them.
    if (stored && !s.overrides) writeJson(OVERRIDES_KEY, null);
    s.controls = controlsFromOverrides(s.overrides, s.policy);
    onChange();

    const exps = await api('/v1/experiments');
    s.loading = false;
    s.loaded = true;
    s.experiments = exps.ok && Array.isArray(exps.data?.experiments) ? exps.data.experiments : [];
    s.problem = exps.ok ? null : problemFor(exps.status, 'the experiment log');
    const want = readJson(EXPERIMENT_KEY);
    s.selected =
      (s.experiments.find(e => e.id === want) ??
        s.experiments.find(e => e.rescorable) ??
        s.experiments[0])?.id ?? null;
    s.baseline.clear();
    render();
    rescore();
  }

  // --- rendering ---------------------------------------------------------------

  function whatIfLine() {
    return el(
      'p',
      {class: 'warn-line', role: 'note'},
      warnIcon(),
      el('span', {text: WHAT_IF_TEXT}),
    );
  }

  function renderHeader() {
    header.replaceChildren(
      el('h2', {class: 'ops-title', text: 'How the agent is set up'}),
      el('p', {
        class: 'note',
        text: 'Saved evaluation runs, the router settings, and what changes when a setting moves. Settings here are a what-if for this browser; they never change the deployed policy.',
      }),
    );
  }

  function renderLog() {
    const focused = document.activeElement?.dataset?.exp ?? null;
    logCard.replaceChildren(el('h2', {class: 'eyebrow', id: 'ops-log-h', text: 'Experiment log'}));
    if (s.experiments.length === 0) {
      appendAll(
        logCard,
        el('p', {class: 'empty', text: s.loading ? 'Loading saved runs…' : 'No saved runs on the Worker yet.'}),
      );
      return;
    }
    const rows = s.experiments.map(e => {
      const sum = e.summary ?? {};
      const chosen = e.id === s.selected;
      const button = el(
        'button',
        {
          type: 'button',
          class: 'exp-pick',
          'aria-pressed': String(chosen),
          'data-exp': e.id,
          onclick: ev => {
            ev.stopPropagation();
            select(e.id);
          },
        },
        el('span', {class: 'exp-label', text: e.label}),
        e.rescorable ? null : el('span', {class: 'exp-tag', text: 'not re-scorable'}),
      );
      return el(
        'tr',
        {class: chosen ? 'selected' : null, onclick: () => select(e.id)},
        el('th', {scope: 'row'}, button),
        el('td', {'data-label': 'Missed', text: Number.isFinite(sum.missed) ? `${sum.missed} of ${sum.emergencies}` : '—'}),
        el('td', {'data-label': 'Human review', text: formatPercent(sum.human_review_rate)}),
        el('td', {'data-label': 'Cost', text: Number.isFinite(sum.cost_score) ? sum.cost_score.toFixed(2) : '—'}),
        el('td', {'data-label': 'Median time', text: seconds(e.median_latency_ms)}),
      );
    });
    appendAll(
      logCard,
      el('p', {class: 'note', text: 'One row per saved 50-case run, as recorded. Pick a run to re-score it below.'}),
      el(
        'div',
        {class: 'table-scroll'},
        el(
          'table',
          {class: 'exp-table'},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {scope: 'col', text: 'Condition'}),
              el('th', {scope: 'col', text: 'Missed emergencies'}),
              el('th', {scope: 'col', text: 'Human review'}),
              el('th', {scope: 'col', text: 'Cost score'}),
              el('th', {scope: 'col', text: 'Median time'}),
            ),
          ),
          el('tbody', {}, rows),
        ),
      ),
    );
    if (focused) logCard.querySelector(`[data-exp="${CSS.escape(focused)}"]`)?.focus();
  }

  function slider({id, label, field, index, range, format, hint, disabled}) {
    const value = index === undefined ? s.controls[field] : s.controls.under_weights[index];
    const policyValue = index === undefined ? s.policy[field] : s.policy.under_weights[index];
    const emergency = index !== undefined && EMERGENCY_WEIGHTS.includes(index);
    const output = el('output', {for: id, class: 'slider-value'});
    const hintEl = el('p', {class: 'note slider-hint', id: `${id}-hint`});
    const input = el('input', {
      type: 'range',
      id,
      min: range.min,
      max: range.max,
      step: range.step,
      value,
      disabled,
      'aria-describedby': `${id}-hint`,
    });
    const wrap = el(
      'div',
      {class: 'slider'},
      el(
        'div',
        {class: 'slider-head'},
        el('label', {for: id}, label, emergency ? el('span', {class: 'guard-tag', text: 'Emergency guard'}) : null),
        output,
      ),
      input,
      hintEl,
    );
    const paint = v => {
      output.textContent = format(v);
      const below = emergency && v < policyValue;
      wrap.classList.toggle('changed', v !== policyValue);
      wrap.classList.toggle('whatif', below);
      hintEl.replaceChildren(
        ...(below
          ? [warnIcon(), `What-if only. Live messages use the policy value, ${format(policyValue)}.`]
          : [`Policy ${format(policyValue)}.${hint ? ` ${hint}` : ''}`]),
      );
    };
    paint(value);
    input.addEventListener('input', () => {
      let v = Number(input.value);
      if (range.step < 1) v = Math.round(v / range.step) * range.step;
      v = Number(v.toFixed(2));
      const next = {...s.controls, under_weights: [...s.controls.under_weights]};
      if (index === undefined) next[field] = v;
      else next.under_weights[index] = v;
      if (field === 'min_valid') {
        // Agreement must stay a majority of the valid samples.
        const floor = minTopVotes(v);
        const top = controlsCard.querySelector('#ops-min_top_votes');
        if (top) top.min = String(floor);
        if (next.min_top_votes < floor) {
          next.min_top_votes = floor;
          if (top) {
            top.value = String(floor);
            top.dispatchEvent(new Event('repaint'));
          }
        }
      }
      paint(v);
      setControls(next);
      updateWhatIf();
      scheduleRescore();
    });
    input.addEventListener('repaint', () => paint(Number(input.value)));
    return wrap;
  }

  function updateWhatIf() {
    const slot = controlsCard.querySelector('.whatif-slot');
    if (slot) slot.replaceChildren(...(isWhatIf(s.overrides, s.policy) ? [whatIfLine()] : []));
    const next = controlsCard.querySelector('.next-live');
    if (next) next.replaceChildren(...nextLiveText());
  }

  function nextLiveText() {
    const live = liveOverrides(s.overrides, s.policy);
    const text = overridesText(live);
    return [
      el('strong', {text: 'Next live message uses: '}),
      text ?? 'the deployed policy, unchanged',
      s.overrides?.policy?.human_review_cost !== undefined
        ? el('span', {class: 'note', text: '. The review cost only changes re-scoring.'})
        : null,
    ];
  }

  function renderControls() {
    controlsCard.replaceChildren(el('h2', {class: 'eyebrow', id: 'ops-controls-h', text: 'Settings'}));
    if (!s.policy) return;
    const exp = selectedExperiment();
    const locked = exp ? !exp.rescorable : true;

    const models = el(
      'fieldset',
      {class: 'model-pick'},
      el('legend', {text: 'Models for live messages'}),
      MODEL_OPTIONS.map(o =>
        el(
          'label',
          {class: 'radio'},
          el('input', {
            type: 'radio',
            name: 'ops-models',
            value: o.value,
            checked: s.controls.models === o.value,
            onchange: () => {
              setControls({...s.controls, models: o.value});
              updateWhatIf();
            },
          }),
          el('span', {}, el('span', {class: 'radio-label', text: o.label}), el('span', {class: 'note', text: o.hint})),
        ),
      ),
      el('p', {
        class: 'note',
        text: 'Re-scoring uses each run’s saved votes, so the model choice does not change the numbers on the right. To compare models, pick a run in the log.',
      }),
    );

    const fmtInt = v => String(v);
    const fmtCost = v => v.toFixed(2);
    const fmtWeight = v => `${v}×`;
    const sliders = [
      slider({
        id: 'ops-min_top_votes',
        label: 'Agreement needed to route',
        field: 'min_top_votes',
        range: {...OVERRIDE_RANGES.min_top_votes, min: minTopVotes(s.controls.min_valid)},
        format: v => `${v} of ${SAMPLES} votes`,
        hint: 'Fewer agreeing votes than this flags the case for a physician.',
        disabled: locked,
      }),
      slider({
        id: 'ops-min_valid',
        label: 'Valid samples needed',
        field: 'min_valid',
        range: OVERRIDE_RANGES.min_valid,
        format: v => `${v} of ${SAMPLES}`,
        hint: 'Fewer valid answers than this sends the case to Human review.',
        disabled: locked,
      }),
      slider({
        id: 'ops-max_span',
        label: 'Widest vote spread allowed',
        field: 'max_span',
        range: OVERRIDE_RANGES.max_span,
        format: v => plural(v, 'level', 'levels'),
        hint: 'Votes spread wider than this flag the case.',
        disabled: locked,
      }),
      slider({
        id: 'ops-human_review_cost',
        label: 'Cost of a physician review',
        field: 'human_review_cost',
        range: OVERRIDE_RANGES.human_review_cost,
        format: fmtCost,
        hint: 'Re-scoring only: it prices each flagged case in the cost score.',
        disabled: locked,
      }),
    ];
    const weights = el(
      'fieldset',
      {class: 'weights', disabled: locked},
      el('legend', {text: 'Under-triage weights'}),
      el('p', {
        class: 'note',
        text: 'How much worse routing one level too low is than one level too high, at each boundary. The two emergency guards can go lower here as a what-if only.',
      }),
      el('div', {class: 'whatif-slot'}),
      s.boundaries.map((between, i) =>
        slider({
          id: `ops-under-${i}`,
          label: `${levelLabel(between[0])} ↔ ${levelLabel(between[1])}`,
          field: 'under_weights',
          index: i,
          range: OVERRIDE_RANGES.under_weight,
          format: fmtWeight,
          hint: EMERGENCY_WEIGHTS.includes(i) ? 'Live routes can raise it, never lower it.' : '',
          disabled: locked,
        }),
      ),
    );

    appendAll(
      controlsCard,
      models,
      el('h3', {class: 'subhead', text: 'Router thresholds'}),
      locked
        ? el('p', {
            class: 'note locked',
            text: 'This run is the rule floor alone: it has no votes to re-score, so the sliders are locked. Settings already chosen still apply to live messages. Pick another run to use the sliders.',
          })
        : null,
      sliders,
      weights,
      el(
        'dl',
        {class: 'fixed'},
        el('dt', {text: 'Samples per model'}),
        el('dd', {text: `${SAMPLES}, fixed. Changing it needs a new run.`}),
        el('dt', {text: 'Red-flag floors'}),
        el('dd', {text: 'Fixed. A red flag always sets at least its minimum level.'}),
      ),
      el('p', {class: 'next-live'}),
      el('div', {class: 'row'}, el('button', {type: 'button', class: 'secondary', text: 'Reset to policy', onclick: reset})),
    );
    updateWhatIf();
  }

  function metric({label, now, base, kind, unit, warn, note}) {
    const value =
      kind === 'percent'
        ? formatPercent(now)
        : kind === 'decimal'
          ? Number.isFinite(now)
            ? now.toFixed(2)
            : '—'
          : String(now ?? '—');
    return el(
      'div',
      {class: `metric${warn?.length ? ' warn' : ''}`},
      el('p', {class: 'metric-label', text: label}),
      el('p', {class: 'metric-value'}, value, unit ? el('span', {class: 'metric-unit', text: unit}) : null),
      base === null || base === undefined
        ? el('p', {class: 'metric-delta', text: note ?? 'As recorded'})
        : el('p', {class: 'metric-delta'}, el('span', {class: 'delta-key', text: 'Policy → now: '}), delta(now, base, kind)),
      (warn ?? []).map(w => el('p', {class: 'warn-line'}, warnIcon(), el('span', {text: w}))),
    );
  }

  function moveFocus(grid, ev) {
    const cells = [...grid.querySelectorAll('.cm-cell')];
    const at = cells.indexOf(document.activeElement);
    if (at === -1) return;
    const cols = 8;
    const step = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols}[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    const next = cells[at + step];
    if (!next) return;
    cells[at].tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }

  function cellText(row, cell) {
    const base =
      cell.base === null || cell.base === cell.count ? '' : ` (deployed policy: ${cell.base})`;
    return `Reference ${row.label}, routed ${cell.label}: ${plural(cell.count, 'case', 'cases')}${base}`;
  }

  function confusionBlock(summary, base) {
    const g = confusionGrid(summary?.confusion, base?.confusion);
    const readout = el('p', {class: 'cm-readout', 'aria-hidden': 'true', text: s.readout || 'Hover or focus a cell to read it.'});
    const show = text => {
      s.readout = text;
      readout.textContent = text;
    };
    const grid = el('div', {
      class: 'cm',
      role: 'grid',
      'aria-label': 'Confusion grid: reference level by routed level',
      onkeydown: ev => moveFocus(grid, ev),
    });
    grid.append(
      el(
        'div',
        {role: 'row', class: 'cm-row'},
        el('span', {role: 'columnheader', class: 'cm-corner', text: 'Reference ↓ · Routed →'}),
        g.columns.map(c =>
          el('span', {role: 'columnheader', class: 'cm-col', title: c.label, text: SHORT_LEVELS[c.key]}),
        ),
      ),
    );
    let first = true;
    for (const r of g.rows) {
      grid.append(
        el(
          'div',
          {role: 'row', class: 'cm-row'},
          el('span', {role: 'rowheader', class: 'cm-rowhead', text: r.label}),
          r.cells.map(c => {
            const text = cellText(r, c);
            const node = el(
              'span',
              {
                role: 'gridcell',
                class: `cm-cell s${c.step}${c.diagonal ? ' diag' : ''}`,
                tabindex: first ? '0' : '-1',
                'aria-label': text,
                onmouseenter: () => show(text),
                onfocus: () => show(text),
              },
              c.count > 0 ? String(c.count) : '',
            );
            first = false;
            return node;
          }),
        ),
      );
    }
    const legend = el(
      'div',
      {class: 'cm-legend', 'aria-hidden': 'true'},
      el('span', {text: 'Cases: 1'}),
      Array.from({length: GRID_STEPS}, (_, i) => el('span', {class: `cm-swatch s${i + 1}`})),
      el('span', {text: String(Math.max(g.max, 1))}),
      el('span', {class: 'cm-key-diag'}),
      el('span', {text: 'Outlined: routed at the reference level'}),
    );
    const table = el(
      'table',
      {class: 'cm-table'},
      el(
        'thead',
        {},
        el('tr', {}, el('th', {scope: 'col', text: 'Reference \\ Routed'}), g.columns.map(c => el('th', {scope: 'col', text: c.label}))),
      ),
      el(
        'tbody',
        {},
        g.rows.map(r =>
          el(
            'tr',
            {},
            el('th', {scope: 'row', text: r.label}),
            r.cells.map(c =>
              el('td', {
                text:
                  c.base === null || c.base === c.count ? String(c.count) : `${c.count} (was ${c.base})`,
              }),
            ),
          ),
        ),
      ),
    );
    return [
      el('h3', {class: 'subhead', text: 'Where each case landed'}),
      el('p', {
        class: 'note',
        text: 'Rows: the reference level. Columns: where the agent routed it. Right of the outlined cell is routed less urgent than the reference; left of it, more urgent.',
      }),
      legend,
      el('div', {class: 'cm-scroll'}, grid),
      el('p', {class: 'note cm-scroll-hint', text: 'Scroll the grid sideways to see every column.'}),
      readout,
      el('details', {class: 'votes-details'}, el('summary', {text: 'Show as table'}), el('div', {class: 'table-scroll'}, table)),
    ];
  }

  function renderResults() {
    const panel = resultsPanel({summary: s.summary, error: s.rescoreError, rescoring: s.rescoring});
    resultsCard.setAttribute('aria-busy', String(s.rescoring));
    resultsCard.classList.toggle('busy', panel.busy === true);
    const exp = selectedExperiment();
    resultsCard.replaceChildren(el('h2', {class: 'eyebrow', id: 'ops-results-h', text: 'Results on the saved run'}));
    if (!exp) {
      appendAll(resultsCard, el('p', {class: 'empty', text: 'Pick a run in the log.'}));
      return;
    }
    const whatIf = isWhatIf(s.overrides, s.policy) && exp.rescorable;
    appendAll(
      resultsCard,
      el('p', {class: 'run-name', text: exp.label}),
      el('p', {
        class: 'note',
        text: exp.rescorable
          ? 'Changes are against the deployed policy re-scored on the same run.'
          : 'Not re-scorable: the numbers are as recorded.',
      }),
      whatIf ? whatIfLine() : null,
    );
    if (panel.kind === 'error') {
      appendAll(
        resultsCard,
        el('p', {class: 'warn-line rescore-failed', role: 'alert'}, warnIcon(), el('span', {text: panel.text})),
      );
      return;
    }
    if (panel.kind !== 'metrics') {
      appendAll(resultsCard, el('p', {class: 'empty', text: panel.text}));
      return;
    }
    const sum = panel.summary;
    const base = s.base;
    const missedWarn = [];
    if (whatIf) missedWarn.push('What-if only: emergency weights are below the policy');
    if (sum.missed > 0) missedWarn.push(`${plural(sum.missed, 'emergency', 'emergencies')} routed below ED now`);
    appendAll(
      resultsCard,
      el(
        'div',
        {class: 'metrics'},
        metric({
          label: 'Missed emergencies',
          now: sum.missed,
          base: base?.missed,
          kind: 'count',
          unit: ` of ${sum.emergencies}`,
          warn: missedWarn,
        }),
        metric({label: 'Human review', now: sum.human_review_rate, base: base?.human_review_rate, kind: 'percent'}),
        metric({label: 'Flagged for physician review', now: sum.flagged_rate, base: base?.flagged_rate, kind: 'percent'}),
        metric({label: 'Over-triage', now: sum.over_triage_rate, base: base?.over_triage_rate, kind: 'percent'}),
        metric({label: 'Cost score (lower is better)', now: sum.cost_score, base: base?.cost_score, kind: 'decimal'}),
      ),
      confusionBlock(sum, base),
    );
  }

  function render() {
    renderHeader();
    if (s.problem) {
      const token = s.problem === 'token';
      root.replaceChildren(
        header,
        el(
          'section',
          {class: 'card'},
          el('p', {
            class: token ? 'empty' : 'status error',
            text: token ? 'The Operations view reads saved runs from the Worker. Enter the access token first.' : s.problem,
          }),
          el(
            'div',
            {class: 'row'},
            token
              ? el('button', {type: 'button', class: 'primary', text: 'Enter access token', onclick: onNeedToken})
              : el('button', {type: 'button', class: 'secondary', text: 'Try again', onclick: () => load()}),
          ),
        ),
      );
      return;
    }
    if (!s.loaded) {
      root.replaceChildren(header, el('section', {class: 'card'}, el('p', {class: 'empty', text: 'Loading the policy and saved runs…'})));
      return;
    }
    root.replaceChildren(header, logCard, body);
    renderLog();
    renderControls();
    renderResults();
  }

  return {
    load,
    /** Loads on first show, or after a problem. */
    show() {
      if (!s.loaded || s.problem) load();
    },
    /** What a live route sends: clamped, without the re-score-only field. */
    liveOverrides: () => liveOverrides(s.overrides, s.policy),
    whatIf: () => isWhatIf(s.overrides, s.policy),
    clearOverrides,
  };
}
