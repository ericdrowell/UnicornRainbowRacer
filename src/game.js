// Unicorn Rainbow Racer — js13k 2026.
//
// The unicorn is twelve boxes, built a few lines down: there is no model file
// from the STL by tools/stl2mesh.mjs. This file gives it normals and, more
// interestingly, works out which vertices belong to which leg so the shader can
// run it — the model is a 3D-print solid with no rigging, so the weights have to
// be derived from where each vertex sits rather than read from the file.
//
// Everything here is plain globals, no imports: this file is concatenated with
// the runtime, the compiled shaders and the mesh, and minified as one program.

const canvas = document.querySelector('canvas');

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


/**
 * Who the player rides before anything is chosen — and so which seat the select
 * screen's carousel opens on. First in the roster, because the screen has to
 * open on the top of the list for the arrows to read as moving through it; any
 * other index opens mid-list and looks like the ring has already been turned.
 */
const SELECTED_UNICORN = 0;

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

// The two defaults a roster entry may leave out: the gold every horn is unless
// it says otherwise, and the eye bead. Not pure black — the bead is drawn over
// the hide, and a true zero next to a near-white face reads as a hole punched in
// the head rather than as an eye.
const HORN = [1, 0.83, 0.3];
const EYE = [0.02, 0.02, 0.03];

// Vector difference, used by the road builder and the livery.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ── The unicorn ─────────────────────────────────────────────────────────────
// **There is no model any more.** What stood here was a 3D print: 248 triangles
// of smoothed, skinned mesh in a generated data file, and it cost 972 zipped
// bytes — more than the whole budget was over. Every cheaper way of storing it
// had already been taken (the wings went, 88 triangles; the coordinates went to
// integer twentieths) and what remained was irreducible, because it was the
// shape itself rather than how it was written down.
//
// So the shape went. Twelve boxes cost a few dozen bytes of numbers and build
// themselves. It is a different unicorn and not a worse one — the model this
// replaces was already being read at fifty metres through a rainbow haze, and a
// blocky animal reads *better* at that distance than a smooth one, which is the
// whole reason the genre it is borrowed from looks the way it does.
//
// **The shapes are in src/unicorn.js and that file holds nothing else — no
// comments, no code.** It is the one part of the game shaped by eye rather than
// reasoned about, and tools/editor.html round-trips it: read the file, drag the
// boxes, copy the file back. Anything written in there would be something the
// tool had to preserve and could get wrong, so everything worth saying about
// those numbers is said here instead.
//
// A row of PARTS is two opposite corners and a colour code — 2 is this racer's
// hide, 1 its mane, 3 its horn. Nothing is painted at build time, because one
// vertex buffer serves all ten instances and a colour resolved here would be the
// same colour on every unicorn in the field.
//
// The order is barrel, neck and head, muzzle, two ears, horn, mane, tail; the
// legs come from LEGS, which is four positions sharing LEG_HALF and LEG_TOP.
//
// **Every part sinks into the one it grows from.** Boxes that merely touch put
// two faces in the same plane, and the depth buffer has no way to choose between
// them — a seam that flickers as the camera moves. Overlapping by a few
// hundredths costs nothing and cannot z-fight, which is why the muzzle starts
// inside the skull, the horn and ears below its crown, the tail inside the rump,
// and why LEG_TOP is past BELLY rather than level with it.
//
// A corner of a box, picked out of the eight by three bits: x, then y, then z.
const corner = (b, k) => [b & 1 ? k[3] : k[0], b & 2 ? k[4] : k[1], b & 4 ? k[5] : k[2]];
// The six faces, each as four corners wound counter-clockwise seen from outside
// followed by the direction it faces. The winding is load-bearing — the program
// culls back faces, so a face listed the other way round is a hole in the animal
// rather than a face pointing the wrong way.
const FACES = [
  [0, 4, 6, 2, -1, 0, 0],
  [1, 3, 7, 5, 1, 0, 0],
  [0, 1, 5, 4, 0, -1, 0],
  [2, 6, 7, 3, 0, 1, 0],
  [0, 2, 3, 1, 0, 0, -1],
  [4, 5, 7, 6, 0, 0, 1],
];


const P = [];
const NR = [];
const RT = [];
const SK = [];
const CL = [];

/**
 * One box into the buffers, rooted at a hip if it is a leg.
 *
 * **Flat normals, and that is the look.** The mesh this replaces averaged the
 * normals of every face meeting at a corner, because a faceted 3D print read as
 * a 3D print. A box animal wants the opposite: each face keeps the direction it
 * actually faces, so the corners stay hard and the light steps between panels
 * instead of rolling round them.
 *
 * `aSkin.x` is 1 for a whole leg and 0 for everything else, which is what makes
 * the legs swing rigidly. The mesh needed a gradient there — vertices near the
 * shoulder had to stay welded to the barrel while the hoof swung — and a box
 * leg has no shoulder ring to tear: it is one rigid part pivoting at its top,
 * which is exactly the straight-legged run the reference has.
 */
const put = (k, paint, hip) => {
  const root = hip ? [hip[0], BELLY, hip[1]] : [0, 0, 0];
  for (const f of FACES) {
    const c = [0, 1, 2, 3].map((i) => corner(f[i], k));
    for (const t of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of t) {
        P.push(c[i][0] - root[0], c[i][1] - root[1], c[i][2] - root[2]);
        NR.push(f[4], f[5], f[6]);
        RT.push(root[0], root[1], root[2]);
        SK.push(hip ? 1 : 0, 0, 0.5, 0);
        CL.push(0, 0, 0, paint);
      }
    }
  }
};

for (const part of PARTS) put(part, part[6]);
// The legs last, so their hips are the only roots in the buffer that are not the
// origin — which is what the shader reads to tell one leg from another.
for (const leg of LEGS)
  put([leg[0] - LEG_HALF, 0, leg[1] - LEG_HALF, leg[0] + LEG_HALF, LEG_TOP, leg[1] + LEG_HALF], 2, leg);

const RACERS = [];
const lineUp = (pick) => {
  for (let i = 0; i < FIELD; i++) RACERS[i] = UNICORNS[(pick + i) % FIELD];
};
lineUp(SELECTED_UNICORN);

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
 * The margin every edge-anchored caption keeps off the edge of the picture, as
 * a fraction of the display's width.
 *
 * **A fraction and not a pixel count, because the picture is a fixed shape now.**
 * It used to be sixteen CSS pixels, which is a margin that means one thing on a
 * laptop and another on a phone: the type scales with the display — every size
 * on this screen is a multiple of `CARD_W`, which is a fraction of the width —
 * so a constant pixel margin drifts against the letters it is supposed to frame.
 * Held against the width instead, the whole layout is one drawing scaled to
 * whatever box index.html gives it.
 *
 * 1.1% is what sixteen pixels came to on the window this was drawn at, so the
 * screens look as they did at that size and hold their proportions everywhere
 * else.
 *
 * **Equal on all four sides, which costs an aspect multiply.** NDC is 2 wide and
 * 2 tall whatever shape the viewport is, so the same fraction is a different
 * number of NDC units across than it is down — see PAD_X and PAD_Y below.
 */
const SCREEN_PADDING = 0.011;
// Blank lines between stacked labels, measured using the upper label's plate.
const LABEL_SPACING = 1;
/**
 * What the slowest three rivals' top speed is multiplied by.
 *
 * MAX_HANDICAP is the ceiling on every circuit, and MIN_HANDICAP is the
 * floor under all of them. The nine rivals are split into
 * thirds between the two by physics.shader.ts: three at the ceiling, three
 * here, three half way between. The player is 1 and is not part of the spread.
 */
const MIN_HANDICAP = 0.75;
const MAX_HANDICAP = 1.3;

/**
 * Which one is being raced. Three are planned; this is the first of them.
 *
 * The circuits themselves live in src/circuits.js — they are data, and a
 * thousand coordinates sitting in the middle of this file buries everything
 * around them.
 */
let SELECTED_CIRCUIT = 0;

