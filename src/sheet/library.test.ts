// @vitest-environment jsdom
// Character library persistence: localStorage round-trip, tolerant
// loads (corrupt entries never brick the library), add/update/remove.
import { expect, test } from "vitest";
import {
  addSheetToLibrary,
  LIBRARY_STORAGE_KEY,
  loadLibrary,
  removeSheetFromLibrary,
  saveLibrary,
  updateSheetInLibrary,
  type LibraryStorage,
} from "./library";
import type { Sheet } from "./types";

function memStorage(seed?: Record<string, string>): LibraryStorage {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

function sheet(id: string, name: string): Sheet {
  return { id, name, ac: 10, hp: 8, maxHp: 8 } as Sheet;
}

test("empty storage loads an empty library", () => {
  expect(loadLibrary(memStorage())).toEqual([]);
});

test("save then load round-trips name, class, level and photo", () => {
  const storage = memStorage();
  const hero = {
    ...sheet("sheet-1", "Borin"),
    charClass: "Guerreiro",
    level: 3,
    photo: "data:image/png;base64,AAA",
  } as Sheet;
  saveLibrary([hero], storage);
  const loaded = loadLibrary(storage);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("Borin");
  expect(loaded[0].charClass).toBe("Guerreiro");
  expect(loaded[0].level).toBe(3);
  expect(loaded[0].photo).toBe("data:image/png;base64,AAA");
});

test("corrupt JSON loads empty instead of throwing", () => {
  const storage = memStorage({ [LIBRARY_STORAGE_KEY]: "not-json{{{" });
  expect(loadLibrary(storage)).toEqual([]);
});

test("invalid entries are skipped, valid ones survive", () => {
  const storage = memStorage({
    [LIBRARY_STORAGE_KEY]: JSON.stringify([
      { id: "good", name: "Celia", ac: 12, hp: 10, maxHp: 10 },
      { nope: true },
      "just-a-string",
      { id: "", name: "", ac: 0, hp: 0, maxHp: 0 },
    ]),
  });
  const loaded = loadLibrary(storage);
  expect(loaded.map((s) => s.id)).toEqual(["good"]);
});

test("add replaces the same id instead of duplicating", () => {
  const first = addSheetToLibrary([], sheet("a", "Borin"));
  const second = addSheetToLibrary(first, { ...sheet("a", "Borin II") });
  expect(second).toHaveLength(1);
  expect(second[0].name).toBe("Borin II");
});

test("update rewrites the entry, remove drops only the target", () => {
  const start = [sheet("a", "Borin"), sheet("b", "Celia")];
  const updated = updateSheetInLibrary(start, { ...sheet("a", "Borin Novo") });
  expect(updated.find((s) => s.id === "a")?.name).toBe("Borin Novo");
  expect(updated).toHaveLength(2);
  const afterRemove = removeSheetFromLibrary(updated, "a");
  expect(afterRemove.map((s) => s.id)).toEqual(["b"]);
  // Removing an unknown id is a noop.
  expect(removeSheetFromLibrary(afterRemove, "missing")).toHaveLength(1);
});
