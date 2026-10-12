// Playable shell bootstrap: creates the local room + grid + sheets,
// mounts the tavern menu and wires the table shell (src/ui/app-shell.ts)
// to the Tauri bridge when running inside the webview. Sessão sem
// slots fixos (Roll20/Foundry): quem hospeda = GM, quem entra com
// código = player; peers ilimitados; fichas `sheet:<id>` com ACL dupla.
// No central server: in a plain browser the same shell runs fully
// offline with no invoke calls; inside Tauri (`window.__TAURI__`
// present) host/join/sync go through `create_room`, `join_room`,
// `push_delta` and `get_snapshot` (src-tauri/src/commands.rs).

import "./styles/menu.css";
import { createGrid } from "./map/grid";
import { createToken, encodeToken } from "./map/tokens";
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
import {
  createAppShell,
  createEmptySheets,
  type Backend,
  type Session,
} from "./ui/app-shell";
import { createMenu } from "./ui/menu";
import { createSheetCreator } from "./ui/sheet-creator";
import { createPeer } from "./session/peers";
import { sanitizeSheetWrite } from "./sheet/acl";
import { decodeSheet, encodeSheet } from "./sheet/srd";
import {
  isSheetKey,
  PUBLIC_SHEET_PREFIX,
  sheetKey,
  visibleSheets,
} from "./sheet/visibility";

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

/**
 * Shown when "Hospedar" is clicked outside the Tauri app (plain
 * browser): hosting needs the Rust backend, so there is no room to
 * create here — point at `npm run tauri dev` / the installer instead
 * of letting the `tauriInvoke` rejection escape as a bare error.
 */
export const HOST_UNAVAILABLE_MESSAGE =
  "Hospedar requer o app Tauri — rode `npm run tauri dev` ou use o instalador";

