// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { Sheet } from "../sheet/types";
import { renderSheetPanel } from "./sheet-panel";

function makeSheet(): Sheet {
  return {
    id: "p1",
    name: "Borin",
    ac: 15,
    hp: 20,
    maxHp: 24,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 8, cha: 13 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders portrait placeholder, name, stats and all sections", () => {
  const el = document.createElement("div");
  renderSheetPanel(el, makeSheet(), { onChange: () => {} });

  expect(el.querySelector(".sheet-title")?.textContent).toBe("Ficha");
  expect(el.querySelector(".sheet-photo-placeholder")).not.toBeNull();
  expect(el.querySelector<HTMLInputElement>(".sheet-name")!.value).toBe("Borin");
  expect(el.querySelectorAll(".ability-card")).toHaveLength(6);
  expect(el.querySelectorAll(".save-row")).toHaveLength(6);
  expect(el.querySelectorAll(".skill-row")).toHaveLength(17);
  for (const title of [
    "Atributos",
    "Salvamentos",
    "Perícias",
    "Inventário",
    "Traços",
    "Condições",
    "Anotações",
  ]) {
    expect(el.textContent).toContain(title);
  }
});

test("editing an ability score fires onChange and refreshes dependent modifiers", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const scoreInput = el.querySelector<HTMLInputElement>(".ability-score")!;
  scoreInput.value = "18";
  scoreInput.dispatchEvent(new Event("input"));

  expect(latest).not.toBeNull();
  expect(latest!.abilities!.str).toBe(18);
  // FOR 18 → +4: the Atletismo (str) skill modifier refreshes too.
  const atletismo = [...el.querySelectorAll<HTMLElement>(".skill-row")].find((r) =>
    r.textContent?.includes("Atletismo"),
  )!;
  expect(atletismo.querySelector(".sheet-row-mod")!.textContent).toBe("+4");
});

test("clicking an ability card rolls d20 + modifier via onRoll", () => {
  const el = document.createElement("div");
  const rolls: Array<{ label: string; mod: number; total: number }> = [];
  renderSheetPanel(el, makeSheet(), {
    onChange: () => {},
    onRoll: (label, result) => {
      rolls.push({ label, mod: result.mod, total: result.total });
    },
  });

  const card = el.querySelector<HTMLButtonElement>(".ability-card")!;
  card.click();

  expect(rolls).toHaveLength(1);
  expect(rolls[0].label).toBe("FOR");
  expect(rolls[0].mod).toBe(3); // (16 - 10) / 2
  expect(rolls[0].total).toBeGreaterThanOrEqual(1 + 3);
  expect(rolls[0].total).toBeLessThanOrEqual(20 + 3);
});

test("clicking a save row rolls with proficiency bonus", () => {
  const el = document.createElement("div");
  const rolls: Array<{ label: string; mod: number }> = [];
  const sheet = makeSheet();
  sheet.saves = [
    { ability: "str", proficient: true },
    { ability: "dex", proficient: false },
    { ability: "con", proficient: false },
    { ability: "int", proficient: false },
    { ability: "wis", proficient: false },
    { ability: "cha", proficient: false },
  ];
  renderSheetPanel(el, sheet, {
    onChange: () => {},
    onRoll: (label, result) => {
      rolls.push({ label, mod: result.mod });
    },
  });

  const saveRow = el.querySelector<HTMLButtonElement>(".save-row")!;
  saveRow.click();

  expect(rolls).toHaveLength(1);
  expect(rolls[0].label).toBe("Salvamento de FOR");
  expect(rolls[0].mod).toBe(5); // +3 ability + 2 proficiency
});

test("toggling a skill proficiency fires onChange and updates the modifier", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const skillRow = [...el.querySelectorAll<HTMLButtonElement>(".skill-row")].find((r) =>
    r.textContent?.includes("Atletismo"),
  )!;
  const prof = skillRow.querySelector<HTMLInputElement>(".sheet-prof")!;
  prof.checked = true;
  prof.dispatchEvent(new Event("change"));

  expect(latest).not.toBeNull();
  const atletismo = latest!.skills!.find((s) => s.name === "Atletismo")!;
  expect(atletismo.proficient).toBe(true);
  expect(skillRow.querySelector(".sheet-row-mod")!.textContent).toBe("+5"); // +3 + 2
});

test("adding and editing inventory items fires onChange", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const addBtn = el.querySelector<HTMLButtonElement>(".sheet-add-item")!;
  addBtn.click();
  expect(latest!.inventory).toHaveLength(1);
  expect(latest!.inventory![0].name).toBe("Novo item");

  const nameInput = el.querySelector<HTMLInputElement>(".sheet-row-input")!;
  nameInput.value = "Espada longa";
  nameInput.dispatchEvent(new Event("input"));
  expect(latest!.inventory![0].name).toBe("Espada longa");

  const qtyInput = el.querySelector<HTMLInputElement>(".sheet-row-qty")!;
  qtyInput.value = "2";
  qtyInput.dispatchEvent(new Event("input"));
  expect(latest!.inventory![0].qty).toBe(2);

  const del = el.querySelector<HTMLButtonElement>(".sheet-row-del")!;
  del.click();
  expect(latest!.inventory).toHaveLength(0);
});

test("editing traits and notes fires onChange", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const inputs = el.querySelectorAll<HTMLInputElement>(".sheet-field input");
  inputs[0].value = "Corajoso e teimoso";
  inputs[0].dispatchEvent(new Event("input"));
  expect(latest!.traits!.personality).toBe("Corajoso e teimoso");

  const notes = el.querySelector<HTMLTextAreaElement>(".sheet-notes")!;
  notes.value = "Encontrou um mapa antigo na taverna.";
  notes.dispatchEvent(new Event("input"));
  expect(latest!.notes).toBe("Encontrou um mapa antigo na taverna.");
});

test("adding a condition fires onChange", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const addBtn = el.querySelector<HTMLButtonElement>(".sheet-add-condition")!;
  addBtn.click();

  expect(latest!.conditions).toHaveLength(1);
  expect(latest!.conditions![0].name).toBe("Nova condição");
});

test("photo upload sets a data URL on the sheet", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  class MockFileReader {
    result: string | null = null;
    onloadend: (() => void) | null = null;
    readAsDataURL(): void {
      this.result = "data:image/png;base64,AAAA";
      this.onloadend?.();
    }
  }
  vi.stubGlobal("FileReader", MockFileReader);

  const input = el.querySelector<HTMLInputElement>(".sheet-photo-input")!;
  const file = new File(["x"], "portrait.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));

  expect(latest!.photo).toBe("data:image/png;base64,AAAA");
  expect(el.querySelector(".sheet-photo-empty")).toBeNull();
});
