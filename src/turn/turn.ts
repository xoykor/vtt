// Turn order + initiative (pure, hermetic). `rolls` arrive already
// resolved by the host (`Record<id, initiative>`), so this module never
// rolls dice: entropy lives in src/dice/roller.ts and only the host
// calls it. Every mutation returns `{ state, delta }` — the delta is
// what the host broadcasts over ordered TCP and applies via applyDelta
// from src/net/peer.ts.
//
// Host-authoritative (global project rule): advanceTurn and endCombat
// take a `role` and deny every non-host role fail-closed, returning the
// unchanged state plus an EMPTY delta — nothing to broadcast, no guest
// can move the turn. Same semantics as moveToken in src/map/tokens.ts.
//
// The whole TurnState is serialized under a single `turn:<id>` key
// (see src/turn/types.ts for why one key instead of one per
// participant), so `delta` is always `{ upsert: { "turn:<id>": ... } }`
// or `{ remove: ["turn:<id>"] }`.

import type { Delta, RoomState } from "../net/peer";
import type { Token } from "../map/tokens";
import type { TurnParticipant, TurnState } from "./types";

/** RoomState partition prefix for the turn module. */
export const TURN_KEY_PREFIX = "turn:";

/** Combat id used when the host does not name one: `turn:state`. */
export const DEFAULT_COMBAT_ID = "state";

export interface TurnResult {
  state: TurnState;
  delta: Delta;
}

/** Canonical key for a turn snapshot: `turn:<id>`. */
export function turnKey(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing turn id");
  }
  return `${TURN_KEY_PREFIX}${id}`;
}

/** Encode a turn state as one JSON value for a `turn:<id>` key. */
export function encodeTurn(state: TurnState): string {
  return JSON.stringify(state);
}

