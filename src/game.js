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

// ── Switches ────────────────────────────────────────────────────────────────
// Everything that gets turned on and off while the game is being made, in one
// place so none of it has to be hunted for.
//
// `const` rather than a runtime flag because terser folds it: with it false the
// feature it guards becomes unreachable and `--toplevel` deletes it outright, so
// a switch that is off costs nothing and the build gets its bytes back. That is
// also why it cannot be flipped at runtime — turning it on means a rebuild,
// which for a thing decided once per session is the right trade at this budget.

/** The soundtrack. Off for now — true costs about 2.3 kB, because terser can
 *  only fold away the synthesiser and the song data while it is off. Sound
 *  effects are separate and keep working either way. Which song plays is chosen
 *  in build.mjs, where the JSON gets inlined. */
const MUSIC_ENABLED = true;

//
// MUSIC_ENABLED gates every line of music below it — and it is the switch
// itself that every guard tests, not the context it produces. Testing `MUSIC`
// instead reads better and costs 18 kB of source: a const used ahead of its own
// declaration is one terser will not fold, so the branch survives minification
// and drags the synthesiser and the song data through with it. Naming the switch
// directly, declared right here, is a value terser can see is false — and then
// everything depending on it is unreachable and goes.
//
// This lived in its own src/music.js until it turned out to be a wrapper around
// four functions. Folding it in meant moving the song data *ahead* of this file
// in the build, because the songs are `const` and a const referenced before its
// declaration line has run is a ReferenceError, not a hoist.
const MUSIC = MUSIC_ENABLED && new (AudioContext || webkitAudioContext)();


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


/**
 * Who the player rides before anything is chosen — and so which seat the select
 * screen's carousel opens on. First in the roster, because the screen has to
 * open on the top of the list for the arrows to read as moving through it; any
 * other index opens mid-list and looks like the ring has already been turned.
 */
const SELECTED_UNICORN = 0;

const SKIN = UNICORNS[SELECTED_UNICORN];

// ── The field ───────────────────────────────────────────────────────────────
// The roster, once each, and nobody else. It used to be ten — the player plus
// nine drawn at random with repeats — which put three Bubble Gums on the grid
// and made the field read as filler rather than as opposition. One of each is a
// smaller race and a better one: every unicorn on the road is a unicorn you
// could have picked.
//
// **The line-up is a rotation, not a slice, and that matters.** Racer 0 is the
// invocation that takes the keyboard and owns the camera, so the player's choice
// has to be first; rotating the roster round to start there keeps all four in
// the race and puts the other three behind, whichever one was chosen. Lifting
// the pick out and unshifting it does the same thing in more code.
//
// FIELD is also written down in physics.shader.ts, which cannot read this file:
// the compiler works from the source, so the workgroup size and its loop bound
// are literals there. Change one and change all three.
const FIELD = UNICORNS.length;
const RACERS = [];
const lineUp = (pick) => {
  for (let i = 0; i < FIELD; i++) RACERS[i] = UNICORNS[(pick + i) % FIELD];
};
lineUp(SELECTED_UNICORN);

/**
 * Whether a mesh colour is one the roster repaints. Matched against the value
 * rather than flagged in the mesh, so the model stays exactly as the converter
 * emitted it — and the parts no unicorn recolours (hooves, eyes) keep their
 * colours without needing to be listed anywhere.
 *
 * The model carries five colours and no two are close, so neither test can
 * collide: the hide is the only near-white and the horn the only gold.
 */
const is = (r, g, b, m) => Math.abs(r - m[0]) < 1e-3 && Math.abs(g - m[1]) < 1e-3 && Math.abs(b - m[2]) < 1e-3;
const HIDE = [1, 0.97, 0.99];
const HORN = [1, 0.83, 0.3];
// Not pure black: the bead is drawn over the hide, and a true zero next to a
// near-white face reads as a hole punched in the head rather than as an eye.
const EYE = [0.02, 0.02, 0.03];

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
 *
 * This takes a *vertex*, never a triangle, and that is the whole point. Deciding
 * per triangle — from its centre, say — lets one physical corner come out
 * weighted 0.44 in one face and 0 in the face next to it, because the two
 * triangles classified differently. The corner then swings in one and stays put
 * in the other, and the surface splits along that edge. Those are the triangles
 * that looked static: they were not failing to move, they were being held still
 * by a neighbour that disagreed about them.
 *
 * Keyed on position, a shared corner gets one answer no matter how many faces
 * meet there, so there is nothing to disagree about.
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

/** How far down its limb a vertex sits: 0 at the belly, 1 at full stretch. */
const weightAt = (y) => Math.min(Math.max((BELLY - y) / LEG_LEN, 0), 1);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Smooth normals, gathered while the mesh is built and applied once it is.
//
// The model is a 3D print: flat-shaded it reads as the faceted solid it really
// is, and the brief is a plush toy. Averaging the normals of every face that
// meets at a corner is the whole of the fix — the geometry keeps its silhouette
// and its polygon count, and only the shading stops announcing where one
// triangle ends and the next begins.
//
// Keyed on the rounded position, for the same reason `skinFor` is: a shared
// corner has to give one answer no matter how many faces arrive at it, and
// floats that came from the same STL vertex are not reliably equal.
const SMOOTH = new Map();
const NKEY = [];

