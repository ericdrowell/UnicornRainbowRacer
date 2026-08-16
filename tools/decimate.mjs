// Reduces the triangle count of src/mesh.js by collapsing edges.
//
// Run with `node tools/decimate.mjs [fraction]` — default 0.5, meaning half the
// triangles. Writes in place.
//
// Garland–Heckbert: every vertex carries a quadric, the sum of squared distances
// to the planes of the faces meeting it, and collapsing an edge costs whatever
// that sum evaluates to at the merged position. Flat regions cost nothing to
// simplify and creases cost a lot, so detail is taken from the barrel and the
// haunches long before it is taken from the muzzle or the horn.
//
// Three things about *this* mesh shape the implementation:
//
// - Vertices are welded per piece, not globally. The pieces are designed to
//   mate, so a tenon rim and its socket rim sit at identical coordinates;
//   welding by position alone fuses wing into body and lets a collapse drag one
//   piece's surface through another's.
//
// - Open borders are pinned. Hollowing left real boundaries where buried faces
//   were removed, and an unconstrained collapse eats into them, which reopens
//   the interior from outside. Each border edge contributes a plane through
//   itself perpendicular to its face, at heavy weight.
//
// - No collapse may flip a face. Cheap by the quadric and catastrophic on
//   screen: the surface passes through itself and the shading inverts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = Number(process.argv[2] || 0.5);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'src', 'mesh.js');
const src = readFileSync(file, 'utf8');
const at = (name) => {
  const i = src.indexOf(name);
  return [src.indexOf('[', i), src.indexOf(']', i) + 1];
};
const P = JSON.parse(src.slice(...at('MESH_P')));
const C = JSON.parse(src.slice(...at('MESH_C')));

const label = (t) => {
  const c = C.slice(t * 12, t * 12 + 4);
  if (c[3] > 0.5) return 'mane';
  if (c[0] > 0.9 && c[1] > 0.9 && c[2] > 0.9) return 'body';
  if (c[0] > 0.9 && c[1] < 0.75 && c[2] > 0.6) return 'wing';
  if (c[0] > 0.9 && c[1] > 0.7 && c[2] < 0.5) return 'horn';
  if (c[0] < 0.1) return 'eye';
  return 'hoof';
};

// ── Build a shared-vertex mesh, per piece ───────────────────────────────────
const verts = [];
const index = new Map();
const faces = [];
const faceCol = [];
const faceLabel = [];
for (let t = 0; t < P.length / 9; t++) {
  const lab = label(t);
  const f = [];
  for (const o of [0, 3, 6]) {
    const v = [P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]];
    const k = lab + '|' + v.map((n) => n.toFixed(4)).join(',');
    if (!index.has(k)) {
      index.set(k, verts.length);
      verts.push(v);
    }
    f.push(index.get(k));
  }
  if (f[0] === f[1] || f[1] === f[2] || f[2] === f[0]) continue;
  faces.push(f);
  faceCol.push(C.slice(t * 12, t * 12 + 4));
  faceLabel.push(lab);
}

const startFaces = faces.length;
const dead = new Array(faces.length).fill(false);
const vfaces = verts.map(() => new Set());
faces.forEach((f, i) => f.forEach((v) => vfaces[v].add(i)));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function planeOf(f) {
  const [a, b, c] = f.map((v) => verts[v]);
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n);
  if (l < 1e-12) return null;
  const u = [n[0] / l, n[1] / l, n[2] / l];
  return [u[0], u[1], u[2], -dot(u, a), l / 2];
}

/** Symmetric 4x4 as ten floats: xx xy xz xw yy yz yw zz zw ww. */
const quadric = (p, w) => {
  const [a, b, c, d] = p;
  return [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d].map((x) => x * w);
};
const addQ = (q, r) => {
  for (let i = 0; i < 10; i++) q[i] += r[i];
};
const evalQ = (q, v) => {
  const [x, y, z] = v;
  return (
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
    q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
    q[7] * z * z + 2 * q[8] * z + q[9]
  );
};

