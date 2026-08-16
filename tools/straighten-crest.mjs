// Straightens the notch in the back of the neck, in place, in src/mesh.js.
//
// Run with `node tools/straighten-crest.mjs`, after decimation. Idempotent.
//
// The body has an open edge running up the crest: the mane sits along there, so
// hollowing correctly removed the neck surface underneath it. What is left is
// the rim of that opening, and the rim does not run straight — it kinks outwards
// at one vertex before carrying on up. Two thin body faces meet at that kink and
// fold against each other, one of them facing back towards the centre, and the
// pair reads as a dent pressed into the back of the neck.
//
// The vertex is not holding anything together. It belongs to exactly two body
// faces, and the mane's own copy of the same position is a separate vertex —
// pieces are welded per piece, not globally, so removing it from the body leaves
// the mane untouched. Dropping it merges the two faces into one and the rim runs
// straight from the seam to the top.

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
const key = (v) => v.map((n) => n.toFixed(4)).join(',');
const isBody = (t) => C[t * 12] > 0.9 && C[t * 12 + 1] > 0.9 && C[t * 12 + 2] > 0.9;

const KINK = '0.1182,1.2588,0.0291';

const owners = [];
for (let t = 0; t < count; t++) {
  if (isBody(t) && tri(t).some((v) => key(v) === KINK)) owners.push(t);
}
if (!owners.length) {
  console.log('crest already straight — nothing to do');
  process.exit(0);
}
// Two faces and no more. If the mesh is regenerated and this vertex ends up
// load-bearing, removing it would tear a hole rather than close a notch, so this
// stops instead of guessing.
if (owners.length !== 2) {
  throw new Error(`expected the kink to belong to 2 body faces, found ${owners.length}: ${owners.join(', ')}`);
}

// The merged triangle is the pair's outline with the kink taken out: they share
// two corners, so between them there are exactly three others.
const [f0, f1] = owners.map(tri);
const rim = [];
for (const v of [...f0, ...f1]) {
  if (key(v) !== KINK && !rim.some((q) => key(q) === key(v))) rim.push(v);
}
if (rim.length !== 3) throw new Error(`expected 3 remaining corners, found ${rim.length}`);

// Winding taken from the face that keeps two of its own corners, so the merged
// triangle faces the same way as what it replaces. Deriving it from a normal
// instead would need a reference for "outwards" that this area does not supply —
// it is an open rim, not a closed surface.
const keep = owners[0];
const orig = f0.map(key);
const kinkAt = orig.indexOf(KINK);
const other = rim.find((v) => !orig.includes(key(v)));
const merged = f0.map((v, i) => (i === kinkAt ? other : v));

for (let k = 0; k < 3; k++) {
  for (let a = 0; a < 3; a++) P[keep * 9 + k * 3 + a] = merged[k][a];
}

const drop = owners[1];
const outP = [];
const outC = [];
for (let t = 0; t < count; t++) {
  if (t === drop) continue;
  outP.push(...P.slice(t * 9, t * 9 + 9));
  outC.push(...C.slice(t * 12, t * 12 + 12));
}

console.log(`merged body faces ${owners.join(' and ')} into one`);
console.log(`  removed corner ${KINK}`);
console.log(`  merged triangle ${merged.map((v) => v.map((n) => n.toFixed(3)).join(',')).join('   ')}`);
console.log(`  ${count} -> ${outP.length / 9} stored triangles (renders ${outP.length / 9 * 2})`);

writeFileSync(
  file,
  src.slice(0, at('MESH_P')[0]) + JSON.stringify(outP) +
    src.slice(at('MESH_P')[1], at('MESH_C')[0]) + JSON.stringify(outC) +
    src.slice(at('MESH_C')[1]),
);
