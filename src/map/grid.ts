// Grid + canvas coordinates (pure, hermetic). Cells are unit squares:
// cell (x, y) spans [x, x+1] x [y, y+1]; its center is (x+0.5, y+0.5).

export interface Point {
  x: number;
  y: number;
}

export interface Grid {
  width: number;
  height: number;
}

export function createGrid(width: number, height: number): Grid {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`invalid width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`invalid height: ${height}`);
  }
  return { width, height };
}

export function inBounds(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function toIndex(grid: Grid, x: number, y: number): number {
  if (!inBounds(grid, x, y)) {
    throw new Error(`out of bounds: ${x},${y}`);
  }
  return y * grid.width + x;
}

export function cellCenter(x: number, y: number): Point {
  return { x: x + 0.5, y: y + 0.5 };
}