const Q = verts.map(() => new Array(10).fill(0));
for (const f of faces) {
  const p = planeOf(f);
  if (!p) continue;
  const q = quadric(p, p[4]); // area-weighted: big faces matter more
  for (const v of f) addQ(Q[v], q);
}

// Border edges: pin them, or hollowing's open seams erode and the inside shows.
const edgeUse = new Map();
faces.forEach((f, i) => {
  for (let k = 0; k < 3; k++) {
    const a = f[k];
    const b = f[(k + 1) % 3];
    const key = Math.min(a, b) + ':' + Math.max(a, b);
    if (!edgeUse.has(key)) edgeUse.set(key, []);
    edgeUse.get(key).push(i);
  }
});
let borders = 0;
for (const [key, fs] of edgeUse) {
  if (fs.length !== 1) continue;
  borders++;
  const [a, b] = key.split(':').map(Number);
  const p = planeOf(faces[fs[0]]);
  if (!p) continue;
  const dir = sub(verts[b], verts[a]);
  const n = cross(dir, [p[0], p[1], p[2]]);
  const l = Math.hypot(...n);
  if (l < 1e-12) continue;
  const u = [n[0] / l, n[1] / l, n[2] / l];
  const plane = [u[0], u[1], u[2], -dot(u, verts[a])];
  const q = quadric(plane, 400);
  addQ(Q[a], q);
  addQ(Q[b], q);
}

// ── Collapse ────────────────────────────────────────────────────────────────
// Vertices on the centre plane are constrained to stay on it. The mesh is half a
// unicorn and game.js mirrors it, so the seam is shared by both halves: let a
// seam vertex drift off z = 0 and the two copies no longer meet, which shows as
// a crack down the spine and under the belly. Pinning them outright would also
// work and would leave the spine stuck at full density, so instead they slide
// within the plane — two seam vertices merge to a point still on it, and a
// vertex off the seam merges *into* the seam vertex rather than dragging it off.
const seam = verts.map((v) => Math.abs(v[2]) < 1e-9);
const seamCount = seam.filter(Boolean).length;

// The eyes are held out of the collapse entirely.
//
// A quadric measures deviation from the surface, which is the wrong question for
// a feature whose whole job is to be a recognisable shape at a specific size. An
// eye is a small, nearly flat dark patch — cheap by that measure and the first
// thing to go, and a face reads as wrong the instant its eye is the wrong size.
// Left free, the two eyes here collapse from 42 triangles to 2 and become
// slivers. They are a handful of faces; keeping all of them costs almost
// nothing.
const locked = verts.map(() => false);
faces.forEach((f, i) => {
  if (faceLabel[i] === 'eye') f.forEach((v) => (locked[v] = true));
});
const lockedCount = locked.filter(Boolean).length;

function constrain(i, j, v) {
  if (seam[i] && seam[j]) return [v[0], v[1], 0];
  if (seam[i]) return verts[i].slice();
  if (seam[j]) return verts[j].slice();
  return v;
}

/** Best merged position: the quadric's minimum, or the best obvious candidate. */
function placement(i, j) {
  const q = Q[i].map((x, k) => x + Q[j][k]);
  const m = [
    [q[0], q[1], q[2]],
    [q[1], q[4], q[5]],
    [q[2], q[5], q[7]],
  ];
  const rhs = [-q[3], -q[6], -q[8]];
  const candidates = [];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) > 1e-10) {
    const inv = (r, c) => {
      const a = [0, 1, 2].filter((x) => x !== r);
      const b = [0, 1, 2].filter((x) => x !== c);
      const s = (r + c) % 2 ? -1 : 1;
      return (s * (m[b[0]][a[0]] * m[b[1]][a[1]] - m[b[0]][a[1]] * m[b[1]][a[0]])) / det;
    };
    const v = [0, 1, 2].map((r) => inv(r, 0) * rhs[0] + inv(r, 1) * rhs[1] + inv(r, 2) * rhs[2]);
    if (v.every(Number.isFinite)) candidates.push(v);
  }
  candidates.push(verts[i], verts[j], verts[i].map((x, k) => (x + verts[j][k]) / 2));
  let best = null;
  // Cost is measured at the constrained point, not the free one — otherwise the
  // seam collapses look cheaper than they are and get chosen first.
  for (const v of candidates) {
    const p = constrain(i, j, v);
    const c = evalQ(q, p);
    if (!best || c < best[1]) best = [p.slice(), c];
  }
  return best;
}

