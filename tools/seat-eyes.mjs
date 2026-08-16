// Seats the eyes proud of the skull, in place, in src/mesh.js.
//
// Run with `node tools/seat-eyes.mjs`, last in the pipeline — after decimation,
// since that moves the skull around the eye and can push it back through.
//
// An eye is a five-triangle pentagon sitting on a curved skull. The pentagon is
// very nearly flat and the skull is not, so parts of the rim end up *inside* the
// head: the skull wins the depth test there and slices a piece off the eye,
// which shows as a black pentagon with a white bite out of one side.
//
// Neither surface is wrong. They interpenetrate because the model was built to
// be printed in pieces and glued, and a glued-on eye does not have to be
// coplanar with anything. So the fix is the same as the physical one — sit the
// eye slightly proud — and the only question is how far. That is measured rather
// than guessed: the cap is stepped outward along its own normal until nothing
// crosses it any more, then given a small margin on top.

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
// Dark and not flagged rainbow — the mane is stored black with the flag set.
const isEye = (t) => C[t * 12 + 3] < 0.5 && C[t * 12] < 0.1;
const isBody = (t) => C[t * 12] > 0.9 && C[t * 12 + 1] > 0.9 && C[t * 12 + 2] > 0.9;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Does the segment pq pass through triangle abc, strictly between its ends? */
function crosses(p, q, a, b, c) {
  const d = sub(q, p);
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const s = sub(p, a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const qq = cross(s, e1);
  const v = f * dot(d, qq);
  if (v < 0 || u + v > 1) return false;
  const t = f * dot(e2, qq);
  return t > 1e-6 && t < 1 - 1e-6;
}

const eyes = [];
const bodies = [];
for (let t = 0; t < count; t++) {
  if (isEye(t)) eyes.push(t);
  else if (isBody(t)) bodies.push(t);
}
if (!eyes.length) {
  console.log('no eyes found — nothing to do');
  process.exit(0);
}

// Outward direction: the area-weighted normal of the cap itself, so this works
// whatever angle the eye ended up at and needs no hand-entered axis.
let N = [0, 0, 0];
for (const t of eyes) {
  const f = tri(t);
  const q = cross(sub(f[1], f[0]), sub(f[2], f[0]));
  N = [N[0] + q[0], N[1] + q[1], N[2] + q[2]];
}
const len = Math.hypot(...N);
N = N.map((q) => q / len);

const eyeVerts = eyes.flatMap(tri);
const near = bodies.filter((t) =>
  tri(t).some((v) => eyeVerts.some((e) => Math.hypot(v[0] - e[0], v[1] - e[1], v[2] - e[2]) < 0.2)),
);

const cutsAt = (off) => {
  let n = 0;
  for (const et of eyes) {
    const E = tri(et).map((v) => [v[0] + N[0] * off, v[1] + N[1] * off, v[2] + N[2] * off]);
    let any = false;
    for (const t of near) {
      const B = tri(t);
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        if (crosses(B[i], B[j], E[0], E[1], E[2])) any = true;
        if (crosses(E[i], E[j], B[0], B[1], B[2])) any = true;
      }
    }
    if (any) n++;
  }
  return n;
};

const before = cutsAt(0);
if (!before) {
  console.log('eyes already clear of the skull — nothing to do');
  process.exit(0);
}

let need = null;
for (let off = 0; off <= 0.08; off += 0.001) {
  if (!cutsAt(off)) {
    need = off;
    break;
  }
}
if (need === null) throw new Error('the eye cannot be cleared by moving it outwards — the skull must be wrong');

// A margin on top of the measured clearance. Not decoration: the two surfaces
// merely stop crossing at `need`, which leaves them touching, and touching
// surfaces flicker as the depth test picks a different winner per pixel.
const off = +(need + 0.003).toFixed(4);

for (const t of eyes) {
  for (let k = 0; k < 3; k++) {
    for (let a = 0; a < 3; a++) {
      P[t * 9 + k * 3 + a] = +(P[t * 9 + k * 3 + a] + N[a] * off).toFixed(4);
    }
  }
}

console.log(`${eyes.length} eye faces, ${before} of them cut by the skull`);
console.log(`  outward normal ${N.map((q) => q.toFixed(3)).join(', ')}`);
console.log(`  clears at ${need.toFixed(4)}, moved ${off} with margin`);
console.log(`  faces still cut: ${cutsAt(off)}`);

writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(P) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(C) +
    src.slice(at('MESH_C')[1]),
);
