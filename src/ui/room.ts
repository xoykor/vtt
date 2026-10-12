// Offline room (simulated local host, no network). Backed by the ready
// P2P primitives: tokens travel as RoomState JSON values and every
// mutation applies via applyDelta, the same ordered-TCP path the real
// host broadcasts on. Remote join (joinRoom) is intentionally unused
// here: there are no peers offline, only the simulated host.
// No central server; no WotC art.

import {
  applyDelta,
  createRoom,
  parseRoomAddr,
  PROTOCOL_VERSION,
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

/** Tauri invoke bridge: `invoke(cmd, args)` exposed via `window.__TAURI__`. */
export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const VPN_HINT =
  "if peers cannot connect over the internet, host via a ZeroTier/Radmin/Hamachi VPN and share that IP";

/**
 * Join a room through the Tauri invoke bridge (Task 4, consumes the T2
 * invoke handler + the T3 handshake): validates `addr` (`ip:port`) locally,
 * calls `invoke("join_room", { ip, port })` and parses the room-info JSON
 * reply (`{"version","room","port"}`). Failures always surface the addr and
 * the ZeroTier/Radmin/Hamachi VPN hint — same contract as `joinRoom`.
 *
 * NOTE (fix round 1): a guest holds no `HostState` — the backend
 * `join_room` intentionally stores nothing, so `push_delta`/`get_snapshot`
 * stay host-only. The lobby must show {@link guestJoinNotice} after a join
 * and keep Sync/Push disabled on the guest path.
 */
export async function joinVia(
  addr: string,
  invoke: InvokeFn,
): Promise<RoomInfo> {
  const { ip, port } = parseRoomAddr(addr);
  let raw: unknown;
  try {
    raw = await invoke("join_room", { ip, port });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ZeroTier|Radmin|Hamachi/.test(msg)) throw e;
    throw new Error(`${msg} [join ${ip}:${port}] (${VPN_HINT})`);
  }
  if (typeof raw !== "string") {
    throw new Error(
      `malformed room reply [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(
      `malformed room reply [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error(
      `malformed room reply [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  const { version, room, port: replyPort } = doc as Record<string, unknown>;
  if (version !== PROTOCOL_VERSION) {
    throw new Error(
      `version mismatch: peer=${String(version)} expected=${PROTOCOL_VERSION} [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  if (typeof room !== "string" || room.length === 0) {
    throw new Error(
      `malformed room reply [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  if (!Number.isInteger(replyPort) || (replyPort as number) < 1 || (replyPort as number) > 65535) {
    throw new Error(
      `malformed room reply [join ${ip}:${port}] (${VPN_HINT})`,
    );
  }
  return {
    room,
    port: replyPort as number,
    version: PROTOCOL_VERSION,
  };
}

/**
 * Wholesale-replace delta: applying it makes the local state exactly
 * `next` — upserts every snapshot entry and removes local keys missing
 * from it. Used by Sincronizar so host-deleted tokens/keys disappear
 * locally instead of accumulating stale (fix round 1).
 */
export function replaceDelta(local: RoomState, next: RoomState): Delta {
  const keep = new Set(Object.keys(next));
  return {
    upsert: { ...next },
    remove: Object.keys(local).filter((k) => !keep.has(k)),
  };
}

/**
 * Lobby status after a guest join: the guest holds no backend state, so
 * Sync/Push stay disabled — only the host mirrors deltas and snapshots.
 * Hydrating from `join_room` alone is impossible (it returns only the
 * room descriptor, no token state); live guest sync is later-task scope.
 */
export function guestJoinNotice(info: RoomInfo): string {
  return (
    `Na sala ${info.room} como convidado — ` +
    `push/sync desabilitados (só o host sincroniza).`
  );
}
