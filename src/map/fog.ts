// Fog of war as a boolean mask (pure, hermetic).
// `visible[i]` is false while cell i is under fog, true once revealed.
// revealFog never mutates its input; it returns a new Fog.

import { cellCenter, type Point } from "./grid";

export interface Fog {
  width: number;
  height: number;
  visible: boolean[];
}

export function createFog(width: number, height: number): Fog {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`invalid width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`invalid height: ${height}`);
  }
  return { width, height, visible: new Array(width * height).fill(false) };
}

/** Ray-casting point-in-polygon (even-odd rule). Pure. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Reveal the cells whose center falls inside `polygon`.
 * Cells outside the polygon keep their previous state (fog is sticky:
 * revealing never re-fogs). Pure: input fog is not mutated.
 */
export function revealFog(fog: Fog, polygon: Point[]): Fog {
  const visible = [...fog.visible];
  for (let y = 0; y < fog.height; y++) {
    for (let x = 0; x < fog.width; x++) {
      if (pointInPolygon(cellCenter(x, y), polygon)) {
        visible[y * fog.width + x] = true;
      }
    }
  }
  return { width: fog.width, height: fog.height, visible };
}
