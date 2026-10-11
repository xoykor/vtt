import { expect, test } from "vitest";
import type { Point } from "./grid";
import type { Fog } from "./fog";
import { revealFog } from "./fog";

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
