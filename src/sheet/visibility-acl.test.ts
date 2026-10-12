// TDD: visibilidade ACL sobre snapshot (GM=todas; player=próprias+compartilhadas).
import { expect, test } from "vitest";
import type { RoomState } from "../net/peer";
import { decodeSheet, encodeSheet } from "./srd";
import { visibleSheets } from "./visibility";

function sheetState(): RoomState {
  return {
    "token:t1": JSON.stringify({ id: "t1", pos: { x: 0, y: 0 }, hp: 10 }),
    "sheet:mine": encodeSheet({
      id: "mine",
      name: "Minha",
      ac: 15,
      hp: 20,
      maxHp: 24,
      controllers: ["peer-b"],
    }),
    "sheet:other": encodeSheet({
      id: "other",
      name: "Alheia",
      ac: 14,
      hp: 18,
      maxHp: 22,
      controllers: ["peer-a"],
    }),
    "sheet:shared": encodeSheet({
      id: "shared",
      name: "Compartilhada",
      ac: 12,
      hp: 10,
      maxHp: 12,
      controllers: ["peer-a"],
      viewers: ["peer-b"],
      backstory: "Bio visível",
      photo: "data:image/png;base64,AAA",
    }),
    "sheet:open": encodeSheet({
      id: "open",
      name: "Taverna",
      ac: 10,
      hp: 5,
      maxHp: 5,
      publicView: true,
    }),
    "sheet:secret": encodeSheet({
      id: "secret",
      name: "Segredo",
      ac: 18,
      hp: 40,
      maxHp: 40,
      controllers: ["peer-a"],
      gmNotes: "Fraqueza secreta",
    }),
    "roll:r1": '{"total":12}',
  };
}

test("GM vê todas as fichas (visibleSheets p/ GM = todas)", () => {
  const out = visibleSheets(sheetState(), "host", "gm-1");
  expect(out["sheet:mine"]).toBeDefined();
  expect(out["sheet:other"]).toBeDefined();
  expect(out["sheet:secret"]).toBeDefined();
  // GM recebe gmNotes.
  expect(decodeSheet(out["sheet:secret"]).gmNotes).toBe("Fraqueza secreta");
});

test("guest não vê ficha alheia", () => {
  const out = visibleSheets(sheetState(), "guest", "peer-b");
  expect(out["sheet:other"]).toBeUndefined();
  expect(out["sheet:secret"]).toBeUndefined();
});

test("player vê próprias + compartilhadas (viewers=metadados, controllers=completa)", () => {
  const out = visibleSheets(sheetState(), "guest", "peer-b");
  // Própria: completa (sem gmNotes quando não-GM).
  expect(decodeSheet(out["sheet:mine"]).ac).toBe(15);
  // Compartilhada como viewer: metadados (nome/bio) sem stats reais.
  const shared = decodeSheet(out["sheet:shared"]);
  expect(shared.name).toBe("Compartilhada");
  expect(shared.ac).not.toBe(12);
  // Pública: visível a todos.
  expect(out["sheet:open"]).toBeDefined();
  // Não-fichas passam intactas.
  expect(out["token:t1"]).toBeDefined();
  expect(out["roll:r1"]).toBeDefined();
});

test("gmNotes nunca chega a não-GM mesmo quando controlador", () => {
  const state: RoomState = {
    "sheet:s1": encodeSheet({
      id: "s1",
      name: "S1",
      ac: 15,
      hp: 20,
      maxHp: 24,
      controllers: ["peer-b"],
      gmNotes: "segredo",
    }),
  };
  const out = visibleSheets(state, "guest", "peer-b");
  expect(decodeSheet(out["sheet:s1"]).gmNotes).toBeUndefined();
});
