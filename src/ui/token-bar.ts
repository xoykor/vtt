// Token bar: one button per member (dm + p1..p5) and a one-line
// summary of the sheet currently selected. The bar owns the selection
// highlight; the caller swaps the sheet panel when `onSelect` fires.

import type { Sheet } from "../sheet/types";

/** Members of a table: the DM plus up to five players. */
export const MEMBERS = ["dm", "p1", "p2", "p3", "p4", "p5"];

export interface TokenBarOptions {
  /** Called when a member button is clicked. */
  onSelect: (id: string) => void;
  /** Member buttons to show (defaults to the full table; guests pass only their own id). */
  members?: string[];
}

export interface TokenBar {
  /** Root element (member buttons + sheet summary). */
  el: HTMLElement;
  /** Highlight `id` and refresh the sheet summary line. */
  setSelected(id: string, sheet: Sheet | undefined): void;
}

/** Build the member buttons plus the sheet summary line. */
export function createTokenBar(options: TokenBarOptions): TokenBar {
  const members = options.members ?? MEMBERS;
  const box = document.createElement("div");
  box.className = "token-bar";

  const summary = document.createElement("div");
  summary.className = "token-summary";
  summary.textContent = "—";

  const buttons = new Map<string, HTMLButtonElement>();
  for (const id of members) {
    const btn = document.createElement("button");
    btn.textContent = id;
    btn.className = "menu-btn";
    btn.style.padding = "0.3rem 0.8rem";
    btn.style.fontSize = "0.85rem";
    btn.addEventListener("click", () => options.onSelect(id));
    buttons.set(id, btn);
    box.appendChild(btn);
  }

  box.appendChild(summary);

  return {
    el: box,
    setSelected(id: string, sheet: Sheet | undefined): void {
      for (const [member, btn] of buttons) {
        btn.classList.toggle("selected", member === id);
      }
      summary.textContent = sheet
        ? `${sheet.name} — CA ${sheet.ac} — HP ${sheet.hp}/${sheet.maxHp}`
        : "—";
    },
  };
}
