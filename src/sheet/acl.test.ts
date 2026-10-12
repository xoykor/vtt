// TDD: novo modelo de sessão/fichas (estilo Roll20/Foundry, sem slots).
// Guest não vê ficha alheia; GM vê todas; player cria própria com
// controllers=[self]; ACL escrita por não-GM ignorada; viewers só
// metadados; gmNotes nunca vaza; token herda controle da ficha.
import { expect, test } from "vitest";
import type { Sheet } from "./types";
import {
  canControl,
  canView,
  filterSheetForPeer,
  sanitizeSheetWrite,
  stripGmNotesForPeer,
  toMetadata,
} from "./acl";
import { canControlToken } from "./acl";

function baseSheet(over: Partial<Sheet> = {}): Sheet {
  return {
    id: "s1",
    name: "Borin",
    ac: 15,
    hp: 20,
    maxHp: 24,
    ...over,
  };
}

test("guest não vê ficha alheia", () => {
  const sheet = baseSheet({ controllers: ["peer-a"], viewers: [] });
  expect(canView(sheet, "peer-b", false)).toBe(false);
  expect(canControl(sheet, "peer-b", false)).toBe(false);
  expect(filterSheetForPeer(sheet, "peer-b", false)).toBeNull();
});

test("GM vê todas (bypass)", () => {
  const sheet = baseSheet({ controllers: ["peer-a"], viewers: [] });
  expect(canView(sheet, "any-peer", true)).toBe(true);
  expect(canControl(sheet, "any-peer", true)).toBe(true);
  const out = filterSheetForPeer(sheet, "any-peer", true);
  expect(out).not.toBeNull();
  expect(out!.id).toBe("s1");
});

test("player cria própria com controllers=[self]", () => {
  const draft = baseSheet({ id: "nova", name: "Nova" });
  const stored = sanitizeSheetWrite(null, draft, {
    peerId: "peer-b",
    isGM: false,
  });
  expect(stored.controllers).toEqual(["peer-b"]);
});

test("ACL escrita por não-GM é ignorada (fail-closed)", () => {
  const prev = baseSheet({
    controllers: ["peer-a"],
    viewers: ["peer-b"],
    publicView: false,
    publicControl: false,
  });
  const attempt = baseSheet({
    controllers: ["peer-b"],
    viewers: [],
    publicView: true,
    publicControl: true,
  });
  const stored = sanitizeSheetWrite(prev, attempt, {
    peerId: "peer-b",
    isGM: false,
  });
  // ACL preservada: não re-compartilha, não se promove.
  expect(stored.controllers).toEqual(["peer-a"]);
  expect(stored.viewers).toEqual(["peer-b"]);
  expect(stored.publicView).toBe(false);
  expect(stored.publicControl).toBe(false);
  // Dados da ficha (nome/hp) passam — só ACL é travada.
  expect(stored.name).toBe(attempt.name);
});

test("GM escreve ACL livremente", () => {
  const prev = baseSheet({ controllers: ["peer-a"] });
  const attempt = baseSheet({
    controllers: ["peer-b"],
    viewers: ["peer-c"],
    publicView: true,
  });
  const stored = sanitizeSheetWrite(prev, attempt, {
    peerId: "gm-1",
    isGM: true,
  });
  expect(stored.controllers).toEqual(["peer-b"]);
  expect(stored.viewers).toEqual(["peer-c"]);
  expect(stored.publicView).toBe(true);
});

test("viewers só vêem metadados (nome/avatar/bio)", () => {
  const sheet = baseSheet({
    name: "Borin",
    photo: "data:image/png;base64,AAA",
    race: "Anão",
    backstory: "Veio das montanhas.",
    ac: 15,
    hp: 20,
    viewers: ["peer-b"],
    controllers: ["peer-a"],
  });
  const out = filterSheetForPeer(sheet, "peer-b", false)!;
  expect(out).not.toBeNull();
  expect(out.name).toBe("Borin");
  // Metadados presentes…
  expect(out.photo).toBe("data:image/png;base64,AAA");
  // …mas stats completos não vazam no modo viewer (redacted).
  expect(out.ac).not.toBe(15);
  expect(out.hp).not.toBe(20);
  expect(toMetadata(sheet).name).toBe("Borin");
});

test("controllers vêem ficha completa (sem gmNotes quando não-GM)", () => {
  const sheet = baseSheet({
    ac: 15,
    gmNotes: "Fraqueza secreta",
    controllers: ["peer-b"],
  });
  const out = filterSheetForPeer(sheet, "peer-b", false)!;
  expect(out.ac).toBe(15);
  expect(out.gmNotes).toBeUndefined();
  const gmOut = filterSheetForPeer(sheet, "gm-1", true)!;
  expect(gmOut.gmNotes).toBe("Fraqueza secreta");
});

test("gmNotes nunca sincroniza p/ não-GM (filtrar na ingestão)", () => {
  const sheet = baseSheet({ gmNotes: "segredo", controllers: ["peer-b"] });
  const stripped = stripGmNotesForPeer(sheet, false);
  expect(stripped.gmNotes).toBeUndefined();
  const kept = stripGmNotesForPeer(sheet, true);
  expect(kept.gmNotes).toBe("segredo");
});

test("token herda controle da ficha via represents", () => {
  const sheet = baseSheet({ id: "s1", controllers: ["peer-b"] });
  const byId = new Map([["s1", sheet]]);
  expect(
    canControlToken({ id: "t1", pos: { x: 0, y: 0 }, hp: 10, represents: "s1" }, byId, "peer-b", false),
  ).toBe(true);
  expect(
    canControlToken({ id: "t1", pos: { x: 0, y: 0 }, hp: 10, represents: "s1" }, byId, "peer-c", false),
  ).toBe(false);
  // GM controla qualquer token.
  expect(
    canControlToken({ id: "t1", pos: { x: 0, y: 0 }, hp: 10, represents: "s1" }, byId, "gm-1", true),
  ).toBe(true);
  // Token sem ficha vinculada: só GM.
  expect(
    canControlToken({ id: "t2", pos: { x: 0, y: 0 }, hp: 10, represents: null }, byId, "peer-b", false),
  ).toBe(false);
});
