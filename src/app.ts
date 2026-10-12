// Playable shell bootstrap: menu + sheet creator + saved
// character library + table shell (src/ui/app-shell.ts). The map grid
// only exists inside a session: saving a sheet goes to the library
// (name, class, level, portrait) with view/edit/delete and entering a
// session with that character (host as GM or join with IP). Hosting or
// joining mounts the table; the library and creator never do.
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
import {
  createCharacterLibrary,
  type LibraryView,
} from "./ui/character-library";
import {
  loadLibrary,
  saveLibrary,
  type LibraryStorage,
} from "./sheet/library";
import { createPeer } from "./session/peers";
import { sanitizeSheetWrite } from "./sheet/acl";
import { decodeSheet, encodeSheet } from "./sheet/srd";
import {
  isSheetKey,
  PUBLIC_SHEET_PREFIX,
  sheetKey,
  visibleSheets,
} from "./sheet/visibility";
import type { Sheet } from "./sheet/types";

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
 * Kept for compatibility (Task 4 webview guidance). The browser Host
 * path no longer shows it: plain-browser "Hospedar" now enters a
 * local offline table as GM instead of dead-ending here.
 * @deprecated
 */
export const HOST_UNAVAILABLE_MESSAGE =
  "Hospedar requer o app Tauri — rode `npm run tauri dev` ou use o instalador";

/**
 * Visible note inside the hosted table when the session is a local
 * offline fallback (plain browser, no Rust backend): no LAN yet —
 * network play needs the Tauri app / installer (IP:port) plus the
 * ZeroTier/Radmin/Hamachi VPN hint when direct connections fail.
 */
export const LOCAL_SESSION_NOTE =
  "Sessão LOCAL — sem LAN ainda. Para jogar em rede use o app Tauri " +
  "(`npm run tauri dev` ou instalador) com IP:porta; se não conectar, " +
  "use VPN ZeroTier/Radmin/Hamachi e compartilhe esse IP.";

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

export interface StartAppOptions {
  /** Persisted library backend (defaults to localStorage). */
  storage?: LibraryStorage;
}

/** In-memory fallback when localStorage is unavailable. */
function memoryStorage(): LibraryStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}

function resolveStorage(explicit?: LibraryStorage): LibraryStorage {
  if (explicit) return explicit;
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Private mode / no DOM: fall through to memory.
  }
  return memoryStorage();
}

