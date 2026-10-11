// Simple light via raycasting (pure, hermetic). A cell is lit when it
// lies within some source radius and the segment from the source to the
// cell center crosses no wall. Walls are per-cell booleans over the grid.

import { cellCenter, type Point } from "./grid";

export interface LightMap {
  width: number;
  height: number;
  /** walls[i] blocks sight through cell i (row-major, length w*h). */
  walls: boolean[];
}

export interface LightSource {
  pos: Point;
  radius: number;
}

function hasLineOfSight(map: LightMap, from: Point, tx: number, ty: number): boolean {
  const to = cellCenter(tx, ty);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Sample along the segment; 4 samples per cell keeps it cheap and
  // hermetic without float-line rasterization edge cases.
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist * 4));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const cx = Math.floor(from.x + dx * t);
    const cy = Math.floor(from.y + dy * t);
    // The target cell itself never blocks its own light.
    if (cx === tx && cy === ty) continue;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue;
    if (map.walls[cy * map.width + cx]) return false;
  }
  return true;
}

/**
 * Compute the lit mask for `sources` over `map` (row-major booleans,
 * true = lit). Pure: inputs are not mutated.
 */
export function computeLight(map: LightMap, sources: LightSource[]): boolean[] {
  const mask = new Array(map.width * map.height).fill(false);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const center = cellCenter(x, y);
      for (const src of sources) {
        if (Math.hypot(center.x - src.pos.x, center.y - src.pos.y) > src.radius) {
          continue;
        }
        if (hasLineOfSight(map, src.pos, x, y)) {
          mask[y * map.width + x] = true;
          break;
        }
      }
    }
  }
  return mask;
}
