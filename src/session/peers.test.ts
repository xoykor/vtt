// TDD: sessão sem slots (Roll20/Foundry). Quem hospeda = GM, quem
// entra com código = player. peerId = hash auto-gerado + nome
// auto-declarado. Convite = roomCode/secret; kick = rotar secret.
import { expect, test } from "vitest";
import {
  addPeer,
  createPeer,
  createSecret,
  inviteCode,
  parseInviteCode,
  removePeer,
  rotateSecret,
} from "./peers";

test("host é GM inicial; peerId contém hash + nome", () => {
  const gm = createPeer("Mestre", true);
  expect(gm.isGM).toBe(true);
  expect(gm.displayName).toBe("Mestre");
  expect(gm.peerId.length).toBeGreaterThan(0);
  expect(gm.peerId).toContain("mestre");
});

test("join com código vira player (não-GM)", () => {
  const secret = createSecret();
  const code = inviteCode("room-7000", secret);
  const parsed = parseInviteCode(code);
  expect(parsed.room).toBe("room-7000");
  expect(parsed.secret).toBe(secret);
  const player = createPeer("Borin", false);
  expect(player.isGM).toBe(false);
});

test("sem limite de peers; kick remove; rotar secret invalida código antigo", () => {
  let peers = [createPeer("Mestre", true)];
  for (let i = 0; i < 10; i++) peers = addPeer(peers, createPeer(`P${i}`, false));
  expect(peers).toHaveLength(11);
  const victim = peers[3];
  peers = removePeer(peers, victim.peerId);
  expect(peers.find((p) => p.peerId === victim.peerId)).toBeUndefined();
  expect(peers).toHaveLength(10);
  const oldSecret = createSecret();
  const fresh = rotateSecret(oldSecret);
  expect(fresh).not.toBe(oldSecret);
  expect(fresh.length).toBeGreaterThan(0);
});

test("parseInviteCode rejeita código malformado", () => {
  expect(() => parseInviteCode("sem-separador")).toThrow(/invite/);
  expect(() => parseInviteCode("")).toThrow(/invite/);
});