/** Sync the sheets map from the (already filtered) room state. Exported p/ testes. */
export function syncSheetsFromRoom(room: OfflineRoom, sheets: Map<string, import("./sheet/types").Sheet>): void {
  for (const [key, value] of Object.entries(room.getState())) {
    if (!isSheetKey(key)) continue;
    // Legado `sheet:public:*`: mapear p/ o id real (`foo`), sem criar
    // id `public:foo` no Map local; chave normal vence quando ambas existem.
    const id = key.startsWith(PUBLIC_SHEET_PREFIX)
      ? key.slice(PUBLIC_SHEET_PREFIX.length)
      : key.slice("sheet:".length);
    if (id.length === 0) continue;
    // Chave normal no snapshot vence; sem ela, a pública legada atualiza
    // (nunca consultar o mapa local stale aqui).
    if (key.startsWith(PUBLIC_SHEET_PREFIX) && room.getState()[sheetKey(id)] !== undefined) continue;
    try {
      sheets.set(id, decodeSheet(value));
    } catch {
      // Ilegível: fail-closed (não entra no mapa local).
    }
  }
  // Remove locais que o host deletou.
  for (const id of [...sheets.keys()]) {
    const key = sheetKey(id);
    const publicKey = `sheet:public:${id}`;
    if (room.getState()[key] === undefined && room.getState()[publicKey] === undefined) {
      // Só remove se nenhuma das formas existe (evita deletar pública legada).
      if (!Object.keys(room.getState()).some((k) => k === key || k.endsWith(`:${id}`))) {
        sheets.delete(id);
      }
    }
  }
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
  sheets: Map<string, import("./sheet/types").Sheet>,
  setStatus: (msg: string) => void,
  redraw: () => void,
  session: Session,
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
      // and REMOVE local keys the host deleted. Guests veem só
      // próprias + compartilhadas (ACL, com gmNotes filtrado na
      // ingestão via visibleSheets); GM vê todas.
      const full = doc.state;
      const peerId = session.peerId !== "" ? session.peerId : session.userId;
      const isGM = session.isGM;
      const state = !isGM && peerId !== "" ? visibleSheets(full, "guest", peerId) : full;
      const delta = replaceDelta(room.getState(), state);
      room.apply(delta);
      syncSheetsFromRoom(room, sheets);
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
  // Sem slots fixos: sala vazia + mapa de fichas vazio. Peers/fichas
  // entram dinamicamente (host=GM, join=player, criar ficha).
  const room = createOfflineRoom([]);
  const grid = createGrid(10, 8);
  const sheets = createEmptySheets();
  // Offline solo começa como GM ("Mestre") — hospedar mantém, entrar
  // troca p/ player. peerId = hash + nome auto-declarado.
  const local = createPeer("Mestre", true);
  const session: Session = {
    backend: null,
    guest: false,
    rollSeq: 0,
    userId: local.peerId,
    peerId: local.peerId,
    displayName: local.displayName,
    isGM: true,
    character: null,
    peers: [local],
  };
  try {
    room.addPeer(local.displayName, true);
  } catch {
    // Sala legada sem peers: ignora (migração).
  }

  const shell = createAppShell({ root, room, grid, sheets, session });

  const menu = createMenu(root, {
    onHost: () => {
      if (!isTauri()) {
        menu.setStatus(HOST_UNAVAILABLE_MESSAGE, "error");
        return;
      }
      menu.setStatus("Criando sala...");
      tauriInvoke("create_room", { port: 7000 })
        .then((reply) => {
          session.guest = false;
          session.isGM = true;
          menu.setStatus(
            `Sala hospedada: ${String(reply)} — convite ${room.inviteCode()}`,
            "success",
          );
          menu.hide();
          shell.show();
        })
        .catch((e: Error) => {
          menu.setStatus(`Hospedar falhou: ${e.message}`, "error");
        });
    },
    onJoin: (address) => {
      if (!isTauri()) {
        menu.setStatus("Modo offline: entrada requer Tauri.", "error");
        return;
      }
      menu.setStatus(`Conectando a ${address}...`);
      joinVia(address, invokeViaBridge)
        .then((info) => {
          menu.setStatus(guestJoinNotice(info), "success");
          // Quem entra com código = player (não-GM).
          const player = createPeer("Jogador", false);
          session.guest = true;
          session.isGM = false;
          session.userId = player.peerId;
          session.peerId = player.peerId;
          session.displayName = player.displayName;
          session.character = null;
          session.peers = [...session.peers, player];
          menu.hide();
          shell.show();
        })
        .catch((e: Error) => {
          menu.setStatus(`Entrar falhou: ${e.message}`, "error");
        });
    },
    onCreateSheet: () => {
      showSheetCreator();
    },
  });

  /**
   * Separate fullscreen sheet-creation route (no grid/map): hides the
   * menu, mounts the creator overlay, and returns to the table on save
   * (to the menu on cancel). Player cria a própria (auto
   * `controllers=[creator]`); GM cria p/ qualquer um e escreve ACL.
   */
  function showSheetCreator(): void {
    menu.hide();
    const peerId = session.peerId !== "" ? session.peerId : session.userId;
    const { el } = createSheetCreator({
      authorPeerId: peerId !== "" ? peerId : local.peerId,
      isGM: session.isGM,
      peers: session.peers,
      onSave: (sheet) => {
        // Fail-closed: ACL escrita por não-GM ignorada mesmo se a UI
        // for burlada (sanitize trava viewers/controllers/public*).
        const sanitized = sanitizeSheetWrite(null, sheet, {
          peerId: peerId !== "" ? peerId : local.peerId,
          isGM: session.isGM,
        });
        sheets.set(sanitized.id, sanitized);
        const sheetDelta = { upsert: { [sheetKey(sanitized.id)]: encodeSheet(sanitized) } };
        room.apply(sheetDelta);
        // Token vinculado (`represents`) herda controle da ficha.
        try {
          const token = createToken(
            sanitized.id,
            { x: sheets.size % 10, y: 0 },
            sanitized.hp,
            sanitized.id,
          );
          const tokenDelta = { upsert: { [tokenKey(token.id)]: encodeToken(token) } };
          room.apply(tokenDelta);
          if (session.backend && session.isGM) {
            session.backend.pushDelta(sheetDelta);
            session.backend.pushDelta(tokenDelta);
          }
        } catch {
          if (session.backend && session.isGM) {
            session.backend.pushDelta(sheetDelta);
          }
        }
        // Primeira ficha vira ativa (`user.character`).
        if (session.character === null) session.character = sanitized.id;
        el.remove();
        shell.refreshSheets();
        shell.show();
      },
      onCancel: () => {
        el.remove();
        menu.show();
      },
    });
    root.appendChild(el);
  }
}
