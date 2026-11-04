import {levelAtRank, maxLevel, rank, type Level} from './levels';
import type {Policy} from './policy';
import type {Extraction} from './schema';

export interface FloorResult {
  floor: Level;
  /** Present flag ids, in policy order. */
  drivers: string[];
  /** The first unsubsumed present modifier that raised the floor, if any. */
  modifier_applied: string | null;
  /** Present flags whose excerpt is null or not found in the message. */
  unverified: string[];
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `excerpt` appears verbatim in `message` after normalising both. */
export function verifyExcerpt(message: string, excerpt: string): boolean {
  const needle = normalise(excerpt);
  // An empty needle is a substring of everything; it verifies nothing.
  if (needle === '') return false;
  return normalise(message).includes(needle);
}

/**
 * The minimum disposition that red flags force, whatever the LLM says.
 * Pure: an unverified present flag still counts toward the floor.
 */
export function ruleFloor(
  ex: Extraction,
  message: string,
  policy: Policy,
): FloorResult {
  let floor: Level = 'self_care';
  const drivers: string[] = [];
  const unverified: string[] = [];
  const subsumed = new Set<string>();

  for (const flag of policy.red_flags) {
    const f = ex.red_flags[flag.id];
    if (f?.state !== 'present') continue;
    drivers.push(flag.id);
    floor = maxLevel(floor, flag.min_level);
    for (const m of flag.subsumes_modifiers) subsumed.add(m);
    if (f.excerpt === null || !verifyExcerpt(message, f.excerpt)) {
      unverified.push(flag.id);
    }
  }

  let modifierApplied: string | null = null;
  if (rank(floor) < rank(policy.modifier_cap)) {
    const mod = policy.modifiers.find(
      m => ex.modifiers[m.id]?.present === true && !subsumed.has(m.id),
    );
    if (mod) {
      modifierApplied = mod.id;
      floor = levelAtRank(rank(floor) + 1);
    }
  }

  return {
    floor,
    drivers,
    modifier_applied: modifierApplied,
    unverified,
  };
}
