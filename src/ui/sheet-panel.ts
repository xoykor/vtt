// Roll20-style character sheet panel (right sidebar): portrait upload,
// editable abilities/skills/saves with one-click d20 rolls, inventory,
// traits, conditions and notes. Pure DOM; every edit fires `onChange`
// with the full updated sheet (the caller decides persistence). Rolls
// go through `onRoll` so the caller can publish them host-side.
// No central server; no WotC art.

import { resolveRoll, type RollResult } from "../dice/roller";
import type {
  AbilityScores,
  Condition,
  InventoryItem,
  Save,
  Sheet,
  SheetTraits,
  Skill,
} from "../sheet/types";

export interface SheetPanelCallbacks {
  /** Fired on every edit with the full updated sheet. */
  onChange: (sheet: Sheet) => void;
  /** Fired on a direct roll (ability/save/skill) with the resolved result. */
  onRoll?: (label: string, result: RollResult) => void;
}

const ABILITY_LABELS: Record<keyof AbilityScores, string> = {
  str: "FOR",
  dex: "DES",
  con: "CON",
  int: "INT",
  wis: "SAB",
  cha: "CAR",
};

const ABILITY_ORDER: (keyof AbilityScores)[] = [
  "str",
  "dex",
  "con",
  "int",
  "wis",
  "cha",
];

const DEFAULT_ABILITIES: AbilityScores = {
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
};

const DEFAULT_TRAITS: SheetTraits = {
  personality: "",
  ideals: "",
  bonds: "",
  flaws: "",
};

/** Standard 5e skills (Portuguese) with their governing ability. */
const DEFAULT_SKILLS: ReadonlyArray<{
  name: string;
  ability: keyof AbilityScores;
}> = [
  { name: "Acrobacia", ability: "dex" },
  { name: "Adestramiento", ability: "wis" },
  { name: "Arcanismo", ability: "int" },
  { name: "Atletismo", ability: "str" },
  { name: "Enganação", ability: "cha" },
  { name: "História", ability: "int" },
  { name: "Intimidação", ability: "cha" },
  { name: "Investigação", ability: "int" },
  { name: "Medicina", ability: "wis" },
  { name: "Natureza", ability: "int" },
  { name: "Percepção", ability: "wis" },
  { name: "Atuação", ability: "cha" },
  { name: "Persuasão", ability: "cha" },
  { name: "Religião", ability: "int" },
  { name: "Prestidigitação", ability: "dex" },
  { name: "Furtividade", ability: "dex" },
  { name: "Sobrevivência", ability: "wis" },
];

const PROF_BONUS = 2;

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

function modText(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string): HTMLElement {
  const sec = el("div", "sheet-section");
  sec.append(el("h3", "sheet-section-title", title));
  return sec;
}

