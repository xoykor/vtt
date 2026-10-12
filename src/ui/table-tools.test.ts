// @vitest-environment jsdom
import { expect, test } from "vitest";
import {
  createToolState,
  renderToolbar,
  TABLE_TOOLS,
  type ToolId,
} from "./table-tools";

const IDS: ToolId[] = [
  "select",
  "pan",
  "measure",
  "draw",
  "text",
  "fog",
  "layers",
  "grid",
  "chat",
];

test("toolbar offers the nine table tools in order", () => {
  const box = document.createElement("div");
  const bar = renderToolbar(box);
  expect(box.querySelector("[data-testid=toolbar]")).not.toBeNull();
  const buttons = [...box.querySelectorAll<HTMLButtonElement>("[data-testid^=tool-]")];
  expect(buttons.map((b) => b.dataset.testid)).toEqual(IDS.map((id) => `tool-${id}`));
  expect(TABLE_TOOLS.map((t) => t.id)).toEqual(IDS);
  expect(bar.state.get()).toBe("select");
});

test("clicking a tool activates it and marks aria-pressed", () => {
  const box = document.createElement("div");
  const bar = renderToolbar(box);
  const measure = box.querySelector<HTMLButtonElement>("[data-testid=tool-measure]")!;
  measure.click();
  expect(bar.state.get()).toBe("measure");
  expect(measure.getAttribute("aria-pressed")).toBe("true");
  expect(box.querySelector("[data-testid=tool-select]")!.getAttribute("aria-pressed")).toBe(
    "false",
  );
});

test("unknown tool ids are ignored (fail-closed)", () => {
  const box = document.createElement("div");
  const bar = renderToolbar(box);
  bar.state.set("measure");
  bar.state.set("banana");
  expect(bar.state.get()).toBe("measure");
});

test("subscribers hear tool changes and can unsubscribe", () => {
  const state = createToolState();
  const heard: ToolId[] = [];
  const off = state.subscribe((t) => heard.push(t));
  state.set("draw");
  off();
  state.set("text");
  expect(heard).toEqual(["draw"]);
});

test("collapse button toggles the rail and small screens start collapsed", () => {
  const box = document.createElement("div");
  const bar = renderToolbar(box);
  const collapse = box.querySelector<HTMLButtonElement>("[data-testid=toolbar-collapse]")!;
  expect(bar.isCollapsed()).toBe(false);
  collapse.click();
  expect(bar.isCollapsed()).toBe(true);
  expect(box.querySelector("[data-testid=toolbar]")!.classList.contains("collapsed")).toBe(true);
  collapse.click();
  expect(bar.isCollapsed()).toBe(false);

  // Narrow viewport: the rail starts collapsed so the map keeps room.
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
  try {
    const narrow = document.createElement("div");
    const narrowBar = renderToolbar(narrow);
    expect(narrowBar.isCollapsed()).toBe(true);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});
