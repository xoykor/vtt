// Flat-face dice for the 3D table view: the mesh, the number atlas and
// the rotation that lands the rolled face up. Pure geometry — no DOM, no
// WebGL — so the mapping is unit-testable without a GPU.
//
// The host decides the face (src/dice/roller.ts); this module only knows
// how to *show* one. Every die is a convex body centred on the origin
// whose faces share one atlas texture, so a roll is a single quaternion
// per die and nothing else in the scene moves.

import * as THREE from "three";

/** Sides the 3D view can render as meshes; anything else stays numeric. */
export const MESHABLE_SIDES = [2, 4, 6, 8, 10, 12, 20] as const;

/** Screen-up hint used when the caller does not describe its camera. */
const DEFAULT_SCREEN_UP = new THREE.Vector3(0, 1, 0);
/** Direction pointing away from the camera (the camera sits on +Z). */
const VIEW_AWAY = new THREE.Vector3(0, 0, -1);
/** World up: last resort when a face is edge-on to the camera. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** One numbered face of a die, in die-local space. */
export interface DieFace {
  /** Outward unit normal. The rolled face is aimed up along it. */
  normal: THREE.Vector3;
  /** In-plane direction that reads as "up" once the face is aimed up. */
  tangent: THREE.Vector3;
  /** In-plane reading direction (`tangent × normal`). */
  right: THREE.Vector3;
  /** Triangles filling the face. */
  triangles: THREE.Vector3[][];
  /** False for decorative faces (the coin rim) that carry no number. */
  labeled: boolean;
}

/** Atlas geometry: larger cells keep two-digit labels readable. */
const CELL = 256;
/** Share of the cell the face polygon is mapped onto. */
const FILL = 0.78;
const IVORY = "#efe2c4";
const INK = "#2c1d10";

/** Project `hint` onto the plane perpendicular to `onto`, or null when parallel. */
function projected(hint: THREE.Vector3, onto: THREE.Vector3): THREE.Vector3 | null {
  const v = hint.clone().sub(onto.clone().multiplyScalar(onto.dot(hint)));
  return v.lengthSq() > 1e-8 ? v.normalize() : null;
}

/**
 * In-plane frame that keeps a number upright for a given camera: the
 * tangent is the direction inside the face closest to screen-up, so the
 * text reads normally once the face is turned towards the viewer.
 */
function faceFrame(normal: THREE.Vector3, screenUp: THREE.Vector3): {
  tangent: THREE.Vector3;
  right: THREE.Vector3;
} {
  const hints = [screenUp, VIEW_AWAY, WORLD_UP, new THREE.Vector3(1, 0, 0)];
  for (const hint of hints) {
    const tangent = projected(hint, normal);
    if (tangent) {
      return { tangent, right: tangent.clone().cross(normal).normalize() };
    }
  }
  return { tangent: VIEW_AWAY.clone(), right: new THREE.Vector3(1, 0, 0) };
}

/** Face from triangles: normal is the summed winding (outward for these dice). */
function faceFromTriangles(
  triangles: THREE.Vector3[][],
  labeled: boolean,
  screenUp: THREE.Vector3,
): DieFace {
  const normal = new THREE.Vector3();
  for (const tri of triangles) {
    normal.add(
      new THREE.Vector3()
        .subVectors(tri[1], tri[0])
        .cross(new THREE.Vector3().subVectors(tri[2], tri[0])),
    );
  }
  if (normal.lengthSq() < 1e-12) throw new Error("degenerate die face");
  normal.normalize();
  const { tangent, right } = faceFrame(normal, screenUp);
  return { normal, tangent, right, triangles, labeled };
}

/** Turn the winding around when the normal points back at the die centre. */
function outward(face: DieFace, screenUp: THREE.Vector3): DieFace {
  const centroid = new THREE.Vector3();
  for (const tri of face.triangles) {
    for (const v of tri) centroid.add(v);
  }
  centroid.divideScalar(face.triangles.length * 3);
  if (face.normal.dot(centroid) >= 0) return face;
  return faceFromTriangles(
    face.triangles.map((tri) => [tri[2], tri[1], tri[0]]),
    face.labeled,
    screenUp,
  );
}

