// Task 6 E2E: real loopback LAN — host listener + guest dialer
// exchanging snapshot + delta over REAL TCP (127.0.0.1:0).
//
// PROTOCOL-CONFORMANCE TEST (NOT Rust binary interop):
// This spec validates the TypeScript codecs (encodeHandshake/
// decodeHandshake, handshake version gate, applyDelta, moveToken,
// decodeToken) against the wire protocol specification — u32-BE
// length-prefixed frames carrying JSON — independent of the Rust
// serve_once/connect_handshake implementation. The host here is a
// Node net.Server that re-implements the wire protocol in-process;
// it does NOT exercise the Rust binary's TCP path.
//
// True Rust↔Rust loopback interop is covered by tcp_test.rs
// (src-tauri/src/net/tcp_test.rs). True Rust↔TS interop would
// require a dedicated src-tauri/src/bin/ entry point exposing
// the native socket path to the TS layer — future work.
//
// Unlike e2e/room.spec.ts (transport-free, pure functions), this
// spec opens real OS sockets in-process: the host is a genuine
// net.Server bound to an ephemeral loopback port and the guest is
// a genuine net.Socket dialing it. Both ends speak the production
// wire protocol from src-tauri/src/net/tcp.rs — u32-BE
// length-prefixed frames carrying JSON (handshake, room reply,
// snapshot, delta) — and every payload goes through the
// production TS codecs (encodeHandshake/decodeHandshake,
// handshake version gate, applyDelta, moveToken, decodeToken).
//
// Flow (mirrors tcp.rs serve_once/connect_with_handshake):
//   1. Guest dials 127.0.0.1:<port> and sends one handshake
//      frame {"version":"1.0","room":"room-<port>","role":"guest"}.
//   2. Host version-gates it with decodeHandshake (stale
//      versions are rejected fail-closed: connection closed with
//      NO error frame — EOF IS the rejection signal) and replies
//      with one room frame {"version","room","port"}.
//   3. Host diffuses the full snapshot (export_json shape:
//      {"version","room","state"}) as one frame; the guest
//      restores it wholesale via applyDelta (replace, never
//      merge — rejoin never duplicates tokens).
//   4. Host broadcasts deltas ({"upsert":{...},"remove":[...]})
//      until it ends the stream; the guest applies each via
//      applyDelta (remove-wins).
//
// Smoke path (local sandbox): Playwright 1.64 with chromium in
// ~/.cache/ms-playwright — this spec needs no browser at all
// (pure Node TCP), so it runs fully offline; the browser install
// in CI covers room.spec.ts's future page tests.
import { expect, test } from "@playwright/test";
import net from "node:net";
import {
  applyDelta,
  decodeHandshake,
  encodeHandshake,
  handshake,
  PROTOCOL_VERSION,
  type Delta,
  type Handshake,
  type RoomState,
} from "../src/net/peer";
import {
  createToken,
  decodeToken,
  encodeToken,
  moveToken,
  type Token,
} from "../src/map/tokens";

const HOST_IP = "127.0.0.1";
const READ_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const EOF = /tcp read failed|EOF|closed/i;

/** One wire frame: u32 big-endian length + UTF-8 payload —
 *  byte-identical to Rust `send_frame` (src-tauri/src/net/tcp.rs). */
function frame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(
      `frame too large: ${body.length} bytes (max ${MAX_FRAME_BYTES})`,
    );
  }
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Buffered reader for length-prefixed frames — the Node mirror
 *  of Rust `recv_frame`. TCP may coalesce back-to-back frames
 *  into one chunk (the host writes reply+snapshot+delta in a
 *  burst), so bytes are buffered and split frame-by-frame. A
 *  socket close with a frame still pending rejects it: EOF on a
 *  pending read is the wire-level rejection/termination signal,
 *  exactly like `tcp read failed` in tcp.rs. */
class FrameReader {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  push(chunk: Buffer): void {
    this.buf =
      this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  end(): void {
    this.closed = true;
    this.failAll(
      new Error("tcp read failed: EOF (peer closed connection)"),
    );
  }

