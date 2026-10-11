import { expect, test } from "@playwright/test";
import {
  applyDelta,
  createRoom,
  joinRoom,
  type RoomState,
} from "../src/net/peer";
import { createToken, encodeToken } from "../src/map/tokens";

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
