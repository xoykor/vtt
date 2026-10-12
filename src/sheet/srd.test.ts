import { expect, test } from "vitest";
import {
  createSrdCache,
  decodeSheet,
  encodeSheet,
  fetchSrd,
  importMonster,
  rollRequest,
} from "./srd";
import type { Roll } from "./types";

// Fixture SRD inline (sem fetch real): formato Open5e, goblin ac 15, hp 7.
const goblinSrd = {
  slug: "goblin",
  name: "Goblin",
  armor_class: 15,
  hit_points: 7,
  hit_dice: "2d6",
};

test("imports srd goblin with ac and hp", async () => {
  const s = importMonster(goblinSrd);
  expect(s.ac).toBe(15); expect(s.hp).toBe(7);
});

test("maps the 5e-SRD API armor_class array shape", () => {
  const entry = {
    index: "goblin",
    name: "Goblin",
    armor_class: [{ type: "dex", value: 15 }],
    hit_points: 7,
    hit_dice: "2d6",
  };
  const s = importMonster(entry);
  expect(s.ac).toBe(15);
  expect(s.hp).toBe(7);
  expect(s.name).toBe("Goblin");
});

test("importMonster throws on missing ac or hp", () => {
  expect(() => importMonster({ name: "Goblin", hit_points: 7 })).toThrow(
    /missing field: armor_class/,
  );
  expect(() => importMonster({ name: "Goblin", armor_class: 15 })).toThrow(
    /missing field: hit_points/,
  );
});

test("rollRequest normalizes defaults and validates sides", () => {
  const dice: Roll = { sides: 20 };
  const roll = rollRequest(dice);
  expect(roll).toEqual({ sides: 20, count: 1, mod: 0 });
  // Puro: a entrada não é mutada.
  expect(dice).toEqual({ sides: 20 });
  expect(rollRequest({ sides: 8, count: 2, mod: 3 })).toEqual({
    sides: 8,
    count: 2,
    mod: 3,
  });
  expect(() => rollRequest({ sides: 0 })).toThrow(/invalid sides/);
  expect(() => rollRequest({ sides: 20, count: 0 })).toThrow(/invalid count/);
});

test("fetchSrd caches locally and drops WotC art fields", async () => {
  const payload = { ...goblinSrd, img: "https://example.com/goblin.png" };
  let calls = 0;
  const stubFetch = async (_url: string) => {
    calls += 1;
    return { ok: true, json: async () => payload };
  };
  const cache = createSrdCache();
  const first = await fetchSrd(
    "goblin",
    stubFetch as unknown as typeof fetch,
    cache,
  );
  expect(first.ac).toBe(15);
  expect(first.hp).toBe(7);
  const second = await fetchSrd(
    "goblin",
    stubFetch as unknown as typeof fetch,
    cache,
  );
  expect(second).toEqual(first);
  // Cache local: o segundo acesso não refaz fetch.
  expect(calls).toBe(1);
  // Sem arte oficial WotC: nenhum campo de imagem sobrevive no Sheet.
  expect(JSON.stringify(first)).not.toContain("example.com");
});

test("sheet encodes to snapshot state and back", () => {
  const s = importMonster(goblinSrd);
  expect(decodeSheet(encodeSheet(s))).toEqual(s);
});

test("decodeSheet round-trips owner, level, class and proficiency", () => {
  const s = importMonster(goblinSrd);
  s.ownerId = "p1";
  s.level = 5;
  s.charClass = "Guerreiro";
  s.profBonus = 3;
  expect(decodeSheet(encodeSheet(s))).toEqual(s);
});

test("decodeSheet round-trips the full Roll20 sheet", () => {
  const s = importMonster(goblinSrd);
  s.ownerId = "p1";
  s.level = 5;
  s.charClass = "Guerreiro";
  s.profBonus = 3;
  s.race = "Anão";
  s.alignment = "Leal e Bom";
  s.xp = 6500;
  s.inspiration = true;
  s.speed = 7.5;
  s.initiativeMisc = 1;
  s.tempHp = 4;
  s.deathSaves = { successes: 1, failures: 0 };
  s.attacks = [{ id: "a1", name: "Machado", bonus: 5, damage: "1d8+3" }];
  s.spells = [{ id: "m1", name: "Mãos Flamejantes", level: 1 }];
  s.spellSlots = [{ level: 1, total: 2, used: 1 }];
  s.money = { cp: 0, sp: 3, ep: 0, gp: 12, pp: 0 };
  s.languages = "Comum, Anão";
  s.backstory = "Forjado nas minas do norte.";
  expect(decodeSheet(encodeSheet(s))).toEqual(s);
});

test("fetchSrd deep-clones abilities on store and hit", async () => {
  const payload = {
    ...goblinSrd,
    strength: 8,
    dexterity: 14,
    constitution: 10,
    intelligence: 10,
    wisdom: 8,
    charisma: 8,
  };
  const stubFetch = async (_url: string) => ({
    ok: true,
    json: async () => payload,
  });
  const cache = createSrdCache();
  const first = await fetchSrd(
    "goblin",
    stubFetch as unknown as typeof fetch,
    cache,
  );
  expect(first.abilities).toEqual({
    str: 8,
    dex: 14,
    con: 10,
    int: 10,
    wis: 8,
    cha: 8,
  });
  // Mutating the returned abilities must not poison the cache.
  if (first.abilities) first.abilities.str = 1;
  const second = await fetchSrd(
    "goblin",
    stubFetch as unknown as typeof fetch,
    cache,
  );
  expect(second.abilities?.str).toBe(8);
  // Mutating a hit must not poison later hits either.
  if (second.abilities) second.abilities.dex = 1;
  const third = await fetchSrd(
    "goblin",
    stubFetch as unknown as typeof fetch,
    cache,
  );
  expect(third.abilities?.dex).toBe(14);
});

test("decodeSheet validates the 6 ability fields when present", () => {
  const good = importMonster({
    ...goblinSrd,
    strength: 8,
    dexterity: 14,
    constitution: 10,
    intelligence: 10,
    wisdom: 8,
    charisma: 8,
  });
  expect(decodeSheet(encodeSheet(good)).abilities).toEqual({
    str: 8,
    dex: 14,
    con: 10,
    int: 10,
    wis: 8,
    cha: 8,
  });
  const base = JSON.parse(encodeSheet(good)) as Record<string, unknown>;
  const missingOne = {
    ...base,
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8 },
  };
  expect(() => decodeSheet(JSON.stringify(missingOne))).toThrow(
    /abilities\.cha/,
  );
  const badType = { ...base, abilities: { ...good.abilities, str: "8" } };
  expect(() => decodeSheet(JSON.stringify(badType))).toThrow(
    /abilities\.str/,
  );
  const nonFinite = { ...base, abilities: { ...good.abilities, dex: null } };
  expect(() => decodeSheet(JSON.stringify(nonFinite))).toThrow(
    /abilities\.dex/,
  );
});
