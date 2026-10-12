// Table shell (the view behind the menu): canvas map with fog and
// light, the sheet bar (sem slots fixos), the character sheet panel
// and the dice roller. Sessão sem seletor de jogador: a barra lista
// fichas visíveis (GM=todas, player=próprias+compartilhadas) e
// `session.character` (`sheetId|null`) é a ficha padrão p/ falar/rolar.
// Tokens com `represents` herdam controle da ficha.

import "../styles/sheet.css";
import { createFog, revealFog } from "../map/fog";
import { inBounds, type Grid } from "../map/grid";
import { computeLight } from "../map/light";
import { encodeToken } from "../map/tokens";
import type { Delta } from "../net/peer";
import { publishRoll, resolveRoll } from "../dice/roller";
import { frameForResult } from "../dice/scene";
import { canControl, canControlToken, canView, filterSheetForPeer, sanitizeSheetWrite } from "../sheet/acl";
import { encodeSheet } from "../sheet/srd";
import type { Sheet } from "../sheet/types";
import { sheetKey } from "../sheet/visibility";
import { tokenKey, type OfflineRoom } from "./room";
import { eventToCell, renderMapView } from "./mapview";
import { renderSheetPanel } from "./sheet-panel";
import { createDicePanel } from "./dice-panel";
import { createThreeDiceView, type ThreeDiceView } from "../dice/three-scene";
import { createTokenBar } from "./token-bar";
import type { SessionPeer } from "../session/peers";

/** Host-side backend: pushes local deltas, pulls the host snapshot. */
export interface Backend {
  pushDelta(delta: Delta): void;
  pullSnapshot(): Promise<void>;
}

/** Mutable session state shared with the menu callbacks. */
export interface Session {
  backend: Backend | null;
  guest: boolean;
  rollSeq: number;
  /** Legado: id do slot (`dm`,`p1`..); migração → `peerId`. */
  userId: string;
  /** Peer atual (hash + nome auto-declarado). */
  peerId: string;
  /** Nome auto-declarado do peer atual. */
  displayName: string;
  /** True quando hospeda (GM inicial). */
  isGM: boolean;
  /** Ficha padrão p/ falar/rolar (`sheetId|null`). */
  character: string | null;
  /** Peers da sessão (sem slots, sem limite). */
  peers: SessionPeer[];
}

export interface AppShellDeps {
  /** Root element the shell renders into. */
  root: HTMLElement;
  /** Local room holding the token/sheet/peer state. */
  room: OfflineRoom;
  /** Map grid geometry (fog/light/token placement). */
  grid: Grid;
  /** Sheet per sheetId, mutated in place by the sheet panel. */
  sheets: Map<string, Sheet>;
  /** Host/guest flags plus the roll sequence counter. */
  session: Session;
}

export interface AppShell {
  /** Build (once) and show the table over the menu. */
  show(): void;
  /** Release the 3D dice view and detach the table. */
  dispose(): void;
  /** Rebuild the sheet bar from the current visible sheets. */
  refreshSheets(): void;
}

function peerIdOf(session: Session): string {
  return session.peerId !== "" ? session.peerId : session.userId;
}

function isGMOf(session: Session): boolean {
  return session.isGM ?? !session.guest;
}