// The course, as a list of places the road passes through. Built from a seed
// rather than read from a literal — see src/circuits.js — which is why there is
// no unpacking left here: the generator hands back triples in absolute
// coordinates, where the authored file held a flat run of steps that had to be
// summed. Both the unpacking and the running sum went with it.
// **Everything below is rebuilt when the circuit changes, which is why it is a
// function and why these names are declared out here.** It was all module-scope
// `const` when there was one track to race; a series of three means the road,
// its ring table, its grid and the scalars the shaders take as uniforms all
// have to be replaced between races, and a `const` cannot be replaced.
//
// The declarations are separated from the assignments rather than the whole
// block being reindented into the function: the values are built in one long
// dependency order and breaking that order to group the exports would be the
// only real way to get this wrong.
let STAR_SLOTS, TRACK, RINGS, ring, LAP, PATTERN, TP, TE, SLOT_ROWS, TI, PICK_BASE, PICK_SLOTS, TRACK_DATA, RACER_BASE, RACER_SLOTS, PALETTE, GRID;
const lay = () => {
TRACK = circuit(CIRCUITS[SELECTED_CIRCUIT]);

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
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
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

RINGS = CENTRE.length;
ring = (i) => CENTRE[(i + RINGS) % RINGS];

// Central differences, so a ring's tangent is the direction the road is heading
// *through* it rather than the direction of the segment on one side of it.
const TAN = CENTRE.map((_, i) => norm(sub(ring(i + 1), ring(i - 1))));

// Distance travelled to each ring, and the length of the whole lap. Measured
// along the resampled polyline, which is the same thing the ribbon is built
// from — deriving it from the control points instead would drift short on
// corners, where the spline bulges out past the chord.
const ALONG = [0];
for (let i = 1; i < RINGS; i++) ALONG.push(ALONG[i - 1] + dist(ring(i), ring(i - 1)));
LAP = ALONG[RINGS - 1] + dist(ring(0), ring(RINGS - 1));


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
PATTERN = (WAVES * 2 * Math.PI) / (0.7 * LAP);

// Two vertices per ring, left edge then right. The ring at the start is emitted
// a second time at the end, carrying a full lap's distance instead of zero:
// closing the strip by wrapping the indices back to ring 0 would leave the last
// quad interpolating the distance from LAP down to 0, cramming the entire
// pattern into two metres of road.
TP = [];
TE = [];
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

// ── Where the pickups are ──────────────────────────────────────────────────
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
// **One table, and rings and stars are both rows in it.** They were two grids
// with two tables, two seat constants, two hitboxes and two mesh loops, and the
// only thing that made them two was that they wanted different spacings. But a
// slot is a piece of road with something on it, and what that something *is* is
// a number in the row — so the row carries it, and every stage downstream reads
// one table and branches on `.y`.
//
// A row is: `.x` the lane, 0 left, 1 middle, 2 right and 3 for nothing here;
// `.y` the type, 0 a ring and 1 a star; `.z` the time a star was collected,
// nought until it is. `.w` is spare.
//
// Sixteen rows to a slot, and four slots is the 64 rows a ring has always had —
// so rings sit on every fourth slot at exactly the spacing they used to, and the
// three slots between two rings are where a run of stars goes. The grid got
// finer; the rings did not move.
//
// Seeded from the circuit, so a track's pickups are as fixed as its corners.
SLOT_ROWS = 16;
/** Slots between one ring and the next — four, which is the 64 rows they had. */
const RING_EVERY = 4;
const START_CLEAR = 8;
PICK_SLOTS = Math.ceil((LAP * PATTERN * 0.4456) / SLOT_ROWS);
const PICK_LANE = new Float32Array(PICK_SLOTS);
const PICK_TYPE = new Float32Array(PICK_SLOTS);
{
  const rnd = seeded((TRACK.b * 1e6) | 0);
  // Nothing anywhere until something is put there. 3 is the empty lane, and it
  // is what both ends of the lap keep: the grid stands behind the start line, so
  // a pickup in the last slots sits among ten stationary unicorns before the
  // flag has dropped.
  PICK_LANE.fill(3);
  // Rings, on every fourth slot, three slots in four filled — the fourth
  // outcome of the roll is "no ring", which is what scatters them.
  for (let i = START_CLEAR; i < PICK_SLOTS - START_CLEAR; i += RING_EVERY) {
    PICK_LANE[i] = Math.floor(rnd() * 4);
  }
  // **Ten runs of four, and front-loaded.** A star is never on its own: each
  // placement lays four of them in consecutive slots, all in the same lane, so
  // what the player sees ahead is a *line* to be followed rather than a thing to
  // be swerved at. Four arrive in a little over a second at racing speed, which
  // is the point — the reward for committing to a lane and holding it is four
  // tenths of the gauge in one move, and the cost of drifting off the line
  // halfway is that you get two.
  //
  // The lane is drawn once for the whole run and not per star. A run that
  // wandered across the road would be three separate pickups wearing a trail's
  // clothing, and following it would mean weaving — which is the opposite of the
  // line this is meant to be.
  //
  // Forty stars against a gauge of ten: two and a half clean runs arms it, so a
  // third run is already slack, and a lap has enough left over that missing one
  // is not the end of it.
  //
  // Raising the fraction along the lap to the power 2.2 is what bunches them:
  // half sit in the opening quarter and the rest string out behind, so the
  // player arms early and then has to make what they took last the circuit.
  //
  // **Snapped to the slot after a ring, which is what keeps a run whole.** Every
  // fourth slot belongs to a ring, so a run starting anywhere else would have a
  // ring in the middle of it — one star, a ring, two stars, which is not a line
  // to follow. Landing on residue 1 puts the run in the three slots between two
  // rings and then one more, and `tail` starting at a residue 1 keeps the clamp
  // on that residue too.
  //
  // **A run of four reaches one slot past the gap, and takes that ring's place.**
  // Three fitted exactly; the fourth lands on residue 0, so it overwrites the
  // ring that would have sat there rather than sitting beside it. That keeps the
  // line unbroken, which is the invariant that matters — a run is still four
  // stars with nothing between them — and it costs the lap up to ten ring slots,
  // nearer seven or eight in practice since a quarter of them roll empty anyway.
  // `tail` still advances by RING_EVERY, so the next run cannot overlap it.
  let tail = START_CLEAR + 1;
  for (let k = 1; k <= 10; k++) {
    const want = Math.min(
      Math.floor((PICK_SLOTS - 24) * (k / 10) ** 2.2),
      PICK_SLOTS - 12,
    );
    const at = Math.max(Math.floor(want / RING_EVERY) * RING_EVERY + 1, tail);
    const lane = Math.floor(rnd() * 3);
    for (let j = 0; j < 4; j++) {
      PICK_LANE[at + j] = lane;
      PICK_TYPE[at + j] = 1;
    }
    // The next run starts no earlier than the next group of four, which is both
    // what stops two overlapping and what keeps the residue.
    tail = at + RING_EVERY;
  }
}

// Two triangles per quad. bmIndex draws uint16, so the track has a ceiling of
// 32k rings — about 65 km of road at this spacing.
TI = [];
for (let i = 0; i < RINGS; i++) {
  const a = i * 2;
  const b = a + 2;
  TI.push(a, b, a + 1, a + 1, b, b + 1);
}

// **An actual torus apiece, and an actual star.** Both are swept in the vertex
// stage from two numbers that run 0 to 1 — `u / uN` round the thing and
// `v / vN` across it — so what is emitted here is a grid of parameters and not
// a shape. track.shader.ts decides what the shape is, off the type in the
// table, and this only has to say how finely to divide it.
//
// **One loop, because a pickup is a pickup.** It was two, one per grid, with the
// same eight lines of index arithmetic written out twice. What differs between a
// ring and a star is two counts, and two counts is what `uN` and `vN` are.
//
// A ring is 24 round by 10 across: segments are free — nothing is stored, it is
// swept from these two numbers — and 24 is a silhouette with no corners in it at
// the size these are read at, while 10 across the tube makes the light sweep
// rather than facet.
//
// A star is 8 by 8, and it is a sphere: the shader draws it as this same torus
// with the major radius at nought, which sweeps `rad * cos(ph) + tng * sin(ph)`
// — a unit vector — right round twice. Double-covered, so 8 by 8 is really a
// 16-gon of latitude, and coincident opaque triangles at identical depth cost a
// few vertices and change nothing on screen.
//
// The marker is 9 for both. It says "this is a pickup, so `aPos` is a slot and
// two angles rather than a position" — nothing more, because which pickup it is
// comes from the table now.
for (let i = 0; i < PICK_SLOTS; i++) {
  if (PICK_LANE[i] > 2 || PICK_TYPE[i]) continue;
  // **Ten round, for both, and offset half a step.** The pickup is a
  // five-pointed star — track.shader.ts swings its radius in and out five times
  // round the sweep — so it has ten corners and needs ten divisions. But a
  // corner has to *land* on a vertex or the sweep cuts it off, and at `u / uN`
  // every vertex sits exactly between two: the swing is `sin(5 * th)`, and at
  // `th = 2piu / 10` that is `sin(pi u)`, which is nought every time. Half a
  // step over and every vertex is a corner instead, alternating point and
  // valley. The seam still closes — `u` runs to `uN`, so the last angle is the
  // first plus a full turn.
  //
  // The ring is the same sweep with the swing switched off, which makes it a
  // ten-sided ring, which at the size a ring is read at is a circle. Ten and not
  // the twenty-four it used to be: the divisions are shared with the pickup, and
  // nothing here is stored, so the count is a single number for both.
  const uN = 64;
  const vN = 16;
  const base = TP.length / 3;
  for (let u = 0; u <= uN; u++) {
    for (let v = 0; v <= vN; v++) {
      TP.push(i, (u + 0.5) / uN, v / vN);
      TE.push(9, 0);
    }
  }
  for (let u = 0; u < uN; u++) {
    for (let v = 0; v < vN; v++) {
      const a = base + u * (vN + 1) + v;
      TI.push(a, a + vN + 1, a + 1, a + 1, a + vN + 1, a + vN + 2);
    }
  }
}

// A film: a fan from the middle out to the tube's inner edge, filling a ring's
// hole. `aEdge.y` carries it rather than a third marker value, because it is the
// one component of that attribute a swept vertex was not already using — and it
// leaves `aEdge.x` meaning exactly one thing, which pickup or gate this is.
//
// `aPos.z` stops being an angle here and becomes the fraction of the way out
// from the middle. That is free: it only ever reaches the sweep as `cos` and
// `sin` of a whole turn, so at 0 and 1 both come back the same and the film's
// own radius is what the shader reads instead.
// **The finish gate: one ring the size of the road, at ring zero.** A lap ends
// on a line painted across the ribbon, which is a thing you are on top of before
// you can see it. An arch is visible from the far side of the circuit, so the
// end of a lap becomes something to drive *at* rather than something you are
// told about afterwards.
//
// It rides the pickup sweep rather than a shape of its own — same vertex format,
// same program, same torus in track.shader.ts — and the only thing that marks it
// out is an 8 in the edge attribute where a pickup carries 9. Both are past the
// 4 that separates road vertices from swept ones, so the whole path down to the
// fragment stage is shared; the shader reads the 8 and swaps three numbers.
//
// `aPos.x` is 0 rather than a slot: the shader zeroes the ring index for the
// gate, so it stands at the start line whatever the table's first row happens to
// say, and it never consults the lane or the type.
//
// **Ten round, the same as a boost ring**, so the gate is recognisably the same
// object at a different size rather than a smoother thing that happens to sit at
// the start line. The flats are long at sixteen metres of radius, and that is
// the point: a decagon has corners, and corners are what make the rotation below
// visible. A thirty-two-sided gate was tried first and is a circle — and a
// circle turning about its own axis is a circle, however fast it spins.
{
  const uN = 64;
  const vN = 16;
  const base = TP.length / 3;
  for (let u = 0; u <= uN; u++) {
    for (let v = 0; v <= vN; v++) {
      TP.push(0, u / uN, v / vN);
      TE.push(8, 0);
    }
  }
  for (let u = 0; u < uN; u++) {
    for (let v = 0; v < vN; v++) {
      const a = base + u * (vN + 1) + v;
      TI.push(a, a + vN + 1, a + 1, a + 1, a + vN + 1, a + vN + 2);
    }
  }
}

// Point lights draw in GPU-sorted order, one quad per star.
STAR_SLOTS = [];
for (let i = 0; i < PICK_SLOTS; i++) {
  if (PICK_LANE[i] > 2 || !PICK_TYPE[i]) continue;
  const base = TP.length / 3;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    TP.push(STAR_SLOTS.length / 4, x, y);
    TE.push(10, 0);
  }
  TI.push(base, base + 1, base + 2, base, base + 2, base + 3);
  STAR_SLOTS.push(i, 0, 0, 0);
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
// The pickup table is appended after it, one vec4 a slot: lane, type, and the
// time a star was collected. A whole vec4 to carry three numbers is wasteful of
// GPU memory and free in the zip — this array is generated, not shipped — and it
// means every reader indexes it with a slot number and nothing else.
//
// Four slots longer than there are, because the AI reads the ring ahead of the
// one it is in and the last racer on the last slot reads past the end. Four
// zeroed vec4s is cheaper than a clamp in the shader — though a zero row reads
// as lane 0, which is a lane, so the placement above leaves the closing slots
// empty and the read never lands on one that matters.
PICK_BASE = (RINGS + 1) * 3;
TRACK_DATA = new Float32Array((PICK_BASE + PICK_SLOTS + 4) * 4);
for (let i = 0; i <= RINGS; i++) {
  const g = i % RINGS;
  TRACK_DATA.set(
    [...CENTRE[g], i < RINGS ? ALONG[i] : LAP, ...TAN[g], 0, ...UPF[g], 0],
    i * 12,
  );
}
for (let i = 0; i < PICK_SLOTS; i++) {
  TRACK_DATA[(PICK_BASE + i) * 4] = PICK_LANE[i];
  TRACK_DATA[(PICK_BASE + i) * 4 + 1] = PICK_TYPE[i];
}

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
// **Indexed by slot and not by racer.** Which unicorn stands on which of these
// is ORDER's business, and it changes between circuits — this is the shape of
// the grid, not the seating plan.
//
// Only the position is seeded. Heading and course are left at zero, which the
// physics stage already treats as "not yet placed" and fills from the tangent
// under the body — the same path a respawn takes, so there is one piece of code
// deciding which way a unicorn faces and not two that can disagree.
RACER_BASE = 16;
// Six, not five: the sixth carries how much boost a racer has left. Every word
// of the other five was spoken for — the spare quarter of each was already
// holding vy, speed, gait, the lit-panel coordinate and the lap distance the
// CPU reads back — and a timer is the one thing a boost pad needs that cannot be
// recomputed from where a unicorn is.
// Seven. Six are the racer; the seventh is everything star-shaped, and it is
// one word rather than two because all of it fits: `.x` is the slot last picked
// up, so one star counts once rather than once a frame while the body is over
// it, `.z` is the run's clock — 6.4 seconds counting down, read by the physics
// for the speed, by the unicorn shader for the flashing, by the sky for the warp
// streaks and by the CPU for the HUD — and `.w` is the rainbow phase the run has
// banked.
//
// It was eight for a while, with the slot memory in a word of its own next to a
// blast that needed all four of its own. The blast went with the shooting and
// the memory moved into the spare `.x` beside the clock.
//
// Written down again in physics.shader.ts as SLOTS and in unicorn.shader.ts,
// neither of which can read this file. PALETTE below depends on it.
RACER_SLOTS = 7;
/** Where the liveries start, six vec4s per racer. */
// **86, and the racer stride is why.** The racers start at 16 and run
// RACER_SLOTS each, so ten of them at seven apiece reach 86. Leave this below
// that and the last racers write their state over the first liveries — which
// shows up as the field coming out the wrong colours, not as a crash.
//
// It sat at 96 through the stride being eight and then being seven, which was
// ten vec4s of buffer nothing addressed. Harmless, and exactly the kind of
// harmless that survives until someone reads 96 as meaningful.
//
// Written down again in unicorn.shader.ts, which cannot read this file.
PALETTE = 86;

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
GRID = [];
for (let i = 0; i < FIELD; i++) {
  // Four metres a row. Tight, and it can be: the whole field is staggered, so
  // the nearest other racer is always a lane over as well as a row up, and the
  // physics only pushes two apart inside 2.4.
  const g = ringAt(LAP - (6 + i * 4));
  const arm = SIDEF[g];
  // Three lanes at a little under a third of the width apart, which leaves
  // about five metres from the outer lanes to the rails.
  //
  // `1 - lane` rather than `lane - 1`, so the stagger runs right to left going
  // back: the leader sits on the right of the front row and the player on the
  // right of the back one. Both ends of the field on the same side is what makes
  // the diagonal read as one line rather than as scattered rows, and it is the
  // player's own lane that tells them which way the lattice leans.
  const lat = (1 - (i % LANES)) * TRACK_WIDTH * 0.3;
  // Four floats, not three: the ring this slot stands on rides along as `.w` of
  // the same word the position goes into. The physics searches for its segment
  // in a window around the ring it was on last frame, and on the very first
  // frame there is no last frame — the grid sits in the closing forty metres of
  // the lap, which is twenty rings from the nought a cleared buffer would give
  // it, so it would start the race hunting near the wrong end of the road.
  GRID.push([...CENTRE[g].map((c, k) => c + arm[k] * lat), g]);
}
};
lay();

