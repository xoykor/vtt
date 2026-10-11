// Canvas map view: grid + fog + light + tokens (2D canvas, no WebGL,
// no art assets — tokens are labeled circles). Consumes the ready
// map/* primitives for geometry only; drawing itself is local.
// No central server.

import type { Grid } from "../map/grid";
import type { Token } from "../map/tokens";

export interface MapViewData {
  grid: Grid;
  tokens: Token[];
  /** Row-major fog mask (true = visible). Defaults to all visible. */
  fog?: boolean[];
  /** Row-major light mask (true = lit). Defaults to all lit. */
  lit?: boolean[];
}

export const CELL = 32;

/** Draw the map frame onto `canvas` (resizes it to grid*CELL). */
export function renderMapView(
  canvas: HTMLCanvasElement,
  data: MapViewData,
): void {
  const { grid, tokens } = data;
  const fog = data.fog ?? new Array(grid.width * grid.height).fill(true);
  const lit = data.lit ?? new Array(grid.width * grid.height).fill(true);
  canvas.width = grid.width * CELL;
  canvas.height = grid.height * CELL;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#1a1a22";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      if (lit[i]) {
        ctx.fillStyle = "#2a2a35";
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  for (let x = 0; x <= grid.width; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, grid.height * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= grid.height; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(grid.width * CELL, y * CELL);
    ctx.stroke();
  }

  const palette = ["#e0a030", "#30a0e0", "#40c040", "#c040c0", "#e05050", "#20c0c0"];
  tokens.forEach((token, n) => {
    const cx = (token.pos.x + 0.5) * CELL;
    const cy = (token.pos.y + 0.5) * CELL;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = palette[n % palette.length];
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(token.id.slice(0, 4), cx, cy);
  });

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!fog[y * grid.width + x]) {
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }
}

/** Convert a canvas click to integer cell coordinates, or null outside. */
export function eventToCell(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / CELL);
  const y = Math.floor((clientY - rect.top) / CELL);
  if (x < 0 || y < 0) return null;
  if (x * CELL >= canvas.width || y * CELL >= canvas.height) return null;
  return { x, y };
}
