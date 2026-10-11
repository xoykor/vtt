import { expect, test } from "vitest";
import { publishRoll, resolveRoll } from "../dice/roller";
import { createOfflineRoom } from "./room";

test("offline room hosts 6 tokens", () => {
  const room = createOfflineRoom(["dm","p1","p2","p3","p4","p5"]);
  expect(room.tokenCount()).toBe(6);
});

test("rolls do not pollute token state", () => {
  const room = createOfflineRoom(["dm","p1","p2","p3","p4","p5"]);
  room.apply(publishRoll(resolveRoll({ sides: 20 }, () => 0.5), "r1"));
  room.apply(publishRoll(resolveRoll({ sides: 6 }, () => 0.1), "r2"));
  expect(room.tokenCount()).toBe(6);
  expect(room.tokens().map((t) => t.id).sort()).toEqual(
    ["dm", "p1", "p2", "p3", "p4", "p5"],
  );
  expect(room.moveToken("p1", { x: 3, y: 4 })).toBe(true);
  expect(room.tokens().find((t) => t.id === "p1")?.pos).toEqual({
    x: 3,
    y: 4,
  });
  expect(room.tokenCount()).toBe(6);
});
