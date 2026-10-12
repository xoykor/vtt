// SRD 5.1 monster import (pure mapping + cached fetch, hermetic).
// Maps JSON from Open5e (`armor_class: 15`) and the 5e SRD API
// (`armor_class: [{ value: 15 }]`) into `Sheet`. Cache is a local
// Map (no central server); art fields (`img`, `image`, ...) are
// dropped on import — no official WotC art is stored or fetched.

import type {
  AbilityScores,
  Attack,
  DeathSaves,
  Money,
  NormalizedRoll,
  Roll,
  Sheet,
  Spell,
  SpellSlot,
} from "./types";

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

/** Deep-clone a Sheet (arrays and blocks are cloned, never shared). */
function cloneSheet(sheet: Sheet): Sheet {
  return structuredClone(sheet);
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
  if (hit !== undefined) return cloneSheet(hit);
  const res = await fetchFn(`${OPEN5E_MONSTER_URL}${slug}/`);
  if (!res.ok) throw new Error(`srd fetch failed: ${slug}`);
  const sheet = importMonster((await res.json()) as SrdMonsterEntry);
  cache.set(slug, cloneSheet(sheet));
  return cloneSheet(sheet);
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

/** Decode a sheet from its RoomState JSON value. Validates the 6 ability fields when `abilities` is present. */
export function decodeSheet(json: string): Sheet {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("missing field: id");
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new Error("missing field: name");
  }
  // Stats tolerantes p/ metadados (viewers): ausente = 0 (redacted);
  // presente mas não-número = erro (nunca mascara corrupção).
  let ac = 0;
  let hp = 0;
  let maxHp = 0;
  if (raw.ac === undefined) ac = 0;
  else if (typeof raw.ac === "number" && Number.isFinite(raw.ac)) ac = raw.ac;
  else throw new Error("missing field: ac");
  if (raw.hp === undefined) hp = 0;
  else if (typeof raw.hp === "number" && Number.isFinite(raw.hp)) hp = raw.hp;
  else throw new Error("missing field: hp");
  if (raw.maxHp === undefined) maxHp = 0;
  else if (typeof raw.maxHp === "number" && Number.isFinite(raw.maxHp))
    maxHp = raw.maxHp;
  else throw new Error("missing field: maxHp");
  const sheet: Sheet = {
    id: raw.id,
    name: raw.name,
    ac,
    hp,
    maxHp,
  };
  if (typeof raw.ownerId === "string" && raw.ownerId.length > 0) {
    sheet.ownerId = raw.ownerId;
  }
  if (typeof raw.level === "number" && Number.isFinite(raw.level)) {
    sheet.level = raw.level;
  }
  if (typeof raw.charClass === "string") {
    sheet.charClass = raw.charClass;
  }
  if (typeof raw.profBonus === "number" && Number.isFinite(raw.profBonus)) {
    sheet.profBonus = raw.profBonus;
  }
  if (raw.abilities !== undefined) {
    const ab = raw.abilities as Record<string, unknown> | null;
    if (typeof ab !== "object" || ab === null) {
      throw new Error("missing field: abilities");
    }
    for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) {
      if (typeof ab[key] !== "number" || !Number.isFinite(ab[key] as number)) {
        throw new Error(`missing field: abilities.${key}`);
      }
    }
    sheet.abilities = {
      str: ab.str as number,
      dex: ab.dex as number,
      con: ab.con as number,
      int: ab.int as number,
      wis: ab.wis as number,
      cha: ab.cha as number,
    };
  }
  // Free-text header/bio fields: copied when present as strings.
  for (const key of [
    "photo",
    "notes",
    "race",
    "alignment",
    "languages",
    "backstory",
    "gmNotes",
  ] as const) {
    if (typeof raw[key] === "string") sheet[key] = raw[key] as string;
  }
  // ACL dupla (tolerante: ignora entradas não-string, nunca quebra sync).
  for (const key of ["viewers", "controllers"] as const) {
    if (Array.isArray(raw[key])) {
      const ids = (raw[key] as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      sheet[key] = ids;
    }
  }
  if (typeof raw.publicView === "boolean") sheet.publicView = raw.publicView;
  if (typeof raw.publicControl === "boolean")
    sheet.publicControl = raw.publicControl;
  // Numeric combat fields: copied when finite.
  for (const key of ["xp", "speed", "initiativeMisc", "tempHp"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) {
      sheet[key] = raw[key] as number;
    }
  }
  if (typeof raw.inspiration === "boolean") sheet.inspiration = raw.inspiration;
  const saves = readDeathSaves(raw.deathSaves);
  if (saves !== undefined) sheet.deathSaves = saves;
  const attacks = readAttacks(raw.attacks);
  if (attacks !== undefined) sheet.attacks = attacks;
  const spells = readSpells(raw.spells);
  if (spells !== undefined) sheet.spells = spells;
  const slots = readSpellSlots(raw.spellSlots);
  if (slots !== undefined) sheet.spellSlots = slots;
  const money = readMoney(raw.money);
  if (money !== undefined) sheet.money = money;
  // Pre-existing collections (inventory/skills/saves/conditions/traits):
  // decoded tolerantly so one odd entry never bricks the table sync.
  const inventory = readInventory(raw.inventory);
  if (inventory !== undefined) sheet.inventory = inventory;
  const skills = readSkills(raw.skills);
  if (skills !== undefined) sheet.skills = skills;
  const savesList = readSaves(raw.saves);
  if (savesList !== undefined) sheet.saves = savesList;
  const conditions = readConditions(raw.conditions);
  if (conditions !== undefined) sheet.conditions = conditions;
  const traits = readTraits(raw.traits);
  if (traits !== undefined) sheet.traits = traits;
  return sheet;
}

