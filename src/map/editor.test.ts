import { expect, test } from "vitest";
import { applyDelta } from "../net/peer";
import {
  assetHash,
  cacheAsset,
  createAssetCache,
  createMap,
  decodeTile,
  getAsset,
  placeTile,
  tileKey,
  type GameMap,
  type Tile,
} from "./editor";

// Fixtures herméticas: mapa 8x8 vazio e um tile de chão. `clientMap`
// simula o snapshot local de um cliente sem papel host.
function emptyMap(): GameMap {
  return createMap(8, 8);
}

const tile: Tile = { x: 2, y: 3, layer: "ground", asset: "grass" };
const clientMap: GameMap = emptyMap();

test("only host delta writes tiles", () => {
  expect(placeTile(clientMap, tile, "player").ok).toBe(false);
});

test("host place returns delta that applies to the snapshot", () => {
  const map = emptyMap();
  const res = placeTile(map, tile, "host");
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("host place must succeed");
  const next = applyDelta(map.tiles, res.delta);
  expect(next[tileKey(tile)]).toBe(JSON.stringify(tile));
  expect(decodeTile(next[tileKey(tile)])).toEqual(tile);
  // Pure: o mapa de entrada não é mutado.
  expect(map.tiles).toEqual({});
});

test("host place rejects out-of-bounds tiles", () => {
  const map = emptyMap();
  expect(placeTile(map, { ...tile, x: 8 }, "host").ok).toBe(false);
  expect(placeTile(map, { ...tile, layer: "" }, "host").ok).toBe(false);
  expect(map.tiles).toEqual({});
});

test("host place with missing fields returns ok:false without throwing", () => {
  const map = emptyMap();
  const noLayer = { x: 2, y: 3, asset: "grass" } as unknown as Tile;
  const noAsset = { x: 2, y: 3, layer: "ground" } as unknown as Tile;
  expect(() => placeTile(map, noLayer, "host")).not.toThrow();
  expect(() => placeTile(map, noAsset, "host")).not.toThrow();
  expect(placeTile(map, noLayer, "host").ok).toBe(false);
  expect(placeTile(map, noAsset, "host").ok).toBe(false);
  expect(() =>
    placeTile(map, null as unknown as Tile, "host"),
  ).not.toThrow();
  expect(placeTile(map, null as unknown as Tile, "host").ok).toBe(false);
  expect(map.tiles).toEqual({});
});

test("assetHash matches the SHA-256 test vector", () => {
  const abc = new TextEncoder().encode("abc");
  expect(assetHash(abc)).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(assetHash(new Uint8Array(0))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("asset cache stores bytes under their hash", () => {
  const cache = createAssetCache();
  const bytes = new TextEncoder().encode("grass pixels");
  const hash = cacheAsset(cache, bytes);
  expect(hash).toBe(assetHash(bytes));
  expect(getAsset(cache, hash)).toEqual(bytes);
  expect(getAsset(cache, "deadbeef")).toBeUndefined();
});

test("getAsset returns a copy; mutating it or the input cannot poison the cache", () => {
  const cache = createAssetCache();
  const bytes = new TextEncoder().encode("grass pixels");
  const hash = cacheAsset(cache, bytes);
  // Mutating the caller's input after store must not affect the cache.
  bytes[0] = 0xff;
  expect(getAsset(cache, hash)).toEqual(new TextEncoder().encode("grass pixels"));
  // Mutating the returned view must not affect the cache.
  const first = getAsset(cache, hash);
  if (first === undefined) throw new Error("cache miss");
  first[0] = 0x00;
  expect(getAsset(cache, hash)).toEqual(
    new TextEncoder().encode("grass pixels"),
  );
});