// Twice round the mesh: once as stored, once mirrored. Only the z > 0 half of
// the unicorn is in MESH_P, and it is the single largest thing in the budget, so
// the other half is rebuilt here for the cost of this loop.
//
// The corners are read back to front on the mirrored pass. Negating one axis is
// a reflection, and a reflection reverses winding — left alone, every mirrored
// face would point inwards and the whole left side would be culled away.
//
// Nothing else has to know about any of this. The gait comes out right on its
// own: skinFor picks a leg by position, so a mirrored vertex finds the opposite
// hip and inherits its phase, and the diagonal trot survives without being
// written down anywhere.
for (let i = 0; i < MESH_P.length * 2; i += 9) {
  const mirror = i >= MESH_P.length;
  const j = mirror ? i - MESH_P.length : i;
  const tri = [0, 3, 6].map((o) => {
    const c = mirror ? 6 - o : o;
    return [MESH_P[j + c], MESH_P[j + c + 1], mirror ? -MESH_P[j + c + 2] : MESH_P[j + c + 2]];
  });
  // Flat normal from the winding. The STL carries its own, but recomputing costs
  // nothing here and keeps the generated mesh to bare coordinates.
  const u = sub(tri[1], tri[0]);
  const v = sub(tri[2], tri[0]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(n[0], n[1], n[2]) || 1;

  // Each corner is classified on its own, then the face is rooted at whichever
  // hip its most-committed corner belongs to. A face can only carry one root —
  // it is a single attribute — but the *weights* stay per corner, and a corner
  // belonging to no leg keeps weight 0, so it sits still regardless of the root
  // the face happens to carry. Corners shared with the body therefore stay
  // welded to it while the rest of the face swings, which is the flex the
  // shader's smoothstep is there to produce.
  // Drop the model's own eye patch: five triangles of flat black laid on the
  // cheek, which the shader now draws for itself. Left in, they sit in the same
  // place as the head surface with their own angle, so the eye decal lands on
  // both and the two fight — one circle on the cheek and a second, skewed one on
  // the patch, z-fighting where they overlap. Repainting them as face was not
  // enough: it is the geometry that is doubled, not the colour.
  //
  // Identified by the colour that is unique to them — 0.05 across, against
  // hooves at 0.16 and a body at 1.
  const ci0 = (j / 3) * 4;
  if (MESH_C[ci0] < 0.1 && MESH_C[ci0 + 3] < 0.5) continue;

  const legs = tri.map((v) => skinFor(v[0], v[1], v[2]));
  let lead = -1;
  for (let k = 0; k < 3; k++) {
    if (legs[k] && (lead < 0 || weightAt(tri[k][1]) > weightAt(tri[lead][1]))) lead = k;
  }
  const leg = lead < 0 ? null : legs[lead];
  const root = leg ? [leg[0], BELLY, leg[1]] : [0, 0, 0];
  const skin = leg ? [0, leg[2], 0.55, 0.9 * leg[3]] : [0, 0, 0, 0];

  for (let k = 0; k < 3; k++) {
    P.push(tri[k][0] - root[0], tri[k][1] - root[1], tri[k][2] - root[2]);
    // Provisional: the face's own normal, replaced below by the average of every
    // face meeting at this corner. Keyed on the position *before* the root is
    // subtracted, because that is the coordinate two faces actually share — the
    // root differs between a body face and a leg face at the very seam where
    // smoothing matters most.
    NKEY.push(tri[k].map((c) => Math.round(c * 1000)).join());
    const a = SMOOTH.get(NKEY[NKEY.length - 1]) || [0, 0, 0];
    // Unnormalised, so a big triangle pulls the average further than a sliver —
    // which is what area weighting is, and it costs nothing here because the
    // cross product's length already is the area.
    a[0] += n[0];
    a[1] += n[1];
    a[2] += n[2];
    SMOOTH.set(NKEY[NKEY.length - 1], a);
    NR.push(n[0] / L, n[1] / L, n[2] / L);
    RT.push(root[0], root[1], root[2]);
    // How far down the limb this corner sits — the weight the shader scales by.
    // Read from the corner itself, so every face meeting here agrees.
    const t = legs[k] ? weightAt(tri[k][1]) : 0;
    SK.push(t, skin[1], skin[2], skin[3]);
    const ci = (j / 3) * 4 + k * 4;
    // The flat black patch the model carries for an eye is repainted as face.
    // The bead appended further down is the eye now, and leaving the patch black
    // underneath it puts two dark shapes at slightly different angles in the same
    // place — which reads as a polygon halo around a circle, and was visible the
    // moment the bead was made smaller than the patch it covers.
    //
    // Identified by its own colour, which is unique in the model: 0.05 across,
    // against hooves at 0.16 and a body at 1. Repainting it frees the bead to be
    // any size at all, since there is no longer anything for it to fail to hide.
    const socket = MESH_C[ci] < 0.1 && MESH_C[ci + 3] < 0.5;
    // Sockets are interior faces that should read as body, so they take the hide
    // colour too — the same substitution that used to hard-code white.
    // Which roster colour, if any, replaces what the converter emitted here.
    // Which roster colour replaces what the converter emitted here — as a code
    // for the shader to act on, not as the colour itself. One vertex buffer is
    // shared by all ten instances, so a colour resolved here would be the same
    // colour on every unicorn in the field; the code lets each instance answer
    // for itself. 1 is the mane, which the alpha channel already meant.
    const paint = socket || is(MESH_C[ci], MESH_C[ci + 1], MESH_C[ci + 2], HIDE)
      ? 2
      : is(MESH_C[ci], MESH_C[ci + 1], MESH_C[ci + 2], HORN)
        ? 3
        : 0;
    CL.push(MESH_C[ci], MESH_C[ci + 1], MESH_C[ci + 2], paint || MESH_C[ci + 3]);
  }
}

// The second pass. Every corner now knows the sum of the faces around it, so
// the provisional flat normals get overwritten with the direction the *surface*
// faces rather than the direction one triangle does.
for (let i = 0; i < NKEY.length; i++) {
  const a = SMOOTH.get(NKEY[i]);
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  NR[i * 3] = a[0] / l;
  NR[i * 3 + 1] = a[1] / l;
  NR[i * 3 + 2] = a[2] / l;
}

const idx = new Uint16Array(P.length / 3).map((_, i) => i);

// ── Rainbow road ────────────────────────────────────────────────────────────
// The track is fifteen points and a width. Everything the road *is* — where it
// banks, how finely it is tessellated, how the lighting pattern lines up with
// itself — is derived from those here, so reshaping the course means moving a
// point rather than editing geometry.
//
// TRACK is the centreline: each entry is a place the ribbon passes through, in
// order, and the last one joins back to the first. A Catmull-Rom spline through
// them is what makes that a usable authoring format — the curve *hits* every
// point instead of being pulled vaguely towards it, so a point dropped at a
// corner apex is where the road actually goes.
//
// The loop starts at the origin because that is where the unicorn stands: the
// first straight runs out from under it, which is what puts the model on the
// road rather than beside it.
const TRACK_WIDTH = 27;

/**
 * Which one is being raced. Three are planned; this is the first of them.
 *
 * The circuits themselves live in src/circuits.js — they are data, and a
 * thousand coordinates sitting in the middle of this file buries everything
 * around them.
 */
const SELECTED_CIRCUIT = 0;

// The course, as a list of places the road passes through. Built from a seed
// rather than read from a literal — see src/circuits.js — which is why there is
// no unpacking left here: the generator hands back triples in absolute
// coordinates, where the authored file held a flat run of steps that had to be
// summed. Both the unpacking and the running sum went with it.
const TRACK = CIRCUITS[SELECTED_CIRCUIT];

/** Metres between ribbon rings. Small enough that corners read as curves. */
const RING_SPACING = 2;
/** Radians of camber per unit of curvature, and the ceiling on it. */
const BANK_GAIN = 15;
const BANK_MAX = 0.55;

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(...sub(a, b));

/**
 * A point on the Catmull-Rom spline between `b` and `c`, with `a` and `d` as the
 * neighbours that set the tangents there.
 */
const spline = (a, b, c, d, t) =>
  [0, 1, 2].map(
    (k) =>
      0.5 *
      (2 * b[k] +
        (c[k] - a[k]) * t +
        (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t * t +
        (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t * t * t),
  );

// Resample the control points into rings spaced by arc length rather than a
// fixed count per segment. A fixed count would tessellate a 60-metre straight
// and a 12-metre hairpin identically — the straight wastes triangles it has no
// curve to spend them on, and the hairpin comes out visibly faceted.
// ── The centreline ──────────────────────────────────────────────────────────
// Three passes: sample the spline finely, stand the loops up out of it, then
// resample the result at even spacing. The middle pass is why the first two
// cannot be one — a loop multiplies arc length locally by six or seven, so
// points evenly spaced along the *course* come out bunched at the loop's joins
// and stretched at its crown, and the ribbon facets visibly where it matters
// most.
const FINE = 0.05;
const BASE = [];
for (let i = 0; i < TRACK.length; i++) {
  const a = TRACK[(i + TRACK.length - 1) % TRACK.length];
  const b = TRACK[i];
  const c = TRACK[(i + 1) % TRACK.length];
  const d = TRACK[(i + 2) % TRACK.length];
  const steps = Math.max(1, Math.round(dist(b, c) / FINE));
  // The endpoint is left off: it is the next segment's start, and emitting both
  // would put two points in the same place.
  for (let s = 0; s < steps; s++) BASE.push(spline(a, b, c, d, s / steps));
}

const BL = [0];
for (let i = 1; i <= BASE.length; i++) BL.push(BL[i - 1] + dist(BASE[i % BASE.length], BASE[i - 1]));
const BASE_LAP = BL[BASE.length];

/** The course before the loops: a point and the direction through it. */
const baseAt = (s) => {
  const u = ((s % BASE_LAP) + BASE_LAP) % BASE_LAP;
  let lo = 0;
  let hi = BASE.length;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (BL[m] <= u) lo = m;
    else hi = m;
  }
  const t = (u - BL[lo]) / Math.max(BL[lo + 1] - BL[lo], 1e-9);
  const at = (k) => BASE[((k % BASE.length) + BASE.length) % BASE.length];
  return {
    p: at(lo).map((c, k) => c + (at(lo + 1)[k] - c) * t),
    t: norm(sub(at(lo + 2), at(lo - 1))),
  };
};

// Resampled by arc length rather than by spline parameter, so the rings come
// out evenly spaced. This is not tidiness: the control points are far apart on
// the straights and close together through the loop, and a spline stepped by
// parameter puts rings wherever the points happen to be — bunched at the loop's
// joins, stretched across its crown, and the ribbon facets exactly where it is
// most on show.

const CENTRE = [];
{
  // A whole number of rings to the lap, and the spacing stretched by a hair to
  // fit: the ribbon is a closed strip, and a part-ring left over at the join is
  // a short quad across the start line.
  const n = Math.round(BASE_LAP / RING_SPACING);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const want = (i * BASE_LAP) / n;
    while (k + 1 < BASE.length && BL[k + 1] <= want) k++;
    const t = (want - BL[k]) / Math.max(BL[k + 1] - BL[k], 1e-9);
    const b = BASE[(k + 1) % BASE.length];
    CENTRE.push(BASE[k].map((c, j) => c + (b[j] - c) * t));
  }
}

const RINGS = CENTRE.length;
const ring = (i) => CENTRE[(i + RINGS) % RINGS];

// Central differences, so a ring's tangent is the direction the road is heading
// *through* it rather than the direction of the segment on one side of it.
const TAN = CENTRE.map((_, i) => norm(sub(ring(i + 1), ring(i - 1))));

// Distance travelled to each ring, and the length of the whole lap. Measured
// along the resampled polyline, which is the same thing the ribbon is built
// from — deriving it from the control points instead would drift short on
// corners, where the spline bulges out past the chord.
const ALONG = [0];
for (let i = 1; i < RINGS; i++) ALONG.push(ALONG[i - 1] + dist(ring(i), ring(i - 1)));
const LAP = ALONG[RINGS - 1] + dist(ring(0), ring(RINGS - 1));

// ── Which way is up ─────────────────────────────────────────────────────────
// Carried along the road, not derived from the world.
//
// **This is what a loop costs.** Every frame here used to start from
// `cross(tangent, worldUp)`, which is exact, free, and undefined at precisely
// one angle: straight up. The old comment beside it said the track "must not
// actually stand on end", and that was not a style note — a vertical tangent
// makes that cross product zero, the road loses its width, and the unicorn
// loses the surface it is standing on. A loop stands on end twice.
//
// So the frame is transported instead: start level at ring zero, and at every
// ring afterwards take the previous up and square it off against the new
// tangent. Nothing is ever derived from the world, so nothing cares which way
// the road is pointing, and the frame rotates only as much as the road forces it
// to — which is the other half of why this construction is the right one. A
// frame that keeps reaching for world up spins about the tangent as the road
// goes over, and the ribbon twists on its own axis for no reason anyone driving
// on it could see.
const UPV = [];
{
  const world = [0, 1, 0];
  const flatten = (v, t) => norm(sub(v, t.map((c) => c * dot(v, t))));
  const ramp = (x, a, b) => Math.min(Math.max((x - a) / (b - a), 0), 1);
  let up = flatten(world, TAN[0]);
  for (let i = 0; i < RINGS; i++) {
    if (i) up = flatten(up, TAN[i]);
    // ── And then let back down towards level ────────────────────────────
    // Transport on its own is not enough, and the loop is what proves it.
    // Transport has no memory of the world — it only ever answers "as little
    // rotation as the road forced", and a loop with any sideways in it forces
    // some. Measured, this circuit's loop leaves 59 degrees of roll in the
    // frame, and because nothing afterwards pulls it back, *the entire rest of
    // the lap came out banked over at sixty degrees*. The road was still smooth
    // and still closed; it was just lying on its side for three kilometres.
    //
    // So the frame is eased back towards world up wherever world up is
    // meaningful, and left alone wherever it is not. Two conditions, and both
    // are needed:
    //
    // - **The road must be shallow.** Near vertical there is no sideways to
    //   take from the world — that is the degeneracy this construction exists
    //   to avoid in the first place.
    // - **The frame must not be inverted.** This is the one that is easy to
    //   miss. At the crown of a loop the road is level and pointing backwards,
    //   so the first test passes with room to spare — and world up is the exact
    //   opposite of where the surface actually faces. Ease towards it there and
    //   the road turns itself inside out at the top of every loop.
    //
    //   The threshold is *not upside down*, deliberately, and not *nearly
    //   level*: a frame that has just come out of a loop is rolled the best part
    //   of sixty degrees, and a gate that only opened for upright frames would
    //   have found it too rolled to be allowed to un-roll. Which is exactly what
    //   the first attempt at this did — it left the road on its side and then
    //   refused to pick it up.
    //
    // Five percent a ring, so a shallow stretch pulls the frame back over about
    // forty units: fast enough that the roll is gone shortly after a loop spits
    // the road back out, slow enough to read as the road untwisting rather than
    // snapping level.
    const w = 0.05 * (1 - ramp(Math.abs(TAN[i][1]), 0.35, 0.7)) * ramp(dot(up, world), -0.1, 0.4);
    if (w > 0) {
      const level = flatten(world, TAN[i]);
      up = norm(up.map((c, k) => c + (level[k] - c) * w));
    }
    UPV.push(up);
  }
}

// The lap is closed and the transport is not: carried the whole way round, the
// frame can come back rolled against the one it started with, and left alone
// that is a crease across the start line. The easing above takes most of it out
// on its own — the road is level at the line, so it arrives already upright —
// but whatever is left is measured once here and unwound evenly over every ring,
// so the road takes the whole lap to give it back and there is nowhere it
// happens.
{
  const side0 = norm(cross(TAN[0], UPV[0]));
  const back = UPV[RINGS - 1];
  const twist = Math.atan2(dot(back, side0), dot(back, UPV[0]));
  for (let i = 0; i < RINGS; i++) {
    const a = (-twist * i) / RINGS;
    const side = norm(cross(TAN[i], UPV[i]));
    UPV[i] = norm(UPV[i].map((c, k) => c * Math.cos(a) + side[k] * Math.sin(a)));
  }
}

// How hard the road is turning at each ring, signed: positive is a left-hander.
//
// Measured in the road's own frame — how much the tangent swings *sideways* —
// rather than out of the world's y axis as it was. On flat ground the two agree.
// In a loop they could not disagree more: the tangent there is swinging through
// a whole turn in the vertical plane, which a world-axis measurement reads as
// the tightest corner on the circuit and banks accordingly, standing the road
// over sideways in the middle of a loop. Read against the frame's own side
// vector, the same swing is straight up, contributes nothing sideways, and the
// loop comes out flat — which is what a loop is.
let BANK = TAN.map((_, i) => {
  const side = norm(cross(TAN[i], UPV[i]));
  const swing = sub(TAN[(i + 1) % RINGS], TAN[(i + RINGS - 1) % RINGS]);
  const span = dist(ring(i + 1), ring(i - 1));
  const turn = -dot(swing, side) / span;
  return Math.min(Math.max(turn * BANK_GAIN, -BANK_MAX), BANK_MAX);
});


// Catmull-Rom is only C1, so curvature — and with it the camber — *steps* at
// every control point, and a step in camber is a crease running clean across
// the road. Averaging each ring against its neighbours a few times spreads the
// step over several metres, which is what a real banked corner does anyway: the
// camber eases in on the approach instead of switching on at the apex.
//
// Out of place, one pass at a time. Smoothing in place would feed each ring the
// value its neighbour was given *this* pass, which is a different filter — it
// drags the whole profile along the direction of the loop.
for (let pass = 0; pass < 12; pass++) {
  BANK = BANK.map(
    (b, i) => (BANK[(i + RINGS - 1) % RINGS] + 2 * b + BANK[(i + 1) % RINGS]) / 4,
  );
}

// The finished frame: the transported one, rolled by its camber. Everything
// downstream — the ribbon, the grid, the physics — reads these two and never
// reaches for world up again.
const SIDEF = [];
const UPF = [];
for (let i = 0; i < RINGS; i++) {
  const side = norm(cross(TAN[i], UPV[i]));
  const cb = Math.cos(BANK[i]);
  const sb = Math.sin(BANK[i]);
  SIDEF.push(norm(side.map((c, k) => c * cb + UPV[i][k] * sb)));
  UPF.push(norm(cross(SIDEF[i], TAN[i])));
}

// The lighting in the shader runs off distance travelled, and the track is a
// loop, so the pattern has to come back to where it started or there is a seam
// across the road at the start line. Scaling every distance by a hair makes the
// lap an exact whole number of waves. A multiple of three, because the slow
// wave is a third of the rate of the fast one and both have to close.
const WAVES = 3 * Math.max(1, Math.round((LAP * 0.7) / (6 * Math.PI)));
const PATTERN = (WAVES * 2 * Math.PI) / (0.7 * LAP);

// Two vertices per ring, left edge then right. The ring at the start is emitted
// a second time at the end, carrying a full lap's distance instead of zero:
// closing the strip by wrapping the indices back to ring 0 would leave the last
// quad interpolating the distance from LAP down to 0, cramming the entire
// pattern into two metres of road.
const TP = [];
const TE = [];
for (let i = 0; i <= RINGS; i++) {
  const g = i % RINGS;
  // Across the road, straight off the carried frame. This used to be built here
  // out of the tangent and world up, which is the construction that cannot
  // survive a loop — see UPV above.
  const arm = SIDEF[g].map((c) => c * TRACK_WIDTH * 0.5);
  const c = CENTRE[g];
  const v = (i < RINGS ? ALONG[i] : LAP) * PATTERN;
  TP.push(c[0] - arm[0], c[1] - arm[1], c[2] - arm[2]);
  TE.push(-1, v);
  TP.push(c[0] + arm[0], c[1] + arm[1], c[2] + arm[2]);
  TE.push(1, v);
}

// ── Where the boost rings are ──────────────────────────────────────────────
// **Decided here rather than in a shader, because two places have to agree
// about it and they cannot agree on a hash.** The pads this replaces were a
// function evaluated identically in the track shader and the physics stage,
// which is what guaranteed the thing you could see was the thing that boosted
// you. A ring is geometry, and geometry is built on the CPU — so the moment the
// CPU needs the same answer, `fract(sin(x) * 43758.5)` stops being usable:
// JavaScript computes that in doubles and WGSL in floats, and a hash multiplied
// by 43758 turns a last-bit difference into a different lane. So the table is
// built once here and shipped to the physics on the end of the track buffer.
//
// One slot every 64 rows of the road's own tiling, three slots in four filled —
// the fourth outcome is "no ring", which is what scatters them. Slot zero and
// its neighbours are skipped whole: `START_CLEAR` keeps the grid and the run off
// the line free, which used to fall out of seating the pad 30 rows into its slot
// and is now said outright.
//
// Seeded from the circuit, so a track's rings are as fixed as its corners.
const RING_ROWS = 64;
const START_CLEAR = 2;
const RING_SLOTS = Math.ceil((LAP * PATTERN * 0.4456) / RING_ROWS);
/** Which third each slot's ring sits in — 0 left, 1 middle, 2 right, 3 none. */
const RING_LANE = new Float32Array(RING_SLOTS);
{
  let n = (TRACK.b * 1e6) | 0;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < RING_SLOTS; i++) {
    RING_LANE[i] = i < START_CLEAR || i > RING_SLOTS - 2 ? 3 : Math.floor(rnd() * 4);
  }
}

