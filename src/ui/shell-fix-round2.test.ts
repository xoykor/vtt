// @vitest-environment jsdom
// Regressão fix round 2: sync public stale + controller recebe projeção.
// Falham antes do fix, passam depois.
import { expect, test, vi } from "vitest";

vi.mock("./sheet-panel", () => ({
  renderSheetPanel: vi.fn((container: HTMLElement) => {
    container.innerHTML = "<div class='stub-panel'></div>";
  }),
}));

import { encodeSheet } from "../sheet/srd";
import type { Sheet } from "../sheet/types";
import { syncSheetsFromRoom } from "../app";
import { createGrid } from "../map/grid";
import { createOfflineRoom } from "./room";
import { createAppShell, type Session } from "./app-shell";
import { renderSheetPanel } from "./sheet-panel";

function v1(): Sheet {
  return { id: "foo", name: "Foo v1", ac: 10, hp: 5, maxHp: 5 };
}

// Item 1 — mapa local stale não bloqueia o valor público do snapshot.
test("regressão: room só com public v2 atualiza mapa local com v1", () => {
  const room = createOfflineRoom([]);
  room.apply({
    upsert: {
      "sheet:public:foo": encodeSheet({
        id: "foo",
        name: "Foo v2",
        ac: 11,
        hp: 6,
        maxHp: 6,
      }),
    },
  });
  const sheets = new Map<string, Sheet>([["foo", v1()]]);
  syncSheetsFromRoom(room, sheets);
  expect(sheets.get("foo")?.name).toBe("Foo v2");
});

// Item 2 — branch controller renderiza a projeção (sem gmNotes p/ não-GM).
test("regressão: controller não-GM com gmNotes local não recebe gmNotes", () => {
  const room = createOfflineRoom([]);
  const grid = createGrid(10, 8);
  const sheet: Sheet = {
    id: "s1",
    name: "Controlada",
    ac: 15,
    hp: 20,
    maxHp: 24,
    controllers: ["peer-b"],
    gmNotes: "segredo",
  };
  const sheets = new Map<string, Sheet>([["s1", sheet]]);
  const session: Session = {
    backend: null,
    guest: true,
    rollSeq: 0,
    userId: "peer-b",
    peerId: "peer-b",
    displayName: "Borin",
    isGM: false,
    character: "s1",
    peers: [{ peerId: "peer-b", displayName: "Borin", isGM: false }],
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    createAppShell({ root, room, grid, sheets, session }).show();
    const calls = vi.mocked(renderSheetPanel).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const shown = calls[0][1] as Sheet;
    expect(shown.ac).toBe(15);
    expect(shown.gmNotes).toBeUndefined();
  } finally {
    root.remove();
    vi.mocked(renderSheetPanel).mockClear();
  }
});
