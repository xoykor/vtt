// Grid config for the table view: type (square / hex-h / hex-v /
// gridless), cell size in px, line opacity + color and snapping.
// Persists to localStorage (`vtt:grid-config`) so the master's layout
// survives reloads; corrupt or missing values fall back to the
// defaults fail-closed. Pure except for the panel DOM + storage.

/** Supported grid overlays (`hex-h` = pointy-top rows, `hex-v` = columns). */
export type GridType = "square" | "hex-h" | "hex-v" | "gridless";

export interface GridConfig {
  type: GridType;
  /** Cell size in whole pixels (8..128). */
  size: number;
  /** Line opacity (0..1). */
  opacity: number;
  /** Line color as `#rrggbb`. */
  color: string;
  /** Snap placements to the grid (Ctrl temporarily disables). */
  snapping: boolean;
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  type: "square",
  size: 32,
  opacity: 0.5,
  color: "#8a8a9a",
  snapping: true,
};

/** localStorage key holding the JSON grid config. */
export const GRID_STORAGE_KEY = "vtt:grid-config";

const MIN_SIZE = 8;
const MAX_SIZE = 128;
const DEFAULT_COLOR = DEFAULT_GRID_CONFIG.color;

export function isGridType(value: unknown): value is GridType {
  return value === "square" || value === "hex-h" || value === "hex-v" || value === "gridless";
}

function saneSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GRID_CONFIG.size;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

function saneOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GRID_CONFIG.opacity;
  return Math.min(1, Math.max(0, n));
}

function saneColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

/** Merge `raw` over the defaults, repairing every invalid field. */
export function sanitizeGridConfig(raw: unknown): GridConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_GRID_CONFIG };
  const src = raw as Record<string, unknown>;
  return {
    type: isGridType(src.type) ? src.type : DEFAULT_GRID_CONFIG.type,
    size: saneSize(src.size),
    opacity: saneOpacity(src.opacity),
    color: saneColor(src.color),
    snapping: typeof src.snapping === "boolean" ? src.snapping : DEFAULT_GRID_CONFIG.snapping,
  };
}

export type GridStorage = Pick<Storage, "getItem" | "setItem">;

/** Load the persisted config (defaults when missing/corrupt/denied). */
export function loadGridConfig(storage?: GridStorage | null): GridConfig {
  if (!storage) return { ...DEFAULT_GRID_CONFIG };
  try {
    const raw = storage.getItem(GRID_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRID_CONFIG };
    return sanitizeGridConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GRID_CONFIG };
  }
}

