import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  min,
  max,
  exp,
  step,
  tan,
  floor,
  fract,
  clamp,
  mix,
  mod,
  dot,
  cross,
  length,
  normalize,
  storageRead,
  storageWrite,
  type Vec3,
  type Vec4,
} from 'brometal';

/**
 * The unicorn, simulated on the GPU.
 *
 * One invocation, one body. There is no parallelism to exploit here and that is
 * not why it lives on the GPU — it is here so that the *result* never has to
 * come back. A compute stage cannot hand a number to JavaScript without a
 * readback that resolves a frame later, so instead this writes everything the
 * frame needs, the camera matrix included, into a buffer the vertex shaders
 * read directly. The CPU sends keys and a delta and is told nothing.
 *
 * **uState is written here and read-only everywhere else.** WebGPU forbids a
 * read_write storage binding from being visible to a vertex stage, so the same
 * GPUBuffer is bound to three programs and only this one declares a write. The
 * compiler works that out per module and the runtime binds each side to match.
 *
 * uState, in vec4s:
 *
 *   0   position
 *   1   facing, drawn     speed
 *   2   surface normal    gait phase
 *   3   surface across    vertical speed
 *   4   view-projection, as four columns
 *   8   camera eye        1 once the camera exists
 *   9   camera target
 *   10  camera up
 *   11  course, the world direction it is travelling
 *   12  heading, the world direction the nose points
 *
 * Slot 1 is the direction the model is *drawn* facing, which is neither the
 * heading nor the course but an exaggeration past both — see the slip below.
 * Nothing outside this shader needs the difference; the vertex stage just wants
 * a forward vector to build a basis from.
 *
 * uTrack is the ribbon, two vec4s per ring: centre with distance travelled,
 * then tangent with camber. Everything about the surface — where its floor is,
 * which way is up, where its edges are — is recovered from those.
 */

/**
 * The road's own frame at a point on a segment: forward, up and across.
 *
 * **This used to build itself from world up and could not survive a loop.** It
 * was `normalize(cross(fwd, vec3(0, 1, 0)))` rolled by the camber — exact, free,
 * and undefined at exactly one angle: straight up. The comment beside it said
 * the track "must not actually stand on end", which was not a style note. A
 * vertical tangent makes that cross product zero, the road loses its width, and
 * the unicorn loses the surface it is standing on. A loop stands on end twice.
 *
 * So game.js carries a frame along the whole centreline instead — squaring each
 * ring's up against its own tangent, starting level, and unwinding the leftover
 * twist over the lap — and sends it in the ring record. Nothing here is derived
 * from the world any more, so nothing here cares which way the road is pointing.
 *
 * The camber is already rolled into it on the way in, so there is no bank term
 * left to apply and nothing for the two sides to disagree about.
 *
 * Re-squared after the interpolation because a lerp between two unit vectors a
 * few degrees apart is neither unit nor quite perpendicular to the tangent, and
 * the whole point of this is to hand back a frame that is both.
 */
function frameUp(fwd: Vec3, up: Vec3): Vec3 {
  return normalize(up.sub(fwd.scale(dot(up, fwd))));
}

/**
 * Normalise, without the hole at zero.
 *
 * `normalize` of a zero vector is NaN rather than zero, and NaN does not stay
 * where it is put: **`mix(a, NaN, 0)` is NaN, not `a`**, because the lerp
 * multiplies the bad endpoint by zero and adds it, and zero times NaN is still
 * NaN. So a direction computed for a state the shader is not even in can wipe
 * out one it is. This bit the select screen's carousel — since moved into the
 * unicorn shader — where a direction built from a still-zeroed camera came
 * through a weight-zero `mix` and destroyed the player's position on the title
 * screen, taking the camera and the entire scene with it.
 */
function steady(v: Vec3): Vec3 {
  return v.scale(1 / max(length(v), 0.0001));
}

/**
 * One column of a view matrix through a GL-style perspective.
 *
 * The projection is the one bmPersp builds rather than a WGSL-native one,
 * because the vertex shaders this feeds already convert clip z from the OpenGL
 * range to WebGPU's — the compiler emits that line into every vertex stage. A
 * matrix built for WebGPU's range would be converted a second time.
 */
function project(col: Vec4, fx: number, fy: number, za: number, zb: number): Vec4 {
  return vec4(fx * col.x, fy * col.y, za * col.z + zb * col.w, 0 - col.z);
}

