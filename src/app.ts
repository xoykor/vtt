// Playable shell: local room + canvas map + sheet panel + dice roller.
// Consumes the ready modules:
// - net/peer (RoomState via OfflineRoom.apply)
// - map/grid + map/fog + map/light (geometry for the view)
// - map/tokens (via OfflineRoom)
// - sheet/srd + sheet/types (sheet panel encode/decode)
// - dice/roller + dice/scene (host-resolved rolls, rendered result)
// Task 4 bootstraps this into the webview via startApp(root): inside a
// Tauri window (`window.__TAURI__` present) host/join/sync go through the
// real invoke bridge (`create_room`, `join_room`, `push_delta`,
// `get_snapshot` in src-tauri/src/commands.rs); in a plain browser the
// same shell runs fully offline with no invoke calls.

import { createGrid, inBounds } from "./map/grid";
import { createFog, revealFog } from "./map/fog";
import { computeLight } from "./map/light";
import { decodeSheet, encodeSheet } from "./sheet/srd";
import type { Sheet } from "./sheet/types";
import { publishRoll, resolveRoll } from "./dice/roller";
import { frameForResult } from "./dice/scene";
import { encodeToken } from "./map/tokens";
import { createMap, placeTile } from "./map/editor";
import type { Delta } from "./net/peer";
import {
  createOfflineRoom,
  guestJoinNotice,
  joinVia,
  replaceDelta,
  tokenKey,
  type InvokeFn,
  type OfflineRoom,
} from "./ui/room";
import { eventToCell, renderMapView } from "./ui/mapview";
import { renderEditorPanel } from "./ui/editor-panel";

const MEMBERS = ["dm", "p1", "p2", "p3", "p4", "p5"];
const SIDES = [2, 4, 6, 8, 10, 12, 20, 100];

/** True inside the Tauri webview (invoke bridge available). */
function isTauri(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Raw Tauri invoke without the `@tauri-apps/api` npm dep: reads the
 * `window.__TAURI__` bridge installed by the webview (Tauri 2 exposes
 * `core.invoke`; older shims expose a top-level `invoke`).
 */
function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const scope = (window as unknown as {
    __TAURI__?: { core?: { invoke?: InvokeFn }; invoke?: InvokeFn };
  }).__TAURI__;
  const fn = scope?.core?.invoke ?? scope?.invoke;
  if (!fn) return Promise.reject(new Error("tauri invoke unavailable (browser offline)"));
  return fn(cmd, args);
}

const invokeViaBridge: InvokeFn = (cmd, args) => tauriInvoke(cmd, args);

/** Host-side backend: pushes local deltas, pulls the host snapshot. */
interface Backend {
  pushDelta(delta: Delta): void;
  pullSnapshot(): Promise<void>;
}

