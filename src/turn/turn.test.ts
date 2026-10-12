// Turn order + initiative (pure, hermetic). Initiative rolls are already
// resolved by the host (`rolls` is a plain Record<id, initiative>), so
// nothing here rolls dice: src/dice/roller.ts owns entropy and this
// module only orders, advances and serializes the combat state.
// Only the host advances/ends a turn — every other role is denied with
// an empty delta (fail-closed, same semantics as moveToken).

import { expect, test } from "vitest";
import { applyDelta, type Delta, type RoomState } from "../net/peer";
import { createToken, type Token } from "../map/tokens";
import {
  DEFAULT_COMBAT_ID,
  activeCombatant,
  advanceTurn,
  createTurnOrder,
  decodeTurn,
  encodeTurn,
  endCombat,
  readTurn,
  startCombat,
  turnDelta,
  turnKey,
} from "./turn";
import type { TurnState } from "./types";

function t(id: string): Token {
  return createToken(id, { x: 0, y: 0 }, 10);
}

const EMPTY_TURN: TurnState = {
  round: 0,
  order: [],
  activeIndex: 0,
  participants: {},
};

function party(): Token[] {
  return [t("hero"), t("goblin"), t("bard"), t("cleric")];
}

test("createTurnOrder sorts initiative desc, tie-break by id", () => {
  const state = createTurnOrder(party(), {
    hero: 18,
    goblin: 5,
    bard: 18,
    cleric: 0,
  });
  // 18 (bard) == 18 (hero): lower id acts first.
  expect(state.order).toEqual(["bard", "hero", "goblin", "cleric"]);
  expect(state.participants.bard).toEqual({
    initiative: 18,
    name: "bard",
  });
  expect(state.participants.cleric).toEqual({
    initiative: 0,
    name: "cleric",
  });
  expect(state.round).toBe(1);
  expect(state.activeIndex).toBe(0);
  expect(activeCombatant(state)).toBe("bard");
});

test("createTurnOrder puts negative initiative last and orders ids asc", () => {
  const state = createTurnOrder([t("zulu"), t("alpha"), t("mike")], {
    mike: 0,
    zulu: -2,
  });
  // alpha has no roll: defaults to 0, tie with mike(0) -> id asc.
  expect(state.order).toEqual(["alpha", "mike", "zulu"]);
  expect(state.participants.zulu.initiative).toBe(-2);
  expect(state.activeIndex).toBe(0);
});

test("empty party yields an inert turn state (no combat)", () => {
  expect(createTurnOrder([], {})).toEqual(EMPTY_TURN);
  expect(startCombat([], {}).state).toEqual(EMPTY_TURN);
});

test("participant names default to the token id and can be overridden", () => {
  const tokens = [t("hero"), t("goblin")];
  expect(createTurnOrder(tokens, { hero: 5, goblin: 9 })
    .participants.hero.name).toBe("hero");
  const named = createTurnOrder(tokens, { hero: 5, goblin: 9 }, {
    hero: "Lyra",
  });
  expect(named.participants.hero.name).toBe("Lyra");
  // Unknown ids in `names` are ignored, tokens keep their own name.
  expect(named.participants.goblin.name).toBe("goblin");
  expect(named.order).toEqual(["goblin", "hero"]);
});

test("startCombat returns state plus a delta that publishes the order", () => {
  const started = startCombat(party(), { hero: 18, goblin: 5, bard: 18 });
  expect(started.state.round).toBe(1);
  expect(started.state.order[0]).toBe("bard");
  expect(started.delta).toEqual({
    upsert: { [turnKey(DEFAULT_COMBAT_ID)]: encodeTurn(started.state) },
  });
  const room = applyDelta({}, started.delta);
  expect(readTurn(room)).toEqual(started.state);
});

test("startCombat with nobody clears a stale snapshot instead of publishing", () => {
  const started = startCombat([], {});
  expect(started.state).toEqual(EMPTY_TURN);
  expect(started.delta).toEqual({ remove: [turnKey(DEFAULT_COMBAT_ID)] });
});

test("only the host advances the turn (fail-closed)", () => {
  const state = createTurnOrder(party(), {
    hero: 18,
    goblin: 5,
    bard: 18,
    cleric: 0,
  });
  for (const role of ["guest", "player", "", "admin", "HOST", "host "]) {
    const res = advanceTurn(state, role);
    // Same state back, nothing to broadcast: the host never acted.
    expect(res.state).toBe(state);
    expect(res.delta).toEqual({});
  }
  expect(state.activeIndex).toBe(0);
});

