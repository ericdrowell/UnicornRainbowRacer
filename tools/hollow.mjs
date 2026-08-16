// Strips the geometry sealed inside the unicorn, in place, in src/mesh.js.
//
// Run with `node tools/hollow.mjs`. Idempotent: a second run finds nothing.
//
// The reference is a model for printing in pieces, so it is not a shell — it is
// a pile of interpenetrating closed solids. The wings and hair have tenons that
// run down inside the body, the eyes are whole spheres sunk into the head, the
// hooves are caps stamped over the ends of the legs, and the body keeps its own
// surface underneath all of them. None of it is ever visible and all of it is
// paid for in the budget.
//
// The test is visibility, not containment. Containment — "is this face inside
// some other piece" — sounds equivalent and is not: it misses faces buried by
// two pieces jointly while inside neither, and it cannot classify the mating
// rims at all, because the pieces are designed to meet exactly and a rim vertex
// sits *on* the other surface rather than in it. Asking instead whether a face
// can be seen from anywhere outside covers every case without special-casing
// any of them.
//
// So: fire rays outward from each face and keep it the moment one escapes. Only
// the outward side is tested, since the renderer culls back faces, and a face
// is dropped only when every ray from every sample point is blocked.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'src', 'mesh.js');
const src = readFileSync(file, 'utf8');
const at = (name) => {
  const i = src.indexOf(name);
  return [src.indexOf('[', i), src.indexOf(']', i) + 1];
};
const P = JSON.parse(src.slice(...at('MESH_P')));
const C = JSON.parse(src.slice(...at('MESH_C')));

