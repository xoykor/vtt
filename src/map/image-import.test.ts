import { expect, test, vi } from "vitest";
import { applyDelta } from "../net/peer";
import { assetHash, decodeTile, tileKey } from "./editor";
import {
  blobToBytes,
  importImageBlob,
  rasterToDelta,
  rasterToImport,
  type RasterImage,
} from "./image-import";

// 4x4 fixture with solid 2x2 quadrants: red | green / blue | white.
// Downscaling to 2x2 must recover exactly one quadrant color per cell.
function quadrantRaster(): RasterImage {
  const quads: Array<[number, number, number, number]> = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ];
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const q = (y < 2 ? 0 : 2) + (x < 2 ? 0 : 1);
      pixels.set(quads[q], (y * 4 + x) * 4);
    }
  }
  return { width: 4, height: 4, pixels };
}

function solidRaster(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): RasterImage {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) pixels.set(rgba, i * 4);
  return { width: w, height: h, pixels };
}

test("raster downscales to one tile per grid cell with hashed assets", () => {
  const { delta, tiles, assets } = rasterToImport(
    quadrantRaster(),
    2,
    2,
    "fundo",
  );

  expect(tiles).toHaveLength(4);
  const at = (x: number, y: number): string => {
    const tile = tiles.find((t) => t.x === x && t.y === y);
    if (!tile) throw new Error(`missing tile ${x},${y}`);
    return tile.asset;
  };
  expect(at(0, 0)).toBe(assetHash(new Uint8Array([255, 0, 0, 255])));
  expect(at(1, 0)).toBe(assetHash(new Uint8Array([0, 255, 0, 255])));
  expect(at(0, 1)).toBe(assetHash(new Uint8Array([0, 0, 255, 255])));
  expect(at(1, 1)).toBe(assetHash(new Uint8Array([255, 255, 255, 255])));

  // The delta is room-ready: canonical keys, decodable tiles, applies clean.
  const keys = Object.keys(delta.upsert ?? {});
  expect(keys.sort()).toEqual([
    "tile:fundo:0,0",
    "tile:fundo:0,1",
    "tile:fundo:1,0",
    "tile:fundo:1,1",
  ]);
  const next = applyDelta({}, delta);
  expect(Object.keys(next).sort()).toEqual(keys.sort());
  for (const [key, json] of Object.entries(next)) {
    const tile = decodeTile(json);
    expect(tileKey(tile)).toBe(key);
    expect(tile.layer).toBe("fundo");
  }
  expect(delta).toEqual(rasterToDelta(quadrantRaster(), 2, 2, "fundo"));

  // Asset bytes travel with the import, keyed by their hash.
  expect(assets.size).toBe(4);
  expect(assets.get(at(0, 0))).toEqual(new Uint8Array([255, 0, 0, 255]));
});

test("uniform raster keeps one tile per cell but a single asset", () => {
  const { tiles, assets, delta } = rasterToImport(
    solidRaster(4, 4, [10, 20, 30, 255]),
    2,
    2,
    "player",
  );
  expect(tiles).toHaveLength(4);
  expect(assets.size).toBe(1);
  expect(Object.keys(delta.upsert ?? {})).toHaveLength(4);
});

test("import rejects bad geometry, pixel length and foreign layers", () => {
  const raster = quadrantRaster();
  expect(() => rasterToDelta(raster, 0, 2, "fundo")).toThrow();
  expect(() => rasterToDelta(raster, 2, -1, "fundo")).toThrow();
  expect(() => rasterToDelta(raster, 2.5, 2, "fundo")).toThrow();
  expect(() => rasterToDelta({ ...raster, width: 0 }, 2, 2, "fundo")).toThrow();
  expect(
    () => rasterToDelta({ ...raster, pixels: new Uint8Array(3) }, 2, 2, "fundo"),
  ).toThrow();
  // Only the three map layers accept imported tiles.
  for (const layer of ["floor", "wall", "asset", "", "Fundo"]) {
    expect(() => rasterToDelta(raster, 2, 2, layer)).toThrow();
  }
  expect(() => rasterToDelta(raster, 2, 2, "gm")).not.toThrow();
});

test("blobToBytes reads the raw file bytes", async () => {
  await expect(blobToBytes(new Blob(["abc"]))).resolves.toEqual(
    new Uint8Array([97, 98, 99]),
  );
});

test("importImageBlob decodes file bytes into a room-ready delta", async () => {
  const seen: Uint8Array[] = [];
  const result = await importImageBlob(
    new Blob(["fake-image-bytes"]),
    2,
    2,
    "player",
    async (bytes) => {
      seen.push(bytes);
      return solidRaster(2, 2, [1, 2, 3, 255]);
    },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual(new TextEncoder().encode("fake-image-bytes"));
  expect(result.tiles).toHaveLength(4);
  expect(result.tiles.every((t) => t.layer === "player")).toBe(true);
  const next = applyDelta({}, result.delta);
  expect(Object.keys(next)).toHaveLength(4);
  for (const [key, json] of Object.entries(next)) {
    expect(tileKey(decodeTile(json))).toBe(key);
  }
});

test("importImageBlob fails fast without reading when args are bad", async () => {
  const decode = vi.fn(async () => solidRaster(2, 2, [0, 0, 0, 255]));
  await expect(
    importImageBlob(new Blob(["x"]), 2, 2, "floor", decode),
  ).rejects.toThrow();
  await expect(
    importImageBlob(new Blob(["x"]), 0, 2, "fundo", decode),
  ).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});

test("importImageBlob propagates decoder failures", async () => {
  await expect(
    importImageBlob(new Blob(["x"]), 2, 2, "fundo", async () => {
      throw new Error("not an image");
    }),
  ).rejects.toThrow(/not an image/);
});
