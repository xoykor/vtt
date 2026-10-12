// @vitest-environment jsdom
import { expect, test } from "vitest";
import {
  createMap,
  decodeTile,
  tileKey,
  type Tile,
} from "../map/editor";
import { applyDelta, type Delta } from "../net/peer";
import { renderEditorPanel } from "./editor-panel";

test("editor panel places tile on host", () => {
  const map = createMap(10, 8);
  let placed: Tile | null = null;
  const el = document.createElement("div");
  renderEditorPanel(el, map, (t) => { placed = t; });
  const btn = el.querySelector("button")!;
  btn.click();
  expect(placed).not.toBeNull();
  expect(placed!.layer).toBe("floor");
});

test("onPlace fires once with the placeTile delta; tile exists after apply", () => {
  const map = createMap(10, 8);
  const calls: Array<{ tile: Tile; delta: Delta }> = [];
  const el = document.createElement("div");
  renderEditorPanel(el, map, (tile, delta) => { calls.push({ tile, delta }); });
  const btn = el.querySelector("button")!;

  btn.click();

  // Regression (double placeTile): exactly one placeTile per click and the
  // delta is handed to the caller instead of being recomputed there.
  expect(calls).toHaveLength(1);
  expect(calls[0].tile).toEqual({ x: 0, y: 0, layer: "floor", asset: "default" });
  const key = tileKey(calls[0].tile);
  expect(Object.keys(calls[0].delta.upsert!)).toEqual([key]);

  // Regression: the tile exists once the caller applies the delta.
  const next = applyDelta(map.tiles, calls[0].delta);
  expect(Object.keys(next)).toEqual([key]);
  expect(decodeTile(next[key])).toEqual(calls[0].tile);
});

test("second click fills the next empty cell (firstEmptyCell uses tileKey)", () => {
  const map = createMap(10, 8);
  const calls: Array<{ tile: Tile; delta: Delta }> = [];
  const el = document.createElement("div");
  renderEditorPanel(el, map, (tile, delta) => { calls.push({ tile, delta }); });
  const btn = el.querySelector("button")!;

  btn.click();
  // A caller applies the delta, so the occupied cell is visible to the panel.
  map.tiles = applyDelta(map.tiles, calls[0].delta);
  btn.click();

  expect(calls).toHaveLength(2);
  expect(calls[1].tile).toEqual({ x: 1, y: 0, layer: "floor", asset: "default" });
});
