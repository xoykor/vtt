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

import "./styles/menu.css";
import { createGrid, inBounds } from "./map/grid";
import { createFog, revealFog } from "./map/fog";
import { computeLight } from "./map/light";
import { decodeSheet, encodeSheet } from "./sheet/srd";
import type { Sheet } from "./sheet/types";
import { publishRoll, resolveRoll } from "./dice/roller";
import { frameForResult } from "./dice/scene";
import { encodeToken } from "./map/tokens";
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

/** SVG silhouette of a medieval tavern for the background. */
function tavernSvg(): string {
  return `
    <svg class="tavern-silhouette" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="roofGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:#3d2517;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1a0f08;stop-opacity:1" />
        </linearGradient>
        <linearGradient id="wallGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:#2d1a0e;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#0d0805;stop-opacity:1" />
        </linearGradient>
      </defs>
      <!-- Main building -->
      <rect x="300" y="180" width="600" height="220" fill="url(#wallGrad)" />
      <!-- Roof -->
      <polygon points="250,180 600,80 950,180" fill="url(#roofGrad)" />
      <!-- Chimney -->
      <rect x="700" y="60" width="40" height="80" fill="#1a0f08" />
      <rect x="695" y="55" width="50" height="10" fill="#2d1a0e" />
      <!-- Windows with warm light -->
      <rect x="380" y="220" width="50" height="60" fill="#c8862a" opacity="0.7" rx="2" />
      <rect x="385" y="225" width="40" height="50" fill="#e8a83e" opacity="0.5" rx="1" />
      <rect x="520" y="220" width="50" height="60" fill="#c8862a" opacity="0.7" rx="2" />
      <rect x="525" y="225" width="40" height="50" fill="#e8a83e" opacity="0.5" rx="1" />
      <rect x="660" y="220" width="50" height="60" fill="#c8862a" opacity="0.7" rx="2" />
      <rect x="665" y="225" width="40" height="50" fill="#e8a83e" opacity="0.5" rx="1" />
      <!-- Door -->
      <rect x="560" y="280" width="80" height="120" fill="#1a0f08" rx="4" />
      <rect x="565" y="285" width="70" height="110" fill="#0d0805" rx="2" />
      <!-- Door handle -->
      <circle cx="620" cy="340" r="4" fill="#d4a017" />
      <!-- Left annex -->
      <rect x="150" y="240" width="180" height="160" fill="url(#wallGrad)" />
      <polygon points="130,240 240,180 350,240" fill="url(#roofGrad)" />
      <rect x="200" y="280" width="40" height="50" fill="#c8862a" opacity="0.5" rx="2" />
      <!-- Right annex -->
      <rect x="870" y="240" width="180" height="160" fill="url(#wallGrad)" />
      <polygon points="850,240 960,180 1070,240" fill="url(#roofGrad)" />
      <rect x="930" y="280" width="40" height="50" fill="#c8862a" opacity="0.5" rx="2" />
      <!-- Barrels -->
      <ellipse cx="120" cy="380" rx="30" ry="25" fill="#2d1a0e" />
      <rect x="95" y="360" width="50" height="40" fill="#3d2517" rx="5" />
      <ellipse cx="120" cy="360" rx="25" ry="8" fill="#1a0f08" />
      <ellipse cx="1080" cy="380" rx="30" ry="25" fill="#2d1a0e" />
      <rect x="1055" y="360" width="50" height="40" fill="#3d2517" rx="5" />
      <ellipse cx="1080" cy="360" rx="25" ry="8" fill="#1a0f08" />
      <!-- Lantern posts -->
      <rect x="420" y="300" width="6" height="100" fill="#1a0f08" />
      <rect x="410" y="290" width="26" height="20" fill="#2d1a0e" rx="3" />
      <rect x="415" y="295" width="16" height="10" fill="#e8a83e" opacity="0.6" rx="2" />
      <rect x="770" y="300" width="6" height="100" fill="#1a0f08" />
      <rect x="760" y="290" width="26" height="20" fill="#2d1a0e" rx="3" />
      <rect x="765" y="295" width="16" height="10" fill="#e8a83e" opacity="0.6" rx="2" />
    </svg>
  `;
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

/** Bootstrap the shell into `root` (Task 4 webview entry). */
export function startApp(root: HTMLElement): void {
  const room = createOfflineRoom(MEMBERS);
  const grid = createGrid(10, 8);
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

  // ─── Menu Inicial ───
  const bg = document.createElement("div");
  bg.className = "tavern-bg";
  bg.innerHTML = tavernSvg();
  root.appendChild(bg);

  const menuContainer = document.createElement("div");
  menuContainer.className = "menu-container";

  const title = document.createElement("h1");
  title.className = "menu-title";
  title.textContent = "VTT — Mesa de D&D 5e";

  const subtitle = document.createElement("p");
  subtitle.className = "menu-subtitle";
  subtitle.textContent = "Uma aventura offline espera por você";

  const ornament = document.createElement("div");
  ornament.className = "menu-ornament";

  const buttonsDiv = document.createElement("div");
  buttonsDiv.className = "menu-buttons";

  // Botão Hospedar
  const hostBtn = document.createElement("button");
  hostBtn.className = "menu-btn";
  hostBtn.innerHTML = '<span class="btn-icon">⚔️</span> Hospedar';
  hostBtn.addEventListener("click", () => {
    if (!isTauri()) {
      setStatus("Modo offline: hospedagem requer Tauri.", "error");
      return;
    }
    setStatus("Criando sala...");
    tauriInvoke("create_room", { port: 7000 })
      .then((reply) => {
        setStatus(`Sala hospedada: ${String(reply)}`, "success");
        showApp();
      })
      .catch((e: Error) => {
        setStatus(`Hospedar falhou: ${e.message}`, "error");
      });
  });

  // Botão Entrar
  const joinBtn = document.createElement("button");
  joinBtn.className = "menu-btn";
  joinBtn.innerHTML = '<span class="btn-icon">🚪</span> Entrar';
  joinBtn.addEventListener("click", () => {
    joinPanel.classList.toggle("visible");
    if (joinPanel.classList.contains("visible")) {
      addrInput.focus();
    }
  });

  // Botão Criar Ficha
  const sheetBtn = document.createElement("button");
  sheetBtn.className = "menu-btn";
  sheetBtn.innerHTML = '<span class="btn-icon">📜</span> Criar Ficha de Personagem';
  sheetBtn.addEventListener("click", () => {
    showApp();
  });

  buttonsDiv.append(hostBtn, joinBtn, sheetBtn);

  // Painel de entrada (IP:Porta)
  const joinPanel = document.createElement("div");
  joinPanel.className = "join-panel";

  const addrLabel = document.createElement("label");
  addrLabel.textContent = "Endereço da sala (IP:Porta):";

  const addrInput = document.createElement("input");
  addrInput.type = "text";
  addrInput.value = "127.0.0.1:7000";
  addrInput.placeholder = "192.168.1.100:7000";

  const panelButtons = document.createElement("div");
  panelButtons.className = "panel-buttons";

  const confirmJoinBtn = document.createElement("button");
  confirmJoinBtn.className = "menu-btn";
  confirmJoinBtn.textContent = "Confirmar";
  confirmJoinBtn.addEventListener("click", () => {
    if (!isTauri()) {
      setStatus("Modo offline: entrada requer Tauri.", "error");
      return;
    }
    setStatus(`Conectando a ${addrInput.value}...`);
    joinVia(addrInput.value, invokeViaBridge)
      .then((info) => {
        setStatus(guestJoinNotice(info), "success");
        guest = true;
        showApp();
      })
      .catch((e: Error) => {
        setStatus(`Entrar falhou: ${e.message}`, "error");
      });
  });

  const cancelJoinBtn = document.createElement("button");
  cancelJoinBtn.className = "menu-btn";
  cancelJoinBtn.textContent = "Cancelar";
  cancelJoinBtn.addEventListener("click", () => {
    joinPanel.classList.remove("visible");
  });

  panelButtons.append(confirmJoinBtn, cancelJoinBtn);
  joinPanel.append(addrLabel, addrInput, panelButtons);

  // Status
  const statusDiv = document.createElement("div");
  statusDiv.className = "menu-status";

  function setStatus(msg: string, type: "" | "error" | "success" = ""): void {
    statusDiv.textContent = msg;
    statusDiv.className = `menu-status${type ? " " + type : ""}`;
  }

  // Rodapé
  const footer = document.createElement("div");
  footer.className = "menu-footer";
  footer.textContent = "VTT D&D 5e — Mesa offline P2P";

  menuContainer.append(title, subtitle, ornament, buttonsDiv, joinPanel, statusDiv);
  root.appendChild(menuContainer);
  root.appendChild(footer);

  // ─── App (mapa + ficha + dados) ───
  let backend: Backend | null = null;
  let guest = false;

  function showApp(): void {
    menuContainer.style.display = "none";
    footer.style.display = "none";

    const appContent = document.createElement("div");
    appContent.className = "app-content";

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "16px";
    wrap.style.padding = "16px";
    wrap.style.height = "100%";

    const canvas = document.createElement("canvas");
    const side = document.createElement("div");

    const sheetTitle = document.createElement("h2");
    sheetTitle.textContent = "Ficha";
    sheetTitle.style.fontFamily = "var(--font-display)";
    sheetTitle.style.color = "var(--tavern-gold)";
    const sheetBox = document.createElement("div");
    sheetBox.style.color = "var(--tavern-text)";
    const tokenList = document.createElement("div");
    const diceTitle = document.createElement("h2");
    diceTitle.textContent = "Dado";
    diceTitle.style.fontFamily = "var(--font-display)";
    diceTitle.style.color = "var(--tavern-gold)";
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
    const rollOut = document.createElement("div");
    rollOut.textContent = "—";
    rollOut.style.color = "var(--tavern-text)";

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

    function showSheet(): void {
      const sheet = sheets.get(selected);
      sheetBox.textContent = sheet
        ? `${sheet.name} — CA ${sheet.ac} — HP ${sheet.hp}/${sheet.maxHp}`
        : "—";
    }

    for (const id of MEMBERS) {
      const btn = document.createElement("button");
      btn.textContent = id;
      btn.className = "menu-btn";
      btn.style.padding = "0.3rem 0.8rem";
      btn.style.fontSize = "0.85rem";
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

    showSheet();
    draw();
    side.append(sheetTitle, tokenList, sheetBox, diceTitle, sidesSel, rollBtn, rollOut);
    wrap.append(canvas, side);
    appContent.appendChild(wrap);
    root.appendChild(appContent);
  }
}
