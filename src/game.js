// Unicorn Rainbow Racer — js13k 2026.
//
// The unicorn is the reference model itself: MESH_P and MESH_C are generated
// from the STL by tools/stl2mesh.mjs. This file gives it normals and, more
// interestingly, works out which vertices belong to which leg so the shader can
// run it — the model is a 3D-print solid with no rigging, so the weights have to
// be derived from where each vertex sits rather than read from the file.
//
// Everything here is plain globals, no imports: this file is concatenated with
// the runtime, the compiled shaders and the mesh, and minified as one program.

const canvas = document.getElementById('c');

// ── Skeleton, measured from the model ───────────────────────────────────────
// Where each leg is, and the height its vertices start belonging to it.
const BELLY = 0.56; // below this, a vertex is leg rather than body
const LEG_LEN = 0.52;
const LEG_R = 0.3; // generous: catches the whole limb including the haunch
const LEGS = [
  [0.39, 0.32, 0, -1], // x, z, gait phase, which way the joint folds
  [0.39, -0.32, Math.PI, -1],
  [-0.55, 0.32, Math.PI, 1],
  [-0.55, -0.32, 0, 1],
];

// ── Buffers ─────────────────────────────────────────────────────────────────
const P = [];
const NR = [];
const RT = [];
const SK = [];
const CL = [];

/**
 * Which leg a vertex belongs to, and how far down it.
 *
 * A print model has no bones, so this is inferred: anything below the belly and
 * within reach of a hip is that leg's, and how far below decides how much it
 * moves. Ambiguity only arises between the two legs on the same side, and they
 * are far enough apart in x that nearest-hip wins cleanly.
 */
function skinFor(x, y, z) {
  if (y >= BELLY) return null;
  let best = null;
  let bestD = LEG_R;
  for (const leg of LEGS) {
    const d = Math.hypot(x - leg[0], z - leg[1]);
    if (d < bestD) {
      bestD = d;
      best = leg;
    }
  }
  return best;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

for (let i = 0; i < MESH_P.length; i += 9) {
  const tri = [0, 3, 6].map((o) => [MESH_P[i + o], MESH_P[i + o + 1], MESH_P[i + o + 2]]);
  // Flat normal from the winding. The STL carries its own, but recomputing costs
  // nothing here and keeps the generated mesh to bare coordinates.
  const u = sub(tri[1], tri[0]);
  const v = sub(tri[2], tri[0]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(n[0], n[1], n[2]) || 1;

  // Which leg is one decision for the whole triangle — a face cannot be rooted
  // at two different hips — but it is taken from the triangle's *lowest* corner,
  // not its centre.
  //
  // Centre-based leaves a static collar at the top of every leg: the ring of
  // faces where leg meets body has its centre just above the belly line, so the
  // whole face is thrown out even though most of it is well down the limb. Those
  // are the four triangles per leg that sat still while everything under them
  // swung. Taking the lowest corner claims that ring for the leg, and the
  // per-vertex weight below still pins its upper edge to the body, so it flexes
  // instead of tearing.
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
  const cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
  const lowest = Math.min(tri[0][1], tri[1][1], tri[2][1]);
  const leg = skinFor(cx, lowest, cz);
  const root = leg ? [leg[0], BELLY, leg[1]] : [0, 0, 0];
  const skin = leg ? [0, leg[2], 0.55, 0.9 * leg[3]] : [0, 0, 0, 0];

  for (let k = 0; k < 3; k++) {
    P.push(tri[k][0] - root[0], tri[k][1] - root[1], tri[k][2] - root[2]);
    NR.push(n[0] / L, n[1] / L, n[2] / L);
    RT.push(root[0], root[1], root[2]);
    // How far down the limb this vertex sits — the weight the shader scales by.
    const t = leg ? Math.min(Math.max((BELLY - tri[k][1]) / LEG_LEN, 0), 1) : 0;
    SK.push(t, skin[1], skin[2], skin[3]);
    const ci = (i / 3) * 4 + k * 4;
    CL.push(MESH_C[ci], MESH_C[ci + 1], MESH_C[ci + 2], MESH_C[ci + 3]);
  }
}

const idx = new Uint16Array(P.length / 3).map((_, i) => i);

bmInit(canvas, [0.55, 0.78, 0.96, 1]).then(() => {
  const prog = bmProgram(Unicorn[0], {
    a: Unicorn[1],
    i: Unicorn[2],
    u: Unicorn[3],
    t: Unicorn[4],
    cull: 1,
  });
  bmAttr(prog, 0, new Float32Array(P));
  bmAttr(prog, 1, new Float32Array(NR));
  bmAttr(prog, 2, new Float32Array(RT));
  bmAttr(prog, 3, new Float32Array(SK));
  bmAttr(prog, 4, new Float32Array(CL));
  bmIndex(prog, idx);

  const u = new Float32Array(Unicorn[3] / 4);
  bmLoop((t) => {
    const view = bmLook([1.9, 1.5, 3.1], [0, 1.02, 0], [0, 1, 0]);
    const proj = bmPersp(1, canvas.width / canvas.height, 0.1, 50);
    u.set(bmMul(proj, bmMul(view, bmRotY(t * 0.5))), 0); // uViewProj
    u[16] = t; // uTime
    bmUniforms(prog, u);
    bmDraw(prog);
  });
});
