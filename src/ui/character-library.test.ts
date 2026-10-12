// @vitest-environment jsdom
// Character library view: list with name/class/level/photo plus the
// view/edit/delete/host/join/new actions. Never mounts the map grid.
import { expect, test, vi } from "vitest";
import { createCharacterLibrary } from "./character-library";
import type { Sheet } from "../sheet/types";

function sheet(id: string, name: string, extra: Partial<Sheet> = {}): Sheet {
  return { id, name, ac: 10, hp: 8, maxHp: 8, ...extra } as Sheet;
}

function handlers(overrides: Partial<Parameters<typeof createCharacterLibrary>[1]> = {}) {
  return {
    onNew: vi.fn(),
    onView: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onHost: vi.fn(),
    onJoin: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

test("lists saved sheets with name, class, level and photo", () => {
  const sheets = [
    sheet("a", "Borin", {
      charClass: "Guerreiro",
      level: 3,
      photo: "data:image/png;base64,AAA",
    }),
    sheet("b", "Celia", { charClass: "Maga", level: 2 }),
  ];
  const h = handlers();
  const view = createCharacterLibrary(sheets, h);
  document.body.appendChild(view.el);
  try {
    expect(view.el.classList.contains("char-library")).toBe(true);
    const cards = [...view.el.querySelectorAll(".library-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute("data-sheet-id")).toBe("a");
    expect(cards[0].querySelector(".library-name")?.textContent).toContain("Borin");
    expect(cards[0].querySelector(".library-meta")?.textContent).toContain("Guerreiro");
    expect(cards[0].querySelector(".library-meta")?.textContent).toMatch(/3/);
    expect(cards[0].querySelector(".library-photo img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAA",
    );
    // Without photo: initial placeholder, never a broken image.
    expect(cards[1].querySelector(".library-photo img")).toBeNull();
    expect(
      cards[1].querySelector(".library-photo-placeholder")?.textContent,
    ).toContain("C");
  } finally {
    view.el.remove();
  }
});

test("empty library shows the empty state with a new-character action", () => {
  const h = handlers();
  const view = createCharacterLibrary([], h);
  document.body.appendChild(view.el);
  try {
    expect(view.el.querySelector(".library-empty")).not.toBeNull();
    view.el.querySelector<HTMLButtonElement>(".library-new")!.click();
    expect(h.onNew).toHaveBeenCalledTimes(1);
  } finally {
    view.el.remove();
  }
});

test("card actions call view/edit/delete/host/join handlers", () => {
  const hero = sheet("a", "Borin", { charClass: "Guerreiro", level: 1 });
  const h = handlers();
  const view = createCharacterLibrary([hero], h);
  document.body.appendChild(view.el);
  try {
    const card = view.el.querySelector(".library-card")!;
    card.querySelector<HTMLButtonElement>(".library-view")!.click();
    expect(h.onView).toHaveBeenCalledWith(hero);
    card.querySelector<HTMLButtonElement>(".library-edit")!.click();
    expect(h.onEdit).toHaveBeenCalledWith(hero);
    card.querySelector<HTMLButtonElement>(".library-delete")!.click();
    expect(h.onDelete).toHaveBeenCalledWith("a");
    card.querySelector<HTMLButtonElement>(".library-host")!.click();
    expect(h.onHost).toHaveBeenCalledWith(hero);
    const addr = view.el.querySelector<HTMLInputElement>(".library-join-address")!;
    addr.value = "192.168.1.10:7000";
    card.querySelector<HTMLButtonElement>(".library-join")!.click();
    expect(h.onJoin).toHaveBeenCalledWith(hero, "192.168.1.10:7000");
    view.el.querySelector<HTMLButtonElement>(".library-back")!.click();
    expect(h.onBack).toHaveBeenCalledTimes(1);
  } finally {
    view.el.remove();
  }
});

test("refresh re-renders the list (used after edit/delete)", () => {
  const h = handlers();
  const view = createCharacterLibrary([sheet("a", "Borin")], h);
  document.body.appendChild(view.el);
  try {
    expect(view.el.querySelectorAll(".library-card")).toHaveLength(1);
    view.refresh([sheet("a", "Borin Novo"), sheet("b", "Celia")]);
    expect(view.el.querySelectorAll(".library-card")).toHaveLength(2);
    expect(view.el.querySelector(".library-card")?.textContent).toContain("Borin Novo");
    view.refresh([]);
    expect(view.el.querySelector(".library-empty")).not.toBeNull();
  } finally {
    view.el.remove();
  }
});

test("status line surfaces host/join errors inside the library", () => {
  const h = handlers();
  const view = createCharacterLibrary([sheet("a", "Borin")], h);
  document.body.appendChild(view.el);
  try {
    const status = view.el.querySelector(".library-status");
    expect(status).not.toBeNull();
    view.setStatus("Hospedar falhou: offline");
    expect(view.el.querySelector(".library-status")?.textContent).toBe(
      "Hospedar falhou: offline",
    );
  } finally {
    view.el.remove();
  }
});

test("library never mounts the map grid or table", () => {  const h = handlers();
  const view = createCharacterLibrary([sheet("a", "Borin")], h);
  document.body.appendChild(view.el);
  try {
    expect(view.el.querySelector("canvas")).toBeNull();
    expect(view.el.querySelector(".app-content")).toBeNull();
    expect(view.el.querySelector(".map-grid")).toBeNull();
  } finally {
    view.el.remove();
  }
});
