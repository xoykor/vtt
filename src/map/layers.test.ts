import { expect, test } from "vitest";
import { encodeTile, tileKey, type GameMap, type Tile } from "./editor";
import {
  BACKGROUND_LAYER,
  decodeMapInfo,
  encodeMapInfo,
  GM_LAYER,
  isLayerVisible,
  isMapLayer,
  layerLabel,
  MAP_INFO_KEY,
  MAP_LAYERS,
  mapFromState,
  PLAYER_LAYER,
  visibleLayers,
  visibleTiles,
} from "./layers";

/** Map with one tile on each of the three layers, all at (1,2). */
function layeredMap(): GameMap {
  const tiles: Record<string, string> = {};
  for (const layer of MAP_LAYERS) {
    const tile: Tile = { x: 1, y: 2, layer, asset: `${layer}-asset` };
    tiles[tileKey(tile)] = encodeTile(tile);
  }
  return { width: 8, height: 8, tiles };
}

test("the three layers are background, gm and player in draw order", () => {
  expect(MAP_LAYERS).toEqual(["fundo", "gm", "player"]);
  expect(BACKGROUND_LAYER).toBe("fundo");
  expect(GM_LAYER).toBe("gm");
  expect(PLAYER_LAYER).toBe("player");
});

test("isMapLayer accepts the three layers and rejects foreign ones", () => {
  for (const layer of MAP_LAYERS) expect(isMapLayer(layer)).toBe(true);
  // The phase-2 editor layers are NOT map layers: they do not exist here.
  for (const layer of ["floor", "wall", "asset", "", "Fundo"]) {
    expect(isMapLayer(layer)).toBe(false);
  }
});

test("host sees every layer", () => {
  expect(visibleLayers("host")).toEqual(["fundo", "gm", "player"]);
  for (const layer of MAP_LAYERS) {
    expect(isLayerVisible("host", layer)).toBe(true);
  }
});

test("player sees the player layer and the background, never the gm layer", () => {
  expect(visibleLayers("player")).toEqual(["fundo", "player"]);
  expect(isLayerVisible("player", "gm")).toBe(false);
  // `guest` is the protocol name for a joined player: same visibility.
  expect(visibleLayers("guest")).toEqual(["fundo", "player"]);
  expect(isLayerVisible("guest", "gm")).toBe(false);
});

test("gm sees the gm layer (plus the shared background)", () => {
  expect(visibleLayers("gm")).toContain("gm");
  expect(visibleLayers("gm")).toContain("fundo");
  expect(isLayerVisible("gm", "player")).toBe(false);
});

test("unknown role sees nothing (fail-closed)", () => {
  for (const role of ["", "ghost", "HOST", "mestre"]) {
    expect(visibleLayers(role)).toEqual([]);
    expect(isLayerVisible(role, "fundo")).toBe(false);
  }
});

test("isLayerVisible never reports a foreign layer as visible", () => {
  expect(isLayerVisible("host", "floor")).toBe(false);
  expect(isLayerVisible("host", "")).toBe(false);
});

test("layerLabel names the layers in pt-BR and passes unknowns through", () => {
  expect(layerLabel(BACKGROUND_LAYER)).toBe("Fundo");
  expect(layerLabel(GM_LAYER)).toMatch(/[Mm]estre/);
  expect(layerLabel(PLAYER_LAYER)).toBe("Jogadores");
  expect(layerLabel("floor")).toBe("floor");
});

test("visibleTiles hides the gm layer from players, in draw order", () => {
  const map = layeredMap();

  const asHost = visibleTiles(map, "host");
  expect(asHost.map((t) => t.layer)).toEqual(["fundo", "gm", "player"]);

  const asPlayer = visibleTiles(map, "player");
  expect(asPlayer.map((t) => t.layer)).toEqual(["fundo", "player"]);

  const asGm = visibleTiles(map, "gm");
  expect(asGm.map((t) => t.layer)).toEqual(["fundo", "gm"]);

  expect(visibleTiles(map, "ghost")).toEqual([]);
});

