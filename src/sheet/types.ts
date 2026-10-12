// D&D sheet types (pure, hermetic). Sheet state travels as RoomState
// (Record<string, string>, one JSON sheet per key) so deltas apply via
// `applyDelta` from src/net/peer.ts (Task 2). No WotC art: sheets carry
// stats only, never image URLs.

export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** One inventory line: item name + quantity. */
export interface InventoryItem {
  id: string;
  name: string;
  qty: number;
}

/** Personality / ideals / bonds / flaws block (Roll20-style traits). */
export interface SheetTraits {
  personality: string;
  ideals: string;
  bonds: string;
  flaws: string;
}

/** One skill: name, governing ability, proficiency checkbox. */
export interface Skill {
  id: string;
  name: string;
  ability: keyof AbilityScores;
  proficient: boolean;
}

/** One saving throw: governing ability + proficiency checkbox. */
export interface Save {
  ability: keyof AbilityScores;
  proficient: boolean;
}

/** One condition: name, duration, effect. */
export interface Condition {
  id: string;
  name: string;
  duration: string;
  effect: string;
}

export interface Sheet {
  id: string;
  name: string;
  ac: number;
  hp: number;
  maxHp: number;
  /** Member that owns the sheet (`dm`, `p1`..`p5`); absent on SRD imports. */
  ownerId?: string;
  /** Character level (1-20); drives the derived proficiency bonus. */
  level?: number;
  /** Character class (e.g. "Guerreiro"), free text. */
  charClass?: string;
  /** Derived proficiency bonus (2 + floor((level-1)/4)), refreshed on level change. */
  profBonus?: number;
  abilities?: AbilityScores;
  /** Data URL of the portrait (uploaded locally, never fetched). */
  photo?: string;
  inventory?: InventoryItem[];
  traits?: SheetTraits;
  skills?: Skill[];
  saves?: Save[];
  conditions?: Condition[];
  notes?: string;
}

/**
 * Roll form, defined here. Task 6 accepts this same shape:
 * `sides` is required (die size, e.g. 20); `count` defaults to 1
 * (number of dice) and `mod` defaults to 0 (flat modifier).
 * `rollRequest` in src/sheet/srd.ts normalizes both.
 */
export interface Roll {
  sides: number;
  count?: number;
  mod?: number;
}

/** Normalized roll: defaults resolved, safe for Task 6 to consume. */
export interface NormalizedRoll {
  sides: number;
  count: number;
  mod: number;
}