// ── Driving ─────────────────────────────────────────────────────────────────
// Keys are the one thing the GPU cannot read, so this is all the CPU still owns
// of the simulation: which keys are down, and a latch for the one that is an
// event rather than a state.
const HELD = {};
// Each direction accepts either key without doubling steering when both are held.
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
// Offset only the selection orbit: 5 seconds places it at 1.5 radians.
let selectOrbit = 0;

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
//   FINISH_STATE     the race over, and the same.
//
// Every transition goes through `go`, which is what keeps the music honest:
// each state names its own song, and the one place that changes state is the
// one place that has to ask for it.
const TITLE_STATE = 0;
const SELECT_STATE = 1;
const RACE_STATE = 2;
const PAUSE_STATE = 3;
const FINISH_STATE = 4;
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
let titleSince = 0;

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

/**
 * How far round the lap each racer is, and how many times each has crossed the
 * line. Read back from the GPU as frames become available; see `peek` below.
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
 * Every racer's finishing positions, added up over the circuits raced so far.
 *
 * **Low is good, and that is the whole scoring system.** A win is 1 and last is
 * 10, so a series total is a golf score: three circuits give a best of 3 and a
 * worst of 30, and coming second everywhere beats winning once and trailing
 * twice. No points table, which is a table this game would have to bake into
 * the atlas as its own captions to ever show.
 *
 * Indexed by *racer slot*, not by unicorn: slot 0 is always the player. The
 * roster is `lineUp`'s rotation of UNICORNS by PICK, so the unicorn in slot `i`
 * is `(PICK + i) % FIELD` — which is how the standings find a name row.
 */
