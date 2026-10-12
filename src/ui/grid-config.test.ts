// @vitest-environment jsdom
import { expect, test } from "vitest";
import {
  DEFAULT_GRID_CONFIG,
  formatDistance,
  loadGridConfig,
  renderGridPanel,
  sanitizeGridConfig,
  saveGridConfig,
  snapPoint,
} from "./grid-config";

/** In-memory Storage stub so tests never touch the real localStorage. */
function memoryStorage(initial?: Record<string, string>): Storage {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

test("defaults are a 32px square grid with snapping on", () => {
  expect(DEFAULT_GRID_CONFIG).toEqual({
    type: "square",
    size: 32,
    opacity: 0.5,
    color: "#8a8a9a",
    snapping: true,
  });
});

test("sanitize keeps good values and repairs bad ones", () => {
  expect(sanitizeGridConfig(undefined)).toEqual(DEFAULT_GRID_CONFIG);
  expect(sanitizeGridConfig(null)).toEqual(DEFAULT_GRID_CONFIG);
  expect(
    sanitizeGridConfig({ type: "hex-h", size: 48, opacity: 0.8, color: "#ff0000", snapping: false }),
  ).toEqual({ type: "hex-h", size: 48, opacity: 0.8, color: "#ff0000", snapping: false });
  const repaired = sanitizeGridConfig({
    type: "triangle",
    size: 3,
    opacity: 9,
    color: "red",
    snapping: "yes",
  });
  // Out-of-range numbers clamp into range instead of resetting.
  expect(repaired).toEqual({ ...DEFAULT_GRID_CONFIG, size: 8, opacity: 1 });
  // Float sizes round to whole pixels.
  expect(sanitizeGridConfig({ size: 40.7 }).size).toBe(41);
});

test("load/save round-trips through storage, failures fall back to defaults", () => {
  const storage = memoryStorage();
  expect(loadGridConfig(storage)).toEqual(DEFAULT_GRID_CONFIG);
  saveGridConfig(storage, { ...DEFAULT_GRID_CONFIG, type: "hex-v", size: 48 });
  expect(loadGridConfig(storage)).toMatchObject({ type: "hex-v", size: 48 });

  expect(loadGridConfig(memoryStorage({ "vtt:grid-config": "{broken" }))).toEqual(
    DEFAULT_GRID_CONFIG,
  );
  expect(loadGridConfig(null)).toEqual(DEFAULT_GRID_CONFIG);
  // A throwing storage never breaks the caller.
  const evil = memoryStorage();
  evil.setItem = () => {
    throw new Error("denied");
  };
  expect(() => saveGridConfig(evil, DEFAULT_GRID_CONFIG)).not.toThrow();
});

test("panel edits persist to storage and notify", () => {
  const storage = memoryStorage();
  const seen: string[] = [];
  const box = document.createElement("div");
  const panel = renderGridPanel(box, {
    storage,
    onChange: (cfg) => seen.push(cfg.type),
  });
  expect(panel.get().type).toBe("square");

  const type = box.querySelector<HTMLSelectElement>("[data-testid=grid-type]")!;
  type.value = "gridless";
  type.dispatchEvent(new Event("change"));
  expect(panel.get().type).toBe("gridless");
  expect(seen).toEqual(["gridless"]);
  expect(JSON.parse(storage.getItem("vtt:grid-config")!).type).toBe("gridless");

  const size = box.querySelector<HTMLInputElement>("[data-testid=grid-size]")!;
  size.value = "64";
  size.dispatchEvent(new Event("change"));
  expect(panel.get().size).toBe(64);

  const snap = box.querySelector<HTMLInputElement>("[data-testid=grid-snapping]")!;
  snap.click();
  expect(panel.get().snapping).toBe(false);
});

test("snapping rounds to the cell and Ctrl temporarily disables it", () => {
  const cfg = { ...DEFAULT_GRID_CONFIG, size: 32 };
  expect(snapPoint(cfg, 40, 50)).toEqual({ x: 32, y: 64 });
  // Ctrl held: raw position passes through.
  expect(snapPoint(cfg, 40, 50, true)).toEqual({ x: 40, y: 50 });
  // Snapping off or gridless: no rounding either.
  expect(snapPoint({ ...cfg, snapping: false }, 40, 50)).toEqual({ x: 40, y: 50 });
  expect(snapPoint({ ...cfg, type: "gridless" }, 40, 50)).toEqual({ x: 40, y: 50 });
});

test("distance formats in squares and feet (5 ft per square)", () => {
  expect(formatDistance(0, 32)).toBe("0 quadrados (0 ft)");
  expect(formatDistance(32, 32)).toBe("1 quadrado (5 ft)");
  expect(formatDistance(96, 32)).toBe("3 quadrados (15 ft)");
  expect(formatDistance(48, 32)).toBe("1,5 quadrados (10 ft)");
});
