// @vitest-environment jsdom
// TDD: mesa sem slots — GM vê todas, player vê próprias+compartilhadas,
// user.character padrão p/ falar/rolar, sem seletor de jogador.
import { expect, test } from "vitest";
import { createGrid } from "../map/grid";
import { encodeSheet } from "../sheet/srd";
import type { Sheet } from "../sheet/types";
import { createOfflineRoom } from "./room";
import {
  createAppShell,
  visibleSheetsForSession,
  type Session,
} from "./app-shell";

function makeSession(over: Partial<Session> = {}): Session {
  return {
    backend: null,
    guest: false,
    rollSeq: 0,
    userId: "gm-1",
    peerId: "gm-1",
    displayName: "Mestre",
    isGM: true,
    character: null,
    peers: [{ peerId: "gm-1", displayName: "Mestre", isGM: true }],
    ...over,
  };
}

function makeSheets(): Map<string, Sheet> {
  const mine: Sheet = {
    id: "s-mine",
    name: "Minha",
    ac: 15,
    hp: 20,
    maxHp: 24,
    controllers: ["peer-b"],
  };
  const other: Sheet = {
    id: "s-other",
    name: "Alheia",
    ac: 14,
    hp: 18,
    maxHp: 22,
    controllers: ["peer-a"],
  };
  const open: Sheet = {
    id: "s-open",
    name: "Taverna",
    ac: 10,
    hp: 5,
    maxHp: 5,
    publicView: true,
  };
  return new Map([
    ["s-mine", mine],
    ["s-other", other],
    ["s-open", open],
  ]);
}

test("GM vê todas (visibleSheets p/ GM = todas)", () => {
  const sheets = makeSheets();
  const gm = makeSession({ peerId: "gm-1", isGM: true });
  expect(visibleSheetsForSession(sheets, gm).map((s) => s.id).sort()).toEqual([
    "s-mine",
    "s-open",
    "s-other",
  ]);
});

test("player vê próprias + compartilhadas, não alheias", () => {
  const sheets = makeSheets();
  const player = makeSession({
    peerId: "peer-b",
    userId: "peer-b",
    displayName: "Borin",
    isGM: false,
    guest: true,
  });
  const ids = visibleSheetsForSession(sheets, player).map((s) => s.id).sort();
  expect(ids).toEqual(["s-mine", "s-open"]);
});

test("mesa não tem seletor de jogador; seleção define user.character", () => {
  const room = createOfflineRoom([]);
  const grid = createGrid(10, 8);
  const sheets = makeSheets();
  const session = makeSession({
    peerId: "peer-b",
    userId: "peer-b",
    displayName: "Borin",
    isGM: false,
    guest: true,
    character: null,
    peers: [
      { peerId: "peer-b", displayName: "Borin", isGM: false },
      { peerId: "peer-a", displayName: "Ana", isGM: false },
    ],
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    const shell = createAppShell({ root, room, grid, sheets, session });
    shell.show();
    // Sem slots fixos: nenhum botão dm/p1..p5.
    const labels = [...root.querySelectorAll(".token-bar button")].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain("dm");
    expect(labels).not.toContain("p1");
    // Só visíveis: Minha + Taverna (ordenadas).
    expect(labels.sort()).toEqual(["Minha", "Taverna"]);
    // Clicar define character (padrão p/ falar/rolar).
    const btn = [...root.querySelectorAll<HTMLButtonElement>(".token-bar button")].find(
      (b) => b.textContent === "Minha",
    )!;
    btn.click();
    expect(session.character).toBe("s-mine");
    // Encode/decode preserva ACL (sheet:<id> intacto).
    const key = "sheet:s-mine";
    room.apply({ upsert: { [key]: encodeSheet(sheets.get("s-mine")!) } });
    expect(room.getState()[key]).toBeDefined();
  } finally {
    root.remove();
  }
});
