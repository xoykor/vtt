// @vitest-environment jsdom
// Regressão fix round 1 (UI): Important 1/2/4.
import { expect, test } from "vitest";
import { createGrid } from "../map/grid";
import type { Sheet } from "../sheet/types";
import { createOfflineRoom } from "./room";
import {
  createAppShell,
  visibleSheetsForSession,
  type Session,
} from "./app-shell";
import { syncSheetsFromRoom } from "../app";

function sessionFor(peerId: string, isGM: boolean): Session {
  return {
    backend: null,
    guest: !isGM,
    rollSeq: 0,
    userId: peerId,
    peerId,
    displayName: peerId,
    isGM,
    character: null,
    peers: [{ peerId, displayName: peerId, isGM }],
  };
}

function viewerSheet(): Sheet {
  return {
    id: "s-shared",
    name: "Compartilhada",
    ac: 15,
    hp: 20,
    maxHp: 24,
    controllers: ["peer-a"],
    viewers: ["peer-b"],
    backstory: "Bio visível",
    attacks: [{ id: "a1", name: "Machado Élfico", bonus: 5, damage: "1d8+3" }],
  };
}

// Important 1 — visibleSheetsForSession projeta viewer p/ metadados.
test("regressão: viewer recebe metadados, não stats completos", () => {
  const sheets = new Map([["s-shared", viewerSheet()]]);
  const out = visibleSheetsForSession(sheets, sessionFor("peer-b", false));
  expect(out).toHaveLength(1);
  expect(out[0].name).toBe("Compartilhada");
  expect(out[0].ac).not.toBe(15);
  expect(out[0].attacks).toBeUndefined();
});

// Important 2 — showSheet renderiza a projeção filtrada (sem stats/ataques).
test("regressão: painel do viewer não mostra ataques/HP reais", () => {
  const room = createOfflineRoom([]);
  const grid = createGrid(10, 8);
  const sheets = new Map([["s-shared", viewerSheet()]]);
  const session = sessionFor("peer-b", false);
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    const shell = createAppShell({ root, room, grid, sheets, session });
    shell.show();
    expect(root.textContent).not.toContain("Machado Élfico");
    expect(root.textContent).not.toContain("20/24");
  } finally {
    root.remove();
  }
});

// Important 4 — syncSheetsFromRoom não cria id "public:foo".
test("regressão: sheet:public:foo não vira id public:foo no Map", () => {
  const room = createOfflineRoom([]);
  const sheets = new Map<string, Sheet>();
  room.apply({
    upsert: {
      "sheet:public:foo": JSON.stringify({
        id: "foo",
        name: "Foo",
        ac: 10,
        hp: 5,
        maxHp: 5,
      }),
    },
  });
  syncSheetsFromRoom(room, sheets);
  expect(sheets.has("public:foo")).toBe(false);
});
