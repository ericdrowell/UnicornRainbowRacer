// Smooths the dimple above the tail, in place, in src/mesh.js.
//
// Run with `node tools/smooth-rump.mjs`. Idempotent: it checks for the offending
// vertex and exits if the mesh has already been patched.
//
// This is a one-off repair rather than a change to stl2mesh.mjs because the flaw
// is in the reference model itself, not in the conversion — and the STLs are not
// in the repo, so stl2mesh.mjs cannot be re-run to produce a corrected mesh.
// Keeping the repair as a script means the edit to a generated file is auditable
// instead of appearing as an unexplained hand-tweak.
//
// The flaw: one vertex on the centreline of the lower back sits 0.0245 below the
// line between its two neighbours along the spine, and six faces fan around it.
// The result reads as a pothole above the tail. That vertex is used by nothing
// outside those six faces, so it can simply go, leaving a hexagonal hole to be
// re-covered.

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

const key = (v) => v.map((n) => n.toFixed(4)).join(',');
const DIMPLE = '-0.4712,0.9755,0.0000';

const tri = (t) => [0, 3, 6].map((o) => [P[t * 9 + o], P[t * 9 + o + 1], P[t * 9 + o + 2]]);
const count = P.length / 9;

const touching = [];
for (let t = 0; t < count; t++) if (tri(t).some((v) => key(v) === DIMPLE)) touching.push(t);
if (!touching.length) {
  console.log('already smoothed — nothing to do');
  process.exit(0);
}

// The patch is every face whose corners all lie in the neighbourhood of the
// dimple. Found by geometry rather than by index so that this keeps working if
// the mesh is ever regenerated and the numbering moves.
const near = new Set();
for (const t of touching) for (const v of tri(t)) near.add(key(v));
const patch = [];
for (let t = 0; t < count; t++) if (tri(t).every((v) => near.has(key(v)))) patch.push(t);

// Every corner except the dimple is shared with the surrounding mesh, so the
// hole has to be re-covered exactly — anything else tears the rump open.
const used = new Map();
for (let t = 0; t < count; t++) for (const v of tri(t)) used.set(key(v), (used.get(key(v)) || 0) + 1);
const inside = new Map();
for (let t = 0; t < count; t++) if (patch.includes(t)) for (const v of tri(t)) inside.set(key(v), (inside.get(key(v)) || 0) + 1);
for (const [k, n] of inside) {
  if (k !== DIMPLE && used.get(k) === n) throw new Error(`corner ${k} is interior too — the patch is bigger than expected`);
}

// Walk the boundary in winding order. Each boundary edge is traversed once by
// the patch, so re-covering it means traversing the loop the same way: winding,
// and therefore which side faces out, is carried by the loop itself and never
// has to be guessed.
const directed = new Map();
const pos = new Map();
for (const t of patch) {
  const v = tri(t);
  for (const q of v) pos.set(key(q), q);
  for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) directed.set(key(v[a]) + '>' + key(v[b]), [key(v[a]), key(v[b])]);
}
const step = new Map();
for (const [, [a, b]] of directed) if (!directed.has(b + '>' + a)) step.set(a, b);

let cursor = [...step.keys()][0];
const loop = [];
while (!loop.includes(cursor)) {
  loop.push(cursor);
  cursor = step.get(cursor);
}
if (loop.length !== step.size) throw new Error('boundary is not a single closed loop');

// Fan from the corner up the spine. Fanning from any of the others folds the
// new faces over each other — the hexagon wraps around the top of the rump, so
// only the apex furthest along it sees the whole loop from one side.
let apex = 0;
for (let i = 1; i < loop.length; i++) if (pos.get(loop[i])[0] > pos.get(loop[apex])[0]) apex = i;

const built = [];
for (let i = 1; i < loop.length - 1; i++) {
  built.push([loop[apex], loop[(apex + i) % loop.length], loop[(apex + i + 1) % loop.length]].map((k) => pos.get(k)));
}

const body = C.slice(patch[0] * 12, patch[0] * 12 + 4);
const outP = [];
const outC = [];
for (let t = 0; t < count; t++) {
  if (patch.includes(t)) continue;
  outP.push(...P.slice(t * 9, t * 9 + 9));
  outC.push(...C.slice(t * 12, t * 12 + 12));
}
for (const t of built) {
  for (const v of t) {
    outP.push(...v);
    outC.push(...body);
  }
}

const next = src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
  src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
  src.slice(at('MESH_C')[1]);
writeFileSync(file, next);
console.log(`removed the dimple: ${patch.length} faces (${patch.join(', ')}) -> ${built.length}`);
console.log(`${count} triangles -> ${outP.length / 9}`);
