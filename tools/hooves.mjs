// Replaces the hooves with plain tapered boxes, in place, in src/mesh.js.
//
// Run with `node tools/hooves.mjs`, after decimation. Idempotent — a second run
// measures the boxes it just wrote and regenerates them identically.
//
// The reference's hooves were never four hooves. The print model has a single
// part holding all four caps laid out flat on a print bed, so stl2mesh took one
// of them and stamped it at each leg — *translated*, not mirrored. That is why
// they were the one piece with no mirror symmetry at all, and why decimation
// left them lopsided: each was an irregular cap being simplified on its own
// terms, with no shape worth preserving.
//
// A hoof at this scale is a dark wedge a few pixels across. It does not need to
// be a scan of a hoof; it needs to be the same simple shape four times. So it is
// generated: a box, square in plan, tapered so the bottom is wider than the top
// the way a real hoof flares. Ten triangles — four sides and a base — which is
// exactly what the irregular caps were costing, so the shape improves for free.
//
// No top face. It would sit inside the leg, invisible from any angle, and this
// is a model where a hidden face is a face not worth storing.

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
// Not white, not flagged rainbow, not the near-black of an eye.
const isHoof = (t) => {
  const c = C.slice(t * 12, t * 12 + 4);
  return c[3] < 0.5 && c[0] > 0.1 && c[0] < 0.5;
};

// Only the z > 0 legs are stored; game.js mirrors them to the other side.
const LEGS = [
  [0.39, 0.32, 'front'],
  [-0.55, 0.32, 'hind'],
];

const old = [];
for (let t = 0; t < count; t++) if (isHoof(t)) old.push(t);
if (!old.length) throw new Error('no hoof faces found — has the colour changed?');
const colour = C.slice(old[0] * 12, old[0] * 12 + 4);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Where the existing hoof sits, so the replacement occupies the same space. */
function boxOf(lx, lz) {
  const vs = [];
  for (const t of old) {
    const f = tri(t);
    const cx = (f[0][0] + f[1][0] + f[2][0]) / 3;
    const cz = (f[0][2] + f[1][2] + f[2][2]) / 3;
    if (Math.hypot(cx - lx, cz - lz) < 0.3) vs.push(...f);
  }
  if (!vs.length) throw new Error(`no hoof found at leg ${lx}, ${lz}`);
  const lo = [0, 1, 2].map((a) => Math.min(...vs.map((v) => v[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...vs.map((v) => v[a])));
  return { lo, hi, faces: vs.length / 3 };
}

/**
 * Tucks the foot inside the hoof.
 *
 * The reference's cap was a socket that plugged onto a narrow spigot at the
 * ankle, so it is much smaller than the foot around it, and the leg's own
 * underside sticks out past the black box as a white fringe — the crack.
 *
 * Growing the hoof to swallow the foot is the obvious answer and it is wrong:
 * the foot is nearly twice the cap's width, so the hoof comes out wider than the
 * leg above it and the pony ends up in boots. The foot is the part nobody sees —
 * it is under the hoof — so the foot moves instead. Corners low enough to be
 * inside the hoof get pulled within its footprint, which narrows the very bottom
 * of the leg into the hoof and leaves the silhouette above untouched.
 */
function tuck(lx, lz, cx, cz, half, yTop) {
  const inset = half * 0.92;
  let moved = 0;
  let worst = 0;
  for (let i = 0; i < P.length; i += 3) {
    const v = [P[i], P[i + 1], P[i + 2]];
    // Only the part swallowed by the hoof. Reaching higher would drag the ankle
    // in with it and pinch the leg where it is meant to be seen.
    if (v[1] > yTop * 0.75) continue;
    if (Math.hypot(v[0] - lx, v[2] - lz) > 0.26) continue;
    const nx = Math.min(Math.max(v[0], cx - inset), cx + inset);
    const nz = Math.min(Math.max(v[2], cz - inset), cz + inset);
    const d = Math.hypot(nx - v[0], nz - v[2]);
    if (d < 1e-9) continue;
    P[i] = +nx.toFixed(4);
    P[i + 2] = +nz.toFixed(4);
    moved++;
    worst = Math.max(worst, d);
  }
  return { moved, worst };
}

// How much narrower the top is than the base. A hoof flares outwards at the
// ground; taper it the other way and it reads as a peg the leg is standing on.
const TAPER = 0.8;

const addP = [];
const addC = [];
function build(lx, lz, name) {
  const { lo, hi, faces } = boxOf(lx, lz);
  // Square in plan, from the mean of the two measured widths — the point is a
  // regular shape, and keeping the reference's slight rectangularity would carry
  // over exactly the lopsidedness being removed.
  const half = (((hi[0] - lo[0]) + (hi[2] - lo[2])) / 4 + 0.012) * 1.15;
  const cx = (lo[0] + hi[0]) / 2;
  const cz = (lo[2] + hi[2]) / 2;
  const y0 = lo[1];
  const y1 = hi[1];

  const ring = (w, y) =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [cx + sx * w, y, cz + sz * w]);
  const B = ring(half, y0);
  const T = ring(half * TAPER, y1);

  const face = (a, b, c) => {
    for (const v of [a, b, c]) {
      addP.push(...v.map((n) => +n.toFixed(4)));
      addC.push(...colour);
    }
  };
  // Base. This corner order gives it a downward normal, and every side below
  // follows from the same order, so all five faces come out pointing outwards.
  face(B[0], B[1], B[2]);
  face(B[0], B[2], B[3]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    face(B[i], T[i], T[j]);
    face(B[i], T[j], B[j]);
  }
  const { moved, worst } = tuck(lx, lz, cx, cz, half, y1);
  console.log(
    `  ${name.padEnd(6)} ${faces} faces -> 10   half-width ${half.toFixed(4)}   y ${y0.toFixed(3)}..${y1.toFixed(3)}` +
      `   tucked ${moved} foot corners in, furthest ${worst.toFixed(4)}`,
  );
}

console.log(`${old.length} hoof faces stored across ${LEGS.length} legs`);
for (const [lx, lz, name] of LEGS) build(lx, lz, name);

const outP = [];
const outC = [];
for (let t = 0; t < count; t++) {
  if (isHoof(t)) continue;
  outP.push(...P.slice(t * 9, t * 9 + 9));
  outC.push(...C.slice(t * 12, t * 12 + 12));
}
outP.push(...addP);
outC.push(...addC);

console.log(`\n${count} -> ${outP.length / 9} stored triangles (renders ${(outP.length / 9) * 2})`);

writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
    src.slice(at('MESH_C')[1]),
);
