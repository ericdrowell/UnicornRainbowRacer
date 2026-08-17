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
// The two booleans are `const` rather than runtime flags because terser folds
// them: with either false, the feature it guards becomes unreachable and
// `--toplevel` deletes it outright, so a switch that is off costs nothing and
// the build gets its bytes back. That is also why they cannot be flipped at
// runtime — turning one on means a rebuild, which for a thing decided once per
// session is the right trade at this budget.

/** The soundtrack. Off while the road is being worked on: half an hour of the
 *  same loop is not a good way to judge a look. Sound effects are separate and
 *  keep working either way. */
const MUSIC_ENABLED = false;

/** The pixel grid. Off renders at native resolution, with the canvas filling
 *  the window from the stylesheet. */
const PIXELATE = false;

/** Block size when PIXELATE is on, in *device* pixels — 1 is native, 8 is
 *  chunky. P cycles it 1 to 8 at runtime; this is where it starts. */
let PIXEL = 8;

// ── Pixel grid ──────────────────────────────────────────────────────────────
// Real pixel art rather than a blur filter: the scene is *rendered* at one pixel
// per art pixel and then blown up by a whole number, so each art pixel lands on
// an exact PIXEL x PIXEL block. Sampling a full-resolution image and quantising
// it would give blocks too, but each would be a point sample of a sharp image —
// blocky edges with full-resolution aliasing trapped inside them. Rendering at
// the low resolution is what makes it read as pixel art.
//
// The blow-up is a CSS transform, not a second render pass. bmLoop sizes the
// drawing buffer from the element's layout box, and a transform does not change
// that box — so the buffer stays small while the picture fills the screen. A
// post-process pass would cost a pipeline, a quad and a shader to arrive at the
// same image, and this budget has 3.5 kB left in it.
//
// Flooring is what keeps the scaling exact. The element is sized to a whole
// number of art pixels, so the leftover strip at the right and bottom is at most
// PIXEL - 1 pixels of background rather than a row of half-width blocks.
//
// **PIXEL is a multiplier, and the block it makes is PIXEL by PIXEL real device
// pixels — 1 is native, 2 is 2x2, 3 is 3x3.** That falls out of bmLoop sizing
// the buffer as `clientWidth * devicePixelRatio`, and it is worth following
// through once: at 1000 CSS px wide on a 2x display with PIXEL = 3, the box is
// floor(1000 / 3) = 333 CSS px, the buffer is 666 device px, and scaling by 3
// paints it across 1998 device px — so one rendered pixel covers exactly three.
// The ratio is PIXEL whatever the display, because the pixel ratio appears in
// the buffer and in the painted width and divides straight back out.
//
// It used to multiply the step by devicePixelRatio as well, on the reasoning
// that the ratio had to be cancelled by hand. It does not, and doing it twice
// silently doubled the setting on every retina screen: PIXEL = 4 drew 8-pixel
// blocks, and no value of it could ever draw 1x1. That is also why resizing the
// window looked wrong — the blocks were a fixed number of *CSS* pixels, so they
// stayed the same size on screen while everything else got smaller.
//
// Sizing the element here is also what makes the switch free. With PIXELATE off
// nothing calls this, and the canvas takes its size from the stylesheet's
// `width:100%;height:100%` instead — which is the one line that has to stay
// whatever happens to this function, because without it a canvas with no
// explicit size is 300 by 150 and the game renders in a stamp.
function pixelate() {
  canvas.style.width = Math.floor(innerWidth / PIXEL) + 'px';
  canvas.style.height = Math.floor(innerHeight / PIXEL) + 'px';
  canvas.style.transform = 'scale(' + PIXEL + ')';
}
if (PIXELATE) {
  pixelate();
  addEventListener('resize', pixelate);
}

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
    NR.push(n[0] / L, n[1] / L, n[2] / L);
    RT.push(root[0], root[1], root[2]);
    // How far down the limb this corner sits — the weight the shader scales by.
    // Read from the corner itself, so every face meeting here agrees.
    const t = legs[k] ? weightAt(tri[k][1]) : 0;
    SK.push(t, skin[1], skin[2], skin[3]);
    const ci = (j / 3) * 4 + k * 4;
    CL.push(MESH_C[ci], MESH_C[ci + 1], MESH_C[ci + 2], MESH_C[ci + 3]);
  }
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
const TRACK = [
  [0, 0, 0], // start line: flat, straight, and pointing the way the unicorn does
  [30, 1, 2],
  [53, 5, 8], // the climb starts
  [64, 10, 20],
  [62, 12, 37], // long left, high and open
  [50, 12, 59],
  [31, 13, 84],
  [9, 17, 103],
  [-12, 22, 111], // over the top
  [-31, 23, 103], // summit, 23 above the start line
  [-48, 18, 82], // dropping away
  [-60, 10, 54],
  [-63, 4, 29], // the tight one, and the steepest bit of the descent
  [-53, 2, 12],
  [-31, 1, 3], // levelling out onto the start straight
];

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
const CENTRE = [];
for (let i = 0; i < TRACK.length; i++) {
  const a = TRACK[(i + TRACK.length - 1) % TRACK.length];
  const b = TRACK[i];
  const c = TRACK[(i + 1) % TRACK.length];
  const d = TRACK[(i + 2) % TRACK.length];
  const steps = Math.max(1, Math.round(dist(b, c) / RING_SPACING));
  // The endpoint is left off: it is the next segment's start, and emitting both
  // would put two rings in the same place and a zero-area quad between them.
  for (let s = 0; s < steps; s++) CENTRE.push(spline(a, b, c, d, s / steps));
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

// How hard the road is turning at each ring, signed: positive is a left-hander.
// The y component of the cross product of the tangents either side is the sine
// of the heading change, and dividing by the distance between them turns that
// into curvature — a number about the track's shape, independent of how many
// rings were spent on it.
let BANK = TAN.map((_, i) => {
  const p = TAN[(i + RINGS - 1) % RINGS];
  const n = TAN[(i + 1) % RINGS];
  const turn = p[2] * n[0] - p[0] * n[2];
  const span = dist(ring(i + 1), ring(i - 1));
  return Math.min(Math.max((turn / span) * BANK_GAIN, -BANK_MAX), BANK_MAX);
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
  const t = TAN[g];
  // Across the road, level with the horizon before banking. This is the one
  // assumption the frame makes: a section going straight up has no side to
  // speak of, so the track may climb as steeply as it likes but must not
  // actually stand on end.
  const side = norm(cross(t, [0, 1, 0]));
  const up = cross(side, t);
  const cb = Math.cos(BANK[g]);
  const sb = Math.sin(BANK[g]);
  // Rolled about the tangent, so the outside of a corner lifts.
  const arm = side.map((s, k) => (s * cb + up[k] * sb) * TRACK_WIDTH * 0.5);
  const c = CENTRE[g];
  const v = (i < RINGS ? ALONG[i] : LAP) * PATTERN;
  TP.push(c[0] - arm[0], c[1] - arm[1], c[2] - arm[2]);
  TE.push(-1, v);
  TP.push(c[0] + arm[0], c[1] + arm[1], c[2] + arm[2]);
  TE.push(1, v);
}

// Two triangles per quad. bmIndex draws uint16, so the track has a ceiling of
// 32k rings — about 65 km of road at this spacing.
const TI = new Uint16Array(RINGS * 6);
for (let i = 0; i < RINGS; i++) {
  const a = i * 2;
  const b = a + 2;
  TI.set([a, b, a + 1, a + 1, b, b + 1], i * 6);
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
const TRACK_DATA = new Float32Array((RINGS + 1) * 8);
for (let i = 0; i <= RINGS; i++) {
  const g = i % RINGS;
  TRACK_DATA.set(
    [...CENTRE[g], i < RINGS ? ALONG[i] : LAP, ...TAN[g], BANK[g]],
    i * 8,
  );
}

// ── Driving ─────────────────────────────────────────────────────────────────
// Keys are the one thing the GPU cannot read, so this is all the CPU still owns
// of the simulation: which keys are down, and a latch for the one that is an
// event rather than a state.
const HELD = {};
let JUMPED = 0;
/** 1 when either key of a pair is down. */
const held = (a, b) => (HELD[a] || HELD[b] ? 1 : 0);

addEventListener('keydown', (e) => {
  HELD[e.code] = 1;
  // Jump is a press, not a hold. The latch is set here and cleared by the frame
  // that spends it, so holding the key gives exactly one jump — and `repeat`
  // keeps the key's own auto-repeat, about thirty a second, from giving more.
  if (e.code === 'Space' && !e.repeat) JUMPED = 1;
  // Arrows scroll the page and space pages down it, both of which move the
  // canvas out from under the player mid-corner.
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
let PAUSED = false;
let clock = 0;
let prev = 0;
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') {
    // 1 through 8, then back to 1. A toggle only ever showed one coarseness, and
    // which one it should be is exactly the question the key exists to answer.
    PIXEL = (PIXEL % 8) + 1;
    pixelate();
    return;
  }
  if (e.code !== 'Escape') return;
  PAUSED = !PAUSED;
  syncMusic();
});

// The rendered song, once music.js has it, and the source playing it. A pause
// is silence, so there is nothing playing to hold on to while paused. Not TRACK:
// that is the road's centreline, further up this file — everything here shares
// one scope, so a second TRACK is not a shadow, it is a build failure.
let SONG = null;
let PLAYING = null;

/**
 * Point the audio at whatever the game currently wants: the song while you
 * drive, nothing at all while you are paused.
 *
 * Resuming starts the song at its first note, which is why the pause stops the
 * source outright rather than suspending the context. A BufferSource plays once
 * and cannot be rewound, so playing from the beginning *is* a new source — and
 * a suspended context would do the opposite, holding the playhead exactly where
 * the pause caught it. Sources are cheap: the buffer is the expensive part, and
 * that is rendered once at load and handed to every source that follows.
 *
 * One function rather than a decision in each place that needs one, because two
 * places deciding independently is exactly how they came to disagree. music.js
 * may not start the track until the browser has seen a gesture, so it waits for
 * the first key or click — and that first key can be the very Escape that just
 * paused. Both handlers fire, and whichever ran last used to win. Now both ask
 * this, and this only ever answers with the state the game is actually in. Both
 * running for one Escape is harmless either way: paused, the second call finds
 * nothing left to stop; playing, it restarts a song that began a moment ago,
 * which is the same song from the top.
 */
function syncMusic() {
  if (!MUSIC_ENABLED) return;
  MUSIC.resume();
  if (PLAYING) {
    PLAYING.stop();
    PLAYING = null;
  }
  if (PAUSED || !SONG) return;
  PLAYING = MUSIC.createBufferSource();
  PLAYING.buffer = SONG;
  PLAYING.loop = true;
  PLAYING.connect(MUSIC.destination);
  PLAYING.start();
}
// The unicorn's whole existence, and the camera that watches it. Thirteen vec4s:
// four of body, four of view-projection, three the camera remembers between
// frames so it can chase rather than snap, and two for the world directions it is
// actually travelling, which is not the direction it is pointing.
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
bmInit(canvas, [0.02, 0.02, 0.05, 1]).then(() => {
  STATE = bmStore(new Float32Array(52));
  const rings = bmStore(TRACK_DATA);

  // The simulation. One workgroup of one, dispatched once a frame: there is a
  // single unicorn and nothing here is parallel. It is on the GPU so that the
  // answer never has to come back — see physics.shader.ts.
  const sim = bmCompute(Physics[0], { u: Physics[3], s: Physics[5] });
  bmStorages(sim, STATE, rings);

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
  bmIndex(prog, idx);
  bmStorages(prog, STATE);

  // Drawn without culling: the ribbon is one surface with nothing under it, and
  // half a lap of it is above the camera on the climb, so the underside is on
  // screen as often as the top.
  const track = bmProgram(Track[0], {
    a: Track[1],
    i: Track[2],
    u: Track[3],
    t: Track[4],
    s: Track[5],
  });
  bmAttr(track, 0, new Float32Array(TP));
  bmAttr(track, 1, new Float32Array(TE));
  bmIndex(track, TI);
  bmStorages(track, STATE);

  // The sky. One triangle big enough to cover the screen — the corners run to 3
  // rather than 1 so a single one spans the viewport with the excess clipped
  // away, which is a vertex and an edge cheaper than a quad and has no diagonal
  // through the middle for the rasteriser to seam on.
  //
  // `zwrite: 0` and drawn before everything else: it fills the frame with sky,
  // leaves the depth buffer as it found it, and the road and the unicorn then
  // paint over it wherever they are.
  const sky = bmProgram(Sky[0], { a: Sky[1], u: Sky[3], t: Sky[4], s: Sky[5], zwrite: 0 });
  bmAttr(sky, 0, new Float32Array([-1, -1, 3, -1, -1, 3]));
  bmIndex(sky, new Uint16Array([0, 1, 2]));
  bmStorages(sky, STATE);

  // The noise the clouds are made of: a 64-cubed volume of smooth value noise,
  // folded into a 512x512 sheet as eight slices across by eight down.
  //
  // Built here, on the CPU, once. That is the trade the whole effect rests on —
  // a march that *evaluates* its noise pays eight hashes and a heap of
  // interpolation at every one of thousands of samples per pixel, and an earlier
  // version of these clouds that did exactly that ran at a tenth of a frame per
  // second. Reading it back is two texture fetches, which the GPU is built for.
  //
  // The lattice wraps at 8, so the volume tiles seamlessly in all three axes and
  // the sky can be sampled forever without a repeat showing up as an edge.
  const LAT = 8;
  const lat = new Float32Array(LAT * LAT * LAT);
  for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
  const latAt = (x, y, z) =>
    lat[(((x % LAT) + LAT) % LAT) * LAT * LAT + (((y % LAT) + LAT) % LAT) * LAT + (((z % LAT) + LAT) % LAT)];
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const vnoise = (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = fade(x - xi);
    const yf = fade(y - yi);
    const zf = fade(z - zi);
    return lerp(
      lerp(
        lerp(latAt(xi, yi, zi), latAt(xi + 1, yi, zi), xf),
        lerp(latAt(xi, yi + 1, zi), latAt(xi + 1, yi + 1, zi), xf),
        yf,
      ),
      lerp(
        lerp(latAt(xi, yi, zi + 1), latAt(xi + 1, yi, zi + 1), xf),
        lerp(latAt(xi, yi + 1, zi + 1), latAt(xi + 1, yi + 1, zi + 1), xf),
        yf,
      ),
      zf,
    );
  };
  const vol = document.createElement('canvas');
  vol.width = 512;
  vol.height = 512;
  const vctx = vol.getContext('2d');
  const pix = vctx.createImageData(512, 512);
  for (let z = 0; z < 64; z++) {
    const ox = (z % 8) * 64;
    const oy = ((z / 8) | 0) * 64;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const u = (x / 64) * LAT;
        const v = (y / 64) * LAT;
        const w = (z / 64) * LAT;
        const n = vnoise(u, v, w) * 0.62 + vnoise(u * 2, v * 2, w * 2) * 0.38;
        const k = ((oy + y) * 512 + ox + x) * 4;
        pix.data[k] = pix.data[k + 1] = pix.data[k + 2] = n * 255;
        pix.data[k + 3] = 255;
      }
    }
  }
  vctx.putImageData(pix, 0, 0);

  // The march, at a quarter of the width and a quarter of the height — one
  // sixteenth of the rays. A cloud is the one thing in the scene that loses
  // nothing to that: no edges, no texture, no silhouette, only soft gradients,
  // and the target samples back linearly.
  const clouds = bmTarget(
    ((canvas.clientWidth * devicePixelRatio) / 4) | 0,
    ((canvas.clientHeight * devicePixelRatio) / 4) | 0,
  );
  const cloud = bmProgram(Cloud[0], {
    a: Cloud[1],
    u: Cloud[3],
    t: Cloud[4],
    s: Cloud[5],
    zwrite: 0,
    fmt: 1,
  });
  bmAttr(cloud, 0, new Float32Array([-1, -1, 3, -1, -1, 3]));
  bmIndex(cloud, new Uint16Array([0, 1, 2]));
  bmTextures(cloud, bmTexture(vol, 1));
  bmStorages(cloud, STATE);
  bmTextures(sky, clouds);

  const step = new Float32Array(Physics[3] / 4);
  const u = new Float32Array(Unicorn[3] / 4);
  // Gallop, always, for as long as there is a track under the hooves. Written
  // once rather than per frame because nothing on this screen can change it; the
  // select screen will hold 0 the same way. See uRun in unicorn.shader.ts.
  u[1] = 1;
  bmLoop((t) => {
    const elapsed = prev ? t - prev : 0;
    prev = t;
    if (!PAUSED) clock += elapsed;
    TIME = clock;

    // A zero step is the pause. The stage still runs — the camera has to keep
    // answering, since the window can be resized while paused and the aspect
    // ratio is baked into the matrix it builds — but nothing integrates, so the
    // unicorn holds exactly where it was rather than resuming somewhere else.
    step[0] = PAUSED ? 0 : elapsed;
    step[1] = held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown');
    step[2] = held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft');
    step[3] = PAUSED ? 0 : JUMPED;
    step[4] = canvas.width / canvas.height;
    step[5] = RINGS;
    step[6] = TRACK_WIDTH;
    step[7] = PATTERN;
    JUMPED = 0;
    bmUniforms(sim, step);
    // Ahead of the draws below, though they were recorded first: bmLoop submits
    // only once this callback returns, so this frame's physics is queued before
    // this frame's rendering and the two never disagree about where anything is.
    bmDispatch(sim, 1);

    u[0] = TIME;
    // The clouds first, into their own quarter-size target, then back to the
    // screen where the sky samples and composites them. Before the road, so the
    // ribbon paints over them and passes overhead on the climb.
    bmPassTo(clouds);
    bmUniforms(cloud, u);
    bmDraw(cloud);
    bmPassTo();
    bmUniforms(sky, u);
    bmDraw(sky);
    bmUniforms(prog, u);
    bmDraw(prog);
    // The same array, and the same sixteen bytes: the track reads uTime out of
    // the front of it and never looks at the gait behind. Each program owns its
    // uniform buffer, so one write does not reach the other — the camera they
    // share travels the other way, through the state buffer, and never touches
    // the CPU at all.
    bmUniforms(track, u);
    bmDraw(track);
  });
});
