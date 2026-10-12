// Roll20-style character sheet panel (right sidebar): tabbed layout
// (Core | Bio | Magias/Equip) with a Roll20 header (name, class, level,
// race, alignment, XP), portrait upload, editable abilities/skills/saves
// with one-click d20 rolls, attacks, spells/slots, inventory, money,
// traits, languages, conditions and notes. Pure DOM; every edit fires
// `onChange` with the full updated sheet (the caller decides
// persistence). Rolls go through `onRoll` so the caller can publish
// them host-side, and the last roll renders inline with crit/fumble
// highlight. No central server; no WotC art.

import { resolveRoll, type RngLike, type RollResult } from "../dice/roller";
import { profBonusForLevel } from "../sheet/level";
import { rollRequest } from "../sheet/srd";
import { abilityMod, initiativeTotal, modText } from "../sheet/stats";
import type {
  AbilityScores,
  Attack,
  Condition,
  InventoryItem,
  Money,
  Save,
  Sheet,
  SheetTraits,
  Skill,
  Spell,
  SpellSlot,
} from "../sheet/types";

export interface SheetPanelCallbacks {
  /** Fired on every edit with the full updated sheet. */
  onChange: (sheet: Sheet) => void;
  /** Fired on a direct roll (ability/save/skill/attack) with the resolved result. */
  onRoll?: (label: string, result: RollResult) => void;
  /** Entropy for direct rolls (defaults to Math.random; tests inject a stub). */
  rng?: RngLike;
}

export const ABILITY_LABELS: Record<keyof AbilityScores, string> = {
  str: "FOR",
  dex: "DES",
  con: "CON",
  int: "INT",
  wis: "SAB",
  cha: "CAR",
};

export const ABILITY_ORDER: (keyof AbilityScores)[] = [
  "str",
  "dex",
  "con",
  "int",
  "wis",
  "cha",
];

export const DEFAULT_ABILITIES: AbilityScores = {
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

const DEFAULT_MONEY: Money = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };

