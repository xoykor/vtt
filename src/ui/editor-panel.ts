// Map editor panel (host-only UI): layer selector (floor/wall/asset), a
// "Colocar tile" button that runs the real host-authoritative
// `placeTile(map, tile, "host")` and fires `onPlace` with the placed
// tile plus the delta to broadcast, plus a live list of the tiles
// currently on the map for the selected layer. Pure DOM, no canvas;
// the delta belongs to the caller (the app applies it via
// `applyDelta`/`room.apply`) — exactly one `placeTile` runs per click.
// No central server; no WotC art.

import { placeTile, tileKey, type GameMap, type Tile } from "../map/editor";
import type { Delta } from "../net/peer";

export type PlaceHandler = (tile: Tile, delta: Delta) => void;

const LAYERS = ["floor", "wall", "asset"] as const;
const DEFAULT_ASSET = "default";

/** First empty cell for `layer` in scan order (y, then x), or null when full. */
function firstEmptyCell(map: GameMap, layer: string): Tile | null {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const candidate: Tile = { x, y, layer, asset: DEFAULT_ASSET };
      const occupied = Object.prototype.hasOwnProperty.call(
        map.tiles,
        tileKey(candidate),
      );
      if (!occupied) return candidate;
    }
  }
  return null;
}

/** Render the editor panel into `container` for `map`. */
export function renderEditorPanel(
  container: HTMLElement,
  map: GameMap,
  onPlace: PlaceHandler,
): void {
  container.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = "Mapa";

  const layerSel = document.createElement("select");
  for (const layer of LAYERS) {
    const opt = document.createElement("option");
    opt.value = layer;
    opt.textContent = layer;
    if (layer === "floor") opt.selected = true;
    layerSel.appendChild(opt);
  }

  const placeBtn = document.createElement("button");
  placeBtn.textContent = "Colocar tile";

  const tileList = document.createElement("div");

  function renderTileList(): void {
    const layer = layerSel.value;
    const keys: string[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const key = tileKey({ x, y, layer, asset: DEFAULT_ASSET });
        if (Object.prototype.hasOwnProperty.call(map.tiles, key)) keys.push(key);
      }
    }
    tileList.textContent = keys.length
      ? `Tiles (${layer}): ${keys.join(", ")}`
      : `Nenhum tile na camada ${layer}.`;
  }

  placeBtn.addEventListener("click", () => {
    const tile = firstEmptyCell(map, layerSel.value);
    if (!tile) return;
    const res = placeTile(map, tile, "host");
    if (!res.ok) return;
    onPlace(tile, res.delta);
    renderTileList();
  });

  layerSel.addEventListener("change", renderTileList);

  renderTileList();
  container.append(title, layerSel, placeBtn, tileList);
}