/** Face defined by its polygon outline, triangulated as a fan. */
function polygonFace(
  points: THREE.Vector3[],
  labeled: boolean,
  screenUp: THREE.Vector3,
): DieFace {
  const triangles: THREE.Vector3[][] = [];
  for (let i = 1; i < points.length - 1; i++) {
    triangles.push([points[0], points[i], points[i + 1]]);
  }
  return outward(faceFromTriangles(triangles, labeled, screenUp), screenUp);
}

/** Face filled by a triangle fan from `centre` around `ring` (one coin side). */
function fanFace(
  centre: THREE.Vector3,
  ring: THREE.Vector3[],
  outwardNormal: THREE.Vector3,
  labeled: boolean,
  screenUp: THREE.Vector3,
): DieFace {
  const triangles: THREE.Vector3[][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = new THREE.Vector3()
      .subVectors(a, centre)
      .cross(new THREE.Vector3().subVectors(b, centre));
    // Winding chosen so the face normal is exactly `outwardNormal`.
    triangles.push(cross.dot(outwardNormal) < 0 ? [centre, b, a] : [centre, a, b]);
  }
  return {
    ...faceFromTriangles(triangles, labeled, screenUp),
    normal: outwardNormal.clone().normalize(),
    ...faceFrame(outwardNormal.clone().normalize(), screenUp),
  };
}

/** Coin (d2): two labelled discs plus a decorative rim. */
function coinFaces(screenUp: THREE.Vector3): DieFace[] {
  const radius = 0.62;
  const half = 0.07;
  const segments = 12;
  const ring: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  const faces: DieFace[] = [];
  for (const sign of [1, -1]) {
    const centre = new THREE.Vector3(0, sign * half, 0);
    const points = ring.map((p) => new THREE.Vector3(p.x, sign * half, p.z));
    faces.push(fanFace(centre, points, new THREE.Vector3(0, sign, 0), true, screenUp));
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const bottomA = new THREE.Vector3(ring[i].x, -half, ring[i].z);
    const bottomB = new THREE.Vector3(ring[j].x, -half, ring[j].z);
    const topA = new THREE.Vector3(ring[i].x, half, ring[i].z);
    const topB = new THREE.Vector3(ring[j].x, half, ring[j].z);
    faces.push(polygonFace([bottomA, topA, topB, bottomB], false, screenUp));
  }
  return faces;
}

/** Pentagonal trapezohedron: the real d10 shape, built as ten kites. */
function trapezohedronFaces(screenUp: THREE.Vector3): DieFace[] {
  const apex = 0.82;
  const radius = 0.92;
  const ring = 0.2;
  const sides = 5;
  const top = new THREE.Vector3(0, apex, 0);
  const bottom = new THREE.Vector3(0, -apex, 0);
  const upper: THREE.Vector3[] = [];
  const lower: THREE.Vector3[] = [];
  const step = (Math.PI / sides) * 2;
  const offset = Math.PI / sides; // lower ring sits half a step around
  for (let i = 0; i < sides; i++) {
    const angle = i * step;
    upper.push(new THREE.Vector3(Math.cos(angle) * radius, ring, Math.sin(angle) * radius));
    lower.push(
      new THREE.Vector3(
        Math.cos(angle + offset) * radius,
        -ring,
        Math.sin(angle + offset) * radius,
      ),
    );
  }
  const faces: DieFace[] = [];
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    faces.push(polygonFace([top, upper[i], lower[i], upper[next]], true, screenUp));
    faces.push(polygonFace([bottom, lower[i], upper[next], lower[next]], true, screenUp));
  }
  return faces;
}

/**
 * Faces of a three.js geometry, grouped by their flat normals: every
 * convex polyhedron face is a run of triangles sharing one normal, so
 * grouping recovers exactly one face per side.
 */
function facesFromGeometry(
  geometry: THREE.BufferGeometry,
  screenUp: THREE.Vector3,
): DieFace[] {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute("position");
  const groups: { normal: THREE.Vector3; triangles: THREE.Vector3[][] }[] = [];
  for (let i = 0; i < position.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(position, i);
    const b = new THREE.Vector3().fromBufferAttribute(position, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(position, i + 2);
    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) continue; // degenerate triangle
    normal.normalize();
    const last = groups[groups.length - 1];
    if (last && last.normal.dot(normal) > 0.999) last.triangles.push([a, b, c]);
    else groups.push({ normal, triangles: [[a, b, c]] });
  }
  if (groups.length === 0) throw new Error("geometry has no faces");
  return groups.map((group) =>
    outward(faceFromTriangles(group.triangles, true, screenUp), screenUp),
  );
}

