// Fullscreen character-sheet creator (Roll20-style wizard): a separate
// screen with no grid/map, opened from the menu via `showSheetCreator`.
// Tabs: Atributos | Perícias | Magias/Equip | Bio/Notas. Saving builds a
// `Sheet` with an `ownerId` and hands it to `onSave` (the caller returns
// to the menu/table). Pure DOM; no network, no WotC art.

import { profBonusForLevel } from "../sheet/level";
import { abilityMod, modText } from "../sheet/stats";
import type {
  AbilityScores,
  InventoryItem,
  Money,
  Sheet,
  SheetTraits,
  Skill,
  Spell,
} from "../sheet/types";
import type { SessionPeer } from "../session/peers";
import {
  ABILITY_LABELS,
  ABILITY_ORDER,
  DEFAULT_ABILITIES,
  DEFAULT_SKILLS,
} from "./sheet-panel";

export interface SheetCreatorOptions {
  /** Peer que cria a ficha (hash + nome auto-declarado). */
  authorPeerId?: string;
  /** GM pode escrever ACL livremente; player tem ACL travada. */
  isGM?: boolean;
  /** Peers p/ o GM compartilhar (viewers/controllers). */
  peers?: SessionPeer[];
  /** Legado: dono do slot fixo (migração → authorPeerId). */
  ownerId?: string;
  /** Called with the built sheet when the user saves. */
  onSave: (sheet: Sheet) => void;
  /** Called when the user cancels (nothing is saved). */
  onCancel: () => void;
}

export interface SheetCreator {
  /** Fullscreen overlay root (the caller mounts and removes it). */
  el: HTMLElement;
}

