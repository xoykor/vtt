// Map editor panel (host-only UI): layer selector (floor/wall/asset), a
// "Colocar tile" button that runs the real host-authoritative
// `placeTile(map, tile, "host")` and fires `onPlace` with the placed
// tile, plus a live list of the tiles currently on the map for the
// selected layer. Pure DOM, no canvas; deltas belong to the caller
// (the app applies them via `room.apply(delta)`).
// No central server; no WotC art.

import { placeTile, type GameMap, type Tile } from "../map/editor";

export type PlaceHandler = (tile: Tile) => void;

const LAYERS = ["floor", "wall", "asset"] as const;
const DEFAULT_ASSET = "default";

/** First empty cell for `layer` in scan order (y, then x), or null when full. */
function firstEmptyCell(map: GameMap, layer: string): { x: number; y: number } | null {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const occupied = Object.prototype.hasOwnProperty.call(
        map.tiles,
        `tile:${layer}:${x},${y}`,
      );
      if (!occupied) return { x, y };
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
    const prefix = `tile:${layerSel.value}:`;
    const keys = Object.keys(map.tiles)
      .filter((k) => k.startsWith(prefix))
      .sort();
    tileList.textContent = keys.length
      ? `Tiles (${layerSel.value}): ${keys.join(", ")}`
      : `Nenhum tile na camada ${layerSel.value}.`;
  }

  placeBtn.addEventListener("click", () => {
    const layer = layerSel.value;
    const pos = firstEmptyCell(map, layer);
    if (!pos) return;
    const tile: Tile = { x: pos.x, y: pos.y, layer, asset: DEFAULT_ASSET };
    const res = placeTile(map, tile, "host");
    if (!res.ok) return;
    onPlace(tile);
    renderTileList();
  });

  layerSel.addEventListener("change", renderTileList);

  renderTileList();
  container.append(title, layerSel, placeBtn, tileList);
}