const TALLY = new Float32Array(FIELD);
/**
 * Racer slots, best total first — the standings as they are drawn.
 *
 * Worked out once when the race ends rather than per frame: the win screen is
 * static, and sorting ten things sixty times a second to get the same answer is
 * work nobody asked for.
 */
let STANDINGS = [];
/**
 * Which racer stands on which grid slot, front to back.
 *
 * **Last race's finishing order is this race's grid**, which is the one piece of
 * state a series has beyond its totals. Win a circuit and the next one starts
 * from pole; come ninth and there is one unicorn in front of you to hunt. It is
 * also what stops four circuits being four runs of the same race: the field the
 * player drives through is a different field each time, arranged by what they
 * did about it last.
 *
 * `(i + 1) % FIELD` is the opening grid, and it says two things at once — the AI
 * fill the rows in front in roster order, and racer 0 wraps to the back. The
 * player starts a series last because a race you start in front of is a time
 * trial with scenery, and the whole reason for nine of them is to have something
 * to overtake.
 *
 * Racer slots, like TALLY and STANDINGS. Handicaps are not in here and must not
 * be: a unicorn's pace is keyed on its own index in the physics stage, so it
 * travels with the unicorn while the grid moves underneath.
 */
const GRID1 = TALLY.map((_, i) => (i + 1) % FIELD);
let ORDER = GRID1;
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
 * gets is the lap readback, which already copies every racer's block during the race with the clock inside it. So the cue is triggered by watching a number
 * rather than by watching the road.
 *
 * Racer zero's, and no one else's. This was field-wide with a distance falloff,
 * on the theory that a ring taken up ahead told you the field was using them —
 * what it actually did was turn a cue into weather. Both of the player's cues
 * are now the player's alone.
 */
let wasBoost = 0;
let boostImpact = -1;
let warpUntil = 0;
/** Stars in racer zero's pocket, as of the last readback — the HUD's only source. */
let starsHeld = 0;
/**
 * Seconds of star power left on racer zero's clock, as of the last readback.
 *
 * Read rather than counted here. The shader owns the clock — it is the thing
 * that decided to start it, on the frame the fourth star was collected — and a
 * second countdown on the CPU would drift against it and disagree about when
 * the HUD should stop saying so.
 */
let starLeft = 0;
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
  paint.set([...r.body, !r.mane]);
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
    bmDevice.queue.writeBuffer(STATE, (RACER_BASE + ORDER[i] * RACER_SLOTS) * 16, block);
  }
}

/**
 * End every racer's star power, now, whoever is holding it.
 *
 * **The clock is GPU state, and GPU state outlives the race.** It counts down
 * inside the physics off `uDt`, and `uDt` is zero unless the game is racing —
 * so crossing the line mid-run does not finish the run, it *freezes* it. The
 * word sits there at whatever it held, and every shader that reads it goes on
 * believing star power is up: the carousel on the select screen drew the whole
 * roster flashing, because that is exactly what the state said.
 *
 * `resetGrid` already zeroes this along with everything else, but it runs on the
 * way into the grid — which is one screen too late to stop the select screen in
 * front of it being wrong.
 *
 * One word a racer rather than the whole block: this has to be able to run at
 * the finish, where the bodies are mid-race and must not be teleported back onto
 * the start line.
 *
 * **And one *component* of that word, not all four.** `.z` is the clock and is
 * what has to stop; `.w` beside it is how much rainbow phase star power has
 * banked, and that one only ever climbs — zeroing it would snap the road's
 * gradient back by however far the run had pushed it, right as the player
 * crosses the line. Hence the `+ 8`: `.z` is the third float of the vec4, two
 * floats in.
 */
function clearStars() {
  const z = new Float32Array(1);
  for (let i = 0; i < FIELD; i++) {
    bmDevice.queue.writeBuffer(STATE, (RACER_BASE + i * RACER_SLOTS + 6) * 16 + 8, z);
  }
}

function go(next) {
  // **The click that says a screen changed, decided here rather than at each
  // caller.** Every route between screens runs through this function — the key
  // presses, the countdown reaching nought, the last racer crossing the line —
  // so this is the one place that sees all of them, and separate call sites
  // cannot drift out of agreement about which ones speak.
  //
  // **One destination speaks, and it is the grid.** This used to be a list of
  // the screens that stay quiet, which is the wrong shape for the rule: a
  // blacklist says yes to every arrival nobody has thought about yet, so each
  // new screen is silently opted into a flourish and the way you find out is by
  // hearing it. Naming the one arrival that earns the sound puts the default the
  // other way round.
  //
  // The grid earns it because it is the only transition that *commits* to
  // something. Picking a unicorn is browsing — the carousel turns under the
  // roster whether or not you settle on one — and going back to the title is
  // leaving; neither is a decision the game should congratulate. Walking out to
  // the start line is, and the sound is the last thing heard before the
  // countdown takes over.
  //
  // Every other arrival was already silent and stays that way for its own
  // reasons: into the race, where the countdown's three tones and the race
  // song's opening hit are landing on that frame and a fourth is one too many;
  // into a pause, which is not a change of scene but the same scene held, and
  // chiming there makes stopping an event; onto the standings, which arrive on
  // their own the moment the last racer crosses, where nobody pressed anything
  // and a flourish would land on top of whatever the finish is still ringing.
  //
  // It borrows the pickup's own flourish rather than adding a sound: already
  // rendered, already familiar, and the one thing in the game that means
  // something good just happened.
  //
  // `powerUp` and not `playStar` — the triad, not one note of it. A single note
  // is the *ingredient*, and on its own it reads as a click rather than as the
  // sound a player already knows; what they recognise is the three of them
  // climbing. It costs nothing extra either, being the same one buffer resampled
  // twice on a pair of timers.
  if (next === FLAG_STATE) powerUp();
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
  // **Crossing the line ends a run, and this is the only place that can say so.**
  // FINISH_STATE is the one way out of a race — a pause goes back to it, and star
  // power surviving a pause is right — so clearing here covers every exit
  // without touching the one state that should hold. `starLeft` goes with it:
  // the readback stops running the moment the racing does, so it would otherwise
  // keep the CPU's copy of a clock that no longer exists.
  if (next === FINISH_STATE) {
    clearStars();
    starLeft = 0;
    // **The order they were in when the player crossed is the finishing order.**
    // The race ends on the player's last lap — the field is still driving — so
    // there is no later moment to ask, and how far each of them has come is
    // exactly what decides it: laps completed times the lap, plus the distance
    // round this one.
    //
    // Positions are added to the running total, so the standings are over the
    // series and not over this circuit. A racer's own total is all that is kept;
    // where they came in each individual race is not something the game ever
    // shows again.
    ORDER = [...TALLY.keys()].sort(
      (a, b) => DONE[b] * LAP + ROUND[b] - (DONE[a] * LAP + ROUND[a]),
    );
    ORDER.forEach((r, i) => (TALLY[r] += i + 1));
    // And the leaderboard is that again by the totals, which is what it lists.
    // Ties fall to whoever finished this race higher, since sort is stable and
    // the array it copies is already in this circuit's finishing order.
    //
    // A copy, because ORDER outlives this screen: it is the next circuit's grid.
    STANDINGS = [...ORDER].sort((a, b) => TALLY[a] - TALLY[b]);
  }
  // The palettes are shared between the carousel and the grid, so they are
  // rewritten on the way into each.
  if (next === SELECT_STATE) {
    PICK = SELECTED_UNICORN;
    selectOrbit = TIME - 5;
    showPick();
  }
  if (next === FLAG_STATE) {
    ROUND.fill(0);
    DONE.fill(0);
    // Circuit one is a new series, however it was reached — off the title, or
    // round again from the end of the last one. Cleared on the way *in* rather
    // than on the way out of the final race, so the last leaderboard is still
    // standing behind the player while they read it.
    //
    // The place readout resets with them, and only with them. Every other
    // circuit inherits the one the last race ended on — which is the player's
    // finishing position, which is now the slot they are standing in. The
    // next readback overwrites it either way; this is what
    // the countdown reads until then.
    if (!SELECTED_CIRCUIT) {
      TALLY.fill(0);
      ORDER = GRID1;
      place = FIELD - 1;
    }
    ROLL = Math.random();
    lights = 0;
    rung = 0;
    lineUp(PICK);
    dress(RACERS);
  }
  // Selection needs the grid too: restore the orbit centre after a series.
  if (next === SELECT_STATE || next === FLAG_STATE) resetGrid();
  if (next === TITLE_STATE) titleSince = TIME;
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
const playSelectNext = shot(UNICORN_SELECT_NEXT_SOUND);
const playSelectPrev = shot(UNICORN_SELECT_PREV_SOUND);
const playReady = shot(READY_SIGNAL_SOUND, 2);
const playBoost = shot(BOOST_SOUND, 3);
const playMistake = shot(MISTAKE_SOUND, 2);
const playStar = shot(STAR_SOUND, 2);
/**
 * Root, major third, fifth, seventy milliseconds apart — the arcade's own
 * "you got something" and cheaper than a second instrument, since all three are
 * the one buffer resampled. See `shot`.
 */
const powerUp = () => {
  playStar();
  setTimeout(() => playStar(2, 1.26), 70);
  setTimeout(() => playStar(2, 1.5), 140);
};

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
  const enter = e.code === 'Enter';
  if (SCREEN === TITLE_STATE) {
    if (enter) go(SELECT_STATE);
    return;
  }
  if (SCREEN === SELECT_STATE) {
    // Wrapped both ways, so the roster is a carousel rather than a list with
    // ends to bump into.
    const step = /^(ArrowRight|KeyD)$/.test(e.code) - /^(ArrowLeft|KeyA)$/.test(e.code);
    if (step) {
      // The winding moves by one whatever happens; the index wraps. That is what
      // makes the ring turn the short way round the ends.
      PICK = (PICK + step + UNICORNS.length) % UNICORNS.length;
      // Up for forward, down for back.
      (step > 0 ? playSelectNext : playSelectPrev)();
      showPick();
    }
    if (enter || e.code === 'Space') go(FLAG_STATE);
    return;
  }
  // **Any key leaves a pause, and this is the one screen where that is right.**
  // Everywhere else the game insists on Enter, because everywhere else the key
  // press is a choice being made. A pause is not a choice — it is a player
  // coming back to a race that is sitting still waiting for them — and the
  // worst thing this screen can do is stay up. Escape included: whatever put
  // the pause there takes it away again.
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
  if (SCREEN === FINISH_STATE && enter) {
    // On through the series, or back to the top once it is done — and either way
    // the road is rebuilt, because returning to the title has to put circuit one
    // back under the carousel rather than leaving the last one there.
    const more = SELECTED_CIRCUIT < CIRCUITS.length - 1;
    swap(more ? SELECTED_CIRCUIT + 1 : 0);
    go(more ? FLAG_STATE : TITLE_STATE);
  }
});

