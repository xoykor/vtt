// Tokens with id, pos, hp (pure, hermetic). Token state travels as
// RoomState (Record<string, string>, one JSON token per key) so deltas
// from moveToken apply directly via applyDelta from src/net/peer.ts.
// Only the host moves tokens: moveToken takes a `role` and any non-host
// role gets `ok: false` (fail-closed), mirroring placeTile in
// src/map/editor.ts.

import type { Delta } from "../net/peer";
import type { Point } from "./grid";

export interface Token {
  id: string;
  pos: Point;
  hp: number;
  /** Ficha representada (`sheetId|null`); controle herdado da ficha. Ausente = legado. */
  represents?: string | null;
}

export type MoveResult =
  | { ok: true; delta: Delta }
  | { ok: false; error: string };

function checkPos(pos: Point): string | null {
  if (pos === null || typeof pos !== "object") return "missing field: pos";
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    return `invalid pos: ${String(pos?.x)},${String(pos?.y)}`;
  }
  return null;
}

export function createToken(
  id: string,
  pos: Point,
  hp: number,
  represents?: string | null,
): Token {
  if (id.length === 0) throw new Error("missing token id");
  const posErr = checkPos(pos);
  if (posErr !== null) throw new Error(posErr);
  if (!Number.isFinite(hp)) throw new Error(`invalid hp: ${hp}`);
  const token: Token = { id, pos: { x: pos.x, y: pos.y }, hp };
  if (represents !== undefined) token.represents = represents;
  return token;
}

export function encodeToken(token: Token): string {
  return JSON.stringify(token);
}

export function decodeToken(json: string): Token {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("missing field: id");
  }
  const pos = raw.pos as Record<string, unknown> | null;
  if (
    typeof pos !== "object" ||
    pos === null ||
    typeof pos.x !== "number" ||
    typeof pos.y !== "number"
  ) {
    throw new Error("missing field: pos");
  }
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    throw new Error(`invalid pos: ${String(pos.x)},${String(pos.y)}`);
  }
  if (typeof raw.hp !== "number") throw new Error("missing field: hp");
  const token: Token = { id: raw.id, pos: { x: pos.x, y: pos.y }, hp: raw.hp };
  // `represents` tolerante: ausente = legado; null/string válidos.
  if (raw.represents === null) token.represents = null;
  else if (typeof raw.represents === "string") token.represents = raw.represents;
  return token;
}

/**
 * Move token `id` to `pos`, returning the delta to broadcast over
 * ordered TCP (host-authoritative). Pure: `state` is not mutated.
 * Only the `host` role writes; every other role (e.g. `player`) is
 * denied with `ok: false` (fail-closed, same semantics as placeTile).
 * Unknown tokens and non-finite positions also return `ok: false`
 * instead of throwing.
 */
export function moveToken(
  state: Record<string, string>,
  id: string,
  pos: Point,
  role: string,
): MoveResult {
  if (role !== "host") {
    return { ok: false, error: `forbidden role: ${role}` };
  }
  const posErr = checkPos(pos);
  if (posErr !== null) return { ok: false, error: posErr };
  const raw = state[id];
  if (raw === undefined) return { ok: false, error: `unknown token: ${id}` };
  let token: Token;
  try {
    token = decodeToken(raw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "bad token" };
  }
  const next: Token = { ...token, id, pos: { x: pos.x, y: pos.y } };
  return { ok: true, delta: { upsert: { [id]: encodeToken(next) } } };
}
