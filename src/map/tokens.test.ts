import { expect, test } from "vitest";
import { applyDelta } from "../net/peer";
import {
  createToken,
  decodeToken,
  encodeToken,
  moveToken,
} from "./tokens";

function seeded(): Record<string, string> {
  return { hero: encodeToken(createToken("hero", { x: 1, y: 2 }, 10)) };
}

test("only host moves tokens (fail-closed like placeTile)", () => {
  const state = seeded();
  for (const role of ["player", "guest", "", "admin"]) {
    const res = moveToken(state, "hero", { x: 2, y: 2 }, role);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/forbidden role/);
  }
  expect(state["hero"]).toBe(seeded()["hero"]);
});

test("host move returns delta that applies via applyDelta", () => {
  const state = seeded();
  const res = moveToken(state, "hero", { x: 3, y: 4 }, "host");
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("host move must succeed");
  const next = applyDelta(state, res.delta);
  expect(decodeToken(next["hero"]).pos).toEqual({ x: 3, y: 4 });
  // Pure: input not mutated.
  expect(decodeToken(state["hero"]).pos).toEqual({ x: 1, y: 2 });
});

test("host move of unknown token returns ok:false", () => {
  const res = moveToken(seeded(), "ghost", { x: 0, y: 0 }, "host");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toMatch(/unknown token/);
});

test("createToken/moveToken/decodeToken reject NaN/Infinity pos", () => {
  expect(() => createToken("a", { x: NaN, y: 0 }, 10)).toThrow(/invalid pos/);
  expect(() => createToken("a", { x: 0, y: Infinity }, 10)).toThrow(
    /invalid pos/,
  );
  expect(() =>
    createToken("a", { x: 0, y: -Infinity }, 10),
  ).toThrow(/invalid pos/);
  const state = seeded();
  for (const pos of [
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: Infinity, y: Infinity },
  ]) {
    const res = moveToken(state, "hero", pos, "host");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid pos/);
  }
  expect(() =>
    decodeToken('{"id":"a","pos":{"x":1e999,"y":0},"hp":10}'),
  ).toThrow(/invalid pos/);
});
