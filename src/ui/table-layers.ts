// Layer switcher for the table view, wired to the existing map
// layers (`fundo`/`gm`/`player` from src/map/layers.ts). The host
// switches the active layer (new drops land on it), moves the current
// selection between layers, and toggles "Ver como jogador" to preview
// the player view — the GM-only layer stays hidden from players.
// Non-hosts are pinned to the player preview; tile writes stay
// host-only through the existing `placeTile` (fail-closed).

import {
  decodeTile,
  encodeTile,
  placeTile,
  tileKey,
  type Tile,
} from "../map/editor";
import {
  decodeMapInfo,
  isMapLayer,
  layerLabel,
  MAP_INFO_KEY,
  MAP_LAYERS,
  mapFromState,
  visibleTiles,
  type MapLayer,
} from "../map/layers";
import type { Delta } from "../net/peer";
import type { OfflineRoom } from "./room";

export type MoveTileResult = { ok: true; delta: Delta } | { ok: false; error: string };

export interface LayerState {
  get(): MapLayer;
  /** Switch the active layer (foreign layers ignored, fail-closed). */
  set(layer: string): void;
  subscribe(fn: (layer: MapLayer) => void): () => void;
}

/** Active-layer store (new drops land on the player layer by default). */
export function createLayerState(initial: MapLayer = "player"): LayerState {
  let current: MapLayer = isMapLayer(initial) ? initial : "player";
  const listeners = new Set<(layer: MapLayer) => void>();
  return {
    get: () => current,
    set: (layer: string) => {
      if (!isMapLayer(layer) || layer === current) return;
      current = layer;
      for (const fn of [...listeners]) fn(current);
    },
    subscribe: (fn: (layer: MapLayer) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/**
 * Role the canvas draws as: the host narrows to the player view while
 * previewing; everyone else is pinned (players/guests to the player
 * view, unknown roles keep their own so `visibleTiles` denies them).
 */
export function effectiveRole(role: string, previewAsPlayer: boolean): string {
  if (role === "host") return previewAsPlayer ? "player" : role;
  return role;
}

/** Grid size from the room's `map:info` (defaults when missing). */
export function roomGridSize(room: OfflineRoom): { width: number; height: number } {
  const info = decodeMapInfo(room.getState()[MAP_INFO_KEY] ?? "");
  return info ?? { width: 10, height: 8 };
}

/**
 * Move the tile at `key` to `to`, returning the delta (remove the old
 * key, upsert the new one). Host-only; same-layer moves, missing
 * tiles, malformed values and occupied targets all fail fail-closed.
 * Pure: the room is untouched.
 */
export function moveTileDelta(
  state: Record<string, string>,
  key: string,
  to: MapLayer,
  role: string,
): MoveTileResult {
  if (role !== "host") return { ok: false, error: `forbidden role: ${role}` };
  if (!key.startsWith("tile:")) return { ok: false, error: `not a tile: ${key}` };
  const json = state[key];
  if (json === undefined) return { ok: false, error: `missing tile: ${key}` };
  let tile: Tile;
  try {
    tile = decodeTile(json);
  } catch {
    return { ok: false, error: `broken tile: ${key}` };
  }
  if (tileKey(tile) !== key) return { ok: false, error: `stale tile: ${key}` };
  if (!isMapLayer(tile.layer)) return { ok: false, error: `foreign layer: ${tile.layer}` };
  if (tile.layer === to) return { ok: false, error: `already on ${layerLabel(to)}` };
  const moved: Tile = { x: tile.x, y: tile.y, layer: to, asset: tile.asset };
  const target = tileKey(moved);
  if (state[target] !== undefined) return { ok: false, error: `alvo ocupado: ${target}` };
  return { ok: true, delta: { upsert: { [target]: encodeTile(moved) }, remove: [key] } };
}

export interface LayerPanelOptions {
  room: OfflineRoom;
  /** Caller role: tile writes stay host-only (fail-closed). */
  role: string;
  initial?: MapLayer;
  onChange?: (layer: MapLayer, previewAsPlayer: boolean) => void;
}

export interface LayerPanel {
  /** Panel root (`section[data-testid=layer-panel]`). */
  el: HTMLElement;
  /** Active layer (new drops land here). */
  activeLayer(): MapLayer;
  /** Current preview-as-player state. */
  isPreview(): boolean;
  setPreview(preview: boolean): void;
  /** Currently selected tile key (`""` when none). */
  selectedKey(): string;
  /** Paint one tile onto the active layer (host-only). */
  drop(x: number, y: number, asset: string): boolean;
  /** Rebuild the selection + tile list from the room. */
  refresh(): void;
}

/** Render the layer switcher into `container`. */
export function renderLayerPanel(container: HTMLElement, opts: LayerPanelOptions): LayerPanel {
  const { room, role } = opts;
  const state = createLayerState(opts.initial);
  let preview = role === "player" || role === "guest";
  let selection = "";
  let moveTarget: MapLayer = "player";

  const el = document.createElement("section");
  el.dataset.testid = "layer-panel";
  el.className = "layer-panel";
  el.setAttribute("aria-label", "Camadas do mapa");

  const title = document.createElement("h2");
  title.textContent = "Camadas";

  const layerLabelEl = document.createElement("label");
  layerLabelEl.textContent = "Ativa: ";
  const layerSel = document.createElement("select");
  layerSel.dataset.testid = "table-layer";
  for (const layer of MAP_LAYERS) {
    const opt = document.createElement("option");
    opt.value = layer;
    opt.textContent = layerLabel(layer);
    layerSel.appendChild(opt);
  }
  layerSel.value = state.get();
  layerLabelEl.appendChild(layerSel);

  const viewLabel = document.createElement("label");
  viewLabel.className = "layer-preview";
  const viewToggle = document.createElement("input");
  viewToggle.type = "checkbox";
  viewToggle.dataset.testid = "table-preview";
  viewToggle.checked = preview;
  // Non-hosts are pinned to the player view (like the map editor).
  if (role !== "host") viewToggle.disabled = true;
  viewLabel.append(viewToggle, document.createTextNode(" Ver como jogador"));

  const selectionLabel = document.createElement("label");
  selectionLabel.textContent = "Seleção: ";
  const selectionSel = document.createElement("select");
  selectionSel.dataset.testid = "table-selection";
  selectionLabel.appendChild(selectionSel);

  const moveLabel = document.createElement("label");
  moveLabel.textContent = "Mover para: ";
  const moveSel = document.createElement("select");
  moveSel.dataset.testid = "move-layer";
  for (const layer of MAP_LAYERS) {
    const opt = document.createElement("option");
    opt.value = layer;
    opt.textContent = layerLabel(layer);
    moveSel.appendChild(opt);
  }
  moveSel.value = moveTarget;
  moveLabel.appendChild(moveSel);

  const moveBtn = document.createElement("button");
  moveBtn.type = "button";
  moveBtn.dataset.testid = "move-selected";
  moveBtn.className = "menu-btn move-btn";
  moveBtn.textContent = "Mover";

  const tiles = document.createElement("div");
  tiles.dataset.testid = "layer-tiles";
  tiles.className = "layer-tiles";

  const status = document.createElement("div");
  status.dataset.testid = "layer-status";
  status.className = "layer-status";
  status.setAttribute("aria-live", "polite");

  const say = (text: string): void => {
    status.textContent = text;
  };

  function viewRole(): string {
    return effectiveRole(role, preview);
  }

  function refresh(): void {
    const { width, height } = roomGridSize(room);
    const seen = visibleTiles(mapFromState(width, height, room.getState()), viewRole());
    selectionSel.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = seen.length ? "Escolha um tile…" : "Nenhum tile visível.";
    selectionSel.appendChild(empty);
    for (const tile of seen) {
      const key = tileKey(tile);
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${layerLabel(tile.layer)} ${tile.x},${tile.y} = ${tile.asset}`;
      selectionSel.appendChild(opt);
    }
    if (selection && [...selectionSel.options].some((o) => o.value === selection)) {
      selectionSel.value = selection;
    } else {
      selection = "";
      selectionSel.value = "";
    }
    tiles.textContent = seen.length
      ? `Visíveis (${seen.length}): ` + seen.map((t) => `${t.layer}:${t.x},${t.y}=${t.asset}`).join(", ")
      : "Nenhum tile visível.";
  }

  function drop(x: number, y: number, asset: string): boolean {
    const name = asset.trim();
    if (!name) {
      say("Escolha um asset antes de soltar.");
      return false;
    }
    const { width, height } = roomGridSize(room);
    const res = placeTile(
      mapFromState(width, height, room.getState()),
      { x, y, layer: state.get(), asset: name },
      role,
    );
    if (!res.ok) {
      say(role === "host" ? `Não soltei: ${res.error}` : "Apenas o mestre pode soltar tiles.");
      return false;
    }
    room.apply(res.delta);
    say(`Solto em ${layerLabel(state.get())} (${x},${y}).`);
    refresh();
    return true;
  }

  function moveSelected(): boolean {
    if (!selection) {
      say("Selecione um tile para mover.");
      return false;
    }
    const res = moveTileDelta(room.getState(), selection, moveTarget, role);
    if (!res.ok) {
      say(
        role === "host"
          ? `Não movi: ${res.error}`
          : "Apenas o mestre pode mover tiles entre camadas.",
      );
      return false;
    }
    room.apply(res.delta);
    say(`Movido para ${layerLabel(moveTarget)}.`);
    selection = Object.keys(res.delta.upsert ?? {})[0] ?? "";
    refresh();
    return true;
  }

  layerSel.addEventListener("change", () => {
    state.set(layerSel.value);
    layerSel.value = state.get();
    say(`Camada ativa: ${layerLabel(state.get())}.`);
    opts.onChange?.(state.get(), preview);
  });
  const onPreview = (): void => {
    if (role !== "host") {
      viewToggle.checked = true;
      return;
    }
    preview = viewToggle.checked;
    refresh();
    opts.onChange?.(state.get(), preview);
  };
  viewToggle.addEventListener("click", onPreview);
  viewToggle.addEventListener("change", onPreview);
  selectionSel.addEventListener("change", () => {
    selection = selectionSel.value;
  });
  moveSel.addEventListener("change", () => {
    if (isMapLayer(moveSel.value)) moveTarget = moveSel.value;
    moveSel.value = moveTarget;
  });
  moveBtn.addEventListener("click", () => {
    moveSelected();
  });

  el.append(title, layerLabelEl, viewLabel, selectionLabel, moveLabel, moveBtn, tiles, status);
  container.appendChild(el);
  refresh();

  return {
    el,
    activeLayer: () => state.get(),
    isPreview: () => preview,
    setPreview: (next: boolean) => {
      if (role !== "host") return;
      preview = next;
      viewToggle.checked = next;
      refresh();
    },
    selectedKey: () => selection,
    drop,
    refresh,
  };
}