/** Persist `cfg` (best-effort: storage errors are swallowed). */
export function saveGridConfig(storage: GridStorage | undefined | null, cfg: GridConfig): void {
  if (!storage) return;
  try {
    storage.setItem(GRID_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Private mode / denied: the table keeps working in memory.
  }
}

/**
 * Snap a pixel position to the grid. Returns the raw position when
 * snapping is off, the grid is gridless, or Ctrl is held (temporary
 * bypass while dragging).
 */
export function snapPoint(
  cfg: GridConfig,
  x: number,
  y: number,
  ctrlHeld = false,
): { x: number; y: number } {
  if (!cfg.snapping || cfg.type === "gridless" || ctrlHeld) return { x, y };
  return { x: Math.round(x / cfg.size) * cfg.size, y: Math.round(y / cfg.size) * cfg.size };
}

/** Human-readable ruler text: squares + feet (5 ft per square). */
export function formatDistance(px: number, cellPx: number): string {
  const squares = cellPx > 0 ? px / cellPx : 0;
  const rounded = Math.round(squares * 10) / 10;
  const label = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  const unit = rounded === 1 ? "quadrado" : "quadrados";
  return `${label} ${unit} (${Math.round(rounded) * 5} ft)`;
}

export interface GridPanelOptions {
  /** Starting config (storage wins when it holds a valid one). */
  config?: GridConfig;
  /** Persistence backend (defaults to window.localStorage when available). */
  storage?: GridStorage | null;
  /** Called after every change with the sanitized config. */
  onChange?: (cfg: GridConfig) => void;
}

export interface GridPanel {
  /** Panel root (`section[data-testid=grid-panel]`). */
  el: HTMLElement;
  /** Current (sanitized) config. */
  get(): GridConfig;
  /** Replace the config (sanitized, persisted, notified). */
  set(cfg: GridConfig): void;
}

function defaultStorage(): GridStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Render the grid settings panel into `container`. */
export function renderGridPanel(container: HTMLElement, opts: GridPanelOptions = {}): GridPanel {
  const storage = opts.storage !== undefined ? opts.storage : defaultStorage();
  let current: GridConfig = opts.config ? sanitizeGridConfig(opts.config) : { ...DEFAULT_GRID_CONFIG };
  if (storage) {
    try {
      const raw = storage.getItem(GRID_STORAGE_KEY);
      if (raw) current = sanitizeGridConfig(JSON.parse(raw));
    } catch {
      // Corrupt JSON: keep the explicit/default config.
    }
  }

  const el = document.createElement("section");
  el.dataset.testid = "grid-panel";
  el.className = "grid-panel";
  el.setAttribute("aria-label", "Configurações da grade");

  const title = document.createElement("h2");
  title.textContent = "Grade";

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Tipo: ";
  const typeSel = document.createElement("select");
  typeSel.dataset.testid = "grid-type";
  const typeOptions: { value: GridType; label: string }[] = [
    { value: "square", label: "Quadrada" },
    { value: "hex-h", label: "Hexagonal (linhas)" },
    { value: "hex-v", label: "Hexagonal (colunas)" },
    { value: "gridless", label: "Sem grade" },
  ];
  for (const opt of typeOptions) {
    const node = document.createElement("option");
    node.value = opt.value;
    node.textContent = opt.label;
    typeSel.appendChild(node);
  }

  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Tamanho (px): ";
  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.min = String(MIN_SIZE);
  sizeInput.max = String(MAX_SIZE);
  sizeInput.dataset.testid = "grid-size";

  const opacityLabel = document.createElement("label");
  opacityLabel.textContent = "Opacidade: ";
  const opacityInput = document.createElement("input");
  opacityInput.type = "range";
  opacityInput.min = "0";
  opacityInput.max = "1";
  opacityInput.step = "0.05";
  opacityInput.dataset.testid = "grid-opacity";

  const colorLabel = document.createElement("label");
  colorLabel.textContent = "Cor: ";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.dataset.testid = "grid-color";

  const snapLabel = document.createElement("label");
  snapLabel.className = "grid-snap";
  const snapInput = document.createElement("input");
  snapInput.type = "checkbox";
  snapInput.dataset.testid = "grid-snapping";
  snapLabel.append(snapInput, document.createTextNode(" Encaixar na grade (segure Ctrl para soltar ao arrastar)"));

  function paint(): void {
    typeSel.value = current.type;
    sizeInput.value = String(current.size);
    opacityInput.value = String(current.opacity);
    colorInput.value = current.color;
    snapInput.checked = current.snapping;
  }

  function commit(next: GridConfig): void {
    current = sanitizeGridConfig(next);
    paint();
    saveGridConfig(storage, current);
    opts.onChange?.({ ...current });
  }

  typeSel.addEventListener("change", () => {
    const next = typeSel.value;
    commit({ ...current, type: isGridType(next) ? next : current.type });
  });
  sizeInput.addEventListener("change", () =>
    commit({ ...current, size: Number(sizeInput.value) }),
  );
  opacityInput.addEventListener("change", () =>
    commit({ ...current, opacity: Number(opacityInput.value) }),
  );
  colorInput.addEventListener("change", () => commit({ ...current, color: colorInput.value }));
  // `click` covers jsdom checkbox activation; `change` covers keyboards.
  snapInput.addEventListener("click", () => commit({ ...current, snapping: snapInput.checked }));
  snapInput.addEventListener("change", () => commit({ ...current, snapping: snapInput.checked }));

  typeLabel.appendChild(typeSel);
  sizeLabel.appendChild(sizeInput);
  opacityLabel.appendChild(opacityInput);
  colorLabel.appendChild(colorInput);
  el.append(title, typeLabel, sizeLabel, opacityLabel, colorLabel, snapLabel);
  paint();
  container.appendChild(el);

  return {
    el,
    get: () => ({ ...current }),
    set: (cfg: GridConfig) => commit(cfg),
  };
}
