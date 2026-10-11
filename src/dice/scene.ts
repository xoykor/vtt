// Minimal dice scene (pure stub, hermetic, zero new dependencies).
//
// Three.js weight evaluation: adding `three` (~600 KB minified) plus a
// physics engine just to show a resolved roll is unjustified in v1,
// and the brief constrains Three.js to rendering only ("Three.js só
// renderiza o resultado"). So this module maps the host-resolved
// `RollResult` to the frame a renderer must display — one labeled face
// per die — with no DOM, WebGL or physics. When a real Three.js view
// lands, it consumes `frameForResult` / `createDiceScene` and animates
// towards the given faces; the authoritative value never changes.

import type { RollResult } from "./roller";

/** One die as the renderer must show it: face value and label. */
export interface DiceFaceView {
  die: number;
  sides: number;
  value: number;
  faceIndex: number;
  label: string;
}

/** Full frame for a resolved roll, including the host total. */
export interface DiceSceneFrame {
  sides: number;
  faces: DiceFaceView[];
  total: number;
}

/**
 * Map a host-resolved result to its display frame. Pure: faces are
 * zero-based indices into the die (`value - 1`), labels are the
 * tabletop reading (`d<sides>:<value>`). Throws on faces outside the
 * die — a renderer must never display an impossible face.
 */
export function frameForResult(result: RollResult): DiceSceneFrame {
  const faces = result.rolls.map((value, die) => {
    if (!Number.isInteger(value) || value < 1 || value > result.sides) {
      throw new Error(`invalid face: ${String(value)} for d${result.sides}`);
    }
    return {
      die,
      sides: result.sides,
      value,
      faceIndex: value - 1,
      label: `d${result.sides}:${value}`,
    } satisfies DiceFaceView;
  });
  return { sides: result.sides, faces, total: result.total };
}

export interface DiceScene {
  /** Display `result`, remembering it as the last shown frame. */
  show(result: RollResult): DiceSceneFrame;
  /** Last shown frame, or `undefined` before the first `show`. */
  last(): DiceSceneFrame | undefined;
}

/**
 * Create a renderer-agnostic dice scene: no canvas, no WebGL context,
 * safe to construct in tests. The Three.js view (when added) calls
 * `show` with each broadcast `RollResult` and tweens meshes towards
 * the returned faces.
 */
export function createDiceScene(): DiceScene {
  let current: DiceSceneFrame | undefined;
  return {
    show(result: RollResult): DiceSceneFrame {
      current = frameForResult(result);
      return current;
    },
    last(): DiceSceneFrame | undefined {
      return current;
    },
  };
}
