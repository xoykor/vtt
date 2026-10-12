// 3D dice for the table: three.js meshes that land with the
// host-resolved face up, plus a numeric fallback for hosts without a
// usable WebGL context (jsdom, CI, software renderers).
//
// Nothing here rolls. The face comes from `resolveRoll` on the host
// (src/dice/roller.ts), travels as a `roll:<id>` delta and is mapped by
// `frameForResult`/`createDiceScene` (src/dice/scene.ts); this module only
// turns that frame into meshes and one quaternion per die. There is no
// physics engine and no roll of its own.

import * as THREE from "three";
import type { RollResult } from "./roller";
import { createDiceScene, type DiceSceneFrame } from "./scene";
import {
  buildDieAtlas,
  buildDieFaceTable,
  buildDieGeometry,
  createDieMaterial,
  defaultFaceLabels,
  faceAimQuaternion,
  MESHABLE_SIDES,
  type DieFace,
} from "./die-geometry";

export { MESHABLE_SIDES };

/** Renderer in use: WebGL meshes, or the numeric readout. */
export type DiceViewMode = "webgl" | "numeric";

/** Dice rendered as meshes at once; the rest stay in the readout. */
export const MAX_3D_DICE = 8;

/** The one die size that is rolled as two percentile dice. */
const PERCENTILE = 100;
/** Distance between neighbouring dice (die radius is ~1). */
const SPACING = 2.2;
/** How long the landing rotation takes, in milliseconds. */
const LANDING_MS = 520;
/** Height a die drops from, in world units. */
const DROP = 0.5;
/** Camera height per unit of distance: ~40° above the table, like a player leaning in. */
const CAMERA_HEIGHT = 0.85;
/** How tall the WebGL canvas is, in pixels, for a few viewport widths. */
function viewHeight(width: number): number {
  return Math.min(280, Math.max(170, Math.round(width * 0.62)));
}

/** Percentile labels: tens die 00..90, units die 0..9. */
const TENS_LABELS = ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"];
const UNIT_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface ThreeDiceViewOptions {
  /**
   * WebGL probe. Defaults to asking a throwaway canvas for a context;
   * tests force either branch.
   */
  hasWebGL?: () => boolean;
}

export interface ThreeDiceView {
  /** Display a resolved roll (frame or raw result) and remember it. */
  show(input: DiceSceneFrame | RollResult): void;
  /** Drop the DOM, cancel the animation and release GL resources. */
  dispose(): void;
  /** Last shown frame, or `undefined` before the first `show`/after dispose. */
  current(): DiceSceneFrame | undefined;
  /** Which renderer is actually showing the roll. */
  mode(): DiceViewMode;
}

/** One die the view must render: its kind and the face that ends up. */
export interface DicePlan {
  /** Cache key for the meshes/atlas of this die kind. */
  kindKey: string;
  /** Die size in sides. */
  sides: number;
  /** Label per face index (blank cells stay unlabelled). */
  labels: (string | null)[];
  /** Zero-based face that must point up after landing. */
  faceIndex: number;
}

/**
 * Split a d100 face into its two d10 dice. `100` reads as `00` + `0`,
 * the same convention as physical percentile dice.
 */
export function percentileParts(value: number): { tens: number; units: number } {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`invalid percentile face: ${String(value)}`);
  }
  const units = value % 10;
  const tens = value === 100 ? 0 : Math.floor(value / 10);
  return { tens, units };
}

/** True when the view can show `sides` as meshes. */
export function isMeshable(sides: number): boolean {
  return sides === PERCENTILE || (MESHABLE_SIDES as readonly number[]).includes(sides);
}

/**
 * Turn a frame into the dice to render. A d100 becomes two d10s; a die
 * size without a mesh shape stays in the readout only. Face order only
 * depends on `sides`, so plans are stable whatever camera is in use.
 */
export function planDice(frame: DiceSceneFrame, max = MAX_3D_DICE): DicePlan[] {
  const plans: DicePlan[] = [];
  for (const face of frame.faces) {
    if (!Number.isInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex >= face.sides) {
      throw new Error(`invalid face index: ${String(face.faceIndex)} for d${face.sides}`);
    }
    if (!isMeshable(face.sides)) continue;
    if (face.sides === PERCENTILE) {
      const { tens, units } = percentileParts(face.value);
      plans.push(
        { kindKey: "d10:tens", sides: 10, labels: TENS_LABELS, faceIndex: tens },
        { kindKey: "d10:units", sides: 10, labels: UNIT_LABELS, faceIndex: units },
      );
      continue;
    }
    plans.push({
      kindKey: `d${face.sides}`,
      sides: face.sides,
      labels: defaultFaceLabels(face.sides),
      faceIndex: face.faceIndex,
    });
  }
  return plans.slice(0, Math.max(0, max));
}