test("visibleTiles orders by layer, then y, then x", () => {
  const tiles: Record<string, string> = {};
  const add = (tile: Tile): void => {
    tiles[tileKey(tile)] = encodeTile(tile);
  };
  add({ x: 3, y: 1, layer: PLAYER_LAYER, asset: "p-a" });
  add({ x: 0, y: 4, layer: PLAYER_LAYER, asset: "p-b" });
  add({ x: 2, y: 2, layer: PLAYER_LAYER, asset: "p-c" });
  add({ x: 5, y: 5, layer: BACKGROUND_LAYER, asset: "bg" });
  add({ x: 0, y: 0, layer: GM_LAYER, asset: "gm" });

  expect(visibleTiles({ width: 8, height: 8, tiles }, "host")).toEqual([
    { x: 5, y: 5, layer: BACKGROUND_LAYER, asset: "bg" },
    { x: 0, y: 0, layer: GM_LAYER, asset: "gm" },
    { x: 3, y: 1, layer: PLAYER_LAYER, asset: "p-a" },
    { x: 2, y: 2, layer: PLAYER_LAYER, asset: "p-c" },
    { x: 0, y: 4, layer: PLAYER_LAYER, asset: "p-b" },
  ]);
});

test("visibleTiles skips malformed entries and non-canonical keys", () => {
  const map = layeredMap();
  map.tiles["tile:player:9,9"] = encodeTile({ x: 9, y: 9, layer: "player", asset: "smuggled" });
  map.tiles["tile:player:0,0"] = "{ not json";
  // A gm tile parked under a player key must not reach a player.
  map.tiles["tile:player:1,1"] = encodeTile({ x: 1, y: 1, layer: "gm", asset: "smuggled" });

  const asPlayer = visibleTiles(map, "player");
  expect(asPlayer.every((t) => t.layer === "player" || t.layer === "fundo")).toBe(true);
  expect(asPlayer.map((t) => t.asset)).not.toContain("smuggled");
  expect(asPlayer).toHaveLength(2);
});

test("map info round-trips through the room state", () => {
  expect(MAP_INFO_KEY).toBe("map:info");
  expect(decodeMapInfo(encodeMapInfo({ width: 12, height: 7 }))).toEqual({
    width: 12,
    height: 7,
  });
});

test("decodeMapInfo rejects anything that is not a usable size", () => {
  expect(decodeMapInfo("{ not json")).toBeNull();
  expect(decodeMapInfo("{}")).toBeNull();
  expect(decodeMapInfo('{"width":0,"height":5}')).toBeNull();
  expect(decodeMapInfo('{"width":5,"height":-1}')).toBeNull();
  expect(decodeMapInfo('{"width":5,"height":"5"}')).toBeNull();
  expect(decodeMapInfo('{"width":5.5,"height":5}')).toBeNull();
  expect(decodeMapInfo("null")).toBeNull();
});

test("mapFromState keeps only canonical tile entries under the given size", () => {
  const state: Record<string, string> = {
    "token:p1": encodeTile({ x: 0, y: 0, layer: "player", asset: "not-a-token" }),
    "tile:fundo:0,0": encodeTile({ x: 0, y: 0, layer: "fundo", asset: "bg" }),
    "tile:gm:1,0": encodeTile({ x: 1, y: 0, layer: "gm", asset: "note" }),
    "roll:r1": '{"sides":20}',
    // Malformed json and a key that does not address its own tile.
    "tile:player:0,1": "{ not json",
    "tile:player:0,2": encodeTile({ x: 5, y: 5, layer: "player", asset: "wrong-key" }),
  };

  const map = mapFromState(8, 8, state);
  expect(map.width).toBe(8);
  expect(map.height).toBe(8);
  expect(Object.keys(map.tiles).sort()).toEqual(["tile:fundo:0,0", "tile:gm:1,0"]);
  expect(visibleTiles(map, "player").map((t) => t.asset)).toEqual(["bg"]);
  expect(visibleTiles(map, "host").map((t) => t.asset)).toEqual(["bg", "note"]);
});

test("mapFromState on an empty room state yields an empty map", () => {
  const map = mapFromState(4, 3, {});
  expect(map).toEqual({ width: 4, height: 3, tiles: {} });
});
