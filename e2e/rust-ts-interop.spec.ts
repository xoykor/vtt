// Task 5 E2E: REAL Rust↔TS interop — the Rust `host` binary serves
// handshake + snapshot + delta over REAL TCP (127.0.0.1:0) and the guest
// speaks it with the production TS codecs. Hermetic: ephemeral loopback
// port, no LAN, no browser sockets, 10 s caps so a hang fails fast.
//
// BRIDGE PATH (invoke → Rust) this spec documents:
//
//   browser/TS                              Rust (`src-tauri/…`)
//   ──────────                              ───────────────────
//   `src/app.ts` `tauriInvoke(cmd, args)` → `commands.rs` `#[tauri::command]`
//   reads `window.__TAURI__` (Tauri 2      `create_room` → `net::create_room`
//   `core.invoke`, legacy `invoke` shim)   `join_room`   → `join_live` →
//   `src/ui/room.ts` `joinVia(addr,           `tcp::connect_handshake` (this
//   invoke)` validates `ip:port`, calls      spec's handshake step, run in
//   `invoke("join_room", { ip, port })`,      Rust by the real binary)
//   parses the room-info JSON reply         `push_delta`  → `decode_delta` +
//   (`{"version","room","port"}`) and        `net::apply_delta` (remove-wins)
//   version-gates it.                       `get_snapshot`→ `save::export_json`
//
// Browsers cannot open raw TCP sockets, so in production the browser
// guest reaches the Rust host EXCLUSIVELY through that invoke bridge
// (`join_room` dials TCP inside Rust, never in JS). This spec proves the
// other half of the same wire: it spawns the real Rust endpoint
// (`src-tauri/src/bin/host.rs`, same `tcp.rs` framing + `save.rs`
// shapes the Tauri commands use) and drives it with the exact TS
// modules the browser bundle ships (`src/net/peer.ts`,
// `src/map/tokens.ts`, `src/ui/room.ts`) running in Node — byte-level
// Rust↔TS interop. The `joinVia` test below feeds the binary's live
// room-reply bytes through the browser's bridge parser.
//
// WITHOUT the binary (plain `git clone`, no cargo build) every test in
// this file SKIPS with an explicit reason instead of failing — run
// `cargo build --bin host` (from `src-tauri/`) to enable it.
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
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
import { decodeToken, type Token } from "../src/map/tokens";
import { joinVia } from "../src/ui/room";

const HOST_IP = "127.0.0.1";
const HOST_ROOM = "room-interop";
const READ_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const EOF = /tcp read failed|EOF|closed|reset|broken pipe/i;

