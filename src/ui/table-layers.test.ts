// @vitest-environment jsdom
import { expect, test } from "vitest";
import { createMap, placeTile } from "../map/editor";
import { MAP_LAYERS } from "../map/layers";
import { createOfflineRoom } from "./room";
import {
  createLayerState,
  effectiveRole,
  moveTileDelta,
  renderLayerPanel,
} from "./table-layers";

/** Room holding one tile per layer on a 4x3 grid (host-seeded). */
function seededRoom(): ReturnType<typeof createOfflineRoom> {
  const room = createOfflineRoom([]);
  const map = createMap(4, 3);
  for (const layer of MAP_LAYERS) {
    const res = placeTile(map, { x: 1, y: 1, layer, asset: `${layer}-asset` }, "host");
    if (!res.ok) throw new Error(`seed failed: ${layer}`);
    room.apply(res.delta);
  }
  room.apply({ upsert: { "map:info": JSON.stringify({ width: 4, height: 3 }) } });
  return room;
}

test("layer state defaults to player and rejects foreign layers", () => {
  const state = createLayerState();
  expect(state.get()).toBe("player");
  state.set("gm");
  expect(state.get()).toBe("gm");
  state.set("banana");
  expect(state.get()).toBe("gm");
});

test("preview-as-player narrows the host view, others stay pinned", () => {
  expect(effectiveRole("host", true)).toBe("player");
  expect(effectiveRole("host", false)).toBe("host");
  expect(effectiveRole("player", false)).toBe("player");
  expect(effectiveRole("ghost", false)).toBe("ghost");
});

test("moving a tile between layers is host-only and keeps one copy", () => {
  const room = seededRoom();
  room.apply({ remove: ["tile:gm:1,1"] });
  const before = room.getState();
  const res = moveTileDelta(before, "tile:player:1,1", "gm", "host");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.delta.remove).toEqual(["tile:player:1,1"]);
  room.apply(res.delta);
  expect(room.getState()["tile:player:1,1"]).toBeUndefined();
  expect(room.getState()["tile:gm:1,1"]).toContain("player-asset");

  // Guests and unknown roles are denied fail-closed.
  expect(moveTileDelta(before, "tile:player:1,1", "gm", "guest").ok).toBe(false);
  expect(moveTileDelta(before, "tile:player:1,1", "gm", "ghost").ok).toBe(false);
  // Same layer, missing tile and occupied targets fail too.
  expect(moveTileDelta(before, "tile:player:1,1", "player", "host").ok).toBe(false);
  expect(moveTileDelta(before, "tile:nope:0,0", "gm", "host").ok).toBe(false);
  expect(moveTileDelta(room.getState(), "tile:fundo:1,1", "gm", "host").ok).toBe(false);
});

test("panel switches the active layer and previews as player", () => {
  const room = seededRoom();
  const seen: string[] = [];
  const box = document.createElement("div");
  const panel = renderLayerPanel(box, {
    room,
    role: "host",
    onChange: (layer, preview) => seen.push(`${layer}:${preview}`),
  });
  expect(panel.activeLayer()).toBe("player");

  const sel = box.querySelector<HTMLSelectElement>("[data-testid=table-layer]")!;
  sel.value = "gm";
  sel.dispatchEvent(new Event("change"));
  expect(panel.activeLayer()).toBe("gm");
  expect(seen).toEqual(["gm:false"]);

  // "Ver como jogador" hides the GM layer like a player would see it.
  const preview = box.querySelector<HTMLInputElement>("[data-testid=table-preview]")!;
  expect(preview.disabled).toBe(false);
  preview.click();
  expect(panel.isPreview()).toBe(true);
  expect(box.querySelector("[data-testid=layer-tiles]")!.textContent).not.toMatch(/gm-asset/);
});

test("non-hosts cannot switch the preview and drops land on the active layer", () => {
  const room = seededRoom();
  const hostBox = document.createElement("div");
  const host = renderLayerPanel(hostBox, { room, role: "host" });
  const preview = hostBox.querySelector<HTMLInputElement>("[data-testid=table-preview]")!;
  expect(preview.disabled).toBe(false);

  // New drops land on the active layer (host paints, guest is denied).
  expect(host.drop(1, 2, "crate")).toBe(true);
  expect(room.getState()["tile:player:1,2"]).toContain("crate");

  const box = document.createElement("div");
  renderLayerPanel(box, { room, role: "player" });
  const pinned = box.querySelector<HTMLInputElement>("[data-testid=table-preview]")!;
  expect(pinned.disabled).toBe(true);
  expect(pinned.checked).toBe(true);

  const guestBox = document.createElement("div");
  const guest = renderLayerPanel(guestBox, { room, role: "guest" });
  expect(guest.drop(0, 0, "crate")).toBe(false);
});

test("selection moves between layers through the room", () => {
  const room = seededRoom();
  const box = document.createElement("div");
  renderLayerPanel(box, { room, role: "host" });
  const options = [...box.querySelectorAll("[data-testid=table-selection] option")].map(
    (o) => (o as HTMLOptionElement).value,
  );
  expect(options).toContain("tile:player:1,1");

  const selection = box.querySelector<HTMLSelectElement>("[data-testid=table-selection]")!;
  selection.value = "tile:player:1,1";
  selection.dispatchEvent(new Event("change"));
  const target = box.querySelector<HTMLSelectElement>("[data-testid=move-layer]")!;
  target.value = "fundo";
  target.dispatchEvent(new Event("change"));
  // fundo:1,1 is occupied, so the move is refused with a status hint.
  box.querySelector<HTMLButtonElement>("[data-testid=move-selected]")!.click();
  expect(box.querySelector("[data-testid=layer-status]")!.textContent).toMatch(/ocupad|falhou/i);

  // A free target (gm:1,1 after clearing it) succeeds.
  room.apply({ remove: ["tile:gm:1,1"] });
  target.value = "gm";
  target.dispatchEvent(new Event("change"));
  box.querySelector<HTMLButtonElement>("[data-testid=move-selected]")!.click();
  expect(room.getState()["tile:player:1,1"]).toBeUndefined();
  expect(room.getState()["tile:gm:1,1"]).toContain("player-asset");
});
