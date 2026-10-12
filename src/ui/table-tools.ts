// Left toolbar rail for the table view: Roll20/Foundry-style tool
// icons (select, pan, measure, draw, text, fog, layers, grid, chat).
// Owns only the active-tool state + the rail DOM; the canvas behavior
// for each tool lives in src/ui/table-view.ts. Unknown tool ids are
// ignored fail-closed (the previous tool stays active). Pure DOM, no
// new dependencies.

/** Tools on the left rail, in display order. */
export type ToolId =
  | "select"
  | "pan"
  | "measure"
  | "draw"
  | "text"
  | "fog"
  | "layers"
  | "grid"
  | "chat";

export interface ToolDef {
  id: ToolId;
  /** Short button label (pt-BR, like the other shell strings). */
  label: string;
  /** Glyph drawn on the rail button (emoji/text only, no assets). */
  icon: string;
  /** Plain-language tooltip explaining what the tool does. */
  hint: string;
}

export const TABLE_TOOLS: ToolDef[] = [
  { id: "select", label: "Selecionar", icon: "➤", hint: "Selecionar e mover fichas no mapa" },
  { id: "pan", label: "Mover câmera", icon: "✋", hint: "Arrastar para mover a câmera (o botão direito sempre move)" },
  { id: "measure", label: "Medir", icon: "📏", hint: "Régua: arraste para medir a distância" },
  { id: "draw", label: "Desenhar", icon: "✏️", hint: "Desenho livre ou retângulo sobre o mapa" },
  { id: "text", label: "Texto", icon: "T", hint: "Clique no mapa para colocar um texto" },
  { id: "fog", label: "Névoa", icon: "🌫️", hint: "Pincel de névoa: revelar ou esconder áreas" },
  { id: "layers", label: "Camadas", icon: "🗂️", hint: "Trocar a camada ativa (fundo, mestre, jogadores)" },
  { id: "grid", label: "Grade", icon: "#️⃣", hint: "Configurar tipo, tamanho e cor da grade" },
  { id: "chat", label: "Bate-papo", icon: "💬", hint: "Mostrar ou esconder o bate-papo" },
];

/** True when `value` names one of the nine rail tools. */
export function isToolId(value: string): value is ToolId {
  return TABLE_TOOLS.some((t) => t.id === value);
}

export interface ToolState {
  /** Currently active tool. */
  get(): ToolId;
  /** Activate `id`; unknown ids are ignored (fail-closed). */
  set(id: string): void;
  /** Called after every real change; returns an unsubscribe fn. */
  subscribe(fn: (tool: ToolId) => void): () => void;
}

/** Viewports narrower than this start with the rail collapsed. */
export const COMPACT_WIDTH = 720;

/** Create the active-tool store (defaults to `select`). */
export function createToolState(initial: ToolId = "select"): ToolState {
  let current: ToolId = isToolId(initial) ? initial : "select";
  const listeners = new Set<(tool: ToolId) => void>();
  return {
    get: () => current,
    set: (id: string) => {
      if (!isToolId(id) || id === current) return;
      current = id;
      for (const fn of [...listeners]) fn(current);
    },
    subscribe: (fn: (tool: ToolId) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export interface ToolbarOptions {
  /** Shared store (a private one is created when omitted). */
  state?: ToolState;
  /** Called after every tool change (after subscribe handlers). */
  onTool?: (tool: ToolId) => void;
  /** Start collapsed; defaults to true on narrow viewports. */
  startCollapsed?: boolean;
}

export interface Toolbar {
  /** Rail root (`nav[data-testid=toolbar]`). */
  el: HTMLElement;
  /** The shared active-tool store. */
  state: ToolState;
  /** Collapse (`true`) or expand the rail. */
  setCollapsed(collapsed: boolean): void;
  /** Current collapsed state. */
  isCollapsed(): boolean;
}

/** Render the rail into `container`; the toolbar owns its buttons. */
export function renderToolbar(container: HTMLElement, opts: ToolbarOptions = {}): Toolbar {
  const state = opts.state ?? createToolState();
  let collapsed = opts.startCollapsed ?? isCompactViewport();

  const nav = document.createElement("nav");
  nav.dataset.testid = "toolbar";
  nav.className = "table-toolbar";
  nav.setAttribute("aria-label", "Ferramentas da mesa");

  const buttons = new Map<ToolId, HTMLButtonElement>();
  function paint(): void {
    const active = state.get();
    for (const [id, btn] of buttons) {
      const on = id === active;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("active", on);
    }
  }

  for (const tool of TABLE_TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.testid = `tool-${tool.id}`;
    btn.className = "tool-btn";
    btn.title = `${tool.label} — ${tool.hint}`;
    btn.setAttribute("aria-label", tool.label);
    const glyph = document.createElement("span");
    glyph.className = "tool-icon";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = tool.icon;
    const caption = document.createElement("span");
    caption.className = "tool-caption";
    caption.textContent = tool.label;
    btn.append(glyph, caption);
    btn.addEventListener("click", () => {
      state.set(tool.id);
    });
    buttons.set(tool.id, btn);
    nav.appendChild(btn);
  }

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.dataset.testid = "toolbar-collapse";
  collapseBtn.className = "tool-btn tool-collapse";
  collapseBtn.title = "Recolher ou expandir a barra de ferramentas";
  collapseBtn.setAttribute("aria-label", "Recolher ou expandir a barra de ferramentas");
  collapseBtn.textContent = "«";
  collapseBtn.addEventListener("click", () => {
    setCollapsed(!collapsed);
  });
  nav.appendChild(collapseBtn);

  function setCollapsed(next: boolean): void {
    collapsed = next;
    nav.classList.toggle("collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "»" : "«";
  }
  setCollapsed(collapsed);

  const off = state.subscribe(() => {
    paint();
    opts.onTool?.(state.get());
  });
  void off;
  paint();
  container.appendChild(nav);

  return {
    el: nav,
    state,
    setCollapsed,
    isCollapsed: () => collapsed,
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

/** Two-choice mode bar (e.g. freehand/rect, reveal/hide). Small helper
 *  shared by the draw and fog tools so both callers behave alike. */
export function renderModeBar(
  container: HTMLElement,
  modes: { id: string; label: string; testid: string }[],
  initial: string,
  onPick: (id: string) => void,
): { el: HTMLElement; get(): string } {
  let current = modes.some((m) => m.id === initial) ? initial : (modes[0]?.id ?? "");
  const bar = document.createElement("div");
  bar.className = "mode-bar";
  const btns = new Map<string, HTMLButtonElement>();
  function paint(): void {
    for (const [id, btn] of btns) {
      btn.setAttribute("aria-pressed", id === current ? "true" : "false");
      btn.classList.toggle("active", id === current);
    }
  }
  for (const mode of modes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.testid = mode.testid;
    btn.className = "mode-btn";
    btn.textContent = mode.label;
    btn.addEventListener("click", () => {
      if (!btns.has(mode.id)) return;
      current = mode.id;
      paint();
      onPick(current);
    });
    btns.set(mode.id, btn);
    bar.appendChild(btn);
  }
  paint();
  container.appendChild(bar);
  return { el: bar, get: () => current };
}
