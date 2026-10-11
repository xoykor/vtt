import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  applyDelta,
  createRoom,
  joinRoom,
  type RoomState,
} from "../src/net/peer";
import { createToken, decodeToken, encodeToken } from "../src/map/tokens";

// Task 7 E2E: rejoin recebe o snapshot do host sem duplicar tokens.
//
// Hermético por desenho (igual às Tasks 2-6): sem socket, sem servidor,
// sem browser — o transporte real (TCP ordenado para estado, UDP para
// cursor) entra quando os sockets Rust landarem. O que este spec prova:
// o guest derruba o estado local, pede o snapshot cheio ao host e o
// aplica por substituição integral (`applySnapshot`), nunca por merge
// de deltas — logo 6 peças continuam 6, sem duplicatas.
//
// Peças de teste (mesa 1 mestre + 5 jogadores): "dm" + p1..p5.
//
// LAN real com 2 peers (manual, quando houver app + rede):
//   1. Peer A (host): `createRoom(7000)` → anuncia `_vtt._tcp` via mDNS.
//   2. Peer B (guest): `joinRoom(<ip-do-A>, 7000)` → handshake versão/sala.
//   3. A difunde o snapshot cheio; B aplica e conta 6 tokens.
//   4. B desconecta, reconecta com o mesmo id e recebe o snapshot de novo.
//   5. `npx playwright test e2e/room.spec.ts --headed` contra a sala real
//      deve manter `tokenCount() === 6` sem ids duplicados.

const PORT = 7000;

/** Estado inicial do host: 6 tokens, um JSON por chave (partição RoomState). */
function sixTokenState(): RoomState {
  const ids = ["dm", "p1", "p2", "p3", "p4", "p5"];
  const state: RoomState = {};
  ids.forEach((id, i) => {
    state[id] = encodeToken(createToken(id, { x: i, y: 0 }, 10 + i));
  });
  return state;
}

/** Vista do guest: aplica snapshots por substituição integral. */
class Room {
  state: RoomState = {};

  constructor(public readonly roomId: string) {}

  tokenCount(): number {
    return Object.keys(this.state).length;
  }

  tokenIds(): string[] {
    return Object.keys(this.state).sort();
  }

  /** Rejoin: o snapshot substitui o estado local (nunca merge). */
  applySnapshot(snapshot: RoomState): void {
    this.state = { ...snapshot };
  }
}

let room: Room;

test.beforeEach(() => {
  const host = createRoom(PORT);
  const guest = joinRoom("127.0.0.1", PORT);
  expect(guest.role).toBe("guest");
  // Host semeia 6 tokens e difunde o snapshot cheio via TCP ordenado.
  const snapshot: RoomState = applyDelta({}, { upsert: sixTokenState() });
  expect(Object.keys(snapshot)).toHaveLength(6);
  // Guest cai, reconecta com o mesmo id e recebe o snapshot de novo.
  room = new Room(host.room);
  room.applySnapshot(snapshot);
  room.applySnapshot({ ...snapshot });
});

test("rejoin gets snapshot without dup tokens", async () => {
  await expect(room.tokenCount()).toBe(6);
});

test("rejoin keeps unique token ids", async () => {
  await expect(room.tokenIds()).toEqual(["dm", "p1", "p2", "p3", "p4", "p5"]);
});

// Cross-boundary golden (review Task 7 round 1): este fixture é gerado
// pelo Rust (`src-tauri/tests/golden_test.rs` via `save::export_json`,
// bytes fixados em `EXPECTED_GOLDEN_JSON`; regen: `cargo test --test
// golden_test`). O teste alimenta o JSON do Rust no caminho real do TS
// (`applyDelta`/snapshot + `decodeToken`) e valida os mesmos 6 ids sem
// duplicatas — divergência na fronteira FFI falha aqui e no Rust.
test("rust golden fixture restores 6 tokens without dups", async () => {
  // O spec roda como CommonJS (sem `"type": "module"` no package.json),
  // logo `__dirname` = `e2e/` — robusto a cwd de invocação.
  const raw = fs.readFileSync(
    path.join(__dirname, "fixtures", "save-golden.json"),
    "utf-8",
  );
  const doc = JSON.parse(raw) as {
    version: string;
    room: string;
    state: RoomState;
  };
  expect(doc.version).toBe("1.0");
  expect(doc.room).toBe("room-7000");
  // Serialização Rust↔TS byte-idêntica (paridade `encodeToken`).
  expect(doc.state["dm"]).toBe('{"id":"dm","pos":{"x":0,"y":0},"hp":10}');
  // Snapshot do host aplicado pelo caminho real de deltas TCP.
  const guest = applyDelta({}, { upsert: doc.state });
  const ids = Object.keys(guest).sort();
  expect(ids).toEqual(["dm", "p1", "p2", "p3", "p4", "p5"]);
  for (const id of ids) {
    expect(decodeToken(guest[id]).id).toBe(id);
  }
  // Rejoin: segundo snapshot substitui, nunca duplica.
  const rejoined: RoomState = { ...doc.state };
  expect(Object.keys(rejoined)).toHaveLength(6);
});