/** Tolerant record reader: object or nothing (never throws). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteProp(
  rec: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stringProp(
  rec: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

/** Valid death-saves block, or undefined when absent/malformed. */
function readDeathSaves(value: unknown): DeathSaves | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const successes = finiteProp(rec, "successes");
  const failures = finiteProp(rec, "failures");
  return successes === undefined || failures === undefined
    ? undefined
    : { successes, failures };
}

/** Valid attacks, or undefined when the value is not a list. Entries missing name/bonus/damage are skipped. */
function readAttacks(value: unknown): Attack[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Attack[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringProp(rec, "id");
    const name = stringProp(rec, "name");
    const bonus = finiteProp(rec, "bonus");
    const damage = stringProp(rec, "damage");
    if (!id || !name || bonus === undefined || damage === undefined) continue;
    out.push({ id, name, bonus, damage });
  }
  return out;
}

/** Valid spells, or undefined when the value is not a list. */
function readSpells(value: unknown): Spell[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Spell[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringProp(rec, "id");
    const name = stringProp(rec, "name");
    const level = finiteProp(rec, "level");
    if (!id || !name || level === undefined) continue;
    out.push({ id, name, level });
  }
  return out;
}

/** Valid spell slots, or undefined when the value is not a list. */
function readSpellSlots(value: unknown): SpellSlot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SpellSlot[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const level = finiteProp(rec, "level");
    const total = finiteProp(rec, "total");
    const used = finiteProp(rec, "used");
    if (level === undefined || total === undefined || used === undefined) {
      continue;
    }
    out.push({ level, total, used });
  }
  return out;
}

/** Valid coin purse, or undefined when absent/malformed. */
function readMoney(value: unknown): Money | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const cp = finiteProp(rec, "cp");
  const sp = finiteProp(rec, "sp");
  const ep = finiteProp(rec, "ep");
  const gp = finiteProp(rec, "gp");
  const pp = finiteProp(rec, "pp");
  return cp === undefined ||
    sp === undefined ||
    ep === undefined ||
    gp === undefined ||
    pp === undefined
    ? undefined
    : { cp, sp, ep, gp, pp };
}

/** Valid inventory lines (bad entries skipped). */
function readInventory(
  value: unknown,
): import("./types").InventoryItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("./types").InventoryItem[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringProp(rec, "id");
    const name = stringProp(rec, "name");
    const qty = finiteProp(rec, "qty");
    if (!id || !name || qty === undefined) continue;
    out.push({ id, name, qty });
  }
  return out;
}

/** Valid skill rows (bad entries skipped). */
function readSkills(value: unknown): import("./types").Skill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("./types").Skill[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringProp(rec, "id");
    const name = stringProp(rec, "name");
    const ability = stringProp(rec, "ability");
    const proficient = rec.proficient;
    if (
      !id ||
      !name ||
      (ability !== "str" &&
        ability !== "dex" &&
        ability !== "con" &&
        ability !== "int" &&
        ability !== "wis" &&
        ability !== "cha") ||
      typeof proficient !== "boolean"
    ) {
      continue;
    }
    out.push({ id, name, ability, proficient });
  }
  return out;
}

/** Valid save rows (bad entries skipped). */
function readSaves(value: unknown): import("./types").Save[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("./types").Save[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const ability = stringProp(rec, "ability");
    const proficient = rec.proficient;
    if (
      (ability !== "str" &&
        ability !== "dex" &&
        ability !== "con" &&
        ability !== "int" &&
        ability !== "wis" &&
        ability !== "cha") ||
      typeof proficient !== "boolean"
    ) {
      continue;
    }
    out.push({ ability, proficient });
  }
  return out;
}

/** Valid condition rows (bad entries skipped). */
function readConditions(
  value: unknown,
): import("./types").Condition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("./types").Condition[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = stringProp(rec, "id");
    const name = stringProp(rec, "name");
    const duration = stringProp(rec, "duration");
    const effect = stringProp(rec, "effect");
    if (!id || !name || duration === undefined || effect === undefined) {
      continue;
    }
    out.push({ id, name, duration, effect });
  }
  return out;
}

/** Valid traits block, or undefined when absent/malformed. */
function readTraits(value: unknown): import("./types").SheetTraits | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const personality = stringProp(rec, "personality");
  const ideals = stringProp(rec, "ideals");
  const bonds = stringProp(rec, "bonds");
  const flaws = stringProp(rec, "flaws");
  return personality === undefined ||
    ideals === undefined ||
    bonds === undefined ||
    flaws === undefined
    ? undefined
    : { personality, ideals, bonds, flaws };
}
