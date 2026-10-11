import { expect, test } from "vitest";
import {
  applyDelta,
  createRoom,
  joinRoom,
  parseRoomAddr,
} from "./peer";

test("rejects bad ip", () => {
  expect(() => parseRoomAddr("999.999.1.1:7000")).toThrow();
});

test("parses valid addr", () => {
  expect(parseRoomAddr("127.0.0.1:7000")).toEqual({
    ip: "127.0.0.1",
    port: 7000,
  });
});

test("createRoom uses given port", () => {
  const info = createRoom(7000);
  expect(info.port).toBe(7000);
  expect(info.version).toBe("1.0");
  expect(info.room.length).toBeGreaterThan(0);
});

test("joinRoom rejects bad ip", () => {
  expect(() => joinRoom("999.999.1.1", 7000)).toThrow();
});

test("applyDelta upserts and removes without mutating input", () => {
  const state = { a: "1", b: "2" };
  const next = applyDelta(state, {
    upsert: { b: "3" },
    remove: ["a"],
  });
  expect(next).toEqual({ b: "3" });
  expect(state).toEqual({ a: "1", b: "2" });
});