/** Render the full character sheet panel into `container`. */
export function renderSheetPanel(
  container: HTMLElement,
  sheet: Sheet,
  callbacks: SheetPanelCallbacks,
): void {
  const { onChange } = callbacks;
  container.innerHTML = "";

  /** Latest sheet the panel knows about, so edits accumulate. */
  let current: Sheet = sheet;

  /** Clone + mutate + emit: every edit path goes through here. */
  function update(mutate: (draft: Sheet) => void): void {
    const draft = structuredClone(current);
    mutate(draft);
    current = draft;
    onChange(draft);
  }

  /** Direct d20 roll: resolved host-side by the caller. */
  function roll(mod: number, label: string): void {
    if (!callbacks.onRoll) return;
    callbacks.onRoll(label, resolveRoll({ sides: 20, mod }));
  }

  /** Current live value of an ability input (falls back to default). */
  function liveScore(ability: keyof AbilityScores): number {
    const raw = abilityInputs.get(ability)?.value ?? "";
    const v = Number(raw);
    return Number.isFinite(v) ? v : DEFAULT_ABILITIES[ability];
  }

  /** Rows (saves/skills) whose modifier depends on an ability score. */
  const dependents: Array<{
    ability: keyof AbilityScores;
    prof: HTMLInputElement;
    modSpan: HTMLElement;
  }> = [];

  const abilityInputs = new Map<keyof AbilityScores, HTMLInputElement>();

  const panel = el("div", "sheet-panel");
  panel.append(el("h2", "sheet-title", "Ficha"));

  // ── Header: portrait + name + HP/AC ──
  const header = el("div", "sheet-header");

  const photoLabel = document.createElement("label");
  photoLabel.className = "sheet-photo" + (sheet.photo ? "" : " sheet-photo-empty");
  photoLabel.title = "Mudar foto";
  const photoImg = document.createElement("img");
  photoImg.alt = `Retrato de ${sheet.name}`;
  if (sheet.photo) photoImg.src = sheet.photo;
  photoLabel.appendChild(photoImg);
  if (!sheet.photo) {
    photoLabel.appendChild(el("span", "sheet-photo-placeholder", "📷"));
  }
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.className = "sheet-photo-input";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        const dataUrl = reader.result;
        update((draft) => {
          draft.photo = dataUrl;
        });
        // Reflect the new portrait in place (no full re-render, so the
        // file input the user just used stays mounted).
        photoLabel.classList.remove("sheet-photo-empty");
        photoImg.src = dataUrl;
        photoImg.alt = `Retrato de ${current.name}`;
        photoLabel.querySelector(".sheet-photo-placeholder")?.remove();
      }
    };
    reader.readAsDataURL(file);
  });
  photoLabel.appendChild(fileInput);
  header.appendChild(photoLabel);

  const nameInput = document.createElement("input");
  nameInput.className = "sheet-name";
  nameInput.value = sheet.name;
  nameInput.placeholder = "Nome do personagem";
  nameInput.addEventListener("input", () => {
    update((draft) => {
      draft.name = nameInput.value;
    });
  });
  header.appendChild(nameInput);

  const stats = el("div", "sheet-stats");
  const statDefs: Array<{ label: string; value: number; key: "hp" | "maxHp" | "ac" }> = [
    { label: "HP", value: sheet.hp, key: "hp" },
    { label: "HP Máx", value: sheet.maxHp, key: "maxHp" },
    { label: "CA", value: sheet.ac, key: "ac" },
  ];
  for (const def of statDefs) {
    const wrap = el("label", "sheet-stat");
    wrap.append(el("span", "sheet-stat-label", def.label));
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(def.value);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      update((draft) => {
        draft[def.key] = v;
      });
    });
    wrap.appendChild(input);
    stats.appendChild(wrap);
  }
  header.appendChild(stats);
  panel.appendChild(header);

  // ── Atributos ──
  const abilitiesSection = section("Atributos");
  const abGrid = el("div", "sheet-abilities");
  for (const key of ABILITY_ORDER) {
    const score = sheet.abilities?.[key] ?? DEFAULT_ABILITIES[key];
    const card = el("button", "ability-card");
    card.type = "button";
    card.title = `Rolar d20 ${modText(abilityMod(score))} (${ABILITY_LABELS[key]})`;
    card.append(el("span", "ability-name", ABILITY_LABELS[key]));
    const scoreInput = document.createElement("input");
    scoreInput.type = "number";
    scoreInput.value = String(score);
    scoreInput.className = "ability-score";
    scoreInput.title = `Valor de ${ABILITY_LABELS[key]}`;
    const modSpan = el("span", "ability-mod", modText(abilityMod(score)));
    abilityInputs.set(key, scoreInput);
    scoreInput.addEventListener("input", () => {
      const v = Number(scoreInput.value);
      if (!Number.isFinite(v)) return;
      modSpan.textContent = modText(abilityMod(v));
      // Refresh save/skill modifiers that depend on this ability.
      for (const dep of dependents) {
        if (dep.ability !== key) continue;
        dep.modSpan.textContent = modText(
          abilityMod(liveScore(key)) + (dep.prof.checked ? PROF_BONUS : 0),
        );
      }
      update((draft) => {
        draft.abilities = { ...(draft.abilities ?? { ...DEFAULT_ABILITIES }), [key]: v };
      });
    });
    scoreInput.addEventListener("click", (ev) => ev.stopPropagation());
    card.append(scoreInput, modSpan);
    card.addEventListener("click", () => {
      roll(abilityMod(liveScore(key)), ABILITY_LABELS[key]);
    });
    abGrid.appendChild(card);
  }
  abilitiesSection.appendChild(abGrid);
  panel.appendChild(abilitiesSection);

  // ── Salvamentos ──
  const savesSection = section("Salvamentos");
  const savesList = el("div", "sheet-list");
  const saves: Save[] =
    sheet.saves ?? ABILITY_ORDER.map((ability) => ({ ability, proficient: false }));
  for (const save of saves) {
    const row = el("button", "sheet-row save-row");
    row.type = "button";
    row.title = "Rolar salvamento";
    const prof = document.createElement("input");
    prof.type = "checkbox";
    prof.checked = save.proficient;
    prof.className = "sheet-prof";
    prof.title = "Proficiência";
    prof.addEventListener("click", (ev) => ev.stopPropagation());
    const modSpan = el("span", "sheet-row-mod", "");
    dependents.push({ ability: save.ability, prof, modSpan });
    modSpan.textContent = modText(
      abilityMod(liveScore(save.ability)) + (prof.checked ? PROF_BONUS : 0),
    );
    prof.addEventListener("change", () => {
      modSpan.textContent = modText(
        abilityMod(liveScore(save.ability)) + (prof.checked ? PROF_BONUS : 0),
      );
      update((draft) => {
        draft.saves = (
          draft.saves ?? ABILITY_ORDER.map((a) => ({ ability: a, proficient: false }))
        ).map((s) =>
          s.ability === save.ability ? { ...s, proficient: prof.checked } : s,
        );
      });
    });
    row.append(
      prof,
      el("span", "sheet-row-name", ABILITY_LABELS[save.ability]),
      modSpan,
    );
    row.addEventListener("click", () => {
      roll(
        abilityMod(liveScore(save.ability)) + (prof.checked ? PROF_BONUS : 0),
        `Salvamento de ${ABILITY_LABELS[save.ability]}`,
      );
    });
    savesList.appendChild(row);
  }
  savesSection.appendChild(savesList);
  panel.appendChild(savesSection);

  // ── Perícias ──
  const skillsSection = section("Perícias");
  const skillsList = el("div", "sheet-list");
  const skills: Skill[] =
    sheet.skills ??
    DEFAULT_SKILLS.map((s) => ({ ...s, id: slugify(s.name), proficient: false }));
  for (const skill of skills) {
    const row = el("button", "sheet-row skill-row");
    row.type = "button";
    row.title = "Rolar perícia";
    const prof = document.createElement("input");
    prof.type = "checkbox";
    prof.checked = skill.proficient;
    prof.className = "sheet-prof";
    prof.title = "Proficiência";
    prof.addEventListener("click", (ev) => ev.stopPropagation());
    const modSpan = el("span", "sheet-row-mod", "");
    dependents.push({ ability: skill.ability, prof, modSpan });
    modSpan.textContent = modText(
      abilityMod(liveScore(skill.ability)) + (prof.checked ? PROF_BONUS : 0),
    );
    prof.addEventListener("change", () => {
      modSpan.textContent = modText(
        abilityMod(liveScore(skill.ability)) + (prof.checked ? PROF_BONUS : 0),
      );
      update((draft) => {
        draft.skills = (
          draft.skills ??
          DEFAULT_SKILLS.map((s) => ({ ...s, id: slugify(s.name), proficient: false }))
        ).map((s) => (s.id === skill.id ? { ...s, proficient: prof.checked } : s));
      });
    });
    row.append(
      prof,
      el("span", "sheet-row-name", `${skill.name} (${ABILITY_LABELS[skill.ability]})`),
      modSpan,
    );
    row.addEventListener("click", () => {
      roll(
        abilityMod(liveScore(skill.ability)) + (prof.checked ? PROF_BONUS : 0),
        skill.name,
      );
    });
    skillsList.appendChild(row);
  }
  skillsSection.appendChild(skillsList);
  panel.appendChild(skillsSection);

  // ── Inventário ──
  const invSection = section("Inventário");
  const invList = el("div", "sheet-list");

  /** One editable inventory row (name + qty + delete). */
  function inventoryRow(item: InventoryItem): HTMLElement {
    const row = el("div", "sheet-row sheet-row-edit");
    const rowName = document.createElement("input");
    rowName.value = item.name;
    rowName.className = "sheet-row-input";
    rowName.placeholder = "Item";
    rowName.addEventListener("input", () => {
      update((draft) => {
        draft.inventory = (draft.inventory ?? []).map((i) =>
          i.id === item.id ? { ...i, name: rowName.value } : i,
        );
      });
    });
    const rowQty = document.createElement("input");
    rowQty.type = "number";
    rowQty.value = String(item.qty);
    rowQty.className = "sheet-row-input sheet-row-qty";
    rowQty.title = "Quantidade";
    rowQty.addEventListener("input", () => {
      const v = Number(rowQty.value);
      if (!Number.isFinite(v)) return;
      update((draft) => {
        draft.inventory = (draft.inventory ?? []).map((i) =>
          i.id === item.id ? { ...i, qty: v } : i,
        );
      });
    });
    const rowDel = el("button", "sheet-row-del", "✕");
    rowDel.type = "button";
    rowDel.title = "Remover item";
    rowDel.addEventListener("click", () => {
      update((draft) => {
        draft.inventory = (draft.inventory ?? []).filter((i) => i.id !== item.id);
      });
      row.remove();
    });
    row.append(rowName, rowQty, rowDel);
    return row;
  }

  const items: InventoryItem[] = sheet.inventory ?? [];
  for (const item of items) {
    invList.appendChild(inventoryRow(item));
  }
  const addItem = el("button", "sheet-add sheet-add-item", "+ Adicionar item");
  addItem.type = "button";
  addItem.addEventListener("click", () => {
    const item: InventoryItem = { id: newId(), name: "Novo item", qty: 1 };
    update((draft) => {
      draft.inventory = [...(draft.inventory ?? []), item];
    });
    // Show the editable row right away (no re-render, keeps focus).
    const added = inventoryRow(item);
    invList.appendChild(added);
    added.querySelector<HTMLInputElement>(".sheet-row-input")?.focus();
  });
  invSection.append(invList, addItem);
  panel.appendChild(invSection);

  // ── Traços ──
  const traitsSection = section("Traços");
  const traits: SheetTraits = sheet.traits ?? { ...DEFAULT_TRAITS };
  const traitFields: Array<[keyof SheetTraits, string, string]> = [
    ["personality", "Personalidade", "Traços de personalidade"],
    ["ideals", "Ideais", "Ideais do personagem"],
    ["bonds", "Ligações", "Ligações com pessoas/lugares"],
    ["flaws", "Defeitos", "Defeitos e fraquezas"],
  ];
  for (const [key, label, placeholder] of traitFields) {
    const field = el("label", "sheet-field");
    field.append(el("span", "sheet-field-label", label));
    const input = document.createElement("input");
    input.value = traits[key];
    input.placeholder = placeholder;
    input.addEventListener("input", () => {
      update((draft) => {
        draft.traits = { ...(draft.traits ?? { ...DEFAULT_TRAITS }), [key]: input.value };
      });
    });
    field.appendChild(input);
    traitsSection.appendChild(field);
  }
  panel.appendChild(traitsSection);

  // ── Condicionais ──
  const condSection = section("Condições");
  const condList = el("div", "sheet-list");

  /** One editable condition row (name + duration + effect + delete). */
  function conditionRow(cond: Condition): HTMLElement {
    const row = el("div", "sheet-row sheet-row-edit sheet-cond-row");
    const rowName = document.createElement("input");
    rowName.value = cond.name;
    rowName.className = "sheet-row-input";
    rowName.placeholder = "Condição";
    rowName.addEventListener("input", () => {
      update((draft) => {
        draft.conditions = (draft.conditions ?? []).map((c) =>
          c.id === cond.id ? { ...c, name: rowName.value } : c,
        );
      });
    });
    const durationInput = document.createElement("input");
    durationInput.value = cond.duration;
    durationInput.className = "sheet-row-input";
    durationInput.placeholder = "Duração";
    durationInput.addEventListener("input", () => {
      update((draft) => {
        draft.conditions = (draft.conditions ?? []).map((c) =>
          c.id === cond.id ? { ...c, duration: durationInput.value } : c,
        );
      });
    });
    const effectInput = document.createElement("input");
    effectInput.value = cond.effect;
    effectInput.className = "sheet-row-input";
    effectInput.placeholder = "Efeito";
    effectInput.addEventListener("input", () => {
      update((draft) => {
        draft.conditions = (draft.conditions ?? []).map((c) =>
          c.id === cond.id ? { ...c, effect: effectInput.value } : c,
        );
      });
    });
    const rowDel = el("button", "sheet-row-del", "✕");
    rowDel.type = "button";
    rowDel.title = "Remover condição";
    rowDel.addEventListener("click", () => {
      update((draft) => {
        draft.conditions = (draft.conditions ?? []).filter((c) => c.id !== cond.id);
      });
      row.remove();
    });
    row.append(rowName, durationInput, effectInput, rowDel);
    return row;
  }

  const conditions: Condition[] = sheet.conditions ?? [];
  for (const cond of conditions) {
    condList.appendChild(conditionRow(cond));
  }
  const addCond = el("button", "sheet-add sheet-add-condition", "+ Adicionar condição");
  addCond.type = "button";
  addCond.addEventListener("click", () => {
    const cond: Condition = { id: newId(), name: "Nova condição", duration: "", effect: "" };
    update((draft) => {
      draft.conditions = [...(draft.conditions ?? []), cond];
    });
    // Show the editable row right away (no re-render, keeps focus).
    const added = conditionRow(cond);
    condList.appendChild(added);
    added.querySelector<HTMLInputElement>(".sheet-row-input")?.focus();
  });
  condSection.append(condList, addCond);
  panel.appendChild(condSection);

  // ── Anotações ──
  const notesSection = section("Anotações");
  const notes = document.createElement("textarea");
  notes.className = "sheet-notes";
  notes.value = sheet.notes ?? "";
  notes.rows = 5;
  notes.placeholder = "Anotações livres...";
  notes.addEventListener("input", () => {
    update((draft) => {
      draft.notes = notes.value;
    });
  });
  notesSection.appendChild(notes);
  panel.appendChild(notesSection);

  container.appendChild(panel);
}
