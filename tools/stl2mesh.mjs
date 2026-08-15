// Converts the reference STL parts into src/mesh.js.
//
// Run with `node tools/stl2mesh.mjs`. This is a build-time tool: it never ships,
// and neither do the STLs. Only its output does.
//
// The part files are used rather than the one-piece export because each part is
// a different colour on the finished model — horn gold, eyes black, hair
// rainbow — and splitting them here means the colour is baked per vertex at no
// runtime cost.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'models', 'unicorn-lowpoly');

/** Binary STL: 80-byte header, a triangle count, then 50 bytes per triangle. */
function readStl(file) {
  const buf = readFileSync(join(dir, file));
  const count = buf.readUInt32LE(80);
  const tris = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50;
    const v = [];
    // Read the corners back to front. Model axes are x, width, up and ours are
    // x, up, z, so the conversion swaps two of them — and swapping two axes is a
    // reflection, which reverses the winding of every triangle. Left alone, the
    // whole model is inside out: front faces get culled and you see the inner
    // surface of the far side. Reversing the corner order here undoes it, and
    // fixes the normals too, since those are computed from the winding.
    for (let k = 2; k >= 0; k--) {
      const p = o + 12 + k * 12;
      v.push([buf.readFloatLE(p), buf.readFloatLE(p + 8), buf.readFloatLE(p + 4)]);
    }
    tris.push(v);
  }
  return tris;
}

/**
 * Fills any hole left in a part, so nothing is see-through.
 *
 * The model is designed to be printed in pieces and assembled, so the base has
 * sockets where the wings and hair plug in — five of them, each a four-edge
 * quad. Leaving a part out leaves its socket as an open hole in the back.
 *
 * A hole is found as edges belonging to only one triangle. In a closed mesh
 * every edge is traversed once in each direction by the two faces sharing it, so
 * an edge traversed only one way is a boundary. The patch has to traverse it the
 * other way, which is why the loop is walked and then emitted reversed —
 * matching the direction would face the new triangles inwards and change
 * nothing visible.
 */
function capHoles(tris) {
  const key = (v) => v.map((n) => n.toFixed(3)).join(',');
  const seen = new Map();
  for (const t of tris) {
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ]) {
      seen.set(key(t[a]) + '>' + key(t[b]), [t[a], t[b]]);
    }
  }
  const next = new Map();
  for (const [k, [a, b]] of seen) {
    if (!seen.has(key(b) + '>' + key(a))) next.set(key(a), [a, b]);
  }
  const patched = [];
  const done = new Set();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop = [];
    let at = start;
    while (next.has(at) && !done.has(at)) {
      done.add(at);
      loop.push(next.get(at)[0]);
      at = key(next.get(at)[1]);
    }
    // Fan from the first corner, walking the loop backwards to face outwards.
    for (let i = loop.length - 1; i >= 2; i--) {
      patched.push([loop[0], loop[i], loop[i - 1]]);
    }
  }
  if (patched.length) console.log(`  capped ${patched.length} triangles across the open sockets`);
  return tris.concat(patched);
}

// [file, colour, rainbow]. Every piece of the reference, wings included — it is
// an alicorn, and the sockets in the base are cut for them.
const PARTS = [
  ['01_Unicorn_base_v2.STL', [1, 0.97, 0.99], 0],
  ['05_Unicorn_tail_v2.STL', [0, 0, 0], 1],
  ['06_Unicorn_wings_L_v2.STL', [1, 0.62, 0.78], 0],
  ['07_Unicorn_wings_R_v2.STL', [1, 0.62, 0.78], 0],
  ['08_Unicorn_horsehair_a_v2.STL', [0, 0, 0], 1],
  ['09_Unicorn_horsehair_b_v2.STL', [0, 0, 0], 1],
  ['10_Unicorn_horn_v2.STL', [1, 0.83, 0.3], 0],
  ['03_Unicorn_eyes_L_v2.STL', [0.05, 0.04, 0.08], 0],
  ['04_Unicorn_eyes_R_v2.STL', [0.05, 0.04, 0.08], 0],
];