  next(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.reject === reject);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(
            new Error(`tcp read timed out after ${timeoutMs / 1000}s`),
          );
        }
      }, timeoutMs);
      this.waiters.push({
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.drain();
      // Closed with this frame still pending → EOF now (truncated
      // tail or rejection-without-reply).
      if (this.closed && this.waiters.length > 0) this.end();
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        this.failAll(
          new Error(
            `frame too large: ${len} bytes (max ${MAX_FRAME_BYTES})`,
          ),
        );
        return;
      }
      if (this.buf.length < 4 + len) return;
      const text = this.buf.subarray(4, 4 + len).toString("utf-8");
      this.buf = this.buf.subarray(4 + len);
      this.waiters.shift()!.resolve(text);
    }
  }

  private failAll(err: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}

/** Host seeds 6 tokens: 1 mestre + 5 jogadores ("dm" + p1..p5). */
function sixTokenState(): RoomState {
  const ids = ["dm", "p1", "p2", "p3", "p4", "p5"];
  const state: RoomState = {};
  ids.forEach((id, i) => {
    state[id] = encodeToken(createToken(id, { x: i, y: 0 }, 10 + i));
  });
  return state;
}

/** Host-authoritative delta built through the production path:
 *  `moveToken` (host role) moves `dm`, plus a remove of `p5` and
 *  an upsert of `p6` — net count stays 6, so the guest proves
 *  snapshot+delta delivery without duplicating tokens. */
function broadcastDelta(state: RoomState): Delta {
  const moved = moveToken(state, "dm", { x: 99, y: 99 }, "host");
  if (!moved.ok) throw new Error(`host move failed: ${moved.error}`);
  return {
    upsert: {
      ...moved.delta.upsert,
      p6: encodeToken(createToken("p6", { x: 6, y: 0 }, 16)),
    },
    remove: ["p5"],
  };
}

/** Real loopback host: an OS TCP listener on `127.0.0.1:0` that
 *  speaks the production wire protocol (tcp.rs `serve_once` +
 *  `send_snapshot`/`send_delta`). Every inbound handshake is
 *  version-gated by the production `decodeHandshake`; a rejected
 *  handshake closes the connection with NO reply frame (EOF is
 *  the rejection signal), mirroring the Rust failure policy. */
class LoopbackHost {
  private server: net.Server | null = null;
  private state: RoomState = {};
  private deltas: Delta[] = [];

  /** Ephemeral port bound by `start()` (the `:0` in `listen`). */
  port = 0;

  async start(): Promise<void> {
    this.state = sixTokenState();
    this.deltas = [broadcastDelta(this.state)];
    this.server = net.createServer((socket) => {
      void this.serveConnection(socket).catch(() => {
        // Fail-closed: any handshake/parse error closes the
        // connection without a reply frame (EOF = rejection).
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, HOST_IP, () => resolve());
    });
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("unexpected non-TCP listener address");
    }
    this.port = addr.port;
    expect(this.port).toBeGreaterThan(0);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** One connection = one guest session: handshake → room reply →
   *  snapshot → deltas → end of stream. */
  private async serveConnection(socket: net.Socket): Promise<void> {
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => reader.end());
    // 1. Handshake, version-gated by the production codec.
    const hsText = await reader.next(READ_TIMEOUT_MS);
    const hs = decodeHandshake(hsText);
    // 2. Room reply (Rust `encode_room_info` shape).
    socket.write(
      frame(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          room: hs.room,
          port: this.port,
        }),
      ),
    );
    // 3. Full snapshot (Rust `send_snapshot`/`export_json` shape).
    socket.write(
      frame(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          room: hs.room,
          state: this.state,
        }),
      ),
    );
    // 4. Delta burst (Rust `send_delta` shape).
    for (const delta of this.deltas) {
      socket.write(frame(JSON.stringify(delta)));
    }
    socket.end();
  }
}

/** Real loopback guest: dials the host over TCP and runs the
 *  production receive path — `encodeHandshake` out, version gate
 *  on the room reply, wholesale snapshot restore via `applyDelta`
 *  (never merge), then `applyDelta` for every delta frame until
 *  the host ends the stream. */
class LoopbackGuest {
  private state: RoomState = {};
  private info: { room: string; port: number; version: string } | null =
    null;

