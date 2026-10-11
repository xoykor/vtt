import { expect, test } from "vitest";
import type { Point } from "./grid";
import type { Fog } from "./fog";
import { revealFog } from "./fog";
import { computeLight } from "./light";

// Helpers locais do teste (herméticos, sem dependências novas).
// Grade 8x8 toda sob fog; polyA é o retângulo [1,5]x[1,4] que cobre
// exatamente 4 colunas x 3 linhas de centros de célula = 12 células.
function emptyFog(): Fog {
  return { width: 8, height: 8, visible: new Array(8 * 8).fill(false) };
}

const polyA: Point[] = [
  { x: 1, y: 1 },
  { x: 5, y: 1 },
  { x: 5, y: 4 },
  { x: 1, y: 4 },
];

function countVisible(fog: Fog): number {
  return fog.visible.filter(Boolean).length;
}

test("reveal removes only polygon area", () => {
  expect(countVisible(revealFog(emptyFog(), polyA))).toBe(12);
});

test("revealFog rejects masks with length !== w*h", () => {
  const bad: Fog = { width: 8, height: 8, visible: [true, false] };
  expect(() => revealFog(bad, polyA)).toThrow(/invalid fog mask/);
});

test("computeLight rejects walls with length !== w*h", () => {
  expect(() =>
    computeLight({ width: 2, height: 2, walls: [false] }, [
      { pos: { x: 0.5, y: 0.5 }, radius: 5 },
    ]),
  ).toThrow(/invalid walls mask/);
});

test("wall blocks light (occlusion)", () => {
  // 3x1 corridor: source at cell 0, wall at cell 1, target at cell 2.
  // Radius covers all three; only the wall cell shadows the far cell.
  const map = { width: 3, height: 1, walls: [false, true, false] };
  const mask = computeLight(map, [{ pos: { x: 0.5, y: 0.5 }, radius: 10 }]);
  expect(mask[0]).toBe(true);
  expect(mask[2]).toBe(false);
});