// Two triangles per quad. bmIndex draws uint16, so the track has a ceiling of
// 32k rings — about 65 km of road at this spacing.
const TI = [];
/**
 * The rings' own indices, kept apart from the road's.
 *
 * **They share every vertex and cannot share a draw, because they must not write
 * depth.** A ring is a quad twelve metres square with a ring painted somewhere
 * inside it and nothing in the rest — but "nothing" is an alpha of zero, not an
 * absence, and a fragment with zero alpha writes depth like any other. One draw
 * with depth write on therefore has each ring stamping a twelve-metre hole into
 * the depth buffer, and every ring behind it fails the test: looking through a
 * near ring, the road ahead has no rings on it at all.
 *
 * So the same vertices are drawn twice from two index lists — the road with
 * depth write, the rings without. They still *test* against it, so a ring over a
 * crest is still hidden by the crest; they just stop hiding each other.
 */
const TH = [];
for (let i = 0; i < RINGS; i++) {
  const a = i * 2;
  const b = a + 2;
  TI.push(a, b, a + 1, a + 1, b, b + 1);
}

// **A quad apiece, not a ring of triangles.** The ring itself is drawn by the
// fragment stage out of `length(uv)`, which costs four vertices instead of forty
// and gets the glow for nothing: a torus built from geometry has a hard silhouette
// and this has a falloff, on a surface where every other light is analytic for
// exactly that reason.
//
// They ride in the road's own buffers and are drawn by the road's own program.
// A ring is not the road, and the honest thing would be a second pipeline — but
// that is a program, a buffer, a bind group and a draw call for four vertices a
// ring. Marking them in `aEdge` instead costs one branch in each stage.
//
// `aPos` carries the slot and the corner rather than a position: where a ring
// actually is depends on the road under it, and the road is in a storage buffer
// the vertex stage can read. Building it here would mean a second copy of the
// centreline in JavaScript.
for (let i = 0; i < RING_SLOTS; i++) {
  if (RING_LANE[i] > 2) continue;
  const base = TP.length / 3;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    TP.push(i, x, y);
    TE.push(9, 0);
  }
  TH.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

// The ribbon, in the form the physics stage reads it: two vec4s a ring, centre
// with distance travelled, then tangent with camber. Everything the simulation
// needs to know about the road — where its floor is, which way is up, where its
// edges are — is rebuilt from those two by the same construction that built the
// geometry, which is the only reason the unicorn stands where the road looks.
//
// One ring longer than there are rings. The physics reads a *segment*, ring i to
// ring i+1, so the last ring needs a partner and its partner is the first one
// again. Exactly the trick the ribbon itself uses for its seam quad, and for the
// same reason: wrapping an index costs a branch in the shader, while repeating
// twelve floats costs twelve floats.
// Three vec4s per ring now, not two: centre with distance travelled, tangent,
// and the frame's up. The third is the whole reason a loop works — the physics
// used to rebuild "up" from the tangent and world up on the GPU, and that is
// undefined exactly where a loop stands the road on end. Sent instead of
// derived, and there is nothing left to be undefined.
//
// The ring at the start is emitted a second time at the end, carrying a full
// lap's distance instead of zero, so a body in the last segment interpolates
// forwards rather than being told the road runs from LAP back to nothing.
//
// The ring lane table is appended after it, one vec4 a slot. A whole vec4 to
// carry one number is wasteful of GPU memory and free in the zip — this array is
// generated, not shipped — and it means both readers index it with a slot number
// and nothing else.
const RING_BASE = (RINGS + 1) * 3;
const TRACK_DATA = new Float32Array((RING_BASE + RING_SLOTS) * 4);
for (let i = 0; i <= RINGS; i++) {
  const g = i % RINGS;
  TRACK_DATA.set(
    [...CENTRE[g], i < RINGS ? ALONG[i] : LAP, ...TAN[g], 0, ...UPF[g], 0],
    i * 12,
  );
}
for (let i = 0; i < RING_SLOTS; i++) TRACK_DATA[(RING_BASE + i) * 4] = RING_LANE[i];

// ── The grid ────────────────────────────────────────────────────────────────
// Where the ten of them stand before the flag. Built here because this is where
// the centreline, the camber and the lap length already live — the alternative
// is teaching the physics stage to lay out a grid it will never look at again
// after its first frame.
//
// **A diagonal stagger: one racer to a row, the lane stepping across by one
// each time it goes back.** Right, middle, left, right, middle, left — so ten
// racers make a lattice running away up the road rather than five tidy pairs.
// It is what a kart grid looks like, and it reads better from behind: every
// unicorn is offset from the one in front, so none of them is hidden and the
// depth of the field is visible at a glance. Rows can also be close together,
// because two racers are never side by side and it is the sideways gap that
// keeps them apart.
//
// Ten slots and three lanes divide with one left over, which is why the leader
// and the player end up in the same lane at opposite ends of the grid: 0 % 3 and
// 9 % 3 are both 0. That falls out of the arithmetic rather than being arranged,
// and would stop being true if the field or the lane count changed.
//
// The player takes the last slot rather than the first: a race you start in
// front of is a time trial with scenery, and the whole reason for nine of them
// is to have something to overtake.
//
// Only the position is seeded. Heading and course are left at zero, which the
// physics stage already treats as "not yet placed" and fills from the tangent
// under the body — the same path a respawn takes, so there is one piece of code
// deciding which way a unicorn faces and not two that can disagree.
const RACER_BASE = 16;
// Six, not five: the sixth carries how much boost a racer has left. Every word
// of the other five was spoken for — the spare quarter of each was already
// holding vy, speed, gait, the lit-panel coordinate and the lap distance the
// CPU reads back — and a timer is the one thing a boost pad needs that cannot be
// recomputed from where a unicorn is.
const RACER_SLOTS = 6;
/** Where the liveries start, six vec4s per racer. */
const PALETTE = 80;