/** Standard 5e skills (Portuguese) with their governing ability. */
export const DEFAULT_SKILLS: ReadonlyArray<{
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

  /** Proficiency follows the level (legacy sheets without a level keep theirs). */
  function liveProf(): number {
    if (current.level !== undefined) return profBonusForLevel(current.level);
    return current.profBonus ?? 2;
  }

  /** Last-roll readout (crit 20 / fumble 1 highlighted). */
  const rollLine = el("div", "sheet-roll-line");

  /** Direct d20 roll: normalized via rollRequest, resolved, published by the caller. */
  function roll(mod: number, label: string): void {
    const result = resolveRoll(
      rollRequest({ sides: 20, mod }),
      callbacks.rng ?? Math.random,
    );
    callbacks.onRoll?.(label, result);
    const face = result.rolls[0] ?? 0;
    const tag =
      face === 20 ? " — CRÍTICO!" : face === 1 ? " — FALHA CRÍTICA!" : "";
    rollLine.textContent = `${label}: ${face} ${modText(mod)} = ${result.total}${tag}`;
    rollLine.className =
      "sheet-roll-line show" +
      (face === 20 ? " crit" : face === 1 ? " fumble" : "");
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
  panel.append(el("h2", "sheet-title", "Ficha"), rollLine);

  // ── Header: portrait + identity (Roll20: name/class/level/race/alignment/XP) ──
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

  const identity = el("div", "sheet-identity");
  const classInput = document.createElement("input");
  classInput.className = "sheet-class";
  classInput.value = sheet.charClass ?? "";
  classInput.placeholder = "Classe";
  classInput.title = "Classe";
  classInput.addEventListener("input", () => {
    update((draft) => {
      draft.charClass = classInput.value;
    });
  });
  const levelInput = document.createElement("input");
  levelInput.type = "number";
  levelInput.className = "sheet-level";
  levelInput.value = String(sheet.level ?? 1);
  levelInput.min = "1";
  levelInput.max = "20";
  levelInput.title = "Nível";
  const raceInput = document.createElement("input");
  raceInput.className = "sheet-race";
  raceInput.value = sheet.race ?? "";
  raceInput.placeholder = "Raça";
  raceInput.title = "Raça";
  raceInput.addEventListener("input", () => {
    update((draft) => {
      draft.race = raceInput.value;
    });
  });
  const alignInput = document.createElement("input");
  alignInput.className = "sheet-alignment";
  alignInput.value = sheet.alignment ?? "";
  alignInput.placeholder = "Alinhamento";
  alignInput.title = "Alinhamento";
  alignInput.addEventListener("input", () => {
    update((draft) => {
      draft.alignment = alignInput.value;
    });
  });
  const xpInput = document.createElement("input");
  xpInput.type = "number";
  xpInput.className = "sheet-xp";
  xpInput.value = String(sheet.xp ?? 0);
  xpInput.min = "0";
  xpInput.title = "XP";
  xpInput.addEventListener("input", () => {
    const v = Number(xpInput.value);
    if (!Number.isFinite(v)) return;
    update((draft) => {
      draft.xp = Math.max(0, Math.floor(v));
    });
  });
  identity.append(classInput, levelInput, raceInput, alignInput, xpInput);
  header.appendChild(identity);
  panel.appendChild(header);

  /** Refresh save/skill modifiers plus combat readouts after a change. */
  function refreshDerived(changedAbility?: keyof AbilityScores): void {
    for (const dep of dependents) {
      if (changedAbility !== undefined && dep.ability !== changedAbility) {
        continue;
      }
      dep.modSpan.textContent = modText(
        abilityMod(liveScore(dep.ability)) +
          (dep.prof.checked ? liveProf() : 0),
      );
    }
    profOut.textContent = modText(liveProf());
    initOut.textContent = modText(
      initiativeTotal(liveScore("dex"), liveInitMisc()),
    );
  }

  levelInput.addEventListener("input", () => {
    const v = Number(levelInput.value);
    if (!Number.isFinite(v)) return;
    const level = Math.min(20, Math.max(1, Math.floor(v)));
    update((draft) => {
      draft.level = level;
      draft.profBonus = profBonusForLevel(level);
    });
    refreshDerived();
  });

  // ── Tabs: Core | Bio | Magias/Equip ──
  const tabs = el("div", "sheet-tabs");
  const tabPanels = new Map<string, HTMLElement>();
  for (const [id, label] of [
    ["core", "Core"],
    ["bio", "Bio"],
    ["spells", "Magias/Equip"],
  ] as const) {
    const btn = el("button", "sheet-tab" + (id === "core" ? " active" : ""), label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      for (const [panelId, panelEl] of tabPanels) {
        panelEl.style.display = panelId === id ? "" : "none";
      }
      for (const other of tabs.querySelectorAll(".sheet-tab")) {
        other.classList.toggle("active", other === btn);
      }
    });
    tabs.appendChild(btn);
    const tabPanel = el("div", "sheet-tab-panel");
    tabPanel.dataset.tabPanel = id;
    tabPanel.style.display = id === "core" ? "" : "none";
    tabPanels.set(id, tabPanel);
    panel.appendChild(tabPanel);
  }
  // Tabs sit right under the header: move them before the panels.
  const corePanel = tabPanels.get("core")!;
  const bioPanel = tabPanels.get("bio")!;
  const spellsPanel = tabPanels.get("spells")!;
  panel.insertBefore(tabs, corePanel);

  // ── Core: combate ──
  const combat = section("Combate");
  const combatGrid = el("div", "sheet-combat-grid");
  const statDefs: Array<{
    label: string;
    value: number;
    key: "hp" | "maxHp" | "ac" | "tempHp";
  }> = [
    { label: "HP", value: sheet.hp, key: "hp" },
    { label: "HP Máx", value: sheet.maxHp, key: "maxHp" },
    { label: "CA", value: sheet.ac, key: "ac" },
    { label: "Temp", value: sheet.tempHp ?? 0, key: "tempHp" },
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
    combatGrid.appendChild(wrap);
  }
  combat.appendChild(combatGrid);

  const combatRows = el("div", "sheet-combat-rows");
  const inspLabel = el("label", "sheet-check-row");
  const inspCheck = document.createElement("input");
  inspCheck.type = "checkbox";
  inspCheck.className = "sheet-inspiration";
  inspCheck.checked = sheet.inspiration ?? false;
  inspCheck.addEventListener("change", () => {
    update((draft) => {
      draft.inspiration = inspCheck.checked;
    });
  });
  inspLabel.append(inspCheck, el("span", "sheet-check-name", "Inspiração"));
  combatRows.appendChild(inspLabel);

  const speedLabel = el("label", "sheet-inline-field");
  speedLabel.append(el("span", "sheet-field-label", "Desloc. (m)"));
  const speedInput = document.createElement("input");
  speedInput.type = "number";
  speedInput.className = "sheet-speed";
  speedInput.value = String(sheet.speed ?? 9);
  speedInput.min = "0";
  speedInput.addEventListener("input", () => {
    const v = Number(speedInput.value);
    if (!Number.isFinite(v)) return;
    update((draft) => {
      draft.speed = v;
    });
  });
  speedLabel.appendChild(speedInput);
  combatRows.appendChild(speedLabel);

  const initWrap = el("div", "sheet-inline-field");
  const initBtn = el("button", "sheet-init-btn", "Iniciativa");
  initBtn.type = "button";
  initBtn.title = "Rolar iniciativa (d20 + DES + extra)";
  const initOut = el("span", "sheet-initiative", "");
  const initMisc = document.createElement("input");
  initMisc.type = "number";
  initMisc.className = "sheet-init-misc";
  initMisc.value = String(sheet.initiativeMisc ?? 0);
  initMisc.title = "Bônus extra de iniciativa";
  initBtn.addEventListener("click", () => {
    roll(
      initiativeTotal(liveScore("dex"), liveInitMisc()),
      "Iniciativa",
    );
  });
  initWrap.append(initBtn, initOut, initMisc);
  combatRows.appendChild(initWrap);

  const profWrap = el("div", "sheet-inline-field");
  profWrap.append(el("span", "sheet-field-label", "Proficiência"));
  const profOut = el("span", "sheet-prof-bonus", modText(liveProf()));
  profWrap.appendChild(profOut);
  combatRows.appendChild(profWrap);
  combat.appendChild(combatRows);

  // Death saves: three successes vs three failures.
  const deathWrap = el("div", "sheet-death-saves");
  deathWrap.append(el("span", "sheet-field-label", "Testes de morte"));
  const deathGroups = el("div", "sheet-death-groups");
  const deathChecks: HTMLInputElement[] = [];
  for (const [kind, count] of [["success", 3], ["failure", 3]] as const) {
    const group = el("div", `sheet-death-group sheet-death-${kind}`);
    group.append(
      el("span", "sheet-death-label", kind === "success" ? "✓" : "✕"),
    );
    const saved =
      kind === "success"
        ? (sheet.deathSaves?.successes ?? 0)
        : (sheet.deathSaves?.failures ?? 0);
    for (let i = 0; i < count; i++) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = i < saved;
      check.title = kind === "success" ? "Sucesso" : "Falha";
      check.addEventListener("change", () => {
        const succ = deathChecks
          .slice(0, 3)
          .filter((c) => c.checked).length;
        const fail = deathChecks.slice(3).filter((c) => c.checked).length;
        update((draft) => {
          draft.deathSaves = { successes: succ, failures: fail };
        });
      });
      deathChecks.push(check);
      group.appendChild(check);
    }
    deathGroups.appendChild(group);
  }
  deathWrap.appendChild(deathGroups);
  combat.appendChild(deathWrap);
  corePanel.appendChild(combat);

  function liveInitMisc(): number {
    const v = Number(initMisc.value);
    return Number.isFinite(v) ? v : 0;
  }
  initMisc.addEventListener("input", () => {
    const v = Number(initMisc.value);
    if (!Number.isFinite(v)) return;
    update((draft) => {
      draft.initiativeMisc = v;
    });
    initOut.textContent = modText(
      initiativeTotal(liveScore("dex"), liveInitMisc()),
    );
  });
  initOut.textContent = modText(
    initiativeTotal(liveScore("dex"), liveInitMisc()),
  );

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
      refreshDerived(key);
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
  corePanel.appendChild(abilitiesSection);

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
      abilityMod(liveScore(save.ability)) + (prof.checked ? liveProf() : 0),
    );
    prof.addEventListener("change", () => {
      modSpan.textContent = modText(
        abilityMod(liveScore(save.ability)) + (prof.checked ? liveProf() : 0),
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
        abilityMod(liveScore(save.ability)) + (prof.checked ? liveProf() : 0),
        `Salvamento de ${ABILITY_LABELS[save.ability]}`,
      );
    });
    savesList.appendChild(row);
  }
  savesSection.appendChild(savesList);
  corePanel.appendChild(savesSection);

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
      abilityMod(liveScore(skill.ability)) + (prof.checked ? liveProf() : 0),
    );
    prof.addEventListener("change", () => {
      modSpan.textContent = modText(
        abilityMod(liveScore(skill.ability)) + (prof.checked ? liveProf() : 0),
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
        abilityMod(liveScore(skill.ability)) + (prof.checked ? liveProf() : 0),
        skill.name,
      );
    });
    skillsList.appendChild(row);
  }
  skillsSection.appendChild(skillsList);
  corePanel.appendChild(skillsSection);

  // ── Ataques ──
  const atkSection = section("Ataques");
  const atkList = el("div", "sheet-list");

  /** One attack row: roll button + editable name/bonus/damage + delete. */
  function attackRow(attack: Attack): HTMLElement {
    const row = el("button", "sheet-row attack-row");
    row.type = "button";
    row.title = `Rolar ataque (${attack.damage})`;
    const nameIn = document.createElement("input");
    nameIn.value = attack.name;
    nameIn.className = "attack-name";
    nameIn.placeholder = "Ataque";
    nameIn.addEventListener("click", (ev) => ev.stopPropagation());
    nameIn.addEventListener("input", () => {
      update((draft) => {
        draft.attacks = (draft.attacks ?? []).map((a) =>
          a.id === attack.id ? { ...a, name: nameIn.value } : a,
        );
      });
    });
    const bonusIn = document.createElement("input");
    bonusIn.type = "number";
    bonusIn.value = String(attack.bonus);
    bonusIn.className = "attack-bonus";
    bonusIn.title = "Bônus de ataque";
    bonusIn.addEventListener("click", (ev) => ev.stopPropagation());
    bonusIn.addEventListener("input", () => {
      const v = Number(bonusIn.value);
      if (!Number.isFinite(v)) return;
      update((draft) => {
        draft.attacks = (draft.attacks ?? []).map((a) =>
          a.id === attack.id ? { ...a, bonus: v } : a,
        );
      });
    });
    const dmgIn = document.createElement("input");
    dmgIn.value = attack.damage;
    dmgIn.className = "attack-damage";
    dmgIn.placeholder = "1d8+3";
    dmgIn.title = "Dano";
    dmgIn.addEventListener("click", (ev) => ev.stopPropagation());
    dmgIn.addEventListener("input", () => {
      update((draft) => {
        draft.attacks = (draft.attacks ?? []).map((a) =>
          a.id === attack.id ? { ...a, damage: dmgIn.value } : a,
        );
      });
    });
    const del = el("button", "attack-del", "✕");
    del.type = "button";
    del.title = "Remover ataque";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      update((draft) => {
        draft.attacks = (draft.attacks ?? []).filter((a) => a.id !== attack.id);
      });
      row.remove();
    });
    const modSpan = el("span", "sheet-row-mod", modText(attack.bonus));
    bonusIn.addEventListener("input", () => {
      const v = Number(bonusIn.value);
      if (Number.isFinite(v)) modSpan.textContent = modText(v);
    });
    row.append(nameIn, bonusIn, dmgIn, modSpan, del);
    row.addEventListener("click", () => {
      roll(Number(bonusIn.value) || 0, attack.name || "Ataque");
    });
    return row;
  }

  for (const attack of sheet.attacks ?? []) {
    atkList.appendChild(attackRow(attack));
  }
  const addAtk = el("button", "sheet-add sheet-add-attack", "+ Adicionar ataque");
  addAtk.type = "button";
  addAtk.addEventListener("click", () => {
    const attack: Attack = {
      id: newId(),
      name: "Novo ataque",
      bonus: liveProf() + abilityMod(liveScore("str")),
      damage: "1d6",
    };
    update((draft) => {
      draft.attacks = [...(draft.attacks ?? []), attack];
    });
    const added = attackRow(attack);
    atkList.appendChild(added);
    added.querySelector<HTMLInputElement>(".attack-name")?.focus();
  });
  atkSection.append(atkList, addAtk);
  corePanel.appendChild(atkSection);

  // ── Bio: traços ──
  const traitsSection = section("Traços");
  const traits: SheetTraits = sheet.traits ?? { ...DEFAULT_TRAITS };
  const traitFields: Array<[keyof SheetTraits, string, string]> = [
    ["personality", "Personalidade", "Traços de personalidade"],
    ["ideals", "Ideais", "Ideais do personagem"],
    ["bonds", "Ligações", "Ligações com pessoas/lugares"],
    ["flaws", "Defeitos", "Defeitos e fraquezas"],
  ];
  for (const [key, label, placeholder] of traitFields) {
    const fieldEl = el("label", "sheet-field");
    fieldEl.append(el("span", "sheet-field-label", label));
    const input = document.createElement("input");
    input.value = traits[key];
    input.placeholder = placeholder;
    input.addEventListener("input", () => {
      update((draft) => {
        draft.traits = { ...(draft.traits ?? { ...DEFAULT_TRAITS }), [key]: input.value };
      });
    });
    fieldEl.appendChild(input);
    traitsSection.appendChild(fieldEl);
  }
  bioPanel.appendChild(traitsSection);

  // ── Bio: idiomas + história ──
  const langSection = section("Idiomas");
  const langInput = document.createElement("input");
  langInput.className = "sheet-language";
  langInput.value = sheet.languages ?? "";
  langInput.placeholder = "Comum, Élfico...";
  langInput.addEventListener("input", () => {
    update((draft) => {
      draft.languages = langInput.value;
    });
  });
  langSection.appendChild(langInput);
  bioPanel.appendChild(langSection);

  const storySection = section("História");
  const story = document.createElement("textarea");
  story.className = "sheet-backstory";
  story.value = sheet.backstory ?? "";
  story.rows = 5;
  story.placeholder = "História do personagem...";
  story.addEventListener("input", () => {
    update((draft) => {
      draft.backstory = story.value;
    });
  });
  storySection.appendChild(story);
  bioPanel.appendChild(storySection);

  // ── Bio: condições ──
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
  bioPanel.appendChild(condSection);

  // ── Bio: anotações ──
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
  bioPanel.appendChild(notesSection);

  // ── Magias/Equip: magias ──
  const spellsSection = section("Magias");
  const spellsList = el("div", "sheet-list");

  /** One editable spell row (name + level + delete). */
  function spellRow(spell: Spell): HTMLElement {
    const row = el("div", "sheet-row sheet-row-edit");
    const nameIn = document.createElement("input");
    nameIn.value = spell.name;
    nameIn.className = "spell-name";
    nameIn.placeholder = "Magia";
    nameIn.addEventListener("input", () => {
      update((draft) => {
        draft.spells = (draft.spells ?? []).map((s) =>
          s.id === spell.id ? { ...s, name: nameIn.value } : s,
        );
      });
    });
    const levelIn = document.createElement("input");
    levelIn.type = "number";
    levelIn.value = String(spell.level);
    levelIn.min = "0";
    levelIn.max = "9";
    levelIn.className = "spell-level";
    levelIn.title = "Nível (0 = truque)";
    levelIn.addEventListener("input", () => {
      const v = Number(levelIn.value);
      if (!Number.isFinite(v)) return;
      update((draft) => {
        draft.spells = (draft.spells ?? []).map((s) =>
          s.id === spell.id ? { ...s, level: Math.max(0, Math.floor(v)) } : s,
        );
      });
    });
    const del = el("button", "spell-del", "✕");
    del.type = "button";
    del.title = "Remover magia";
    del.addEventListener("click", () => {
      update((draft) => {
        draft.spells = (draft.spells ?? []).filter((s) => s.id !== spell.id);
      });
      row.remove();
    });
    row.append(nameIn, levelIn, del);
    return row;
  }

  for (const spell of sheet.spells ?? []) {
    spellsList.appendChild(spellRow(spell));
  }
  const addSpell = el("button", "sheet-add sheet-add-spell", "+ Adicionar magia");
  addSpell.type = "button";
  addSpell.addEventListener("click", () => {
    const spell: Spell = { id: newId(), name: "Nova magia", level: 1 };
    update((draft) => {
      draft.spells = [...(draft.spells ?? []), spell];
    });
    const added = spellRow(spell);
    spellsList.appendChild(added);
    added.querySelector<HTMLInputElement>(".spell-name")?.focus();
  });

  const slotsSection = section("Slots de magia");
  const slotsList = el("div", "sheet-list");

  /** Local slot objects (no ids): rows mutate their own entry in place. */
  let slots: SpellSlot[] = (sheet.spellSlots ?? []).map((s) => ({ ...s }));

  function pushSlots(): void {
    const snapshot = slots.map((s) => ({ ...s }));
    update((draft) => {
      draft.spellSlots = snapshot;
    });
  }

  /** One spell-slot row (level + total + used + delete). */
  function slotRow(slot: SpellSlot): HTMLElement {
    const row = el("div", "sheet-row sheet-row-edit");
    const levelIn = document.createElement("input");
    levelIn.type = "number";
    levelIn.value = String(slot.level);
    levelIn.min = "1";
    levelIn.max = "9";
    levelIn.className = "slot-level";
    levelIn.title = "Nível";
    const totalIn = document.createElement("input");
    totalIn.type = "number";
    totalIn.value = String(slot.total);
    totalIn.min = "0";
    totalIn.className = "slot-total";
    totalIn.title = "Total";
    const usedIn = document.createElement("input");
    usedIn.type = "number";
    usedIn.value = String(slot.used);
    usedIn.min = "0";
    usedIn.className = "slot-used";
    usedIn.title = "Usados";
    const sync = (): void => {
      slot.level = Math.max(1, Math.floor(Number(levelIn.value) || 1));
      slot.total = Math.max(0, Math.floor(Number(totalIn.value) || 0));
      slot.used = Math.max(0, Math.floor(Number(usedIn.value) || 0));
      pushSlots();
    };
    for (const input of [levelIn, totalIn, usedIn]) {
      input.addEventListener("input", sync);
    }
    const del = el("button", "slot-del", "✕");
    del.type = "button";
    del.title = "Remover slot";
    del.addEventListener("click", () => {
      slots = slots.filter((entry) => entry !== slot);
      pushSlots();
      row.remove();
    });
    row.append(
      el("span", "sheet-row-name", "Nv"),
      levelIn,
      el("span", "sheet-row-name", "Total"),
      totalIn,
      el("span", "sheet-row-name", "Usados"),
      usedIn,
      del,
    );
    return row;
  }

  for (const slot of slots) {
    slotsList.appendChild(slotRow(slot));
  }
  const addSlot = el("button", "sheet-add sheet-add-slot", "+ Adicionar slot");
  addSlot.type = "button";
  addSlot.addEventListener("click", () => {
    const slot: SpellSlot = { level: 1, total: 2, used: 0 };
    slots.push(slot);
    pushSlots();
    slotsList.appendChild(slotRow(slot));
  });
  spellsSection.append(spellsList, addSpell);
  spellsPanel.appendChild(spellsSection);
  slotsSection.append(slotsList, addSlot);
  spellsPanel.appendChild(slotsSection);

  // ── Magias/Equip: inventário ──
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
  spellsPanel.appendChild(invSection);

  // ── Magias/Equip: dinheiro ──
  const moneySection = section("Dinheiro");
  const moneyGrid = el("div", "sheet-money-grid");
  const money: Money = sheet.money ?? { ...DEFAULT_MONEY };
  for (const coin of ["cp", "sp", "ep", "gp", "pp"] as const) {
    const wrap = el("label", "sheet-stat");
    wrap.append(el("span", "sheet-stat-label", coin.toUpperCase()));
    const input = document.createElement("input");
    input.type = "number";
    input.className = `sheet-money-${coin}`;
    input.value = String(money[coin]);
    input.min = "0";
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      update((draft) => {
        draft.money = {
          ...(draft.money ?? { ...DEFAULT_MONEY }),
          [coin]: Math.max(0, Math.floor(v)),
        };
      });
    });
    wrap.appendChild(input);
    moneyGrid.appendChild(wrap);
  }
  moneySection.appendChild(moneyGrid);
  spellsPanel.appendChild(moneySection);

  container.appendChild(panel);
}
