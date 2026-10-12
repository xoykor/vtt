// Animated menu backdrop: torch-lit treasure vault ("O Cofre Esquecido").
//
// TypeScript port of the self-contained pixel-art scene (320x180 software
// render: gold piles, chests, gems, eyes in the dark, torch flame, dust and
// ember particles, mouse parallax, click flare / coin rain). The visuals,
// light model and motion are kept faithful to the original; only the
// platform glue changed:
//
// - Audio KEPT: torch crackle + water drips + coin sparkle, all procedural
//   (Web Audio, no assets). It starts on the first click, following the
//   browser autoplay policy (AudioContext is created/resumed inside the
//   pointerdown handler). Mute is supported via options + setMuted().
// - R-regenerate is OPT-IN (options.regenerateOnR, default false): the menu
//   has a text field (IP:porta) and a global "r" hotkey would fire while
//   typing, so regeneration stays off unless the caller asks for it.
// - prefers-reduced-motion renders ONE static frame (no loop, no audio,
//   no parallax listeners).
// - Pause: the loop skips work while document.hidden (as the original) and
//   stop() cancels the frame + removes every listener + suspends audio.
// - CPU: the scene always renders at 320x180; the visible canvas uses an
//   integer contain scale capped at maxScale (default 4, i.e. at most
//   1280x720 backing pixels) and CSS stretches it over the menu with
//   pixelated rendering, so the GPU does the final upscale.

export interface MenuBackdropOptions {
  /** Scene seed (default 0x5eed1e, the original's). */
  seed?: number;
  /** Enable the "R generates a new vault" hotkey (default false). */
  regenerateOnR?: boolean;
  /** Start muted (no AudioContext is created until unmuted). */
  muted?: boolean;
  /** Force/lift the reduced-motion path (default: matchMedia detect). */
  reducedMotion?: boolean;
  /** Integer upscale cap for the visible canvas (default 4). */
  maxScale?: number;
}

export interface MenuBackdropHandle {
  readonly canvas: HTMLCanvasElement;
  /** Rebuild the vault with a new variation (advances the seed by default). */
  regenerate(seed?: number): void;
  /** Mute/unmute the procedural audio (menu persists the choice). */
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Cancel the loop, remove listeners, suspend audio. */
  stop(): void;
}

const W = 320;
const H = 180;
const N = W * H;
const VX = 160;
const VY = 88;
const DEFAULT_SEED = 0x5eed1e;

/* ============ 1. CONFIG E PALETA (32 cores em rampas) ============ */
const HEX = [
  0x0b0d14, 0x151a24, 0x222b38, 0x33414f, 0x4b5d68, 0x6c8089, // 0-5 pedra fria
  0x1f3a22, 0x2f5a2c, 0x4f7f35, // 6-8 musgo
  0xffe680, 0xf5c542, 0xd99a1e, 0xa8651a, 0x6b3d14, // 9-13 ouro
  0x3b2414, 0x5e3a1f, 0x82552c, // 14-16 madeira
  0x2a2e38, 0x4a505e, 0x7d8594, // 17-19 ferro
  0xc8243c, 0x2fbf6a, 0x3a7be0, 0x9a4ae0, // 20-23 gemas
  0xfffbd0, 0xffd54a, 0xff9a1f, 0xe0501a, 0x8a1e12, // 24-28 fogo
  0xff2a2a, 0xb01818, 0x601010, // 29-31 sangue (só os olhos)
];
const PAL = HEX.map((h) => (0xff000000 | ((h & 255) << 16) | (h & 0xff00) | (h >> 16)) >>> 0);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bay = (x: number, y: number): number => BAYER[((y & 3) << 2) | (x & 3)];
const sh = (c: number, f: number): number => {
  const r = Math.min(255, (c & 255) * f);
  const g = Math.min(255, ((c >>> 8) & 255) * f);
  const b = Math.min(255, ((c >>> 16) & 255) * f);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
};

