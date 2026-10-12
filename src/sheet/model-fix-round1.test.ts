// Regressão fix round 1 (puro): Critical 1/2 + Important 3.
// Cada teste falha antes do fix e passa depois.
import { expect, test } from "vitest";
import { sanitizeSheetWrite } from "./acl";
import type { Sheet } from "./types";
import { visibleSheets } from "./visibility";
import { encodeSheet } from "./srd";

function base(over: Partial<Sheet> = {}): Sheet {
  return { id: "s1", name: "S1", ac: 15, hp: 20, maxHp: 24, ...over };
}

// Critical 1 — ownerId travado p/ não-GM (caminho legado canView/canControl).
test("regressão: edição não-GM não pode sequestrar ownerId", () => {
  const prev = base({ ownerId: "peer-a", controllers: ["peer-a"] });
  const attempt = base({ ownerId: "peer-b", controllers: ["peer-b"] });
  const stored = sanitizeSheetWrite(prev, attempt, { peerId: "peer-b", isGM: false });
  expect(stored.ownerId).toBe("peer-a");
});

test("regressão: criação não-GM força ownerId=author", () => {
  const draft = base({ ownerId: "victim" });
  const stored = sanitizeSheetWrite(null, draft, { peerId: "peer-b", isGM: false });
  expect(stored.ownerId).toBe("peer-b");
});

// Critical 2 — fallback de decode ilegível não vaza gmNotes (fail-closed).
test("regressão: ficha ilegível própria não vaza gmNotes p/ guest", () => {
  const badOwn = JSON.stringify({ id: "x", ownerId: "peer-b", gmNotes: "segredo" });
  const out = visibleSheets({ "sheet:peer-b": badOwn }, "guest", "peer-b");
  const val = out["sheet:peer-b"];
  if (val !== undefined) expect(val).not.toContain("segredo");
});

test("regressão: pública legada ilegível não vaza gmNotes p/ guest", () => {
  const badPub = JSON.stringify({ id: "shop", gmNotes: "segredo" });
  const out = visibleSheets({ "sheet:public:shop": badPub }, "guest", "peer-b");
  const val = out["sheet:public:shop"];
  if (val !== undefined) expect(val).not.toContain("segredo");
});

// Important 3 — verbatim não confia no decode p/ gmNotes:null/number.
test("regressão: gmNotes:null no wire não passa verbatim p/ guest", () => {
  const sheet = base({ controllers: ["peer-b"] });
  const wire = JSON.stringify({ ...JSON.parse(encodeSheet(sheet)), gmNotes: null });
  const out = visibleSheets({ "sheet:s1": wire }, "guest", "peer-b");
  expect(out["sheet:s1"]).toBeDefined();
  expect(out["sheet:s1"]).not.toContain("gmNotes");
});

test("regressão: gmNotes:number no wire não passa verbatim p/ guest", () => {
  const sheet = base({ controllers: ["peer-b"] });
  const wire = JSON.stringify({ ...JSON.parse(encodeSheet(sheet)), gmNotes: 123 });
  const out = visibleSheets({ "sheet:s1": wire }, "guest", "peer-b");
  expect(out["sheet:s1"]).toBeDefined();
  expect(out["sheet:s1"]).not.toContain("gmNotes");
});
