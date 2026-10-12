// Table shell (the view behind the menu): canvas map with fog and
// light, the token bar, the character sheet panel and the dice roller.
// Extracted from src/app.ts so `startApp` only orchestrates the menu,
// the room and the host backend.

import "../styles/sheet.css";
import { createFog, revealFog } from "../map/fog";
import { inBounds, type Grid } from "../map/grid";
import { computeLight } from "../map/light";
import { encodeToken } from "../map/tokens";
import type { Delta } from "../net/peer";
import { publishRoll, resolveRoll } from "../dice/roller";
import { frameForResult } from "../dice/scene";
import { decodeSheet, encodeSheet } from "../sheet/srd";
import type { Sheet } from "../sheet/types";
import { tokenKey, type OfflineRoom } from "./room";
import { eventToCell, renderMapView } from "./mapview";
import { renderSheetPanel } from "./sheet-panel";
import { createDicePanel } from "./dice-panel";
import { createThreeDiceView, type ThreeDiceView } from "../dice/three-scene";
import { createTokenBar, MEMBERS } from "./token-bar";

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
}

export interface AppShellDeps {
  /** Root element the shell renders into. */
  root: HTMLElement;
  /** Local room holding the token/member state. */
  room: OfflineRoom;
  /** Map grid geometry (fog/light/token placement). */
  grid: Grid;
  /** Sheet per member id, mutated in place by the sheet panel. */
  sheets: Map<string, Sheet>;
  /** Host/guest flags plus the roll sequence counter. */
  session: Session;
}

export interface AppShell {
  /** Build (once) and show the table over the menu. */
  show(): void;
  /** Release the 3D dice view and detach the table. */
  dispose(): void;
}

/** Create the table shell; `show()` mounts it into the root. */
export function createAppShell(deps: AppShellDeps): AppShell {
  const { root, room, grid, sheets, session } = deps;
  let selected = MEMBERS[0];
  let mounted: HTMLElement | null = null;

  const canvas = document.createElement("canvas");
  const side = document.createElement("div");
  side.style.width = "360px";
  side.style.flexShrink = "0";
  side.style.overflowY = "auto";
  side.style.maxHeight = "100%";

  const sheetPanel = document.createElement("div");

  const tokenBar = createTokenBar({
    onSelect: (id) => {
      selected = id;
      showSheet();
    },
  });

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
      dice.setResult(
        frame.faces.map((f) => f.label).join(" ") + ` = ${result.total}`,
      );
      diceView?.show(frame);
    },
  });

  /** Apply locally and mirror into the hosted room (host only). */
  function publish(delta: Delta): void {
    room.apply(delta);
    if (session.backend && !session.guest) session.backend.pushDelta(delta);
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
    const sheet = sheets.get(selected);
    if (!sheet) return;
    renderSheetPanel(sheetPanel, sheet, {
      onChange: (updated) => {
        sheets.set(selected, updated);
        // Mirror edits into the hosted room (host-only): the sheet
        // travels as one RoomState value under the member key.
        if (session.backend && !session.guest) {
          session.backend.pushDelta({ upsert: { [selected]: encodeSheet(updated) } });
        }
        tokenBar.setSelected(selected, updated);
      },
      onRoll: (label, result) => {
        const delta = publishRoll(result, `roll-${++session.rollSeq}`);
        publish(delta);
        dice.setResult(`${label}: ${result.rolls.join(" ")} = ${result.total}`);
        diceView?.show(frameForResult(result));
      },
    });
    tokenBar.setSelected(selected, sheet);
  }

  canvas.addEventListener("click", (ev) => {
    const cell = eventToCell(canvas, ev.clientX, ev.clientY);
    if (!cell || !inBounds(grid, cell.x, cell.y)) return;
    if (!room.moveToken(selected, { x: cell.x, y: cell.y })) return;
    const moved = room.tokens().find((t) => t.id === selected);
    if (moved && session.backend && !session.guest) {
      session.backend.pushDelta({ upsert: { [tokenKey(selected)]: encodeToken(moved) } });
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
  };
}

/** Fresh sheets for every member (used by `startApp`). */
export function createMemberSheets(): Map<string, Sheet> {
  return new Map(
    MEMBERS.map((id, i) => [
      id,
      decodeSheet(encodeSheet({ id, name: id, ac: 10 + (i % 3), hp: 10, maxHp: 10 })),
    ]),
  );
}