/* ============ 2. PRNG E RUÍDO ============ */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hs = (x: number, y: number, s = 0): number => {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const sm = (t: number): number => t * t * (3 - 2 * t);
function vn(x: number, y: number, s = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = sm(x - xi);
  const fy = sm(y - yi);
  const a = hs(xi, yi, s);
  const b = hs(xi + 1, yi, s);
  const c = hs(xi, yi + 1, s);
  const d = hs(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const n1 = (t: number, s: number): number => {
  const i = Math.floor(t);
  const a = hs(i, 0, s);
  return a + (hs(i + 1, 0, s) - a) * sm(t - i);
};

interface Layer {
  a: Uint32Array;
  d: number;
  p: number;
  ox: number;
  oy: number;
}
interface Pile {
  x: number;
  y: number;
  w: number;
  h: number;
  L: Layer;
}
interface Eye {
  x: number;
  x0: number;
  tx: number;
  y: number;
  z: number;
  sz: number;
  gap: number;
  a: number;
  on: number;
  hold: number;
  cl: number;
  nb: number;
  nm: number;
}

/** True when the OS asks for reduced motion (guarded for test DOMs). */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  } catch {
    // No matchMedia: assume full motion.
  }
  return false;
}

/**
 * Start the vault scene on `canvas`. Returns a handle; call stop() when the
 * menu hides. When reduced motion applies, a single static frame is painted
 * (no loop, no audio) and stop() only removes the resize listener.
 */
export function startMenuBackdrop(
  canvas: HTMLCanvasElement,
  opts: MenuBackdropOptions = {},
): MenuBackdropHandle {
  const maxScale = Math.max(1, Math.min(8, Math.floor(opts.maxScale ?? 4)));
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  let muted = opts.muted ?? false;
  let seed = (opts.seed ?? DEFAULT_SEED) >>> 0;

  const ctxOrNull = canvas.getContext("2d");
  const bc = document.createElement("canvas");
  bc.width = W;
  bc.height = H;
  const bctxOrNull = bc.getContext("2d");
  // No 2D context (rare/test DOMs): inert handle, CSS gradient stays behind.
  if (ctxOrNull === null || bctxOrNull === null) {
    return {
      canvas,
      regenerate: () => undefined,
      setMuted: (m: boolean) => {
        muted = m;
      },
      isMuted: () => muted,
      stop: () => undefined,
    };
  }
  const ctx: CanvasRenderingContext2D = ctxOrNull;
  const bctx: CanvasRenderingContext2D = bctxOrNull;

  const img = bctx.createImageData(W, H);
  const out = new Uint32Array(img.data.buffer);
  const sc = new Uint32Array(N);
  const dep = new Uint8Array(N);

  let R: () => number = Math.random;
  let R2: () => number = Math.random;
  let T = 0;
  const rr = (a: number, b: number): number => a + R() * (b - a);
  const r2 = (a: number, b: number): number => a + R2() * (b - a);

  /* ============ 3. CAMADAS, TEXTURAS E SPRITES ============ */
  const mkL = (d: number, p: number): Layer => ({ a: new Uint32Array(N), d, p, ox: 0, oy: 0 });
  const L0 = mkL(0, 0.12);
  const L1 = mkL(190, 0.35);
  const L2 = mkL(110, 0.7);
  const LW = mkL(130, 0.55);
  const L3 = mkL(25, 1);
  const LAY = [L0, L1, L2, LW, L3];
  const D0 = new Uint8Array(N);
  const SH = new Uint8Array(N);
  let spk: Array<[number, number, Layer]> = [];
  let gems: Array<[number, number, number, Layer]> = [];
  let piles: Pile[] = [];
  let pil: Array<[number, number, number, number]> = [];
  let eyes: Eye[] = [];

  const P = (L: Layer, x: number, y: number, c: number): void => {
    x |= 0;
    y |= 0;
    if (x >= 0 && x < W && y >= 0 && y < H) L.a[y * W + x] = c;
  };
  const rect = (L: Layer, x: number, y: number, w: number, h: number, c: number): void => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) P(L, x + i, y + j, c);
  };
  const disc = (L: Layer, cx: number, cy: number, r: number, c: number): void => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + r) P(L, cx + i, cy + j, c);
  };
  function line(L: Layer | null, x0: number, y0: number, x1: number, y1: number, c: number): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      plot(L, x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) {
        e += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        e += dx;
        y0 += sy;
      }
    }
  }
  function plot(L: Layer | null, x: number, y: number, c: number): void {
    if (L) P(L, x, y, c);
    else ep(x, y, c);
  }
  const clampI = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

  function genEnv(L: Layer, sd: number): void {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const ux = (x - VX) / 118;
        const sy = y < VY ? (VY - y) / 70 : (y - VY) / 92;
        const u = Math.abs(ux);
        const s = Math.max(u, sy);
        const i = y * W + x;
        D0[i] = Math.min(255, (1 - s) * 290) | 0;
        if (s < 0.2) {
          const row = y >> 2;
          const bx = x + (row & 1) * 3;
          const bk = (bx / 6) | 0;
          L.a[i] =
            (y & 3) === 0 || bx % 6 === 0
              ? PAL[1]
              : sh(PAL[2 + ((hs(bk, row, sd) * 3) | 0)], 0.8 + hs(bk, row, 1) * 0.4);
          D0[i] = 255;
          continue;
        }
        let a: number;
        let b: number;
        let fl = 0;
        if (sy >= u) {
          const k = Math.max(sy, 0.05);
          a = ux / k;
          b = 1 / k;
          fl = y >= VY ? 1 : 2;
        } else {
          const k = Math.max(u, 0.05);
          a = (y - VY) / 92 / k;
          b = 1 / k;
        }
        a *= 3.2;
        b *= 3.2;
        a += hs(0, Math.floor(b), sd) * 2;
        const fa = a - Math.floor(a);
        const fb = b - Math.floor(b);
        const cell = hs(Math.floor(a), Math.floor(b), sd + 3);
        const v =
          0.2 +
          0.5 * cell +
          0.3 * (vn(x * 0.14, y * 0.14, sd) - 0.5) +
          0.1 * (hs(x, y, sd) - 0.5) +
          (fl === 1 ? 0.08 : 0) -
          (fl === 2 ? 0.1 : 0);
        let idx = clampI(1 + ((v * 5) | 0), 1, 5);
        if (fa < 0.06 || fb < 0.08 || Math.abs(vn(x * 0.09, y * 0.09, sd + 5) - 0.5) < 0.012) idx = 1;
        const mv = vn(x * 0.11, y * 0.2, sd + 8);
        if (mv > 0.7 && (fl === 1 || y > VY + 10)) idx = 6 + Math.min(2, ((mv - 0.7) * 9) | 0);
        L.a[i] = PAL[idx];
      }
    for (let k = 0; k < 46; k++) {
      const s = rr(0.3, 1);
      const x = (VX + rr(-0.85, 0.85) * s * 118) | 0;
      const y = (VY + s * 92) | 0;
      P(L, x, y, PAL[10]);
      P(L, x + 1, y, PAL[s > 0.62 ? 9 : 11]);
      if (s > 0.62) {
        P(L, x, y + 1, PAL[12]);
        P(L, x + 1, y + 1, PAL[13]);
      }
      if (R() < 0.5) spk.push([x, y, L]);
    }
  }

  function cyl(L: Layer, cx: number, y0: number, y1: number, w: number, sd: number): void {
    const h2 = w / 2;
    for (let y = y0; y <= y1; y++)
      for (let i = Math.ceil(-h2); i < h2; i++) {
        const t = i / h2;
        const x = cx + i;
        const v =
          0.5 +
          t * 0.28 -
          Math.pow(Math.abs(t), 3) * 0.3 +
          (vn(x * 0.5, y * 0.15, sd) - 0.5) * 0.5 +
          (hs(x, y, sd) - 0.5) * 0.14;
        let idx = clampI(1 + ((v * 5) | 0), 1, 5);
        if (y < y0 + 3 || y > y1 - 3) idx = Math.min(5, idx + 1);
        const mv = vn(x * 0.3, y * 0.06, sd + 2);
        if (mv > 0.64 && (y > y0 + (y1 - y0) * 0.5 || mv > 0.75))
          idx = 6 + Math.min(2, ((mv - 0.64) * 14) | 0);
        P(L, x, y, PAL[idx]);
      }
    rect(L, cx - h2 - 1, y0, w + 2, 3, PAL[4]);
    rect(L, cx - h2 - 1, y1 - 2, w + 2, 3, PAL[3]);
  }
  function arch(L: Layer, s: number, sd: number, pw: number): void {
    const hw = 118 * s;
    const sp = VY - 40 * s;
    const rise = 42 * s;
    const th = Math.max(2, (5 * s) | 0);
    for (let x = Math.ceil(VX - hw + pw); x <= VX + hw - pw; x++) {
      const t = Math.abs((x - VX) / (hw - pw));
      const y = Math.round(sp - (rise * Math.sqrt(Math.max(0, 4 - (1 + t) * (1 + t)))) / 1.732);
      for (let k = 0; k < th; k++) {
        const v = 0.45 + (hs(x, k, sd) - 0.5) * 0.3 + (k === 0 ? 0.2 : 0) - (k === th - 1 ? 0.1 : 0);
        let idx = clampI(1 + ((v * 5) | 0), 1, 5);
        if (vn(x * 0.2, s * 7, sd + 4) > 0.68) idx = 6 + (k & 1);
        P(L, x, y + k, PAL[idx]);
      }
    }
  }
  function pair(L: Layer, s: number, sd: number): void {
    const hw = 118 * s;
    const pw = Math.max(5, (26 * s) | 0);
    const cap = (VY - 40 * s) | 0;
    const base = (VY + 92 * s) | 0;
    for (const g of [-1, 1]) {
      const cx = (VX + g * (hw - pw / 2)) | 0;
      cyl(L, cx, cap, base, pw, sd);
      pil.push([cx, base, pw, s]);
    }
    arch(L, s, sd, pw);
  }
  function web(L: Layer, x: number, y: number, sx: number, sy: number, r: number): void {
    const c = PAL[4];
    for (let k = 0; k <= 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      line(L, x, y, x + sx * Math.cos(a) * r, y + sy * Math.sin(a) * r, c);
    }
    for (let q = 1; q <= 3; q++) {
      const q2 = (r * q) / 3.4;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const b = ((k + 1) / 4) * Math.PI * 2;
        line(
          L,
          x + sx * Math.cos(a) * q2,
          y + sy * Math.sin(a) * q2,
          x + sx * Math.cos(b) * q2,
          y + sy * Math.sin(b) * q2,
          c,
        );
      }
    }
  }

  const topY = (p: Pile, x: number): number =>
    p.y - p.h * (1 - Math.pow(Math.abs((x - p.x) / (p.w / 2)), 1.7));
  function heap(L: Layer, cx: number, by: number, w: number, hh: number, sd: number): void {
    for (let x = Math.ceil(cx - w / 2); x < cx + w / 2; x++) {
      const t = (x - cx) / (w / 2);
      const top = by - hh * (1 - Math.pow(Math.abs(t), 1.7)) * (0.85 + 0.3 * vn(x * 0.2, sd, 3));
      for (let y = Math.ceil(top); y <= by; y++) {
        const v = hs(x >> 1, y >> 1, sd);
        let i = v > 0.8 ? 9 : v > 0.45 ? 10 : v > 0.2 ? 11 : 12;
        if (y - top < 2 && v > 0.3) i = 9;
        if (hs(x, y, 5) < 0.08) i = 13;
        if (i === 9 && hs(x, y, 77) < 0.25 && spk.length < 110) spk.push([x, y, L]);
        P(L, x, y, PAL[i]);
      }
    }
  }
  function gem(L: Layer, x: number, y: number, k: number): void {
    const c = PAL[20 + k];
    rect(L, x, y, 2, 2, c);
    P(L, x, y, sh(c, 1.6));
    P(L, x + 1, y + 1, sh(c, 0.6));
    gems.push([x, y, c, L], [x + 1, y, c, L]);
  }
  function item(L: Layer, k: number, x: number, y: number): void {
    if (k === 0) gem(L, x, y, (R() * 4) | 0);
    else if (k === 1) {
      rect(L, x - 4, y - 3, 9, 3, PAL[10]);
      rect(L, x - 4, y - 5, 2, 2, PAL[9]);
      rect(L, x - 1, y - 6, 2, 3, PAL[9]);
      rect(L, x + 3, y - 5, 2, 2, PAL[9]);
      rect(L, x - 4, y - 1, 9, 1, PAL[12]);
      P(L, x, y - 2, PAL[20]);
      gems.push([x, y - 2, PAL[20], L]);
    } else if (k === 2) {
      const d = R() < 0.5 ? 1 : -1;
      line(L, x, y, x + d * 13, y - 9, PAL[19]);
      line(L, x, y + 1, x + d * 13, y - 8, PAL[17]);
      rect(L, x - 1, y - 1, 3, 2, PAL[11]);
      P(L, x - d, y + 2, PAL[12]);
    } else if (k === 3) {
      disc(L, x, y - 3, 6, PAL[18]);
      disc(L, x, y - 3, 5, PAL[15]);
      disc(L, x, y - 3, 2, PAL[11]);
      line(L, x - 5, y - 3, x + 5, y - 3, PAL[14]);
      P(L, x, y - 3, PAL[9]);
    } else {
      rect(L, x - 3, y - 6, 7, 3, PAL[10]);
      rect(L, x - 2, y - 3, 5, 2, PAL[11]);
      rect(L, x, y - 1, 1, 3, PAL[12]);
      rect(L, x - 2, y + 2, 5, 1, PAL[11]);
      P(L, x - 2, y - 6, PAL[9]);
      P(L, x - 2, y - 5, PAL[9]);
    }
  }
  function pile(L: Layer, cx: number, by: number, w: number, hh: number, sd: number): void {
    const p: Pile = { x: cx, y: by, w, h: hh, L };
    heap(L, cx, by, w, hh, sd);
    piles.push(p);
    for (let k = 0, n = 11 + ((R() * 3) | 0); k < n; k++) {
      const x = (cx + rr(-0.72, 0.72) * (w / 2)) | 0;
      item(L, k < 6 ? 0 : 1 + ((k - 6) % 4), x, (topY(p, x) + 3) | 0);
    }
  }
  function chest(L: Layer, x: number, y: number, w: number, h: number, st: number, sd: number): void {
    const bw = Math.max(2, (w / 12) | 0);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        P(L, x + i, y + j, PAL[i % 9 === 0 || j === h - 1 ? 14 : hs((i / 9) | 0, j >> 2, sd) < 0.3 ? 16 : 15]);
    for (const f of [0.12, 0.78]) {
      rect(L, x + ((w * f) | 0), y, bw, h, PAL[18]);
      rect(L, x + ((w * f) | 0), y, 1, h, PAL[19]);
    }
    rect(L, x, y, w, 1, PAL[16]);
    rect(L, x + (w >> 1) - 2, y + 2, 4, 5, PAL[11]);
    P(L, x + (w >> 1), y + 4, PAL[13]);
    if (st === 0) {
      const lh = (h * 0.45) | 0;
      for (let j = 0; j < lh; j++) {
        const ins = j < 2 ? 2 - j : 0;
        rect(L, x + ins, y - lh + j, w - ins * 2, 1, PAL[j === 0 ? 16 : 15]);
      }
      for (const f of [0.12, 0.78]) rect(L, x + ((w * f) | 0), y - lh + 2, bw, lh - 2, PAL[18]);
    } else if (st === 1) {
      const pp: Pile = { x: x + (w >> 1), y: y + 2, w: w - 6, h: (h * 0.55) | 0, L };
      rect(L, x + 2, y - h, w - 4, (h * 0.6) | 0, PAL[14]);
      rect(L, x + 2, y - h, w - 4, 1, PAL[15]);
      heap(L, pp.x, pp.y, pp.w, pp.h, sd + 1);
      for (let k = 0; k < ((w / 9) | 0); k++) {
        const gx = x + 4 + ((R() * (w - 12)) | 0);
        gem(L, gx, ((topY(pp, gx) | 0) + 1) | 0, (R() * 4) | 0);
      }
    } else {
      rect(L, x + 1, y - 4, w - 2, 3, PAL[15]);
      rect(L, x + 2, y - 2, w - 4, 2, PAL[1]);
      rect(L, x + 3, y - 2, w - 6, 1, PAL[10]);
    }
  }

  function genEyes(): void {
    eyes = [];
    const n = 2 + ((R() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const z = 0.78 + R() * 0.2;
      const sz = z < 0.86 ? 2 : 1;
      const x = VX + rr(-50, 22);
      eyes.push({
        x,
        x0: x,
        tx: x,
        y: (rr(88, 108)) | 0,
        z,
        sz,
        gap: sz === 2 ? 4 + ((R() * 3) | 0) : 3 + ((R() * 2) | 0),
        a: 0,
        on: 0,
        hold: 0,
        cl: 0,
        nb: r2(2, 6),
        nm: r2(5, 12),
      });
    }
  }

  /* ============ 4. ILUMINAÇÃO ============ */
  const LS = { S: 1, breath: 1, drop: 0, g: 1, warm: 1, x: 244, y: 120 };
  let nextDrop = 8;
  let ds = -99;
  let dH = 0.2;
  let dR = 0.6;
  let dO = 0;
  let flare = 0;
  let mx = 0;
  let my = 0;
  let tmx = 0;
  let tmy = 0;
  function lightOsc(dt: number): void {
    const t = T;
    const breath = 1 + 0.25 * Math.sin(t * 1.5);
    let fl = 1 + (n1(t * 10, 1) - 0.5) * 0.2;
    if (hs((t * 12) | 0, 0, 5) > 0.94) fl += 0.1;
    if (t >= nextDrop) {
      ds = t;
      dH = r2(0.1, 0.3);
      dR = r2(0.4, 0.8);
      dO = R2() < 0.5 ? 0.18 : 0;
      nextDrop = t + 0.15 + dH + dR + r2(6, 15);
    }
    const u = t - ds;
    let m = 1;
    if (u >= 0 && u < 0.15 + dH + dR) {
      if (u < 0.15) m = 1 - (0.65 * u) / 0.15;
      else if (u < 0.15 + dH) m = 0.35;
      else {
        const e = (u - 0.15 - dH) / dR;
        m = 0.35 + 0.65 * e + dO * Math.sin(Math.PI * e);
      }
    }
    flare = Math.max(0, flare - dt);
    const S = breath * fl * m * (flare > 0 ? 1.3 : 1);
    LS.S = S;
    LS.breath = breath;
    LS.drop = Math.max(0, 1 - m);
    LS.g = Math.min(1.1, 0.55 + 0.45 * S);
    LS.warm = clampI((S - 0.4) / 0.7, 0, 1);
    LS.x = 244 + mx * 16 + (n1(t * 9, 2) - 0.5) * 3;
    LS.y = 120 + my * 8 + (n1(t * 11, 3) - 0.5) * 2;
  }
  function lightAt(x: number, y: number, D: number): number {
    const Re = 250 * LS.S * (1 - 0.5 * D);
    const f = 1 - Math.hypot(x - LS.x, y - LS.y) / Re;
    return f > 0 ? f * Math.sqrt(f) * LS.g : 0;
  }
  const MR = new Int32Array(6);
  const MG = new Int32Array(6);
  const MB = new Int32Array(6);

  /* ============ 5. OLHOS E PRESENÇA ============ */
  let calm = 0;
  let needDrop = false;
  let wasDrop = false;
  function updEyes(dt: number): void {
    calm = Math.max(0, calm - dt);
    const dropping = LS.drop > 0.15;
    if (dropping && !wasDrop) needDrop = false;
    wasDrop = dropping;
    const go = (LS.breath < 0.9 + 0.12 * Math.max(0, mx) || dropping) && calm <= 0 && !needDrop;
    let cnt = 0;
    for (const e of eyes) if (e.on || e.a > 0.05) cnt++;
    for (const e of eyes) {
      e.hold = Math.max(0, e.hold - dt);
      e.cl = Math.max(0, e.cl - dt);
      const reach = Math.hypot(e.x - LS.x, e.y - LS.y) < 250 * LS.S * (1 - 0.5 * e.z) * 0.92;
      if (reach) {
        e.on = 0;
        e.a = 0;
        e.hold = 0.15;
      } else if (!go) e.on = 0;
      else if (!e.on && cnt < 2 && e.hold <= 0 && R2() < dt * 2.5) {
        e.on = 1;
        cnt++;
      }
      e.a = clampI(e.a + (e.on ? 2.2 : -3) * dt, 0, 1);
      if (T >= e.nb) {
        e.cl = r2(0.08, 0.12);
        e.nb = T + e.cl + r2(2, 6);
      }
      if (T >= e.nm) {
        e.tx = e.x0 + (R2() < 0.5 ? -1 : 1) * (1 + ((R2() * 3) | 0));
        e.nm = T + r2(7, 16);
      }
      e.x += (e.tx - e.x) * dt * 0.5;
    }
  }
  function drawEyes(): void {
    for (const e of eyes) {
      if (e.a <= 0.02 || e.cl > 0) continue;
      const x = Math.round(e.x);
      const y = e.y;
      const h = e.gap >> 1;
      const s = e.sz;
      for (let n = 0; n < 2; n++) {
        const ex = n ? x + h : x - h - s;
        if (s === 2) {
          for (let j = -2; j <= 3; j++)
            for (let i = -2; i <= 3; i++) {
              const o = Math.max(Math.abs(i - 0.5), Math.abs(j - 0.5));
              if (o > 2 && Math.abs(i - 0.5) + Math.abs(j - 0.5) < 4.5) {
                if (bay(ex + i, y + j) < e.a * 0.5) ep(ex + i, y + j, PAL[31]);
              } else if (o > 1 && o <= 2 && !(Math.abs(i - 0.5) > 1 && Math.abs(j - 0.5) > 1)) {
                if (bay(ex + i, y + j) < e.a) ep(ex + i, y + j, PAL[30]);
              }
            }
        }
        for (let j = 0; j < s; j++)
          for (let i = 0; i < s; i++) if (bay(ex + i, y + j) < e.a) ep(ex + i, y + j, PAL[29]);
      }
    }
  }

  /* ============ 6. PARTÍCULAS (pool fixo, sem alocação por frame) ============ */
  const MP = 240;
  const PX = new Float32Array(MP);
  const PY = new Float32Array(MP);
  const PVX = new Float32Array(MP);
  const PVY = new Float32Array(MP);
  const PL = new Float32Array(MP);
  const PM = new Float32Array(MP);
  const PF = new Float32Array(MP);
  const PT = new Uint8Array(MP);
  let pc = 0;
  let emA = 0;
  let smA = 0;
  let duA = 0;
  let nextDrip = 2;
  let nextCoin = 5;
  function spawn(t: number, x: number, y: number, vx: number, vy: number, l: number, f?: number): void {
    for (let k = 0; k < MP; k++) {
      const i = (pc + k) % MP;
      if (PL[i] <= 0) {
        pc = i + 1;
        PX[i] = x;
        PY[i] = y;
        PVX[i] = vx;
        PVY[i] = vy;
        PL[i] = PM[i] = l;
        PF[i] = f || 0;
        PT[i] = t;
        return;
      }
    }
  }
  function updParts(dt: number): void {
    const fh = Math.round(9 + 11 * Math.min(LS.S, 1.4));
    const fx = 268 + Math.round(mx * 3);
    for (emA += dt * (8 + 8 * LS.S); emA >= 1; emA--)
      spawn(1, fx + r2(-2, 2), 118 - fh, r2(-6, 6), -r2(15, 32), r2(0.6, 1.3));
    for (smA += dt * 4; smA >= 1; smA--)
      spawn(2, fx + r2(-1, 1), 118 - fh - 3, r2(-3, 3), -r2(8, 14), r2(1.2, 2.2));
    for (duA += dt * 8; duA >= 1; duA--)
      spawn(3, LS.x + r2(-110, 110), LS.y + r2(-70, 70), r2(-3, 3), r2(-2, 2), r2(4, 8));
    if (T >= nextDrip) {
      nextDrip = T + r2(1.5, 4);
      spawn(4, r2(141, 157), 23, 0, 0, 3, r2(110, 172));
    }
    if (T >= nextCoin && piles.length) {
      nextCoin = T + r2(4, 10);
      const p = piles[(R2() * piles.length) | 0];
      const x = p.x + r2(-0.4, 0.4) * (p.w / 2);
      spawn(7, x, topY(p, x) + 2, (R2() < 0.5 ? -1 : 1) * r2(14, 22), r2(10, 16), 0.9);
    }
    for (let i = 0; i < MP; i++) {
      if (PL[i] <= 0) continue;
      PL[i] -= dt;
      const t = PT[i];
      if (t === 3 || t === 1) PVX[i] += (R2() - 0.5) * dt * (t === 1 ? 60 : 10);
      if (t >= 4 && t <= 6) PVY[i] += (t === 6 ? 380 : t === 5 ? 260 : 420) * dt;
      PX[i] += PVX[i] * dt;
      PY[i] += PVY[i] * dt;
      if (t === 7 && R2() < dt * 10) spawn(8, PX[i], PY[i], 0, 0, 0.2, 2);
      if (t === 4 && PY[i] >= PF[i]) {
        PL[i] = 0;
        snd("drip");
        for (let k = 0; k < 3; k++) spawn(5, PX[i], PF[i], (k - 1) * 16, -40, 0.25);
      }
      if (t === 6 && PVY[i] > 0 && PY[i] >= PF[i]) {
        PL[i] = 0;
        if (R2() < 0.5) spawn(8, PX[i], PY[i], 0, 0, 0.2, 2);
      }
    }
    for (let k = 0; k < 4 && spk.length; k++) {
      const c = spk[(R2() * spk.length) | 0];
      const L = c[2];
      const x = c[0] + L.ox;
      const y = c[1] + L.oy;
      const I = lightAt(x, y, L === L0 ? 0.15 : L.d / 255);
      if (R2() < I * 0.1) spawn(8, x, y, 0, 0, 0.18 + R2() * 0.2, 1 + ((R2() * Math.min(3, 1 + I * 3)) | 0));
    }
  }
  function drawParts(): void {
    for (let i = 0; i < MP; i++) {
      if (PL[i] <= 0) continue;
      const x = PX[i] | 0;
      const y = PY[i] | 0;
      const t = PT[i];
      const r = PL[i] / PM[i];
      if (t === 1) ep(x, y, r > 0.6 ? PAL[25] : r > 0.3 ? PAL[26] : r > 0.12 ? PAL[27] : PAL[28]);
      else if (t === 2) {
        if (bay(x, y) < r * 0.55) ep(x, y, PAL[1]);
      } else if (t === 3) {
        const I = lightAt(x, y, 0.3);
        if (bay(x, y) < I * 1.2 && I > 0.06) ep(x, y, PAL[5]);
      } else if (t === 4) {
        ep(x, y, PAL[5]);
        ep(x, y - 1, PAL[4]);
      } else if (t === 5) ep(x, y, PAL[5]);
      else if (t === 6 || t === 7) {
        ep(x, y, PAL[10]);
        ep(x + 1, y, PAL[11]);
        if ((((T * 20) | 0) + i) % 7 === 0) ep(x, y, PAL[24]);
      } else if (t === 8) {
        const s = Math.ceil(PF[i] * r);
        ep(x, y, PAL[24]);
        if (s > 1) {
          ep(x - 1, y, PAL[9]);
          ep(x + 1, y, PAL[9]);
          ep(x, y - 1, PAL[9]);
          ep(x, y + 1, PAL[9]);
        }
        if (s > 2) {
          ep(x - 2, y, PAL[10]);
          ep(x + 2, y, PAL[10]);
          ep(x, y - 2, PAL[10]);
          ep(x, y + 2, PAL[10]);
        }
      }
    }
  }

  /* ============ 7. RENDER ============ */
  let OX = 0;
  let OY = 0;
  function ep(x: number, y: number, c: number): void {
    x = (x + OX) | 0;
    y = (y + OY) | 0;
    if (x >= 0 && x < W && y >= 0 && y < H) out[y * W + x] = c;
  }
  function lift(x: number, y: number, c: number, k: number): void {
    x |= 0;
    y |= 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = y * W + x;
    const e = out[i];
    const r = Math.max(e & 255, (c & 255) * k);
    const g = Math.max((e >>> 8) & 255, ((c >>> 8) & 255) * k);
    const b = Math.max((e >>> 16) & 255, ((c >>> 16) & 255) * k);
    out[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  function blit(L: Layer, first: boolean): void {
    const a = L.a;
    const ox = L.ox;
    const oy = L.oy;
    for (let y = 0; y < H; y++) {
      const sy = y - oy;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < W; x++) {
        const sx = x - ox;
        if (sx < 0 || sx >= W) continue;
        const v = a[sy * W + sx];
        if (v) {
          sc[y * W + x] = v;
          dep[y * W + x] = first ? D0[sy * W + sx] : L.d;
        }
      }
    }
  }
  function inPoly(p: number[][], x: number, y: number): boolean {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[i];
      const b = p[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function poly(p: number[][], fn: (x: number, y: number) => number): void {
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    for (const q of p) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (inPoly(p, x + 0.5, y + 0.5)) ep(x, y, fn(x, y));
  }
  function flame(cx: number, by: number): void {
    const S = LS.S;
    const ph = ((T * 12) | 0) % 5;
    const h = Math.round(9 + 11 * Math.min(S, 1.4));
    const w0 = 3 + 3 * Math.min(S, 1.3);
    const cool = (1 - Math.min(1, S)) * 0.6;
    for (let j = 0; j < h; j++) {
      const k = j / h;
      const hw = w0 * (1 - Math.pow(k, 1.3)) * (0.85 + 0.3 * hs(j, ph, 1));
      const sw = Math.round(Math.sin(ph * 1.7 + j * 0.5) * k * 2);
      for (let i = Math.ceil(-hw); i <= hw; i++) {
        const heat =
          1 - (Math.abs(i) / (hw + 0.5)) * 0.65 - k * 0.55 + (hs(i, j + ph * 7, 2) - 0.5) * 0.2 - cool;
        if (heat > 0)
          ep(cx + i + sw, by - j, heat > 0.75 ? PAL[24] : heat > 0.55 ? PAL[25] : heat > 0.35 ? PAL[26] : heat > 0.15 ? PAL[27] : PAL[28]);
      }
    }
  }
  function rect2(x: number, y: number, w: number, h: number, c: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) ep(x + i, y + j, PAL[c]);
  }
  function drawHand(bb: number): void {
    OX = Math.round(mx * 3);
    OY = Math.round(-bb);
    for (let d = -2; d < 2; d++) line(null, 268 + d, 126, 272 + d, 178, PAL[d < -1 ? 14 : d < 1 ? 15 : 16]);
    poly(
      [
        [276, 160],
        [288, 150],
        [320, 134],
        [320, 180],
        [298, 180],
        [282, 172],
      ],
      (x, y) => PAL[y < 150 - (x - 288) * 0.5 + 4 ? 16 : hs(x >> 1, y >> 1, 3) < 0.3 ? 14 : 15],
    );
    line(null, 276, 160, 282, 172, PAL[14]);
    poly(
      [
        [258, 150],
        [268, 145],
        [281, 147],
        [283, 158],
        [274, 164],
        [262, 160],
      ],
      (x, y) => PAL[y < 151 ? 11 : y > 158 ? 13 : 12],
    );
    for (let k = 0; k < 3; k++) line(null, 262 + k * 4, 151, 262 + k * 4, 157, PAL[13]);
    rect2(263, 118, 11, 10, 15);
    rect2(263, 118, 2, 10, 14);
    rect2(263, 126, 11, 2, 18);
    rect2(264, 117, 9, 1, 27);
    flame(268, 117);
    OX = OY = 0;
  }
  function render(): void {
    const bb = Math.sin(T * 1.1);
    for (const L of LAY) {
      L.ox = Math.round(-mx * 5 * L.p);
      L.oy = Math.round(-my * 2.5 * L.p + bb * L.p);
    }
    LW.ox += Math.round(Math.sin(T * 0.7));
    sc.fill(0);
    dep.fill(0);
    blit(L0, true);
    blit(L1, false);
    blit(L2, false);
    blit(LW, false);
    blit(L3, false);
    const Rb = 250 * LS.S;
    const g = LS.g;
    const lx = LS.x;
    const ly = LS.y;
    const wm = LS.warm;
    for (let q = 0; q < 6; q++) {
      const l = Math.pow(q / 5, 0.85);
      MR[q] = ((0.06 + 0.94 * l) * 256) | 0;
      MG[q] = ((0.07 + (0.6 + 0.3 * wm - 0.07) * l) * 256) | 0;
      MB[q] = ((0.18 + (0.28 + 0.27 * wm - 0.18) * l) * 256) | 0;
    }
    for (let y = 0, i = 0; y < H; y++) {
      const dy = y - ly;
      const dy2 = dy * dy;
      const by = (y & 3) << 2;
      for (let x = 0; x < W; x++, i++) {
        const dx = x - lx;
        const Re = Rb * (1 - 0.5 * (dep[i] / 255));
        let f = 1 - Math.sqrt(dx * dx + dy2) / Re;
        f = f > 0 ? f * Math.sqrt(f) * g : 0;
        if (SH[i]) f *= 0.4;
        let q = (f * 5 + BAYER[by | (x & 3)]) | 0;
        if (q > 5) q = 5;
        const c = sc[i];
        out[i] =
          (0xff000000 |
            (((c >>> 16) & 255) * MB[q] >> 8) << 16 |
            ((((c >>> 8) & 255) * MG[q] >> 8) << 8) |
            ((c & 255) * MR[q] >> 8)) >>>
          0;
      }
    }
    for (const e of gems) lift(e[0] + e[3].ox, e[1] + e[3].oy, e[2], 0.6);
    drawParts();
    drawEyes();
    drawHand(bb);
    bctx.putImageData(img, 0, 0);
    ctx.drawImage(bc, 0, 0, canvas.width, canvas.height);
  }

  function buildScene(s: number): void {
    seed = s >>> 0;
    R = mulberry32(seed);
    R2 = mulberry32(seed ^ 0x9e3779b9);
    T = 0;
    nextDrop = r2(6, 12);
    ds = -99;
    flare = 0;
    calm = 0;
    needDrop = false;
    spk = [];
    gems = [];
    piles = [];
    pil = [];
    SH.fill(0);
    PL.fill(0);
    for (const L of LAY) L.a.fill(0);
    const sd = seed & 255;
    genEnv(L0, sd);
    pair(L1, 0.26, sd + 1);
    pair(L1, 0.4, sd + 2);
    chest(L1, 134, 113, 18, 12, 0, sd);
    chest(L1, 184, 115, 16, 10, 2, sd + 1);
    rect(L1, 138, 16, 22, 7, PAL[2]);
    rect(L1, 139, 17, 20, 5, PAL[0]);
    for (let i = 0; i < 5; i++) rect(L1, 140 + i * 4, 17, 1, 5, PAL[18]);
    pair(L2, 0.62, sd + 3);
    chest(L2, 148, 128, 26, 15, 2, sd + 2);
    pile(L2, (86 + rr(-6, 6)) | 0, 156, 104, 56, sd);
    pile(L2, (240 + rr(-6, 6)) | 0, 152, 96, 52, sd + 9);
    pair(L3, 1, sd + 4);
    chest(L3, 4, 126, 86, 48, 1, sd + 5);
    chest(L3, 196, 164, 64, 36, 0, sd + 6);
    for (const s of [0.62, 0.4, 0.26])
      for (const g of [-1, 1]) {
        const pw = Math.max(5, (26 * s) | 0);
        web(LW, VX + g * (118 * s - pw), VY - 40 * s, -g, 1, 22 * s);
      }
    for (const q of pil) {
      if (q[3] > 0.9) continue;
      const dx = q[0] - 250;
      const dy = q[1] - 128;
      const l = Math.hypot(dx, dy);
      const ux = dx / l;
      const uy = (dy / l) * 0.35;
      for (let t = 0; t < 70 * q[3] + 10; t++)
        for (let i = (-q[2] / 2) | 0; i < q[2] / 2; i++)
          for (let k = 0; k < Math.max(2, 5 * q[3]); k++) {
            const x = Math.round(q[0] + i + ux * t);
            const y = Math.round(q[1] + uy * t + k);
            if (x >= 0 && x < W && y >= 0 && y < H) SH[y * W + x] = 1;
          }
    }
    genEyes();
  }

  /* ============ 8. ÁUDIO PROCEDURAL (inicia no primeiro clique) ============ */
  let AC: AudioContext | null = null;
  let NB: AudioBuffer | null = null;
  let gB: GainNode | null = null;
  function ensureAudio(): void {
    if (AC || muted) return;
    try {
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      AC = new Ctor();
      NB = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      const d = NB.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = AC.createBufferSource();
      const f = AC.createBiquadFilter();
      s.buffer = NB;
      s.loop = true;
      f.type = "lowpass";
      f.frequency.value = 170;
      gB = AC.createGain();
      gB.gain.value = 0;
      s.connect(f);
      f.connect(gB);
      gB.connect(AC.destination);
      s.start();
    } catch {
      AC = null;
    }
  }
  function snd(k: "crack" | "drip" | "coin", v?: number): void {
    if (!AC || !NB || muted) return;
    try {
      const t = AC.currentTime;
      const g = AC.createGain();
      g.connect(AC.destination);
      if (k === "crack") {
        const s = AC.createBufferSource();
        const f = AC.createBiquadFilter();
        s.buffer = NB;
        f.type = "highpass";
        f.frequency.value = 2200 + (v ?? 0) * 3000;
        s.connect(f);
        f.connect(g);
        g.gain.setValueAtTime(0.025 * Math.min(1, v ?? 0), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        s.start(t, Math.random() * 0.5, 0.05);
      } else {
        const o = AC.createOscillator();
        const fr = k === "drip" ? [1400, 600] : [2600, 3300];
        o.frequency.setValueAtTime(fr[0], t);
        o.frequency.exponentialRampToValueAtTime(fr[1], t + 0.06);
        g.gain.setValueAtTime(0.02, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        o.connect(g);
        o.start(t);
        o.stop(t + 0.13);
      }
    } catch {
      // Audio is best-effort: a denied device never breaks the scene.
    }
  }
  /** Create/resume the context inside a user gesture (autoplay policy). */
  function unlockAudio(): void {
    if (muted) return;
    ensureAudio();
    if (AC && AC.state === "suspended") {
      try {
        const p = AC.resume() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => undefined);
      } catch {
        // Resume races with tab switches; the next click retries.
      }
    }
  }

  /* ============ 9. INPUT E LOOP PRINCIPAL ============ */
  function clickAt(bx: number, by: number): void {
    for (const p of piles) {
      const x = bx - p.L.ox;
      const y = by - p.L.oy;
      if (Math.abs(x - p.x) < p.w / 2 && y >= topY(p, x) - 4 && y <= p.y + 3) {
        for (let k = 0; k < 16; k++) spawn(6, bx, by, r2(-40, 40), -r2(60, 130), 1.5, by + r2(8, 24));
        for (let k = 0; k < 5; k++)
          spawn(8, bx + r2(-8, 8), by + r2(-8, 6), 0, 0, 0.3 + R2() * 0.3, 2 + ((R2() * 2) | 0));
        snd("coin");
        return;
      }
    }
    flare = 0.3;
    calm = r2(3, 4.5);
    needDrop = true;
    for (const e of eyes) {
      e.on = 0;
      e.a = 0;
    }
  }
  function fractions(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return [0.5, 0.5];
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }
  const onPointerMove = (e: PointerEvent): void => {
    const p = fractions(e);
    tmx = clampI(p[0] * 2 - 1, -1, 1);
    tmy = clampI(p[1] * 2 - 1, -1, 1);
  };
  const onPointerDown = (e: PointerEvent): void => {
    onPointerMove(e);
    unlockAudio();
    const p = fractions(e);
    clickAt(p[0] * W, p[1] * H);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "r" || e.key === "R") regenerate();
  };
  function resize(): void {
    const vw = typeof window.innerWidth === "number" ? window.innerWidth : W;
    const vh = typeof window.innerHeight === "number" ? window.innerHeight : H;
    const s = Math.max(1, Math.min(maxScale, Math.floor(Math.min(vw / W, vh / H))));
    canvas.width = W * s;
    canvas.height = H * s;
    ctx.imageSmoothingEnabled = false;
  }
  function step(dt: number): void {
    T += dt;
    const k = Math.min(1, dt * 6);
    mx += (tmx - mx) * k;
    my += (tmy - my) * k;
    lightOsc(dt);
    updEyes(dt);
    updParts(dt);
    if (AC && !muted) {
      if (R2() < dt * 9) snd("crack", LS.S);
      let v = 0;
      for (const e of eyes) v += e.a;
      if (gB) gB.gain.value = v * 0.012 * (0.6 + 0.4 * Math.sin(T * 1.4));
    }
  }

  function regenerate(next?: number): void {
    buildScene(next ?? Math.imul(seed, 1664525) + 1013904223);
    if (reduced) {
      // Static path: repaint the single frame right away.
      warmup();
      render();
    }
  }
  function setMuted(m: boolean): void {
    muted = m;
    if (m) {
      try {
        void AC?.suspend();
      } catch {
        // Already closed in some browsers; nothing to do.
      }
    } else if (!reduced) {
      unlockAudio();
    }
  }

  buildScene(seed);
  resize();

  if (reduced) {
    // Single static frame: warm the particles up so the vault is alive,
    // paint once, and stay silent (no loop, no audio, no parallax).
    warmup();
    render();
    const onResizeStatic = (): void => {
      resize();
      render();
    };
    window.addEventListener("resize", onResizeStatic);
    return {
      canvas,
      regenerate,
      setMuted: (m: boolean) => {
        muted = m;
      },
      isMuted: () => muted,
      stop: () => window.removeEventListener("resize", onResizeStatic),
    };
  }

  function warmup(): void {
    T = 2;
    lightOsc(0);
    for (let i = 0; i < 90; i++) {
      T += 1 / 60;
      updParts(1 / 60);
    }
  }

  let raf = 0;
  let last = 0;
  let dead = false;
  const loop = (now: number): void => {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden) {
      last = 0;
      return; // pausa com a aba oculta
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    step(dt);
    render();
  };

  window.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  if (opts.regenerateOnR) window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", resize);
  raf = requestAnimationFrame(loop);

  return {
    canvas,
    regenerate,
    setMuted,
    isMuted: () => muted,
    stop: () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", resize);
      try {
        void AC?.suspend();
      } catch {
        // Best-effort: the context is dropped with the handle.
      }
    },
  };
}
