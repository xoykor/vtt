// Menu start menu: animated vault backdrop plus the three buttons
// (Hospedar / Entrar / Criar Ficha) with the join panel (IP:Porta) and a
// status line. Pure DOM: every action goes through the handlers the caller
// passes in, so this module knows nothing about rooms or the bridge.

import { startMenuBackdrop, type MenuBackdropHandle } from "./menu-backdrop";

export type NoticeKind = "" | "error" | "success";

export interface MenuHandlers {
  /** "Hospedar": host a room locally (needs the Tauri bridge). */
  onHost(): void;
  /** "Confirmar" in the join panel, with the typed address (IP:Porta). */
  onJoin(address: string): void;
  /** "Criar Ficha de Personagem": open the sheet creator. */
  onCreateSheet(): void;
  /** "Meus Personagens": open the saved-character library. */
  onOpenLibrary(): void;
}

export interface Menu {
  /** Hide the menu (backdrop, buttons and footer). */
  hide(): void;
  /** Show the menu again (used when the sheet creator is cancelled). */
  show(): void;
  /** Write a message into the status line. */
  setStatus(message: string, kind?: NoticeKind): void;
}

/** localStorage key for the vault-sound mute choice. */
export const MENU_MUTED_KEY = "vtt:menu-muted";

function readMutedChoice(): boolean {
  try {
    return window.localStorage?.getItem(MENU_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMutedChoice(muted: boolean): void {
  try {
    window.localStorage?.setItem(MENU_MUTED_KEY, muted ? "1" : "0");
  } catch {
    // Private mode: the choice simply does not persist.
  }
}

/** Build the menu (backdrop, title, three buttons, join panel). */
export function createMenu(root: HTMLElement, handlers: MenuHandlers): Menu {
  root.innerHTML = "";

  const bg = document.createElement("div");
  bg.className = "menu-bg";

  const overlay = document.createElement("div");
  overlay.className = "menu-backdrop-overlay";
  overlay.setAttribute("aria-hidden", "true");

  let muted = readMutedChoice();
  let backdrop: MenuBackdropHandle | null = null;
  let canvasEl: HTMLCanvasElement | null = null;

  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.className = "menu-mute-btn";
  function paintMuteBtn(): void {
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
    const label = muted ? "Ativar sons do cofre" : "Silenciar sons do cofre";
    muteBtn.setAttribute("aria-label", label);
    muteBtn.title = label;
  }
  paintMuteBtn();
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    writeMutedChoice(muted);
    paintMuteBtn();
    backdrop?.setMuted(muted);
  });

  /** Mount the animated canvas (cheap: one static frame when reduced). */
  function mountBackdrop(): void {
    if (canvasEl || bg.style.display === "none") return;
    const canvas = document.createElement("canvas");
    canvas.className = "menu-backdrop-canvas";
    canvas.setAttribute("aria-hidden", "true");
    bg.prepend(canvas);
    canvasEl = canvas;
    try {
      backdrop = startMenuBackdrop(canvas, { muted });
    } catch {
      // No canvas/audio in this browser: the CSS gradient stays behind.
      backdrop = null;
    }
  }

  /** Stop the loop + free the canvas so hidden menus cost nothing. */
  function teardownBackdrop(): void {
    backdrop?.stop();
    backdrop = null;
    canvasEl?.remove();
    canvasEl = null;
  }

  bg.append(overlay, muteBtn);
  root.appendChild(bg);
  mountBackdrop();

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
  hostBtn.addEventListener("click", () => handlers.onHost());

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
  sheetBtn.addEventListener("click", () => handlers.onCreateSheet());

  // Botão Biblioteca (fichas salvas, sem grid/mesa).
  const libraryBtn = document.createElement("button");
  libraryBtn.className = "menu-btn";
  libraryBtn.innerHTML = '<span class="btn-icon">📚</span> Meus Personagens';
  libraryBtn.addEventListener("click", () => handlers.onOpenLibrary());

  buttonsDiv.append(hostBtn, joinBtn, sheetBtn, libraryBtn);

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
  confirmJoinBtn.addEventListener("click", () => handlers.onJoin(addrInput.value));

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

  // Rodapé
  const footer = document.createElement("div");
  footer.className = "menu-footer";
  footer.textContent = "VTT D&D 5e — Mesa offline P2P";

  menuContainer.append(title, subtitle, ornament, buttonsDiv, joinPanel, statusDiv);
  root.appendChild(menuContainer);
  root.appendChild(footer);

  return {
    hide(): void {
      teardownBackdrop();
      bg.style.display = "none";
      menuContainer.style.display = "none";
      footer.style.display = "none";
    },
    show(): void {
      bg.style.display = "";
      menuContainer.style.display = "";
      footer.style.display = "";
      mountBackdrop();
    },
    setStatus(message: string, kind: NoticeKind = ""): void {
      statusDiv.textContent = message;
      statusDiv.className = `menu-status${kind ? " " + kind : ""}`;
    },
  };
}