const FACE_TABLE_CACHE = new Map<string, DieFace[]>();

/** Face table for `sides` (memoised per camera angle). */
export function dieTableFor(sides: number, screenUp: THREE.Vector3 = DEFAULT_SCREEN_UP): DieFace[] {
  const key = `${sides}|${screenUp.toArray().map((v) => v.toFixed(4)).join(",")}`;
  const cached = FACE_TABLE_CACHE.get(key);
  if (cached) return cached;
  const table = buildDieFaceTable(sides, screenUp);
  FACE_TABLE_CACHE.set(key, table);
  return table;
}

/** Build the face table for one die. Throws on sides without a mesh shape. */
export function buildDieFaceTable(sides: number, screenUp: THREE.Vector3 = DEFAULT_SCREEN_UP): DieFace[] {
  switch (sides) {
    case 2:
      return coinFaces(screenUp);
    case 4:
      return facesFromGeometry(new THREE.TetrahedronGeometry(1, 0), screenUp);
    case 6:
      return facesFromGeometry(new THREE.BoxGeometry(1.15, 1.15, 1.15), screenUp);
    case 8:
      return facesFromGeometry(new THREE.OctahedronGeometry(1.05, 0), screenUp);
    case 10:
      return trapezohedronFaces(screenUp);
    case 12:
      return facesFromGeometry(new THREE.DodecahedronGeometry(1.05, 0), screenUp);
    case 20:
      return facesFromGeometry(new THREE.IcosahedronGeometry(1.05, 0), screenUp);
    default:
      throw new Error(`unmeshable die: d${String(sides)}`);
  }
}

/** Atlas cell per face: cell 0 stays blank for decorative faces. */
function faceCells(labels: (string | null)[]): number[] {
  let next = 1;
  return labels.map((label) => (label ? next++ : 0));
}

/** Atlas size needed for `labels` (cells laid out in a square-ish grid). */
function atlasGrid(labels: (string | null)[]): { cols: number; rows: number } {
  // One slot per cell index actually used, plus the blank cell at 0.
  const cells = faceCells(labels).reduce((max, cell) => Math.max(max, cell + 1), 1);
  const cols = Math.ceil(Math.sqrt(cells));
  return { cols, rows: Math.ceil(cells / cols) };
}

/** Default labels for a die: 1..sides, blank on decorative faces. */
export function defaultFaceLabels(sides: number, screenUp?: THREE.Vector3): (string | null)[] {
  return dieTableFor(sides, screenUp).map((face, index) => (face.labeled ? String(index + 1) : null));
}

/** Face centre and half-extent in its own tangent plane, shared by the UVs. */
function faceMetrics(face: DieFace): { centre: THREE.Vector3; reach: number } {
  const centre = new THREE.Vector3();
  for (const tri of face.triangles) {
    for (const v of tri) centre.add(v);
  }
  centre.divideScalar(face.triangles.length * 3);
  let reach = 0;
  for (const tri of face.triangles) {
    for (const v of tri) {
      const d = v.clone().sub(centre);
      reach = Math.max(reach, Math.abs(d.dot(face.right)), Math.abs(d.dot(face.tangent)));
    }
  }
  return { centre, reach };
}

