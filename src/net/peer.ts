// P2P room protocol (transport-free): address parsing, room/peer
// descriptors and pure state deltas. Mirrors src-tauri/src/net/ for
// Tasks 3-6. No sockets here: critical state travels over ordered TCP,
// cursor/light updates over UDP; the host is authoritative.

export const PROTOCOL_VERSION = "1.0";

/** mDNS service type announced by hosts. */
export const MDNS_SERVICE = "_vtt._tcp";

export type Role = "host" | "guest";

/** Handshake payload: JSON with `version`, `room`, `role`. */
export interface Handshake {
  version: string;
  room: string;
  role: Role;
}

/** Ordered TCP carries state; UDP carries cursor/light. */
export type Channel = "tcp-state" | "udp-cursor";

export function channelTransport(channel: Channel): "tcp" | "udp" {
  return channel === "tcp-state" ? "tcp" : "udp";
}

/** Accept only when the peer speaks the expected version. */
export function handshake(peerVersion: string, expected: string): void {
  if (peerVersion !== expected) {
    throw new Error(
      `version mismatch: peer=${peerVersion} expected=${expected}`,
    );
  }
}

export function encodeHandshake(h: Handshake): string {
  return JSON.stringify({
    version: h.version,
    room: h.room,
    role: h.role,
  });
}

/** Parse and version-check a handshake from its JSON wire form. */
export function decodeHandshake(json: string): Handshake {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("malformed handshake json");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("malformed handshake json");
  }
  const { version, room, role } = raw as Record<string, unknown>;
  if (typeof version !== "string") throw new Error("missing field: version");
  handshake(version, PROTOCOL_VERSION);
  if (typeof room !== "string" || room.length === 0) {
    throw new Error("missing field: room");
  }
  if (role !== "host" && role !== "guest") {
    throw new Error(`unknown role: ${String(role)}`);
  }
  return { version, room, role };
}

export interface RoomAddr {
  ip: string;
  port: number;
}

function checkIp(ip: string): void {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`invalid ip: ${ip}`);
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`invalid ip: ${ip}`);
    if (part.length > 1 && part.startsWith("0")) {
      throw new Error(`invalid ip: ${ip}`);
    }
    const n = Number(part);
    if (n < 0 || n > 255) throw new Error(`invalid ip: ${ip}`);
  }
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
}

/** Parse `ip:port` into a validated room address. */
export function parseRoomAddr(addr: string): RoomAddr {
  const sep = addr.lastIndexOf(":");
  if (sep <= 0 || sep === addr.length - 1) {
    throw new Error(`invalid room addr: ${addr}`);
  }
  const ip = addr.slice(0, sep);
  const port = Number(addr.slice(sep + 1));
  checkIp(ip);
  checkPort(port);
  return { ip, port };
}

export interface RoomInfo {
  room: string;
  port: number;
  version: string;
}

export interface Peer {
  ip: string;
  port: number;
  role: Role;
}

/** Host a room on `port`; deterministic id keeps tests hermetic. */
export function createRoom(port: number): RoomInfo {
  checkPort(port);
  return { room: `room-${port}`, port, version: PROTOCOL_VERSION };
}

/** Join the room hosted at `ip:port` as guest. */
export function joinRoom(ip: string, port: number): Peer {
  checkIp(ip);
  checkPort(port);
  return { ip, port, role: "guest" };
}

export type RoomState = Record<string, string>;

export interface Delta {
  upsert?: Record<string, string>;
  remove?: string[];
}

/** Pure state transition: returns the state with `delta` applied. */
export function applyDelta(state: RoomState, delta: Delta): RoomState {
  const next: RoomState = { ...state };
  if (delta.upsert) {
    for (const [key, value] of Object.entries(delta.upsert)) {
      next[key] = value;
    }
  }
  if (delta.remove) {
    for (const key of delta.remove) {
      delete next[key];
    }
  }
  return next;
}