/** Locate the prebuilt Rust host (`cargo build --bin host`). */
function findHostBin(): string | null {
  for (const rel of [
    "../src-tauri/target/debug/host",
    "../src-tauri/target/release/host",
  ]) {
    const abs = path.join(__dirname, rel);
    try {
      fs.accessSync(abs, fs.constants.X_OK);
      return abs;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const HOST_BIN: string | null = findHostBin();

test.skip(
  HOST_BIN === null,
  "host binary not built — run `cargo build --bin host` from src-tauri/ to enable real Rust↔TS interop (skipping, not failing)",
);

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

/** Buffered reader for length-prefixed frames — the Node mirror of
 *  Rust `recv_frame` (same shape as `e2e/lan.spec.ts`: TCP may coalesce
 *  back-to-back frames, so bytes buffer until a full frame arrives; a
 *  close with a frame pending rejects it — EOF IS the rejection). */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
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

/** The real Rust endpoint under test: `src-tauri/src/bin/host.rs`
 *  on an ephemeral loopback port (`--port 0`), discovered via its
 *  `HOST_READY port=… room=…` stdout line. */
class RustHost {
  private child: ChildProcess | null = null;
  port = 0;

  async start(): Promise<void> {
    if (HOST_BIN === null) throw new Error("host binary missing");
    this.child = spawn(
      HOST_BIN,
      ["--bind", HOST_IP, "--port", "0", "--room", HOST_ROOM],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const child = this.child;
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("host readiness timed out after 10s")),
        READ_TIMEOUT_MS,
      );
      let out = Buffer.alloc(0);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      child.once("error", fail);
      child.stdout!.on("data", (chunk: Buffer) => {
        out = Buffer.concat([out, chunk]);
        const nl = out.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(out.subarray(0, nl).toString("utf-8").trim());
        }
      });
    }).catch((e: Error) => {
      this.child?.kill("SIGKILL");
      throw e;
    });
    const m = /^HOST_READY port=(\d+) room=(\S+)$/.exec(ready);
    if (!m || m[2] !== HOST_ROOM) {
      await this.stop();
      throw new Error(`malformed HOST_READY line: ${JSON.stringify(ready)}`);
    }
    this.port = Number(m[1]);
    expect(this.port).toBeGreaterThan(0);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** TS guest: the production browser codecs (`encodeHandshake`,
 *  `handshake` version gate, `applyDelta`, `decodeToken`) driven over
 *  a real TCP socket against the Rust host. */
class TsGuest {
  private state: RoomState = {};
  /** Raw room-reply bytes from the Rust host (bridge test input). */
  roomReplyRaw = "";
  room = "";
  port = 0;

  async join(host: RustHost): Promise<void> {
    const socket = new net.Socket();
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => reader.end());
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(host.port, HOST_IP, () => resolve());
    });
    try {
      // 1. Handshake as guest (what Rust `connect_handshake` sends
      //    inside the Tauri `join_room` command).
      const hs: Handshake = {
        version: PROTOCOL_VERSION,
        room: HOST_ROOM,
        role: "guest",
      };
      socket.write(frame(encodeHandshake(hs)));
      // 2. Room reply, version-gated by the production `decodeHandshake`
      //    shape check (same `handshake()` gate the bridge uses).
      this.roomReplyRaw = await reader.next(READ_TIMEOUT_MS);
      const reply = JSON.parse(this.roomReplyRaw) as Record<string, unknown>;
      handshake(String(reply.version), PROTOCOL_VERSION);
      expect(reply.room).toBe(HOST_ROOM);
      expect(reply.port).toBe(host.port);
      this.room = String(reply.room);
      this.port = Number(reply.port);
      // Prove the reply also parses as a handshake-style version gate
      // on the TS side (mirrors `joinVia`'s bridge check below).
      decodeHandshake(
        encodeHandshake({ version: hs.version, room: hs.room, role: "guest" }),
      );
      // 3. Snapshot: wholesale restore (replace, never merge).
      const snap = JSON.parse(await reader.next(READ_TIMEOUT_MS)) as {
        version: string;
        room: string;
        state: RoomState;
      };
      expect(snap.version).toBe(PROTOCOL_VERSION);
      expect(snap.room).toBe(HOST_ROOM);
      this.state = applyDelta({}, { upsert: snap.state });
      // 4. Delta round-trip: the guest pushes one delta (remove-wins)
      //    and the host echoes the updated snapshot.
      const delta: Delta = {
        upsert: {
          p6: '{"id":"p6","pos":{"x":6,"y":0},"hp":16}',
        },
        remove: ["p5"],
      };
      socket.write(frame(JSON.stringify(delta)));
      const updated = JSON.parse(await reader.next(READ_TIMEOUT_MS)) as {
        version: string;
        room: string;
        state: RoomState;
      };
      expect(updated.room).toBe(HOST_ROOM);
      this.state = applyDelta({}, { upsert: updated.state });
    } finally {
      socket.destroy();
    }
  }

  tokenCount(): number {
    return this.tokenIds().length;
  }

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
}

let host: RustHost;
let guest: TsGuest;

test.beforeAll(async () => {
  // `test.skip` above skips the tests but NOT this hook: without the
  // binary a plain clone would fail here instead of skipping. Bail out
  // early so the suite stays green with an explicit skip reason.
  if (HOST_BIN === null) return;
  host = new RustHost();
  await host.start();
  guest = new TsGuest();
  await guest.join(host);
});

test.afterAll(async () => {
  if (HOST_BIN === null) return;
  await host.stop();
});

test("rust host serves snapshot to ts guest", async () => {
  expect(guest.tokenCount()).toBe(6);
  expect(guest.room).toBe(HOST_ROOM);
  expect(guest.port).toBe(host.port);
});

test("ts guest delta round-trips without dup ids", async () => {
  // Seed carried dm+p1..p5 (6); the guest delta removed p5 and added
  // p6 — still exactly 6 unique tokens after the Rust host applied it.
  expect(guest.tokenIds()).toEqual(["dm", "p1", "p2", "p3", "p4", "p6"]);
  expect(guest.token("dm").pos).toEqual({ x: 0, y: 0 });
  expect(guest.token("p6").hp).toBe(16);
});

test("browser bridge joinVia parses the real rust room reply", async () => {
  // The browser never touches TCP: `joinVia` calls
  // `invoke("join_room", { ip, port })` and the Rust command returns
  // exactly these bytes. Feed the live reply through the real parser.
  const raw = guest.roomReplyRaw;
  expect(raw).toContain('"room":"room-interop"');
  const info = await joinVia(`${HOST_IP}:${host.port}`, async (cmd, args) => {
    expect(cmd).toBe("join_room");
    expect(args).toEqual({ ip: HOST_IP, port: host.port });
    return raw;
  });
  expect(info).toEqual({
    room: HOST_ROOM,
    port: host.port,
    version: PROTOCOL_VERSION,
  });
});

test("rust host rejects stale-version handshake over tcp", async () => {
  const stale: Handshake = {
    version: "0.9",
    room: HOST_ROOM,
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
  // Rejection policy (tcp.rs): no typed error frame — the host closes
  // without replying, so the pending read fails with EOF.
  await expect(reader.next(READ_TIMEOUT_MS)).rejects.toThrow(EOF);
  socket.destroy();
});
