import { expect, test } from "vitest";
import { applyDelta } from "../net/peer";
import { rollRequest } from "../sheet/srd";
import { createDiceScene, frameForResult } from "./scene";
import {
  decodeRollResult,
  encodeRollResult,
  publishRoll,
  resolveRoll,
} from "./roller";

test("host rejects d20 with 21 faces", () => {
  expect(() => resolveRoll({ sides: 21 })).toThrow();
});

test("host resolves a NormalizedRoll from rollRequest", () => {
  const req = rollRequest({ sides: 20 });
  // Hermetic rng: always the lowest face.
  const result = resolveRoll(req, () => 0);
  expect(result).toEqual({ sides: 20, count: 1, mod: 0, rolls: [1], total: 1 });
});

test("host sums dice plus mod with a stub rng", () => {
  const result = resolveRoll({ sides: 6, count: 2, mod: 3 }, () => 0.999);
  expect(result.rolls).toEqual([6, 6]);
  expect(result.total).toBe(15);
  for (const face of result.rolls) {
    expect(face).toBeGreaterThanOrEqual(1);
    expect(face).toBeLessThanOrEqual(6);
  }
});

test("host rejects bad dice fail-closed", () => {
  expect(() => resolveRoll({ sides: 1 })).toThrow(/invalid sides/);
  expect(() => resolveRoll({ sides: 1.5 })).toThrow(/invalid sides/);
  expect(() => resolveRoll({ sides: 101 })).toThrow(/invalid sides/);
  expect(() => resolveRoll({ sides: 6, count: 0 })).toThrow(/invalid count/);
  // Client asks, host validates: the request is never mutated.
  const req = { sides: 8, count: 2, mod: 1 };
  resolveRoll(req, () => 0);
  expect(req).toEqual({ sides: 8, count: 2, mod: 1 });
});

test("host diffuses the result to everyone via applyDelta", () => {
  const result = resolveRoll({ sides: 8 }, () => 0);
  const delta = publishRoll(result, "r1");
  const state = applyDelta({}, delta);
  expect(decodeRollResult(state["roll:r1"])).toEqual(result);
  expect(encodeRollResult(result)).toContain('"total":1');
});

test("decodeRollResult validates length, faces and total", () => {
  const good = resolveRoll({ sides: 6, count: 2, mod: 3 }, () => 0);
  expect(decodeRollResult(encodeRollResult(good))).toEqual(good);
  const short = { ...good, rolls: [1] };
  expect(() => decodeRollResult(JSON.stringify(short))).toThrow(
    /invalid rolls/,
  );
  const badFace = { ...good, rolls: [1, 7] };
  expect(() => decodeRollResult(JSON.stringify(badFace))).toThrow(
    /invalid face/,
  );
  const zeroFace = { ...good, rolls: [1, 0] };
  expect(() => decodeRollResult(JSON.stringify(zeroFace))).toThrow(
    /invalid face/,
  );
  const badTotal = { ...good, total: good.total + 1 };
  expect(() => decodeRollResult(JSON.stringify(badTotal))).toThrow(
    /invalid total/,
  );
});

test("scene only renders the host-resolved result", () => {
  const result = resolveRoll({ sides: 6, count: 2 }, () => 0);
  const frame = frameForResult(result);
  expect(frame.faces.map((f) => f.label)).toEqual(["d6:1", "d6:1"]);
  expect(frame.total).toBe(result.total);
  const scene = createDiceScene();
  expect(scene.last()).toBeUndefined();
  expect(scene.show(result)).toEqual(frame);
  expect(scene.last()).toEqual(frame);
  expect(() =>
    frameForResult({ sides: 6, count: 1, mod: 0, rolls: [7], total: 7 }),
  ).toThrow(/invalid face/);
});
