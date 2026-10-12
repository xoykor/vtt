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

test("header shows Roll20 identity fields and tabs switch panels", () => {
  const el = document.createElement("div");
  const sheet = makeSheet();
  sheet.charClass = "Guerreiro";
  sheet.level = 5;
  sheet.race = "Anão";
  sheet.alignment = "Leal e Bom";
  sheet.xp = 6500;
  renderSheetPanel(el, sheet, { onChange: () => {} });

  expect(el.querySelector<HTMLInputElement>(".sheet-class")!.value).toBe("Guerreiro");
  expect(el.querySelector<HTMLInputElement>(".sheet-level")!.value).toBe("5");
  expect(el.querySelector<HTMLInputElement>(".sheet-race")!.value).toBe("Anão");
  expect(el.querySelector<HTMLInputElement>(".sheet-alignment")!.value).toBe(
    "Leal e Bom",
  );
  expect(el.querySelector<HTMLInputElement>(".sheet-xp")!.value).toBe("6500");

  const tabs = [...el.querySelectorAll<HTMLButtonElement>(".sheet-tab")].map(
    (b) => b.textContent,
  );
  expect(tabs).toEqual(["Core", "Bio", "Magias/Equip"]);

  const bio = [...el.querySelectorAll<HTMLButtonElement>(".sheet-tab")].find(
    (b) => b.textContent === "Bio",
  )!;
  bio.click();
  expect(
    el.querySelector<HTMLElement>('[data-tab-panel="bio"]')?.style.display,
  ).not.toBe("none");
  expect(
    el.querySelector<HTMLElement>('[data-tab-panel="core"]')?.style.display,
  ).toBe("none");
});

test("changing the level recalculates the proficiency bonus", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  expect(el.querySelector(".sheet-prof-bonus")!.textContent).toBe("+2");
  const level = el.querySelector<HTMLInputElement>(".sheet-level")!;
  level.value = "5";
  level.dispatchEvent(new Event("input"));

  expect(latest!.level).toBe(5);
  expect(latest!.profBonus).toBe(3);
  expect(el.querySelector(".sheet-prof-bonus")!.textContent).toBe("+3");
});

test("clicking an attack rolls d20 + bonus via onRoll", () => {
  const el = document.createElement("div");
  const rolls: Array<{ label: string; mod: number; total: number }> = [];
  const sheet = makeSheet();
  sheet.attacks = [{ id: "a1", name: "Machado", bonus: 5, damage: "1d8+3" }];
  renderSheetPanel(el, sheet, {
    onChange: () => {},
    onRoll: (label, result) => {
      rolls.push({ label, mod: result.mod, total: result.total });
    },
  });

  el.querySelector<HTMLButtonElement>(".attack-row")!.click();
  expect(rolls).toHaveLength(1);
  expect(rolls[0].label).toBe("Machado");
  expect(rolls[0].mod).toBe(5);
  expect(el.querySelector(".sheet-roll-line")!.textContent).toContain("Machado");
});

test("natural 20 and 1 highlight the roll line as crit/fumble", () => {
  const el = document.createElement("div");
  renderSheetPanel(el, makeSheet(), {
    onChange: () => {},
    rng: () => 0.999,
  });
  el.querySelector<HTMLButtonElement>(".ability-card")!.click();
  expect(el.querySelector(".sheet-roll-line")!.classList.contains("crit")).toBe(
    true,
  );
  expect(el.querySelector(".sheet-roll-line")!.textContent).toContain("CRÍTICO");

  const el2 = document.createElement("div");
  renderSheetPanel(el2, makeSheet(), {
    onChange: () => {},
    rng: () => 0,
  });
  el2.querySelector<HTMLButtonElement>(".ability-card")!.click();
  expect(el2.querySelector(".sheet-roll-line")!.classList.contains("fumble")).toBe(
    true,
  );
  expect(el2.querySelector(".sheet-roll-line")!.textContent).toContain(
    "FALHA CRÍTICA",
  );
});

test("death saves, money and initiative misc persist via onChange", () => {
  const el = document.createElement("div");
  let latest: Sheet | null = null;
  renderSheetPanel(el, makeSheet(), {
    onChange: (s) => {
      latest = s;
    },
  });

  const checks = el.querySelectorAll<HTMLInputElement>(
    ".sheet-death-saves input[type=checkbox]",
  );
  expect(checks).toHaveLength(6);
  (checks[0] as HTMLInputElement).checked = true;
  checks[0].dispatchEvent(new Event("change"));
  expect(latest!.deathSaves).toEqual({ successes: 1, failures: 0 });

  const gp = el.querySelector<HTMLInputElement>(".sheet-money-gp")!;
  gp.value = "12";
  gp.dispatchEvent(new Event("input"));
  expect(latest!.money!.gp).toBe(12);

  const misc = el.querySelector<HTMLInputElement>(".sheet-init-misc")!;
  misc.value = "1";
  misc.dispatchEvent(new Event("input"));
  // DES 12 → +1, misc +1 = +2.
  expect(el.querySelector(".sheet-initiative")!.textContent).toBe("+2");
  expect(latest!.initiativeMisc).toBe(1);
});