/** Would any surviving face turn inside out? */
function flips(i, j, p) {
  for (const v of [i, j]) {
    for (const fi of vfaces[v]) {
      if (dead[fi]) continue;
      const f = faces[fi];
      if (f.includes(i) && f.includes(j)) continue; // dies in the collapse
      const before = planeOf(f);
      if (!before) continue;
      const moved = f.map((x) => (x === i || x === j ? p : verts[x]));
      const n = cross(sub(moved[1], moved[0]), sub(moved[2], moved[0]));
      const l = Math.hypot(...n);
      if (l < 1e-11) return true;
      if (dot([before[0], before[1], before[2]], [n[0] / l, n[1] / l, n[2] / l]) < 0.1) return true;
    }
  }
  return false;
}

const target = Math.max(4, Math.round(startFaces * KEEP));
let live = faces.length;
let stalled = 0;

while (live > target) {
  // Rebuild the candidate list from the live faces, cheapest first. Slower than
  // maintaining a heap and small enough here that the simpler version is worth
  // having.
  const ranked = [];
  const seen = new Set();
  for (let fi = 0; fi < faces.length; fi++) {
    if (dead[fi]) continue;
    const f = faces[fi];
    for (let k = 0; k < 3; k++) {
      const a = Math.min(f[k], f[(k + 1) % 3]);
      const b = Math.max(f[k], f[(k + 1) % 3]);
      const key = a + ':' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      if (locked[a] || locked[b]) continue;
      const [p, cost] = placement(a, b);
      ranked.push({ a, b, p, cost });
    }
  }
  if (!ranked.length) break;
  ranked.sort((x, y) => x.cost - y.cost);

  let done = false;
  for (const cand of ranked) {
    if (flips(cand.a, cand.b, cand.p)) continue;
    const { a, b, p } = cand;
    verts[a] = p;
    addQ(Q[a], Q[b]);
    for (const fi of vfaces[b]) {
      if (dead[fi]) continue;
      const f = faces[fi];
      for (let k = 0; k < 3; k++) if (f[k] === b) f[k] = a;
      if (f[0] === f[1] || f[1] === f[2] || f[2] === f[0]) {
        dead[fi] = true;
        live--;
      } else {
        vfaces[a].add(fi);
      }
    }
    vfaces[b].clear();
    done = true;
    break;
  }
  if (!done) {
    stalled++;
    break;
  }
}

const outP = [];
const outC = [];
let kept = 0;
for (let fi = 0; fi < faces.length; fi++) {
  if (dead[fi]) continue;
  kept++;
  for (const v of faces[fi]) {
    outP.push(...verts[v].map((n) => +n.toFixed(4)));
    outC.push(...faceCol[fi]);
  }
}

const tally = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  if (dead[fi]) continue;
  tally.set(faceLabel[fi], (tally.get(faceLabel[fi]) || 0) + 1);
}
const was = new Map();
faceLabel.forEach((l) => was.set(l, (was.get(l) || 0) + 1));

console.log(`${startFaces} triangles, ${borders} border edges pinned, ${seamCount} vertices held on the centre plane, ${lockedCount} locked (eyes)\n`);
console.log('  piece    before   after');
for (const k of was.keys()) {
  console.log(`  ${k.padEnd(8)} ${String(was.get(k)).padStart(6)} ${String(tally.get(k) || 0).padStart(7)}`);
}
console.log(`\n${startFaces} -> ${kept} triangles (${((1 - kept / startFaces) * 100).toFixed(1)}% removed)`);
if (stalled) console.log('stopped early: every remaining collapse would fold the surface');

writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
    src.slice(at('MESH_C')[1]),
);
