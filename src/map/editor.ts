// Map editor with tiles and layers (pure, hermetic). Only the host
// writes tiles: placeTile returns a Delta to broadcast over ordered TCP
// (host-authoritative, global constraint), while any non-host role gets
// `ok: false` (fail-closed). Tiles travel as one JSON value per key so
// deltas apply directly via applyDelta from src/net/peer.ts, mirroring
// src/map/tokens.ts. Assets are addressed by SHA-256 hex (assetHash)
// with a local cache; no central server.

import type { Delta } from "../net/peer";

export interface Tile {
  x: number;
  y: number;
  layer: string;
  asset: string;
}

/**
 * Map snapshot: dimensions plus tiles as `tileKey -> JSON Tile`, a
 * RoomState partition so host deltas apply via `applyDelta`.
 */
export interface GameMap {
  width: number;
  height: number;
  tiles: Record<string, string>;
}

export type PlaceResult =
  | { ok: true; delta: Delta }
  | { ok: false; error: string };

export function createMap(width: number, height: number): GameMap {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`invalid width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`invalid height: ${height}`);
  }
  return { width, height, tiles: {} };
}

/** Canonical key for a tile: `tile:<layer>:<x>,<y>`. */
export function tileKey(tile: Tile): string {
  return `tile:${tile.layer}:${tile.x},${tile.y}`;
}

export function encodeTile(tile: Tile): string {
  return JSON.stringify(tile);
}

export function decodeTile(json: string): Tile {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.x !== "number") throw new Error("missing field: x");
  if (typeof raw.y !== "number") throw new Error("missing field: y");
  if (typeof raw.layer !== "string" || raw.layer.length === 0) {
    throw new Error("missing field: layer");
  }
  if (typeof raw.asset !== "string" || raw.asset.length === 0) {
    throw new Error("missing field: asset");
  }
  return { x: raw.x, y: raw.y, layer: raw.layer, asset: raw.asset };
}

/**
 * Place `tile` on `map`, returning the delta to broadcast. Only the
 * `host` role writes; every other role (e.g. `player`) is denied with
 * `ok: false`. Pure: `map` is not mutated.
 */
export function placeTile(
  map: GameMap,
  tile: Tile,
  role: string,
): PlaceResult {
  if (role !== "host") {
    return { ok: false, error: `forbidden role: ${role}` };
  }
  if (map === null || typeof map !== "object") {
    return { ok: false, error: "missing map" };
  }
  if (tile === null || typeof tile !== "object") {
    return { ok: false, error: "missing tile" };
  }
  if (
    !Number.isInteger(tile.x) ||
    !Number.isInteger(tile.y) ||
    tile.x < 0 ||
    tile.y < 0 ||
    tile.x >= map.width ||
    tile.y >= map.height
  ) {
    return { ok: false, error: `out of bounds: ${tile.x},${tile.y}` };
  }
  if (typeof tile.layer !== "string" || tile.layer.length === 0) {
    return { ok: false, error: "missing field: layer" };
  }
  if (typeof tile.asset !== "string" || tile.asset.length === 0) {
    return { ok: false, error: "missing field: asset" };
  }
  const placed: Tile = {
    x: tile.x,
    y: tile.y,
    layer: tile.layer,
    asset: tile.asset,
  };
  return { ok: true, delta: { upsert: { [tileKey(placed)]: encodeTile(placed) } } };
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * SHA-256 of `bytes` as lowercase hex. Manual implementation (no new
 * dependencies) matching `asset_hash` in src-tauri/src/assets.rs.
 */
export function assetHash(bytes: Uint8Array): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  const w = new Array<number>(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(off + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** Local asset cache: hash hex -> bytes. Plain Map, no dependencies. */
export function createAssetCache(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>();
}

/** Store `bytes` under its hash; returns the hash. */
export function cacheAsset(
  cache: Map<string, Uint8Array>,
  bytes: Uint8Array,
): string {
  const hash = assetHash(bytes);
  cache.set(hash, bytes.slice());
  return hash;
}

/** Fetch cached bytes by hash, or `undefined` on cache miss. */
export function getAsset(
  cache: Map<string, Uint8Array>,
  hash: string,
): Uint8Array | undefined {
  return cache.get(hash);
}