test("host advance moves the active index and publishes a delta", () => {
  const state = createTurnOrder(party(), {
    hero: 18,
    goblin: 5,
    bard: 18,
    cleric: 0,
  });
  const res = advanceTurn(state, "host");
  expect(res.state).not.toBe(state);
  expect(res.state.order).toEqual(["bard", "hero", "goblin", "cleric"]);
  expect(res.state.activeIndex).toBe(1);
  expect(res.state.round).toBe(1);
  expect(activeCombatant(res.state)).toBe("hero");
  expect(res.delta.upsert).toEqual({
    [turnKey(DEFAULT_COMBAT_ID)]: encodeTurn(res.state),
  });
  // Pure: the input keeps its own activeIndex.
  expect(state.activeIndex).toBe(0);
  // The delta is an update, not a full replace: it applies over the
  // previous snapshot exactly like the host broadcasts it.
  const room = applyDelta({}, turnDelta(state));
  const next = applyDelta(room, res.delta);
  expect(readTurn(next)).toEqual(res.state);
  expect(Object.keys(next)).toEqual([turnKey(DEFAULT_COMBAT_ID)]);
});

test("wrapping past the last combatant starts a new round", () => {
  let state = createTurnOrder([t("a"), t("b"), t("c")], {
    a: 20,
    b: 12,
    c: 7,
  });
  const first = advanceTurn(state, "host");
  const second = advanceTurn(first.state, "host");
  expect(second.state.activeIndex).toBe(2);
  expect(second.state.round).toBe(1);
  expect(activeCombatant(second.state)).toBe("c");
  const third = advanceTurn(second.state, "host");
  expect(third.state.activeIndex).toBe(0);
  expect(third.state.round).toBe(2);
  expect(activeCombatant(third.state)).toBe("a");
  const fourth = advanceTurn(third.state, "host");
  expect(fourth.state).toEqual({
    round: 2,
    order: ["a", "b", "c"],
    activeIndex: 1,
    participants: third.state.participants,
  });
});

test("advancing an empty combat keeps the state (no turn to advance)", () => {
  const res = advanceTurn(EMPTY_TURN, "host");
  expect(res.state).toBe(EMPTY_TURN);
  expect(res.delta).toEqual({});
  expect(EMPTY_TURN.round).toBe(0);
});

test("endCombat clears the state and removes the turn key", () => {
  const started = startCombat(party(), { hero: 18, goblin: 5, bard: 18 });
  const room: RoomState = {
    "token:hero": "{}",
    ...turnDelta(started.state).upsert,
  };
  const res = endCombat(started.state, "host");
  expect(res.state).toEqual(EMPTY_TURN);
  expect(res.delta).toEqual({ remove: [turnKey(DEFAULT_COMBAT_ID)] });
  const cleared = applyDelta(room, res.delta);
  expect(readTurn(cleared)).toBeNull();
  // Other partitions (tokens) survive the cleanup.
  expect(cleared["token:hero"]).toBe("{}");
  expect(
    Object.keys(cleared).filter((k) => k.startsWith("turn:")),
  ).toEqual([]);
});

test("endCombat is host-only too (fail-closed)", () => {
  const started = startCombat(party(), { hero: 18 });
  for (const role of ["guest", "player", "", "admin"]) {
    const res = endCombat(started.state, role);
    expect(res.state).toBe(started.state);
    expect(res.delta).toEqual({});
  }
  expect(started.state.round).toBe(1);
});

test("encodeTurn/decodeTurn round-trip a turn state", () => {
  const state = createTurnOrder(party(), {
    hero: 18,
    goblin: 5,
    bard: 18,
    cleric: 0,
  });
  const json = encodeTurn(state);
  const back = decodeTurn(json);
  expect(back).toEqual(state);
  // Decoded is a copy: mutating it never touches the original.
  back.participants.hero.initiative = 99;
  back.order.push("ghost");
  expect(state.participants.hero.initiative).toBe(18);
  expect(state.order).toEqual(["bard", "hero", "goblin", "cleric"]);
  expect(decodeTurn(encodeTurn(EMPTY_TURN))).toEqual(EMPTY_TURN);
});