function uid(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampLevel(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.min(20, Math.max(1, Math.floor(raw)));
}

function field(
  label: string,
  input: HTMLElement,
  className = "creator-field",
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = className;
  const span = document.createElement("span");
  span.className = "creator-field-label";
  span.textContent = label;
  wrap.append(span, input);
  return wrap;
}

function textInput(className: string, placeholder = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = className;
  input.placeholder = placeholder;
  return input;
}

function numInput(
  className: string,
  value: number,
  min?: number,
  max?: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = className;
  input.value = String(value);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  return input;
}

/** Build the fullscreen creator; the caller mounts `el` and removes it. */
export function createSheetCreator(options: SheetCreatorOptions): SheetCreator {
  // Sem slots fixos: autor = peer atual (legado ownerId vira peerId).
  const authorPeerId = options.authorPeerId ?? options.ownerId ?? "local-player";
  const isGM = options.isGM ?? false;
  const overlay = document.createElement("div");
  overlay.className = "sheet-creator";

  const card = document.createElement("div");
  card.className = "creator-card";
  overlay.appendChild(card);

  card.appendChild(header("Criar Ficha de Personagem"));

  // ── Identity header (always visible, sem seletor de jogador) ──
  const head = document.createElement("div");
  head.className = "creator-header";

  const nameInput = textInput("creator-name", "Nome do personagem");
  const classInput = textInput("creator-class", "Classe (ex. Guerreiro)");
  const levelInput = numInput("creator-level", 1, 1, 20);
  const raceInput = textInput("creator-race", "Raça");
  const alignInput = textInput("creator-alignment", "Alinhamento");
  const xpInput = numInput("creator-xp", 0, 0);
  const acInput = numInput("creator-ac", 10);
  const hpInput = numInput("creator-hp", 10, 1);
  const profLine = document.createElement("div");
  profLine.className = "creator-prof";

  function refreshProf(): void {
    const level = clampLevel(Number(levelInput.value));
    profLine.textContent = `Bônus de proficiência: ${modText(profBonusForLevel(level))}`;
  }
  levelInput.addEventListener("input", () => {
    refreshProf();
    refreshSkillMods();
  });
  refreshProf();

  head.append(
    field("Nome", nameInput),
    field("Classe", classInput),
    field("Nível", levelInput),
    field("Raça", raceInput),
    field("Alinhamento", alignInput),
    field("XP", xpInput),
    field("CA", acInput),
    field("HP Máx", hpInput),
  );
  card.append(head, profLine);

  // ── Compartilhamento (só GM escreve ACL; player não re-compartilha) ──
  let publicViewCheck: HTMLInputElement | null = null;
  let publicControlCheck: HTMLInputElement | null = null;
  const viewerChecks = new Map<string, HTMLInputElement>();
  const controllerChecks = new Map<string, HTMLInputElement>();
  let gmNotesInput: HTMLTextAreaElement | null = null;
  if (isGM) {
    const share = document.createElement("div");
    share.className = "creator-share";
    const title = document.createElement("h3");
    title.className = "creator-subtitle";
    title.textContent = "Compartilhamento (GM)";
    share.appendChild(title);
    publicViewCheck = document.createElement("input");
    publicViewCheck.type = "checkbox";
    publicViewCheck.className = "creator-public-view";
    const pvLabel = document.createElement("label");
    pvLabel.append(publicViewCheck, document.createTextNode(" Visível p/ todos (publicView)"));
    publicControlCheck = document.createElement("input");
    publicControlCheck.type = "checkbox";
    publicControlCheck.className = "creator-public-control";
    const pcLabel = document.createElement("label");
    pcLabel.append(publicControlCheck, document.createTextNode(" Controlável p/ todos (publicControl)"));
    share.append(pvLabel, pcLabel);
    const peers = options.peers ?? [];
    if (peers.length > 0) {
      const list = document.createElement("div");
      list.className = "creator-share-list";
      for (const peer of peers) {
        if (peer.peerId === authorPeerId) continue;
        const row = document.createElement("div");
        row.className = "creator-share-row";
        const name = document.createElement("span");
        name.textContent = `${peer.displayName} (${peer.peerId})`;
        const vCheck = document.createElement("input");
        vCheck.type = "checkbox";
        vCheck.className = "creator-viewer-check";
        vCheck.dataset.peer = peer.peerId;
        const vLabel = document.createElement("label");
        vLabel.append(vCheck, document.createTextNode(" ver"));
        const cCheck = document.createElement("input");
        cCheck.type = "checkbox";
        cCheck.className = "creator-controller-check";
        cCheck.dataset.peer = peer.peerId;
        const cLabel = document.createElement("label");
        cLabel.append(cCheck, document.createTextNode(" controlar"));
        viewerChecks.set(peer.peerId, vCheck);
        controllerChecks.set(peer.peerId, cCheck);
        row.append(name, vLabel, cLabel);
        list.appendChild(row);
      }
      share.appendChild(list);
    }
    gmNotesInput = document.createElement("textarea");
    gmNotesInput.className = "creator-gm-notes";
    gmNotesInput.rows = 3;
    gmNotesInput.placeholder = "Notas do GM (nunca sincronizam p/ jogadores)...";
    share.appendChild(field("Notas do GM", gmNotesInput));
    card.appendChild(share);
  }

  // ── Tabs ──
  const tabs = document.createElement("div");
  tabs.className = "creator-tabs";
  const panels = document.createElement("div");
  panels.className = "creator-panels";
  const tabDefs = [
    { id: "atributos", label: "Atributos" },
    { id: "pericias", label: "Perícias" },
    { id: "magias", label: "Magias/Equip" },
    { id: "bio", label: "Bio/Notas" },
  ] as const;
  const panelEls = new Map<string, HTMLElement>();
  for (const def of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "creator-tab" + (def.id === "atributos" ? " active" : "");
    btn.textContent = def.label;
    btn.addEventListener("click", () => {
      for (const [id, panel] of panelEls) {
        panel.style.display = id === def.id ? "" : "none";
      }
      for (const other of tabs.querySelectorAll(".creator-tab")) {
        other.classList.toggle("active", other === btn);
      }
    });
    tabs.appendChild(btn);
    const panel = document.createElement("div");
    panel.className = "creator-tab-panel";
    panel.dataset.tabPanel = def.id;
    panel.style.display = def.id === "atributos" ? "" : "none";
    panelEls.set(def.id, panel);
    panels.appendChild(panel);
  }
  card.append(tabs, panels);

  // ── Tab: Atributos ──
  const abilityInputs = new Map<keyof AbilityScores, HTMLInputElement>();
  const abilityMods = new Map<keyof AbilityScores, HTMLElement>();
  const attrGrid = document.createElement("div");
  attrGrid.className = "creator-abilities";
  for (const key of ABILITY_ORDER) {
    const wrap = document.createElement("div");
    wrap.className = "creator-ability";
    const name = document.createElement("span");
    name.className = "creator-ability-name";
    name.textContent = ABILITY_LABELS[key];
    const input = numInput("creator-ability-score", DEFAULT_ABILITIES[key]);
    const mod = document.createElement("span");
    mod.className = "creator-ability-mod";
    mod.textContent = modText(abilityMod(DEFAULT_ABILITIES[key]));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      mod.textContent = modText(abilityMod(v));
      refreshSkillMods();
    });
    abilityInputs.set(key, input);
    abilityMods.set(key, mod);
    wrap.append(name, input, mod);
    attrGrid.appendChild(wrap);
  }
  panelEls.get("atributos")!.appendChild(attrGrid);

  function liveScore(key: keyof AbilityScores): number {
    const v = Number(abilityInputs.get(key)?.value);
    return Number.isFinite(v) ? v : DEFAULT_ABILITIES[key];
  }

  function liveProfBonus(): number {
    return profBonusForLevel(clampLevel(Number(levelInput.value)));
  }

  // ── Tab: Perícias ──
  const skillChecks: Array<{
    ability: keyof AbilityScores;
    check: HTMLInputElement;
    mod: HTMLElement;
  }> = [];
  const skillList = document.createElement("div");
  skillList.className = "creator-skills";
  for (const def of DEFAULT_SKILLS) {
    const row = document.createElement("label");
    row.className = "creator-skill";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "creator-skill-check";
    check.dataset.skill = def.name;
    const mod = document.createElement("span");
    mod.className = "creator-skill-mod";
    row.append(
      check,
      Object.assign(document.createElement("span"), {
        className: "creator-skill-name",
      }),
      mod,
    );
    (row.querySelector(".creator-skill-name") as HTMLElement).textContent =
      `${def.name} (${ABILITY_LABELS[def.ability]})`;
    check.addEventListener("change", () => {
      mod.textContent = modText(
        abilityMod(liveScore(def.ability)) +
          (check.checked ? liveProfBonus() : 0),
      );
    });
    skillChecks.push({ ability: def.ability, check, mod });
    skillList.appendChild(row);
  }

  function refreshSkillMods(): void {
    for (let i = 0; i < skillChecks.length; i++) {
      const entry = skillChecks[i];
      const def = DEFAULT_SKILLS[i];
      entry.mod.textContent = modText(
        abilityMod(liveScore(def.ability)) +
          (entry.check.checked ? liveProfBonus() : 0),
      );
    }
  }
  refreshSkillMods();
  panelEls.get("pericias")!.appendChild(skillList);

  // ── Tab: Magias/Equip ──
  const magicPanel = panelEls.get("magias")!;
  const spellRows = document.createElement("div");
  spellRows.className = "creator-list";
  const draftSpells: Spell[] = [];
  const addSpell = document.createElement("button");
  addSpell.type = "button";
  addSpell.className = "menu-btn creator-add";
  addSpell.textContent = "+ Adicionar magia";
  addSpell.addEventListener("click", () => {
    const spell: Spell = { id: uid("spell"), name: "", level: 1 };
    draftSpells.push(spell);
    const row = document.createElement("div");
    row.className = "creator-row";
    const nameIn = textInput("creator-spell-name", "Nome da magia");
    nameIn.addEventListener("input", () => {
      spell.name = nameIn.value;
    });
    const levelSel = document.createElement("select");
    levelSel.className = "creator-spell-level";
    for (let lv = 0; lv <= 9; lv++) {
      const opt = document.createElement("option");
      opt.value = String(lv);
      opt.textContent = lv === 0 ? "Truque" : `Nível ${lv}`;
      if (lv === 1) opt.selected = true;
      levelSel.appendChild(opt);
    }
    levelSel.addEventListener("change", () => {
      spell.level = Number(levelSel.value);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sheet-row-del";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      draftSpells.splice(draftSpells.indexOf(spell), 1);
      row.remove();
    });
    row.append(nameIn, levelSel, del);
    spellRows.appendChild(row);
  });
  const equipRows = document.createElement("div");
  equipRows.className = "creator-list";
  const draftItems: InventoryItem[] = [];
  const addItem = document.createElement("button");
  addItem.type = "button";
  addItem.className = "menu-btn creator-add";
  addItem.textContent = "+ Adicionar equipamento";
  addItem.addEventListener("click", () => {
    const item: InventoryItem = { id: uid("item"), name: "", qty: 1 };
    draftItems.push(item);
    const row = document.createElement("div");
    row.className = "creator-row";
    const nameIn = textInput("creator-item-name", "Equipamento");
    nameIn.addEventListener("input", () => {
      item.name = nameIn.value;
    });
    const qtyIn = numInput("creator-item-qty", 1, 0);
    qtyIn.addEventListener("input", () => {
      const v = Number(qtyIn.value);
      if (Number.isFinite(v)) item.qty = v;
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sheet-row-del";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      draftItems.splice(draftItems.indexOf(item), 1);
      row.remove();
    });
    row.append(nameIn, qtyIn, del);
    equipRows.appendChild(row);
  });
  const moneyGrid = document.createElement("div");
  moneyGrid.className = "creator-money";
  const moneyInputs = new Map<keyof Money, HTMLInputElement>();
  for (const coin of ["cp", "sp", "ep", "gp", "pp"] as const) {
    const input = numInput(`creator-money-${coin}`, 0, 0);
    moneyInputs.set(coin, input);
    moneyGrid.appendChild(field(coin.toUpperCase(), input));
  }
  magicPanel.append(
    subTitle("Magias"),
    spellRows,
    addSpell,
    subTitle("Equipamento"),
    equipRows,
    addItem,
    subTitle("Dinheiro"),
    moneyGrid,
  );

  // ── Tab: Bio/Notas ──
  const bioPanel = panelEls.get("bio")!;
  const langInput = textInput("creator-languages", "Comum, Élfico...");
  const traitInputs = new Map<keyof SheetTraits, HTMLInputElement>();
  const traitDefs: Array<[keyof SheetTraits, string]> = [
    ["personality", "Personalidade"],
    ["ideals", "Ideais"],
    ["bonds", "Ligações"],
    ["flaws", "Defeitos"],
  ];
  const backstoryInput = document.createElement("textarea");
  backstoryInput.className = "creator-backstory";
  backstoryInput.rows = 4;
  backstoryInput.placeholder = "História do personagem...";
  const notesInput = document.createElement("textarea");
  notesInput.className = "creator-notes";
  notesInput.rows = 4;
  notesInput.placeholder = "Anotações livres...";
  bioPanel.append(field("Idiomas", langInput));
  for (const [key, label] of traitDefs) {
    const input = textInput(`creator-trait-${key}`, label);
    traitInputs.set(key, input);
    bioPanel.appendChild(field(label, input));
  }
  bioPanel.append(
    field("História", backstoryInput),
    field("Anotações", notesInput),
  );

  // ── Footer ──
  const footer = document.createElement("div");
  footer.className = "creator-footer";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "menu-btn creator-save";
  saveBtn.textContent = "Salvar ficha";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "menu-btn creator-cancel";
  cancelBtn.textContent = "Cancelar";
  cancelBtn.addEventListener("click", () => options.onCancel());
  saveBtn.addEventListener("click", () => {
    const level = clampLevel(Number(levelInput.value));
    const maxHp = Math.max(1, Math.floor(Number(hpInput.value) || 10));
    const ac = Math.floor(Number(acInput.value) || 10);
    const abilities = { ...DEFAULT_ABILITIES };
    for (const key of ABILITY_ORDER) abilities[key] = liveScore(key);
    const skills: Skill[] = DEFAULT_SKILLS.map((def) => ({
      id: def.name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, ""),
      name: def.name,
      ability: def.ability,
      proficient:
        skillChecks[DEFAULT_SKILLS.indexOf(def)]?.check.checked ?? false,
    }));
    const money: Money = {
      cp: Math.max(0, Math.floor(Number(moneyInputs.get("cp")?.value) || 0)),
      sp: Math.max(0, Math.floor(Number(moneyInputs.get("sp")?.value) || 0)),
      ep: Math.max(0, Math.floor(Number(moneyInputs.get("ep")?.value) || 0)),
      gp: Math.max(0, Math.floor(Number(moneyInputs.get("gp")?.value) || 0)),
      pp: Math.max(0, Math.floor(Number(moneyInputs.get("pp")?.value) || 0)),
    };
    const sheet: Sheet = {
      id: uid("sheet"),
      name: nameInput.value.trim() || "Sem nome",
      level,
      charClass: classInput.value.trim(),
      profBonus: profBonusForLevel(level),
      race: raceInput.value.trim(),
      alignment: alignInput.value.trim(),
      xp: Math.max(0, Math.floor(Number(xpInput.value) || 0)),
      ac,
      hp: maxHp,
      maxHp,
      abilities,
      skills,
      spells: draftSpells.map((s) => ({ ...s })),
      inventory: draftItems.map((i) => ({ ...i })),
      money,
      traits: {
        personality: traitInputs.get("personality")?.value ?? "",
        ideals: traitInputs.get("ideals")?.value ?? "",
        bonds: traitInputs.get("bonds")?.value ?? "",
        flaws: traitInputs.get("flaws")?.value ?? "",
      },
      languages: langInput.value.trim(),
      backstory: backstoryInput.value,
      notes: notesInput.value,
    };
    // ACL: player cria a própria (auto controllers=[creator], sem
    // re-compartilhar); GM escreve ACL livremente via UI acima.
    if (isGM) {
      const viewers: string[] = [];
      const controllers: string[] = [authorPeerId];
      for (const [peerId, check] of viewerChecks) {
        if (check.checked) viewers.push(peerId);
      }
      for (const [peerId, check] of controllerChecks) {
        if (check.checked) controllers.push(peerId);
      }
      sheet.viewers = viewers;
      sheet.controllers = controllers;
      sheet.publicView = publicViewCheck?.checked ?? false;
      sheet.publicControl = publicControlCheck?.checked ?? false;
      const gmNotes = gmNotesInput?.value.trim() ?? "";
      if (gmNotes.length > 0) sheet.gmNotes = gmNotes;
    } else {
      sheet.controllers = [authorPeerId];
      sheet.viewers = [];
      sheet.publicView = false;
      sheet.publicControl = false;
    }
    // Migração: ownerId espelha o autor (legado lê ownerId).
    sheet.ownerId = authorPeerId;
    options.onSave(sheet);
  });
  footer.append(cancelBtn, saveBtn);
  card.appendChild(footer);

  return { el: overlay };
}

function header(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "creator-title";
  h.textContent = text;
  return h;
}

function subTitle(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "creator-subtitle";
  h.textContent = text;
  return h;
}