/** Ask a throwaway canvas for a WebGL context. */
function probeWebGL(): boolean {
  if (typeof document === "undefined") return false;
  // jsdom/CI: the WebGL globals themselves are missing, so asking for a
  // context would only log "not implemented".
  if (typeof WebGLRenderingContext === "undefined" && typeof WebGL2RenderingContext === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGLRenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    return Boolean(gl);
  } catch {
    return false;
  }
}

/** Deterministic jitter in [0,1) so repeated rolls look varied, tests stable. */
function jitter(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** `performance.now` when available, else the wall clock. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Meshes, atlas and material for one die kind, released with the view. */
interface DieKind {
  table: DieFace[];
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/** Build the table view: three.js when a context works, numbers otherwise. */
export function createThreeDiceView(
  container: HTMLElement,
  options: ThreeDiceViewOptions = {},
): ThreeDiceView {
  const scene = createDiceScene();
  const probe = options.hasWebGL ?? probeWebGL;
  let last: DiceSceneFrame | undefined;
  let mode: DiceViewMode = "numeric";

  const root = document.createElement("div");
  root.className = "dice-3d";
  root.dataset.mode = mode;
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.alignItems = "center";
  root.style.gap = "6px";

  const readout = document.createElement("div");
  readout.className = "dice-3d-readout";
  readout.style.display = "flex";
  readout.style.flexWrap = "wrap";
  readout.style.alignItems = "baseline";
  readout.style.justifyContent = "center";
  readout.style.gap = "6px";
  readout.style.fontFamily = "var(--font-display)";
  readout.style.color = "var(--menu-gold)";
  root.appendChild(readout);
  container.appendChild(root);

  // WebGL resources, created lazily and only when a context really works.
  let renderer: THREE.WebGLRenderer | null = null;
  let world: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let observer: ResizeObserver | null = null;
  /** Direction that reads as "up" on screen; orients the numbers. */
  let screenUp = new THREE.Vector3(0, 1, 0);
  const kinds = new Map<string, DieKind>();
  let pool: THREE.Mesh[] = [];
  let frameId: number | null = null;
  let landing: {
    started: number;
    dice: { mesh: THREE.Mesh; from: THREE.Quaternion; to: THREE.Quaternion }[];
  } | null = null;

  if (probe()) attachRenderer();
  mode = world ? "webgl" : "numeric";
  root.dataset.mode = mode;

  /** Open the 3D branch; any failure keeps the numeric readout. */
  function attachRenderer(): void {
    const width = container.clientWidth || 320;
    const height = viewHeight(width);
    try {
      canvas = document.createElement("canvas");
      canvas.className = "dice-3d-canvas";
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = `${height}px`;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 2));
      renderer.setSize(width, height, false);

      world = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
      // Provisional placement: `applyLayout` moves it per roll, but the
      // direction (which fixes how numbers read) never changes.
      camera.position.set(0, CAMERA_HEIGHT, 1);
      camera.lookAt(0, 0, 0);
      screenUp = upOnScreen(camera.position);

      world.add(new THREE.AmbientLight(0xfff2d8, 1.2));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(2.5, 4.5, 3);
      world.add(key);
      const fill = new THREE.DirectionalLight(0xbfd4ff, 0.55);
      fill.position.set(-3, 1.5, -2);
      world.add(fill);

      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          if (mode === "webgl") applyLayout(pool.length);
          draw();
        });
        observer.observe(container);
      }
    } catch {
      detachRenderer();
    }
  }

  function detachRenderer(): void {
    observer?.disconnect();
    observer = null;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    landing = null;
    renderer = null;
    world = null;
    camera = null;
    if (canvas?.parentElement) canvas.remove();
    canvas = null;
    for (const kind of kinds.values()) {
      kind.geometry.dispose();
      kind.material.map?.dispose();
      kind.material.dispose();
    }
    kinds.clear();
    pool = [];
  }

  /** Direction that appears "up" on screen for a camera looking at the origin. */
  function upOnScreen(eye: THREE.Vector3): THREE.Vector3 {
    const view = eye.clone().normalize();
    return new THREE.Vector3(0, 1, 0)
      .sub(view.clone().multiplyScalar(view.y))
      .normalize();
  }

  /** Meshes/atlas/material for one die kind, cached per view. */
  function kindFor(plan: DicePlan): DieKind {
    const cached = kinds.get(plan.kindKey);
    if (cached) return cached;
    const table = buildDieFaceTable(plan.sides, screenUp);
    const kind: DieKind = {
      table,
      geometry: buildDieGeometry(table, plan.labels),
      material: createDieMaterial(buildDieAtlas(table, plan.labels)),
    };
    kinds.set(plan.kindKey, kind);
    return kind;
  }

  /** Fit the camera and drawing buffer to the container and the row width. */
  function applyLayout(count: number): void {
    if (!camera || !renderer || !canvas) return;
    // Measure the canvas box itself so the buffer matches what is shown.
    const width = canvas.clientWidth || container.clientWidth || 320;
    const height = canvas.clientHeight || viewHeight(width);
    const spread = Math.max(1, count) * SPACING + 1.8;
    camera.aspect = width / height;
    // Pull back until the whole row fits the horizontal field of view.
    const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const distance = spread / 2 / Math.max(Math.tan(halfFov) * camera.aspect, 1e-3) / 1.05;
    // Look down steeply enough that the rolled face reads at a glance.
    camera.position.set(0, distance * CAMERA_HEIGHT, distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  /** Add, reuse and remove meshes so one row matches `plans`. */
  function syncDice(plans: DicePlan[]): void {
    if (!world) return;
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const kind = kindFor(plan);
      let mesh = pool[i];
      if (!mesh || mesh.userData.kindKey !== plan.kindKey) {
        if (mesh) world.remove(mesh);
        mesh = new THREE.Mesh(kind.geometry, kind.material);
        mesh.scale.setScalar(0.95);
        mesh.userData.kindKey = plan.kindKey;
      }
      mesh.position.set((i - (plans.length - 1) / 2) * SPACING, 0, 0);
      if (mesh.parent !== world) world.add(mesh);
      meshes.push(mesh);
    }
    for (let i = plans.length; i < pool.length; i++) world.remove(pool[i]);
    pool = meshes;
  }

  /** Short landing rotation from a small wobble onto the rolled face. */
  function startLanding(plans: DicePlan[]): void {
    if (!world) return;
    landing = {
      started: now(),
      dice: plans.map((plan, i) => {
        const face = kindFor(plan).table[plan.faceIndex];
        const to = faceAimQuaternion(face, screenUp);
        // Start close by: a short wobble, never a full tumble.
        const angle = (0.2 + jitter(plan.faceIndex * 7 + i) * 0.3) * Math.PI;
        const axis = new THREE.Vector3(
          jitter(i * 13),
          jitter(i * 29 + 5),
          jitter(i * 41 + 11),
        ).normalize();
        const wobble = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        const mesh = pool[i];
        mesh.position.y = DROP;
        return { mesh, from: to.clone().multiply(wobble), to };
      }),
    };
    if (typeof requestAnimationFrame !== "function") {
      applyLanding(1); // no frames available: land at once
      draw();
      return;
    }
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
  }

  function applyLanding(progress: number): void {
    if (!landing) return;
    const eased = 1 - Math.pow(1 - progress, 3);
    for (const die of landing.dice) {
      die.mesh.quaternion.slerpQuaternions(die.from, die.to, eased);
      die.mesh.position.y = DROP * (1 - eased);
    }
  }

  function tick(time: number): void {
    frameId = null;
    if (!landing) return;
    const progress = Math.min(1, (time - landing.started) / LANDING_MS);
    applyLanding(progress);
    if (progress < 1) frameId = requestAnimationFrame(tick);
    else landing = null;
    draw();
  }

  function draw(): void {
    if (renderer && world && camera) renderer.render(world, camera);
  }

  /** Rewrite the numeric readout: one chip per die plus the total. */
  function renderReadout(frame: DiceSceneFrame): void {
    readout.replaceChildren();
    for (const face of frame.faces) {
      const chip = document.createElement("span");
      chip.className = "dice-3d-face";
      chip.dataset.die = String(face.die);
      chip.dataset.sides = String(face.sides);
      chip.dataset.face = String(face.value);
      chip.textContent = face.label;
      readout.appendChild(chip);
    }
    const total = document.createElement("span");
    total.className = "dice-3d-total";
    total.textContent = `= ${frame.total}`;
    readout.appendChild(total);
  }

  function setMode(next: DiceViewMode): void {
    // Idempotent: it must also run when the mode is already right, since
    // the canvas is only inserted the first time a roll can be shown.
    mode = next;
    root.dataset.mode = next;
    if (next === "webgl") {
      if (canvas && canvas.parentElement !== root) root.insertBefore(canvas, readout);
    } else if (canvas?.parentElement) {
      canvas.remove();
    }
  }

  function show(input: DiceSceneFrame | RollResult): void {
    // A raw RollResult goes through the ready scene, which validates the
    // faces; an already-mapped frame is shown as given.
    const raw = input as Partial<RollResult> & Partial<DiceSceneFrame>;
    const frame = Array.isArray(raw.rolls)
      ? scene.show(input as RollResult)
      : (input as DiceSceneFrame);
    last = frame;
    renderReadout(frame);
    const plans = planDice(frame);
    if (world && canvas && plans.length > 0) {
      setMode("webgl");
      applyLayout(plans.length);
      syncDice(plans);
      startLanding(plans);
      return;
    }
    setMode("numeric");
  }

  return {
    show,
    dispose(): void {
      detachRenderer();
      last = undefined;
      root.remove();
    },
    current(): DiceSceneFrame | undefined {
      return last;
    },
    mode(): DiceViewMode {
      return mode;
    },
  };
}
