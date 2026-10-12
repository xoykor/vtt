// @vitest-environment jsdom
//
// The 3D view needs a real WebGL context, which jsdom does not provide,
// so this suite pins the three things that must hold everywhere: the
// numeric fallback (jsdom/CI), graceful degradation when a context is
// claimed but unusable, and the pure geometry that decides where a face
// lands. The host still decides the face (src/dice/roller.ts) — this
// view only shows it.

import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import {
  buildDieAtlas,
  buildDieFaceTable,
  buildDieGeometry,
  defaultFaceLabels,
} from "./die-geometry";
import { resolveRoll } from "./roller";
import { frameForResult, type DiceSceneFrame } from "./scene";
import {
  createThreeDiceView,
  MAX_3D_DICE,
  MESHABLE_SIDES,
  percentileParts,
  planDice,
} from "./three-scene";
import { faceAimQuaternion } from "./die-geometry";

/**
 * Screen-up hint for a camera above the table at ~25°: the frames are
 * built against it, exactly as the view does with its own camera.
 */
const UP_HINT = new THREE.Vector3(0, 1, 0)
  .sub(new THREE.Vector3(0, 0.42, 1).normalize().multiplyScalar(0.42))
  .normalize();

function mount(): HTMLDivElement {
  const box = document.createElement("div");
  document.body.appendChild(box);
  return box;
}

function stubRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("fallback shows the face the host resolved", () => {
  const box = mount();
  const view = createThreeDiceView(box);
  expect(view.mode()).toBe("numeric"); // jsdom has no WebGL context

  const result = resolveRoll({ sides: 20 }, () => 0.74);
  const frame = frameForResult(result);
  expect(frame.faces[0].value).toBe(15);

  view.show(frame);

  const faces = box.querySelectorAll(".dice-3d-face");
  expect(faces).toHaveLength(1);
  expect(faces[0].getAttribute("data-die")).toBe("0");
  expect(faces[0].getAttribute("data-sides")).toBe("20");
  expect(faces[0].getAttribute("data-face")).toBe("15");
  expect(faces[0].textContent).toBe("d20:15");
  expect(box.querySelector(".dice-3d-total")?.textContent).toBe("= 15");
  expect(view.current()).toEqual(frame);
});

test("every die of a multi-die roll gets its own face", () => {
  const box = mount();
  const view = createThreeDiceView(box);
  const frame = frameForResult(
    resolveRoll({ sides: 6, count: 3, mod: 2 }, stubRng([0, 0.5, 0.99])),
  );
  expect(frame.faces.map((f) => f.value)).toEqual([1, 4, 6]);

  view.show(frame);

  expect(box.querySelectorAll(".dice-3d-face")).toHaveLength(3);
  const shown = Array.from(box.querySelectorAll(".dice-3d-face")).map((el) =>
    el.getAttribute("data-face"),
  );
  expect(shown).toEqual(["1", "4", "6"]);
  expect(box.querySelector(".dice-3d-total")?.textContent).toBe("= 13");
  expect(view.current()?.total).toBe(13);
});

test("show also accepts the raw host result", () => {
  const box = mount();
  const view = createThreeDiceView(box);

  view.show(resolveRoll({ sides: 8 }, () => 0.5)); // floor(0.5 * 8) + 1

  const face = box.querySelector(".dice-3d-face");
  expect(face?.getAttribute("data-face")).toBe("5");
  expect(face?.textContent).toBe("d8:5");
});

test("show replaces the previous roll", () => {
  const box = mount();
  const view = createThreeDiceView(box);
  view.show(resolveRoll({ sides: 4 }, () => 0)); // 1
  view.show(resolveRoll({ sides: 4 }, () => 0.75)); // 4

  expect(box.querySelectorAll(".dice-3d-face")).toHaveLength(1);
  expect(box.querySelector(".dice-3d-face")?.getAttribute("data-face")).toBe("4");
  expect(box.querySelector(".dice-3d-total")?.textContent).toBe("= 4");
});

test("dispose empties the container and forgets the frame", () => {
  const box = mount();
  const view = createThreeDiceView(box);
  view.show(resolveRoll({ sides: 20 }, () => 0.74));

  view.dispose();

  expect(box.childElementCount).toBe(0);
  expect(box.textContent).toBe("");
  expect(view.current()).toBeUndefined();
});

