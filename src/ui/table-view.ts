// Composed table view: the left toolbar rail, the map canvas with
// per-tool behavior, the layer switcher + grid panels and the
// toggleable chat aside — mounted together so the app shell can drop
// the whole table in at once. Canvas tools: Select (cell readout),
// Pan (left-drag; the right button ALWAYS pans), Measure (ruler drag
// with a distance tooltip in squares/feet), Draw (snapped freehand or
// rectangle, Ctrl bypasses snapping), Text (inline form → map note),
// Fog (reveal/hide brush over an in-memory mask). Tile writes stay
// host-only via the layer panel; the GM layer stays hidden behind
// "Ver como jogador". Narrow screens start with a collapsed rail.
// Pure DOM + one 2D canvas; no new dependencies.

import "../styles/table.css";
import { createFog, type Fog } from "../map/fog";
import type { Grid } from "../map/grid";
import type { Delta } from "../net/peer";
import { renderChatPanel, type ChatPanel } from "./chat";
import {
  formatDistance,
  renderGridPanel,
  snapPoint,
  type GridConfig,
  type GridPanel,
  type GridStorage,
} from "./grid-config";
import {
  renderLayerPanel,
  type LayerPanel,
} from "./table-layers";
import type { MapLayer } from "../map/layers";
import {
  COMPACT_WIDTH,
  createToolState,
  renderModeBar,
  renderToolbar,
  type ToolId,
  type ToolState,
} from "./table-tools";

export interface CellPos {
  x: number;
  y: number;
}

export interface Drawing {
  kind: "freehand" | "rect";
  points: { x: number; y: number }[];
}

export interface TextNote {
  x: number;
  y: number;
  text: string;
}

export interface TableViewOptions {
  room: import("./room").OfflineRoom;
  /** Caller role (tile writes stay host-only, fail-closed). */
  role: string;
  grid: Grid;
  /** Speaking-as name for the chat (a fn follows the selection). */
  speaker?: string | (() => string);
  /** True for the GM (may send /gmroll and /desc). */
  isGM?: boolean;
  /** Grid persistence (defaults to window.localStorage when available). */
  storage?: GridStorage | null;
  /** Mirror for the network backend (host pushes chat deltas onward). */
  onBroadcast?: (delta: Delta) => void;
  /**
   * Base scene painter (background + light) called at the start of
   * every repaint with the current cell size, instead of the built-in
   * one. Lets the app shell own the authoritative scene while the
   * table adds tokens, the grid overlay, drawings and the fog brush
   * on top — all at the same scale.
   */
  paintBase?: (canvas: HTMLCanvasElement, cellPx: number) => void;
  /** Start the fog mask fully revealed (default: fully hidden). */
  initialFogVisible?: boolean;
}

export interface TableView {
  /** View root (`div[data-testid=table-view]`). */
  el: HTMLElement;
  /** Shared active-tool store. */
  tools: ToolState;
  setTool(tool: string): void;
  getTool(): ToolId;
  isCollapsed(): boolean;
  /** Paint one tile onto the active layer (host-only). */
  placeDrop(cell: CellPos, asset: string): boolean;
  activeLayer(): MapLayer;
  /** Accumulated right/left-drag pan offset in px. */
  getPan(): { x: number; y: number };
  /** Last measured distance text (`""` before the first measure). */
  getMeasure(): string;
  getDrawings(): Drawing[];
  setDrawMode(mode: string): void;
  getNotes(): TextNote[];
  getFog(): Fog;
  setFogMode(mode: "reveal" | "hide"): void;
  /** Full canvas repaint (base scene + overlay + fog). */
  repaint(): void;
  chat: ChatPanel;
  layers: LayerPanel;
  gridPanel: GridPanel;
}