// The source that is currently playing, and which song it is playing, so a
// state change that asks for the same music does not restart it. Not TRACK: that
// is the road's centreline, further up this file — everything here shares one
// scope, so a second TRACK is not a shadow, it is a build failure.
let PLAYING = null;
let PLAYING_NAME = null;

function syncMusic() {
  if (!MUSIC_ENABLED) return;
  // **A star run has its own track, and it is the one state the screen alone
  // does not decide.** Everywhere else the music follows the screen; here it
  // follows a clock as well, so the length of a run swaps the race song
  // out for the star song and swap it back when the clock runs down.
  //
  // Gated on RACE_STATE rather than on the clock alone. Pausing mid-run leaves
  // the clock exactly where it was — the physics counts it down and the physics
  // is stopped — so without the gate a paused game would sit there playing the
  // star track with nothing happening.
  const want = SCREEN === RACE_STATE && starLeft ? 'star' : SCORE[SCREEN];
  // Already playing the right thing. **This test is the whole reason pausing
  // does not restart the menu music**: PAUSE_STATE and SELECT_STATE and FINISH_STATE all ask for the
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
 * scheduler actually runs at: the build rounds `bpm` from rowLen as sonant-x does, so
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
  // The build caps the pattern count and rounds the tempo from the export.
  const loop = ((song.endPattern + 1) * 480) / song.bpm;
  const rate = MUSIC.sampleRate;
  const len = Math.round(loop * rate);
  return renderSong(MUSIC, song, len * 2).then((raw) => {
    const buffer = MUSIC.createBuffer(2, len, rate);
    // **Scaled to fit, because nothing downstream does it.** renderSong sums the
    // tracks raw — each folds to plus or minus one of its own and five of them
    // land on top of each other — so a busy song comes back well past full
    // scale. The star track peaks near 2.9 and spends six per cent of itself
    // outside the range. Web Audio does not wrap that the way the synth's own
    // 16-bit fold does; it hard-clips at the device, and that is the tearing.
    //
    // **SoundBox's own player never shows this**, which is what makes it look
    // like a bug in the song rather than in the playback: that player puts a
    // gain of its own between the mix and the speakers. This is that gain,
    // measured per song rather than guessed.
    //
    // `peak` starts at 1, so a song that already fits is divided by one and
    // keeps exactly the level it was written at — only the ones that overflow
    // are touched, and they are turned down by just enough.
    //
    // One factor across both channels: scaling them apart would swing the stereo
    // image, and it is the mix that is too loud, not one side of it.
    let peak = 1;
    for (let ch = 0; ch < 2; ch++) {
      for (const v of raw.getChannelData(ch).subarray(len)) {
        peak = Math.max(peak, v, -v);
      }
    }
    for (let ch = 0; ch < 2; ch++) {
      const src = raw.getChannelData(ch).subarray(len);
      buffer.getChannelData(ch).set(src.map((v) => v / peak));
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
  renderLoop(MENU_SONG, 'menu')
    .then(() => renderLoop(RACE_SONG, 'race'))
    .then(() => renderLoop(STAR_SONG, 'star'));


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
// The four the swap between circuits has to re-point at a new road. Out here
// rather than inside the setup closure for that reason alone.
let sim, track, rings;
const programFor = (shader, options = {}) => bmProgram(shader[0], {
  a: shader[1], i: shader[2], u: shader[3], t: shader[4], s: shader[5], ...options
});

function uploadTrack() {
  const order = new Float32Array(STAR_SLOTS);
  // Slot 146 follows all ten liveries; the shaders share this layout.
  bmDevice.queue.writeBuffer(STATE, (PALETTE + FIELD * 6) * 16, order);
  bmStorages(sim, STATE, rings);
  bmAttr(track, 0, new Float32Array(TP));
  bmAttr(track, 1, new Float32Array(TE));
  bmIndex(track, new Uint16Array(TI));
  bmStorages(track, STATE, rings);
}

/**
 * Move the series on to circuit `i` and rebuild everything that was the old one.
 *
 * **A new buffer rather than a rewrite, because the size changes.** Circuits
 * differ in length, so they differ in ring count, so the ribbon, its index list
 * and its track record are all a different shape — there is nothing to write
 * over. `lay()` rebuilds the arrays and this hands the new ones to the two
 * programs that read them.
 *
 * The grid is reset on entry to the flag or selection screen. Both use the
 * new `GRID`, including selection after returning from a completed series.
 */
function swap(i) {
  SELECTED_CIRCUIT = i;
  lay();
  rings = bmStore(TRACK_DATA);
  uploadTrack();
}

bmInit(canvas, [0.02, 0.02, 0.05, 0]).then(() => {
  // Sixteen vec4 slots of player and camera, five each per racer from slot 16,
  // and six each of livery from slot 80. The first sixteen keep their old
  // meanings so the road's shadow, the minimap and the debug build go on reading
  // slot 0 for "where is the unicorn the camera is watching".
  //
  // Slots 13 and 14 are spare. They used to hold a falling star's arc and had to
  // be seeded with unit vectors, because the sky normalised them every frame and
  // normalising a zero vector is NaN rather than zero.
  const state = new Float32Array((PALETTE + FIELD * 6) * 4 + STAR_SLOTS.length);
  // The grid. Position only: everything else is zero, which every field here is
  // genuinely starting at — and a zero course is what tells the physics stage to
  // point each unicorn down the road it finds itself on.
  for (let i = 0; i < FIELD; i++) {
    state.set(GRID[i], (RACER_BASE + ORDER[i] * RACER_SLOTS) * 4);
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
  rings = bmStore(TRACK_DATA);

  // The simulation. One workgroup of one, dispatched once a frame: there is a
  // single unicorn and nothing here is parallel. It is on the GPU so that the
  // answer never has to come back — see physics.shader.ts.
  sim = bmCompute(Physics[0], { u: Physics[3], s: Physics[5] });

  // ── The field, as instance data ─────────────────────────────────────────
  // One buffer, one float: which racer each instance is. WebGPU guarantees only
  // eight vertex buffers and the mesh already spends five, so the colours go
  // through the state buffer instead — see PALETTE above. Asking for five
  // instance buffers was ten in total, which is a validation error and a black
  // screen rather than a slow frame.
  const IX = new Float32Array(FIELD).map((_, i) => i);
  /** The one instance buffer sits after the five per-vertex ones. */
  const herd = (p) => bmAttr(p, 5, IX);

  const prog = programFor(Unicorn, { cull: 1 });
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
  // Opaque geometry draws first; the two-sided films blend over it separately.
  track = programFor(Track, { blend: 1 });
  uploadTrack();

  // The sky. One triangle big enough to cover the screen — the corners run to 3
  // rather than 1 so a single one spans the viewport with the excess clipped
  // away, which is a vertex and an edge cheaper than a quad and has no diagonal
  // through the middle for the rasteriser to seam on.
  //
  // `zwrite: 0` and drawn before everything else: it fills the frame with sky,
  // leaves the depth buffer as it found it, and the road and the unicorn then
  // paint over it wherever they are.
  const su = new Float32Array(Sky[3] / 4);
  const sky = programFor(Sky, { zwrite: 0 });

  // The warp, from the same shader over the same triangle — the pipeline differs
  // in a blend and nothing else does. Drawn last so it lands over the road, and
  // gated on a clock so this second full-screen pass only runs in the second
  // after a ring rather than every frame of every race.
  const warp = programFor(Sky, { zwrite: 0, blend: 1 });
  for (const p of [sky, warp]) {
    bmAttr(p, 0, new Float32Array([-1, -1, 3, -1, -1, 3]));
    bmIndex(p, new Uint16Array([0, 1, 2]));
    bmStorages(p, STATE);
  }

  // Logical atlas cells keep menu and HUD alignment consistent. Browser glyphs
  // are rasterized at 16x resolution below for smooth rounded lettering.
  const CELL = 4;
  const ROW_H = 12;
  const CARD_W = WIDE * CELL + 2;

  const TYPE = CARD_W / 116;
  // Five shared text sizes, relative to the logical atlas scale.
  const FONT_S = 0.42 * TYPE;
  const FONT_M = 0.62 * TYPE;
  const FONT_L = TYPE;
  const FONT_XL = 1.25 * TYPE;
  const FONT_XXL = 1.6 * TYPE;

  // Fixed 16:9 layout, computed once. Atlas proportions still determine glyph
  // sizes, but resizing the window only scales the complete picture.
  const tall = (half) => 5 * half / CARD_W * (16 / 9);
  const plate = (half) => 7 * half / CARD_W * (16 / 9);
  const PAD_X = 2 * SCREEN_PADDING;
  const PAD_Y = PAD_X * (16 / 9);
  const HUD_BOT = PAD_Y - 1;
  const HUD_TOP = 1 - PAD_Y;
  // Centre-to-centre distance: both half-heights plus a full upper line.
  const HEAD_GAP = plate(FONT_L * (1 + 2 * LABEL_SPACING) + FONT_S);
  const headY = plate(FONT_L * LABEL_SPACING + FONT_S);
  const hint = HUD_BOT + ROW_H * FONT_S / CARD_W * (16 / 9);
  const HINT_GAP = plate(FONT_S * (2 + 2 * LABEL_SPACING));
  const pitch = plate(FONT_M) * 1.8;
  const headingInset = (ROW_H - 7) * FONT_M / CARD_W * (16 / 9);
  const nameY = HUD_TOP - plate(FONT_M * (2 + 2 * LABEL_SPACING) + FONT_L);
  const SELECT_Y = (nameY + HUD_BOT + HINT_GAP + plate(2 * FONT_S - FONT_L)) / 2 - 0.08;


  // **Every row below is counted back from the names, and the counts are the
  // block that sits in front of them.** src/text.js ends with, in order: ten
  // place numerals, four suffixes, the standings' star, the ten centred names
  // and the ten padded ones. So the names start twenty from the end, and each
  // constant here is how many rows lie between its own block and them.
  //
  // Adding a row anywhere in that tail moves every offset in front of it, and
  // nothing checks. The mark went in between the suffixes and the names and
  // pushed the numerals and the suffixes each one row late — which draws as the
  // place readout counting from two and the standings listing 2 to 10, with the
  // ordinal off the bottom of its own block. Nothing errors; it just reads wrong.
  /** The row each unicorn's name landed on, centred — the select screen's. */
  const NAME_ROW = LINES.length - UNICORNS.length * 2;
  /** And again, padded to hang off a left edge — the standings' column. */
  const LIST_ROW = LINES.length - UNICORNS.length;
  /** The star that marks the player's own row, immediately before the names. */
  const MARK_ROW = NAME_ROW - 1;
  /** The row of the numeral "1"; the other nine follow it. Ten, four and one. */
  const PLACE_ROW = NAME_ROW - 15;
  /** "CIRCUIT 1 / 2" and its siblings, one a circuit, just above the numerals. */
  const CIRCUIT_ROW = PLACE_ROW - CIRCUITS.length;
  /** The countdown's own glyphs: 3, 2, 1, GO!. */
  const COUNT_ROW = 11;
  /** The row of "ST", then ND, RD, TH; four suffixes cover ten places. */
  const SUFFIX_ROW = NAME_ROW - 5;
  const atlasRows = Math.ceil(LINES.length / 2);
  const card = document.createElement('canvas');
  // Browser-font experiment: rasterize smooth rounded lettering at high
  // resolution, preserving the atlas's logical cells and existing HUD anchors.
  card.width = CARD_W * 2 * 18;
  card.height = atlasRows * ROW_H * 18;
  const cctx = card.getContext('2d');
  cctx.scale(18, 18);
  const bevel = document.createElement('canvas');
  bevel.width = CARD_W * 18;
  bevel.height = ROW_H * 18;
  const bctx = bevel.getContext('2d');
  bctx.scale(18, 18);
  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.lineJoin = 'round';
  cctx.shadowColor = '#0008';
  cctx.shadowBlur = 12;
  cctx.shadowOffsetY = 10;
  LINES.forEach((text, row) => {
    const left = ((CARD_W - text.length * CELL) / 2) | 0;
    const column = Math.floor(row / atlasRows) * CARD_W;
    const top = (row % atlasRows) * ROW_H;
    let edgeLeft = CARD_W, edgeRight = 0;
    // Align numeral ink, including italic overhang, instead of its fixed cell.
    bctx.font = (/[<>]/.test(text) ? '' : 'italic ') + '700 6.5px Tahoma, sans-serif';
    let numeralShift = 0;
    if (row >= PLACE_ROW && row < PLACE_ROW + 10) {
      const last = bctx.measureText(text.at(-1));
      numeralShift = 1.9 - last.actualBoundingBoxRight * Math.min(1, 3.8 / last.width);
    }
    const glyphs = (offset, stroke) => {
      for (let i = 0; i < text.length; i++) {
        const char = text[i] === '<' ? '◀' : text[i] === '>' ? '▶' : text[i] === '*' ? '★' : text[i];
        bctx[stroke ? 'strokeText' : 'fillText'](char, left + i * CELL + 1.5 + numeralShift + Math.min(offset, 0), ROW_H / 2 - 0.6 + offset, 3.8);
      }
    };
    bctx.clearRect(0, 0, CARD_W, ROW_H);
    bctx.globalCompositeOperation = 'source-over';
    bctx.strokeStyle = '#fff';
    // Title, countdown and placement numerals share the narrower rounded rim.
    bctx.lineWidth = row === 29 || (row >= COUNT_ROW && row <= COUNT_ROW + 3) || (row >= PLACE_ROW && row < PLACE_ROW + 10) ? 1 : 1.5;
    for (let depth = 4; depth >= 0; depth--) glyphs(depth / 4, 1);
    // Measure the merged silhouette directly, including the rounded rim.
    const mask = bctx.getImageData(0, 0, bevel.width, bevel.height).data;
    for (let i = 3; i < mask.length; i += 4) if (mask[i]) {
      const x = (i >> 2) % bevel.width / 18;
      edgeLeft = Math.min(edgeLeft, x);
      edgeRight = Math.max(edgeRight, x);
    }
    bctx.globalCompositeOperation = 'source-in';
    const rainbow = bctx.createLinearGradient(edgeLeft, 0, edgeRight, 0);
    for (let i = 0; i < 7; i++) rainbow.addColorStop(i / 6, `hsl(${i * 50} 90% 70%)`);
    bctx.fillStyle = rainbow;
    bctx.fillRect(0, 0, CARD_W, ROW_H);
    bctx.globalCompositeOperation = 'source-over';
    bctx.fillStyle = '#0003';
    glyphs(-0.15, 0);
    bctx.fillStyle = '#fff';
    glyphs(0, 0);
    cctx.drawImage(bevel, column, top, CARD_W, ROW_H);
  });
  const cardTex = bmTexture(card, 1);

  // The march, at a quarter of the width and a quarter of the height — one
  // sixteenth of the rays. A cloud is the one thing in the scene that loses
  // nothing to that: no edges, no texture, no silhouette, only soft gradients,
  // and the target samples back linearly.

  // The title card. Its own program because it blends — the letters have to sit
  // over the sky rather than punch a hole in it — and because a blend state is
  // baked into a pipeline at creation and cannot be switched on for one draw.
  const text = programFor(Text, { blend: 1, zwrite: 0 });
  bmAttr(text, 0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  const CAPTIONS = 29;
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
  // Three, and it has to be exactly three: the block is uTime, uStep and uBase,
  // and bmUniforms writes this whole array into a buffer sized to the block.
  // Written wider than the block, every frame's write is rejected outright as
  // out of range and the shader keeps the zeros it started with — which put
  // every ring and star on road ring nought, in a lane read out of the road's
  // own coordinates. Silent, because a rejected write is not an exception.
  const tu = new Float32Array(3);
  // Gallop, always, for as long as there is a track under the hooves. Written
  // once rather than per frame because nothing on this screen can change it; the
  // select screen will hold 0 the same way. See uRun in unicorn.shader.ts.
  u[1] = 1;
  // The circuit's boost phase, to the two stages that have to agree about where
  // the pads are: the physics decides whether a unicorn is standing on one, the
  // road draws them, and a disagreement is a pad you can see and not use. Sent
  // ── Positions, lap counts and effects ──────────────────────────────────
  // One asynchronous read of all ten seven-vec4 racer blocks (1,120 bytes).
  // Reuse the staging buffer and allow only one outstanding read. Results may
  // arrive a frame or two later, but are no longer throttled to six per second.
  // MAP_READ | COPY_DST; the simulation buffer supplies COPY_SRC.
  const lapPeek = bmDevice.createBuffer({ size: FIELD * RACER_SLOTS * 16, usage: 1 | 8 });
  let peeking = false;

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
      // Keep scraping sounds at most four times a second, independently of
      // the faster position readback.
      if (seen[21] > 0.01 && TIME > mistakeAt) {
        playMistake();
        mistakeAt = TIME + 0.25;
      }
      // Racer zero's boost clock, watched for a rise: the ring is under the
      // hooves briefly; the raised clock also survives a delayed readback.
      const lit = seen[20];
      if (lit > wasBoost) { playBoost(); boostImpact = TIME; }
      // **The gate mirrors the shader's own condition rather than counting its
      // own second.** It used to be set from the rise, one second long, which
      // put two clocks on the same effect — and the pass stopped being issued
      // while the shader was still fading, so the streaks vanished mid-fade.
      //
      // 1.8 is where the shader's envelope reaches zero, and the third of a
      // second covers asynchronous readback delays, so a gate
      // renewed on every read that finds the clock still up cannot lapse while
      // there is anything left to draw. Past that the pass draws nothing anyway;
      // this only decides whether it is issued at all.
      // **Star power's gauge and its clock, both racer zero's alone.** They used
      // to be read inside the field loop under an `if (i === 0)`, which is a
      // test run ten times to be true once and put two racer-zero readouts in
      // among nine racers' lap distances. Out here they sit with the boost
      // clock, which is the other thing only the player has.
      //
      // **On the rise only.** The gauge falls as well as climbs — the fourth
      // star spends all four — and a chime on the way down would ring for the
      // wrong thing. Only a rising count should trigger the pickup sound.
      const nowStars = seen[23];
      if (nowStars > starsHeld) powerUp();
      starsHeld = nowStars;
      // The run's own clock, watched for the same edge, and what both the bang
      // and the rush hang off. It cannot be inferred from the
      // gauge: the gauge goes to ten and back to nought inside one frame of
      // shader time, between asynchronous readbacks — so the full gauge
      // that starts a run is very often never seen at all. The clock is up for
      // six seconds and cannot be missed.
      const nowStar = seen[26];
      // **The pad's whoosh, once, and not a run-length version of it.** A
      // sustained whoosh was tried: the same instrument with a held middle,
      // running the length of the clock. It pulsed — the filter LFO sweeps on a
      // two-second period, which is one arc across the pad's 1.77 seconds and
      // three and a half across seven, and what reads as a rush over one arc
      // reads as a wobble over three. Star power is announced, not narrated;
      // the flashing and the warp carry the run.
      //
      // The pad's own sound and nothing layered under it. There was a `BLAST`
      // here — a low detonation spread off the race song's noise track, fifteen
      // overridden fields of instrument — and it was written for a beam that no
      // longer exists. Against the whoosh it was doing the same job in the same
      // half second, and the triad that has already played three notes on the
      // way to arming is what tells the player they got there.
      if (nowStar > starLeft) playBoost();
      // Both ends of the run, and only those. `syncMusic` returns early when the
      // answer has not changed, but this poll can land every frame and there
      // is no reason to ask it that often.
      const swap = !nowStar !== !starLeft;
      starLeft = nowStar;
      if (swap) syncMusic();
      // **The warp is issued for a boost or for a run, and a run is the long
      // one.** Read straight out of `seen` rather than off `starLeft`, which is
      // last poll's answer — a delayed tunnel at the top of a
      // run is exactly where it would be noticed, because that is the frame the
      // player is looking for something to have happened.
      //
      // The third of a second of cover is the same on both: the pass only has to
      // be *issued* while there is anything to draw, and both effects fade
      // themselves out in the shader off clocks the CPU never has to track.
      if (lit > 1.8 || nowStar > 0) warpUntil = TIME + 0.34;
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
      // **Two crossings, not one: the grid sits behind the line.** The first
      // crossing is the start, the second is the finish, and a circuit is one
      // lap now — there is no lap count anywhere any more, and no lap caption in
      // the corner to keep in step with one.
      //
      // `DONE` stays even with a single lap to race, because it is not a lap
      // counter, it is what keeps the running order honest across the line: a
      // racer who has just crossed has a `ROUND` of nearly nothing, and ordering
      // on that alone would show whoever is winning as last.
      if (DONE[0] > 1) go(FINISH_STATE);
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
    // Keep standings and pickup sounds current. peek() permits only
    // one outstanding copy and skips menus/paused screens.
    peek();
    TIME = clock;

    // The pink card lifts over about a third of a second rather than blinking
    // out, revealing the world that has been rendering behind it all along.
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
    const driving = SCREEN === RACE_STATE;
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
    // **The throttle is not a key.** It was Up, and before that Up against a
    // Down that was a reverse gear nobody asked for. Both are gone: there is
    // nothing on this road that going slower solves — the rails hold you on it
    // and the corners are taken flat — and a race whose winning input is "hold
    // one key from the flag to the finish" is not asking the player a question.
    // So it is held for them, always, and steering is the entire game.
    step[1] = driving;
    step[2] = driving * (held('ArrowRight', 'KeyD') - held('ArrowLeft', 'KeyA'));
    step[3] = canvas.width / canvas.height;
    step[4] = RINGS;
    step[10] = PICK_BASE;
    step[5] = TRACK_WIDTH;
    step[6] = PATTERN;
    step[7] = TIME - selectOrbit * (SCREEN === SELECT_STATE);
    // The orbiting camera is up for everything before the race; it is also what
    // switches off the road's shadow, since there is no unicorn to cast one.
    step[8] = SCREEN <= SELECT_STATE;
    // Everything holds on the grid until the flag.
    step[9] = SCREEN !== FLAG_STATE;
    // Constant for the whole race — rolled once at the flag. Sent every frame
    // because the block is written whole, not because it changes.
    step[11] = ROLL;
    step[12] = SLOT_ROWS;
    step[13] = MAX_HANDICAP;
    step[14] = MIN_HANDICAP;
    step[15] = TIME;
    bmUniforms(sim, step);
    // Ahead of the draws below, though they were recorded first: bmLoop submits
    // only once this callback returns, so this frame's physics is queued before
    // this frame's rendering and the two never disagree about where anything is.
    bmDispatch(sim, 1);

    // Start the selection turntable clock at zero on every entry.
    u[0] = step[7] - 5 * (SCREEN === SELECT_STATE);

    // **Per frame, though they only change between races.** These were written
    // once at start-up, when there was one circuit and it could not change; a
    // series of three replaces the road under them, and a uniform set once is a
    // uniform still describing the previous track. Updating all three values is
    // cheaper than remembering to reissue them from the one place that swaps.
    tu.set([TIME, 1 / (PATTERN * 0.4456 * 2), PICK_BASE]);

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
    u[3] = SCREEN === SELECT_STATE;
    u[2] = u[3] ? 2.3 : 1.6;
    u[4] = SELECT_Y * u[3];

    bmPassTo();
    const age = TIME - titleSince;
    const impact = Math.max(0, SCREEN === TITLE_STATE ? age - 1.125 : TIME - boostImpact);
    const shake = Math.max(0, 0.2 - impact) * Math.sin(impact * 100) * -6;
    canvas.style.transform = `translateY(${shake}%)`;
    su.set([TIME, 0, SCREEN === TITLE_STATE]);
    bmUniforms(sky, su);
    bmDraw(sky);
    if (shown) {
      bmUniforms(prog, u);
      bmDraw(prog, shown);
    // The same array, and the same sixteen bytes: the track reads uTime out of
    // the front of it and never looks at the gait behind. Each program owns its
    // uniform buffer, so one write does not reach the other — the camera they
    // share travels the other way, through the state buffer, and never touches
    // the CPU at all.
      bmUniforms(track, tu);
      bmDraw(track);
    }

    if (TIME < warpUntil) {
      su[1] = 1;
      bmUniforms(warp, su);
      bmDraw(warp);
    }


    // ── The overlay ─────────────────────────────────────────────────────────
    // Whatever this screen has to say, gathered into the instance buffer and
    // drawn in one go. One draw because a uniform cannot change between two of
    // them inside a pass — see the instance attributes in text.shader.ts.
    let n = 0;
    /** Ordinary caption: row, centre y, half-width, fade. Negative fades select HUD layouts; row -1 is the card. */
    const say = (row, y, half, fade = 1) => {
      // Share the prompt pulse; wall time keeps it moving on the pause screen.
      // Bits 1, 4, 6, 8 and 15 select prompts; the bound prevents wrapping.
      if (row < 16 && (33106 >> row & 1)) fade *= 0.6 + 0.4 * Math.cos((row === 1 ? Math.max(0, age - 2.3) : t) * 3);
      cells.set([row, y, half, fade], n++ * 4);
    };

    /** A heading with one line under it, centred as a pair. */
    const heading = (top, under) => {
      say(top, headY, FONT_L);
      say(under, headY - HEAD_GAP, FONT_S);
    };

    // The title's ground goes first so the text lands on top of it. It is drawn
    // over a world that is still being rendered underneath, which is what lets
    // the pink lift off the circuit rather than cut to it.

    // The corner HUD stays visible from the grid through the race and finish.
    // Its grouped backgrounds are anchored by the shader to SCREEN_PADDING.
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
      // HUD markers: -1 numeral, -2 suffix, -3 gauge, -4 label. The shader
      // anchors the groups to SCREEN_PADDING and gives adjacent plates shared
      // edges. Ordinal sizes are relative to FONT_L; left rows use halves.
      say(PLACE_ROW + place, 0, FONT_XL / FONT_L, -1);
      say(SUFFIX_ROW + Math.min(place, 3), 0, FONT_M / FONT_L, -2);
      say(16, 0, FONT_M, -4);
      say(17 + starsHeld, 0, FONT_M, -3);
    }
    if (SCREEN === TITLE_STATE) {
      const slide = 1 + 2.6 * (1 - Math.max(0, Math.min(1, (age - 0.75) / 0.375)));

      say(0, 0.36, FONT_L, slide);
      say(29, -0.02, FONT_XXL, slide);
      say(1, -0.42, FONT_S, Math.max(0, Math.min(1, (age - 2) / 0.3)));
    } else if (SCREEN === SELECT_STATE) {
      // The heading on the top line, the roster's name hung under it, and the
      // two instructions on the bottom line — the same two edges the race HUD
      // uses, so the screens frame their contents identically.
      //
      // All stacked labels leave one full upper-label height between plates.
      say(2, HUD_TOP - plate(FONT_M) - headingInset, FONT_M);
      say(NAME_ROW + PICK, nameY - headingInset, FONT_L);
      // Level with the unicorn, which is no longer level with the middle of the
      // screen: the name above and the two hints below are not symmetric about
      // it, so centring on zero left the animal riding high with a gap under the
      // name. So it rides halfway between the bottom of the name and the top of
      // the upper hint, and that is what both this and the model are hung from.
      //
      // Worked out rather than written down now that the hints hang off the
      // bottom edge: the pair moves with the padding, and a constant here would
      // have left the animal where the old -0.74 put it.
      //
      // Just outside its neighbours, too.
      //
      // Its own half-width rather than one of the constants, because an arrow's
      // *position* is its half-width — the ink is at the ends of the row. It
      // scales with the atlas like everything else, so the triangles stay put
      // however long the longest caption gets.
      // Left, then the same row mirrored for the right — see the note on row 9
      // in src/text.js. A negative half-width flips the quad and not the
      // texture, so the caret comes back pointing the other way at the other
      // side, and the pair stays one row of the atlas rather than two.
      say(9, SELECT_Y, FONT_L);
      say(30, SELECT_Y, FONT_L);
      say(3, hint + HINT_GAP, FONT_S);
      say(4, hint, FONT_S);
    } else if (SCREEN === FLAG_STATE) {
      // Between the two corner readouts rather than over either: thirteen
      // characters at FONT_M reach about a quarter of the way out from the
      // middle, and the lap and the place stop at 0.63 and 0.69.
      //
      // Share the fixed top margin with the corner readouts.
      say(CIRCUIT_ROW + SELECTED_CIRCUIT, HUD_TOP - plate(FONT_M), FONT_M);
      // Three, two, one — one glyph a signal, and `rung` is already counting
      // them for the sound. Nothing on the first frame, when `rung` is zero:
      // there is a beat of quiet before the first tone, and a "3" hanging there
      // through it would be a countdown that starts early.
      if (rung) say(COUNT_ROW + rung - 1, 0.5, FONT_XXL);
      // Two lines again, back on the pair of rows they sat on before a third was
      // added under them. The star meter in the corner is the only instruction
      // star power needs: it fills as you collect, which says what stars are for
      // without a sentence, and the line that spelled it out was telling the
      // player a rule they were already watching happen.
      //
      // One line, on the lowest row a caption sits on anywhere in the game. It
      // was two, with "PRESS UP TO GO" above it — and the throttle is held down
      // for the player now, so the only thing left to tell them is the only
      // thing they can do.
      say(10, HUD_BOT + ROW_H * FONT_S / CARD_W * (16 / 9), FONT_S);
    } else if (SCREEN === RACE_STATE && flash) {
      // Fading over the last second of the two, which is `min(flash, 1)` and
      // needs no second timer.
      say(COUNT_ROW + 3, 0.5, FONT_XXL, Math.min(flash, 1));
    } else if (SCREEN === PAUSE_STATE) {
      heading(5, 6);
    } else if (SCREEN === FINISH_STATE) {
      // ── The standings ───────────────────────────────────────────────────
      // Ten rows, one a racer, best total at the top: the position out at the
      // right where the place readout has always sat, and the name centred.
      // Two captions a row rather than one, because a row's *text* is baked
      // into the atlas and a name paired with a number is a pairing that
      // changes every race — ten names against ten positions is a hundred rows
      // of atlas to say what two captions say for nothing.
      //
      // The numerals are the HUD's own, already padded to end 24 rows' worth
      // right of centre; the names are a second, padded copy of the roster that
      // starts the same distance to the left of it. Both edges are set by the
      // same number, so the block stays square as the window changes.
      //
      // Fixed row pitch leaves a small gap between the seven-pixel plates.
      // Centred as a block: five rows above the middle and five below, with the
      // heading over them and the way on underneath.
      const promptY = HUD_BOT + ROW_H * FONT_M / CARD_W * (16 / 9);
      const headingY = HUD_TOP - ROW_H * FONT_L / CARD_W * (16 / 9);
      const listY = (headingY - tall(FONT_L) + promptY + tall(FONT_M)) / 2;
      for (let i = 0; i < FIELD; i++) {
        const y = pitch * (4.5 - i) + listY;
        say(PLACE_ROW + i, y, FONT_S);
        say(LIST_ROW + ((PICK + STANDINGS[i]) % FIELD), y, FONT_S);
        // Slot zero is the player, always — `lineUp` rotates the roster so that
        // it is, which is why the arrow needs no other bookkeeping than this.
        if (!STANDINGS[i]) say(MARK_ROW, y, FONT_S);
      }
      const more = SELECTED_CIRCUIT < CIRCUITS.length - 1;
      say(more ? 28 : 7, headingY, FONT_L);
      say(
        more ? 15 : 8,
        promptY,
        FONT_M,
      );
    }


    if (n) {
      // Written straight into the buffer that already exists. A queue write
      // lands before the pass is submitted, which is exactly the ordering an
      // instanced draw wants and the one a per-draw uniform cannot give.
      bmDevice.queue.writeBuffer(cellBuf, 0, cells, 0, n * 4);
      textU.set([
        atlasRows, ROW_H / CARD_W, 0, 0,
        // The same two margins the CPU-side captions hang from, so the four
        // corners the shader places and the lines placed above agree.
        PAD_X, PAD_Y,
        2 * FONT_L / CARD_W, FONT_M / FONT_L,
      ]);
      bmUniforms(text, textU);
      bmDraw(text, n);
    }
  });
});
