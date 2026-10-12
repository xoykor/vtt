// @vitest-environment jsdom
// App flow: saving in the creator goes to the saved-character library
// (never the grid/room). The grid/table only mounts after host or join.
// The creator stays reachable from the library and the menu.
import { afterEach, expect, test, vi } from "vitest";
import { startApp } from "./app";
import { loadLibrary, type LibraryStorage } from "./sheet/library";

function memStorage(): LibraryStorage & { raw(): string | null } {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    raw: () => store.get("vtt-char-library-v1") ?? null,
  };
}

function clickButton(root: HTMLElement, label: string): void {
  const btn = [...root.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`button not found: ${label}`);
  (btn as HTMLButtonElement).click();
}

function saveHero(root: HTMLElement, name = "Borin"): void {
  clickButton(root, "Criar Ficha");
  root.querySelector<HTMLInputElement>(".creator-name")!.value = name;
  root.querySelector<HTMLInputElement>(".creator-class")!.value = "Guerreiro";
  root.querySelector<HTMLInputElement>(".creator-level")!.value = "3";
  root.querySelector<HTMLButtonElement>(".creator-save")!.click();
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  document.body.innerHTML = "";
});

test("saving in the creator navigates to the saved-character library", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    // Creator is gone, library is up with the saved sheet.
    expect(root.querySelector(".sheet-creator")).toBeNull();
    expect(root.querySelector(".char-library")).not.toBeNull();
    expect(root.querySelector(".library-card")?.textContent).toContain("Borin");
    expect(root.querySelector(".library-card")?.textContent).toContain("Guerreiro");
  } finally {
    root.remove();
  }
});

test("library renders no map/grid outside a session", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    expect(root.querySelector(".char-library")).not.toBeNull();
    expect(root.querySelector(".app-content")).toBeNull();
    expect(root.querySelector("canvas")).toBeNull();
    // Opening the library straight from the menu also mounts no grid.
    root.querySelector<HTMLButtonElement>(".library-back")!.click();
    clickButton(root, "Meus Personagens");
    expect(root.querySelector(".char-library")).not.toBeNull();
    expect(root.querySelector(".app-content")).toBeNull();
    expect(root.querySelector("canvas")).toBeNull();
  } finally {
    root.remove();
  }
});

test("creator stays reachable from the library and the menu", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    // From the menu.
    clickButton(root, "Criar Ficha");
    expect(root.querySelector(".sheet-creator")).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".creator-cancel")!.click();
    // From the library.
    clickButton(root, "Meus Personagens");
    root.querySelector<HTMLButtonElement>(".library-new")!.click();
    expect(root.querySelector(".sheet-creator")).not.toBeNull();
  } finally {
    root.remove();
  }
});

test("saved sheets persist locally and reload", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    expect(loadLibrary(storage).map((s) => s.name)).toEqual(["Borin"]);
    // A fresh shell over the same storage still lists the hero.
    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    try {
      startApp(root2, { storage });
      clickButton(root2, "Meus Personagens");
      expect(root2.querySelector(".library-card")?.textContent).toContain("Borin");
    } finally {
      root2.remove();
    }
  } finally {
    root.remove();
  }
});

test("editing a saved sheet updates the library entry", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    const before = loadLibrary(storage);
    expect(before).toHaveLength(1);
    root.querySelector<HTMLButtonElement>(".library-edit")!.click();
    expect(root.querySelector(".sheet-creator")).not.toBeNull();
    root.querySelector<HTMLInputElement>(".creator-name")!.value = "Borin Novo";
    root.querySelector<HTMLButtonElement>(".creator-save")!.click();
    expect(root.querySelector(".char-library")).not.toBeNull();
    expect(root.querySelectorAll(".library-card")).toHaveLength(1);
    expect(root.querySelector(".library-card")?.textContent).toContain("Borin Novo");
    const after = loadLibrary(storage);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Borin Novo");
    expect(after[0].id).toBe(before[0].id);
  } finally {
    root.remove();
  }
});

test("deleting a saved sheet removes it and persists", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    root.querySelector<HTMLButtonElement>(".library-delete")!.click();
    expect(root.querySelector(".library-card")).toBeNull();
    expect(root.querySelector(".library-empty")).not.toBeNull();
    expect(loadLibrary(storage)).toEqual([]);
  } finally {
    root.remove();
  }
});

test("viewing a sheet opens details without the grid", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    root.querySelector<HTMLButtonElement>(".library-view")!.click();
    expect(root.querySelector(".library-detail")).not.toBeNull();
    expect(root.querySelector(".library-detail")?.textContent).toContain("Borin");
    expect(root.querySelector(".app-content")).toBeNull();
    expect(root.querySelector("canvas")).toBeNull();
  } finally {
    root.remove();
  }
});

test("hosting from the library without Tauri enters the local table", () => {
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    root.querySelector<HTMLButtonElement>(".library-host")!.click();
    // Same enterTable path as Tauri success: table mounted, library closed.
    expect(root.querySelector(".app-content")).not.toBeNull();
    expect(root.querySelector(".char-library")).toBeNull();
    // The GM enters with that sheet available (mirrors the Tauri path).
    expect(root.querySelector(".app-content")?.textContent).toContain("Borin");
    // Visible LOCAL-session note inside the table (LAN guidance).
    const note = root.querySelector(".local-session-note");
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/LOCAL/);
    expect(note?.textContent).toMatch(/Tauri/);
    expect(note?.textContent).toMatch(/ZeroTier\/Radmin/);
  } finally {
    root.remove();
  }
});

test("hosting with a library character opens the table", async () => {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "create_room") return "room-7000";
        throw new Error(`unexpected: ${cmd}`);
      },
    },
  };
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    root.querySelector<HTMLButtonElement>(".library-host")!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".app-content")).not.toBeNull();
  } finally {
    root.remove();
  }
});

test("joining with a library character opens the table", async () => {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "join_room")
      return JSON.stringify({ version: "1.0", room: "sala", port: 7000 });
    throw new Error(`unexpected: ${cmd}`);
  });
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: { invoke },
  };
  const storage = memStorage();
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root, { storage });
    saveHero(root, "Borin");
    root.querySelector<HTMLInputElement>(".library-join-address")!.value =
      "127.0.0.1:7000";
    root.querySelector<HTMLButtonElement>(".library-join")!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).toHaveBeenCalledWith(
      "join_room",
      expect.objectContaining({ ip: "127.0.0.1", port: 7000 }),
    );
    expect(root.querySelector(".app-content")).not.toBeNull();
  } finally {
    root.remove();
  }
});
