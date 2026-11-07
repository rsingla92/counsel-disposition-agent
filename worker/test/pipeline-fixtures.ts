import type {Level} from '../src/levels';
import {
  LlmError,
  type LlmClient,
  type LlmErrorCode,
  type LlmRequest,
  type ModelSpec,
} from '../src/llm';
import type {Deps} from '../src/pipeline';
import type {Sample} from '../src/schema';
import {fakeExtraction, policy20, sample, toWire, withFlags} from './fixtures';

// Synthetic messages only: the repo is public.
export const M = 'I have had a sore throat for two days. What should I do?';
export const REFILL_WITH_CHEST =
  'Could you refill my blood pressure pills please? Also my chest feels ' +
  'tight and the pressure is spreading into my left arm.';
export const SECRET_MSG =
  'SYNTHETIC-SECRET-7f3a: a mild itchy rash on my forearm since Tuesday.';

export const PRIMARY: ModelSpec = {model: 'test/primary', provider: 'test-a'};
export const SECONDARY: ModelSpec = {
  model: 'test/secondary',
  provider: 'test-b',
};

export type ScriptOpts = {
  /** Flags to mark; a present flag's excerpt is `excerpt`. */
  flags?: Record<string, 'present' | 'unknown'>;
  /** Excerpt for present flags and modifiers (default: the whole message). */
  excerpt?: string;
  /** Modifiers to mark present. */
  mods?: string[];
  /** The level every primary sample proposes (default routine). */
  samples?: Level;
  /** The i-th primary sample, in call order; overrides `samples`. */
  sampleFor?: (i: number) => Sample;
  /** The level every secondary sample proposes, or 'fail' (default: samples). */
  secondary?: Level | 'fail';
  /** Makes the extraction call fail with this LlmError code. */
  extractError?: LlmErrorCode;
  /**
   * Limits extractError to one model's extraction call: PRIMARY's for
   * 'primary', SECONDARY's for 'secondary'.
   */
  extractErrorOn?: 'primary' | 'secondary';
  /** The HTTP status carried by extractError. */
  extractStatus?: number;
  language?: string;
  care?: boolean;
  questions?: string[];
  photo?: boolean;
  /** How many primary sample calls fail with a timeout. */
  sampleFailures?: number;
  /** Every sample call waits on this before it settles. */
  samplesAwait?: Promise<unknown>;
  /** Called as each sample call settles. */
  onSample?: () => void;
};

/** The patient message inside a request's data delimiters. */
function messageOf(req: LlmRequest): string {
  const m = /^<patient_message>\n([\s\S]*)\n<\/patient_message>/.exec(req.user);
  if (!m) throw new Error('request has no patient_message block');
  return m[1];
}

/**
 * An LlmClient whose extraction call returns an extraction built from opts
 * and whose sample calls return samples. Counts and records every call.
 */
export function scripted(opts: ScriptOpts): LlmClient & {
  calls: number;
  requests: {schemaName: string; model: string}[];
  /** Each extraction request's rate-limit retry cap, in call order. */
  extractionRetries: (number | undefined)[];
} {
  const policy = policy20;
  let primarySamples = 0;
  const client = {
    calls: 0,
    requests: [] as {schemaName: string; model: string}[],
    extractionRetries: [] as (number | undefined)[],
    async complete(req: LlmRequest) {
      client.calls++;
      client.requests.push({schemaName: req.schemaName, model: req.spec.model});
      if (req.schemaName === 'extraction') {
        client.extractionRetries.push(req.maxRetries);
        const failsOn =
          opts.extractErrorOn === 'primary'
            ? PRIMARY
            : opts.extractErrorOn === 'secondary'
              ? SECONDARY
              : null;
        const failsHere = !failsOn || req.spec.model === failsOn.model;
        if (opts.extractError && failsHere) {
          throw new LlmError(
            opts.extractError,
            'scripted extraction failure',
            opts.extractStatus,
          );
        }
        const ex = withFlags(
          fakeExtraction(policy),
          opts.flags ?? {},
          opts.mods ?? [],
          opts.excerpt ?? messageOf(req),
        );
        ex.language = opts.language ?? 'en';
        ex.is_care_request = opts.care ?? true;
        ex.questions = opts.questions ?? [];
        ex.photo_needed = opts.photo ?? false;
        const json = toWire(ex);
        return {json, raw: JSON.stringify(json), latencyMs: 1};
      }
      const isPrimary = req.spec.model !== SECONDARY.model;
      const i = isPrimary ? primarySamples++ : -1;
      if (opts.samplesAwait) await opts.samplesAwait;
      opts.onSample?.();
      const level = isPrimary
        ? (opts.samples ?? 'routine')
        : (opts.secondary ?? opts.samples ?? 'routine');
      if (isPrimary && i < (opts.sampleFailures ?? 0)) {
        throw new LlmError('timeout', 'scripted timeout');
      }
      if (level === 'fail') throw new LlmError('timeout', 'scripted timeout');
      const json =
        isPrimary && opts.sampleFor ? opts.sampleFor(i) : sample(level);
      return {json, raw: JSON.stringify(json), latencyMs: 1};
    },
  };
  return client;
}

/** Deps around an LlmClient: no secondary model, a silent log. */
export function deps(llm: LlmClient): Deps {
  return {
    llm,
    policy: policy20,
    primary: PRIMARY,
    secondary: null,
    log: () => {},
  };
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return {promise, resolve};
}

/** Lets pending microtasks and one macrotask run. */
export function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
