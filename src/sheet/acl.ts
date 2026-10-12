// Sheet ACL dupla (Roll20/Foundry, sem slots): `viewers[]` vê só
// metadados (nome/avatar/bio), `controllers[]` vê/controla a ficha
// completa (+bio+tokens+falar como). `publicView`/`publicControl`
// = "todos". GM bypassa tudo. `gmNotes` nunca vai p/ não-GM.
// Player não re-compartilha: `sanitizeSheetWrite` trava ACL p/
// não-GM (fail-closed). Puro, hermético; sem rede/mapa.

import type { Token } from "../map/tokens";
import type { Sheet } from "./types";

/** Autor de uma escrita de ficha. */
export interface SheetAuthor {
  peerId: string;
  isGM: boolean;
}

/** Metadados visíveis a viewers: nome/avatar/bio (+id p/ chave). Stats zerados (redacted). */
export function toMetadata(sheet: Sheet): Sheet {
  const out: Sheet = {
    id: sheet.id,
    name: sheet.name,
    ac: 0,
    hp: 0,
    maxHp: 0,
  };
  if (sheet.photo !== undefined) out.photo = sheet.photo;
  if (sheet.race !== undefined) out.race = sheet.race;
  if (sheet.charClass !== undefined) out.charClass = sheet.charClass;
  if (sheet.backstory !== undefined) out.backstory = sheet.backstory;
  if (sheet.languages !== undefined) out.languages = sheet.languages;
  if (sheet.alignment !== undefined) out.alignment = sheet.alignment;
  return out;
}

/** True quando `peerId` (ou todos) pode ver ao menos metadados. GM bypassa. */
export function canView(sheet: Sheet, peerId: string, isGM: boolean): boolean {
  if (isGM) return true;
  if (sheet.publicView === true || sheet.publicControl === true) return true;
  if (sheet.controllers?.includes(peerId) === true) return true;
  if (sheet.viewers?.includes(peerId) === true) return true;
  // Legado: ownerId == peerId (migração de slots fixos).
  if (sheet.ownerId !== undefined && sheet.ownerId === peerId) return true;
  return false;
}

/** True quando `peerId` (ou todos) controla a ficha completa. GM bypassa. */
export function canControl(sheet: Sheet, peerId: string, isGM: boolean): boolean {
  if (isGM) return true;
  if (sheet.publicControl === true) return true;
  if (sheet.controllers?.includes(peerId) === true) return true;
  // Legado: ownerId == peerId controla (migração).
  if (sheet.ownerId !== undefined && sheet.ownerId === peerId) return true;
  return false;
}

/** Remove `gmNotes` p/ não-GM (puro: nunca muta a entrada). */
export function stripGmNotesForPeer(sheet: Sheet, isGM: boolean): Sheet {
  if (isGM || sheet.gmNotes === undefined) return { ...sheet };
  const next = { ...sheet };
  delete next.gmNotes;
  return next;
}

/**
 * Projeção de uma ficha p/ um peer: controllers/GM recebem a ficha
 * completa (sem `gmNotes` quando não-GM); viewers/`publicView`
 * recebem só metadados; sem acesso retorna null.
 */
export function filterSheetForPeer(
  sheet: Sheet,
  peerId: string,
  isGM: boolean,
): Sheet | null {
  if (canControl(sheet, peerId, isGM)) {
    return stripGmNotesForPeer(sheet, isGM);
  }
  if (canView(sheet, peerId, isGM)) {
    return toMetadata(sheet);
  }
  return null;
}

/**
 * Travamento de escrita (fail-closed): GM escreve ACL livremente;
 * não-GM tem `viewers`/`controllers`/`public*` ignorados.
 * Criação (`prev === null`) por player força `controllers=[author]`.
 * Campos de dados (nome/hp/...) passam sempre; só ACL é travada.
 */
export function sanitizeSheetWrite(
  prev: Sheet | null,
  next: Sheet,
  author: SheetAuthor,
): Sheet {
  if (author.isGM) return { ...next };
  const out: Sheet = { ...next };
  if (prev === null) {
    out.controllers = [author.peerId];
    out.viewers = next.viewers !== undefined ? [] : undefined;
    // Sem re-compartilhar na criação: público sempre falso p/ player.
    if (next.publicView === true || next.publicControl === true) {
      out.publicView = false;
      out.publicControl = false;
    }
    return out;
  }
  // Edição: preserva ACL existente (player não re-compartilha).
  if (prev.controllers !== undefined) out.controllers = [...prev.controllers];
  else delete out.controllers;
  if (prev.viewers !== undefined) out.viewers = [...prev.viewers];
  else delete out.viewers;
  if (prev.publicView !== undefined) out.publicView = prev.publicView;
  else delete out.publicView;
  if (prev.publicControl !== undefined) out.publicControl = prev.publicControl;
  else delete out.publicControl;
  return out;
}

/**
 * Herança de controle do token: token com `represents` delega à
 * ficha; sem ficha vinculada, só GM. Puro.
 */
export function canControlToken(
  token: Token,
  sheetsById: Map<string, Sheet> | Record<string, Sheet>,
  peerId: string,
  isGM: boolean,
): boolean {
  if (isGM) return true;
  const rep = token.represents ?? null;
  if (rep === null || rep === undefined || rep === "") return false;
  const sheet =
    sheetsById instanceof Map ? sheetsById.get(rep) : sheetsById[rep];
  if (!sheet) return false;
  return canControl(sheet, peerId, isGM);
}