function readParticipants(
  raw: unknown,
  order: string[],
): Record<string, TurnParticipant> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("missing field: participants");
  }
  const source = raw as Record<string, unknown>;
  const participants: Record<string, TurnParticipant> = {};
  for (const id of order) {
    const entry = source[id];
    if (entry === undefined) {
      throw new Error(`unknown participant: ${id}`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid participant: ${id}`);
    }
    const { initiative, name } = entry as Record<string, unknown>;
    if (typeof initiative !== "number" || !Number.isInteger(initiative)) {
      throw new Error(`invalid initiative: ${String(initiative)} [${id}]`);
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("missing field: name");
    }
    participants[id] = { initiative, name };
  }
  for (const id of Object.keys(source)) {
    if (!(id in participants)) {
      throw new Error(`participant not in order: ${id}`);
    }
  }
  return participants;
}

/**
 * Decode and validate a turn state from its `turn:<id>` JSON value.
 * Enforces the invariants that make a snapshot authoritative:
 * `order` holds non-empty unique ids, every id has a participant
 * (and vice versa, so the snapshot re-encodes identically),
 * `activeIndex` points inside `order` and `round` is a non-negative
 * integer (0 only when there is no combat).
 */
export function decodeTurn(json: string): TurnState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("malformed turn json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("malformed turn json");
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.round !== "number") throw new Error("missing field: round");
  if (!Number.isInteger(doc.round) || doc.round < 0) {
    throw new Error(`invalid round: ${String(doc.round)}`);
  }
  if (!Array.isArray(doc.order)) throw new Error("missing field: order");
  const order: string[] = [];
  for (const id of doc.order) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`invalid order id: ${String(id)}`);
    }
    if (order.includes(id)) throw new Error(`duplicate order id: ${id}`);
    order.push(id);
  }
  if (typeof doc.activeIndex !== "number") {
    throw new Error("missing field: activeIndex");
  }
  // An empty order has no acting combatant, so 0 is the only valid index.
  const maxIndex = order.length === 0 ? 0 : order.length - 1;
  if (
    !Number.isInteger(doc.activeIndex) ||
    doc.activeIndex < 0 ||
    doc.activeIndex > maxIndex
  ) {
    throw new Error(
      `invalid activeIndex: ${String(doc.activeIndex)} order length ${order.length}`,
    );
  }
  if (order.length === 0 && doc.round !== 0) {
    throw new Error(`invalid round: ${doc.round} with empty order`);
  }
  const participants = readParticipants(doc.participants, order);
  return { round: doc.round, order, activeIndex: doc.activeIndex, participants };
}

/** Delta that publishes `state` under `turn:<id>` (atomically). */
export function turnDelta(state: TurnState, id: string = DEFAULT_COMBAT_ID): Delta {
  return { upsert: { [turnKey(id)]: encodeTurn(state) } };
}

/** Delta that clears `turn:<id>`; removing an absent key is a no-op. */
export function clearTurnDelta(id: string = DEFAULT_COMBAT_ID): Delta {
  return { remove: [turnKey(id)] };
}

/** Decoded snapshot stored under `turn:<id>`, or null when absent/corrupt. */
export function readTurn(
  state: RoomState,
  id: string = DEFAULT_COMBAT_ID,
): TurnState | null {
  const raw = state[turnKey(id)];
  if (raw === undefined) return null;
  try {
    return decodeTurn(raw);
  } catch {
    return null;
  }
}

/** Id of the combatant acting now, or null when no combat is running. */
export function activeCombatant(state: TurnState): string | null {
  if (state.order.length === 0) return null;
  return state.order[state.activeIndex] ?? null;
}

const NO_COMBAT: TurnState = {
  round: 0,
  order: [],
  activeIndex: 0,
  participants: {},
};

/** Combatant token as seen by the turn module: only `id` matters. */
export function tokenIdOf(token: Token): string {
  if (token === null || typeof token !== "object" || typeof token.id !== "string") {
    throw new Error("invalid token");
  }
  if (token.id.length === 0) throw new Error("missing token id");
  return token.id;
}

/**
 * Build the initiative order from the combatant tokens and the
 * host-resolved `rolls` (initiative per token id). Highest initiative
 * acts first; ties break on the id (ascending) so every peer derives
 * the same order from the same inputs. Tokens without a roll default
 * to initiative 0 rather than being dropped.
 *
 * `names` optionally supplies display names for the participants
 * (unknown ids are ignored); by default the name is the token id.
 */
export function createTurnOrder(
  tokens: Token[],
  rolls: Record<string, number>,
  names?: Record<string, string>,
): TurnState {
  if (!Array.isArray(tokens)) throw new Error("missing tokens");
  if (typeof rolls !== "object" || rolls === null) throw new Error("missing rolls");
  const ids: string[] = [];
  for (const token of tokens) {
    const id = tokenIdOf(token);
    if (ids.includes(id)) throw new Error(`duplicate token id: ${id}`);
    ids.push(id);
  }
  const participants: Record<string, TurnParticipant> = {};
  for (const id of ids) {
    const initiative = rolls[id] ?? 0;
    if (!Number.isInteger(initiative)) {
      throw new Error(`invalid initiative: ${String(initiative)} [${id}]`);
    }
    participants[id] = { initiative, name: names?.[id] ?? id };
  }
  const order = [...ids].sort(compareInitiative(participants));
  if (order.length === 0) return { ...NO_COMBAT, participants: {} };
  return { round: 1, order, activeIndex: 0, participants };
}

function compareInitiative(
  participants: Record<string, TurnParticipant>,
): (a: string, b: string) => number {
  return (a, b) => {
    const diff = participants[b].initiative - participants[a].initiative;
    if (diff !== 0) return diff;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  };
}

/**
 * Start a combat with `tokens`/`rolls`: returns the fresh state (round
 * 1, first initiative acting) and the delta that publishes it. With an
 * empty party nothing is published — any stale snapshot is removed
 * instead, so a room never shows a leftover order.
 */
export function startCombat(
  tokens: Token[],
  rolls: Record<string, number>,
  names?: Record<string, string>,
  id: string = DEFAULT_COMBAT_ID,
): TurnResult {
  const state = createTurnOrder(tokens, rolls, names);
  const delta =
    state.order.length === 0 ? clearTurnDelta(id) : turnDelta(state, id);
  return { state, delta };
}

/**
 * Pass the turn to the next combatant. Host-only: any other role gets
 * the SAME state and an empty delta (fail-closed, nothing broadcast).
 * An empty state (no combat) is kept as-is, also with no delta.
 * Wrapping past the last combatant starts the next round.
 */
export function advanceTurn(
  state: TurnState,
  role: string,
  id: string = DEFAULT_COMBAT_ID,
): TurnResult {
  if (role !== "host") return { state, delta: {} };
  if (state.order.length === 0) return { state, delta: {} };
  const next: TurnState =
    state.activeIndex + 1 >= state.order.length
      ? { ...state, activeIndex: 0, round: state.round + 1 }
      : { ...state, activeIndex: state.activeIndex + 1 };
  return { state: next, delta: turnDelta(next, id) };
}

/**
 * End the combat: back to the inert state (round 0, no order) plus the
 * delta that removes `turn:<id>` from every peer. Host-only (fail-closed
 * like advanceTurn); ending an already-ended combat is a no-op delta.
 */
export function endCombat(
  state: TurnState,
  role: string,
  id: string = DEFAULT_COMBAT_ID,
): TurnResult {
  if (role !== "host") return { state, delta: {} };
  return { state: { ...NO_COMBAT, participants: {} }, delta: clearTurnDelta(id) };
}
