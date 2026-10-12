// Turn state shared by host and guests (pure types, no logic).
// The whole combat state travels as ONE JSON value in the `turn:<id>`
// partition of the RoomState (flat key/value, same namespacing
// convention as `token:<id>`, `tile:<layer>:<x>,<y>`, `roll:<id>`),
// so a snapshot applies atomically through applyDelta: peers never see
// half an initiative order. The host is the only writer (see
// src/turn/turn.ts), matching the project-wide host-authoritative rule.

export interface TurnParticipant {
  /** Host-resolved initiative (d20 + modifier), already sorted. */
  initiative: number;
  /** Display name; defaults to the token id when the token has none. */
  name: string;
}

export interface TurnState {
  /** 1-based round number; 0 means "no combat running". */
  round: number;
  /** Combatant ids, highest initiative first (ties broken by id asc). */
  order: string[];
  /** Index into `order` of the combatant acting now. */
  activeIndex: number;
  /** Every id in `order`, keyed by id. */
  participants: Record<string, TurnParticipant>;
}
