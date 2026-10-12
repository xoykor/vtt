// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { applyDelta } from "../net/peer";
import { createMap, placeTile } from "../map/editor";
import { MAP_LAYERS } from "../map/layers";
import { createOfflineRoom } from "./room";
import { renderMapEditor } from "./map-editor";

/** Room with one tile per map layer at (1,1) on a 4x3 grid. */
function seededRoom(): ReturnType<typeof createOfflineRoom> {
  const room = createOfflineRoom([]);
  const map = createMap(4, 3);
  for (const layer of MAP_LAYERS) {
    const res = placeTile(
      map,
      { x: 1, y: 1, layer, asset: `${layer}-asset` },
      "host",
    );
    if (!res.ok) throw new Error(`seed failed: ${layer}`);
    room.apply(res.delta);
  }
  return room;
}

function tilesText(el: HTMLElement): string {
  return el.querySelector("[data-testid=tiles]")?.textContent ?? "";
}

function setSelect(el: HTMLElement, value: string): void {
  const sel = el.querySelector<HTMLSelectElement>("[data-testid=layer]")!;
  sel.value = value;
  sel.dispatchEvent(new Event("change"));
}

function clickCell(canvas: HTMLElement, x = 5, y = 5): void {
  canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
}

function solidPixels(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): Uint8Array {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) pixels.set(rgba, i * 4);
  return pixels;
}

function attachFile(input: HTMLInputElement, name = "map.png"): void {
  const file = new File(["fake-image-bytes"], name, { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
}

test("host sees every layer, player never sees the gm layer", () => {
  const room = seededRoom();

  const asHost = document.createElement("div");
  renderMapEditor(asHost, { room, role: "host", width: 4, height: 3 });
  const hostTiles = tilesText(asHost);
  expect(hostTiles).toMatch(/fundo-asset/);
  expect(hostTiles).toMatch(/gm-asset/);
  expect(hostTiles).toMatch(/player-asset/);

  const asPlayer = document.createElement("div");
  renderMapEditor(asPlayer, { room, role: "player", width: 4, height: 3 });
  const playerTiles = tilesText(asPlayer);
  expect(playerTiles).toMatch(/fundo-asset/);
  expect(playerTiles).toMatch(/player-asset/);
  expect(playerTiles).not.toMatch(/gm-asset/);

  // Unknown roles see nothing (fail-closed).
  const asGhost = document.createElement("div");
  renderMapEditor(asGhost, { room, role: "ghost", width: 4, height: 3 });
  expect(tilesText(asGhost)).not.toMatch(/-asset/);
});

test("host preview toggle hides the gm layer like a player would see it", () => {
  const room = seededRoom();
  const el = document.createElement("div");
  renderMapEditor(el, { room, role: "host", width: 4, height: 3 });
  expect(tilesText(el)).toMatch(/gm-asset/);

  const toggle = el.querySelector<HTMLInputElement>("[data-testid=view-as-player]")!;
  toggle.click();
  expect(tilesText(el)).not.toMatch(/gm-asset/);
  expect(tilesText(el)).toMatch(/fundo-asset/);

  toggle.click();
  expect(tilesText(el)).toMatch(/gm-asset/);
});

test("brush paints the active layer as host and reports status", () => {
  const room = createOfflineRoom([]);
  const onStatus = vi.fn();
  const el = document.createElement("div");
  renderMapEditor(el, { room, role: "host", width: 4, height: 3, onStatus });

  // The layer selector offers exactly the three map layers.
  const options = [...el.querySelectorAll("[data-testid=layer] option")].map(
    (o) => (o as HTMLOptionElement).value,
  );
  expect(options).toEqual(["fundo", "gm", "player"]);

  setSelect(el, "player");
  el.querySelector<HTMLInputElement>("[data-testid=brush]")!.value = "tijolo";
  clickCell(el.querySelector("[data-testid=grid]")!);

  expect(room.getState()["tile:player:0,0"]).toBe(
    JSON.stringify({ x: 0, y: 0, layer: "player", asset: "tijolo" }),
  );
  expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/tijolo|pincel/i));
  // The painted tile shows up in the visible list.
  expect(tilesText(el)).toMatch(/tijolo/);
});

