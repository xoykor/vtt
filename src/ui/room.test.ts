import { expect, test } from "vitest";
import { createOfflineRoom } from "./room";

test("offline room hosts 6 tokens", () => {
  const room = createOfflineRoom(["dm","p1","p2","p3","p4","p5"]);
  expect(room.tokenCount()).toBe(6);
});
