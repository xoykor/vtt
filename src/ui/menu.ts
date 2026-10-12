// Tavern start menu: SVG backdrop plus the three buttons (Hospedar /
// Entrar / Criar Ficha) with the join panel (IP:Porta) and a status
// line. Pure DOM: every action goes through the handlers the caller
// passes in, so this module knows nothing about rooms or the bridge.

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

/** Build the tavern menu (backdrop, title, three buttons, join panel). */
export function createMenu(root: HTMLElement, handlers: MenuHandlers): Menu {
  root.innerHTML = "";

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
      bg.style.display = "none";
      menuContainer.style.display = "none";
      footer.style.display = "none";
    },
    show(): void {
      bg.style.display = "";
      menuContainer.style.display = "";
      footer.style.display = "";
    },
    setStatus(message: string, kind: NoticeKind = ""): void {
      statusDiv.textContent = message;
      statusDiv.className = `menu-status${kind ? " " + kind : ""}`;
    },
  };
}