test("guest brush clicks never reach the room (fail-closed)", () => {
  const room = createOfflineRoom([]);
  const onStatus = vi.fn();
  const el = document.createElement("div");
  renderMapEditor(el, { room, role: "guest", width: 4, height: 3, onStatus });

  setSelect(el, "player");
  el.querySelector<HTMLInputElement>("[data-testid=brush]")!.value = "tijolo";
  clickCell(el.querySelector("[data-testid=grid]")!);

  expect(
    Object.keys(room.getState()).filter((k) => k.startsWith("tile:")),
  ).toEqual([]);
  expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/mestre/i));
});

test("image import paints the active layer as host", async () => {
  const room = createOfflineRoom([]);
  const onStatus = vi.fn();
  const el = document.createElement("div");
  renderMapEditor(el, {
    room,
    role: "host",
    width: 2,
    height: 2,
    onStatus,
    decodeImage: async () => ({
      width: 2,
      height: 2,
      pixels: solidPixels(2, 2, [9, 9, 9, 255]),
    }),
  });

  setSelect(el, "fundo");
  attachFile(el.querySelector<HTMLInputElement>("[data-testid=import]")!);
  await vi.waitFor(() => {
    expect(Object.keys(room.getState())).toHaveLength(4);
  });
  const state = room.getState();
  expect(Object.keys(state).sort()).toEqual([
    "tile:fundo:0,0",
    "tile:fundo:0,1",
    "tile:fundo:1,0",
    "tile:fundo:1,1",
  ]);
  // The import delta went through room.apply, so the view lists it.
  expect(tilesText(el)).toMatch(/tile:fundo:1,1/);
  expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/importada/i));
});

test("guest image import never decodes nor writes (fail-closed)", async () => {
  const room = createOfflineRoom([]);
  const onStatus = vi.fn();
  const decodeImage = vi.fn(async () => ({
    width: 2,
    height: 2,
    pixels: solidPixels(2, 2, [9, 9, 9, 255]),
  }));
  const el = document.createElement("div");
  renderMapEditor(el, { room, role: "guest", width: 2, height: 2, onStatus, decodeImage });

  attachFile(el.querySelector<HTMLInputElement>("[data-testid=import]")!);
  // Let the async handler run: it must bail before touching the decoder.
  await vi.waitFor(() => {
    expect(onStatus).toHaveBeenCalled();
  });
  expect(decodeImage).not.toHaveBeenCalled();
  expect(room.getState()).toEqual({});
  expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/mestre/i));
});

test("imported delta stays valid after room.apply (canonical keys)", async () => {
  const room = createOfflineRoom([]);
  const el = document.createElement("div");
  renderMapEditor(el, {
    room,
    role: "host",
    width: 2,
    height: 2,
    decodeImage: async () => ({
      width: 2,
      height: 2,
      pixels: solidPixels(2, 2, [4, 5, 6, 255]),
    }),
  });
  attachFile(el.querySelector<HTMLInputElement>("[data-testid=import]")!);
  await vi.waitFor(() => {
    expect(Object.keys(room.getState())).toHaveLength(4);
  });
  // Re-applying the snapshot wholesale keeps every tile (no stale keys).
  const snap = room.getState();
  room.apply({ upsert: { ...snap } });
  expect(room.getState()).toEqual(snap);
  // Sanity: applying on top of an unrelated partition never pollutes it.
  const withToken = applyDelta(snap, { upsert: { "token:p1": "{}" } });
  expect(Object.keys(withToken).filter((k) => k.startsWith("tile:"))).toHaveLength(4);
});
