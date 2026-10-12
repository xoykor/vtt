// @vitest-environment jsdom
// Lifecycle + reduced-motion + mute gating for the vault menu backdrop.
// The 2D context is stubbed (jsdom has no canvas rasterizer); the tests
// drive frames, clicks and mute through the public handle.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prefersReducedMotion, startMenuBackdrop } from "./menu-backdrop";

interface FakeCtx {
  imageSmoothingEnabled: boolean;
  createImageData: (w: number, h: number) => { data: Uint8ClampedArray; width: number; height: number };
  putImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

const createdCtxs: FakeCtx[] = [];

function fakeCtx(): FakeCtx {
  const c: FakeCtx = {
    imageSmoothingEnabled: false,
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
  };
  createdCtxs.push(c);
  return c;
}

let rafQueue: FrameRequestCallback[] = [];
let rafNextId = 0;

function mountCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 640,
    height: 360,
    right: 640,
    bottom: 360,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return canvas;
}

beforeEach(() => {
  createdCtxs.length = 0;
  rafQueue = [];
  rafNextId = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeCtx() as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    rafNextId += 1;
    return rafNextId;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runFrames(n: number): void {
  for (let k = 0; k < n; k++) {
    const cb = rafQueue.shift();
    if (!cb) throw new Error("loop stalled: no frame scheduled");
    cb(16 * (k + 1));
  }
}

function click(canvas: HTMLCanvasElement, x = 320, y = 180): void {
  canvas.dispatchEvent(
    new window.MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }),
  );
}

test("start sizes the canvas, loops frames, and stop halts the loop", () => {
  const canvas = mountCanvas();
  const handle = startMenuBackdrop(canvas, { seed: 1234 });

  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  expect(rafQueue).toHaveLength(1);

  // A few frames paint through the offscreen buffer to the display canvas.
  runFrames(3);
  const offscreen = createdCtxs.find((c) => c.putImageData.mock.calls.length > 0);
  const display = createdCtxs.find((c) => c.drawImage.mock.calls.length > 0);
  expect(offscreen).toBeDefined();
  expect(display).toBeDefined();

  // Clicks (flare or coin rain) never throw, even over piles.
  expect(() => click(canvas, 100, 140)).not.toThrow();
  expect(() => click(canvas, 320, 300)).not.toThrow();
  runFrames(2);

  // Regenerate rebuilds the scene without restarting the loop.
  expect(() => handle.regenerate(987)).not.toThrow();
  runFrames(1);

  handle.stop();
  expect(window.cancelAnimationFrame).toHaveBeenCalled();
  const pending = rafQueue.length;
  const stale = rafQueue.shift();
  stale?.(9999);
  // A stale queued callback after stop() must not reschedule.
  expect(rafQueue).toHaveLength(pending - 1);
});

test("reduced motion paints exactly one static frame and never loops", () => {
  const canvas = mountCanvas();
  const handle = startMenuBackdrop(canvas, { reducedMotion: true, seed: 77 });

  expect(rafQueue).toHaveLength(0);
  const painted = createdCtxs.filter((c) => c.putImageData.mock.calls.length > 0);
  expect(painted).toHaveLength(1);
  expect(handle.isMuted()).toBe(false);
  expect(() => handle.regenerate(78)).not.toThrow();
  // Regenerating the static frame repaints once more, still no loop.
  expect(rafQueue).toHaveLength(0);
  expect(() => handle.stop()).not.toThrow();
});

test("matchMedia reduce is honored without an explicit flag", () => {
  const matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("matchMedia", matchMedia);
  expect(prefersReducedMotion()).toBe(true);

  const canvas = mountCanvas();
  const handle = startMenuBackdrop(canvas, { seed: 5 });
  expect(rafQueue).toHaveLength(0);
  handle.stop();
});

test("muted start never constructs an AudioContext; unmuted click does", () => {
  const ctor = vi.fn().mockImplementation(() => {
    throw new Error("no audio device");
  });
  (window as unknown as Record<string, unknown>).AudioContext = ctor;

  try {
    const quiet = mountCanvas();
    const quietHandle = startMenuBackdrop(quiet, { muted: true, seed: 11 });
    expect(quietHandle.isMuted()).toBe(true);
    click(quiet, 200, 150);
    runFrames(2);
    expect(ctor).not.toHaveBeenCalled();
    quietHandle.stop();

    const loud = mountCanvas();
    const loudHandle = startMenuBackdrop(loud, { seed: 12 });
    expect(loudHandle.isMuted()).toBe(false);
    click(loud, 200, 150);
    expect(ctor).toHaveBeenCalled();
    // Failed construction falls back to silence, never throws.
    runFrames(2);
    loudHandle.setMuted(true);
    expect(loudHandle.isMuted()).toBe(true);
    click(loud, 200, 150);
    runFrames(1);
    loudHandle.stop();
  } finally {
    delete (window as unknown as Record<string, unknown>).AudioContext;
  }
});