/** The ring nearest a given distance round the lap. */
const ringAt = (d) => {
  const want = ((d % LAP) + LAP) % LAP;
  let best = 0;
  for (let i = 1; i < RINGS; i++) {
    if (Math.abs(ALONG[i] - want) < Math.abs(ALONG[best] - want)) best = i;
  }
  return best;
};

const LANES = 3;
const GRID = [];
for (let i = 0; i < FIELD; i++) {
  // Racer 0 is the player and goes to the back; the AI fill the rows in front.
  const slot = i ? i - 1 : FIELD - 1;
  // Four metres a row. Tight, and it can be: the whole field is staggered, so
  // the nearest other racer is always a lane over as well as a row up, and the
  // physics only pushes two apart inside 2.4.
  const g = ringAt(LAP - (6 + slot * 4));
  const arm = SIDEF[g];
  // Three lanes at a little under a third of the width apart, which leaves
  // about five metres from the outer lanes to the rails.
  //
  // `1 - lane` rather than `lane - 1`, so the stagger runs right to left going
  // back: the leader sits on the right of the front row and the player on the
  // right of the back one. Both ends of the field on the same side is what makes
  // the diagonal read as one line rather than as scattered rows, and it is the
  // player's own lane that tells them which way the lattice leans.
  const lat = (1 - (slot % LANES)) * TRACK_WIDTH * 0.3;
  GRID.push(CENTRE[g].map((c, k) => c + arm[k] * lat));
}

// ── Driving ─────────────────────────────────────────────────────────────────
// Keys are the one thing the GPU cannot read, so this is all the CPU still owns
// of the simulation: which keys are down, and a latch for the one that is an
// event rather than a state.
const HELD = {};
/** 1 when either key of a pair is down. */
const held = (a, b) => (HELD[a] || HELD[b] ? 1 : 0);

