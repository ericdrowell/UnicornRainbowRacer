import {
  shader,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  sign,
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
    uBase: 'float',
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
    /** Tile rows to a pickup slot — see SLOT_ROWS in game.js. */
    uRows: 'float',
    /**
     * The field's top-speed multiplier for this circuit — the second number of
     * the circuit's row in src/circuits.js. 1 would be parity with the player.
     *
     * **Last in the block**, like everything added here: the uniforms are
     * positional and game.js fills them by index, so anything inserted above
     * silently repoints every write below it.
     */
    uHand: 'float',
  },
  storage: { uState: 'vec4', uTrack: 'vec4' },
  workgroupSize: [10, 1, 1],

  compute(
    { uState, uTrack, uDt, uThrottle, uSteer, uAspect, uRings, uWidth, uPattern, uBase, uRoll, uRows, uHand, uTime, uTitle, uGo },
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
    const SLOTS = 7;

    /**
     * **Top speed on the throttle, before any handicap.** Metres a second.
     *
     * The drag term below is derived from it, so this is where drag alone
     * settles a unicorn racing at handicap 1 — which is the player, who has no
     * cap at all and is only ever slowed by the air. A boost is half again on
     * top of it, so turning this scales the whole race.
     */
    const TOP_SPEED = 60;
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
    /**
     * This racer's own ceiling.
     *
     * **One number, and it moves everything that is a speed.** The drag term is
     * written as `7.5 / top²` so that terminal velocity *is* `top` — throttle
     * and drag cancel at exactly that — and the boost pin and the backstop are
     * both multiples of it. So raising this raises the whole speed range
     * together rather than lifting one number into another's ceiling.
     *
     * The player is always 1: `mix(uHand, 1, player)`. That is what makes
     * TOP_SPEED the player's number and this the field's.
     */
    const top = TOP_SPEED * mix(uHand, 1, player);

    const s0 = storageRead(uState, mine);
    const s1 = storageRead(uState, mine + 1);
    const s2 = storageRead(uState, mine + 2);
    const s3 = storageRead(uState, mine + 3);
    let pos = s0.xyz;
    let speed = s1.w;
    let gait = s2.w;
    const wasRing = s0.w;
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
    // **Near where it was last frame, and nowhere else.** This used to scan
    // every ring on the track and take the closest in three dimensions, which is
    // right only while the road never passes near itself. Circuit two crosses
    // over — and on the deck above, a ring on the deck below can be the nearer
    // one. The moment it was, the body's idea of "the road" moved to the lower
    // segment, the floor came with it, and the unicorn dropped onto the road
    // underneath. Nothing was broken by it; the search was simply answering a
    // question that has two right answers and picking by distance.
    //
    // Continuity is the missing constraint: a body sixty metres up cannot have
    // arrived on a segment it was not on last frame. So the ring it found last
    // time rides in `.w` of the word its position goes into, and the search
    // starts there and looks eight either way. Sixteen rings is 32 metres of
    // road against the six a frame can cover at twice top speed with `dt`
    // clamped — five times the worst case, and the overpass is hundreds of rings
    // away in lap distance however close it is in space.
    //
    // It is also seventeen reads a racer instead of one per ring.
    let nearest = 0;
    let nearestD = 100;
    for (let k = 0; k < 17; k += 1) {
      const i = mod(wasRing + k + uRings - 8, uRings);
      const c = storageRead(uTrack, i * 3);
      const d = length(c.xyz.sub(pos).add(courseDir));
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }

    const a = nearest;
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
    // **Through the gate is a boost, and the gate is the lap line.** `onLap` only
    // ever climbs — the heading wall below means nobody drives backwards — so the
    // one frame it comes out *smaller* than last frame's is the frame the line
    // was crossed. No band, no lane test and no slot: the gate spans the whole
    // road, so passing under it is the same event as starting a new lap.
    //
    // Last frame's rides in `.w` of the same word this stage stores the heading
    // in, which is written at the very bottom of this file — so the read here is
    // genuinely the previous frame's and not this one's.
    //
    // It cannot misfire on the first frame, when both are nought and `step`
    // answers 1, nor before the flag, when `dt` is nought and `onLap` cannot move.
    const crossed = 1 - step(storageRead(uState, mine + 4).w, onLap);
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
    // **Read, not hashed.** This used to be `fract(sin(slot * k + seed))`,
    // evaluated identically here and in the road shader, which is what made the
    // ring you could see the ring that boosted you. A ring is geometry now and
    // geometry is built on the CPU, and a hash multiplied by 43758 does not
    // survive the trip from JavaScript's doubles to a shader's floats — a
    // last-bit difference comes out a lane apart. So game.js decides, and both
    // stages read the same table off the end of the road buffer.
    //
    // Seated 31 rows into the slot, which is where the ring is drawn: the vertex
    // stage puts it at `slot * 64 + 32`, the middle of this three-row window. Get
    // that offset wrong and the boost fires seventy metres before the ring.
    // Rows before the first ring fall into slot -1 and are clamped to 0, whose
    // lane the table always sets to "none" — so the clamp cannot invent a ring
    // at the start line.
    //
    // The same clamp protects the stars below, for the same reason: ORB_LANE is
    // filled with "none" and the first run is placed four slots in, so a row
    // before the first star clamps to a slot that has none.
    const bSeat = bRow - 7;
    const bSlot = max(floor(bSeat / uRows), 0);
    // **The whole of what this slot holds, in one read.** `.x` is the lane, 3
    // for nothing; `.y` is the type, 0 a ring and 1 a star; `.z` is when the
    // star in it was collected, nought until it was. Rings and stars were two
    // tables with two seats and two hitboxes, and everything below this line was
    // written twice — for two objects that are both "a thing on a piece of road
    // in one of three lanes". They are one thing now, and this is the read.
    const rec = storageRead(uTrack, uBase + bSlot);
    // Three rows long, about seven metres — a bit over two body lengths, which
    // is short enough to be missed and long enough to be aimed at. A pickup is a
    // box and missing one is the box either side of it — both are answered by
    // where the body is, this frame, and neither needs to remember anything.
    const band = 1 - step(3, bSeat - bSlot * uRows);
    // Which third of the road the body is in, against which third the pickup is
    // in. One question, asked once, for both kinds.
    const mySide = floor((dot(pos.sub(centre.xyz), sideT) / uWidth + 0.5) * 3);
    const onLane = step(abs(mySide - rec.x), 0.5);
    // Touched *something*. What it was is one multiply away.
    const got = onLane * band;
    const isStar = rec.y;
    const bOn = got * (1 - isStar);

    // ── Stars ──────────────────────────────────────────────────────────────
    // **Slot 6 holds everything star-shaped, and it is read once here.** `.x` is
    // the slot last collected, `.z` the run's clock, `.w` the rainbow phase it
    // has banked.
    const prev = storageRead(uState, mine + 6);
    // The boost word, read here rather than at the pad below because `.w` of it
    // is the gauge and the gauge is needed now. One read serves both.
    const was = storageRead(uState, mine + 5);
    const onStar =
      got *
      isStar *
      // **A pickup counts once, and twice over.** `prev.x` is the slot last
      // collected, so the three frames a body spends inside the band bank one;
      // `.z` of the slot's own row is the time it was taken, so a star driven
      // over, left, and come back to on the next lap stays taken. The first
      // alone was not enough once a collected star started vanishing — it would
      // have been a pickup off a piece of empty road.
      step(0.5, abs(bSlot - prev.x)) *
      (1 - step(0.001, rec.z)) *
      // **The player's alone.** The field went on collecting after star power
      // became the player's, which made nine unicorns who each wanted four
      // compete for stars they could never spend — they stripped the road ahead
      // and the player arrived at empty slots. Collecting something you cannot
      // use is not a strategy, it is a denial, and it was invisible: the star
      // simply was not there.
      player *
      uGo;
    // **Ten, and ten is a full gauge.** `was.w` is a charge meter rather than a
    // count: a star is a tenth of it, and an eleventh star on a full gauge is
    // simply nothing. `min` rather than a wrap, so running over one at 100% does
    // not empty you.
    //
    // The ten is `CELLS` in src/text.js, which is where it is written down and
    // which generates the gauge's rows from it. It is a literal here because a
    // shader compiles on its own and cannot read that file — so if it moves,
    // this and the test below move with it.
    const stars = min(was.w + onStar, 10);

    // ── Star power ─────────────────────────────────────────────────────────
    // **Seven seconds of being the hazard instead of avoiding it.** The clock
    // is one word — .z of slot 6, counting down — and everything the state does
    // is read off it: twice the speed here, the flashing in unicorn.shader.ts,
    // the warp streaks in sky.shader.ts, and the free contact in the collision
    // loop below. Dead is .z at zero, which is also how it starts, so nothing
    // needs initialising.
    //
    // **It arms itself, and that is the whole of the interaction.** There was a
    // button once — a full gauge lit a prompt and the player pressed space to
    // let a beam off — and a power-up you have to remember to spend is a power-
    // up that sits unspent while the player drives. Collecting the fourth star
    // *is* using it, so the gauge is a countdown to something happening rather
    // than a resource to manage, and the road ahead is the only thing to think
    // about.
    //
    // `1 - alive` is not redundant even though the gauge empties on the same
    // frame: `stars` here is this frame's count, and without the gate a star
    // collected on the last frame of a run would re-arm it from a gauge that is
    // about to be zeroed anyway.
    //
    // 9.5 rather than 10 for the same reason every threshold in this file is
    // half a step short of the integer it means: `stars` is a float that has been
    // through a `min` and an add, and testing it against its own exact value is
    // asking whether two floats are equal.
    const alive = step(0.001, prev.z);
    const engage = step(9.5, stars) * (1 - alive) * player * uGo;
    // **6.4 is not a feel number, it is the song's length.** The star track is
    // one 32-row pattern at 150bpm — 8 beats, 3.2 seconds — and the run is two
    // turns of it, so the music ends exactly where the power does rather than
    // being cut mid-phrase. Anything that does not divide the loop reads as the
    // sound breaking rather than as a power-up ending.
    //
    // Change the song's tempo, its length or the number of turns and this has to
    // move with it — and so does the ramp in unicorn.shader.ts, which fades the
    // flash in from this value and is silent for the whole opening of a run if
    // it is left behind.
    const starClock = mix(max(prev.z - dt, 0), 6.4, engage);
    const starGo = step(0.001, starClock);
    // **`.w` is how long this racer has spent starred, ever, and it only goes
    // up.** The road's rainbow flows at a phase of `uTime * 12` and star power
    // doubles that — but a *rate* cannot be doubled in a shader that computes
    // phase as rate times time, because the phase jumps the instant the rate
    // does, and a rainbow that jumps reads as a dropped frame rather than as a
    // surge. So the extra speed is delivered as extra *phase*: this word is the
    // integral of the second twelve panels a second, added on in the track and
    // unicorn shaders.
    //
    // Accumulated rather than derived from the clock. `7 - clock` would have
    // done the same job for one run and then snapped back by a whole run's
    // worth of phase at the start of the next one, and there are three runs in a
    // gauge-and-a-half of stars. This only ever increases, so there is no
    // moment anywhere that it steps.
    const starNow = vec4(mix(prev.x, bSlot, onStar), 0, starClock, prev.w + dt * starGo);
    storageWrite(uState, mine + 6, starNow);
    // **The moment of collection, written back onto the star itself.** A taken
    // star spins up and vanishes rather than simply being gone on the next
    // frame, and the only thing that can drive that is the star knowing when it
    // was touched — so the time goes into the spare `.z` of its own row in the
    // pickup table, which the track shader is already reading `.x` and `.y` out
    // of. Nought means never taken, and `uTime` is never nought once a race is
    // running, so the sentinel costs nothing.
    //
    // **Guarded, and it has to be.** This is the one write in this shader that
    // is not to a word the invocation owns: ten racers share the lane table.
    // `onStar` already carries `player`, so exactly one invocation on exactly
    // one frame reaches this — without the guard, the other nine would read the
    // row and write it straight back every frame, and the player's timestamp
    // would last until whichever invocation happened to run last that frame
    // undid it.
    //
    // The row is already in hand from the hitbox above, so this is a write and
    // not a read and a write.
    if (onStar > 0.5) {
      storageWrite(uTrack, uBase + bSlot, vec4(rec.x, rec.y, uTime, rec.w));
    }

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
    // ── Going for the rings ────────────────────────────────────────────────
    // **The field aims at the next ring, not at a lane of its own.** Without
    // this the AI take whichever rings happen to fall in the lane they were born
    // in — about a third of them, by luck — and the one mechanic the race is
    // about is something only the player is playing. Steering for them is what
    // makes the ring in front of you a thing worth reaching first.
    //
    // The next *ring*, which on a grid this fine is not the next slot. Rings
    // sit on every fourth one — see RING_EVERY in game.js — so rounding this
    // slot down to a multiple of four and stepping on by four lands on the ring
    // ahead however far into the group of four the racer happens to be. The
    // three slots it skips are where a run of stars goes, and the field cannot
    // collect those: steering nine racers toward a pickup they cannot take is a
    // swerve with nothing on the end of it.
    //
    // There is a long way to line up — better than two hundred metres between
    // rings — which is why nothing here needs to be clever about when to start
    // moving. The steering below is a proportional chase on an aim point;
    // handing it a lane is the whole of it.
    //
    // Their own wander survives at a third of its width, kept rather than
    // dropped so nine racers converging on the same nine-metre ring arrive
    // spread across it instead of stacked on its centre line, shunting each
    // other out of a boost they all earned.
    const wander = (fract(roll * 7.7) - 0.5) * uWidth * 0.5;
    const next = storageRead(uTrack, uBase + (floor(bSlot / 4) + 1) * 4).x;
    // The ring, or the wander.
    const lane = mix(
      wander,
      ((next - 1) * uWidth) / 3 + wander * 0.3,
      1 - step(2.5, next),
    );
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
    const aiSteer = clamp(lat * 3, -1, 1);
    // Off the throttle when the nose is a long way from where it wants to be,
    // which is what a corner looks like from here. Without it they arrive at
    // hairpins at top speed, understeer into the rail and fall off the world —
    // and the rails do not stop them, because nothing here knows about rails.
    const aiThrottle = 1 - 0.9 * smoothstep(0.18, 0.62, abs(lat));

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
    const boost = max(was.x - dt, max(bOn, crossed) * 3 * uGo);
    const bGo = step(0.001, boost);

    // **The field has no speed handicap.** Every rival used to race under a
    // ceiling drawn between 0.7 and 0.95 of TOP_SPEED, with two of the nine
    // pinned to the bounds so both ends of the range were always actually raced.
    // The ceiling eased the throttle off as a racer approached it rather than
    // clamping the speed, so a shunt from behind was not erased on the next
    // frame.
    //
    // All of it is gone. Every unicorn now runs the player's physics with
    // nothing taken off — the same thrust, the same drag, the same ceiling — and
    // drag alone settles the whole field at the same speed. What separates them
    // is what they do with it: the line they take, when they lift for a corner,
    // and which rings they reach.
    //
    // That makes the field a lump by default, and that is the point. The spread
    // has to come from something deliberate now, rather than from a number
    // quietly holding nine racers back.
    const throttle = mix(aiThrottle, uThrottle, player) * uGo;
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
    const grip = min(speed / 7, 1);
    const turn = steer * dt * 2.5 * grip;
    headingDir = normalize(
      headingDir.scale(cos(turn)).add(cross(headingDir, upT).scale(sin(turn))),
    );
    // **And it can never come round past the road.** The rotation above is free
    // — a held steer integrates without limit — so a player who leant on one
    // arrow for two seconds turned all the way round and set off the wrong way
    // down the track, with the lap counter, the AI's aim and the camera all
    // still believing in the direction they were built for. Nothing caught it,
    // because nothing was watching for it.
    //
    // The fix is a wall rather than a correction: the heading's component along
    // the road's own forward is held at or above 0.34, so a turn that would take
    // it past about seventy degrees slides along the limit instead of through
    // it. `min(·, 0)` makes the whole term vanish for any heading already inside
    // the wall, which is every heading anybody drives with — you have to be
    // trying to feel this at all.
    //
    // Seventy and not ninety: at ninety the unicorn is broadside with the road
    // going past its flank and the nose is a coin toss away from the wrong side.
    // Seventy is far more than a corner ever asks for and still plainly forward.
    //
    // A wall on the *drawn* heading, not on the steering, so the input stays
    // exactly as responsive as it was up to the point it stops.
    headingDir = normalize(headingDir.sub(fwdT.scale(min(dot(headingDir, fwdT) - 0.3, 0))));

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

    // Lifting off is not braking, it is its own gentler decay. Quadratic drag on
    // top is what sets the top speed, so there is no separate clamp pretending
    // to be physics.
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
    // **One rate, where there were two.** It was `mix(30, 7.5, step(0, throttle))`
    // — thirty for a brake and seven and a half for the throttle — and with the
    // brake key gone there is nothing on this road that can make `throttle`
    // negative: the player's is `held('ArrowUp')`, nought or one, and the AI's
    // is a smoothstep between 0.1 and 1. The test could only ever answer one
    // way.
    const rate = 7.5;
    speed = speed + throttle * rate * dt;
    speed = speed - speed * (1 - step(0.5, throttle)) * dt * 0.9;
    // **One drag term for the whole field, so acceleration and deceleration are
    // the same for everyone and only the cap differs.**
    //
    // Thrust against quadratic drag sets both how hard a racer pulls from a
    // standstill and where it stops accelerating, and those are the same number
    // — so the first attempt at a faster field raised the AI's thrust, which
    // gave it two and a half times the player's launch and made the flag look
    // like nine rockets and a pony. The second moved the difference to drag,
    // which fixed the launch and left the AI coasting differently.
    //
    // Neither is needed. One drag term for the whole field means every unicorn
    // accelerates and coasts identically, and the only thing that differs is
    // where a rival's throttle eases off. Read backwards out of the balance — a
    // racer settles at `sqrt(rate / c)` — so `c` is the number that puts the
    // player exactly at `TOP_SPEED`, with no cap of their own to do it.
    speed = speed - speed * speed * dt * (7.5 / (top * top));
    // A backstop well clear of anything the throttle can reach, not the thing
    // setting the top speed — see the ease above.
    // Ninety rather than sixty, and it is still a backstop rather than the thing
    // setting the top speed — it just has to be clear of the boosted speed now
    // instead of the driven one. It matters most in the seconds *after* a boost:
    // a ceiling of 60 would snap a racer coming off a pad straight down to it,
    // and the whole point of the pad is that it lets go gradually.
    // Twice `TOP_SPEED` now rather than half again: star power pins higher than
    // a boost pad does, and a backstop below the thing it is backstopping is
    // not a backstop, it is a governor that silently caps the power-up.
    //
    // **Nought at the bottom, where it used to be -7.** The brake is a brake and
    // not a reverse gear: held past a standstill it used to carry a racer
    // backwards at seven metres a second, which is a lap counter running the
    // wrong way and a player who has no idea they asked for it. There is nothing
    // on this road that reversing solves — the rails hold you on it and a spin
    // has been impossible since the heading gained its wall — so the gear can
    // go. Braking now decelerates to a stop and holds there.
    speed = clamp(speed, 0, top * 2);

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
    speed = mix(speed, top * 1.5, bGo);
    // **And star power pins higher still, after the pad rather than before it.**
    // Both are held speeds and both override the throttle, so whichever is
    // written last is the one that counts — and taking a boost pad while starred
    // should not slow you down to 90. Twice the sixty this road tops out at, for
    // the whole run, which is the "twice as fast" half of the power-up
    // and the reason the ceiling above had to move.
    speed = mix(speed, top * 2, starGo);
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
    // - Speed changes once per substantial nose-to-tail contact: the hitter
    //   loses half, while the horse ahead gains up to 25%, capped at top speed.
    // `nose` is signed: positive means the other horse is behind this one;
    // negative means it is ahead. Its absolute value measures how square the
    // impact is, with zero meaning a side swipe.
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
    // Signed body contact this frame. Accumulated
    // rather than tested at the end, because contact with a *particular*
    // neighbour is only known inside the loop below and is gone by the time it
    // finishes.
    let knock = 0;
    // Which way a starred racer is currently shoving this one: 0 for nobody,
    // otherwise -1 or 1 for the side of the road to be thrown at. Only racer
    // zero can ever be starred, so this is 0 or ±1 and never sums.
    let bull = 0;
    for (let j = 0; j < FIELD; j += 1) {
      const away = pos.sub(storageRead(uState, RACER + j * SLOTS).xyz);
      const raw = length(away);
      // **Measured in barrel widths, not metres.** A sphere of 2.4 was the old
      // test, and a unicorn is not a sphere: its barrel is 2.08 long and 1.22
      // wide once the model scale is in, so a radius that let two of them pass
      // nose to tail held them 2.4 apart side by side — nearly twice the gap
      // there should be, and the space between them was visible.
      //
      // Dividing the separation by the barrel's own half-extents along each axis
      // turns the box into a unit sphere, so one comparison against 1 does the
      // whole job. It is an ellipsoid rather than a box, which differs from one
      // only at the corners — and a corner of a barrel is a haunch.
      //
      // Split on this racer's own heading rather than each pair's. On a road
      // everyone points much the same way, and a per-pair frame would mean
      // reading the other's course inside the loop for a difference nobody could
      // see in a photograph.
      const nos = dot(away, courseDir);
      const sway = away.sub(courseDir.scale(nos));
      const gap = sqrt((nos * nos) / 4 + dot(sway, sway) / 1.5);
      const hit = step(0.5, abs(j - me)) * step(0.001, raw) * (1 - step(1, gap));
      // Divided rather than normalised: at gap zero — self, or two bodies exactly
      // coincident — `hit` is already zero, so this contributes nothing, and the
      // max() keeps the divide itself finite instead of producing the NaN that
      // normalize() would and then spreading it through the whole position.
      const line = away.scale(1 / max(raw, 0.001));
      // The overlap is in those same barrel units, so it is put back into metres
      // on the way out — 0.9 is about the mean half-extent, which is what makes
      // a shove separate them at the rate it used to.
      pos = pos.add(line.scale(hit * (1 - gap) * 0.9));
      const nose = dot(line, courseDir);
      // **Star power costs nothing to spend.** A starred unicorn ploughs
      // through the field rather than bouncing off it: the bodies still
      // separate, but the speed response and the mistake bell are both called off.
      // Being billed for the power-up is not the power-up.
      const free = starGo;
      // **Bulldozed.** Touching a starred racer throws this one at the rail —
      // the whole of what star power does to the field, and it does not touch
      // their speed: they are shoved aside, not stopped, and carry on racing
      // from wherever they end up. Being run off your line at ninety metres a
      // second costs you the corner without needing a penalty attached.
      //
      // `line` points from the other body to this one, so its side-of-road
      // component is already "away from whatever hit me". The sign is all that
      // is taken and not the size: a rear-end shunt has almost no lateral
      // component, and a bulldozer that only works side-on is not a bulldozer.
      // `step(0, ·) * 2 - 1` is the sign, which this DSL has no operator for.
      bull =
        bull +
        hit *
          step(0.001, storageRead(uState, RACER + j * SLOTS + 6).z) *
          (step(0, dot(line, sideT)) * 2 - 1);
      // Only substantial front/back contact triggers a response. Side swipes
      // separate the bodies without trading speed, and repeated overlap does
      // not compound the initial penalty or rear-hit boost.
      // Signed contact: +1 means hitting a horse ahead, -1 means being hit
      // from behind. Front contact takes priority in a simultaneous pile-up.
      knock = mix(knock, -sign(nose),
        hit * step(0.5, abs(nose)) * (1 - free) * step(knock, 0));
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


    // ── The rails hold ────────────────────────────────────────────────────
    // **You cannot leave the road sideways, and touching the edge costs you
    // nothing.** Falling off was a real punishment — a respawn at the start
    // line, half a lap gone — for the one mistake a player makes without meaning
    // to, and the AI made it too: hairpins taken a shade wide and a racer simply
    // left the world. What replaced it is a wall you can lean on.
    //
    // **The wall used to scrub speed and no longer does.** On the opening
    // circuit that read as a fair cost for a wide line; across a series with
    // loops and corkscrews in it, the edge is somewhere the road puts you rather
    // than somewhere you chose to go, and being slowed for it is being taxed on
    // the track's geometry. The clamp stays because falling off is worse than
    // either — it just does its job silently now.
    //
    // Nothing downstream reads the contact any more, which is the point: it is
    // gone from the speed, gone from `knock`, and therefore gone from both the
    // mistake cue and the halving. A rail that costs nothing must not ring a
    // bell that says it did.
    //
    // A clamp on where the body sits across the road, not a force pushing it
    // back: forces bounce, and bouncing off a rail at speed hands the mistake
    // straight back with interest. Clamped, a unicorn held against the edge just
    // runs along it.
    //
    // 1.2 in from the half-width so the model rides inside the rail rather than
    // hanging over the drop, which at this scale is most of a hoof.
    const off = dot(pos.sub(centre.xyz), sideT);
    const kerb = uWidth * 0.5 - 1;
    // **The shove rides in the rail's own clamp, because it is the same word.**
    // Both are answering "where across the road is this body allowed to be", so
    // a bulldozed racer is one whose answer has moved to the kerb — no lateral
    // velocity to carry, no clock to count down, nothing to store between
    // frames.
    //
    // Six tenths of the way there per frame of contact. Contact lasts two or
    // three frames at the closing speed a starred player arrives with, which
    // compounds to most of the road: from the middle they are at the rail and
    // pinned there while the player is still alongside. It reads as being swept
    // aside rather than nudged, and it stops dead the moment the contact does.
    const held = clamp(mix(off, kerb * bull, abs(bull) * 0.6), 0 - kerb, kerb);
    pos = pos.add(sideT.scale(held - off));

    // One response per continuous contact: halve the hitter's speed, or give
    // the horse ahead up to 25% extra speed, capped at normal top speed.
    // Existing power-up speed is preserved. A rear hit never rings the mistake cue
    // or cancels a ring boost. Signed last-frame contact prevents compounding.
    const impact = knock * (1 - abs(was.z));
    const bang = max(impact, 0);
    speed = min(speed * (1 + 0.25 * max(-impact, 0)), max(speed, top)) * (1 - 0.5 * bang);

    // Height above the surface. There is no "is there surface here" test any
    // more: the clamp above guarantees there is.
    // ── On the road, and only on the road ──────────────────────────────────
    // **The body is placed on the surface rather than pulled towards it.** There
    // was a whole vertical simulation here: a fall speed integrated against
    // gravity down the road's own normal, a landing test that caught the body
    // when it reached the surface and zeroed the fall, and a fifty-metre
    // backstop that teleported anything plainly lost back to the start line.
    //
    // All of it existed to serve a state the game does not have. Nothing jumps,
    // nothing is launched, there is no ramp and no lip — the road is a ribbon
    // and a unicorn runs along it. The airborne case was only ever reached
    // transiently, cresting a rise where the surface dropped away faster than
    // gravity brought the body down, and what it bought for those few frames was
    // a hover of a few centimetres nobody could see. What it cost was a float of
    // state, an integration, two thresholds, a recovery path, and a way for a
    // body to be somewhere the road is not.
    //
    // One projection instead: take the body's height above its segment's plane
    // and subtract it. The lateral offset is untouched, because it is along
    // `sideT` and this only moves along `upT` — the rails above have already
    // said which lane it is in, and this says nothing about that.
    //
    // It works on a banked road and through a loop for the same reason gravity
    // did: `upT` is the road's own up, carried round with the surface, so there
    // is no orientation at which this stops meaning "stand on it".
    pos = pos.sub(upT.scale(dot(pos.sub(centre.xyz), upT)));

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
    // It doubled below nought once, so a unicorn backing up scurried rather than
    // gliding rearwards with its legs barely bothering. `speed` cannot go below
    // nought any more — the brake is gone and the clamp floors it — so the
    // doubling, the `abs` and the `sign` were all asking about a direction the
    // body no longer has.
    const churn = max(speed * 0.6, 20 * smoothstep(0, 2, speed));
    gait = gait + churn * dt;

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
    // Two things rattle the camera and they share the one term: the first half
    // second of a boost, and star power coming on. `star.z` starts at 7 and
    // counts down, so this is the first quarter second of a run — long enough to
    // land as a kick, short enough not to blur the road you are about to drive
    // down at twice the speed. The other six and three quarter seconds are
    // steady, which is what makes the moment it arrives read as an event rather
    // than as the camera having come loose.
    //
    // **The two no longer share an amplitude, and star power's is much the
    // bigger.** They did share one, at the 0.3 metres a boost pad has always
    // been worth, and at that size the kick was there but nobody found it: a pad
    // is a thing that happens *to* you every lap and wants a nudge, while star
    // power is the rules changing and wants to be felt. 0.75 metres over 0.43
    // seconds against 0.3 over 0.2 — two and a half times the throw for twice as
    // long, which reads as a thump rather than a rattle and still settles well
    // before the first corner arrives at twice the speed.
    //
    // **Star power's is two terms, because it has to last and cannot last at
    // full strength.** A pad is an event and gets one shape: a kick that decays.
    // A run is a six-second state, and the shake has to be up for all of it —
    // but 0.75 metres of throw held for that long while the road goes past
    // at twice speed is not exciting, it is unreadable, and it is the kind of
    // thing that makes people put the controller down.
    //
    // So: a low rumble held for the whole run, and the big kick laid on top of
    // it for the first half second. Together they still reach the same 0.75 at
    // the moment of engaging, and the body of the run sits at 0.18 — enough that
    // the camera never settles and the player can feel the state continuing,
    // little enough that the road stays sharp enough to drive.
    //
    // The rumble eases out over the last third of a second rather than stopping,
    // for the same reason the boost's does: a shake that ends on a frame reads as
    // a dropped frame. And it is nought at a clock of nought, so a racer with no
    // star power gets nothing from either term.
    const jolt =
      smoothstep(2.5, 2.7, boost) * 0.3 +
      smoothstep(6.55, 6.98, starNow.z) * 0.57 +
      smoothstep(0, 0.35, starNow.z) * 0.18;
    const chaseEye = pos
      .sub(courseDir.scale(10))
      .add(upT.scale(5 + sin(uTime * 60) * jolt))
      .add(sideT.scale(sin(uTime * 60) * jolt));
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
    const ang = uTime * 0.3;
    const titleAt = pos.add(courseDir.scale(16));
    const titleEye = titleAt.add(vec3(sin(ang) * 52, 20, cos(ang) * 52));

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
    const settle = mix(1 - exp(0 - 14 * dt), 1, max(1 - prevEye.w, uTitle));
    const eye = mix(prevEye.xyz, wantEye, settle);
    const at = mix(prevAt.xyz, wantAt, settle);
    // The roll is smoothed too, or the camera would still step through the
    // camber changes it is meant to lean into.
    const camUp = normalize(mix(prevUp.xyz, mix(upT, vec3(0, 1, 0), uTitle), settle));

    const f = 1 / tan(0.5);
    const fx = f / uAspect;
    const za = 0 - 1.0002;
    const zb = 0 - 0.2;
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
    // `.w` was the fall speed; it is the ring this racer was found on, which is
    // where next frame's search starts. See the window at the top.
    storageWrite(uState, mine, vec4(pos, nearest));
    storageWrite(uState, mine + 1, vec4(dir, speed));
    storageWrite(uState, mine + 2, vec4(upT, gait));
    storageWrite(uState, mine + 3, vec4(courseDir, trackAlong));
    // Raw distance round the lap rather than the track shader's stretched
    // version: this one is for knowing who is winning, so it wants metres.
    storageWrite(uState, mine + 4, vec4(headingDir, onLap));
    // The mistake clock, beside the boost clock and read the same way: the CPU
    // reads as a level rather than an edge, and rate-limits it. Two tenths of a
    // second is long enough that a poll landing six times a second cannot step
    // over a one-frame knock, and short enough that a single knock is gone before
    // the limiter would let a second sound through — so one bump is one sound and
    // a rail leant on is a run of them.
    //
    // **One clock for all three, because they are one thing to the player.**
    // Clipping a rival, leaning on the rail and driving past a ring are the same
    // sentence — that cost you — and giving each its own cue would be three
    // sounds saying it. The two that *are* different in kind, a ring taken and a
    // ring passed, already sound different.
    //
    // **A miss used to be a state machine and did not need to be.** It watched
    // for the moment a racer left a ring's slot without having been on the ring,
    // which meant carrying the slot and a taken-flag packed into a spare word —
    // and it fired in the wrong place, because a ring sits at the *front* of its
    // slot: leaving the slot happens a hundred and thirty metres later, which is
    // exactly where the next ring is. It rang for the ring you were arriving at
    // rather than the one you had just gone past. A miss is a hitbox, the two
    // thirds of the road the ring is not in, and it rings where it happens.
    storageWrite(
      uState,
      mine + 5,
      // **A crash ends the boost, and it has to.** The pin above sets speed to
      // TOP_SPEED * 1.5 outright on every frame a boost is live, and it runs
      // long before contact is resolved — so halving the speed down here and
      // leaving the clock alone means the very next frame puts it straight back.
      // The penalty would apply everywhere except while boosting, which is the
      // one time a player is fast enough for it to matter.
      //
      // .z is last frame's signed contact, for the edge test above. It costs nothing:
      // the word was being written as a zero either way.
      vec4(boost * (1 - bang), max(was.y - dt, knock * 0.2), knock, stars * (1 - engage)),
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
      storageWrite(uState, 3, vec4(sideT, 0));
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
