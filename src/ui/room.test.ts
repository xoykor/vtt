import { expect, test } from "vitest";
import { publishRoll, resolveRoll } from "../dice/roller";
import { createOfflineRoom, joinVia } from "./room";

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

test("join failure surfaces ip and vpn hint", async () => {
  const failingInvoke = async (): Promise<unknown> => {
    throw new Error(
      "invoke join_room failed for 999.999.1.1:7000 (ZeroTier/Radmin/Hamachi VPN)",
    );
  };
  await expect(joinVia("999.999.1.1:7000", failingInvoke)).rejects.toThrow(
    /ZeroTier/,
  );
});

test("joinVia returns room info on invoke success", async () => {
  const okInvoke = async (): Promise<unknown> =>
    '{"version":"1.0","room":"room-7000","port":7000}';
  await expect(joinVia("127.0.0.1:7000", okInvoke)).resolves.toEqual({
    room: "room-7000",
    port: 7000,
    version: "1.0",
  });
});

test("joinVia surfaces ip and vpn hint when invoke rejects", async () => {
  const refusedInvoke = async (): Promise<unknown> => {
    throw new Error("tcp connect failed");
  };
  let err: Error | null = null;
  try {
    await joinVia("127.0.0.1:7000", refusedInvoke);
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect(err?.message).toMatch(/127\.0\.0\.1/);
  expect(err?.message).toMatch(/7000/);
  expect(err?.message).toMatch(/ZeroTier/);
});
