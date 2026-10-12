// Guest sheet visibility filter (pure, hermetic): the host sees every
// key, a guest sees only `sheet:<ownId>` (+ public sheets) while
// tokens/rolls/tiles pass through untouched.
import { expect, test } from "vitest";
import type { RoomState } from "../net/peer";
import { isSheetKey, sheetKey, visibleSheets } from "./visibility";

function makeState(): RoomState {
  return {
    "token:p1": '{"id":"p1"}',
    "sheet:p1": '{"id":"p1","ownerId":"p1"}',
    "sheet:p2": '{"id":"p2","ownerId":"p2"}',
    "sheet:public:shop": '{"id":"shop"}',
    "roll:r1": '{"total":12}',
  };
}

test("sheetKey namespaces sheets like token: and roll: keys", () => {
  expect(sheetKey("p1")).toBe("sheet:p1");
  expect(() => sheetKey("")).toThrow(/missing sheet id/);
  expect(isSheetKey("sheet:p1")).toBe(true);
  expect(isSheetKey("token:p1")).toBe(false);
});

test("host sees the whole snapshot", () => {
  const state = makeState();
  expect(visibleSheets(state, "host", "p1")).toEqual(state);
});

test("guest sees only their own sheet plus public sheets", () => {
  const out = visibleSheets(makeState(), "guest", "p1");
  expect(out).toEqual({
    "token:p1": '{"id":"p1"}',
    "sheet:p1": '{"id":"p1","ownerId":"p1"}',
    "sheet:public:shop": '{"id":"shop"}',
    "roll:r1": '{"total":12}',
  });
});

test("guest with no sheet sees only shared state", () => {
  const out = visibleSheets(makeState(), "guest", "p9");
  expect(out).not.toContain("sheet:p1");
  expect(out["token:p1"]).toBe('{"id":"p1"}');
  expect(out["sheet:public:shop"]).toBe('{"id":"shop"}');
});

test("filter is pure: the input snapshot is never mutated", () => {
  const state = makeState();
  visibleSheets(state, "guest", "p1");
  expect(Object.keys(state)).toHaveLength(5);
});
