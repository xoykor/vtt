// Image-to-grid import: a File/Blob becomes one tile per grid cell.
// The image is downscaled to the grid with a box filter (each cell
// averages its source rect), every cell's RGBA average is hashed with
// the existing `assetHash` from src/map/editor.ts, and the tiles come
// back as a Delta that applies via `room.apply`/`applyDelta` — the
// same ordered-TCP path as `placeTile`. Only the three layers from
// src/map/layers.ts are accepted. Pure except for the Blob byte read
// and the browser image decoder (injectable, so tests stay hermetic).
// No central server; no WotC art.

import type { Delta } from "../net/peer";
import {
  assetHash,
  encodeTile,
  tileKey,
  type Tile,
} from "./editor";
import { isMapLayer } from "./layers";

/** Decoded RGBA image: row-major bytes, 4 per pixel. */
export interface RasterImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Turns raw file bytes into a raster (browser canvas by default). */
export type ImageDecoder = (bytes: Uint8Array) => Promise<RasterImage>;

/** One imported cell: the tile plus the exact bytes its asset hashes. */
interface CellImport {
  tile: Tile;
  bytes: Uint8Array;
}

/** Tiles + the delta to broadcast + the asset bytes keyed by hash. */
export interface ImageImportResult {
  tiles: Tile[];
  delta: Delta;
  assets: Map<string, Uint8Array>;
}

function checkSize(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

function checkRaster(raster: RasterImage): void {
  if (raster === null || typeof raster !== "object") {
    throw new Error("missing image");
  }
  checkSize(raster.width, "image width");
  checkSize(raster.height, "image height");
  if (
    !(raster.pixels instanceof Uint8Array) ||
    raster.pixels.length !== raster.width * raster.height * 4
  ) {
    throw new Error(
      `bad pixel length: ${raster.pixels?.length ?? "missing"} for ${raster.width}x${raster.height}`,
    );
  }
}

function checkGrid(mapWidth: number, mapHeight: number, layer: string): void {
  checkSize(mapWidth, "map width");
  checkSize(mapHeight, "map height");
  if (!isMapLayer(layer)) {
    throw new Error(`unknown layer: ${layer}`);
  }
}

/** Average RGBA of the source rect covered by grid cell (gx, gy). */
function cellAverage(
  raster: RasterImage,
  mapWidth: number,
  mapHeight: number,
  gx: number,
  gy: number,
): Uint8Array {
  const x0 = Math.floor((gx * raster.width) / mapWidth);
  const x1 = Math.max(
    x0 + 1,
    Math.ceil(((gx + 1) * raster.width) / mapWidth),
  );
  const y0 = Math.floor((gy * raster.height) / mapHeight);
  const y1 = Math.max(
    y0 + 1,
    Math.ceil(((gy + 1) * raster.height) / mapHeight),
  );
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let y = y0; y < Math.min(y1, raster.height); y++) {
    for (let x = x0; x < Math.min(x1, raster.width); x++) {
      const i = (y * raster.width + x) * 4;
      r += raster.pixels[i];
      g += raster.pixels[i + 1];
      b += raster.pixels[i + 2];
      a += raster.pixels[i + 3];
      n++;
    }
  }
  return new Uint8Array([
    Math.round(r / n),
    Math.round(g / n),
    Math.round(b / n),
    Math.round(a / n),
  ]);
}

/** Downscale `raster` to the grid: one tile per cell on `layer`. */
function rasterToCells(
  raster: RasterImage,
  mapWidth: number,
  mapHeight: number,
  layer: string,
): CellImport[] {
  checkRaster(raster);
  checkGrid(mapWidth, mapHeight, layer);
  const cells: CellImport[] = [];
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const bytes = cellAverage(raster, mapWidth, mapHeight, x, y);
      cells.push({ tile: { x, y, layer, asset: assetHash(bytes) }, bytes });
    }
  }
  return cells;
}

/** One tile per grid cell, in scan order (y, then x). */
export function rasterToTiles(
  raster: RasterImage,
  mapWidth: number,
  mapHeight: number,
  layer: string,
): Tile[] {
  return rasterToCells(raster, mapWidth, mapHeight, layer).map((c) => c.tile);
}

/** Tiles as a RoomState delta (`tile:<layer>:<x>,<y>` -> JSON tile). */
export function tilesToDelta(tiles: Tile[]): Delta {
  const upsert: Record<string, string> = {};
  for (const tile of tiles) {
    upsert[tileKey(tile)] = encodeTile(tile);
  }
  return { upsert };
}

/** Downscale `raster` straight to a delta ready for `room.apply`. */
export function rasterToDelta(
  raster: RasterImage,
  mapWidth: number,
  mapHeight: number,
  layer: string,
): Delta {
  return tilesToDelta(rasterToTiles(raster, mapWidth, mapHeight, layer));
}

/**
 * Downscale `raster` to tiles + delta + the per-hash asset bytes.
 * Uniform areas share one asset entry; every cell still gets a tile.
 */
export function rasterToImport(
  raster: RasterImage,
  mapWidth: number,
  mapHeight: number,
  layer: string,
): ImageImportResult {
  const cells = rasterToCells(raster, mapWidth, mapHeight, layer);
  const assets = new Map<string, Uint8Array>();
  for (const { tile, bytes } of cells) {
    if (!assets.has(tile.asset)) assets.set(tile.asset, bytes.slice());
  }
  return {
    tiles: cells.map((c) => c.tile),
    delta: tilesToDelta(cells.map((c) => c.tile)),
    assets,
  };
}

/** Raw bytes of a File/Blob (`arrayBuffer` with a FileReader fallback). */
export function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error("unreadable file"));
    };
    reader.onerror = () => reject(new Error("unreadable file"));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Browser decoder: file bytes -> RGBA via `createImageBitmap` (or an
 * `<img>` + canvas fallback). Throws outside a browser canvas env —
 * pass a custom `decoder` to `importImageBlob` there (tests do).
 */
export async function defaultDecodeImage(bytes: Uint8Array): Promise<RasterImage> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error("image decoding requires a browser canvas");
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/*" });
  let bitmap: ImageBitmap | HTMLImageElement;
  if (typeof createImageBitmap === "function") {
    bitmap = await createImageBitmap(blob);
  } else {
    const url = URL.createObjectURL(blob);
    try {
      bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("not an image"));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("image decoding requires a browser canvas");
  ctx.drawImage(bitmap, 0, 0);
  const release = bitmap as Partial<ImageBitmap>;
  if (typeof release.close === "function") release.close();
  const data = ctx.getImageData(0, 0, width, height);
  return { width, height, pixels: new Uint8Array(data.data) };
}

/**
 * Full import: File/Blob -> tiles on `layer` for a
 * `mapWidth`x`mapHeight` grid. Args validate BEFORE any byte is read
 * (fail fast); decoding uses `decoder` or the browser default.
 */
export async function importImageBlob(
  blob: Blob,
  mapWidth: number,
  mapHeight: number,
  layer: string,
  decoder: ImageDecoder = defaultDecodeImage,
): Promise<ImageImportResult> {
  checkGrid(mapWidth, mapHeight, layer);
  if (blob === null || typeof blob !== "object") {
    throw new Error("missing file");
  }
  const bytes = await blobToBytes(blob);
  const raster = await decoder(bytes);
  return rasterToImport(raster, mapWidth, mapHeight, layer);
}
