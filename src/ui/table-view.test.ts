// @vitest-environment jsdom
import { expect, test } from "vitest";
import { createGrid } from "../map/grid";
import { createMap, placeTile } from "../map/editor";
import { MAP_LAYERS } from "../map/layers";
import { createOfflineRoom } from "./room";
import { renderTableView } from "./table-view";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

function mount(role = "host"): {
  box: HTMLElement;
  view: ReturnType<typeof renderTableView>;
  canvas: HTMLCanvasElement;
} {
  const room = createOfflineRoom([]);
  const box = document.createElement("div");
  const view = renderTableView(box, {
    room,
    role,
    grid: createGrid(6, 5),
    speaker: "Borin",
    isGM: role === "host",
    storage: memoryStorage(),
  });
  const canvas = box.querySelector("canvas")!;
  return { box, view, canvas };
}

function pointer(
  type: string,
  x: number,
  y: number,
  opts: { button?: number; ctrlKey?: boolean } = {},
): Event {
  return new MouseEvent(type, {
    button: opts.button ?? 0,
    clientX: x,
    clientY: y,
    ctrlKey: opts.ctrlKey ?? false,
    bubbles: true,
  });
}

function seededBox(): {
  box: HTMLElement;
  view: ReturnType<typeof renderTableView>;
} {
  const room = createOfflineRoom([]);
  const map = createMap(6, 5);
  for (const layer of MAP_LAYERS) {
    const res = placeTile(map, { x: 1, y: 1, layer, asset: `${layer}-asset` }, "host");
    if (!res.ok) throw new Error("seed failed");
    room.apply(res.delta);
  }
  room.apply({ upsert: { "map:info": JSON.stringify({ width: 6, height: 5 }) } });
  const box = document.createElement("div");
  const view = renderTableView(box, {
    room,
    role: "host",
    grid: createGrid(6, 5),
    speaker: "Mestre",
    isGM: true,
    storage: memoryStorage(),
  });
  return { box, view };
}

test("table mounts rail, canvas, chat and hidden layer/grid panels", () => {
  const { box } = mount();
  expect(box.querySelector("[data-testid=table-view]")).not.toBeNull();
  expect(box.querySelectorAll("[data-testid^=tool-]")).toHaveLength(9); // one per tool
  expect(box.querySelector("[data-testid=toolbar-collapse]")).not.toBeNull();
  expect(box.querySelector("[data-testid=table-canvas]")).not.toBeNull();
  expect(box.querySelector("[data-testid=chat-panel]")).not.toBeNull();
  expect(box.querySelector("[data-testid=chat-aside]")!.hasAttribute("hidden")).toBe(false);
  expect(box.querySelector("[data-testid=layer-host]")!.hasAttribute("hidden")).toBe(true);
  expect(box.querySelector("[data-testid=grid-host]")!.hasAttribute("hidden")).toBe(true);
});

test("tools reveal their panels; chat toggles the aside", () => {
  const { box, view } = mount();
  view.setTool("layers");
  expect(box.querySelector("[data-testid=layer-host]")!.hasAttribute("hidden")).toBe(false);
  view.setTool("grid");
  expect(box.querySelector("[data-testid=grid-host]")!.hasAttribute("hidden")).toBe(false);
  expect(box.querySelector("[data-testid=layer-host]")!.hasAttribute("hidden")).toBe(true);
  const aside = box.querySelector("[data-testid=chat-aside]")!;
  view.setTool("chat");
  expect(aside.hasAttribute("hidden")).toBe(true);
  view.setTool("chat");
  expect(aside.hasAttribute("hidden")).toBe(false);
});

test("right-drag pans and context menu never opens on the canvas", () => {
  const { box, view, canvas } = mount();
  view.setTool("select");
  let opened = false;
  canvas.addEventListener("contextmenu", () => {
    opened = true;
  });
  canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(opened).toBe(true); // listener ran, but default is prevented below
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  canvas.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);

  // Right button pans even with the ruler active.
  view.setTool("measure");
  canvas.dispatchEvent(pointer("pointerdown", 10, 10, { button: 2 }));
  canvas.dispatchEvent(pointer("pointermove", 30, 40, { button: 2 }));
  canvas.dispatchEvent(pointer("pointerup", 30, 40, { button: 2 }));
  expect(view.getPan()).toEqual({ x: 20, y: 30 });
});