/** Fichas visíveis p/ a sessão (GM=todas; player=próprias+compartilhadas, projetadas: viewer=metadados). */
export function visibleSheetsForSession(
  sheets: Map<string, Sheet>,
  session: Session,
): Sheet[] {
  const peerId = peerIdOf(session);
  const isGM = isGMOf(session);
  const out: Sheet[] = [];
  for (const sheet of sheets.values()) {
    const projected = filterSheetForPeer(sheet, peerId, isGM);
    if (projected) out.push(projected);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create the table shell; `show()` mounts it into the root. */
export function createAppShell(deps: AppShellDeps): AppShell {
  const { root, room, grid, sheets, session } = deps;
  let selected = session.character ?? "";
  let mounted: HTMLElement | null = null;

  const canvas = document.createElement("canvas");
  const side = document.createElement("div");
  side.style.width = "360px";
  side.style.flexShrink = "0";
  side.style.overflowY = "auto";
  side.style.maxHeight = "100%";

  const sheetPanel = document.createElement("div");

  const tokenBar = createTokenBar({
    items: [],
    onSelect: (id) => {
      selected = id;
      session.character = id;
      // Legado: mantém userId apontando p/ seleção (migração).
      showSheet();
    },
  });

  function refreshBar(): void {
    const visible = visibleSheetsForSession(sheets, session);
    tokenBar.setItems(visible.map((s) => ({ id: s.id, label: s.name })));
    // Seleção inicial: character válido, senão primeira visível.
    if (!visible.some((s) => s.id === selected)) {
      selected = session.character && visible.some((s) => s.id === session.character)
        ? session.character
        : (visible[0]?.id ?? "");
      if (selected !== "") session.character = selected;
    }
  }

  // 3D dice mounted next to the numeric result: mirrors every resolved
  // roll (face comes from the host via `resolveRoll`, never rolled here).
  // Without a usable WebGL context the view stays numeric, so the text
  // result above remains the source of truth.
  const diceViewHost = document.createElement("div");
  diceViewHost.className = "dice-3d-host";
  let diceView: ThreeDiceView | null = createThreeDiceView(diceViewHost);

  const dice = createDicePanel({
    onRoll: (sides) => {
      const result = resolveRoll({ sides });
      const delta = publishRoll(result, `offline-${++session.rollSeq}`);
      publish(delta);
      const frame = frameForResult(result);
      const who = session.character
        ? (sheets.get(session.character)?.name ?? session.character)
        : session.displayName;
      dice.setResult(
        `${who}: ` + frame.faces.map((f) => f.label).join(" ") + ` = ${result.total}`,
      );
      diceView?.show(frame);
    },
  });

  /** Apply locally and mirror into the hosted room (host only). */
  function publish(delta: Delta): void {
    room.apply(delta);
    if (session.backend && isGMOf(session)) session.backend.pushDelta(delta);
  }

  function draw(): void {
    const fog = revealFog(createFog(grid.width, grid.height), [
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 7 },
      { x: 0, y: 7 },
    ]);
    const lit = computeLight(
      {
        width: grid.width,
        height: grid.height,
        walls: new Array(grid.width * grid.height).fill(false),
      },
      [{ pos: { x: 0.5, y: 0.5 }, radius: 12 }],
    );
    renderMapView(canvas, {
      grid,
      tokens: room.tokens(),
      fog: fog.visible,
      lit,
    });
  }

  function showSheet(): void {
    refreshBar();
    const sheet = selected !== "" ? sheets.get(selected) : undefined;
    if (!sheet) {
      sheetPanel.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "sheet-empty";
      empty.textContent =
        sheets.size === 0
          ? "Nenhuma ficha — crie uma pelo menu."
          : "Selecione uma ficha visível acima.";
      sheetPanel.appendChild(empty);
      tokenBar.setSelected(selected, undefined);
      return;
    }
    // Fail-closed: sem visão, não renderiza. Renderiza a projeção
    // filtrada (viewer=metadados, sem gmNotes p/ não-GM), nunca a ficha
    // completa de quem só pode ver.
    const peerId = peerIdOf(session);
    const isGM = isGMOf(session);
    const projected = filterSheetForPeer(sheet, peerId, isGM);
    if (!projected) {
      sheetPanel.innerHTML = "";
      tokenBar.setSelected(selected, undefined);
      return;
    }
    // Viewer (vê, não controla): painel somente-leitura da projeção —
    // edições locais não persistem (fail-closed, sem corromper stats).
    if (!canControl(sheet, peerId, isGM)) {
      renderSheetPanel(sheetPanel, projected, {
        onChange: (updated) => {
          tokenBar.setSelected(selected, updated);
        },
        onRoll: (label, result) => {
          const delta = publishRoll(result, `roll-${++session.rollSeq}`);
          publish(delta);
          const who = sheets.get(selected)?.name ?? label;
          dice.setResult(`${who} — ${label}: ${result.rolls.join(" ")} = ${result.total}`);
          diceView?.show(frameForResult(result));
        },
      });
      tokenBar.setSelected(selected, projected);
      return;
    }
    renderSheetPanel(sheetPanel, projected, {
      onChange: (updated) => {
        const prev = sheets.get(selected);
        const sanitized = sanitizeSheetWrite(prev ?? null, updated, {
          peerId,
          isGM,
        });
        sheets.set(selected, sanitized);
        const delta = { upsert: { [sheetKey(selected)]: encodeSheet(sanitized) } };
        room.apply(delta);
        // Mirror edits into the hosted room (host-only): the sheet
        // travels as one RoomState value under the `sheet:<id>` key.
        if (session.backend && isGM) {
          session.backend.pushDelta(delta);
        }
        refreshBar();
        tokenBar.setSelected(selected, sanitized);
      },
      onRoll: (label, result) => {
        const delta = publishRoll(result, `roll-${++session.rollSeq}`);
        publish(delta);
        const who = sheets.get(selected)?.name ?? label;
        dice.setResult(`${who} — ${label}: ${result.rolls.join(" ")} = ${result.total}`);
        diceView?.show(frameForResult(result));
      },
    });
    tokenBar.setSelected(selected, projected);
  }

  canvas.addEventListener("click", (ev) => {
    const cell = eventToCell(canvas, ev.clientX, ev.clientY);
    if (!cell || !inBounds(grid, cell.x, cell.y)) return;
    const peerId = peerIdOf(session);
    const isGM = isGMOf(session);
    // Token da ficha selecionada (herda controle); legado cai p/ id.
    const tokens = room.tokens();
    let target = tokens.find((t) => t.represents === selected);
    if (!target) target = tokens.find((t) => t.id === selected);
    if (!target) {
      // Sem token vinculado: GM move o primeiro; player não move nada.
      if (!isGM) return;
      target = tokens[0];
      if (!target) return;
    }
    if (!canControlToken(target, sheets, peerId, isGM)) return;
    if (!room.moveToken(target.id, { x: cell.x, y: cell.y })) return;
    const moved = room.tokens().find((t) => t.id === target!.id);
    if (moved && session.backend && isGM) {
      session.backend.pushDelta({ upsert: { [tokenKey(target.id)]: encodeToken(moved) } });
    }
    draw();
  });

  return {
    show(): void {
      if (!mounted) {
        const appContent = document.createElement("div");
        appContent.className = "app-content";

        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.gap = "16px";
        wrap.style.padding = "16px";
        wrap.style.height = "100%";

        if (!diceView) diceView = createThreeDiceView(diceViewHost);
        side.append(tokenBar.el, sheetPanel, dice.el, diceViewHost);
        wrap.append(canvas, side);
        appContent.appendChild(wrap);
        root.appendChild(appContent);
        mounted = appContent;

        showSheet();
        draw();
      } else if (!diceView) {
        diceView = createThreeDiceView(diceViewHost);
        if (!diceViewHost.isConnected) side.append(diceViewHost);
      }
      mounted.style.display = "";
    },
    dispose(): void {
      diceView?.dispose();
      diceView = null;
      mounted?.remove();
      mounted = null;
    },
    refreshSheets(): void {
      refreshBar();
      showSheet();
    },
  };
}

/** Fresh empty sheets (sem slots fixos; usado por `startApp`). */
export function createEmptySheets(): Map<string, Sheet> {
  return new Map<string, Sheet>();
}

/**
 * Legado: fichas por membro fixo (`dm`,`p1`..). Mantido p/ migração —
 * prefira `createEmptySheets` (sem slots). Retorna mapa vazio.
 * @deprecated
 */
export function createMemberSheets(): Map<string, Sheet> {
  return new Map<string, Sheet>();
}
