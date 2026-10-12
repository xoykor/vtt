// Derived proficiency bonus from character level (pure, hermetic).
// 5e table: 2 (lv 1-4), 3 (lv 5-8), 4 (lv 9-12), 5 (lv 13-16), 6 (lv 17+).
import { expect, test } from "vitest";
import { profBonusForLevel } from "./level";

test("proficiency bonus follows the 5e level bands", () => {
  expect(profBonusForLevel(1)).toBe(2);
  expect(profBonusForLevel(4)).toBe(2);
  expect(profBonusForLevel(5)).toBe(3);
  expect(profBonusForLevel(8)).toBe(3);
  expect(profBonusForLevel(9)).toBe(4);
  expect(profBonusForLevel(12)).toBe(4);
  expect(profBonusForLevel(13)).toBe(5);
  expect(profBonusForLevel(16)).toBe(5);
  expect(profBonusForLevel(17)).toBe(6);
  expect(profBonusForLevel(20)).toBe(6);
});

test("out-of-range levels clamp to the table instead of throwing", () => {
  expect(profBonusForLevel(0)).toBe(2);
  expect(profBonusForLevel(-3)).toBe(2);
  // Fractional levels use the band they sit in.
  expect(profBonusForLevel(4.9)).toBe(2);
  expect(profBonusForLevel(5.2)).toBe(3);
});

test("non-finite levels throw fail-closed", () => {
  expect(() => profBonusForLevel(NaN)).toThrow(/invalid level/);
  expect(() => profBonusForLevel(Infinity)).toThrow(/invalid level/);
});
