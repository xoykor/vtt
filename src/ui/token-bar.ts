// Sheet bar: one button per visible sheet (sem slots fixos, sem
// seletor de jogador) + resumo da ficha selecionada. A barra possui
// o highlight; o chamador troca o painel quando `onSelect` dispara.
// Sem MEMBERS: a lista é dinâmica (GM=todas, player=próprias+
// compartilhadas) via `items`/`setItems`.
import type { Sheet } from "../sheet/types";

export interface SheetBarItem {
  id: string;
  label: string;
}

export interface TokenBarOptions {
  /** Called when a sheet button is clicked. */
  onSelect: (id: string) => void;
  /** Sheet buttons to show (dynamic; empty = nenhuma ficha visível). */
  items?: SheetBarItem[];
  /**
   * Legado: ids simples (migração de `members`).
   * @deprecated use `items` (sem slots fixos).
   */
  members?: string[];
}

export interface TokenBar {
  /** Root element (sheet buttons + summary). */
  el: HTMLElement;
  /** Highlight `id` and refresh the sheet summary line. */
  setSelected(id: string, sheet: Sheet | undefined): void;
  /** Replace the button list (GM=todas, player=próprias+compartilhadas). */
  setItems(items: SheetBarItem[]): void;
}

/** Build the sheet buttons plus the summary line. */
export function createTokenBar(options: TokenBarOptions): TokenBar {
  const box = document.createElement("div");
  box.className = "token-bar";

  const list = document.createElement("div");
  list.className = "token-bar-list";

  const summary = document.createElement("div");
  summary.className = "token-summary";
  summary.textContent = "—";

  const buttons = new Map<string, HTMLButtonElement>();
  let selectedId = "";

  function renderItems(items: SheetBarItem[]): void {
    list.innerHTML = "";
    buttons.clear();
    for (const item of items) {
      const btn = document.createElement("button");
      btn.textContent = item.label;
      btn.title = item.id;
      btn.className = "menu-btn" + (item.id === selectedId ? " selected" : "");
      btn.style.padding = "0.3rem 0.8rem";
      btn.style.fontSize = "0.85rem";
      btn.addEventListener("click", () => options.onSelect(item.id));
      buttons.set(item.id, btn);
      list.appendChild(btn);
    }
  }

  const initial: SheetBarItem[] =
    options.items ??
    (options.members ?? []).map((id) => ({ id, label: id }));
  renderItems(initial);

  box.append(list, summary);

  return {
    el: box,
    setSelected(id: string, sheet: Sheet | undefined): void {
      selectedId = id;
      for (const [itemId, btn] of buttons) {
        btn.classList.toggle("selected", itemId === id);
      }
      summary.textContent = sheet
        ? `${sheet.name} — CA ${sheet.ac} — HP ${sheet.hp}/${sheet.maxHp}`
        : "—";
    },
    setItems(items: SheetBarItem[]): void {
      renderItems(items);
    },
  };
}
