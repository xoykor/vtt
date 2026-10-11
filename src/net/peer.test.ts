import { expect, test } from "vitest";
import {
  applyDelta,
  createRoom,
  decodeHandshake,
  encodeHandshake,
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

test("applyDelta is remove-wins on keys present in both upsert and remove", () => {
  const next = applyDelta({ a: "1" }, { upsert: { a: "2" }, remove: ["a"] });
  expect("a" in next).toBe(false);
});

test("joinRoom/parseRoomAddr errors include ip:port and suggest a VPN", () => {
  expect(() => joinRoom("999.999.1.1", 7000)).toThrow(/999\.999\.1\.1/);
  expect(() => joinRoom("999.999.1.1", 7000)).toThrow(/ZeroTier/);
  expect(() => joinRoom("999.999.1.1", 7000)).toThrow(/127|7000|999/);
  expect(() => parseRoomAddr("999.999.1.1:7000")).toThrow(/ZeroTier/);
  expect(() => parseRoomAddr("999.999.1.1:7000")).toThrow(/999\.999\.1\.1/);
  expect(() => parseRoomAddr("not-an-addr")).toThrow(/ZeroTier/);
  expect(() => joinRoom("127.0.0.1", 0)).toThrow(/invalid port/);
  expect(() => joinRoom("127.0.0.1", 0)).toThrow(/ZeroTier/);
});

test("handshake roundtrips room with quotes and backslashes", () => {
  const h = { version: "1.0", room: 'weird "room" \\ name', role: "guest" as const };
  expect(decodeHandshake(encodeHandshake(h))).toEqual(h);
});

test("decodeHandshake rejects malformed, missing field, unknown role", () => {
  expect(() => decodeHandshake("not json")).toThrow();
  expect(() =>
    decodeHandshake('{"version":"1.0","room":"r"}'),
  ).toThrow(/missing field: role/);
  expect(() =>
    decodeHandshake('{"version":"1.0","room":"r","role":"admin"}'),
  ).toThrow(/unknown role/);
  expect(() =>
    decodeHandshake('{"version":"0.9","room":"r","role":"guest"}'),
  ).toThrow(/version mismatch/);
});