/** Distinct face vertices, projected into the face's own tangent plane. */
function faceOutline(face: DieFace, centre: THREE.Vector3): { x: number; y: number }[] {
  const seen = new Set<string>();
  const points: { x: number; y: number }[] = [];
  const bx = centre.dot(face.right);
  const by = centre.dot(face.tangent);
  for (const tri of face.triangles) {
    for (const v of tri) {
      const x = v.dot(face.right) - bx;
      const y = v.dot(face.tangent) - by;
      const key = `${Math.round(x * 1e4)}:${Math.round(y * 1e4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ x, y });
    }
  }
  return points;
}

type Point = { x: number; y: number };

/** Convex hull of `points` (monotone chain, counter-clockwise). */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const turn = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const chain = (input: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of input) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...chain(pts), ...chain([...pts].reverse())];
}

/**
 * How much room a centred label has: the smallest distance from the face
 * centre to one of its outline edges, as a fraction of the face
 * half-extent. Kites and triangles are narrower than their bounding box,
 * so their numbers must shrink to stay inside the shape.
 */
function faceFit(face: DieFace, metrics: { centre: THREE.Vector3; reach: number }): number {
  if (metrics.reach <= 0) return 1;
  const hull = convexHull(faceOutline(face, metrics.centre));
  if (hull.length < 3) return 1;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    nearest = Math.min(nearest, Math.abs(a.x * (b.y - a.y) - a.y * (b.x - a.x)) / len);
  }
  return Number.isFinite(nearest) ? Math.min(1, nearest / metrics.reach) : 1;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw the numbers for one die onto a canvas atlas. Each labelled face
 * gets a cell, and the UVs from `buildDieGeometry` point at that cell.
 */
export function buildDieAtlas(table: DieFace[], labels: (string | null)[]): HTMLCanvasElement {
  const { cols, rows } = atlasGrid(labels);
  const cells = faceCells(labels);
  const canvas = document.createElement("canvas");
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable (no WebGL surface)");

  table.forEach((face, index) => {
    const label = labels[index];
    if (!face.labeled || !label) return; // decorative faces stay blank
    const cell = cells[index];
    const x = (cell % cols) * CELL;
    const y = Math.floor(cell / cols) * CELL;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = IVORY;
    ctx.fillRect(0, 0, CELL, CELL);
    ctx.fillStyle = "rgba(44, 29, 16, 0.10)";
    roundedRect(ctx, 10, 10, CELL - 20, CELL - 20, 22);
    ctx.fill();
    ctx.strokeStyle = "rgba(44, 29, 16, 0.20)";
    ctx.lineWidth = 2;
    ctx.stroke();
    const base = label.length >= 3 ? CELL * 0.26 : label.length === 2 ? CELL * 0.3 : CELL * 0.36;
    // Shrink to the room the face really has, never below a readable size.
    const half = faceFit(face, faceMetrics(face)) * FILL * 0.45;
    const size = Math.max(CELL * 0.17, Math.min(base, half * CELL * 2));
    ctx.fillStyle = INK;
    ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, CELL / 2, CELL / 2 + size * 0.04);
    ctx.restore();
  });
  return canvas;
}

/**
 * Turn a face table into one non-indexed, flat-shaded geometry whose UVs
 * map each face onto its atlas cell. The mapping is uniform around the
 * face centre, so numbers keep their proportions on every shape.
 */
export function buildDieGeometry(
  table: DieFace[],
  labels: (string | null)[],
): THREE.BufferGeometry {
  const cells = faceCells(labels);
  const { cols, rows } = atlasGrid(labels);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  table.forEach((face, index) => {
    const cell = cells[index];
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const { centre, reach } = faceMetrics(face);
    if (reach === 0) throw new Error("degenerate die face");

    const local: { x: number; y: number }[] = [];
    for (const tri of face.triangles) {
      for (const v of tri) {
        const d = v.clone().sub(centre);
        local.push({ x: d.dot(face.right), y: d.dot(face.tangent) });
      }
    }

    for (const tri of face.triangles) {
      for (const v of tri) {
        positions.push(v.x, v.y, v.z);
        normals.push(face.normal.x, face.normal.y, face.normal.z);
        const p = local.shift()!;
        const cx = 0.5 + (p.x / reach) * FILL * 0.5;
        const cy = 0.5 - (p.y / reach) * FILL * 0.5;
        uvs.push((col + cx) / cols, 1 - (row + cy) / rows);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Rotation that puts `face` on top with its number reading upright. */
export function faceAimQuaternion(
  face: DieFace,
  screenUp: THREE.Vector3 = DEFAULT_SCREEN_UP,
): THREE.Quaternion {
  const up = WORLD_UP.clone();
  // Where the number's "up" should land on the table plane.
  const aim = projected(screenUp, up) ?? projected(VIEW_AWAY, up) ?? VIEW_AWAY.clone();
  const source = new THREE.Matrix4().makeBasis(face.right, face.tangent, face.normal);
  const target = new THREE.Matrix4().makeBasis(aim.clone().cross(up), aim, up);
  return new THREE.Quaternion().setFromRotationMatrix(target.multiply(source.transpose()));
}

/** Material for one die: the atlas texture on a bone-like surface. */
export function createDieMaterial(atlas: HTMLCanvasElement): THREE.MeshStandardMaterial {
  const texture = new THREE.CanvasTexture(atlas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.52,
    metalness: 0.04,
  });
}
