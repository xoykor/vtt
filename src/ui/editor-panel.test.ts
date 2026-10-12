// @vitest-environment jsdom
import { expect, test } from "vitest";
import { createMap, type Tile } from "../map/editor";
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