export const Physics = shader({
  uniforms: {
    uDt: 'float',
    /** +1 accelerating, -1 braking, 0 coasting. */
    uThrottle: 'float',
    /** +1 steering one way, -1 the other. */
    uSteer: 'float',
    uAspect: 'float',
    uRings: 'float',
    uWidth: 'float',
    /**
     * Track distance to the track shader's own along-coordinate. game.js stretches
     * that coordinate so a lap holds a whole number of pattern periods, and the
     * unicorn has to land in the same space to be lit by the right panel.
     *
     * Rides in a uniform block padded to eight floats, so it costs nothing to
     * send.
     */
    uPattern: 'float',
    /**
     * Wall clock, for the parts of the look that drift on their own and for the
     * title camera's orbit. The block was already padded to eight floats for
     * uPattern's sake and only seven were used, so this rides along at no cost.
     */
    uTime: 'float',
    /** 1 before the flag, while the title card is up. See the camera below. */
    uTitle: 'float',
    /**
     * 1 once the flag drops, 0 on the grid during the countdown.
     *
     * A gate on the throttle rather than on `dt`, and that is the point of it.
     * Stopping the clock would hold the field still, but it would also freeze
     * the camera — the chase is an exponential settle on `dt`, so a zero step
     * leaves it wherever it was, which is out at the carousel. Everything has to
     * keep integrating so the camera can fly in; only the accelerating waits.
     */
    uGo: 'float',
    /**
     * The circuit's boost phase — see `points.b` in src/circuits.js. Hashed with
     * a pad's index down the road to place the pads, by exactly the arithmetic
     * the track shader uses to draw them.
     *
     * **Last in the block, and that is not a style choice.** game.js fills this
     * struct by index — `step[9] = uGo` and so on — so a uniform inserted
     * anywhere but the end renumbers every field below it and silently
     * repoints those writes. Added after `uPattern` first, which pushed uTime,
     * uTitle and uGo down one: the throttle gate then read the boost phase,
     * which is a constant and never zero, so the field bolted the instant the
     * grid appeared, and `uTitle` read the go flag and threw the camera out to
     * the orbit shot the moment the race started. Nothing warns. New uniforms
     * go on the end.
     */
    uSeed: 'float',
    /**
     * One number rolled fresh at each flag, so a race is not the same race.
     *
     * Every AI's pace and lane used to be `fract(me * k)` — a function of the
     * invocation index and nothing else, which meant racer 5 was the quickest
     * and racer 8 the slowest in every race anyone would ever run, always in the
     * same lane. Hashing the index against this instead keeps them apart from
     * each other and stops them being the same nine racers twice.
     *
     * Last in the block for the same reason `uSeed` is — game.js fills this
     * struct by index, so a field inserted anywhere else silently renumbers
     * every one below it.
     */
    uRoll: 'float',
  },
  storage: { uState: 'vec4', uTrack: 'vec4' },
  workgroupSize: [10, 1, 1],

  compute(
    { uState, uTrack, uDt, uThrottle, uSteer, uAspect, uRings, uWidth, uPattern, uSeed, uRoll, uTime, uTitle, uGo },
    id,
  ) {
    // A tab left in the background delivers one enormous frame on return, and
    // an unclamped step of that size moves the unicorn straight through the
    // road — collision is tested at the new position, not swept to it.
    const dt = min(uDt, 0.05);

    // ── Which unicorn this invocation is ───────────────────────────────────
    // One per invocation of a single workgroup, and they all run the code below. Racer zero is the player and the only difference is
    // where its throttle and steering come from — everything after that, the
    // handling model included, is shared. That is the point of doing it this
    // way rather than giving the AI a simpler mover of its own: a field that
    // obeys different physics from the player reads as fake the first time you
    // race alongside it.
    // The whole roster, one each. Written here as a literal and again in
    // game.js, which is not a duplication that can be factored out: this file is
    // compiled from its source, so the workgroup size above and this bound have
    // to be numbers. They must agree — a FIELD larger than the workgroup leaves
    // racers unsimulated, and smaller leaves invocations reading slots nobody
    // fills.
    const FIELD = 10;
    const RACER = 16;
    const SLOTS = 6;

    /**
     * **How fast the field runs, and the one number to turn while tuning it.**
     *
     * The average cruising speed of the nine AI, in metres a second. Each of
     * them takes a share of a sixteen-wide spread either side of it, so this
     * moves the whole field together and keeps the character between them.
     *
     * Everything about an AI's pace hangs off it — the cap it lifts off at, and
     * the thrust that lets it reach the cap in the first place — so there is
     * nothing else to keep in step. Raise it and the field is harder to beat
     * without the pads; drop it and the pads matter less.
     *
     * For scale: drag alone settles a racer at 54.8, and a pad pins one at 90.
     * The whole race lives between those two, and this says where in between the
     * field sits.
     */
    const PACE = 76;
    const me = id.x;
    const mine = RACER + me * SLOTS;
    // This racer's draw for the race: the pace it settles at and the line it
    // takes both come off it, so the two stay independent of each other and
    // neither is the same twice. `fract(roll * 7.7)` is a second number out of
    // the first, which is cheaper than a second hash and just as uncorrelated
    // over nine racers.
    const roll = fract(sin(me * 12.99 + uRoll) * 43758.5);
    /** 1 for the player, 0 for the AI. Used as a mix factor, never as a branch. */
    const player = 1 - step(0.5, me);

    const s0 = storageRead(uState, mine);
    const s1 = storageRead(uState, mine + 1);
    const s2 = storageRead(uState, mine + 2);
    const s3 = storageRead(uState, mine + 3);
    let pos = s0.xyz;
    let speed = s1.w;
    let gait = s2.w;
    let vy = s0.w;
    // Where it is going and where it is pointing, as world directions. Two
    // whole slots because they are vectors now rather than angles off the
    // track — see the steering below for why that had to change.
    let courseDir = s3.xyz;
    let headingDir = storageRead(uState, mine + 4).xyz;

    // Nearest ring, by brute force over the whole lap. Tracking the last ring
    // and searching outwards from it would be fewer iterations, but it makes
    // the search stateful — and the one time it matters is the one time that
    // state is wrong, after a fall or a respawn has moved the body somewhere
    // the previous ring says nothing about. A couple of hundred distance tests
    // in a single invocation is not the expensive part of this frame.
    let nearest = 0;
    let nearestD = 1000000;
    for (let i = 0; i < uRings; i += 1) {
      const c = storageRead(uTrack, i * 3);
      const d = length(c.xyz.sub(pos));
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }

    // The surface, interpolated along the segment the body is actually in
    // rather than taken from the nearest ring.
    //
    // **This is what stops the ride juddering.** Snapped to a ring, the floor is
    // a plane that changes every time the nearest ring does — twelve times a
    // second at speed — and consecutive planes differ by up to 2.6 degrees of
    // camber. Camber pivots about the centreline, so the height that step moves
    // you by grows with your distance from it: out by half a road width it is a
    // pop of a quarter of a metre, at frame rate, and the camera is bolted to
    // the body that is popping. Interpolating makes the floor continuous, so
    // there is no boundary left to cross.
    //
    // Which segment: `nearest` is the closest ring, and the body is on one side
    // of it or the other. Projecting onto the chord ahead says which, and picks
    // the pair either side of it. Chosen with mix rather than a branch, and
    // `b = a + 1` is always in range because the CPU repeats ring zero at the
    // end of the buffer.
    const here = storageRead(uTrack, nearest * 3);
    const ahead = storageRead(uTrack, nearest * 3 + 3);
    const forward = step(0, dot(pos.sub(here.xyz), ahead.xyz.sub(here.xyz)));
    const a = mix(max(nearest - 1, 0), nearest, forward);

    const ca = storageRead(uTrack, a * 3);
    const ta = storageRead(uTrack, a * 3 + 1);
    const ua = storageRead(uTrack, a * 3 + 2);
    const cb = storageRead(uTrack, a * 3 + 3);
    const tb = storageRead(uTrack, a * 3 + 4);
    const ub = storageRead(uTrack, a * 3 + 5);
    const seg = cb.xyz.sub(ca.xyz);
    // Clamped, so a body off the end of a segment borrows that segment's end
    // frame rather than extrapolating one that bends away from the road.
    const along = clamp(dot(pos.sub(ca.xyz), seg) / max(dot(seg, seg), 0.0001), 0, 1);

    // The centre runs along the chord, which is not an approximation of the
    // road — it is exactly where the road is. The ribbon is built by joining
    // these same points with straight quads, so physics and geometry agree by
    // construction instead of by being tuned to.
    const centre = vec4(ca.xyz.add(seg.scale(along)), 0);
    const fwdT = normalize(mix(ta.xyz, tb.xyz, along));
    const upT = frameUp(fwdT, mix(ua.xyz, ub.xyz, along));
    const sideT = cross(fwdT, upT);

    // The road's own along-coordinate, hoisted: the boost pads are placed in it
    // and the buffer write at the bottom of the stage reports it. Nothing between
    // here and there moves the body along the ribbon it was measured on.
    const onLap = mix(ca.w, cb.w, along);
    const trackAlong = onLap * uPattern;

    // ── Boost pads ─────────────────────────────────────────────────────────
    // **The pads are not objects. They are a function of where you are.**
    // Nothing is placed, nothing is stored and nothing is searched: a pad exists
    // wherever this arithmetic says one does, and the road shader runs the same
    // arithmetic on the same two coordinates to paint it. That is what keeps a
    // scattering of boosts down two and a half kilometres of track at nought
    // bytes of data — and it is also the only way the two can be guaranteed to
    // agree, which matters more. A pad you can see and cannot use, or use and
    // cannot see, is worse than no pad.
    //
    // The coordinates are the track shader's own: which of twelve columns across
    // the road, and which row of tiles along it. Here they are rebuilt from the
    // body's place on the ribbon rather than interpolated from a vertex, but
    // they are the same numbers — `uPattern` is exactly the factor that puts
    // distance-travelled into the road's lit-panel space.
    //
    // A pad is four columns wide — a third of the road, as asked — so `* 0.25`
    // turns a column into which third it is in, and the whole test is whether
    // that third is the one the seed drew.
    const bRow = floor(trackAlong * 0.4456);
    // One pad slot every 64 rows — about 144 metres, so a lap holds a dozen or
    // two. The hash gives four outcomes and only three of them are lanes: a
    // quarter of the slots draw "no pad here", which is what turns a regular
    // spacing into a scattering without a second hash to pay for.
    //
    // **Thirty rows in, not at the slot's edge, and that is what clears the
    // start line.** With a pad at the front of every slot, slot zero's sat on
    // rows 0, 1 and 2 — the start line itself, with the grid parked a few metres
    // behind it. The field launched straight onto a pad. Seating the pad a third
    // of the way into its slot puts the first one about sixty-five metres past
    // the line, and rows before that fall into slot -1 at an offset no pad
    // covers, so the opening stretch is clear by construction rather than by a
    // special case.
    const bSeat = bRow - 30;
    const bSlot = floor(bSeat * 0.015625);
    const bPick = floor(fract(sin(bSlot * 91.7 + uSeed) * 43758.5) * 4);
    // Three rows long, about seven metres — a bit over two body lengths, which
    // is short enough to be missed and long enough to be aimed at.
    const bOn =
      step(abs(floor((dot(pos.sub(centre.xyz), sideT) / uWidth + 0.5) * 3) - bPick), 0.5) *
      (1 - step(3, bSeat - bSlot * 64));

    // ── The driver ─────────────────────────────────────────────────────────
    // For racer zero this is the keyboard. For the other nine it is this, and it
    // is deliberately the smallest thing that can drive a car: aim at a point
    // some way up the road, steer at it, and lift off when the aim is hard.
    //
    // **The look-ahead is the whole AI.** A racer that steers at the road
    // *under* it corrects late, overshoots, and weaves; one that steers at the
    // road well in front of it turns in early and comes out of a corner already
    // pointed down the next straight. Fourteen rings is far enough to do that
    // and near enough that the target is still on the piece of track the racer
    // is committed to.
    const LOOK = 14;
    const aim = mod(nearest + LOOK, uRings);
    const ac = storageRead(uTrack, aim * 3);
    // A lane of its own, held for the whole race. Nine racers all aiming at the
    // centreline is a single-file train that never overtakes and never touches,
    // which makes both the field and the collisions below invisible. Spread
    // across 55% of the width, they run abreast, and the closing speeds between
    // different lanes are what actually produce contact.
    // Where in the road this one likes to sit, and how fast it is willing to go
    // — both straight off the racer's index rather than out of a hash.
    //
    // **The golden ratio is what makes an index good enough.** Multiplying by
    // 0.618 and taking the fraction walks the unit interval in the most evenly
    // spread order there is: ten racers land at 0, .62, .24, .85, .47, .09, .71,
    // .33, .94, .56 — better distributed than the `fract(sin(...))` hash this
    // replaced, which cost a function and two calls to be arbitrary rather than
    // even.
    const lane = (fract(roll * 7.7) - 0.5) * uWidth * 0.55;
    // Offset in *this* segment's frame rather than the aim ring's. Rebuilding a
    // frame fourteen rings ahead cost a normalise, a frameUp and a cross to
    // answer a question that only decides which side of the road to aim at: on a
    // straight the two frames agree exactly, and in a corner the lane lands a
    // metre or so off where it meant to, which is a racing line either way.
    const aimPt = ac.xyz.add(sideT.scale(lane));

    // How far off the nose the target sits, measured along the exact axis
    // positive steering rotates towards. Taking the sign from the steering's own
    // construction rather than from a cross product and a guess is what makes
    // this correct by build instead of by testing which way the AI drove off.
    const want = normalize(aimPt.sub(pos));
    const lat = dot(want, cross(headingDir, upT));
    const aiSteer = clamp(lat * 3.2, -1, 1);
    // Off the throttle when the nose is a long way from where it wants to be,
    // which is what a corner looks like from here. Without it they arrive at
    // hairpins at top speed, understeer into the rail and fall off the world —
    // and the rails do not stop them, because nothing here knows about rails.
    const aiThrottle = 1 - 0.9 * smoothstep(0.18, 0.62, abs(lat));

    // Each AI is a little slower than the player and a little different from its
    // neighbours, so the field spreads out over a lap instead of staying a lump,
    // and so winning is possible without being trivial. The player is capped at
    // 60 as before — the drag settles it near 55 long before that.
    // Three seconds, counting down, in the sixth slot. `max` rather than a
    // branch: standing on a pad sets the clock to 3 and stepping off it leaves
    // the countdown alone, so a pad taken at an angle across its corner gives
    // the same three seconds as one taken square. Re-arming on every frame of
    // contact is deliberate — a long pad is not a longer boost, it is a boost
    // that starts when you leave.
    // **Armed only once the flag is out.** The pin below overrides the throttle,
    // and the throttle is the only thing the countdown was holding the field
    // with — so a racer sitting on a pad before the start was set to 90 and left
    // the grid on its own. `uGo` on the arming rather than on the pin, so a
    // countdown spent standing on one does not bank three seconds of boost to
    // spend the moment it drops.
    const was = storageRead(uState, mine + 5);
    const boost = max(was.x - dt, bOn * 3 * uGo);
    const bGo = step(0.001, boost);

    // Untouched by the boost. A pad does not persuade a racer to go faster, it
    // *sets* how fast it is going — see the pin below — so there is nothing here
    // for a raised cap to do. What the cap still does is decide how the AI comes
    // back down afterwards: at 90 it is well over its own limit, so the throttle
    // eases off and the racer coasts rather than fighting the drag.
    // Each AI is a little different from its neighbours so the field spreads out
    // over a lap instead of staying a lump.
    //
    // **Raised, because the field was not fast enough to be a race.** It used to
    // top out at 55, which is also where drag alone settles a racer — so the
    // fastest AI was driving at the same speed as a player who never touched a
    // pad, and every pad the player did take was gained against a field that
    // could not answer.
    const cap = mix(PACE - 8 + roll * 16, 60, player);
    // The cap eases the throttle off rather than clamping the speed, and that
    // matters now that a shunt can add speed the racer did not ask for. Clamped,
    // an AI sitting at its cap had any push from behind erased on the very next
    // frame — the shove landed, the buffer was written, and the ceiling took it
    // straight back off. Easing lets it run over its own limit for a second and
    // coast back down, which is what being rear-ended is supposed to look like.
    // Gated for everyone, player and AI alike. A grid where the field creeps
    // away while you wait is not a grid.
    const throttle =
      mix(aiThrottle * (1 - smoothstep(cap - 5, cap, speed)), uThrottle, player) * uGo;
    const steer = mix(aiSteer, uSteer, player);

    // ── Where it points, and where it goes ─────────────────────────────────
    // Both are **world directions**, not angles measured off the track, and
    // that distinction is the whole steering model.
    //
    // Held as angles relative to the tangent, they rotated with the tangent for
    // free: the road bent and the unicorn's velocity bent with it, so letting go
    // of the keys followed the corner round. That is a rail. Held in world
    // space, nothing turns the unicorn but the player — run at a right-hander
    // without steering and you leave by the outside, which is what a road is.
    //
    // Nothing left to clamp, either. A limit only means anything relative to
    // something, and the only thing to measure against was the tangent — which
    // would have dragged the nose round to stay inside the limit and quietly
    // put the rail back. So the nose goes wherever it is steered, all the way
    // round if you hold the key.
    const fresh = 1 - step(0.5, length(courseDir));
    courseDir = mix(courseDir, fwdT, fresh);
    headingDir = mix(headingDir, fwdT, fresh);

    // Steering rotates the nose about the road's normal. Scaled by speed,
    // because a kart that pivots on the spot reads as a bug.
    const grip = min(abs(speed) / 7, 1);
    const turn = steer * dt * 2.6 * grip;
    headingDir = normalize(
      headingDir.scale(cos(turn)).add(cross(headingDir, upT).scale(sin(turn))),
    );

    // Momentum. The direction of travel swings toward the nose at a finite rate
    // rather than snapping to it, so turning the body does not turn the
    // velocity with it — the unicorn keeps going the way it was going and only
    // gradually gets dragged around. That lag *is* the drift.
    //
    // Chasing at a rate rather than by a fixed step per frame, so the slide
    // lasts the same length of real time whatever the frame rate. While the
    // steering is still moving the nose, the course never quite catches up and
    // the slip holds; let go and it closes in about a fifth of a second.
    //
    // **This number is the handling.** It was 3.2 — a 0.31s lag — and that was
    // most of why holding a line through a corner was a fight: you steered, and
    // for a third of a second you kept going the old way, which at 45 m/s is a
    // long way sideways. At 5 the slide is a third shorter and recoverable at
    // any speed the unicorn can reach.
    //
    // Changing it alone would have quietly restyled the drift as well, since
    // what gets drawn is built from the gap this leaves. The exaggeration below
    // is raised to match, so the handling moved and the look did not.
    courseDir = normalize(mix(courseDir, headingDir, 1 - exp(0 - 5 * dt)));

    // Braking bites harder than the throttle pushes, and lifting off is neither
    // — coasting is its own, gentler decay. Quadratic drag on top is what sets
    // the top speed, so there is no separate clamp pretending to be physics.
    //
    // Top speed is where the throttle and the drag cancel, at sqrt(accel/drag),
    // so these two are not independent knobs — 7.5 against 0.0025 settles at
    // about 55, twice the 27 this started at.
    //
    // How *long* it takes to get there is sqrt(accel * drag), and that is the
    // other half of why both moved. Halving the acceleration alone would have
    // dropped the top speed to 39 as well as slowing the climb; halving the
    // drag alongside it holds the top speed where it was and doubles the time
    // to reach it, which is exactly the split asked for. About sixteen seconds
    // now, against eight.
    //
    // Braking is left at 30 and so is now four times the throttle rather than
    // twice it. That is deliberate — an arcade racer wants to be able to stop —
    // but it is a ratio worth knowing has changed.
    //
    // The clamp is a backstop well clear of top speed, not the thing setting
    // it. The reverse end is doing real work though: backing up is drag-free at
    // these speeds, so -7 is the only reason it stops.
    // **The AI need the thrust as well as the cap, or the cap is decoration.**
    // What sets a top speed here is thrust against quadratic drag, and 7.5
    // settles at 54.8 whatever the cap says — so raising an AI's cap past that
    // on its own changes nothing at all. Derived from `PACE` rather than given
    // its own number, at the top of the spread so the quickest AI can still
    // reach its own cap: drag balances thrust at `sqrt(rate / 0.0025)`, so this
    // is that read backwards. The player keeps 7.5 — a pad is worth what it is
    // worth because 90 is so far above what a throttle alone can reach.
    const rate = mix(
      30,
      mix((PACE + 8) * (PACE + 8) * 0.0025, 7.5, player),
      step(0, throttle),
    );
    speed = speed + throttle * rate * dt;
    speed = speed - speed * (1 - step(0.5, abs(throttle))) * dt * 0.9;
    speed = speed - speed * abs(speed) * dt * 0.0025;
    // A backstop well clear of anything the throttle can reach, not the thing
    // setting the top speed — see the ease above.
    // Ninety rather than sixty, and it is still a backstop rather than the thing
    // setting the top speed — it just has to be clear of the boosted speed now
    // instead of the driven one. It matters most in the seconds *after* a boost:
    // a ceiling of 60 would snap a racer coming off a pad straight down to it,
    // and the whole point of the pad is that it lets go gradually.
    speed = clamp(speed, -7, 90);

    // ── The boost, as a held speed ─────────────────────────────────────────
    // **A pad sets the speed rather than adding to it, and then holds it there.**
    // Half again over the sixty this road tops out at, pinned for three seconds
    // however hard the racer is or is not pressing, and then simply released.
    //
    // Released, not ramped: there is no fade term here and there does not need
    // to be one. Drag is quadratic, so at 90 it is pulling about 20 a second
    // against 7.5 of throttle — the racer sheds the difference on its own and
    // settles back at its usual 55 over about three seconds. A pad therefore
    // gives roughly six seconds of being quick for three seconds of being
    // fastest, and the tail is the part that feels like speed.
    //
    // It overrides the throttle, braking included. That is what a boost pad is:
    // you drove onto it, and for three seconds the road is deciding.
    speed = mix(speed, 90, bGo);

    // Both flattened back into the road's surface. This is the one thing the
    // track is still allowed to do to the unicorn's direction, and it is not
    // steering: it tips the direction up and down to follow a climb or a
    // descent, and touches nothing left or right. Skip it and a unicorn
    // cresting a rise keeps aiming at the sky.
    headingDir = normalize(headingDir.sub(upT.scale(dot(headingDir, upT))));
    courseDir = normalize(courseDir.sub(upT.scale(dot(courseDir, upT))));

    pos = pos.add(courseDir.scale(speed * dt));

    // ── Bumping ────────────────────────────────────────────────────────────
    // Every racer against every other, resolved by each one moving *itself*.
    // Nothing reaches across to modify another racer, which is what makes this
    // safe to run in ten invocations at once — and it still comes out symmetric,
    // because the racer on the other side of the contact is running this same
    // loop about this one and reaching the equal and opposite conclusion.
    //
    // **Where you hit decides whether speed changes at all.** Two things happen
    // on contact and they are separate:
    //
    // - *Position* always separates, whatever the angle. Nobody ever ends up
    //   inside anybody.
    // - *Speed* is only traded nose-to-tail. Run into the side of a unicorn and
    //   you knock it across the road and carry on at the speed you arrived at;
    //   run into the back of one and you shunt it forward and lose the speed you
    //   gave it.
    //
    // `nose` is what tells them apart: the contact direction against the
    // direction of travel, so 1 is square in the back or square in the front and
    // 0 is a pure side swipe. Taken absolute, because both halves of a rear-end
    // are the same event seen from either end.
    //
    // The trade itself is the two speeds meeting in the middle — a perfectly
    // inelastic collision, and the reason it needs no sign test. The racer
    // behind is the faster one, so averaging costs it speed; the racer in front
    // is the slower one, so the same average gives speed to it. One expression,
    // and it is correct from both seats at once.
    //
    // **The read here is racy and deliberately so.** These ten invocations share
    // a workgroup with no barrier, so another racer's slot may hold this frame's
    // value or the last one's. At sixty frames a second and fifty-odd units a
    // second that is under a metre against a contact radius of 2.4 — and the
    // alternative, a second dispatch to publish positions before resolving them,
    // is a whole extra pass to buy an accuracy nobody can see.
    //
    // The self-test is `abs(j - me)` rather than a branch: at j == me the gap is
    // zero, which would otherwise register as the hardest possible collision
    // with itself and fire every racer off the track on frame one.
    // Anything this frame worth a knock — a body or the rail. Accumulated
    // rather than tested at the end, because contact with a *particular*
    // neighbour is only known inside the loop below and is gone by the time it
    // finishes.
    let knock = 0;
    for (let j = 0; j < FIELD; j += 1) {
      const away = pos.sub(storageRead(uState, RACER + j * SLOTS).xyz);
      const gap = length(away);
      const hit = step(0.5, abs(j - me)) * step(0.001, gap) * (1 - step(2.4, gap));
      // Divided rather than normalised: at gap zero — self, or two bodies exactly
      // coincident — `hit` is already zero, so this contributes nothing, and the
      // max() keeps the divide itself finite instead of producing the NaN that
      // normalize() would and then spreading it through the whole position.
      const line = away.scale(1 / max(gap, 0.001));
      pos = pos.add(line.scale(hit * (2.4 - gap) * 0.5));
      const nose = abs(dot(line, courseDir));
      const theirs = storageRead(uState, RACER + j * SLOTS + 1).w;
      // Not the whole way to the average in one frame: contact lasts while the
      // two are still overlapping, so a firm shunt applies this several times
      // over and arrives at the average anyway. Going all the way immediately
      // makes a light touch feel like hitting a wall.
      speed = mix(speed, (speed + theirs) * 0.5, hit * nose * 0.5);
      knock = max(knock, hit);
    }

    // What gets *drawn*, and deliberately past even the nose. The gap between
    // the nose and the course is the slip angle, and overstating it is what
    // turns a lag into a visible drift: the unicorn cocks into the corner
    // further than it is really turning, while sliding along the old line.
    // Going straight the two agree, the extrapolation has nothing to stretch,
    // and this is exactly the course.
    //
    // 2.7, up from 1.5, purely to hold the look still while the handling
    // changed. The camera aims along the course, so what a player sees is the
    // angle from the course to this — and tightening the chase from 3.2 to 5
    // shrank the gap this multiplies. The two were solved together to land back
    // on the same 62 degrees of cocked body that was there before.
    //
    // Cannot degenerate, despite the size: the extrapolation is shortest when
    // nose and course agree, where it is exactly one unit long.
    const dir = normalize(courseDir.add(headingDir.sub(courseDir).scale(2.7)));

    // ── Gravity ────────────────────────────────────────────────────────────
    // Into the road, always, and harder where the road is steep.
    //
    // Down-the-normal rather than world-down is not new and was never about
    // loops: a body resting on a camber under world gravity slides, which then
    // needs friction invented to stop it, and into-the-surface costs one vector
    // and no friction at all. What it means on a loop is that it already holds a
    // unicorn to a road that has gone past vertical — the pull follows the
    // surface round, so there is no orientation at which it stops pressing.
    //
    // **What is new is the second term, and it is there because holding on is
    // not the same as holding on hard enough.** A real loop is survived on
    // speed: too slow at the crown and you leave the track. There is no speed
    // term here and there should not be one — falling out of a loop because you
    // lifted off is a simulation answer to an arcade question — so instead the
    // pull ramps up where the road is steep enough for it to matter.
    //
    // `tilt` is the road's own up against the world's, so it is 1 on the flat,
    // 0 on a wall and -1 upside down. Nothing changes until 45 degrees off
    // level, which is past every camber the circuit builds — the ceiling is 0.55
    // radians, about 31 — so ordinary corners feel exactly as they did. Past 45
    // it climbs to two and a half times, and by the time the road is properly
    // inverted a unicorn is stuck to it whatever it is doing.
    const tilt = dot(upT, vec3(0, 1, 0));
    const steep = 1 - smoothstep(0.35, 0.707, tilt);
    vy = vy - 30 * (1 + 1.5 * steep) * dt;
    pos = pos.add(upT.scale(vy * dt));

    // ── The rails hold ────────────────────────────────────────────────────
    // **You cannot leave the road sideways any more. You can only scrub speed
    // against the edge.** Falling off was a real punishment — a respawn at the
    // start line, half a lap gone — for the one mistake a player makes without
    // meaning to, and the AI made it too: hairpins taken a shade wide and a
    // racer simply left the world. What replaced it is a wall you can lean on.
    //
    // A clamp on where the body sits across the road, not a force pushing it
    // back: forces bounce, and bouncing off a rail at speed hands the mistake
    // straight back with interest. Clamped, a unicorn held against the edge just
    // runs along it.
    //
    // 1.2 in from the half-width so the model rides inside the rail rather than
    // hanging over the drop, which at this scale is most of a hoof.
    const off = dot(pos.sub(centre.xyz), sideT);
    const kerb = uWidth * 0.5 - 1.2;
    const held = clamp(off, 0 - kerb, kerb);
    pos = pos.add(sideT.scale(held - off));
    // The cost of leaning on it. Exponential rather than a fixed subtraction, so
    // a graze costs a little and a long scrape down the outside of a corner
    // costs a lot — and it is the same shape as the drag term above, which is
    // what keeps it feeling like the road rather than like a rule.
    const scrape = step(0.001, abs(off - held));
    speed = speed - speed * scrape * dt * 1.6;
    knock = max(knock, scrape);

    // Height above the surface. There is no "is there surface here" test any
    // more: the clamp above guarantees there is.
    const high = dot(pos.sub(centre.xyz), upT);
    const landed = step(high, 0);
    pos = pos.add(upT.scale((0 - high) * landed));
    // Landing zeroes the fall; not landed leaves vy alone, so gravity keeps
    // accumulating. This is where jump used to live — the whole move was this one
    // line launching instead of clamping when the key went down on the same frame.
    //
    // Gravity and the clamp stay. They are not jump machinery: they are what
    // holds the unicorn against a road that climbs, banks and drops away.
    vy = vy * (1 - landed);

    // Far enough under the road to have plainly lost it: back to the start.
    // Unreachable by the sideways route now that the rails hold, and kept as
    // what it always also was — a backstop for a body that ends up somewhere the
    // nearest-ring search cannot explain.
    const lost = step(high, -50);
    const home = storageRead(uTrack, 0);
    pos = mix(pos, home.xyz, lost);
    speed = speed * (1 - lost);
    vy = vy * (1 - lost);
    // Pointed back down the start straight, using ring zero's own tangent
    // rather than the one under the body — which is wherever it fell off, and
    // no longer has anything to do with where it is being put back.
    const homeDir = normalize(storageRead(uTrack, 1).xyz);
    courseDir = normalize(mix(courseDir, homeDir, lost));
    headingDir = normalize(mix(headingDir, homeDir, lost));

    // Legs driven by distance covered rather than by the clock, at 0.6 rad per
    // unit travelled, so the gait keeps pace with the unicorn — but only once it
    // is quick. Under a floor of 20 rad/s it is the clock after all, and that is
    // the point. Speed builds at 7.5 a second from a standing start, so a gait
    // tied strictly to it spends the first seconds of a race barely moving its
    // legs while the body pulls away, which reads as a unicorn being towed
    // rather than one running. At the floor a start is by far the *fastest* the
    // legs ever churn relative to the ground: hooves scrabbling for grip, going
    // nowhere, trying far too hard.
    //
    // The floor is high enough to have swallowed the middle of the range whole.
    // Distance only takes the reins past 33 units, better than half of top
    // speed, so everything from a crawl to a fast cruise now runs at a flat 20
    // and the gentle ramp of leg speed that used to fill that range is gone —
    // deliberately. The legs read as effort, not as a speedometer; the road
    // going past is the speedometer.
    //
    // The floor itself fades in over the first couple of units rather than
    // applying from the first instant of movement, and it has to: standing still
    // means legs that have stopped, and a plain `max` would hold them at full
    // scramble down to a speed of nothing at all. Nothing ever reaches exactly
    // zero to switch on — the throttle-off decay is exponential and only ever
    // approaches it — so a hard test at zero would leave a stationary unicorn
    // running on the spot forever. Fading over 0 to 2 puts a real stop at a real
    // stop, and takes about a quarter second to wind up, which is over before
    // the eye has settled on the legs.
    //
    // Signed, not absolute, so reversing runs the cycle backwards. Backing up
    // with the legs still cycling forwards is a moonwalk, and it is the reverse
    // that gives the game away: the walk the shader picks below zero would be
    // playing in the wrong direction. Backwards has no floor either — nothing
    // about reversing is trying hard — so it is 0.6 per unit all the way down,
    // which tops out at a 4.2 rad/s amble.
    //
    // In rad/s throughout, rather than a floor in speed units multiplied into
    // rad/s afterwards: the 20 is the number that gets tuned by watching the
    // legs, so it is worth being the number that is written down.
    //
    // Doubled in reverse — the animation, not the travel. At 0.6 per unit a
    // backward amble tops out around 4.2 rad/s, which against the speed the road
    // is actually going past reads as a unicorn gliding rearwards with its legs
    // barely bothering. Twice that is a proper backwards scurry, and it costs the
    // physics nothing because `speed` is untouched: the body still backs off at
    // the same rate, the legs just work harder at it.
    const churn = max(abs(speed) * 0.6, 20 * smoothstep(0, 2, speed)) * (1 + step(speed, -0.001));
    gait = gait + sign(speed) * churn * dt;

    // Behind and above the body, along the direction it is *travelling* —
    // `courseDir`, not the nose and not the tangent.
    //
    // It used to sit along the tangent, so the view was always down the road.
    // That only worked while the unicorn could not leave the road. Now that it
    // can, a camera pinned to the tangent would keep staring down a corner the
    // unicorn had just run straight out of, and watch it slide off the edge of
    // the frame.
    //
    // Following the course keeps most of what the tangent gave: the course only
    // parts from the road when the player steers or refuses to, and around a
    // normally-driven lap the two are near enough the same that the camera
    // still reads as looking down the road. Steering does not whip it either,
    // because the course lags the nose by design and the whole thing is
    // smoothed again below. The unicorn still visibly rotates within the frame,
    // since what gets drawn is exaggerated past the course.
    // ── Where behind, and how far ──────────────────────────────────────────
    // Solved against design/mario-kart-driving.jpg rather than dialled in by
    // eye, because three things in that frame are measurable and all three are
    // camera placement:
    //
    //   - the kart's roof sits at 53% down the frame and its wheels at 95%, so
    //     it covers about two fifths of the height and just clears the bottom;
    //   - its centre is therefore at 74% — the player is *low*, not centred, and
    //     the upper half of the screen is track rather than vehicle;
    //   - the ground's vanishing point is at 40%, a shade above the middle,
    //     which is the whole of the downward tilt: `f * tan(pitch)` in clip
    //     space, so 40% fixes the pitch on its own.
    //
    // Pitch settled, the two remaining freedoms — how far back and how high —
    // are fixed by the other two numbers.
    //
    // **The two references do not agree, and the answer is between them.**
    // design/mario-kart-boost-ramp.avif is the same game and a looser shot: the
    // kart covers 29% of the height rather than 42%, with the horizon at 35%
    // rather than 40%. Its centre is at 72% against the other's 74%, which is
    // the useful part — the two disagree about how far back the camera sits and
    // agree almost exactly about how low the player rides. So the height is
    // split between them and the placement is not: 10 back and 5.4 up puts the
    // model's top at 54.0% and its bottom at 92.5%, for 38.5% of the height
    // with its centre at 73.3% and the horizon at 37.8% — inside the span the
    // two references bracket, on all three.
    //
    // **The two points that matter are the horn and the back hooves, not the
    // middle.** A first pass placed the animal as though it were a flat card at
    // its own centre, and it came out a third too close with its legs cut off
    // by the bottom of the screen. A unicorn is three units long and this camera
    // looks down the length of it from a metre or two away: its rump is nearer
    // than its nose by most of a body, and the near end is what fills the frame.
    // Project the extremes instead — (1.44, 3.36) at the horn tip and
    // (-1.52, 0) at the back hooves, in road units after `uScale` — and both
    // land where the reference has them.
    //
    // **The camera went up, not back.** The old placement was 8 back and 3 up
    // aiming 5 ahead at a point one unit off the road — *below* the unicorn's
    // own middle, which is what put the animal dead centre in frame with as
    // much empty sky above it as track. Aiming above it instead is what drops it
    // to the bottom of the picture; the extra height is what stops that from
    // becoming a view of the road ten metres ahead. The pitch came down on the
    // way, from 8.7 degrees to 7.6.
    // ── The kick off a boost pad ──────────────────────────────────────────
    // **Half a second of shake, and it is only half of what sells it.** The
    // other half is already free: the pad sets the speed to 90 in one frame and
    // the camera is an exponential follow, so the unicorn simply leaves — the
    // boom stretches out behind it and reels back in over the next second. That
    // lurch is the warp; this is the rattle on top of it.
    //
    // Two sines at frequencies with no common factor, so the wobble never
    // settles into a rhythm you can hear the loop in, across the road and up
    // rather than along it — a camera that shakes *forwards* reads as the frame
    // rate coming apart rather than as speed.
    //
    // On the eye and not the aim point, so the shake rotates the view a little
    // as well as moving it. Shaking both together is a pure translation, and a
    // pure translation of a camera ten metres back is nearly invisible.
    //
    // The first half second of the three, off a clock that starts at 3 and
    // counts down: full for the first three tenths and eased out by the half
    // second. The boost runs another two and a half seconds after the rattle
    // stops, which is the right way round — the shake is the moment you *hit*
    // the pad, and holding it for the whole three seconds turns an event into a
    // state.
    //
    // Eased out rather than switched off, because a rattle that stops on a frame
    // reads as a dropped frame.
    const jolt = smoothstep(2.5, 2.7, boost) * 0.3;
    const chaseEye = pos
      .sub(courseDir.scale(10))
      .add(upT.scale(5.4 + sin(uTime * 61) * jolt))
      .add(sideT.scale(sin(uTime * 84) * jolt));
    const chaseAt = pos.add(courseDir.scale(8)).add(upT.scale(3));

    // ── The title camera ───────────────────────────────────────────────────
    // Before the flag there is nothing to chase — the field is stood on the grid
    // and the clock is stopped — so the camera circles the pack instead, holding
    // them in frame while the circuit turns behind them.
    //
    // Aimed a little way up the road rather than at the player itself. The
    // player starts at the *back* of the grid, so pointing the camera at it puts
    // nine unicorns off to one side; a third of the grid's length forward is the
    // middle of the pack.
    //
    // The orbit runs off `uTime`, which keeps running before the flag even
    // though `dt` does not — the clock and the simulation step are different
    // things, and this is the one place that difference is load-bearing.
    // High and wide, working its way round the circuit. The selector uses the
    // same camera — the carousel is placed by the unicorn shader, in front of
    // whatever this one is doing, so the shot does not change to accommodate it
    // and the circuit keeps turning behind the roster.
    //
    // Aimed a little way up the road rather than at the player itself. The
    // player starts at the *back* of the grid, so pointing the camera at it puts
    // nine unicorns off to one side; a third of the grid's length forward is the
    // middle of the pack.
    //
    // The orbit runs off `uTime`, which keeps running before the flag even
    // though `dt` does not — the clock and the simulation step are different
    // things, and this is the one place that difference is load-bearing.
    const ang = uTime * 0.32;
    const titleAt = pos.add(courseDir.scale(16));
    const titleEye = titleAt.add(vec3(sin(ang) * 52, 21, cos(ang) * 52));

    const wantEye = mix(chaseEye, titleEye, uTitle);
    const wantAt = mix(chaseAt, titleAt, uTitle);

    // Then chased rather than snapped to. With the floor continuous there is no
    // judder left to hide, so this is not covering for the physics — it is here
    // for the wobble the physics cannot help: frames do not arrive evenly, and a
    // camera pinned exactly to the body renders every hitch in their spacing.
    //
    // `1 - exp(-k*dt)` rather than a fixed fraction per frame, so the camera
    // settles at the same rate in real time whatever the frame rate. A plain
    // lerp constant is silently a different camera at 144Hz than at 60.
    const prevEye = storageRead(uState, 8);
    const prevAt = storageRead(uState, 9);
    const prevUp = storageRead(uState, 10);
    // Snap, don't chase, when there is nothing sane to chase from: the first
    // frame, where the stored camera is still zero, and a respawn, where it
    // would otherwise fly the length of the track to catch up.
    // Snapped rather than chased on the title screen, and that is not a
    // stylistic choice — it is the only thing that makes the orbit move at all.
    // `dt` is zero before the flag, so `1 - exp(-14 * dt)` is zero, and a camera
    // that lerps a zero fraction of the way to its target every frame sits
    // exactly where it was: the orbit was being computed correctly and then
    // thrown away. There is nothing to smooth here anyway — the flight path is
    // an analytic circle rather than a body being simulated.
    const settle = mix(1 - exp(0 - 14 * dt), 1, max(max(1 - prevEye.w, lost), uTitle));
    const eye = mix(prevEye.xyz, wantEye, settle);
    const at = mix(prevAt.xyz, wantAt, settle);
    // The roll is smoothed too, or the camera would still step through the
    // camber changes it is meant to lean into.
    const camUp = normalize(mix(prevUp.xyz, mix(upT, vec3(0, 1, 0), uTitle), settle));

    const f = 1 / tan(0.5);
    const fx = f / uAspect;
    const za = (900 + 0.1) / (0.1 - 900);
    const zb = (2 * 900 * 0.1) / (0.1 - 900);
    const zAxis = normalize(eye.sub(at));
    const xAxis = normalize(cross(camUp, zAxis));
    const yAxis = cross(zAxis, xAxis);

    // near 0.1, far 900, as one expression each: the DSL has no module-level
    // constants, and naming them locally costs more than it explains.
    //
    // The far plane was 500 and the road reached it, so the ribbon began at a
    // hard edge that crawled towards you. Nine hundred pushes that edge past
    // where the eye is looking. It is not free — depth precision is spent on
    // the ratio of far to near, and this widens it from five thousand to one
    // to nine thousand — but the near plane is the expensive end of that
    // fraction and it has not moved.
    storageWrite(uState, mine, vec4(pos, vy));
    storageWrite(uState, mine + 1, vec4(dir, speed));
    storageWrite(uState, mine + 2, vec4(upT, gait));
    storageWrite(uState, mine + 3, vec4(courseDir, trackAlong));
    // Raw distance round the lap rather than the track shader's stretched
    // version: this one is for knowing who is winning, so it wants metres.
    storageWrite(uState, mine + 4, vec4(headingDir, onLap));
    // The contact clock, beside the boost clock and read the same way: the CPU
    // watches for it to go *up*, so one bump is one sound however many frames
    // the bodies stay overlapped. Half a second is long enough that a poll
    // landing six times a second cannot miss it, and short enough that letting
    // go of a rail and touching it again reads as two knocks rather than one.
    storageWrite(
      uState,
      mine + 5,
      vec4(boost, max(was.y - dt, knock * 0.5), 0, 0),
    );

    // ── And what only the player leaves behind ─────────────────────────────
    // The camera and the legacy body slots that the road, the
    // minimap and the debug build still read from fixed positions. All of it is
    // about the one unicorn being watched, so all of it is racer zero's alone —
    // nine more invocations writing their own camera into slot 4 would be nine
    // cameras fighting over one matrix.
    if (player > 0.5) {
      storageWrite(uState, 0, vec4(pos, 0));
      storageWrite(uState, 1, vec4(dir, speed));
      storageWrite(uState, 2, vec4(upT, gait));
      storageWrite(uState, 3, vec4(sideT, vy));
      storageWrite(uState, 4, project(vec4(xAxis.x, yAxis.x, zAxis.x, 0), fx, f, za, zb));
      storageWrite(uState, 5, project(vec4(xAxis.y, yAxis.y, zAxis.y, 0), fx, f, za, zb));
      storageWrite(uState, 6, project(vec4(xAxis.z, yAxis.z, zAxis.z, 0), fx, f, za, zb));
      storageWrite(
        uState,
        7,
        project(
          vec4(0 - dot(xAxis, eye), 0 - dot(yAxis, eye), 0 - dot(zAxis, eye), 1),
          fx,
          f,
          za,
          zb,
        ),
      );
      // The camera's own memory. The 1 in the first slot is the "there is a
      // camera here now" flag the snap above reads on the very first frame.
      storageWrite(uState, 8, vec4(eye, 1));
      // The camera's target, and in the spare word beside it, whether the title
      // card is up. The road reads that word to know whether to cast the
      // unicorn's shadow — see track.shader.ts. It rides here rather than in a
      // uniform of its own because the road already binds this buffer and a
      // uniform would have to be plumbed through the CPU every frame to say one
      // thing the GPU already knows.
      storageWrite(uState, 9, vec4(at, uTitle));
      storageWrite(uState, 10, vec4(camUp, 0));
      // The spare word on the course direction carries how far along the road the
      // unicorn is, in the units the track shader draws in, so the model can be
      // lit by the panel it is standing on. The two ring records either side of it
      // carry real distances in their own spare words and the segment is already
      // solved for, so this is an interpolation of numbers that were sitting there
      // — no second search, and exact rather than ring index times a nominal
      // spacing, which the rings do not actually have.
      storageWrite(uState, 11, vec4(courseDir, trackAlong));
      storageWrite(uState, 12, vec4(headingDir, 0));

    }
  },
});
