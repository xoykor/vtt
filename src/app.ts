// Playable shell bootstrap: creates the local room + grid + sheets,
// mounts the tavern menu and wires the table shell (src/ui/app-shell.ts)
// to the Tauri bridge when running inside the webview. No central
// server: in a plain browser the same shell runs fully offline with no
// invoke calls; inside Tauri (`window.__TAURI__` present) host/join/sync
// go through `create_room`, `join_room`, `push_delta` and `get_snapshot`
// (src-tauri/src/commands.rs).

import "./styles/menu.css";
import { createGrid } from "./map/grid";
import type { Delta } from "./net/peer";
import {
  createOfflineRoom,
  guestJoinNotice,
  joinVia,
  replaceDelta,
  type InvokeFn,
  type OfflineRoom,
} from "./ui/room";
import {
  createAppShell,
  createMemberSheets,
  type Backend,
  type Session,
} from "./ui/app-shell";
import { createMenu } from "./ui/menu";
import { MEMBERS } from "./ui/token-bar";

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
  const sheets = createMemberSheets();
  const session: Session = { backend: null, guest: false, rollSeq: 0 };

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
          menu.setStatus(`Sala hospedada: ${String(reply)}`, "success");
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
          session.guest = true;
          menu.hide();
          shell.show();
        })
        .catch((e: Error) => {
          menu.setStatus(`Entrar falhou: ${e.message}`, "error");
        });
    },
    onCreateSheet: () => {
      menu.hide();
      shell.show();
    },
  });
}
