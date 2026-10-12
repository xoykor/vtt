// Per-sheet visibility over a room snapshot (pure, hermetic). Sheets
// travel under `sheet:<id>` keys (same namespacing as `token:<id>` and
// `roll:<id>`); the host sees everything while a guest sees only their
// own sheet plus opt-in public sheets (`sheet:public:*`). Every other
// partition passes through untouched, so map/roll sync is unaffected.

import type { Role, RoomState } from "../net/peer";

/** Key prefix of the sheet partition. */
export const SHEET_PREFIX = "sheet:";

/** Prefix of opt-in public sheets, visible to every guest. */
export const PUBLIC_SHEET_PREFIX = "sheet:public:";

/** Canonical key for a hosted sheet: `sheet:<id>`. */
export function sheetKey(id: string): string {
  if (id.length === 0) throw new Error("missing sheet id");
  return `${SHEET_PREFIX}${id}`;
}

/** True for keys in the sheet partition. */
export function isSheetKey(key: string): boolean {
  return key.startsWith(SHEET_PREFIX);
}

/**
 * Filter a room snapshot for `role`: host returns everything, guest
 * keeps only `sheet:<userId>` and `sheet:public:*` entries. Pure: the
 * input is never mutated.
 */
export function visibleSheets(
  state: RoomState,
  role: Role,
  userId: string,
): RoomState {
  if (role === "host") return { ...state };
  const own = sheetKey(userId);
  const next: RoomState = {};
  for (const [key, value] of Object.entries(state)) {
    if (!isSheetKey(key)) {
      next[key] = value;
      continue;
    }
    if (key === own || key.startsWith(PUBLIC_SHEET_PREFIX)) {
      next[key] = value;
    }
  }
  return next;
}