test("a claimed WebGL context that cannot render degrades to numbers", () => {
  const box = mount();
  // jsdom exposes no context, so this forces the 3D branch with a
  // context that cannot actually render: the view must not throw.
  const view = createThreeDiceView(box, { hasWebGL: () => true });

  expect(view.mode()).toBe("numeric");
  expect(() => view.show(resolveRoll({ sides: 20 }, () => 0.74))).not.toThrow();
  expect(box.querySelector(".dice-3d-face")?.getAttribute("data-face")).toBe("15");
});

test("a canvas that refuses every context does not throw", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    throw new Error("context denied");
  });
  const box = mount();

  expect(() => {
    const view = createThreeDiceView(box);
    view.show(resolveRoll({ sides: 6 }, () => 0.5));
    view.dispose();
  }).not.toThrow();
  expect(box.childElementCount).toBe(0);
});

test("unsupported dice stay numeric even with WebGL", () => {
  const box = mount();
  const view = createThreeDiceView(box, { hasWebGL: () => true });

  view.show(resolveRoll({ sides: 3 }, () => 0.5)); // d3 has no mesh shape

  expect(view.mode()).toBe("numeric");
  expect(box.querySelector(".dice-3d-face")?.textContent).toBe("d3:2");
});

test("a roll of many dice still renders without throwing", () => {
  const box = mount();
  const view = createThreeDiceView(box);
  const frame = frameForResult(resolveRoll({ sides: 20, count: 12 }, () => 0.42));

  view.show(frame);

  expect(frame.faces).toHaveLength(12);
  expect(box.querySelectorAll(".dice-3d-face")).toHaveLength(12);
  expect(view.mode()).toBe("numeric");
});

test("face tables carry one labeled face per side", () => {
  for (const sides of MESHABLE_SIDES) {
    const table = buildDieFaceTable(sides);
    expect(
      table.filter((face) => face.labeled),
      `d${sides}`,
    ).toHaveLength(sides);
  }
});

test("face frames are flat, outward and read upright", () => {
  for (const sides of [4, 6, 8, 10, 12, 20]) {
    const table = buildDieFaceTable(sides, UP_HINT);
    const normals = new Set<string>();
    for (const face of table) {
      normals.add(face.normal.toArray().map((v) => v.toFixed(4)).join(","));

      // Flat: one outward normal, every triangle inside that plane.
      const centroid = new THREE.Vector3();
      let plane = 0;
      let count = 0;
      for (const tri of face.triangles) {
        for (const v of tri) {
          centroid.add(v);
          plane += v.dot(face.normal);
          count += 1;
        }
      }
      centroid.divideScalar(count);

      expect(face.normal.length(), `d${sides} unit normal`).toBeCloseTo(1);
      expect(face.normal.dot(centroid), `d${sides} outward`).toBeGreaterThan(0);
      expect(Math.abs(plane / count - centroid.dot(face.normal)), `d${sides} flat`).toBeLessThan(
        1e-9,
      );

      // Tangent frame: orthonormal, perpendicular, reads upright.
      expect(face.tangent.length(), `d${sides} tangent`).toBeCloseTo(1);
      expect(face.right.length(), `d${sides} right`).toBeCloseTo(1);
      expect(face.tangent.dot(face.normal), `d${sides} tangent ⊥ normal`).toBeCloseTo(0);
      expect(face.right.dot(face.normal), `d${sides} right ⊥ normal`).toBeCloseTo(0);
      expect(face.right.dot(face.tangent), `d${sides} right ⊥ tangent`).toBeCloseTo(0);
      expect(face.tangent.dot(UP_HINT), `d${sides} reads up`).toBeGreaterThanOrEqual(0);
    }
    // One distinct normal per face: no two faces overlap.
    expect(normals.size, `d${sides} distinct faces`).toBe(table.length);
  }
});

test("aiming a face puts it on top with the number upright", () => {
  const table = buildDieFaceTable(6, UP_HINT);
  for (const face of table) {
    const q = faceAimQuaternion(face, UP_HINT);
    const normal = face.normal.clone().applyQuaternion(q);
    const tangent = face.tangent.clone().applyQuaternion(q);
    expect(normal.y).toBeCloseTo(1);
    expect(Math.hypot(normal.x, normal.z)).toBeLessThan(1e-9);
    expect(tangent.y).toBeCloseTo(0);
    expect(tangent.dot(UP_HINT)).toBeGreaterThan(0);
  }
});

