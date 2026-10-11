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
 * Host `memberIds` locally: one token per member on row 0
 * (`{x: i, y: 0}`, hp 10). Pure host simulation; no sockets.
 */
export function createOfflineRoom(memberIds: string[]): OfflineRoom {
  const info = createRoom(5199);
  let state: RoomState = {};
  memberIds.forEach((id, i) => {
    const token = createToken(id, { x: i, y: 0 }, 10);
    state = applyDelta(state, { upsert: { [id]: encodeToken(token) } });
  });
  return {
    info,
    tokenCount(): number {
      return Object.keys(state).length;
    },
    tokens(): Token[] {
      return Object.values(state).map((json) => decodeToken(json));
    },
    getState(): RoomState {
      return { ...state };
    },
    apply(delta: Delta): void {
      state = applyDelta(state, delta);
    },
    moveToken(id: string, pos: Point): boolean {
      const res = moveToken(state, id, pos, "host");
      if (!res.ok) return false;
      state = applyDelta(state, res.delta);
      return true;
    },
  };
}
