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
  clamp,
  mix,
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
    /** 1 on the frame the jump key went down, 0 otherwise. */
    uJump: 'float',
    uAspect: 'float',
    uRings: 'float',
    uWidth: 'float',
  },
  storage: { uState: 'vec4', uTrack: 'vec4' },
  workgroupSize: [1, 1, 1],

  compute({ uState, uTrack, uDt, uThrottle, uSteer, uJump, uAspect, uRings, uWidth }, id) {
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
    // Landing zeroes the fall; landing on the frame the jump key went down
    // launches instead. Not landed and both leave vy alone, which is what makes
    // jump a ground move without a branch.
    //
    // Height is v squared over twice gravity, so **doubling the jump means
    // multiplying the launch by root two, not by two** — 12 to 17 takes the arc
    // from 2.4 up to 4.8. It also stretches the hang time, by the same root two,
    // from about eight tenths of a second to one and a sixth.
    vy = mix(vy, uJump * 17, landed);

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

    // Legs driven by distance covered rather than by the clock, so the gait
    // slows with the unicorn and stops dead when it does. The rate is set so
    // that a cruise lands near the 9 rad/s the gait was originally tuned at.
    gait = gait + abs(speed) * dt * 0.6;

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
    storageWrite(uState, 11, vec4(courseDir, 0));
    storageWrite(uState, 12, vec4(headingDir, 0));
  },
});
