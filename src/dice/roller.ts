// Host-resolved dice (pure, hermetic). The client asks with a `Roll`
// (`sides`, optional `count`/`mod`, same shape Task 5 normalizes via
// `rollRequest`); only the host calls `resolveRoll`, validates the
// request and broadcasts the `RollResult` to everyone as a Delta that
// applies via `applyDelta` from src/net/peer.ts (ordered TCP,
// host-authoritative, global constraint). Three.js never rolls: it
// only renders the resolved result (see src/dice/scene.ts), so no
// physics engine and no new dependency here.

import type { Delta } from "../net/peer";
import type { Roll } from "../sheet/types";

/** Host-resolved roll: per-die faces plus the `sum + mod` total. */
export interface RollResult {
  sides: number;
  count: number;
  mod: number;
  rolls: number[];
  total: number;
}

/**
 * Injectable entropy so tests stay hermetic: returns a float in
 * [0, 1). Defaults to `Math.random` on the host.
 */
export type RngLike = () => number;

/**
 * Standard tabletop dice the host accepts: d2-d20 plus the percentile
 * d100. Anything else (e.g. 21 faces: a d20 has exactly 20) matches no
 * physical die and is rejected, even though client-side `rollRequest`
 * only enforces `sides >= 2`.
 */
const MAX_NOVELTY_SIDES = 20;
const PERCENTILE_SIDES = 100;

/** Cap per request so one client cannot force a huge allocation. */
export const MAX_DICE_COUNT = 100;

function checkSides(sides: number): void {
  if (
    !Number.isInteger(sides) ||
    sides < 2 ||
    (sides > MAX_NOVELTY_SIDES && sides !== PERCENTILE_SIDES)
  ) {
    throw new Error(`invalid sides: ${String(sides)}`);
  }
}

/**
 * Resolve `req` on the host: validate (bad dice throw, fail-closed)
 * and roll every die with `rng`. Pure except for `rng`; `req` is not
 * mutated. `count` defaults to 1, `mod` defaults to 0, mirroring
 * `rollRequest` from src/sheet/srd.ts.
 */
export function resolveRoll(req: Roll, rng: RngLike = Math.random): RollResult {
  if (req === null || typeof req !== "object") {
    throw new Error("missing dice");
  }
  checkSides(req.sides);
  const count = req.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    throw new Error(`invalid count: ${String(req.count)}`);
  }
  const mod = req.mod ?? 0;
  if (typeof mod !== "number" || !Number.isFinite(mod)) {
    throw new Error(`invalid mod: ${String(req.mod)}`);
  }
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng();
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r >= 1) {
      throw new Error(`invalid rng output: ${String(r)}`);
    }
    // Clamp guards an rng returning exactly 1 - epsilon rounding.
    rolls.push(Math.min(req.sides, Math.floor(r * req.sides) + 1));
  }
  const total = rolls.reduce((sum, face) => sum + face, 0) + mod;
  return { sides: req.sides, count, mod, rolls, total };
}

/** Encode a result as one JSON value for a RoomState partition. */
export function encodeRollResult(result: RollResult): string {
  return JSON.stringify(result);
}

/** Decode a result from its RoomState JSON value. Validates `rolls.length === count`, faces in `[1,sides]` and `total === sum + mod`. */
export function decodeRollResult(json: string): RollResult {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.sides !== "number" || !Number.isInteger(raw.sides)) {
    throw new Error("missing field: sides");
  }
  if (typeof raw.count !== "number" || !Number.isInteger(raw.count)) {
    throw new Error("missing field: count");
  }
  if (typeof raw.mod !== "number" || !Number.isFinite(raw.mod)) {
    throw new Error("missing field: mod");
  }
  if (!Array.isArray(raw.rolls)) throw new Error("missing field: rolls");
  if (typeof raw.total !== "number" || !Number.isFinite(raw.total)) {
    throw new Error("missing field: total");
  }
  const { sides, count, mod, rolls, total } = raw as unknown as RollResult;
  if (rolls.length !== count) {
    throw new Error(`invalid rolls: length ${rolls.length} expected ${count}`);
  }
  let sum = 0;
  for (const face of rolls) {
    if (!Number.isInteger(face) || face < 1 || face > sides) {
      throw new Error(`invalid face: ${String(face)} not in [1,${sides}]`);
    }
    sum += face;
  }
  if (total !== sum + mod) {
    throw new Error(`invalid total: ${total} expected ${sum + mod}`);
  }
  return { sides, count, mod, rolls: [...rolls], total };
}

/** Canonical key for a broadcast result: `roll:<id>`. */
export function rollResultKey(id: string): string {
  if (id.length === 0) throw new Error("missing roll id");
  return `roll:${id}`;
}

/**
 * Pack a host-resolved `result` as the Delta to diffuse to every peer.
 * Pure: applies via `applyDelta` on ordered TCP. `id` must be unique
 * per roll (e.g. `crypto.randomUUID()` on the host).
 */
export function publishRoll(result: RollResult, id: string): Delta {
  return { upsert: { [rollResultKey(id)]: encodeRollResult(result) } };
}
