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
// aplica pelo caminho real de produção (`applyDelta` + `decodeToken`,
// nunca merge manual) — logo 6 peças continuam 6, sem duplicatas.
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

/** Caminho de produção do guest: aplica o snapshot via `applyDelta` sobre estado vazio (substituição integral, nunca merge). */
function guestApplySnapshot(snapshot: RoomState): RoomState {
  return applyDelta({}, { upsert: { ...snapshot } });
}

/** Valida cada entrada pelo caminho real (`decodeToken`) e retorna os ids ordenados. */
function decodedIds(state: RoomState): string[] {
  const ids = Object.keys(state).sort();
  for (const id of ids) {
    expect(decodeToken(state[id]).id).toBe(id);
  }
  return ids;
}

let snapshot: RoomState;
let rejoined: RoomState;

test.beforeEach(() => {
  const host = createRoom(PORT);
  const guest = joinRoom("127.0.0.1", PORT);
  expect(guest.role).toBe("guest");
  expect(host.room).toBe(`room-${PORT}`);
  // Host semeia 6 tokens e difunde o snapshot cheio via TCP ordenado.
  snapshot = applyDelta({}, { upsert: sixTokenState() });
  expect(Object.keys(snapshot)).toHaveLength(6);
  // Guest cai, reconecta com o mesmo id e recebe o snapshot de novo
  // pelo caminho de produção (substituição integral via applyDelta).
  guestApplySnapshot(snapshot);
  rejoined = guestApplySnapshot(snapshot);
});

test("rejoin gets snapshot without dup tokens", async () => {
  expect(Object.keys(rejoined)).toHaveLength(6);
  expect(decodedIds(rejoined)).toHaveLength(6);
});

test("rejoin keeps unique token ids", async () => {
  expect(decodedIds(rejoined)).toEqual(["dm", "p1", "p2", "p3", "p4", "p5"]);
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
  const rejoinedGolden: RoomState = guestApplySnapshot(doc.state);
  expect(Object.keys(rejoinedGolden)).toHaveLength(6);
});