addEventListener('keydown', (e) => {
  HELD[e.code] = 1;
  // Arrows scroll the page and space pages down it, both of which move the
  // canvas out from under the player mid-corner. Space is no longer bound to
  // anything, but it still scrolls, so it is still swallowed.
  if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => (HELD[e.code] = 0));

// Wall clock, for the parts of the look that drift on their own — the road's
// scroll and the mane's colour. Everything that moves *because the unicorn is
// moving* reads the gait out of the state buffer instead, and the gait is a
// distance rather than a time.
let TIME = 0;

// ── Pause ───────────────────────────────────────────────────────────────────
// Escape toggles. The frame keeps being drawn while paused — the camera still
// works, so the model can be turned over and looked at — but `clock` stops, and
// `clock` is the only time the shader ever sees.
//
// That distinction is the whole trick. bmLoop hands out the wall clock, which
// carries on regardless, so a pause that merely skips the draw leaves the gait
// running invisibly and the legs jump to a new position the moment it resumes.
// Accumulating elapsed time only while playing means paused really is stopped.
// Which states count as "playing" is the state machine's business — see the
// frame loop, where only RACE_STATE advances the clock.
let clock = 0;
let prev = 0;

// ── The state machine ───────────────────────────────────────────────────────
// Five screens, one variable, and one function that moves between them.
//
// Called SCREEN rather than STATE because STATE is the GPU buffer every stage
// reads its world out of — everything in this program shares one scope, so a
// second STATE is not a shadow, it is a build failure.
//
// The states are numbers rather than strings because every one of them is
// compared dozens of times a frame and terser can fold a number into the
// comparison; the names are consts so the code still reads as names.
//
//   TITLE_STATE   a flat pink card. No world, no music, nothing to look at but
//                 the name of the game. Any key leaves.
//   SELECT_STATE  the circuit orbiting behind one unicorn turning on the spot.
//                 Left and right change it, enter goes to the grid.
//   FLAG_STATE    the field on the start line, held, counting down.
//   RACE_STATE    the thing itself.
//   PAUSE_STATE   the race, frozen, with the world still drawn behind the card.
//   WIN_STATE     the race over, and the same.
//
// Every transition goes through `go`, which is what keeps the music honest:
// each state names its own song, and the one place that changes state is the
// one place that has to ask for it.
const TITLE_STATE = 0;
const SELECT_STATE = 1;
const RACE_STATE = 2;
const PAUSE_STATE = 3;
const WIN_STATE = 4;
/**
 * On the start line, before the flag.
 *
 * Its own state rather than a flag inside RACE_STATE, because every question
 * the rest of the code asks — does the clock run, do the keys drive, which song
 * is playing, is the orbiting camera up — has a different answer here, and a
 * state machine that already answers all four is cheaper than four booleans
 * that can disagree with each other.
 */
const FLAG_STATE = 5;
let SCREEN = TITLE_STATE;

/** Which unicorn the player has picked, as an index into UNICORNS. */
let PICK = SELECTED_UNICORN;
/**
 * Where the carousel actually is, easing towards PICK.
 *
 * Held separately because the ring has to *turn*: snapping it to the new index
 * would teleport the choice into the front seat, and the one thing a carousel is
 * for is showing that the thing you wanted came round.
 *
 * It also has to be allowed to unwind past the ends — pressing left at the first
 * unicorn should run the ring backwards to the last, not spin it forwards
 * through the whole roster — so this tracks an unbounded winding rather than an
 * index, and the shader takes it modulo the seats.
 */

/** Fades the title card's pink out from under the world when SELECT_STATE arrives. */
let PINK = 1;

/**
 * How far round the lap each racer is, and how many times each has crossed the
 * line. Read back from the GPU six times a second; see `peek` below.
 *
 * **Crossings are one more than laps completed**, because the grid stands behind
 * the line and the opening lap begins with a crossing that finishes nothing.
 *
 * Laps are counted here rather than read from anywhere, because nothing on the
 * GPU tracks them: a racer's slot carries distance *round* the lap, which resets
 * at the line. Ordering the field on that alone would show the leader dropping
 * to last the instant they crossed it.
 *
 * Module scope rather than inside the frame loop because `go` clears them, and
 * `go` is what every transition goes through — a counter the transition cannot
 * reach is one that survives into the next race.
 */
const ROUND = new Float32Array(FIELD);
const DONE = new Float32Array(FIELD);
/** The player's place, 0 for first. */
let place = 0;
/**
 * The draw the field takes for this race — see uRoll in physics.shader.ts.
 *
 * Rolled at the flag and held for the whole race, because it decides each AI's
 * pace: re-rolled per frame it would not be a field of racers, it would be nine
 * caps flickering at sixty hertz.
 */
let ROLL = 0;
/**
 * The player's boost clock as of the last readback, to hear a rise in it.
 *
 * **The rings are on the GPU and the speakers are on the CPU, and this is the
 * only wire between them.** Nothing here knows where a ring is; what the CPU
 * gets is the lap readback, which already copies every racer's block six times a
 * second with the clock inside it. So the cue is triggered by watching a number
 * rather than by watching the road.
 *
 * Racer zero's, and no one else's. This was field-wide with a distance falloff,
 * on the theory that a ring taken up ahead told you the field was using them —
 * what it actually did was turn a cue into weather. Both of the player's cues
 * are now the player's alone.
 */
let wasBoost = 0;
/**
 * Earliest wall-clock time the next mistake may be heard.
 *
 * The mistake cue is the player's alone. A rival scraping a rail or shunting
 * another rival is not their problem and does not want to be in their ears: nine
 * racers jostling would put a knock under the whole race. The boost cue is the
 * opposite case and stays field-wide, because a ring taken ahead of you is
 * information.
 */
let mistakeAt = 0;

/**
 * One unicorn's colours, in the layout the palette region expects.
 *
 * **A two-colour mane is stored as a three-stop gradient with its middle stop at
 * the midpoint**, which is the same straight line through colour space — so
 * every mane written before the third stop existed comes out unchanged, to the
 * pixel, and the shader has one blend rather than a branch.
 */
function livery(r) {
  const paint = new Float32Array(24);
  paint.set([...r.body, r.mane ? 0 : 1], 0);
  if (r.mane) {
    const a = r.mane.slice(0, 3);
    const c = r.mane.slice(-3);
    paint.set(a, 4);
    paint.set(r.mane.length > 6 ? r.mane.slice(3, 6) : a.map((v, k) => (v + c[k]) / 2), 8);
    paint.set(c, 12);
  }
  paint.set(r.horn || HORN, 16);
  // The horn's spare fourth word: how big this one is, 1 if the roster does not
  // say. Not a colour, and it rides here because the alternative — an eleventh
  // channel — is a seventh vec4 for every racer to carry one number.
  paint[19] = r.size || 1;
  paint.set(r.eye || EYE, 20);
  return paint;
}

/**
 * Dress the palette slots.
 *
 * The palettes live in the state buffer, six vec4s per racer from slot 80, and
 * every render stage already reads them there — so this is not a message to
 * anything, it is twenty-four numbers written over twenty-four, and the next
 * frame draws different unicorns.
 *
 * This one dresses the whole field, for the grid: the roster rotated so the
 * player's pick leads, which is what makes racer zero the player. The select
 * screen wants one slot rather than ten and has `showPick` above for it.
 */
/**
 * The chosen unicorn's colours, into the one palette slot the select screen
 * draws from.
 *
 * That screen shows a single model, so walking the roster is a matter of
 * rewriting twenty-four numbers rather than moving anything: the arrows change
 * `PICK`, this puts the new livery in slot zero, and the next frame draws a
 * different unicorn in the same place. Called on the way in and on every press.
 */
function showPick() {
  bmDevice.queue.writeBuffer(STATE, PALETTE * 16, livery(UNICORNS[PICK]));
}

function dress(list) {
  for (let i = 0; i < FIELD; i++) {
    bmDevice.queue.writeBuffer(STATE, (PALETTE + i * 6) * 16, livery(list[i]));
  }
}

/**
 * Put the whole field back on the grid.
 *
 * **The select screen leaves the whole field in the air.** The carousel is drawn by
 * writing seats into the same slots the simulation reads its bodies out of —
 * there is only one position per racer — so the first four come out of that
 * screen believing they are hanging in front of a camera. Left alone they start
 * the race there, fall, and hunt for a road that is a hundred units away.
 *
 * Zeroing everything but the position is what makes this a *reset* rather than a
 * repair: a zero course is the flag the physics stage reads as "not yet placed",
 * and it answers it from the tangent under the body. So the same write that
 * fixes the carousel also clears speed, gait and the fall, and points every
 * unicorn back down the road.
 */
function resetGrid() {
  const block = new Float32Array(RACER_SLOTS * 4);
  for (let i = 0; i < FIELD; i++) {
    block.fill(0);
    block.set(GRID[i], 0);
    bmDevice.queue.writeBuffer(STATE, (RACER_BASE + i * RACER_SLOTS) * 16, block);
  }
}

function go(next) {
  // A race always starts from nothing, however it was reached.
  //
  // Last and not first: the grid puts the player behind the whole field, so the
  // corner should read 10TH from the moment it appears. Zero here meant the
  // countdown ran with 1ST on screen until the first readback landed and
  // corrected it — the one moment in the race when the number is a promise
  // rather than a report.
  // The flag itself, held for two seconds. Only from the grid: unpausing is also
  // a way into RACE_STATE, and a race resuming mid-corner should not announce
  // itself as if it were starting.
  if (next === RACE_STATE && SCREEN === FLAG_STATE) flash = 2;
  if (next === FLAG_STATE) {
    ROUND.fill(0);
    DONE.fill(0);
    place = FIELD - 1;
  }
  // The palettes are shared between the carousel and the grid, so they are
  // rewritten on the way into each.
  if (next === SELECT_STATE) showPick();
  if (next === FLAG_STATE) {
    ROLL = Math.random();
    lights = 0;
    rung = 0;
    lineUp(PICK);
    dress(RACERS);
    resetGrid();
  }
  SCREEN = next;
  syncMusic();
}

// The two rendered loops, and the song each state asks for.
//
// **Two states are absent, and both are silence on purpose.** TITLE_STATE,
// because that is what makes the first keypress the moment the game starts
// making noise. And FLAG_STATE, so the grid is quiet: three ready signals and a
// countdown land on nothing at all, which is the loudest they can be, and the
// race song then cuts in on the flag rather than replacing something already
// playing.
//
// The grid used to hold the menu song at half volume, and half a song is still a
// song to sit a countdown on. There was a gain node between the music and the
// speakers for that ducking; with nothing left to duck it went too, and the
// looping source now goes straight to the destination the way an effect always
// did.
const SONGS = {};

// Each effect is rendered once at start-up and handed back as a function that
// plays it. Both the effects and `shot`, which renders them, live in
// src/soundEffects.js.
const playSelectNext = shot(UNICORN_SELECT_NEXT);
const playSelectPrev = shot(UNICORN_SELECT_PREV);
const playReady = shot(READY_SIGNAL, 2);
const playBoost = shot(BOOST, 2);
const playMistake = shot(MISTAKE, 2);

// ── The start line ──────────────────────────────────────────────────────────
// Seconds since the grid appeared, and how many signals have sounded. Three
// readies and then the start, one a second, which is the sequence every kart
// game has used since the arcade.
//
// Counted in signals rather than checked against timestamps, so a dropped frame
// or a tab left in the background cannot swallow one: the loop plays whatever it
// is behind on, in order, however late it notices.
let lights = 0;
let rung = 0;
/**
 * Seconds of "GO!" left on screen.
 *
 * Set when the flag drops and counted down like everything else, rather than
 * compared against a timestamp: pausing stops the clock, and a player who pauses
 * two frames into a race should come back to the same two seconds of it.
 */
let flash = 0;
const SIGNALS = 4;

// The grid keeps the menu song. The race song arriving *with* the flag is what
// makes the flag an event.
const SCORE = { 1: 'menu', 2: 'race', 3: 'menu', 4: 'menu' };

addEventListener('keydown', (e) => {
  if (SCREEN === TITLE_STATE) {
    go(SELECT_STATE);
    return;
  }
  if (SCREEN === SELECT_STATE) {
    // Wrapped both ways, so the roster is a carousel rather than a list with
    // ends to bump into.
    const step = (e.code === 'ArrowRight' || e.code === 'KeyD' ? 1 : 0) -
      (e.code === 'ArrowLeft' || e.code === 'KeyA' ? 1 : 0);
    if (step) {
      // The winding moves by one whatever happens; the index wraps. That is what
      // makes the ring turn the short way round the ends.
      PICK = (PICK + step + UNICORNS.length) % UNICORNS.length;
      // Up for forward, down for back.
      (step > 0 ? playSelectNext : playSelectPrev)();
      showPick();
    }
    if (e.code === 'Enter' || e.code === 'Space') go(FLAG_STATE);
    return;
  }
  // Any key at all leaves a pause, not just the one that caused it. Escape to
  // stop and W to go again is the natural thing to reach for, and it works
  // because the throttle is read from the held-keys map rather than from this
  // handler — the key that unpauses is already down when the next frame asks.
  if (SCREEN === PAUSE_STATE) {
    go(RACE_STATE);
    return;
  }
  if (e.code === 'Escape' && SCREEN === RACE_STATE) {
    go(PAUSE_STATE);
    return;
  }
  // From the winner's screen, back to the top, and on Enter only — unlike the
  // pause screen, which any key leaves. The result is worth a beat to read, and
  // a player still holding the throttle at the finish would otherwise clear it
  // before seeing it.
  if (SCREEN === WIN_STATE && e.code === 'Enter') go(TITLE_STATE);
});
// A click does whatever a key would at the one place a player might try it.
addEventListener('pointerdown', () => {
  if (SCREEN === TITLE_STATE) go(SELECT_STATE);
});

// The source that is currently playing, and which song it is playing, so a
// state change that asks for the same music does not restart it. Not TRACK: that
// is the road's centreline, further up this file — everything here shares one
// scope, so a second TRACK is not a shadow, it is a build failure.
let PLAYING = null;
let PLAYING_NAME = null;

function syncMusic() {
  if (!MUSIC_ENABLED) return;
  const want = SCORE[SCREEN];
  // Already playing the right thing. **This test is the whole reason pausing
  // does not restart the menu music**: PAUSE_STATE and SELECT_STATE and WIN_STATE all ask for the
  // same song, so unpausing mid-bar drops straight back into the race rather
  // than restarting a track the player was already listening to.
  if (want === PLAYING_NAME) return;
  if (PLAYING) {
    PLAYING.stop();
    PLAYING = null;
  }
  PLAYING_NAME = null;
  // Nothing to play in this state, or the song has not finished rendering yet —
  // in which case music.js calls back here the moment it has.
  if (!want || !SONGS[want]) return;
  // Resumed here rather than on the way in, so the silent title screen never
  // asks the browser for audio it is not going to use.
  MUSIC.resume();
  PLAYING = MUSIC.createBufferSource();
  PLAYING.buffer = SONGS[want];
  PLAYING.loop = true;
  PLAYING.connect(MUSIC.destination);
  PLAYING.start();
  PLAYING_NAME = want;
}

/**
 * Render one song into a buffer that loops seamlessly.
 *
 * ── Trim it to what is actually written ────────────────────────────────────
 * A SoundBox export carries two numbers that disagree with its own patterns,
 * and both of them break a loop.
 *
 * `endPattern` is how many pattern slots the scheduler cycles through, and it is
 * set in the editor rather than derived — so a song written as four bars but
 * left with the length slider at six declares six. The scheduler does
 * `p[floor(row / 32) % (endPattern + 1)] || 0`, and the slots past the end of
 * `p` come back undefined, fall through the `||`, and play as silence. That does
 * not sound like a gap in a loop; it sounds like the music stopped.
 *
 * `songLen` is the render length in seconds, also authored by hand, and it
 * truncates whatever it is shorter than. Derived instead from the tempo the
 * scheduler actually runs at: `bpm` is *rounded* off rowLen inside sonant-x, so
 * the row it schedules is 60/bpm/4 rather than rowLen/44100, and computing this
 * from rowLen directly drifts a few milliseconds by the end of the loop.
 *
 * The clamp is one-directional on purpose. A song asking for *fewer* slots than
 * it has patterns is a deliberately short loop and is left alone; only the
 * over-declaration is corrected.
 *
 * ── Then keep the second time round, not the first ─────────────────────────
 * Cutting the render at the loop point leaves every note that was still
 * releasing chopped off mid-decay, and the jump from that to the silence of the
 * first sample is a click once round.
 *
 * The fix is not to render a little extra and add it back over the start. That
 * was tried and made it worse: the scheduler already wraps its pattern list, so
 * the samples past the loop point are not the ring-out of the last bar, they are
 * *the first bar playing again*. Adding them to the start doubled the opening.
 *
 * What is wanted is a slice of the song mid-performance, with the previous time
 * round already ringing through it. So it is rendered twice and the *second*
 * pass is kept. Its opening carries the tail of the first pass, and because both
 * passes play identical notes, that tail is exactly what this pass's own ending
 * hands to whatever follows it. The buffer joins to itself.
 *
 * Twice is enough and three times would buy nothing: the tail rings for less
 * than a bar and every pass is the same music, so pass two is already
 * indistinguishable from pass two hundred.
 */
function renderLoop(song, into) {
  const slots = Math.min(
    song.endPattern + 1,
    Math.max(...song.songData.map((ch) => ch.p.length)),
  );
  song.endPattern = slots - 1;
  const loop = (slots * 32 * 60) / (Math.round(661500 / song.rowLen) * 4);
  song.songLen = loop * 2;
  const rate = MUSIC.sampleRate;
  const len = Math.round(loop * rate);
  return renderSong(MUSIC, song, len * 2).then((raw) => {
    const buffer = MUSIC.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      buffer.getChannelData(ch).set(raw.getChannelData(ch).subarray(len, len * 2));
    }
    SONGS[into] = buffer;
    // Whichever state is up may have been waiting for exactly this one.
    syncMusic();
  });
}

if (MUSIC_ENABLED) {
  // The menu song first, because it is the one a player hears first: the title
  // screen is silent, and the very next state wants it. Rendered in series
  // rather than together — each is a full offline mix, and the frame the page
  // loads is already busy compiling shaders and building a circuit.
  renderLoop(MENU_SONG, 'menu').then(() => renderLoop(RACE_SONG, 'race'));


  // Autoplay is not something a page gets to decide. Every current browser
  // starts an AudioContext suspended until the user has interacted with the
  // page, and the state machine turns that rule into the start button: the
  // title screen is silent by design, so the keypress that leaves it is the
  // gesture that unlocks the audio. Nothing extra is needed here.
}


// The unicorn's whole existence, and the camera that watches it.
//
// Zeroed, which is a valid opening position rather than a placeholder: the body
// starts at the origin, which is ring zero, and every other field — heading,
// course, speed, gait, the fall — genuinely starts at nothing. The camera's stored
// "exists" flag starting at zero is what tells the first dispatch to place the
// camera outright instead of gliding it in from the origin.
//
// A global because the debug build writes over it. See debug.js.
let STATE = null;