/** Render the full table view into `container`. */
export function renderTableView(container: HTMLElement, opts: TableViewOptions): TableView {
  const { room, role, grid } = opts;
  const isGM = opts.isGM ?? role === "host";
  const speakerOpt: string | (() => string) = opts.speaker ?? (isGM ? "Mestre" : "Jogador");
  const tools = createToolState();

  const compact = isCompactViewport();
  const root = document.createElement("div");
  root.dataset.testid = "table-view";
  root.className = "table-view" + (compact ? " compact" : "");

  // ── Rail ──
  const rail = document.createElement("div");
  rail.className = "table-rail";
  const toolbar = renderToolbar(rail, { state: tools, onTool: updatePanels, startCollapsed: compact });

  // ── Canvas column ──
  const main = document.createElement("div");
  main.className = "table-main";
  const wrap = document.createElement("div");
  wrap.dataset.testid = "canvas-wrap";
  wrap.className = "table-canvas-wrap";

  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "table-canvas";
  canvas.className = "table-canvas";

  const tip = document.createElement("div");
  tip.dataset.testid = "measure-tip";
  tip.className = "measure-tip";
  tip.setAttribute("hidden", "");

  const drawBar = document.createElement("div");
  drawBar.dataset.testid = "draw-bar";
  drawBar.className = "tool-bar";
  drawBar.setAttribute("hidden", "");
  let drawMode: "freehand" | "rect" = "freehand";
  renderModeBar(
    drawBar,
    [
      { id: "freehand", label: "Livre", testid: "draw-freehand" },
      { id: "rect", label: "Retângulo", testid: "draw-rect" },
    ],
    drawMode,
    (id) => {
      drawMode = id === "rect" ? "rect" : "freehand";
    },
  );

  const fogBar = document.createElement("div");
  fogBar.dataset.testid = "fog-bar";
  fogBar.className = "tool-bar";
  fogBar.setAttribute("hidden", "");
  let fogMode: "reveal" | "hide" = "reveal";
  renderModeBar(
    fogBar,
    [
      { id: "reveal", label: "Revelar", testid: "fog-reveal" },
      { id: "hide", label: "Esconder", testid: "fog-hide" },
    ],
    fogMode,
    (id) => {
      fogMode = id === "hide" ? "hide" : "reveal";
    },
  );

  const textForm = document.createElement("form");
  textForm.dataset.testid = "text-form";
  textForm.className = "text-form";
  textForm.setAttribute("hidden", "");
  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.dataset.testid = "text-input";
  textInput.placeholder = "Texto do mapa…";
  textInput.setAttribute("aria-label", "Texto do mapa");
  textInput.maxLength = 140;
  const textOk = document.createElement("button");
  textOk.type = "submit";
  textOk.textContent = "Colocar";
  textForm.append(textInput, textOk);

  const selectStatus = document.createElement("div");
  selectStatus.dataset.testid = "select-status";
  selectStatus.className = "canvas-status";
  selectStatus.setAttribute("aria-live", "polite");
  selectStatus.textContent = "Selecione uma ferramenta à esquerda.";

  const fogStatus = document.createElement("div");
  fogStatus.dataset.testid = "fog-status";
  fogStatus.className = "canvas-status";
  fogStatus.setAttribute("aria-live", "polite");

  const layerHost = document.createElement("div");
  layerHost.dataset.testid = "layer-host";
  layerHost.setAttribute("hidden", "");
  const gridHost = document.createElement("div");
  gridHost.dataset.testid = "grid-host";
  gridHost.setAttribute("hidden", "");

  wrap.append(canvas, tip, drawBar, fogBar, textForm, selectStatus, fogStatus, layerHost, gridHost);

  // ── Chat aside ──
  const chatAside = document.createElement("aside");
  chatAside.dataset.testid = "chat-aside";
  chatAside.className = "chat-aside";

  main.append(wrap, chatAside);
  root.append(rail, main);
  container.appendChild(root);

  // ── Panels (created after the DOM so redraw can paint) ──
  const layers = renderLayerPanel(layerHost, {
    room,
    role,
    onChange: () => redraw(),
  });
  const gridPanel = renderGridPanel(gridHost, {
    storage: opts.storage !== undefined ? opts.storage : undefined,
    onChange: () => {
      redraw();
    },
  });
  const chat = renderChatPanel(chatAside, {
    speaker: speakerOpt,
    isGM,
    role,
    room,
    onBroadcast: opts.onBroadcast,
  });
  let gridCfg: GridConfig = gridPanel.get();

  // ── Ephemeral tool state ──
  let fog: Fog = createFog(grid.width, grid.height);
  if (opts.initialFogVisible) {
    fog = { width: fog.width, height: fog.height, visible: fog.visible.map(() => true) };
  }
  const drawings: Drawing[] = [];
  const notes: TextNote[] = [];
  let pan = { x: 0, y: 0 };
  let measureText = "";
  let measureAnchor: { x: number; y: number } | null = null;
  let stroke: Drawing | null = null;
  let panning = false;
  let panStart = { x: 0, y: 0 };
  let panBase = { x: 0, y: 0 };
  let scrollBase = { left: 0, top: 0 };
  let fogPainting = false;
  let pendingText: { x: number; y: number } | null = null;
  let selectedCell: CellPos | null = null;

  function paintFogStatus(): void {
    const revealed = fog.visible.filter(Boolean).length;
    fogStatus.textContent = `Névoa: ${revealed}/${fog.visible.length} visíveis (${fogMode === "reveal" ? "revelando" : "escondendo"}).`;
  }

  /** Full canvas repaint (guarded: jsdom has no 2D context). */
  function redraw(): void {
    gridCfg = gridPanel.get();
    const size = gridCfg.size;
    paintFogStatus();
    try {
      canvas.width = grid.width * size;
      canvas.height = grid.height * size;
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Authoritative base scene (the shell paints background +
      // light at the table's scale); the table adds tokens, overlay
      // and fog on top of it.
      let basePainted = false;
      if (opts.paintBase) {
        try {
          opts.paintBase(canvas, size);
          basePainted = true;
        } catch {
          basePainted = false;
        }
      }
      if (!basePainted) {
        ctx.fillStyle = "#1a1a22";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      {
        // Tokens from the room (labeled circles, like the map view).
        const palette = ["#e0a030", "#30a0e0", "#40c040", "#c040c0", "#e05050", "#20c0c0"];
        room.tokens().forEach((token, n) => {
          const cx = (token.pos.x + 0.5) * size;
          const cy = (token.pos.y + 0.5) * size;
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.35, 0, Math.PI * 2);
          ctx.fillStyle = palette[n % palette.length];
          ctx.fill();
          ctx.fillStyle = "#000";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(token.id.slice(0, 4), cx, cy);
        });
      }

      // Grid overlay (gridless draws nothing).
      if (gridCfg.type !== "gridless") {
        ctx.strokeStyle = gridCfg.color;
        ctx.globalAlpha = gridCfg.opacity;
        ctx.lineWidth = 1;
        for (let x = 0; x <= grid.width; x++) {
          ctx.beginPath();
          ctx.moveTo(x * size, 0);
          ctx.lineTo(x * size, grid.height * size);
          ctx.stroke();
        }
        for (let y = 0; y <= grid.height; y++) {
          ctx.beginPath();
          if (gridCfg.type === "hex-h" && y % 2 === 1) {
            // Offset rows read as hexagons at a glance.
            ctx.moveTo(size / 2, y * size);
            ctx.lineTo(grid.width * size + size / 2, y * size);
          } else {
            ctx.moveTo(0, y * size);
            ctx.lineTo(grid.width * size, y * size);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Freehand strokes + rectangles.
      ctx.strokeStyle = "#f0c040";
      ctx.lineWidth = 2;
      for (const drawing of drawings) {
        if (drawing.kind === "rect" && drawing.points.length >= 2) {
          const [a, b] = drawing.points;
          ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        } else if (drawing.points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(drawing.points[0].x, drawing.points[0].y);
          for (const p of drawing.points.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.stroke();
        } else if (drawing.points.length === 1) {
          ctx.beginPath();
          ctx.arc(drawing.points[0].x, drawing.points[0].y, 2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Fog: hidden cells stay dark.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          if (!fog.visible[y * grid.width + x]) ctx.fillRect(x * size, y * size, size, size);
        }
      }
    } catch {
      // Headless 2D context: the DOM status lines stay authoritative.
    }
  }

  function canvasPos(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function showTip(at: { x: number; y: number }, text: string): void {
    tip.removeAttribute("hidden");
    tip.style.left = `${at.x + 12}px`;
    tip.style.top = `${at.y + 12}px`;
    tip.textContent = text;
  }

  function hideTip(): void {
    tip.setAttribute("hidden", "");
  }

  function paintFogAt(pos: { x: number; y: number }): void {
    const size = gridCfg.size;
    const cx = Math.floor(pos.x / size);
    const cy = Math.floor(pos.y / size);
    if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return;
    fog = {
      width: fog.width,
      height: fog.height,
      visible: fog.visible.map((v, i) =>
        i === cy * grid.width + cx ? fogMode === "reveal" : v,
      ),
    };
    redraw();
  }

  canvas.addEventListener("contextmenu", (ev) => {
    // The right button always pans: the menu never steals it.
    ev.preventDefault();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    const me = ev as unknown as MouseEvent;
    const pos = canvasPos(me);
    if (me.button === 2 || tools.get() === "pan") {
      if (me.button !== 0 && me.button !== 2) return;
      panning = true;
      panStart = { x: me.clientX, y: me.clientY };
      panBase = { ...pan };
      scrollBase = { left: wrap.scrollLeft, top: wrap.scrollTop };
      hideTip();
      return;
    }
    if (me.button !== 0) return;
    const snapped = snapPoint(gridCfg, pos.x, pos.y, me.ctrlKey);
    switch (tools.get()) {
      case "measure":
        measureAnchor = snapped;
        showTip(pos, "Arraste para medir…");
        break;
      case "draw":
        stroke = { kind: drawMode, points: [snapped] };
        break;
      case "fog":
        fogPainting = true;
        paintFogAt(pos);
        break;
      case "text":
        pendingText = snapped;
        textForm.removeAttribute("hidden");
        textInput.value = "";
        textInput.focus();
        break;
      case "select": {
        const size = gridCfg.size;
        const cx = Math.floor(pos.x / size);
        const cy = Math.floor(pos.y / size);
        if (cx >= 0 && cy >= 0 && cx < grid.width && cy < grid.height) {
          selectedCell = { x: cx, y: cy };
          selectStatus.textContent = `Selecionado (${cx},${cy}).`;
        }
        break;
      }
      default:
        break;
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    const me = ev as unknown as MouseEvent;
    const pos = canvasPos(me);
    if (panning) {
      pan = { x: panBase.x + (me.clientX - panStart.x), y: panBase.y + (me.clientY - panStart.y) };
      try {
        wrap.scrollLeft = scrollBase.left - (me.clientX - panStart.x);
        wrap.scrollTop = scrollBase.top - (me.clientY - panStart.y);
      } catch {
        // Headless scroll: the pan offset above stays authoritative.
      }
      return;
    }
    if (measureAnchor && tools.get() === "measure") {
      const dist = Math.hypot(pos.x - measureAnchor.x, pos.y - measureAnchor.y);
      showTip(pos, `${formatDistance(dist, gridCfg.size)} · ${Math.round(dist)} px`);
      return;
    }
    if (stroke && tools.get() === "draw") {
      const snapped = snapPoint(gridCfg, pos.x, pos.y, me.ctrlKey);
      if (stroke.kind === "rect") {
        stroke.points = [stroke.points[0], snapped];
      } else {
        const last = stroke.points[stroke.points.length - 1];
        if (last.x !== snapped.x || last.y !== snapped.y) stroke.points.push(snapped);
      }
      return;
    }
    if (fogPainting && tools.get() === "fog") paintFogAt(pos);
  });

  function endPointer(): void {
    if (panning) panning = false;
    if (stroke) {
      drawings.push(stroke);
      stroke = null;
      redraw();
    }
    if (measureAnchor && !tip.hasAttribute("hidden")) {
      measureText = tip.textContent ?? "";
      measureAnchor = null;
    }
    fogPainting = false;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  textForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = textInput.value.trim();
    if (!text || !pendingText) {
      textForm.setAttribute("hidden", "");
      pendingText = null;
      return;
    }
    const note: TextNote = { x: pendingText.x, y: pendingText.y, text };
    notes.push(note);
    const pin = document.createElement("div");
    pin.className = "text-note";
    pin.style.left = `${note.x}px`;
    pin.style.top = `${note.y}px`;
    pin.textContent = note.text;
    wrap.appendChild(pin);
    selectStatus.textContent = `Texto colocado em (${note.x},${note.y}).`;
    pendingText = null;
    textForm.setAttribute("hidden", "");
  });

  function updatePanels(tool: ToolId): void {
    layerHost.toggleAttribute("hidden", tool !== "layers");
    gridHost.toggleAttribute("hidden", tool !== "grid");
    drawBar.toggleAttribute("hidden", tool !== "draw");
    fogBar.toggleAttribute("hidden", tool !== "fog");
    textForm.setAttribute("hidden", "");
    pendingText = null;
    if (tool === "chat") chatAside.toggleAttribute("hidden");
  }

  function setTool(tool: string): void {
    // The chat button toggles the aside even when re-pressed.
    if (tool === "chat" && tools.get() === "chat") {
      chatAside.toggleAttribute("hidden");
      return;
    }
    tools.set(tool);
  }

  function clickMode(testid: string): void {
    const btn = root.querySelector<HTMLButtonElement>(`[data-testid=${testid}]`);
    btn?.click();
  }

  updatePanels(tools.get());
  redraw();

  return {
    el: root,
    tools,
    setTool,
    getTool: () => tools.get(),
    isCollapsed: () => toolbar.isCollapsed(),
    placeDrop: (cell: CellPos, asset: string) => {
      const ok = layers.drop(cell.x, cell.y, asset);
      redraw();
      return ok;
    },
    activeLayer: () => layers.activeLayer(),
    getPan: () => ({ ...pan }),
    getMeasure: () => measureText,
    getDrawings: () => drawings.map((d) => ({ kind: d.kind, points: d.points.map((p) => ({ ...p })) })),
    setDrawMode: (mode: string) => {
      if (mode !== "freehand" && mode !== "rect") return;
      clickMode(mode === "rect" ? "draw-rect" : "draw-freehand");
    },
    getNotes: () => notes.map((n) => ({ ...n })),
    getFog: () => ({ width: fog.width, height: fog.height, visible: [...fog.visible] }),
    setFogMode: (mode: "reveal" | "hide") => {
      clickMode(mode === "hide" ? "fog-hide" : "fog-reveal");
      paintFogStatus();
    },
    repaint: () => redraw(),
    chat,
    layers,
    gridPanel,
  };
}

/** True on narrow viewports (guards SSR/non-DOM runners). */
function isCompactViewport(): boolean {
  try {
    return typeof window !== "undefined" && window.innerWidth < COMPACT_WIDTH;
  } catch {
    return false;
  }
}

export { COMPACT_WIDTH };
