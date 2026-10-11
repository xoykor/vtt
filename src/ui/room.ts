// Offline room (simulated local host, no network). Backed by the ready
// P2P primitives: tokens travel as RoomState JSON values and every
// mutation applies via applyDelta, the same ordered-TCP path the real
// host broadcasts on. Remote join (joinRoom) is intentionally unused
// here: there are no peers offline, only the simulated host.
// No central server; no WotC art.

import {
  applyDelta,
  createRoom,
  type Delta,
  type RoomInfo,
  type RoomState,
} from "../net/peer";
import {
  createToken,
  decodeToken,
  encodeToken,
  moveToken,
  type Token,
} from "../map/tokens";
import type { Point } from "../map/grid";

export interface OfflineRoom {
  /** Deterministic host descriptor (room-5199, v1.0). */
  info: RoomInfo;
  /** Number of tokens currently hosted. */
  tokenCount(): number;
  /** All hosted tokens, decoded. */
  tokens(): Token[];
  /** Copy of the underlying RoomState partition. */
  getState(): RoomState;
  /** Apply a delta (sheet/roll partitions included) via applyDelta. */
  apply(delta: Delta): void;
  /** Host-authoritative move; false when unknown/forbidden/invalid. */
  moveToken(id: string, pos: Point): boolean;
}

/**
 * Canonical key for a hosted token: `token:<id>`. Tokens live in their
 * own partition of the flat RoomState so roll/sheet deltas (`roll:*`,
 * sheet keys) applied via `apply()` never pollute `tokenCount()` /
 * `tokens()` — same namespacing convention as `tile:*` and `roll:*`.
 */
export function tokenKey(id: string): string {
  if (id.length === 0) throw new Error("missing token id");
  return `token:${id}`;
}
/**
 * Host `memberIds` locally: one token per member on row 0
 * (`{x: i, y: 0}`, hp 10) under `token:<id>` keys. Pure host
 * simulation; no sockets.
 */
export function createOfflineRoom(memberIds: string[]): OfflineRoom {
  const info = createRoom(5199);
  let state: RoomState = {};
  memberIds.forEach((id, i) => {
    const token = createToken(id, { x: i, y: 0 }, 10);
    state = applyDelta(state, { upsert: { [tokenKey(id)]: encodeToken(token) } });
  });
  return {
    info,
    tokenCount(): number {
      return Object.keys(state).filter((k) => k.startsWith("token:")).length;
    },
    tokens(): Token[] {
      return Object.entries(state)
        .filter(([k]) => k.startsWith("token:"))
        .map(([, json]) => decodeToken(json));
    },
    getState(): RoomState {
      return { ...state };
    },
    apply(delta: Delta): void {
      state = applyDelta(state, delta);
    },
    moveToken(id: string, pos: Point): boolean {
      // The ready moveToken() addresses tokens by bare id within its
      // partition: project the token entry as that view, then remap the
      // returned delta key back to the `token:<id>` partition.
      const key = tokenKey(id);
      const res = moveToken({ [id]: state[key] }, id, pos, "host");
      if (!res.ok) return false;
      const upsert: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.delta.upsert ?? {})) {
        upsert[k === id ? key : k] = v;
      }
      state = applyDelta(state, { ...res.delta, upsert });
      return true;
    },
  };
}