const count = P.length / 9;
const tri = (t) => [0, 3, 6].map((o) => [P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const NRM = [];
const LO = [];
const HI = [];
for (let t = 0; t < count; t++) {
  const v = tri(t);
  NRM.push(norm(cross(sub(v[1], v[0]), sub(v[2], v[0]))));
  LO.push([0, 1, 2].map((a) => Math.min(v[0][a], v[1][a], v[2][a])));
  HI.push([0, 1, 2].map((a) => Math.max(v[0][a], v[1][a], v[2][a])));
}

/** Möller–Trumbore, both facings — geometry blocks sight whichever way it faces. */
function blocked(o, d, t) {
  const v = tri(t);
  const e1 = sub(v[1], v[0]);
  const e2 = sub(v[2], v[0]);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const s = sub(o, v[0]);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const w = f * dot(d, q);
  if (w < 0 || u + w > 1) return false;
  return f * dot(e2, q) > 1e-5;
}

/** Slab test, so most faces are rejected without the full intersection. */
function mayBlock(o, inv, t) {
  let near = 0;
  let far = Infinity;
  for (let a = 0; a < 3; a++) {
    let t0 = (LO[t][a] - o[a]) * inv[a];
    let t1 = (HI[t][a] - o[a]) * inv[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return false;
  }
  return true;
}

// Directions over the outward hemisphere, spread by the golden angle so they do
// not line up with the model's own symmetry. The face normal goes first: for
// anything on the outside it escapes immediately and the rest are never cast.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
function fan(n, k) {
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const r = norm(cross(n, up));
  const b = cross(n, r);
  const out = [n];
  for (let i = 0; i < k; i++) {
    // Biased towards the normal: a face peeking out of a crevice is seen from
    // near its own facing, and grazing angles rarely decide anything.
    const y = 1 - ((i + 0.5) / k) * 0.92;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * GOLDEN;
    const c = Math.cos(th) * rad;
    const s = Math.sin(th) * rad;
    out.push([n[0] * y + r[0] * c + b[0] * s, n[1] * y + r[1] * c + b[1] * s, n[2] * y + r[2] * c + b[2] * s]);
  }
  return out;
}

const RAYS = 48;
const EPS = 1e-4;

const eyeAt = [];
for (let t = 0; t < count; t++) {
  const c = C.slice(t * 12, t * 12 + 4);
  // Dark *and* not flagged rainbow. The mane and tail are stored black with the
  // flag set, so testing darkness alone catches the entire mane.
  if (c[3] < 0.5 && c[0] < 0.1) for (const v of tri(t)) eyeAt.push(v);
}
const nearEye = (v) =>
  v.some((p) => eyeAt.some((e) => Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]) < EYE_PAD));

// Everything at hoof height is kept regardless.
//
// The visibility test is done in the rest pose, and that is a fair assumption
// almost everywhere — but not here. The hooves are caps stamped over the ends of
// the legs, so the seam between cap and leg is buried while the model stands
// still and swings into view as the leg lifts and rotates. Judged at rest the
// test removes it, and the result is right for exactly one frame of the gait.
//
// Rather than pose the model at every phase and take the union, which is a lot
// of machinery for one known region, the ankles down are simply exempt.
const KEEP_BELOW = 0.22;

// The head keeps its surface behind the eyes, for a different reason.
//
// An eye is a whole sphere sunk into the head, so the head's own surface behind
// it really is invisible and the test really does remove it. That leaves a hole
// with nothing but the eye's front cap over it — and cap and skull are separate
// surfaces that share no edge, so nothing holds them together. Decimation then
// moves each independently and the cap stops covering the hole, which reads as a
// gap at the rim with the background showing through the head.
//
// Keeping the skull closed under the eye costs a few faces and makes the join
// unbreakable: the eye can sit proud, sink, or drift, and there is still solid
// head behind it.
const EYE_PAD = 0.07;

function visible(t) {
  const v = tri(t);
  if (Math.min(v[0][1], v[1][1], v[2][1]) < KEEP_BELOW) return true;
  // Only the *skull* around the eye is exempt, not the eye itself. The eye's own
  // buried hemisphere is genuinely never seen and there is no reason to carry
  // it; what has to survive is the head behind it, so there is no hole to leave
  // uncovered.
  const col = C.slice(t * 12, t * 12 + 4);
  if (!(col[3] < 0.5 && col[0] < 0.1) && nearEye(v)) return true;
  const n = NRM[t];
  const c = [0, 1, 2].map((a) => (v[0][a] + v[1][a] + v[2][a]) / 3);
  // The centroid plus each corner drawn in towards it. One sample can call a
  // face hidden when only a sliver of it shows, and a sliver is still visible.
  const origins = [c, ...v.map((q) => [0, 1, 2].map((a) => q[a] * 0.25 + c[a] * 0.75))].map((p) =>
    [0, 1, 2].map((a) => p[a] + n[a] * EPS),
  );
  for (const d of fan(n, RAYS)) {
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    for (const o of origins) {
      let hit = false;
      for (let k = 0; k < count && !hit; k++) {
        if (k !== t && mayBlock(o, inv, k) && blocked(o, d, k)) hit = true;
      }
      if (!hit) return true; // escaped — this face can be seen
    }
  }
  return false;
}

const label = (t) => {
  const c = C.slice(t * 12, t * 12 + 4);
  if (c[3] > 0.5) return 'mane / tail';
  if (c[0] > 0.9 && c[1] > 0.9 && c[2] > 0.9) return 'body';
  if (c[0] > 0.9 && c[1] < 0.75 && c[2] > 0.6) return 'wing';
  if (c[0] > 0.9 && c[1] > 0.7 && c[2] < 0.5) return 'horn';
  if (c[0] < 0.1) return 'eye';
  return 'hoof';
};

const drop = new Set();
const tally = new Map();
const kept = new Map();
for (let t = 0; t < count; t++) {
  if (visible(t)) {
    kept.set(label(t), (kept.get(label(t)) || 0) + 1);
  } else {
    drop.add(t);
    tally.set(label(t), (tally.get(label(t)) || 0) + 1);
  }
}

console.log(`${count} triangles tested\n`);
if (!drop.size) {
  console.log('nothing hidden — already a shell');
  process.exit(0);
}
console.log('  piece           kept   removed');
for (const k of new Set([...kept.keys(), ...tally.keys()])) {
  console.log(`  ${k.padEnd(14)} ${String(kept.get(k) || 0).padStart(5)} ${String(tally.get(k) || 0).padStart(9)}`);
}
console.log(`\n${count} -> ${count - drop.size} triangles (${((drop.size / count) * 100).toFixed(1)}% removed)`);

const outP = [];
const outC = [];
for (let t = 0; t < count; t++) {
  if (drop.has(t)) continue;
  outP.push(...P.slice(t * 9, t * 9 + 9));
  outC.push(...C.slice(t * 12, t * 12 + 12));
}
writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
    src.slice(at('MESH_C')[1]),
);
