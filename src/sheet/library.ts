// Saved-character library persistence (local, offline-first).
// Sheets persist as a JSON array under `LIBRARY_STORAGE_KEY` in the
// injected storage (localStorage in the app, memory in tests). Loads
// are fail-closed: corrupt JSON or invalid entries never throw — they
// resolve to an empty list or skip the bad entry.

import { decodeSheet, encodeSheet } from "./srd";
import type { Sheet } from "./types";

/** localStorage key for the saved-character library. */
export const LIBRARY_STORAGE_KEY = "vtt-char-library-v1";

/** Minimal storage surface (localStorage-compatible, memory in tests). */
export interface LibraryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Load saved sheets; corrupt payloads resolve to `[]` (fail-closed). */
export function loadLibrary(storage: LibraryStorage): Sheet[] {
  let raw: string | null;
  try {
    raw = storage.getItem(LIBRARY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Sheet[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    try {
      out.push(decodeSheet(JSON.stringify(entry)));
    } catch {
      // Invalid entry: skip, keep the valid ones.
    }
  }
  return out;
}

/** Persist sheets (tolerant: storage failures never throw). */
export function saveLibrary(sheets: Sheet[], storage: LibraryStorage): void {
  try {
    const payload = JSON.stringify(sheets.map((s) => JSON.parse(encodeSheet(s))));
    storage.setItem(LIBRARY_STORAGE_KEY, payload);
  } catch {
    // Local persistence is best-effort (private mode, quota).
  }
}

/** Add a sheet, replacing any entry with the same id (no duplicates). */
export function addSheetToLibrary(sheets: Sheet[], sheet: Sheet): Sheet[] {
  const next = sheets.filter((s) => s.id !== sheet.id);
  next.push(sheet);
  return next;
}

/** Rewrite an existing entry (same semantics as add; kept for intent). */
export function updateSheetInLibrary(sheets: Sheet[], sheet: Sheet): Sheet[] {
  return addSheetToLibrary(sheets, sheet);
}

/** Drop one entry by id; unknown ids leave the list untouched. */
export function removeSheetFromLibrary(sheets: Sheet[], id: string): Sheet[] {
  return sheets.filter((s) => s.id !== id);
}