/** Bootstrap the shell into `root` (Task 4 webview entry). */
export function startApp(root: HTMLElement, opts: StartAppOptions = {}): void {
  // Sem slots fixos: sala vazia + mapa de fichas da biblioteca local.
  // A biblioteca persiste em localStorage; a mesa (grid/tokens) só
  // existe dentro de sessão (hospedar ou entrar).
  const storage = resolveStorage(opts.storage);
  const room = createOfflineRoom([]);
  const grid = createGrid(10, 8);
  const sheets = createEmptySheets();
  for (const saved of loadLibrary(storage)) sheets.set(saved.id, saved);
  const persist = (): void => {
    saveLibrary([...sheets.values()], storage);
  };
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
  let library: LibraryView | null = null;

  function closeLibrary(): void {
    library?.el.remove();
    library = null;
  }

  function enterTable(): void {
    closeLibrary();
    menu.hide();
    shell.show();
    shell.refreshSheets();
  }

  /** Visible LOCAL-session banner inside the mounted table (browser fallback). */
  function showLocalSessionNote(): void {
    const appContent = root.querySelector(".app-content");
    if (!appContent) return;
    if (appContent.querySelector(".local-session-note")) return;
    const note = document.createElement("div");
    note.className = "local-session-note";
    note.textContent = LOCAL_SESSION_NOTE;
    appContent.prepend(note);
  }

  /** Plain-browser host: enter the local OfflineRoom as GM (no backend). */
  function hostLocally(sheet: Sheet | null): void {
    if (sheet) {
      session.character = sheet.id;
      ensureTokenForSheet(sheet);
    }
    session.guest = false;
    session.isGM = true;
    menu.setStatus("Sessão local criada — você é o Mestre (GM).", "success");
    enterTable();
    showLocalSessionNote();
  }

  /** Token vinculado à ficha (criado ao entrar em sessão, nunca ao salvar). */
  function ensureTokenForSheet(sheet: Sheet): void {
    const tokens = room.tokens();
    if (tokens.some((t) => t.represents === sheet.id || t.id === sheet.id)) return;
    try {
      const token = createToken(
        sheet.id,
        { x: tokens.length % 10, y: 0 },
        sheet.hp,
        sheet.id,
      );
      const tokenDelta = { upsert: { [tokenKey(token.id)]: encodeToken(token) } };
      room.apply(tokenDelta);
      if (session.backend && session.isGM) {
        session.backend.pushDelta(tokenDelta);
      }
    } catch {
      // Token inválido: a ficha entra sem token (fail-closed).
    }
  }

  /** Host a session with `sheet` as the active character (GM). */
  function hostWithSheet(sheet: Sheet | null): void {
    if (!isTauri()) {
      hostLocally(sheet);
      return;
    }
    if (sheet) {
      session.character = sheet.id;
      ensureTokenForSheet(sheet);
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
        enterTable();
      })
      .catch((e: Error) => {
        const msg = `Hospedar falhou: ${e.message}`;
        menu.setStatus(msg, "error");
        library?.setStatus(msg);
      });
  }

  /** Join a session with `sheet` as the active character (player). */
  function joinWithSheet(sheet: Sheet | null, address: string): void {
    if (!isTauri()) {
      const msg = "Modo offline: entrada requer Tauri.";
      menu.setStatus(msg, "error");
      library?.setStatus(msg);
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
        session.peers = [...session.peers, player];
        if (sheet) {
          session.character = sheet.id;
          ensureTokenForSheet(sheet);
        } else {
          session.character = null;
        }
        enterTable();
      })
      .catch((e: Error) => {
        const msg = `Entrar falhou: ${e.message}`;
        menu.setStatus(msg, "error");
        library?.setStatus(msg);
      });
  }

  /** Read-only detail overlay (abrir/ver), sem grid/mesa. */
  function showSheetDetail(sheet: Sheet): void {
    const overlay = document.createElement("div");
    overlay.className = "library-detail";
    const detailCard = document.createElement("div");
    detailCard.className = "library-detail-card";
    const photo = document.createElement("div");
    photo.className = "library-detail-photo";
    if (typeof sheet.photo === "string" && sheet.photo !== "") {
      const img = document.createElement("img");
      img.src = sheet.photo;
      img.alt = sheet.name;
      photo.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "library-photo-placeholder";
      ph.textContent = sheet.name.trim().charAt(0).toUpperCase() || "?";
      photo.appendChild(ph);
    }
    const name = document.createElement("div");
    name.className = "library-detail-name";
    name.textContent = sheet.name;
    const meta = document.createElement("div");
    meta.className = "library-detail-meta";
    const cls = sheet.charClass?.trim() !== "" ? (sheet.charClass as string) : "Sem classe";
    meta.textContent = typeof sheet.level === "number" ? `${cls} · Nível ${sheet.level}` : cls;
    detailCard.append(photo, name, meta);
    if (sheet.backstory) {
      const bio = document.createElement("div");
      bio.className = "library-detail-bio";
      bio.textContent = sheet.backstory;
      detailCard.appendChild(bio);
    }
    const actions = document.createElement("div");
    actions.className = "library-detail-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "menu-btn detail-edit";
    editBtn.textContent = "Editar";
    editBtn.addEventListener("click", () => {
      overlay.remove();
      showSheetCreator({ initial: sheet, returnTo: "library" });
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "menu-btn detail-close";
    closeBtn.textContent = "Fechar";
    closeBtn.addEventListener("click", () => overlay.remove());
    actions.append(editBtn, closeBtn);
    detailCard.appendChild(actions);
    overlay.appendChild(detailCard);
    root.appendChild(overlay);
  }

  /** Saved-character library (sem mapa/grid): view/edit/delete + host/join. */
  function showLibrary(): void {
    menu.hide();
    closeLibrary();
    const view = createCharacterLibrary([...sheets.values()], {
      onNew: () => {
        closeLibrary();
        showSheetCreator({ returnTo: "library" });
      },
      onView: (sheet) => showSheetDetail(sheet),
      onEdit: (sheet) => {
        closeLibrary();
        showSheetCreator({ initial: sheet, returnTo: "library" });
      },
      onDelete: (id) => {
        sheets.delete(id);
        persist();
        view.refresh([...sheets.values()]);
      },
      onHost: (sheet) => hostWithSheet(sheet),
      onJoin: (sheet, address) => joinWithSheet(sheet, address),
      onBack: () => {
        closeLibrary();
        menu.show();
      },
    });
    library = view;
    root.appendChild(view.el);
  }

  const menu = createMenu(root, {
    onHost: () => hostWithSheet(null),
    onJoin: (address) => joinWithSheet(null, address),
    onCreateSheet: () => {
      showSheetCreator({ returnTo: "menu" });
    },
    onOpenLibrary: () => {
      showLibrary();
    },
  });

  /**
   * Fullscreen sheet-creation route (no grid/map): hides the menu,
   * mounts the creator overlay, and goes to the saved-character
   * library on save (back to the origin on cancel). Player cria a
   * própria (auto `controllers=[creator]`); GM cria p/ qualquer um
   * e escreve ACL.
   */
  function showSheetCreator(opts: { initial?: Sheet; returnTo: "menu" | "library" }): void {
    menu.hide();
    closeLibrary();
    const peerId = session.peerId !== "" ? session.peerId : session.userId;
    const { el } = createSheetCreator({
      authorPeerId: peerId !== "" ? peerId : local.peerId,
      isGM: session.isGM,
      peers: session.peers,
      initial: opts.initial,
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
        persist();
        // Primeira ficha vira ativa (`user.character`).
        if (session.character === null) session.character = sanitized.id;
        el.remove();
        // Salvar nunca abre a mesa: biblioteca (sem grid) é o destino.
        showLibrary();
      },
      onCancel: () => {
        el.remove();
        if (opts.returnTo === "library") showLibrary();
        else menu.show();
      },
    });
    root.appendChild(el);
  }
}