// Normalise against the whole animal so every part lands in the same frame.
const all = readStl('Unicornio_ONE_PIECE_ONE_COLOR.STL').flat();
const lo = [0, 1, 2].map((a) => Math.min(...all.map((v) => v[a])));
const hi = [0, 1, 2].map((a) => Math.max(...all.map((v) => v[a])));
const S = 2.1 / (hi[1] - lo[1]);
const cx = (hi[0] + lo[0]) / 2;
const cz = (hi[2] + lo[2]) / 2;
const fix = (v) => [(v[0] - cx) * S, (v[1] - lo[1]) * S, (v[2] - cz) * S];

const pos = [];
const col = [];
const part = []; // one name index per triangle, for the debug inspector
const names = [];

/**
 * The hooves.
 *
 * `02_Unicorn_feet` is laid out on a print bed rather than in place — its four
 * caps sit in a row, asymmetric in z, so it cannot simply be included like the
 * other parts. Since all four are the same shape, one is taken, moved to its own
 * origin, and stamped at the bottom of each leg. That also guarantees they line
 * up, which matching print-bed positions to legs by guesswork would not.
 */
function hooves() {
  const tris = readStl('02_Unicorn_feet_v2.STL').map((t) => t.map(fix));
  // Split into connected pieces; take the first.
  const key = (v) => v.map((n) => n.toFixed(3)).join(',');
  const owner = new Map();
  const find = (k) => {
    while (owner.get(k) !== k) k = owner.get(k);
    return k;
  };
  for (const t of tris) {
    for (const v of t) if (!owner.has(key(v))) owner.set(key(v), key(v));
    for (const v of t.slice(1)) owner.set(find(key(v)), find(key(t[0])));
  }
  const groups = new Map();
  for (const t of tris) {
    const g = find(key(t[0]));
    groups.set(g, (groups.get(g) || []).concat([t]));
  }
  const one = [...groups.values()][0];
  const vs = one.flat();
  const ox = (Math.max(...vs.map((v) => v[0])) + Math.min(...vs.map((v) => v[0]))) / 2;
  const oz = (Math.max(...vs.map((v) => v[2])) + Math.min(...vs.map((v) => v[2]))) / 2;
  const oy = Math.min(...vs.map((v) => v[1]));

  const out = [];
  for (const [lx, lz] of [
    [0.39, 0.32],
    [0.39, -0.32],
    [-0.55, 0.32],
    [-0.55, -0.32],
  ]) {
    for (const t of one) {
      out.push(t.map((v) => [v[0] - ox + lx, v[1] - oy, v[2] - oz + lz]));
    }
  }
  console.log(`  hooves: ${one.length} triangles stamped at 4 legs`);
  return out;
}
for (const [file, rgb, rainbow] of PARTS) {
  const id = names.push(file.replace(/^\d+_Unicorn_|_v2\.STL$/g, '')) - 1;
  for (const t of capHoles(readStl(file))) {
    part.push(id);
    for (const v of t) {
      pos.push(...fix(v).map((n) => +n.toFixed(4)));
      col.push(rgb[0], rgb[1], rgb[2], rainbow);
    }
  }
}

const hoofId = names.push('hoof') - 1;
for (const t of hooves()) {
  part.push(hoofId);
  for (const v of t) {
    pos.push(...v.map((n) => +n.toFixed(4)));
    col.push(0.16, 0.13, 0.2, 0);
  }
}

const out = `// Generated by tools/stl2mesh.mjs from the reference model. Do not edit.
const MESH_P = [${pos.join(',')}];
const MESH_C = [${col.join(',')}];
// Debug only: which part each triangle came from. Stripped from the real build.
const MESH_PART = [${part.join(',')}];
const MESH_NAMES = ${JSON.stringify(names)};
`;
writeFileSync(join(root, 'src', 'mesh.js'), out);
console.log(`${pos.length / 3} vertices -> src/mesh.js (${(out.length / 1024).toFixed(1)} KB of source)`);
