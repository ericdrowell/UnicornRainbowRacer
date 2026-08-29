import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  tan,
  abs,
  min,
  max,
  exp,
  step,
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
 * The across-track direction at a ring, rolled by the camber.
 *
 * Level first, from the tangent and world up, then rotated about the tangent.
 * This is the same construction game.js used to build the ribbon, and it has to
 * stay the same construction: if the two disagree the unicorn stands on a
 * surface that is not where the road was drawn.
 */
function across(fwd: Vec3, bank: number): Vec3 {
  const flat = normalize(cross(fwd, vec3(0, 1, 0)));
  return flat.scale(cos(bank)).add(cross(flat, fwd).scale(sin(bank)));
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
     * Wall clock, for the falling star's arc. The block was already padded to
     * eight floats for uPattern's sake and only seven were used, so this rides
     * along at no cost.
     */
    uTime: 'float',
  },
  storage: { uState: 'vec4', uTrack: 'vec4' },
  workgroupSize: [1, 1, 1],

  compute({ uState, uTrack, uDt, uThrottle, uSteer, uAspect, uRings, uWidth, uPattern, uTime }, id) {
    // A tab left in the background delivers one enormous frame on return, and
    // an unclamped step of that size moves the unicorn straight through the
    // road — collision is tested at the new position, not swept to it.
    const dt = min(uDt, 0.05);

    const s0 = storageRead(uState, 0);
    const s1 = storageRead(uState, 1);
    const s2 = storageRead(uState, 2);
    const s3 = storageRead(uState, 3);
    let pos = s0.xyz;
    let speed = s1.w;
    let gait = s2.w;
    let vy = s3.w;
    // Where it is going and where it is pointing, as world directions. Two
    // whole slots because they are vectors now rather than angles off the
    // track — see the steering below for why that had to change.
    let courseDir = storageRead(uState, 11).xyz;
    let headingDir = storageRead(uState, 12).xyz;

    // Nearest ring, by brute force over the whole lap. Tracking the last ring
    // and searching outwards from it would be fewer iterations, but it makes
    // the search stateful — and the one time it matters is the one time that
    // state is wrong, after a fall or a respawn has moved the body somewhere
    // the previous ring says nothing about. A couple of hundred distance tests
    // in a single invocation is not the expensive part of this frame.
    let nearest = 0;
    let nearestD = 1000000;
    for (let i = 0; i < uRings; i += 1) {
      const c = storageRead(uTrack, i * 2);
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
    const here = storageRead(uTrack, nearest * 2);
    const ahead = storageRead(uTrack, nearest * 2 + 2);
    const forward = step(0, dot(pos.sub(here.xyz), ahead.xyz.sub(here.xyz)));
    const a = mix(max(nearest - 1, 0), nearest, forward);

    const ca = storageRead(uTrack, a * 2);
    const ta = storageRead(uTrack, a * 2 + 1);
    const cb = storageRead(uTrack, a * 2 + 2);
    const tb = storageRead(uTrack, a * 2 + 3);
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
    const sideT = across(fwdT, mix(ta.w, tb.w, along));
    const upT = cross(sideT, fwdT);

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
    const turn = uSteer * dt * 2.6 * grip;
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
    const rate = mix(30, 7.5, step(0, uThrottle));
    speed = speed + uThrottle * rate * dt;
    speed = speed - speed * (1 - step(0.5, abs(uThrottle))) * dt * 0.9;
    speed = speed - speed * abs(speed) * dt * 0.0025;
    speed = clamp(speed, -7, 60);

    // Both flattened back into the road's surface. This is the one thing the
    // track is still allowed to do to the unicorn's direction, and it is not
    // steering: it tips the direction up and down to follow a climb or a
    // descent, and touches nothing left or right. Skip it and a unicorn
    // cresting a rise keeps aiming at the sky.
    headingDir = normalize(headingDir.sub(upT.scale(dot(headingDir, upT))));
    courseDir = normalize(courseDir.sub(upT.scale(dot(courseDir, upT))));

    pos = pos.add(courseDir.scale(speed * dt));

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

    // Gravity along the road's normal rather than world down. On a surface
    // banked thirty degrees those differ, and using world down lets a body
    // resting on the camber slide, which then needs friction invented to stop
    // it. Down-is-into-the-road costs one vector and no friction at all.
    vy = vy - 30 * dt;
    pos = pos.add(upT.scale(vy * dt));

    // Height above the surface, and whether there is any surface here. Past the
    // rails there is nothing under the unicorn but sky, so the landing is
    // skipped and it keeps falling.
    const high = dot(pos.sub(centre.xyz), upT);
    const onRoad = step(abs(dot(pos.sub(centre.xyz), sideT)), uWidth * 0.5);
    const landed = step(high, 0) * onRoad;
    pos = pos.add(upT.scale((0 - high) * landed));
    // Landing zeroes the fall; not landed leaves vy alone, so gravity keeps
    // accumulating. This is where jump used to live — the whole move was this one
    // line launching instead of clamping when the key went down on the same frame.
    //
    // Gravity and the clamp stay. They are not jump machinery: they are what
    // holds the unicorn against a road that climbs, banks and drops away, and
    // what lets it fall past the rails when it leaves the edge.
    vy = vy * (1 - landed);

    // Far enough under the road to have plainly lost it: back to the start.
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
    const wantEye = pos.sub(courseDir.scale(8)).add(upT.scale(3));
    const wantAt = pos.add(courseDir.scale(5)).add(upT.scale(1));

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
    const settle = mix(1 - exp(0 - 14 * dt), 1, max(1 - prevEye.w, lost));
    const eye = mix(prevEye.xyz, wantEye, settle);
    const at = mix(prevAt.xyz, wantAt, settle);
    // The roll is smoothed too, or the camera would still step through the
    // camber changes it is meant to lean into.
    const camUp = normalize(mix(prevUp.xyz, upT, settle));

    const zAxis = normalize(eye.sub(at));
    const xAxis = normalize(cross(camUp, zAxis));
    const yAxis = cross(zAxis, xAxis);

    const f = 1 / tan(0.5);
    const fx = f / uAspect;
    // near 0.1, far 500, as one expression each: the DSL has no module-level
    // constants, and naming them locally costs more than it explains.
    const za = (500 + 0.1) / (0.1 - 500);
    const zb = (2 * 500 * 0.1) / (0.1 - 500);

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
    storageWrite(uState, 9, vec4(at, 0));
    storageWrite(uState, 10, vec4(camUp, 0));
    // The spare word on the course direction carries how far along the road the
    // unicorn is, in the units the track shader draws in, so the model can be
    // lit by the panel it is standing on. The two ring records either side of it
    // carry real distances in their own spare words and the segment is already
    // solved for, so this is an interpolation of numbers that were sitting there
    // — no second search, and exact rather than ring index times a nominal
    // spacing, which the rings do not actually have.
    const trackAlong = mix(ca.w, cb.w, along) * uPattern;
    storageWrite(uState, 11, vec4(courseDir, trackAlong));
    storageWrite(uState, 12, vec4(headingDir, 0));

    // The falling star's arc, aimed by the camera once and then left in the world.
    //
    // The sky shader used to build this arc every frame from wherever the camera
    // was pointing at that moment, which is why the star turned with the player:
    // it was never in the world at all, it was painted on the inside of the view.
    // Aiming it is still the camera's job — a star on a fixed compass bearing is
    // only seen when the player happens to face it, and on a road that is always
    // turning that was almost never. So it is aimed once, on the frame it lights,
    // and held in world space for the rest of its flight. Placed by the view, then
    // left behind by it.
    //
    // The slot arithmetic mirrors the sky shader, which owns the star's shape:
    // same 7.5 second block, same per-slot offset, so "has it started yet" is the
    // same question answered the same way in both places. If one changes the other
    // has to follow.
    const beat = uTime / 7.5;
    const slotIx = floor(beat);
    const begin = mix(fract(sin(slotIx * 33.71) * 12345.678) * 2.4, 0.8, step(slotIx, 0.5));
    const armed = storageRead(uState, 13);
    // Fire on the frame the star lights, once per slot. The spare word carries the
    // slot the stored arc belongs to, offset by one so that a zeroed buffer reads
    // as "nothing armed yet" rather than as "slot zero is already done" — which
    // would have cost the opening star, the one the player is guaranteed to see.
    const fire = step(begin, fract(beat) * 7.5) * (1 - step(abs(armed.w - slotIx - 1), 0.5));
    // Enough vertical scatter that consecutive stars do not trace one groove.
    const wander = fract(sin(slotIx * 91.7) * 43758.5453) * 0.22 - 0.11;
    // zAxis runs from the target back to the eye, so forward is its negation.
    const gaze = vec3(0, 0, 0).sub(zAxis);
    // A 64 degree sweep, entering high on the left and leaving lower on the right
    // — it is a falling star, so it has to lose height as it crosses.
    const enterDir = normalize(gaze.sub(xAxis.scale(0.62)).add(yAxis.scale(0.58 + wander)));
    const leaveDir = normalize(gaze.add(xAxis.scale(0.62)).add(yAxis.scale(0.46 + wander)));
    storageWrite(uState, 13, vec4(mix(armed.xyz, enterDir, fire), mix(armed.w, slotIx + 1, fire)));
    storageWrite(uState, 14, vec4(mix(storageRead(uState, 14).xyz, leaveDir, fire), 0));
  },
});