  async join(host: LoopbackHost): Promise<void> {
    const socket = new net.Socket();
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => reader.end());
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(host.port, HOST_IP, () => resolve());
    });
    try {
      // 1. Handshake as guest for the deterministic room id.
      const hs: Handshake = {
        version: PROTOCOL_VERSION,
        room: `room-${host.port}`,
        role: "guest",
      };
      socket.write(frame(encodeHandshake(hs)));
      // 2. Room reply, version-gated by the production `handshake`.
      const reply = JSON.parse(
        await reader.next(READ_TIMEOUT_MS),
      ) as Record<string, unknown>;
      handshake(String(reply.version), PROTOCOL_VERSION);
      expect(reply.room).toBe(hs.room);
      expect(reply.port).toBe(host.port);
      this.info = {
        room: String(reply.room),
        port: Number(reply.port),
        version: String(reply.version),
      };
      // 3. Snapshot: wholesale restore (replace, never merge),
      //    so a rejoining guest never duplicates tokens.
      const snap = JSON.parse(await reader.next(READ_TIMEOUT_MS)) as {
        version: string;
        room: string;
        state: RoomState;
      };
      expect(snap.version).toBe(PROTOCOL_VERSION);
      expect(snap.room).toBe(hs.room);
      this.state = applyDelta({}, { upsert: snap.state });
      // 4. Deltas until the host ends the stream (EOF terminates
      //    the burst — same loop a live guest runs forever).
      for (;;) {
        let text: string;
        try {
          text = await reader.next(READ_TIMEOUT_MS);
        } catch (e) {
          if (e instanceof Error && EOF.test(e.message)) break;
          throw e;
        }
        this.state = applyDelta(this.state, JSON.parse(text) as Delta);
      }
    } finally {
      socket.destroy();
    }
  }

  /** Number of decodable tokens in the guest's applied state. */
  tokenCount(): number {
    return this.tokenIds().length;
  }

  /** Sorted token ids, each validated through production
   *  `decodeToken` — a duplicate id would survive `applyDelta`
   *  (last-wins) but a corrupted token fails here. */
  tokenIds(): string[] {
    const ids = Object.keys(this.state).sort();
    for (const id of ids) {
      expect(decodeToken(this.state[id]).id).toBe(id);
    }
    return ids;
  }

  token(id: string): Token {
    return decodeToken(this.state[id]);
  }

  get roomInfo(): { room: string; port: number; version: string } {
    if (!this.info) throw new Error("guest has not joined");
    return this.info;
  }
}

let host: LoopbackHost;
let guest: LoopbackGuest;

test.beforeEach(async () => {
  host = new LoopbackHost();
  await host.start();
  guest = new LoopbackGuest();
  await guest.join(host);
});

test.afterEach(async () => {
  await host.stop();
});

test("loopback host serves snapshot to guest", async () => {
  await expect(guest.tokenCount()).toBe(6);
  expect(guest.roomInfo.room).toBe(`room-${host.port}`);
  expect(guest.roomInfo.port).toBe(host.port);
});

test("guest applies tcp delta without dup ids", () => {
  // Snapshot carried dm+p1..p5 (6); the host delta moved dm,
  // removed p5 and added p6 — still exactly 6 unique tokens.
  expect(guest.tokenIds()).toEqual(["dm", "p1", "p2", "p3", "p4", "p6"]);
  expect(guest.token("dm").pos).toEqual({ x: 99, y: 99 });
  expect(guest.token("p6").hp).toBe(16);
});

test("host rejects stale-version handshake over tcp", async () => {
  const stale: Handshake = {
    version: "0.9",
    room: `room-${host.port}`,
    role: "guest",
  };
  const socket = new net.Socket();
  const reader = new FrameReader();
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("close", () => reader.end());
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(host.port, HOST_IP, () => resolve());
  });
  socket.write(frame(encodeHandshake(stale)));
  // Rejection policy (tcp.rs): no typed error frame — the host
  // closes without replying, so the pending read fails with EOF.
  await expect(reader.next(READ_TIMEOUT_MS)).rejects.toThrow(/tcp read/i);
  socket.destroy();
});
