// Cuts the unicorn in half down the spine, in place, in src/mesh.js.
//
// Run with `node tools/symmetrize.mjs`. game.js mirrors the half back at load,
// so only one side is ever stored.
//
// The reference is not actually symmetric — a little over half its faces have a
// mirror twin, and the hooves have none at all, because they were stamped from a
// single foot translated to four positions rather than mirrored. So this does
// not *detect* symmetry, it *imposes* it: the z > 0 side is kept and becomes
// both sides. At this polygon count the difference is invisible, and it halves
// the largest thing in the budget.
//
// Faces crossing the centre are clipped against z = 0 rather than assigned to a
// side by their centroid. Assigning whole faces leaves a ragged seam, and a
// ragged seam mirrored against itself gives interpenetrating flaps down the
// spine and gaps under the belly. Clipping puts every cut corner exactly on the
// plane, so the two halves meet along a shared edge loop and the result is
// closed.

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
const SNAP = 2e-3; // corners this close to the centre are pulled onto it

const outP = [];
const outC = [];
let kept = 0;
let clipped = 0;
let dropped = 0;

const area = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
};

for (let t = 0; t < count; t++) {
  const f = [0, 3, 6].map((o) => {
    const v = [P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]];
    if (Math.abs(v[2]) < SNAP) v[2] = 0;
    return v;
  });
  const col = C.slice(t * 12, t * 12 + 4);

  const sign = f.map((v) => (v[2] > 0 ? 1 : v[2] < 0 ? -1 : 0));
  if (sign.every((s) => s <= 0)) {
    if (sign.some((s) => s < 0)) dropped++;
    continue; // wholly on the far side, or lying in the plane (its mirror covers it)
  }

  let poly;
  if (sign.every((s) => s >= 0)) {
    poly = f;
    kept++;
  } else {
    // Sutherland–Hodgman against z >= 0. Corners on the plane are kept as they
    // are, which is what makes the seam land on shared vertices instead of on
    // two nearly-equal ones that would leave a hairline crack.
    poly = [];
    for (let i = 0; i < 3; i++) {
      const a = f[i];
      const b = f[(i + 1) % 3];
      if (a[2] >= 0) poly.push(a);
      if ((a[2] > 0 && b[2] < 0) || (a[2] < 0 && b[2] > 0)) {
        const s = a[2] / (a[2] - b[2]);
        poly.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, 0]);
      }
    }
    clipped++;
  }

  for (let i = 1; i + 1 < poly.length; i++) {
    const t3 = [poly[0], poly[i], poly[i + 1]];
    if (area(...t3) < 1e-9) continue;
    for (const v of t3) {
      outP.push(...v.map((n) => +n.toFixed(4)));
      outC.push(...col);
    }
  }
}

const half = outP.length / 9;
console.log(`${count} triangles -> ${half} stored`);
console.log(`  ${kept} kept whole, ${clipped} clipped at the centre, ${dropped} dropped from the far side`);
console.log(`  renders as ${half * 2} once game.js mirrors it back`);

writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
    src.slice(at('MESH_C')[1]),
);
