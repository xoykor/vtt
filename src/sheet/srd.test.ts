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