/** Bootstrap the shell into `root` (Task 4 webview entry). */
export function startApp(root: HTMLElement): void {
  const room = createOfflineRoom(MEMBERS);
  const grid = createGrid(10, 8);
  const gameMap = createMap(grid.width, grid.height);
  let selected = MEMBERS[0];
  let rollSeq = 0;

  const sheets = new Map<string, Sheet>(
    MEMBERS.map((id, i) => [
      id,
      decodeSheet(
        encodeSheet({ id, name: id, ac: 10 + (i % 3), hp: 10, maxHp: 10 }),
      ),
    ]),
  );

  root.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = isTauri() ? "VTT — Sala" : "VTT — Sala offline";
  root.append(title);

  // Task 4 lobby: real host + real join via the Tauri window. The browser
  // path skips this entirely (stays offline, no invoke calls).
  //
  // `backend` exists ONLY after a successful `create_room` (fix
  // round 1): `join_room` stores no host state, so a guest holds no
  // backend — Push/Sync stay disabled on the guest path with a
  // clear status message instead of erroring `no room hosted yet`
  // on every move.
  let backend: Backend | null = null;
  let guest = false;
  if (isTauri()) {
    const status = document.createElement("div");
    status.textContent = "Tauri: invoke pronto.";
    const setStatus = (msg: string): void => {
      status.textContent = msg;
    };
    const lobby = document.createElement("div");
    lobby.style.display = "flex";
    lobby.style.gap = "8px";
    lobby.style.marginBottom = "12px";

    const portInput = document.createElement("input");
    portInput.value = "7000";
    portInput.style.width = "6em";
    const hostBtn = document.createElement("button");
    hostBtn.textContent = "Hospedar sala";
    hostBtn.addEventListener("click", () => {
      tauriInvoke("create_room", { port: Number(portInput.value) })
        .then((reply) => {
          guest = false;
          if (!backend) backend = makeBackend(room, setStatus, draw);
          setStatus(`Sala hospedada: ${String(reply)}`);
        })
        .catch((e: Error) => {
          setStatus(`Hospedar falhou: ${e.message}`);
        });
    });

    const addrInput = document.createElement("input");
    addrInput.value = "127.0.0.1:7000";
    addrInput.style.width = "12em";
    const joinBtn = document.createElement("button");
    joinBtn.textContent = "Entrar em sala";
    joinBtn.addEventListener("click", () => {
      joinVia(addrInput.value, invokeViaBridge)
        .then((info) => {
          guest = true;
          setStatus(guestJoinNotice(info));
        })
        .catch((e: Error) => {
          setStatus(`Entrar falhou: ${e.message}`);
        });
    });

    const syncBtn = document.createElement("button");
    syncBtn.textContent = "Sincronizar";
    syncBtn.addEventListener("click", () => {
      if (backend && !guest) {
        backend.pullSnapshot().catch((e: Error) => {
          setStatus(`Sincronizar falhou: ${e.message}`);
        });
      } else if (guest) {
        setStatus(
          "Sincronizar desabilitado para convidados (só o host sincroniza).",
        );
      } else {
        setStatus("Nada para sincronizar (hospede primeiro).");
      }
    });

    lobby.append(portInput, hostBtn, addrInput, joinBtn, syncBtn);
    root.append(lobby, status);
  }

  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "16px";

  const canvas = document.createElement("canvas");
  const side = document.createElement("div");

  const sheetTitle = document.createElement("h2");
  sheetTitle.textContent = "Ficha";
  const sheetBox = document.createElement("div");
  const tokenList = document.createElement("div");
  const diceTitle = document.createElement("h2");
  diceTitle.textContent = "Dado";
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
  const rollOut = document.createElement("div");
  rollOut.textContent = "—";

  function draw(): void {
    const fog = revealFog(createFog(grid.width, grid.height), [
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 7 },
      { x: 0, y: 7 },
    ]);
    const lit = computeLight(
      { width: grid.width, height: grid.height, walls: new Array(grid.width * grid.height).fill(false) },
      [{ pos: { x: 0.5, y: 0.5 }, radius: 12 }],
    );
    renderMapView(canvas, {
      grid,
      tokens: room.tokens(),
      fog: fog.visible,
      lit,
    });
  }

  // `draw` is hoisted by function declaration, so the backend above closes
  // over it safely.
  function showSheet(): void {
    const sheet = sheets.get(selected);
    sheetBox.textContent = sheet
      ? `${sheet.name} — CA ${sheet.ac} — HP ${sheet.hp}/${sheet.maxHp}`
      : "—";
  }

  for (const id of MEMBERS) {
    const btn = document.createElement("button");
    btn.textContent = id;
    btn.addEventListener("click", () => {
      selected = id;
      showSheet();
    });
    tokenList.appendChild(btn);
  }

  canvas.addEventListener("click", (ev) => {
    const cell = eventToCell(canvas, ev.clientX, ev.clientY);
    if (!cell || !inBounds(grid, cell.x, cell.y)) return;
    if (!room.moveToken(selected, { x: cell.x, y: cell.y })) return;
    const moved = room.tokens().find((t) => t.id === selected);
    if (moved && backend && !guest) {
      backend.pushDelta({ upsert: { [tokenKey(selected)]: encodeToken(moved) } });
    }
    draw();
  });

  rollBtn.addEventListener("click", () => {
    const result = resolveRoll({ sides: Number(sidesSel.value) });
    const delta = publishRoll(result, `offline-${++rollSeq}`);
    room.apply(delta);
    if (backend && !guest) backend.pushDelta(delta);
    rollOut.textContent = frameForResult(result).faces
      .map((f) => f.label)
      .join(" ") + ` = ${result.total}`;
  });

  // Task 1: host-only map editor panel. The panel runs the real
  // placeTile(map, tile, "host") and hands the placed tile back here;
  // the delta travels the same ordered path as tokens/rolls —
  // room.apply locally, push_delta to the hosted room when host.
  const editorTitle = document.createElement("h2");
  editorTitle.textContent = "Mapa (host)";
  const editorBox = document.createElement("div");
  renderEditorPanel(editorBox, gameMap, (tile) => {
    const res = placeTile(gameMap, tile, "host");
    if (!res.ok) return;
    room.apply(res.delta);
    if (backend && !guest) backend.pushDelta(res.delta);
  });

  showSheet();
  draw();
  side.append(
    sheetTitle,
    tokenList,
    sheetBox,
    diceTitle,
    sidesSel,
    rollBtn,
    rollOut,
    editorTitle,
    editorBox,
  );
  wrap.append(canvas, side);
  root.append(wrap);
}

/**
 * Mirror local deltas into the hosted room (best-effort) and pull
 * the host snapshot as a wholesale replace. Deltas cross the
 * bridge as JSON with BOTH fields present (`JSON.stringify` drops
 * `undefined`, while the Rust `decode_delta` requires `upsert` +
 * `remove`).
 */
function makeBackend(
  room: OfflineRoom,
  setStatus: (msg: string) => void,
  redraw: () => void,
): Backend {
  return {
    pushDelta(delta: Delta): void {
      const wire = JSON.stringify({
        upsert: delta.upsert ?? {},
        remove: delta.remove ?? [],
      });
      tauriInvoke("push_delta", { delta: wire })
        .then(() => undefined)
        .catch((e: Error) => {
          setStatus(`push_delta falhou: ${e.message}`);
        });
    },
    async pullSnapshot(): Promise<void> {
      const raw = await tauriInvoke("get_snapshot");
      if (typeof raw !== "string") throw new Error("snapshot ilegível");
      const doc = JSON.parse(raw) as {
        state?: Record<string, string>;
        room?: string;
      };
      if (!doc || typeof doc.state !== "object" || doc.state === null) {
        throw new Error("snapshot ilegível");
      }
      // Wholesale replace (fix round 1): upsert every snapshot entry
      // and REMOVE local keys the host deleted — applying the
      // snapshot upsert-only would leave stale tokens/keys
      // accumulating locally forever.
      const delta = replaceDelta(room.getState(), doc.state);
      room.apply(delta);
      redraw();
      setStatus(
        `Sincronizado: sala ${doc.room ?? "?"} ` +
          `(${Object.keys(doc.state).length} chaves, ` +
          `${delta.remove?.length ?? 0} removidas).`,
      );
    },
  };
}
