// Saved-character library view: list of stored sheets (name, class,
// level, portrait) with view/edit/delete plus entering a session with
// that character (host as GM or join with IP). Pure DOM, tavern theme.
// Never mounts the map/grid/table: no canvas, no `.app-content`.

import type { Sheet } from "../sheet/types";

export interface LibraryHandlers {
  /** "Novo personagem": open the creator. */
  onNew(): void;
  /** "Ver": open the read-only detail. */
  onView(sheet: Sheet): void;
  /** "Editar": open the creator prefilled. */
  onEdit(sheet: Sheet): void;
  /** "Excluir": remove from the library. */
  onDelete(id: string): void;
  /** "Hospedar": host a session with this character. */
  onHost(sheet: Sheet): void;
  /** "Entrar": join a session with this character + address. */
  onJoin(sheet: Sheet, address: string): void;
  /** Back to the tavern menu. */
  onBack(): void;
}

export interface LibraryView {
  /** Root element (the caller mounts and removes it). */
  el: HTMLElement;
  /** Re-render the list (used after edit/delete). */
  refresh(sheets: Sheet[]): void;
}

const DEFAULT_JOIN_ADDRESS = "127.0.0.1:7000";

function metaLine(sheet: Sheet): string {
  const cls = sheet.charClass?.trim() !== "" ? (sheet.charClass as string) : "Sem classe";
  const level = typeof sheet.level === "number" ? ` · Nv ${sheet.level}` : "";
  return `${cls}${level}`;
}

function photoEl(sheet: Sheet): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "library-photo";
  if (typeof sheet.photo === "string" && sheet.photo !== "") {
    const img = document.createElement("img");
    img.src = sheet.photo;
    img.alt = sheet.name;
    wrap.appendChild(img);
  } else {
    const ph = document.createElement("span");
    ph.className = "library-photo-placeholder";
    ph.textContent = sheet.name.trim().charAt(0).toUpperCase() || "?";
    wrap.appendChild(ph);
  }
  return wrap;
}

function actionButton(label: string, className: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `menu-btn ${className}`;
  btn.textContent = label;
  return btn;
}

/** Build the library overlay; the caller mounts `el` and removes it. */
export function createCharacterLibrary(
  initial: Sheet[],
  handlers: LibraryHandlers,
): LibraryView {
  const el = document.createElement("div");
  el.className = "char-library";

  const card = document.createElement("div");
  card.className = "library-card-wrap";
  el.appendChild(card);

  const title = document.createElement("h2");
  title.className = "library-title";
  title.textContent = "Meus Personagens";
  card.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "library-subtitle";
  subtitle.textContent = "Escolha um personagem para ver, editar ou entrar em sessão";
  card.appendChild(subtitle);

  const toolbar = document.createElement("div");
  toolbar.className = "library-toolbar";

  const newBtn = actionButton("＋ Novo personagem", "library-new");
  newBtn.addEventListener("click", () => handlers.onNew());
  toolbar.appendChild(newBtn);

  const joinAddr = document.createElement("input");
  joinAddr.type = "text";
  joinAddr.className = "library-join-address";
  joinAddr.value = DEFAULT_JOIN_ADDRESS;
  joinAddr.placeholder = "192.168.1.100:7000";
  joinAddr.setAttribute("aria-label", "Endereço da sala (IP:Porta)");
  toolbar.appendChild(joinAddr);

  const backBtn = actionButton("← Taverna", "library-back");
  backBtn.addEventListener("click", () => handlers.onBack());
  toolbar.appendChild(backBtn);
  card.appendChild(toolbar);

  const list = document.createElement("div");
  list.className = "library-list";
  card.appendChild(list);

  function render(sheets: Sheet[]): void {
    list.innerHTML = "";
    if (sheets.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "Nenhum personagem salvo — crie o primeiro.";
      list.appendChild(empty);
      return;
    }
    const ordered = [...sheets].sort((a, b) => a.name.localeCompare(b.name));
    for (const sheet of ordered) {
      const item = document.createElement("div");
      item.className = "library-card";
      item.setAttribute("data-sheet-id", sheet.id);

      item.appendChild(photoEl(sheet));

      const info = document.createElement("div");
      info.className = "library-info";
      const name = document.createElement("div");
      name.className = "library-name";
      name.textContent = sheet.name;
      const meta = document.createElement("div");
      meta.className = "library-meta";
      meta.textContent = metaLine(sheet);
      info.append(name, meta);
      item.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "library-actions";
      const viewBtn = actionButton("Ver", "library-view");
      viewBtn.addEventListener("click", () => handlers.onView(sheet));
      const editBtn = actionButton("Editar", "library-edit");
      editBtn.addEventListener("click", () => handlers.onEdit(sheet));
      const delBtn = actionButton("Excluir", "library-delete");
      delBtn.addEventListener("click", () => handlers.onDelete(sheet.id));
      const hostBtn = actionButton("Hospedar", "library-host");
      hostBtn.addEventListener("click", () => handlers.onHost(sheet));
      const joinBtn = actionButton("Entrar", "library-join");
      joinBtn.addEventListener("click", () => handlers.onJoin(sheet, joinAddr.value));
      actions.append(viewBtn, editBtn, delBtn, hostBtn, joinBtn);
      item.appendChild(actions);

      list.appendChild(item);
    }
  }

  render(initial);
  return { el, refresh: render };
}
