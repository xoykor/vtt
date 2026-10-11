// Tokens with id, pos, hp (pure, hermetic). Token state travels as
// RoomState (Record<string, string>, one JSON token per key) so deltas
// from moveToken apply directly via applyDelta from src/net/peer.ts.

import type { Delta } from "../net/peer";
import type { Point } from "./grid";

export interface Token {
  id: string;
  pos: Point;
  hp: number;
}

export function createToken(id: string, pos: Point, hp: number): Token {
  if (id.length === 0) throw new Error("missing token id");
  if (!Number.isFinite(hp)) throw new Error(`invalid hp: ${hp}`);
  return { id, pos: { x: pos.x, y: pos.y }, hp };
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
  if (typeof raw.hp !== "number") throw new Error("missing field: hp");
  return { id: raw.id, pos: { x: pos.x, y: pos.y }, hp: raw.hp };
}

/**
 * Move token `id` to `pos`, returning the delta to broadcast over
 * ordered TCP (host-authoritative). Pure: `state` is not mutated.
 * Throws on unknown token.
 */
export function moveToken(
  state: Record<string, string>,
  id: string,
  pos: Point,
): Delta {
  const raw = state[id];
  if (raw === undefined) throw new Error(`unknown token: ${id}`);
  const token = decodeToken(raw);
  const next: Token = { ...token, id, pos: { x: pos.x, y: pos.y } };
  return { upsert: { [id]: encodeToken(next) } };
}