/** Recording 2D context: only what the atlas drawing uses. */
function recordingContext(drawn: { label: string; size: number }[]): CanvasRenderingContext2D {
  const noop = (): void => undefined;
  const ctx = {
    fillText: (label: string, _x: number, _y: number): void => {
      drawn.push({ label, size: Number.parseFloat(font.split(" ")[1] ?? "0") });
    },
    fillRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    fill: noop,
    stroke: noop,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  let font = "";
  Object.defineProperty(ctx, "font", {
    get: () => font,
    set: (value: string) => {
      font = value;
    },
  });
  return ctx as unknown as CanvasRenderingContext2D;
}

test("the atlas draws one number per labelled face", () => {
  const drawn: { label: string; size: number }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind: string) =>
    kind === "2d" ? recordingContext(drawn) : null,
  );

  const table = buildDieFaceTable(6);
  const atlas = buildDieAtlas(table, defaultFaceLabels(6));

  expect(drawn.map((d) => d.label)).toEqual(["1", "2", "3", "4", "5", "6"]);
  // 6 labelled faces + the blank cell, laid out in a square-ish grid.
  expect(atlas.width).toBe(256 * Math.ceil(Math.sqrt(7)));
  expect(atlas.height).toBe(atlas.width);
});

test("the coin rim leaves the blank cell undrawn", () => {
  const drawn: { label: string; size: number }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind: string) =>
    kind === "2d" ? recordingContext(drawn) : null,
  );

  buildDieAtlas(buildDieFaceTable(2), defaultFaceLabels(2));

  expect(drawn.map((d) => d.label)).toEqual(["1", "2"]);
});

test("numbers shrink on faces that are narrower than their bounding box", () => {
  const drawn: { label: string; size: number }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind: string) =>
    kind === "2d" ? recordingContext(drawn) : null,
  );

  buildDieAtlas(buildDieFaceTable(6), defaultFaceLabels(6));
  const cube = drawn[0].size;
  const cubeCount = drawn.length;
  buildDieAtlas(buildDieFaceTable(20), defaultFaceLabels(20));
  const triangle = drawn[cubeCount].size;

  // A d20 face is a triangle inscribed in its UV cell, so its number
  // must be smaller than the number on a square d6 face.
  expect(cube).toBeGreaterThan(60);
  expect(triangle).toBeLessThan(cube);
});

test("die uvs stay inside the atlas cell", () => {
  for (const sides of [4, 6, 10, 20]) {
    const geometry = buildDieGeometry(buildDieFaceTable(sides, UP_HINT), defaultFaceLabels(sides));
    const uv = geometry.getAttribute("uv");
    expect(uv.count).toBe(geometry.getAttribute("position").count);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      expect(u, `d${sides} u`).toBeGreaterThanOrEqual(0);
      expect(u, `d${sides} u`).toBeLessThanOrEqual(1);
      expect(v, `d${sides} v`).toBeGreaterThanOrEqual(0);
      expect(v, `d${sides} v`).toBeLessThanOrEqual(1);
    }
  }
});

test("percentile faces split into two d10 dice", () => {
  expect(percentileParts(7)).toEqual({ tens: 0, units: 7 });
  expect(percentileParts(10)).toEqual({ tens: 1, units: 0 });
  expect(percentileParts(45)).toEqual({ tens: 4, units: 5 });
  expect(percentileParts(95)).toEqual({ tens: 9, units: 5 });
  expect(percentileParts(100)).toEqual({ tens: 0, units: 0 });
  expect(() => percentileParts(0)).toThrow(/invalid percentile/);
  expect(() => percentileParts(101)).toThrow(/invalid percentile/);
});

test("plans cap the meshes and never index a missing face", () => {
  const single = planDice(frameForResult(resolveRoll({ sides: 20 }, () => 0.74)));
  expect(single).toHaveLength(1);
  expect(single[0].sides).toBe(20);
  expect(single[0].faceIndex).toBe(14); // face 15

  const percentile = planDice(frameForResult(resolveRoll({ sides: 100 }, () => 0.56)));
  expect(percentile.map((d) => d.kindKey)).toEqual(["d10:tens", "d10:units"]);
  expect(percentile.map((d) => d.faceIndex)).toEqual([5, 7]); // 57 = 50 + 7

  const crowd = planDice(frameForResult(resolveRoll({ sides: 20, count: 40 }, () => 0.74)));
  expect(crowd).toHaveLength(MAX_3D_DICE);

  expect(() => planDice(frameWithIndex(99))).toThrow(/invalid face index/);
});

function frameWithIndex(index: number): DiceSceneFrame {
  return {
    sides: 6,
    total: 7,
    faces: [{ die: 0, sides: 6, value: 7, faceIndex: index, label: "d6:7" }],
  };
}
