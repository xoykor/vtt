// Dice roller widget: d4..d100 selector, "Rolar" button and the result
// line. The widget only owns the DOM: `onRoll` receives the chosen die
// size and the caller resolves/publishes the roll, then feeds the text
// back through `setResult`.

/** Die sizes offered in the selector (d4..d100, 5e set). */
const SIDES = [2, 4, 6, 8, 10, 12, 20, 100];

export interface DicePanelOptions {
  /** Called when "Rolar" is pressed, with the selected die size. */
  onRoll: (sides: number) => void;
}

export interface DicePanel {
  /** Root element (title + selector + button + result line). */
  el: HTMLElement;
  /** Replace the result line text (e.g. "FOR: 14 = 17"). */
  setResult(text: string): void;
}

/** Build the dice panel; returns its root element and result writer. */
export function createDicePanel(options: DicePanelOptions): DicePanel {
  const box = document.createElement("div");
  box.className = "dice-panel";

  const diceTitle = document.createElement("h2");
  diceTitle.textContent = "Dado";
  diceTitle.style.fontFamily = "var(--font-display)";
  diceTitle.style.color = "var(--menu-gold)";

  const sidesSel = document.createElement("select");
  for (const s of SIDES) {
    const opt = document.createElement("option");
    opt.value = String(s);
    opt.textContent = `d${s}`;
    if (s === 20) opt.selected = true;
    sidesSel.appendChild(opt);
  }

  const rollBtn = document.createElement("button");
  rollBtn.textContent = "Rolar";
  rollBtn.className = "menu-btn";
  rollBtn.style.padding = "0.5rem 1rem";
  rollBtn.style.fontSize = "0.9rem";
  rollBtn.addEventListener("click", () => options.onRoll(Number(sidesSel.value)));

  const rollOut = document.createElement("div");
  rollOut.textContent = "—";
  rollOut.style.color = "var(--menu-text)";

  box.append(diceTitle, sidesSel, rollBtn, rollOut);

  return {
    el: box,
    setResult(text: string): void {
      rollOut.textContent = text;
    },
  };
}
