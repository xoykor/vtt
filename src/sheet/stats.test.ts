// Ability modifiers and initiative totals (pure, hermetic).
import { expect, test } from "vitest";
import { abilityMod, initiativeTotal } from "./stats";

test("abilityMod follows (score - 10) / 2 floored", () => {
  expect(abilityMod(10)).toBe(0);
  expect(abilityMod(16)).toBe(3);
  expect(abilityMod(8)).toBe(-1);
  expect(abilityMod(9)).toBe(-1);
  expect(abilityMod(20)).toBe(5);
});

test("initiative is the dex modifier plus the misc bonus", () => {
  expect(initiativeTotal(14, 0)).toBe(2);
  expect(initiativeTotal(14, 1)).toBe(3);
  expect(initiativeTotal(8, 0)).toBe(-1);
  expect(initiativeTotal(10, 2)).toBe(2);
});
