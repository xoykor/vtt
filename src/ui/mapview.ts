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

/** Draw the map frame onto `canvas` (resizes it to grid*cellPx). */
export function renderMapView(
  canvas: HTMLCanvasElement,
  data: MapViewData,
  cellPx: number = CELL,
): void {
  const { grid, tokens } = data;
  const fog = data.fog ?? new Array(grid.width * grid.height).fill(true);
  const lit = data.lit ?? new Array(grid.width * grid.height).fill(true);
  const unit = cellPx > 0 ? cellPx : CELL;
  canvas.width = grid.width * unit;
  canvas.height = grid.height * unit;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#1a1a22";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      if (lit[i]) {
        ctx.fillStyle = "#2a2a35";
        ctx.fillRect(x * unit, y * unit, unit, unit);
      }
    }
  }

  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  for (let x = 0; x <= grid.width; x++) {
    ctx.beginPath();
    ctx.moveTo(x * unit, 0);
    ctx.lineTo(x * unit, grid.height * unit);
    ctx.stroke();
  }
  for (let y = 0; y <= grid.height; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * unit);
    ctx.lineTo(grid.width * unit, y * unit);
    ctx.stroke();
  }

  const palette = ["#e0a030", "#30a0e0", "#40c040", "#c040c0", "#e05050", "#20c0c0"];
  tokens.forEach((token, n) => {
    const cx = (token.pos.x + 0.5) * unit;
    const cy = (token.pos.y + 0.5) * unit;
    ctx.beginPath();
    ctx.arc(cx, cy, unit * 0.35, 0, Math.PI * 2);
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
        ctx.fillRect(x * unit, y * unit, unit, unit);
      }
    }
  }
}

/** Convert a canvas click to integer cell coordinates, or null outside. */
export function eventToCell(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  cellPx: number = CELL,
): { x: number; y: number } | null {
  const unit = cellPx > 0 ? cellPx : CELL;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / unit);
  const y = Math.floor((clientY - rect.top) / unit);
  if (x < 0 || y < 0) return null;
  if (x * unit >= canvas.width || y * unit >= canvas.height) return null;
  return { x, y };
}
