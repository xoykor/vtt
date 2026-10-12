// Map layers for the master editor: background (`fundo`), GM-only
// (`gm`) and player-visible (`player`). They are plain strings on
// purpose: the editor rule in src/map/editor.ts addresses tiles as
// `tile:<layer>:<x>,<y>`, so a layer plugs straight into `tileKey`,
// `encodeTile`/`decodeTile`, `placeTile` and `applyDelta` unchanged.
// Visibility is a VIEW concern only — every peer still receives the
// same RoomState partition and draws what its role may see
// (fail-closed: unknown roles see nothing).
// No central server; no WotC art.

import { decodeTile, tileKey, type GameMap, type Tile } from "./editor";

/** Draw order: background first, GM overlay, then the player layer. */
export const MAP_LAYERS = ["fundo", "gm", "player"] as const;

export type MapLayer = (typeof MAP_LAYERS)[number];

/** Shared map image: everyone sees it. */
export const BACKGROUND_LAYER: MapLayer = "fundo";
/** GM-only notes/traps: never drawn for players. */
export const GM_LAYER: MapLayer = "gm";
/** What the players see and move on. */
export const PLAYER_LAYER: MapLayer = "player";

const LAYER_LABELS: Record<MapLayer, string> = {
  fundo: "Fundo",
  gm: "Mestre (GM)",
  player: "Jogadores",
};

/** True when `layer` is one of the three map layers. */
export function isMapLayer(layer: string): layer is MapLayer {
  return (MAP_LAYERS as readonly string[]).includes(layer);
}

/**
 * Layers `role` may see, in draw order. The host (the master running
 * the table) sees all three; a `gm` screen sees its own layer plus the
 * shared background; a `player`/`guest` sees the player layer plus the
 * background. Any other role sees nothing — fail-closed.
 */
export function visibleLayers(role: string): MapLayer[] {
  switch (role) {
    case "host":
      return [...MAP_LAYERS];
    case "gm":
      return [BACKGROUND_LAYER, GM_LAYER];
    case "player":
    case "guest":
      return [BACKGROUND_LAYER, PLAYER_LAYER];
    default:
      return [];
  }
}

/** True when `role` may see `layer` (foreign layer names never are). */
export function isLayerVisible(role: string, layer: string): boolean {
  return isMapLayer(layer) && visibleLayers(role).includes(layer);
}

/** UI label for a layer (pt-BR, like the other shell strings). */
export function layerLabel(layer: string): string {
  return isMapLayer(layer) ? LAYER_LABELS[layer] : layer;
}

/** Position of `layer` in the draw order (foreign layers go last). */
function layerOrder(layer: string): number {
  const idx = (MAP_LAYERS as readonly string[]).indexOf(layer);
  return idx === -1 ? MAP_LAYERS.length : idx;
}

/**
 * Tiles of `map` that `role` may see, ordered for drawing (layer draw
 * order, then y, then x). Entries whose key is not the canonical
 * `tile:<layer>:<x>,<y>` address of their own tile, entries outside the
 * grid and entries with malformed JSON are all skipped: a broken or
 * hostile snapshot cannot smuggle a tile into a layer the role should
 * not see, nor outside the grid it was written for.
 */
export function visibleTiles(map: GameMap, role: string): Tile[] {
  const allowed = new Set<string>(visibleLayers(role));
  const tiles: Tile[] = [];
  for (const [key, json] of Object.entries(map.tiles)) {
    let tile: Tile;
    try {
      tile = decodeTile(json);
    } catch {
      continue;
    }
    if (tileKey(tile) !== key) continue;
    if (tile.x < 0 || tile.y < 0) continue;
    if (tile.x >= map.width || tile.y >= map.height) continue;
    if (!allowed.has(tile.layer)) continue;
    tiles.push(tile);
  }
  return tiles.sort(
    (a, b) =>
      layerOrder(a.layer) - layerOrder(b.layer) || a.y - b.y || a.x - b.x,
  );
}

/** RoomState key holding the map descriptor (`{"width":W,"height":H}`). */
export const MAP_INFO_KEY = "map:info";

export interface MapInfo {
  width: number;
  height: number;
}

/** Serialize a map descriptor as a RoomState value. */
export function encodeMapInfo(info: MapInfo): string {
  return JSON.stringify({ width: info.width, height: info.height });
}

/** Parse a map descriptor, or null when it is not a usable size. */
export function decodeMapInfo(json: string): MapInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { width, height } = raw as Record<string, unknown>;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if ((width as number) < 1 || (height as number) < 1) return null;
  return { width: width as number, height: height as number };
}

/**
 * Rebuild a `GameMap` view over the `tile:*` partition of a RoomState
 * snapshot. Non-tile keys (tokens, rolls, sheets, map info) and
 * malformed or non-canonical tile entries are dropped; the geometry
 * comes from the caller, since the grid is not part of the partition.
 */
export function mapFromState(
  width: number,
  height: number,
  state: Record<string, string>,
): GameMap {
  const tiles: Record<string, string> = {};
  for (const [key, json] of Object.entries(state)) {
    if (!key.startsWith("tile:")) continue;
    try {
      if (tileKey(decodeTile(json)) !== key) continue;
    } catch {
      continue;
    }
    tiles[key] = json;
  }
  return { width, height, tiles };
}
