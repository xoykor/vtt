// Per-sheet visibility over a room snapshot (pure, hermetic). Sheets
// travel under `sheet:<id>` keys (same namespacing as `token:<id>` and
// `roll:<id>`); the host/GM sees everything while a guest/player sees
// only próprias + compartilhadas via ACL dupla (`viewers[]`/
// `controllers[]`, `publicView`/`publicControl`). Viewers recebem só
// metadados; `gmNotes` nunca sai p/ não-GM (filtrar na ingestão).
// Legado `sheet:<userId>`/`ownerId`/`sheet:public:*` continua visível
// (migração de slots fixos). Outras partições passam intactas.

import type { Role, RoomState } from "../net/peer";
import { filterSheetForPeer } from "./acl";
import { decodeSheet, encodeSheet } from "./srd";
import type { Sheet } from "./types";

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
 * Filter a room snapshot for `role`/`userId` (peerId): host returns
 * everything, guest keeps only próprias + compartilhadas (ACL), com
 * projeção p/ metadados quando viewer e `gmNotes` removido p/
 * não-GM. Pure: a entrada nunca é mutada.
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
    const isPublicLegacy = key.startsWith(PUBLIC_SHEET_PREFIX);
    const isOwnKey = key === own;
    let sheet;
    try {
      sheet = decodeSheet(value);
    } catch {
      // Ilegível: pública legada ou chave própria passa como está
      // (migração); demais fichas: fail-closed (não vaza p/ guest).
      if (isPublicLegacy || isOwnKey) next[key] = value;
      continue;
    }
    const projected = filterSheetForPeer(sheet, userId, false);
    if (!projected) {
      // Sem acesso via ACL: chave própria legada sem ACL ainda passa
      // (migração), sem gmNotes.
      if (isOwnKey) {
        try {
          const { gmNotes: _drop, ...rest } = JSON.parse(value) as Record<
            string,
            unknown
          >;
          void _drop;
          next[key] = JSON.stringify(rest);
        } catch {
          // Ilegível: não vaza.
        }
      }
      continue;
    }
    // Preserva o wire original quando a projeção é identidade (evita
    // churn e mantém compat com snapshots legados sem gmNotes):
    // controlador sem gmNotes passa verbatim; com gmNotes re-codifica
    // sem o campo; viewer (metadados) sempre re-codifica.
    if (isController(sheet, userId) && sheet.gmNotes === undefined) {
      next[key] = value;
    } else {
      next[key] = encodeSheet(projected);
    }
  }
  return next;
}

/** Controlador direto (espelha canControl p/ decidir verbatim vs re-encode). */
function isController(sheet: Sheet, userId: string): boolean {
  if (sheet.publicControl === true) return true;
  if (sheet.controllers?.includes(userId) === true) return true;
  if (sheet.ownerId !== undefined && sheet.ownerId === userId) return true;
  return false;
}
