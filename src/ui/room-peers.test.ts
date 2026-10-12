// TDD: sala sem slots — peers ilimitados via RoomState, convite por
// roomCode/secret, kick = remover + rotar secret. Sem seletor fixo.
import { expect, test } from "vitest";
import { createOfflineRoom, inviteCodeFor, peerKey } from "./room";

test("sala vazia não tem slots fixos; peers ilimitados", () => {
  const room = createOfflineRoom([]);
  expect(room.tokenCount()).toBe(0);
  expect(room.peers()).toHaveLength(0);
  const gm = room.addPeer("Mestre", true);
  expect(gm.isGM).toBe(true);
  for (let i = 0; i < 8; i++) room.addPeer(`Jogador ${i}`, false);
  expect(room.peers()).toHaveLength(9);
});

test("peerId contém hash + nome; kick remove", () => {
  const room = createOfflineRoom([]);
  const p = room.addPeer("Borin", false);
  expect(p.peerId).toContain("borin");
  expect(room.removePeer(p.peerId)).toBe(true);
  expect(room.peers().find((x) => x.peerId === p.peerId)).toBeUndefined();
  expect(room.removePeer("inexistente")).toBe(false);
});

test("convite = room#secret; rotar secret invalida código antigo", () => {
  const room = createOfflineRoom([]);
  const code1 = room.inviteCode();
  expect(code1).toContain("#");
  expect(code1).toContain(room.info.room);
  const secret1 = room.getSecret();
  const secret2 = room.rotateSecret();
  expect(secret2).not.toBe(secret1);
  expect(room.inviteCode()).not.toBe(code1);
  expect(peerKey("abc")).toBe("peer:abc");
  expect(inviteCodeFor("room-1", "s3cr3t")).toBe("room-1#s3cr3t");
});

test("peers viajam como RoomState sem poluir tokens", () => {
  const room = createOfflineRoom([]);
  room.addPeer("Mestre", true);
  const state = room.getState();
  // Sessão em memória: RoomState/delta intactos (sem peer:/room:secret).
  expect(Object.keys(state).some((k) => k.startsWith("peer:"))).toBe(false);
  expect(room.tokenCount()).toBe(0);
  expect(room.peers()).toHaveLength(1);
});
