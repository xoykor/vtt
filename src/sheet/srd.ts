// SRD 5.1 monster import (pure mapping + cached fetch, hermetic).
// Maps JSON from Open5e (`armor_class: 15`) and the 5e SRD API
// (`armor_class: [{ value: 15 }]`) into `Sheet`. Cache is a local
// Map (no central server); art fields (`img`, `image`, ...) are
// dropped on import — no official WotC art is stored or fetched.

import type { AbilityScores, NormalizedRoll, Roll, Sheet } from "./types";

/** Minimal monster entry accepted from Open5e or the 5e SRD API. */
export interface SrdMonsterEntry {
  slug?: unknown;
  index?: unknown;
  name?: unknown;
  armor_class?: unknown;
  hit_points?: unknown;
  hit_dice?: unknown;
  strength?: unknown;
  dexterity?: unknown;
  constitution?: unknown;
  intelligence?: unknown;
  wisdom?: unknown;
  charisma?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Open5e uses a number; the 5e SRD API uses `[{ value }]`. */
function readArmorClass(value: unknown): number | undefined {
  const direct = asNumber(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested =
        typeof item === "object" && item !== null
          ? asNumber((item as Record<string, unknown>).value)
          : undefined;
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function readAbilities(entry: SrdMonsterEntry): AbilityScores | undefined {
  const abilities: AbilityScores = {
    str: asNumber(entry.strength) ?? 10,
    dex: asNumber(entry.dexterity) ?? 10,
    con: asNumber(entry.constitution) ?? 10,
    int: asNumber(entry.intelligence) ?? 10,
    wis: asNumber(entry.wisdom) ?? 10,
    cha: asNumber(entry.charisma) ?? 10,
  };
  const hasAny =
    asNumber(entry.strength) !== undefined ||
    asNumber(entry.dexterity) !== undefined ||
    asNumber(entry.constitution) !== undefined ||
    asNumber(entry.intelligence) !== undefined ||
    asNumber(entry.wisdom) !== undefined ||
    asNumber(entry.charisma) !== undefined;
  return hasAny ? abilities : undefined;
}

/**
 * Map an SRD monster entry to a `Sheet`. Pure: never fetches, never
 * stores art. Throws on missing `armor_class` / `hit_points`.
 */
export function importMonster(entry: SrdMonsterEntry): Sheet {
  if (entry === null || typeof entry !== "object") {
    throw new Error("missing monster entry");
  }
  const ac = readArmorClass(entry.armor_class);
  if (ac === undefined) throw new Error("missing field: armor_class");
  const hp = asNumber(entry.hit_points);
  if (hp === undefined) throw new Error("missing field: hit_points");
  const name = asNonEmptyString(entry.name) ?? "Unknown";
  const id =
    asNonEmptyString(entry.slug) ??
    asNonEmptyString(entry.index) ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sheet: Sheet = { id, name, ac, hp, maxHp: hp };
  const abilities = readAbilities(entry);
  if (abilities !== undefined) sheet.abilities = abilities;
  return sheet;
}

/** Local SRD cache: slug -> Sheet. Plain Map, no dependencies. */
export function createSrdCache(): Map<string, Sheet> {
  return new Map<string, Sheet>();
}

const OPEN5E_MONSTER_URL = "https://api.open5e.com/monsters/";

export interface FetchLike {
  (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/**
 * Fetch a monster by `slug` from Open5e (SRD 5.1), importing to a
 * `Sheet` and caching locally. `fetchFn` defaults to global fetch so
 * tests inject a stub (no real fetch in tests). Rejects on HTTP
 * failure; art fields never reach the Sheet (see `importMonster`).
 */
export async function fetchSrd(
  slug: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
  cache: Map<string, Sheet> = createSrdCache(),
): Promise<Sheet> {
  if (slug.length === 0) throw new Error("missing slug");
  const hit = cache.get(slug);
  if (hit !== undefined) return { ...hit };
  const res = await fetchFn(`${OPEN5E_MONSTER_URL}${slug}/`);
  if (!res.ok) throw new Error(`srd fetch failed: ${slug}`);
  const sheet = importMonster((await res.json()) as SrdMonsterEntry);
  cache.set(slug, { ...sheet });
  return { ...sheet };
}

/**
 * Normalize a dice request to a `NormalizedRoll` for Task 6:
 * `count` defaults to 1, `mod` defaults to 0. Pure: `dice` is not
 * mutated. Throws on non-positive-integer `sides` / `count`.
 */
export function rollRequest(dice: Roll): NormalizedRoll {
  if (dice === null || typeof dice !== "object") {
    throw new Error("missing dice");
  }
  if (!Number.isInteger(dice.sides) || dice.sides < 2) {
    throw new Error(`invalid sides: ${String(dice.sides)}`);
  }
  const count = dice.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`invalid count: ${String(dice.count)}`);
  }
  const mod = dice.mod ?? 0;
  if (typeof mod !== "number" || !Number.isFinite(mod)) {
    throw new Error(`invalid mod: ${String(dice.mod)}`);
  }
  return { sides: dice.sides, count, mod };
}

/** Encode a sheet as one JSON value for a RoomState partition. */
export function encodeSheet(sheet: Sheet): string {
  return JSON.stringify(sheet);
}

/** Decode a sheet from its RoomState JSON value. */
export function decodeSheet(json: string): Sheet {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("missing field: id");
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new Error("missing field: name");
  }
  if (typeof raw.ac !== "number") throw new Error("missing field: ac");
  if (typeof raw.hp !== "number") throw new Error("missing field: hp");
  if (typeof raw.maxHp !== "number") {
    throw new Error("missing field: maxHp");
  }
  return raw as unknown as Sheet;
}