test("measure drag shows a distance tooltip in squares", () => {
  const { box, view, canvas } = mount();
  view.setTool("measure");
  canvas.dispatchEvent(pointer("pointerdown", 0, 0));
  canvas.dispatchEvent(pointer("pointermove", 64, 0));
  const tip = box.querySelector("[data-testid=measure-tip]")!;
  expect(tip.hasAttribute("hidden")).toBe(false);
  expect(tip.textContent).toMatch(/2 quadrados/);
  canvas.dispatchEvent(pointer("pointerup", 64, 0));
  expect(view.getMeasure()).toMatch(/2 quadrados/);
});

test("draw stores snapped strokes and rects (Ctrl bypasses snapping)", () => {
  const { view, canvas } = mount();
  view.setTool("draw");
  canvas.dispatchEvent(pointer("pointerdown", 40, 50));
  canvas.dispatchEvent(pointer("pointermove", 45, 55));
  canvas.dispatchEvent(pointer("pointerup", 45, 55));
  const strokes = view.getDrawings();
  expect(strokes).toHaveLength(1);
  expect(strokes[0].kind).toBe("freehand");
  // (40,50) snapped to the 32px grid.
  expect(strokes[0].points[0]).toEqual({ x: 32, y: 64 });

  view.setDrawMode("rect");
  canvas.dispatchEvent(pointer("pointerdown", 10, 10));
  canvas.dispatchEvent(pointer("pointerup", 70, 40));
  expect(view.getDrawings()).toHaveLength(2);
  expect(view.getDrawings()[1].kind).toBe("rect");

  view.setDrawMode("freehand");
  canvas.dispatchEvent(pointer("pointerdown", 40, 50, { ctrlKey: true }));
  canvas.dispatchEvent(pointer("pointerup", 40, 50, { ctrlKey: true }));
  expect(view.getDrawings()[2].points[0]).toEqual({ x: 40, y: 50 });
});

test("text tool places a note through the inline form", () => {
  const { box, view, canvas } = mount();
  view.setTool("text");
  canvas.dispatchEvent(pointer("pointerdown", 64, 64));
  canvas.dispatchEvent(pointer("pointerup", 64, 64));
  const form = box.querySelector("[data-testid=text-form]")!;
  expect(form.hasAttribute("hidden")).toBe(false);
  box.querySelector<HTMLInputElement>("[data-testid=text-input]")!.value = "Armadilha!";
  box.querySelector<HTMLFormElement>("[data-testid=text-form]")!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  expect(view.getNotes()).toEqual([{ x: 64, y: 64, text: "Armadilha!" }]);
  expect(box.querySelector(".text-note")!.textContent).toBe("Armadilha!");
});

test("fog brush reveals and hides cells with GM-only status", () => {
  const { box, view, canvas } = mount();
  view.setTool("fog");
  expect(view.getFog().visible.every((v) => v === false)).toBe(true);
  canvas.dispatchEvent(pointer("pointerdown", 10, 10));
  canvas.dispatchEvent(pointer("pointerup", 10, 10));
  expect(view.getFog().visible[0]).toBe(true);
  expect(box.querySelector("[data-testid=fog-status]")!.textContent).toMatch(/1\/30/);
  view.setFogMode("hide");
  canvas.dispatchEvent(pointer("pointerdown", 10, 10));
  canvas.dispatchEvent(pointer("pointerup", 10, 10));
  expect(view.getFog().visible[0]).toBe(false);
});

test("drops land on the active layer and preview hides the GM layer", () => {
  const { box, view } = seededBox();
  view.setTool("layers");
  const layerSel = box.querySelector<HTMLSelectElement>("[data-testid=table-layer]")!;
  layerSel.value = "gm";
  layerSel.dispatchEvent(new Event("change"));
  expect(view.placeDrop({ x: 2, y: 2 }, "trap")).toBe(true);

  // Preview as player: fundo + player only, never the GM layer.
  const preview = box.querySelector<HTMLInputElement>("[data-testid=table-preview]")!;
  preview.click();
  const tiles = box.querySelector("[data-testid=layer-tiles]")!.textContent ?? "";
  expect(tiles).not.toMatch(/gm-asset/);
  expect(tiles).not.toMatch(/trap/);
  expect(tiles).toMatch(/player-asset/);
});

test("narrow screens start with a collapsed rail", () => {
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
  try {
    const { box, view } = mount();
    expect(box.querySelector("[data-testid=table-view]")!.classList.contains("compact")).toBe(
      true,
    );
    expect(view.isCollapsed()).toBe(true);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});
