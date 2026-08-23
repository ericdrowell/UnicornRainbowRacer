// Subdivides and relaxes the wings, in place, in src/mesh.js.
//
// Run with `node tools/smooth-wings.mjs`. Idempotent: it counts the wing faces
// and exits if they have already been subdivided.
//
// The wings ship at 22 triangles over 14 vertices each, which is too coarse for
// a shape that is mostly silhouette. Every crease in the reference model lands
// on an edge, so the outline is a run of straight segments meeting at hard
// corners — the "pointy" look. No amount of shading fixes that, because the
// problem is the outline itself, and the outline is geometry.
//
// Two passes, and both are needed:
//
//   Subdivide splits every triangle on its edge midpoints, one into four. On its
//   own this changes nothing visible — the midpoint of a straight edge is on the
//   same straight edge — but it supplies the vertices the next step moves.
//
//   Relax then walks each interior vertex toward the average of its neighbours.
//   That is what actually rounds the corners: a vertex sitting at a sharp point
//   has neighbours spread wide around it, so the average pulls it inward, while a
//   vertex already on a flat run has neighbours either side and barely moves.
//
// Boundary vertices are pinned. The wing is an open shell with a short boundary
// where it meets the shoulder — a tenon that interpenetrates the body rather than
// welding to it — and relaxing that rim walks it out of the socket and opens a
// gap you can see straight through. Three of its vertices coincide exactly with
// vertices elsewhere in the model; those are pinned for the same reason.

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
const read = (name) => JSON.parse(src.slice(...at(name)));
const P = read('MESH_P');
const C = read('MESH_C');

const RELAX_PASSES = 3;
/** How far a vertex moves toward its neighbours each pass. */
const RELAX = 0.55;

const faces = P.length / 9;
const isWing = (t) => Math.abs(C[t * 12] - 1) < 1e-6 && Math.abs(C[t * 12 + 1] - 0.62) < 1e-6;
const wing = [];
for (let t = 0; t < faces; t++) if (isWing(t)) wing.push(t);

if (wing.length === 0) throw new Error('no wing faces found — has the colour changed?');
if (wing.length > 40) {
  console.log(`already subdivided (${wing.length} wing faces) — nothing to do`);
  process.exit(0);
}

const key = (v) => v.map((n) => n.toFixed(4)).join(',');

// ── Weld ────────────────────────────────────────────────────────────────────
// The mesh is a triangle soup, so every vertex is stored once per face that uses
// it. Nothing below works on a soup: a midpoint has to be shared by both faces
// across an edge or subdivision tears the surface, and "the average of its
// neighbours" is meaningless without knowing which faces meet.
const verts = [];
const index = new Map();
const idOf = (v) => {
  const k = key(v);
  if (!index.has(k)) { index.set(k, verts.length); verts.push(v.slice()); }
  return index.get(k);
};
let tris = wing.map((t) => [0, 3, 6].map((o) => idOf([P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]])));

// Vertices this wing shares with the rest of the model — the tenon. Collected
// before anything moves, and never moved.
const elsewhere = new Set();
for (let t = 0; t < faces; t++) {
  if (isWing(t)) continue;
  for (const o of [0, 3, 6]) elsewhere.add(key([P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]]));
}
const pinned = new Set();
verts.forEach((v, i) => { if (elsewhere.has(key(v))) pinned.add(i); });

// ── Subdivide ───────────────────────────────────────────────────────────────
const midCache = new Map();
const midpoint = (a, b) => {
  const k = a < b ? `${a}:${b}` : `${b}:${a}`;
  if (!midCache.has(k)) {
    const va = verts[a], vb = verts[b];
    midCache.set(k, idOf([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
  }
  return midCache.get(k);
};
tris = tris.flatMap(([a, b, c]) => {
  const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
  return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
});

// ── Relax ───────────────────────────────────────────────────────────────────
// Boundary first: an edge used by one face is on the rim, and both its ends stay
// put. This has to be recomputed after subdividing, because the new midpoints
// sitting on rim edges are on the rim too.
const edgeUse = new Map();
for (const [a, b, c] of tris) {
  for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    const k = x < y ? `${x}:${y}` : `${y}:${x}`;
    edgeUse.set(k, (edgeUse.get(k) || 0) + 1);
  }
}
for (const [k, n] of edgeUse) if (n === 1) k.split(':').forEach((i) => pinned.add(+i));

const neighbours = verts.map(() => new Set());
for (const [a, b, c] of tris) {
  neighbours[a].add(b); neighbours[a].add(c);
  neighbours[b].add(a); neighbours[b].add(c);
  neighbours[c].add(a); neighbours[c].add(b);
}
for (let pass = 0; pass < RELAX_PASSES; pass++) {
  const next = verts.map((v) => v.slice());
  for (let i = 0; i < verts.length; i++) {
    if (pinned.has(i) || neighbours[i].size === 0) continue;
    const avg = [0, 0, 0];
    for (const j of neighbours[i]) for (let k = 0; k < 3; k++) avg[k] += verts[j][k];
    for (let k = 0; k < 3; k++) {
      avg[k] /= neighbours[i].size;
      next[i][k] = verts[i][k] + (avg[k] - verts[i][k]) * RELAX;
    }
  }
  for (let i = 0; i < verts.length; i++) verts[i] = next[i];
}

// ── Write back ──────────────────────────────────────────────────────────────
// Wing faces are dropped from their original slots and the subdivided set is
// appended, so the rest of the model keeps its indices.
const keep = [];
const keepC = [];
for (let t = 0; t < faces; t++) {
  if (isWing(t)) continue;
  keep.push(...P.slice(t * 9, t * 9 + 9));
  keepC.push(...C.slice(t * 12, t * 12 + 12));
}
const colour = C.slice(wing[0] * 12, wing[0] * 12 + 4);
const round = (n) => +n.toFixed(4);
for (const [a, b, c] of tris) {
  for (const i of [a, b, c]) {
    keep.push(...verts[i].map(round));
    keepC.push(...colour);
  }
}

const out = src.slice(0, at('MESH_P')[0]) + JSON.stringify(keep)
  + src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(keepC)
  + src.slice(at('MESH_C')[1]);
writeFileSync(file, out);
console.log(`wings: ${wing.length} faces -> ${tris.length}, ${verts.length} verts, ${RELAX_PASSES} relax passes`);