test("decodeTurn validates every field", () => {
  const good = createTurnOrder([t("a"), t("b")], { a: 9, b: 4 });
  const json = JSON.parse(encodeTurn(good)) as Record<string, unknown>;
  const parts = json.participants as Record<string, unknown>;
  const with_ = (patch: Record<string, unknown>): string =>
    JSON.stringify({ ...json, ...patch });

  expect(() => decodeTurn("{")).toThrow(/malformed turn json/);
  expect(() => decodeTurn("null")).toThrow(/malformed turn json/);
  expect(() => decodeTurn("[]")).toThrow(/malformed turn json/);
  const { round: _r, ...noRound } = json;
  expect(() => decodeTurn(JSON.stringify(noRound))).toThrow(/missing field: round/);
  expect(() => decodeTurn(with_({ round: 1.5 }))).toThrow(/invalid round/);
  expect(() => decodeTurn(with_({ round: -1 }))).toThrow(/invalid round/);
  const { order: _o, ...noOrder } = json;
  expect(() => decodeTurn(JSON.stringify(noOrder))).toThrow(/missing field: order/);
  expect(() => decodeTurn(with_({ order: ["a", ""] }))).toThrow(
    /invalid order id/,
  );
  expect(() => decodeTurn(with_({ order: ["a", "b", 3] }))).toThrow(
    /invalid order id/,
  );
  expect(() => decodeTurn(with_({ activeIndex: 1.5 }))).toThrow(
    /invalid activeIndex/,
  );
  expect(() => decodeTurn(with_({ activeIndex: 2 }))).toThrow(
    /invalid activeIndex: 2 order length 2/,
  );
  expect(() => decodeTurn(with_({ activeIndex: -1 }))).toThrow(
    /invalid activeIndex/,
  );
  expect(() => decodeTurn(with_({ participants: null }))).toThrow(
    /missing field: participants/,
  );
  // A participant payload must be an object.
  expect(() =>
    decodeTurn(with_({ participants: { a: parts.a, b: 4 } })),
  ).toThrow(/invalid participant: b/);
  expect(() =>
    decodeTurn(with_({ participants: { a: 7, b: parts.b } })),
  ).toThrow(/invalid participant: a/);
  expect(() =>
    decodeTurn(with_({ participants: { a: { initiative: 1 }, b: parts.b } })),
  ).toThrow(/missing field: name/);
  expect(() =>
    decodeTurn(
      with_({
        participants: {
          ...parts,
          a: { initiative: 1.5, name: "A" },
        },
      }),
    ),
  ).toThrow(/invalid initiative: 1.5/);
  // An order id with no participant entry is not a combatant.
  expect(() => decodeTurn(with_({ order: ["a", "b", "ghost"] }))).toThrow(
    /unknown participant: ghost/,
  );
  // A participant nobody in the order cannot act.
  expect(() =>
    decodeTurn(
      with_({
        participants: { ...parts, ghost: { initiative: 3, name: "G" } },
      }),
    ),
  ).toThrow(/participant not in order: ghost/);
});

test("decodeTurn keeps the order the host built (even unsorted)", () => {
  const json = JSON.stringify({
    round: 2,
    order: ["b", "a"],
    activeIndex: 1,
    participants: {
      a: { initiative: 5, name: "A" },
      b: { initiative: 20, name: "B" },
    },
  });
  const state = decodeTurn(json);
  expect(state.order).toEqual(["b", "a"]);
  expect(state.round).toBe(2);
  expect(activeCombatant(state)).toBe("a");
});

test("createTurnOrder rejects duplicates, empty ids and bad rolls", () => {
  expect(() => createTurnOrder([t("a"), t("a")], { a: 3 })).toThrow(
    /duplicate token id: a/,
  );
  expect(() => createTurnOrder([t("")], {})).toThrow(/missing token id/);
  expect(() => createTurnOrder([t("a")], { a: NaN })).toThrow(
    /invalid initiative: NaN/,
  );
  expect(() => createTurnOrder([t("a")], { a: 1.5 })).toThrow(
    /invalid initiative: 1.5/,
  );
  expect(() =>
    createTurnOrder([t("a")], ({ a: "3" } as unknown) as Record<string, number>),
  ).toThrow(/invalid initiative: 3/);
  expect(() => createTurnOrder([t("a")], (null as unknown) as Record<string, number>)).toThrow(
    /missing rolls/,
  );
});

test("turn keys are namespaced and never collide with other partitions", () => {
  expect(turnKey("hero")).toBe("turn:hero");
  expect(() => turnKey("")).toThrow(/missing turn id/);
  const state = createTurnOrder([t("hero")], { hero: 12 });
  const delta: Delta = turnDelta(state, "encounter-7");
  expect(Object.keys(delta.upsert ?? {})).toEqual(["turn:encounter-7"]);
  const room = applyDelta({ "token:hero": "{}" }, delta);
  const advanced = advanceTurn(state, "host", "encounter-7");
  const next = applyDelta(room, advanced.delta);
  expect(readTurn(next, "encounter-7")).toEqual(advanced.state);
  // The default partition is untouched by a named combat.
  expect(readTurn(next)).toBeNull();
  expect(next["token:hero"]).toBe("{}");
});

test("activeCombatant is null without combat and after endCombat", () => {
  expect(activeCombatant(EMPTY_TURN)).toBeNull();
  const started = startCombat([t("a"), t("b")], { a: 1, b: 2 });
  expect(activeCombatant(started.state)).toBe("b");
  expect(activeCombatant(endCombat(started.state, "host").state)).toBeNull();
});

test("a guest cannot advance or end combat through a decoded snapshot", () => {
  // A guest only ever sees the JSON the host broadcast.
  const started = startCombat(party(), { hero: 18, goblin: 5, bard: 18 });
  const seen = decodeTurn(encodeTurn(started.state));
  const advanced = advanceTurn(seen, "guest");
  const ended = endCombat(seen, "guest");
  expect(advanced.state).toBe(seen);
  expect(advanced.delta).toEqual({});
  expect(ended.state).toBe(seen);
  expect(ended.delta).toEqual({});
  expect(seen.round).toBe(1);
  expect(seen.activeIndex).toBe(0);
  // The host still advances over the very same snapshot.
  expect(advanceTurn(seen, "host").state.activeIndex).toBe(1);
});
