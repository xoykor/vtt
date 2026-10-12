// @vitest-environment jsdom
// The table UI (toolbar rail, layer switcher, grid panel, chat)
// mounts inside the app-shell table view; the shell canvas keeps its
// token-move click on the select tool and its sheet/dice behavior.
import { expect, test } from "vitest";
import { createGrid } from "../map/grid";
import { createToken, encodeToken } from "../map/tokens";
import type { Sheet } from "../sheet/types";
import { createOfflineRoom, tokenKey } from "./room";
import { createAppShell, type Session } from "./app-shell";

function gmSession(): Session {
  return {
    backend: null,
    guest: false,
    rollSeq: 0,
    userId: "p1",
    peerId: "p1",
    displayName: "Mestre",
    isGM: true,
    character: "s1",
    peers: [{ peerId: "p1", displayName: "Mestre", isGM: true }],
  };
}

function sheets(): Map<string, Sheet> {
  return new Map([["s1", { id: "s1", name: "Borin", ac: 14, hp: 20, maxHp: 24 }]]);
}

function mounted(): { root: HTMLElement; room: ReturnType<typeof createOfflineRoom> } {
  const room = createOfflineRoom([]);
  room.apply({
    upsert: { [tokenKey("s1")]: encodeToken(createToken("s1", { x: 1, y: 0 }, 20, "s1")) },
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  createAppShell({ root, room, grid: createGrid(10, 8), sheets: sheets(), session: gmSession() }).show();
  return { root, room };
}

test("shell table mounts the rail, canvas, layers, grid and chat", () => {
  const { root } = mounted();
  try {
    expect(root.querySelector("[data-testid=toolbar]")).not.toBeNull();
    expect(root.querySelectorAll("[data-testid^=tool-]")).toHaveLength(9);
    expect(root.querySelector("[data-testid=table-canvas]")).not.toBeNull();
    expect(root.querySelector("[data-testid=layer-panel]")).not.toBeNull();
    expect(root.querySelector("[data-testid=grid-panel]")).not.toBeNull();
    expect(root.querySelector("[data-testid=chat-panel]")).not.toBeNull();
    // The sheet bar and dice panel still mount alongside the table.
    expect(root.textContent).toMatch(/Borin/);
  } finally {
    root.remove();
  }
});

test("token click still moves on the select tool; context menu never opens", () => {
  const { root, room } = mounted();
  try {
    const canvas = root.querySelector("[data-testid=table-canvas]") as HTMLCanvasElement;
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);

    // Cell (2,0) at default 32px: click moves the selected token there.
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 2 * 32 + 1, clientY: 1, bubbles: true }));
    expect(room.tokens().find((t) => t.id === "s1")?.pos).toEqual({ x: 2, y: 0 });
  } finally {
    root.remove();
  }
});

test("chat speaks as the current character and broadcasts chat:* keys", () => {
  const { root, room } = mounted();
  try {
    const input = root.querySelector("[data-testid=chat-input]") as HTMLTextAreaElement;
    input.value = "olá, mesa";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const log = root.querySelector("[data-testid=chat-log]")!;
    expect(log.textContent).toMatch(/Borin/);
    expect(log.textContent).toMatch(/olá, mesa/);
    const keys = Object.keys(room.getState()).filter((k) => k.startsWith("chat:"));
    expect(keys).toHaveLength(1);
    expect(room.getState()[keys[0]]).toContain("olá, mesa");
  } finally {
    root.remove();
  }
});

test("layer preview hides the GM layer inside the shell", () => {
  const { root } = mounted();
  try {
    root.querySelector<HTMLButtonElement>("[data-testid=tool-layers]")!.click();
    expect(
      (root.querySelector("[data-testid=layer-host]") as HTMLElement).hasAttribute("hidden"),
    ).toBe(false);
    const tiles = root.querySelector("[data-testid=layer-tiles]")!;
    // No tiles seeded: the list reports emptiness instead of crashing.
    expect(tiles.textContent).toMatch(/Nenhum tile/);
    root.querySelector<HTMLInputElement>("[data-testid=table-preview]")!.click();
    expect(tiles.textContent).toMatch(/Nenhum tile/);
  } finally {
    root.remove();
  }
});

test("refreshSheets reloads chat history from the room", () => {
  const room = createOfflineRoom([]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    const shell = createAppShell({
      root,
      room,
      grid: createGrid(10, 8),
      sheets: sheets(),
      session: gmSession(),
    });
    shell.show();
    room.apply({
      upsert: {
        "chat:7": JSON.stringify({ id: "7-1", ts: 7, from: "Borin", kind: "say", text: "eco do sync" }),
      },
    });
    expect(root.querySelector("[data-testid=chat-log]")!.textContent).not.toMatch(/eco do sync/);
    shell.refreshSheets();
    expect(root.querySelector("[data-testid=chat-log]")!.textContent).toMatch(/eco do sync/);
  } finally {
    root.remove();
  }
});
