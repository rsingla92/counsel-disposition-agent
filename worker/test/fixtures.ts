import {LEVELS, type Level} from '../src/levels';
import type {Policy} from '../src/policy';
import {emptyVotes, type Votes} from '../src/router';
import type {Extraction, RouteResult} from '../src/schema';

/** Votes with the given counts; levels not named get 0. */
export function v(partial: Partial<Votes>): Votes {
  return {...emptyVotes(), ...partial};
}

/** An extraction in which nothing is flagged. */
export function fakeExtraction(policy: Policy): Extraction {
  return {
    language: 'en',
    is_care_request: true,
    red_flags: Object.fromEntries(
      policy.red_flags.map(f => [f.id, {state: 'absent', excerpt: null}]),
    ),
    modifiers: Object.fromEntries(
      policy.modifiers.map(m => [m.id, {present: false, excerpt: null}]),
    ),
    questions: [],
    photo_needed: false,
    time_sensitive: false,
  } as Extraction;
}

function counts(top: Level, n: number): Record<Level, number> {
  return Object.fromEntries(LEVELS.map(l => [l, l === top ? n : 0])) as Record<
    Level,
    number
  >;
}

/** A RouteResult that passes the schema. */
export const validResult: RouteResult = {
  status: 'routed',
  disposition: 'routine',
  tier: 'async',
  brief_label: 'ASYNC_PHYSICIAN',
  floor: null,
  red_flags: [],
  modifiers: [],
  votes: {primary: counts('routine', 5), secondary: null},
  confidence: 1,
  human_review: {flagged: false, reasons: []},
  info_requests: {questions: [], photo: false},
  time_sensitive: false,
  justification: 'This looks routine. A physician will review it.',
  safety_net: 'Call your clinic if it gets worse.',
  patient_message: 'A physician will reply within a week.',
  trace: {
    input_sha256: 'a'.repeat(64),
    policy_version: '0.1.0',
    models: [{model: 'test-model', provider: 'test'}],
    latency_ms: 10,
    raw: null,
  },
};