// Near black, with just enough blue in it to be a night sky rather than a hole
// in the screen. The road is the only light source in the scene, and it is only
// as bright as what surrounds it — the daylit sky this used to clear to was
// within a stop of the rails, so the glowing ribbon read as a coloured floor.
// Everything the road does now happens against nothing at all.
// Alpha zero in the clear, and it matters in exactly one place. The canvas is
// configured `alphaMode: 'opaque'`, so its own alpha is never looked at — but
// render targets clear with this same colour, and the reflection target uses
// alpha as its coverage mask. Cleared to 1 the mask reads "unicorn everywhere"
// and the road mixes toward black across its whole surface.
bmInit(canvas, [0.02, 0.02, 0.05, 0]).then(() => {
  // Sixteen vec4 slots of player and camera, five each per racer from slot 16,
  // and six each of livery from slot 80. The first sixteen keep their old
  // meanings so the road's shadow, the minimap and the debug build go on reading
  // slot 0 for "where is the unicorn the camera is watching".
  //
  // Slots 13 and 14 are spare. They used to hold a falling star's arc and had to
  // be seeded with unit vectors, because the sky normalised them every frame and
  // normalising a zero vector is NaN rather than zero.
  const state = new Float32Array((PALETTE + FIELD * 6) * 4);
  // The grid. Position only: everything else is zero, which every field here is
  // genuinely starting at — and a zero course is what tells the physics stage to
  // point each unicorn down the road it finds itself on.
  for (let i = 0; i < FIELD; i++) {
    state.set(GRID[i], (RACER_BASE + i * RACER_SLOTS) * 4);
  }
  // Each racer's colours, six slots apiece. Written once and never again: a
  // livery is not state, it is a constant that happens to differ per instance,
  // and this buffer is the only channel wide enough to carry the whole field.
  //
  // Through `livery` rather than repeating its layout, which is the second copy
  // this used to be — and the copy that would have kept writing two mane stops
  // into a palette that now holds three.
  RACERS.forEach((r, i) => state.set(livery(r), (PALETTE + i * 6) * 4));
  // Created here rather than through bmStore, for one flag: COPY_SRC.
  //
  // **This is the only path by which anything on the GPU can tell the CPU
  // something.** The whole design puts the simulation on the GPU so the answer
  // never has to come back — but a race has to end, and knowing that the player
  // has crossed the line for the last time is a fact only the physics stage
  // knows. bmStore makes its buffers STORAGE|COPY_DST, which can be written but
  // never read; the same buffer with COPY_SRC can be copied into a staging
  // buffer and mapped.
  STATE = bmDevice.createBuffer({ size: state.byteLength, usage: 128 | 8 | 4 });
  bmDevice.queue.writeBuffer(STATE, 0, state);
  const rings = bmStore(TRACK_DATA);

  // The simulation. One workgroup of one, dispatched once a frame: there is a
  // single unicorn and nothing here is parallel. It is on the GPU so that the
  // answer never has to come back — see physics.shader.ts.
  const sim = bmCompute(Physics[0], { u: Physics[3], s: Physics[5] });
  bmStorages(sim, STATE, rings);

  // ── The field, as instance data ─────────────────────────────────────────
  // One buffer, one float: which racer each instance is. WebGPU guarantees only
  // eight vertex buffers and the mesh already spends five, so the colours go
  // through the state buffer instead — see PALETTE above. Asking for five
  // instance buffers was ten in total, which is a validation error and a black
  // screen rather than a slow frame.
  const IX = new Float32Array(FIELD);
  for (let i = 0; i < FIELD; i++) IX[i] = i;
  /** The one instance buffer sits after the five per-vertex ones. */
  const herd = (p) => bmAttr(p, 5, IX);

  const prog = bmProgram(Unicorn[0], {
    a: Unicorn[1],
    i: Unicorn[2],
    u: Unicorn[3],
    t: Unicorn[4],
    s: Unicorn[5],
    cull: 1,
  });
  bmAttr(prog, 0, new Float32Array(P));
  bmAttr(prog, 1, new Float32Array(NR));
  bmAttr(prog, 2, new Float32Array(RT));
  bmAttr(prog, 3, new Float32Array(SK));
  bmAttr(prog, 4, new Float32Array(CL));
  herd(prog);
  bmIndex(prog, idx);
  bmStorages(prog, STATE);

  // Drawn without culling: the ribbon is one surface with nothing under it, and
  // half a lap of it is above the camera on the climb, so the underside is on
  // screen as often as the top.
  // Blending, for the boost rings only: they ride in this buffer and fade out
  // into their own quads' corners. The road returns an alpha of 1 and is
  // untouched by it.
  const track = bmProgram(Track[0], {
    blend: 1,
    a: Track[1],
    i: Track[2],
    u: Track[3],
    t: Track[4],
    s: Track[5],
  });
  bmAttr(track, 0, new Float32Array(TP));
  bmAttr(track, 1, new Float32Array(TE));
  bmIndex(track, new Uint16Array(TI));
  bmStorages(track, STATE, rings);

  // The rings, from the same shader over the same vertices — the pipeline
  // differs in one flag and nothing else does.
  const hoops = bmProgram(Track[0], {
    blend: 1,
    zwrite: 0,
    a: Track[1],
    i: Track[2],
    u: Track[3],
    t: Track[4],
    s: Track[5],
  });
  bmAttr(hoops, 0, new Float32Array(TP));
  bmAttr(hoops, 1, new Float32Array(TE));
  bmIndex(hoops, new Uint16Array(TH));
  bmStorages(hoops, STATE, rings);

  // The sky. One triangle big enough to cover the screen — the corners run to 3
  // rather than 1 so a single one spans the viewport with the excess clipped
  // away, which is a vertex and an edge cheaper than a quad and has no diagonal
  // through the middle for the rasteriser to seam on.
  //
  // `zwrite: 0` and drawn before everything else: it fills the frame with sky,
  // leaves the depth buffer as it found it, and the road and the unicorn then
  // paint over it wherever they are.
  const sky = bmProgram(Sky[0], { a: Sky[1], u: Sky[3], s: Sky[5], zwrite: 0 });
  bmAttr(sky, 0, new Float32Array([-1, -1, 3, -1, -1, 3]));
  bmIndex(sky, new Uint16Array([0, 1, 2]));
  bmStorages(sky, STATE);

  // The captions, baked. Every line the game shows lives in src/text.js; this
  // paints them into the rows of one texture.
  //
  // Baked rather than rasterised in a shader because none of it changes: the
  // roster is fixed, so even the unicorn names are known at start-up. A lap
  // counter would want the glyph table in a storage buffer and the bits picked
  // out per fragment; this wants a canvas and a loop.
  //
  // White on transparent, so the shader gets coverage rather than colour and is
  // free to paint the letters out of the rainbow. One canvas pixel per font
  // pixel with a nearest filter, so a 3x5 letter stays a 3x5 letter however
  // large the quad lands it.
  /** Font pixels per glyph cell: three of letter and one of gap. */
  const CELL = 4;
  /**
   * And seven down: five of letter with a spare above and below.
   *
   * **Seven and not six because of the plate** — the black rectangle behind each
   * letter, which is the glyph's 3x5 with a pixel of margin all round, so 5x7.
   * At a pitch of six a plate would run a pixel into the row above, and rows are
   * unrelated captions: the lap counter would have carried a stray black bar
   * from whatever happened to be baked above it.
   *
   * Seven also centres the ink, which the old six did not — five in six left it
   * a twelfth high and the vertex stage had to shift every quad down to
   * compensate. That correction is gone.
   */
  const ROW_H = 7;
  const CARD_W = Math.max(...LINES.map((l) => l.length)) * CELL;

  // ── Type sizes ──────────────────────────────────────────────────────────
  // Three of them, named, so every screen agrees: EXTRA_LARGE for whatever a
  // screen is *about*, LARGE for the line under it, MEDIUM for instructions.
  //
  // The number is the half-width of the caption's quad in NDC, not a height —
  // and that is what makes one constant give the same *letter* size to every
  // line. Each row of the atlas is as wide as the longest string in the game and
  // shorter ones are centred in it, so a row always carries the same number of
  // font pixels across; scaling the quad therefore scales the glyphs and nothing
  // else. `PAUSED` at EXTRA_LARGE is six big letters, not one word stretched to
  // fill the screen.
  //
  // **Derived from the atlas width, not written down.** A row is padded to the
  // longest line in the game and shorter strings are centred in the padding, so
  // the same half-width draws smaller letters the moment a longer caption
  // appears. That happened twice — 29 characters to 38 to 44 — and each time
  // every constant here had to be multiplied by hand to keep the screens looking
  // as they did, with the arrows and the two aligned readouts needing their own
  // corrections on top. Scaling off CARD_W does it instead.
  //
  // 116 is the width these numbers were chosen at: 29 cells of four pixels. The
  // ratio is what matters, so the type stays the size it looks on screen however
  // long the longest caption gets.
  const TYPE = CARD_W / 116;
  /**
   * The countdown, and nothing else.
   *
   * **Far wider than the screen, on purpose.** A caption's half-width sizes its
   * glyphs, and these rows are one and three characters long in an atlas
   * forty-three wide — so nearly all of the quad is empty padding either side of
   * the ink, and only the middle of it is ever on screen. Sizing this off the
   * type scale like everything else would give a numeral the height of a
   * caption; the countdown wants to be a third of the display.
   */
  const HUGE = 5.2 * TYPE;
  const EXTRA_LARGE = TYPE;
  const LARGE = 0.62 * TYPE;
  const MEDIUM = 0.42 * TYPE;
  /**
   * The "ST" beside the place, and the one size that is derived rather than
   * chosen.
   *
   * It used to be LARGE, and LARGE is 0.62 — which put the suffix's plate four
   * thousandths *inside* the numeral's. The two are separate captions, so their
   * plates are separate quads at half alpha, and where they overlapped the black
   * doubled into a hard line down the gap.
   *
   * The two plates touch exactly at 0.6234, which falls out of where the ink
   * sits in each row: the numeral's ends at atlas pixel 133 of 172 and the
   * suffix's begins at 164, and each plate reaches one atlas pixel further,
   * scaled by its own half-width. Sitting on that number would leave the join a
   * rounding error away from a seam in either direction, so this is far enough
   * past it to read as two boxes with a gap rather than one box with a fault.
   */
  const SUFFIX = 0.64 * TYPE;

  /** The row each unicorn's name landed on. */
  const NAME_ROW = LINES.length - UNICORNS.length;
  /** The row of the numeral "1"; the other nine follow it. */
  const PLACE_ROW = NAME_ROW - 16;
  /** "CIRCUIT 1 / 2" and its siblings, one a circuit, just above the numerals. */
  const CIRCUIT_ROW = PLACE_ROW - CIRCUITS.length;
  /** The countdown's own glyphs: 3, 2, 1, GO!. */
  const COUNT_ROW = 12;
  /** The row of "ST", then ND, RD, TH; four suffixes cover ten places. */
  const SUFFIX_ROW = NAME_ROW - 6;
  /** The row of "LAP 1/2"; one row a lap. */
  const LAP_ROW = NAME_ROW - 2;
  const card = document.createElement('canvas');
  card.width = CARD_W;
  card.height = LINES.length * ROW_H;
  const cctx = card.getContext('2d');
  const glyphs = cctx.createImageData(card.width, card.height);
  // Two things go into this image, in two channels: alpha is *coverage* — the
  // plate and the letter together — and red says which of the two a pixel is.
  // The shader paints red pixels out of the rainbow and the rest black, so one
  // sample carries both the letterform and the box behind it.
  const put = (row, x, y, ink) => {
    const k = ((row * ROW_H + y) * CARD_W + x) * 4;
    glyphs.data[k] = ink;
    glyphs.data[k + 3] = 255;
  };
  LINES.forEach((text, row) => {
    const left = ((CARD_W - text.length * CELL) / 2) | 0;
    for (let i = 0; i < text.length; i++) {
      const g = FONT_SET.indexOf(text[i]);
      // Nothing at all for a space, plate included — otherwise the bar behind a
      // caption would run straight through the gaps between its words.
      if (g < 1) continue;
      const x0 = left + i * CELL;
      // The plate first, so the letter overwrites the middle of it. Five wide
      // and seven tall against a cell that is four by seven, which means the
      // plate of one letter overlaps its neighbour's by a pixel: adjacent
      // letters merge into one continuous bar behind the word, which is the
      // point. A per-letter box with hairline gaps would read as stripes.
      //
      // The countdown gets one too. It used to be the exception — the plate
      // scales with the caption and these four are drawn at five times the size,
      // so a "3" arrived with a dark panel a third of the screen wide — but a
      // countdown with no box behind it is the one caption that lands on a
      // moving scene it has to be read against, and consistency with the rest of
      // the type is worth the panel.
      for (let y = 0; y < ROW_H; y++) {
        for (let x = 0; x < 5; x++) put(row, Math.max(x0 + x - 1, 0), y, 0);
      }
      for (let y = 0; y < 5; y++) {
        const bits = parseInt(FONT[g * 5 + y], 8);
        for (let x = 0; x < 3; x++) {
          // Octal digits run most significant bit first, which is leftmost.
          if (bits & (4 >> x)) put(row, x0 + x, y + 1, 255);
        }
      }
    }
  });
  cctx.putImageData(glyphs, 0, 0);
  // Nearest, or the blow-up smears each font pixel into its neighbours.
  const cardTex = bmTexture(card, 0);

  // The march, at a quarter of the width and a quarter of the height — one
  // sixteenth of the rays. A cloud is the one thing in the scene that loses
  // nothing to that: no edges, no texture, no silhouette, only soft gradients,
  // and the target samples back linearly.

  // The title card. Its own program because it blends — the letters have to sit
  // over the sky rather than punch a hole in it — and because a blend state is
  // baked into a pipeline at creation and cannot be switched on for one draw.
  const text = bmProgram(Text[0], {
    a: Text[1], i: Text[2], u: Text[3], t: Text[4], s: Text[5],
    blend: 1,
    // No depth: it is an overlay, drawn last, over a finished frame.
    zwrite: 0,
  });
  bmAttr(text, 0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  // Eight is the most any screen asks for, and it is the grid: a place, a
  // suffix, a lap, a circuit title, a countdown glyph and two instructions —
  // seven — with the title card still fading over the top of them if a player
  // went from the title to the grid in under a third of a second. Allocated once and written into every frame rather than rebuilt —
  // bmAttr creates a fresh GPU buffer each call, which per frame is a leak
  // rather than an upload.
  //
  // Too small is not a slow frame, it is `Float32Array.set` throwing `offset is
  // out of bounds` from inside the render loop, and a black screen.
  const CAPTIONS = 8;
  const cells = new Float32Array(CAPTIONS * 4);
  bmAttr(text, 1, cells);
  const cellBuf = text.b[1];
  bmIndex(text, new Uint16Array([0, 1, 2, 0, 2, 3]));
  bmTextures(text, cardTex);
  const textU = new Float32Array(Text[3] / 4);

  const step = new Float32Array(Physics[3] / 4);
  const u = new Float32Array(Unicorn[3] / 4);
  // The clock, on its own, for the stages that want nothing else.
  //
  // This used to be `u` as well, and it worked only because the unicorn's block
  // happened to be the same sixteen bytes as everyone else's. Giving the unicorn
  // its mane colours grew it to forty-eight, and handing that to a program with a
  // sixteen byte block overruns it — the write is rejected and the uniform simply
  // never updates. The symptom was the whole sky frozen at time zero:
  // no drift in the road's palette, and nothing in the console to say so.
  const tu = new Float32Array(4);
  // Gallop, always, for as long as there is a track under the hooves. Written
  // once rather than per frame because nothing on this screen can change it; the
  // select screen will hold 0 the same way. See uRun in unicorn.shader.ts.
  u[1] = 1;
  // The circuit's boost phase, to the two stages that have to agree about where
  // the pads are: the physics decides whether a unicorn is standing on one, the
  // road draws them, and a disagreement is a pad you can see and not use. Sent
  // once — it is a property of the circuit, and the circuit does not change
  // inside a race. `tu` already carries four floats to the road and the sky and
  // was using one of them.
  // The road stage no longer hashes the rings out of the seed — game.js decides
  // where they are, so what the two stages need is how to find them.
  tu[1] = 1 / (PATTERN * 0.4456 * 2);
  tu[2] = RING_BASE;
  step[10] = RING_BASE;
  // ── Counting laps ───────────────────────────────────────────────────────
  // One 16-byte read, six times a second, of the one number that decides when
  // the race is over: how far round the lap racer zero is.
  //
  // Polled rather than pushed, and deliberately slow. A map is asynchronous —
  // the answer arrives a frame or two later — so this can never be part of the
  // frame it is asked in, which rules out anything that has to be exact. It does
  // not have to be: a lap takes about a minute, and the only question being
  // asked is "has the distance jumped from near the end back to near the
  // beginning", which is true for several seconds either side of the line.
  //
  // The buffer is recycled and a read is never started while one is in flight —
  // mapAsync on an already-mapped buffer is an error, and allocating a fresh
  // staging buffer six times a second is a leak with extra steps.
  /** Laps to race. Crossings needed is one more, for the start. */
  const LAPS = 2;
  // MAP_READ | COPY_DST. WebGPU allows MAP_READ to pair with COPY_DST and
  // nothing else, so a staging buffer is the *destination* of the copy; the
  // storage buffer is the one that needs COPY_SRC.
  //
  // The whole field now, not just the player: it used to copy one racer's fifth
  // slot to count laps, and the running order needs the same number off every
  // one of them. They are contiguous — five slots each from RACER_BASE — so it
  // is still one copy, of 800 bytes instead of 16, six times a second.
  const lapPeek = bmDevice.createBuffer({ size: FIELD * RACER_SLOTS * 16, usage: 1 | 8 });
  let peeking = false;
  let peekAt = 0;

  const peek = () => {
    // The grid as well as the race: the order is on screen from the moment the
    // field lines up, and without a read there it would show whatever the last
    // race left behind. It also primes the wrap test before the flag.
    if (peeking || (SCREEN !== RACE_STATE && SCREEN !== FLAG_STATE)) return;
    peeking = true;
    const enc = bmDevice.createCommandEncoder();
    // Every racer's block. The fifth slot of each carries distance round the
    // lap in its spare word.
    enc.copyBufferToBuffer(STATE, RACER_BASE * 16, lapPeek, 0, lapPeek.size);
    bmDevice.queue.submit([enc.finish()]);
    lapPeek.mapAsync(1).then(() => {
      const seen = new Float32Array(lapPeek.getMappedRange().slice(0));
      lapPeek.unmap();
      peeking = false;
      // Same wrap test for all ten, and then the order falls out of the totals.
      // Racer zero's contact clock, on its own outside the loop, because only
      // the player's knocks are audible. Same rising edge as the boost, so a
      // rail leant on through a corner rings once rather than sixty times a
      // second, and at the effect's own volume — the player is never at a
      // distance from themselves.
      // **A level and a rate limit, not an edge.** An edge rings once and then
      // goes quiet for as long as the contact lasts, which is wrong for a rail:
      // scraping down the outside of a corner should keep telling you so. The
      // shader holds the clock up for as long as the mistake is being made, and
      // this decides how often that is worth saying.
      //
      // A quarter of a second is the floor on the gap. The readback lands six
      // times a second, so the real rate is one sound every other poll — a shade
      // over three a second, under the limit rather than at it.
      if (seen[21] > 0.01 && TIME > mistakeAt) {
        playMistake();
        mistakeAt = TIME + 0.25;
      }
      // Racer zero's boost clock, watched for a rise: the ring is under the
      // hooves for a tenth of a second, less than the gap between reads, so the
      // contact is routinely missed and the raised clock left behind never is.
      const lit = seen[20];
      if (lit > wasBoost) playBoost();
      wasBoost = lit;
      let ahead = 0;
      for (let i = 0; i < FIELD; i++) {
        const p = i * RACER_SLOTS * 4;
        const now = seen[p + 19];
        if (ROUND[i] > LAP * 0.75 && now < LAP * 0.25) DONE[i]++;
        ROUND[i] = now;

      }
      const mine = DONE[0] * LAP + ROUND[0];
      for (let i = 1; i < FIELD; i++) {
        if (DONE[i] * LAP + ROUND[i] > mine) ahead++;
      }
      place = ahead;
      // The player's own count is DONE[0], the same number the order is built
      // from. It used to be tracked separately with its own copy of the wrap
      // test; two counters of the same thing is one too many, and the one that
      // drifts is the one nobody is watching.
      //
      // One more crossing than laps raced: the grid is behind the line, so the
      // first crossing is the start.
      if (DONE[0] > LAPS) go(WIN_STATE);
    });
  };

  bmLoop((t) => {
    // Clamped, and not only for tidiness. `t` is wall clock, so a tab left in
    // the background and come back to hands over a step of whatever the pause
    // was — seconds, sometimes minutes. Unclamped that integrates in one go: the
    // unicorn is flung down the track it never drove along, and the start
    // countdown collapses into a single frame with all four signals firing at
    // once. A twentieth of a second is three frames' worth, so a real stutter
    // still catches up and a suspension does not.
    const elapsed = prev ? Math.min(t - prev, 0.05) : 0;
    prev = t;
    if (SCREEN !== PAUSE_STATE) clock += elapsed;
    // Six times a second is plenty for a question whose answer changes once a
    // minute, and it keeps the copy off most frames entirely.
    //
    // No state test here — peek() has its own, and it allows the grid as well as
    // the race. This gate used to say RACE_STATE, which made peek()'s FLAG_STATE
    // clause dead code and left the readout showing whatever `place` last held
    // all the way through the countdown: 1ST, for a player sitting at the back
    // of the grid.
    if (TIME > peekAt) {
      peekAt = TIME + 1 / 6;
      peek();
    }
    TIME = clock;

    // The pink card lifts over about a third of a second rather than blinking
    // out, revealing the world that has been rendering behind it all along.
    PINK = SCREEN === TITLE_STATE ? 1 : Math.max(PINK - elapsed * 3, 0);
    flash = Math.max(flash - elapsed, 0);

    // A zero step is the pause. The stage still runs — the camera has to keep
    // answering, since the window can be resized while paused and the aspect
    // ratio is baked into the matrix it builds — but nothing integrates, so the
    // unicorn holds exactly where it was rather than resuming somewhere else.
    // Only RACE_STATE integrates. Every other state holds the field exactly where it
    // is and lets the camera do the moving.
    // The grid integrates too, and has to: the chase camera is an exponential
    // settle on this number, so a zero step would leave it parked out at the
    // carousel instead of flying in to the start line. What holds the field
    // still there is uGo below, on the throttle.
    step[0] = SCREEN === RACE_STATE || SCREEN === FLAG_STATE ? elapsed : 0;
    // Steering and throttle are dead outside the race, so the arrow keys that
    // pick a unicorn on the select screen do not also drive one.
    const driving = SCREEN === RACE_STATE ? 1 : 0;
    // The countdown. Signals are played by number rather than by deadline, so
    // being late plays them late rather than skipping them.
    if (SCREEN === FLAG_STATE) {
      lights += elapsed;
      const due = Math.min(SIGNALS, Math.floor(lights));
      while (rung < due) {
        rung++;
        // Three signals and a fourth beat of nothing. The race song's own
        // opening hit is the start — see src/soundEffects.js.
        if (rung < SIGNALS) playReady();
      }
      if (rung >= SIGNALS) go(RACE_STATE);
    }
    step[1] = driving * (held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'));
    step[2] = driving * (held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'));
    step[3] = canvas.width / canvas.height;
    step[4] = RINGS;
    step[5] = TRACK_WIDTH;
    step[6] = PATTERN;
    step[7] = TIME;
    // The orbiting camera is up for everything before the race; it is also what
    // switches off the road's shadow, since there is no unicorn to cast one.
    step[8] = SCREEN === RACE_STATE || SCREEN === PAUSE_STATE || SCREEN === WIN_STATE || SCREEN === FLAG_STATE ? 0 : 1;
    // Everything holds on the grid until the flag.
    step[9] = SCREEN === FLAG_STATE ? 0 : 1;
    // Constant for the whole race — rolled once at the flag. Sent every frame
    // because the block is written whole, not because it changes.
    step[11] = ROLL;
    step[12] = RING_ROWS;
    bmUniforms(sim, step);
    // Ahead of the draws below, though they were recorded first: bmLoop submits
    // only once this callback returns, so this frame's physics is queued before
    // this frame's rendering and the two never disagree about where anything is.
    bmDispatch(sim, 1);

    u[0] = TIME;
    tu[0] = TIME;
    // The clouds first, into their own quarter-size target, then back to the
    // screen where the sky samples and composites them. Before the road, so the
    // ribbon paints over them and passes overhead on the climb.
    // The field — but only once there is a race. On the title screen the circuit
    // is the subject and ten unicorns stood on the grid are in the way of it, so
    // they are simply not drawn.
    // How many unicorns this state wants: none on the title card, one on the
    // turntable, the whole field in a race.
    // One on the select screen, since that screen shows one: the roster is
    // walked by rewriting the first palette slot rather than by drawing a ring
    // of ten and sliding it.
    const shown = SCREEN === TITLE_STATE ? 0 : SCREEN === SELECT_STATE ? 1 : FIELD;
    // 1.6 on the road, and the roster's own size factor on top of that — see
    // `livery`, which carries it in the palette's spare fourth word. The model
    // is built about the size of a real pony against a 27-wide road, which from
    // a chase camera reads as a toy; twice that read as too much of the frame,
    // and this is the fifth back from it.
    //
    // The select screen is not a scaled version of the same view and does not
    // follow it down: it is a close look at one unicorn rather than a field of
    // them seen from a camera boom, so its number is a framing rather than a
    // size and stays where it is.
    // Slots 2 to 5, not 3 to 6: dropping `uMirror` from the shader closed the
    // gap it left, and these indices are positions in that block rather than
    // names. Nothing warns when they are wrong — the model simply came back at
    // uScale 0, which is to say invisible.
    u[2] = SCREEN === SELECT_STATE ? 2.3 : 1.6;
    u[3] = SCREEN === SELECT_STATE ? 1 : 0;

    bmPassTo();
    bmUniforms(sky, tu);
    bmDraw(sky);
    if (shown) {
      bmUniforms(prog, u);
      bmDraw(prog, shown);
    }
    // The same array, and the same sixteen bytes: the track reads uTime out of
    // the front of it and never looks at the gait behind. Each program owns its
    // uniform buffer, so one write does not reach the other — the camera they
    // share travels the other way, through the state buffer, and never touches
    // the CPU at all.
    bmUniforms(track, tu);
    bmDraw(track);
    bmUniforms(hoops, tu);
    bmDraw(hoops);

    // ── The overlay ─────────────────────────────────────────────────────────
    // Whatever this screen has to say, gathered into the instance buffer and
    // drawn in one go. One draw because a uniform cannot change between two of
    // them inside a pass — see the instance attributes in text.shader.ts.
    let n = 0;
    /** A caption: atlas row, centre y, half-width, fade. Row -1 is the card. */
    const say = (row, y, half, fade) => {
      cells.set([row, y, half, fade], n * 4);
      n++;
    };

    // ── Centring a heading and its line ─────────────────────────────────────
    // Where the heading has to sit for the *pair* to be centred, rather than the
    // heading alone.
    //
    // Putting the heading at zero centres the heading and leaves the line below
    // it hanging off the bottom, so the block reads low — which is what the
    // title, pause and win screens were all doing. What wants to be at the
    // middle of the screen is the midpoint between the top of the heading and
    // the bottom of the line under it.
    //
    // Worked out here rather than written down as a number because it depends on
    // the window: a caption's height is its half-width times the atlas row's
    // proportions times the aspect ratio, so the right offset at one window size
    // is wrong at the next.
    //
    // Five sevenths, because that is how much of a row is ink: a glyph is five
    // pixels in a seven-pixel cell, centred, with the spare above and below
    // holding the plate. The extent to balance is the ink's, not the quad's.
    const tall = (half) => (5 / 7) * half * (ROW_H / CARD_W) * (canvas.width / canvas.height);
    const HEAD_GAP = 0.26;
    const headY = HEAD_GAP / 2 - (tall(EXTRA_LARGE) - tall(MEDIUM)) / 2;
    /** A heading with one line under it, centred as a pair. */
    const heading = (top, under) => {
      say(top, headY, EXTRA_LARGE, 1);
      say(under, headY - HEAD_GAP, MEDIUM, 1);
    };

    // The title's ground goes first so the text lands on top of it. It is drawn
    // over a world that is still being rendered underneath, which is what lets
    // the pink lift off the circuit rather than cut to it.
    if (PINK > 0.002) say(-1, 0, 1, PINK);
    // The HUD, along the top: place at the right, lap at the left. Up from the
    // moment the field lines up and still there when the race is over — both
    // are as worth reading frozen as they are moving.
    //
    // Along the top and not the bottom because of what is behind it: the track
    // fills the lower half of the screen and the sky the upper, so text down
    // there sits on a moving rainbow and text up here sits on black. The
    // readouts were at the bottom for a version and the road washed them out.
    //
    // `SCREEN > SELECT_STATE` and not a list of four, which works only because
    // the race states are numbered above the two menu ones. It is the cheapest
    // test and the most fragile line here; renumber the states and this silently
    // draws a HUD over the title card.
    if (SCREEN > SELECT_STATE) {
      // Two captions for one number: the numeral big, the suffix small and
      // tucked against its shoulder, the way karting games have drawn a
      // position since the arcade. It has to be two — a caption is one quad at
      // one half-width, and one quad cannot hold two sizes.
      // The suffix's y is not the numeral's: they are set so the two *tops*
      // line up, which takes a different centre for each because a caption's
      // height follows its half-width.
      say(PLACE_ROW + place, 0.86, EXTRA_LARGE, 1);
      say(SUFFIX_ROW + Math.min(place, 3), 0.89, SUFFIX, 1);
      // The crossing that starts lap one happens as the grid rolls over the
      // line, so before it there is no lap yet — hence the floor at 1.
      //
      // LARGE and not MEDIUM, and that is forced rather than chosen: a
      // full-width row's ink starts at the quad's left edge, so the leftmost a
      // caption reaches is minus its half-width. MEDIUM only gets to -0.64,
      // which reads as floating rather than as a corner.
      say(LAP_ROW + Math.min(Math.max(DONE[0], 1), LAPS) - 1, 0.89, LARGE, 1);
    }
    if (SCREEN === TITLE_STATE) {
      heading(0, 1);
    } else if (SCREEN === SELECT_STATE) {
      say(2, 0.88, LARGE, 1);
      say(NAME_ROW + PICK, 0.55, EXTRA_LARGE, 1);
      // Level with the unicorn and just outside its neighbours.
      //
      // Its own half-width rather than one of the constants, because an arrow's
      // *position* is its half-width — the ink is at the ends of the row. It
      // scales with the atlas like everything else, so the triangles stay put
      // however long the longest caption gets.
      say(9, 0, 0.78 * TYPE, 1);
      say(3, -0.74, MEDIUM, 1);
      say(4, -0.9, MEDIUM, 1);
    } else if (SCREEN === FLAG_STATE) {
      // Between the two corner readouts rather than over either: thirteen
      // characters at LARGE reach about a quarter of the way out from the
      // middle, and the lap and the place stop at 0.63 and 0.69.
      say(CIRCUIT_ROW + SELECTED_CIRCUIT, 0.88, LARGE, 1);
      // Three, two, one — one glyph a signal, and `rung` is already counting
      // them for the sound. Nothing on the first frame, when `rung` is zero:
      // there is a beat of quiet before the first tone, and a "3" hanging there
      // through it would be a countdown that starts early.
      if (rung) say(COUNT_ROW + rung - 1, 0.2, HUGE, 1);
      say(10, -0.74, MEDIUM, 1);
      say(11, -0.9, MEDIUM, 1);
    } else if (SCREEN === RACE_STATE && flash) {
      // Fading over the last second of the two, which is `min(flash, 1)` and
      // needs no second timer.
      say(COUNT_ROW + 3, 0.2, HUGE, Math.min(flash, 1));
    } else if (SCREEN === PAUSE_STATE) {
      heading(5, 6);
    } else if (SCREEN === WIN_STATE) {
      heading(7, 8);
    }

    if (n) {
      // Written straight into the buffer that already exists. A queue write
      // lands before the pass is submitted, which is exactly the ordering an
      // instanced draw wants and the one a per-draw uniform cannot give.
      bmDevice.queue.writeBuffer(cellBuf, 0, cells, 0, n * 4);
      textU[0] = TIME;
      textU[1] = canvas.width / canvas.height;
      textU[2] = LINES.length;
      textU[3] = ROW_H / CARD_W;
      bmUniforms(text, textU);
      bmDraw(text, n);
    }
  });
});
