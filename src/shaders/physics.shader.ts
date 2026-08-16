import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  tan,
  abs,
  min,
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
 *   0   position          heading
 *   1   facing            speed
 *   2   surface normal    gait phase
 *   3   surface across    vertical speed
 *   4   view-projection, as four columns
 *   8   camera eye        1 once the camera exists
 *   9   camera target
 *   10  camera up
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
    let heading = s0.w;
    let speed = s1.w;
    let gait = s2.w;
    let vy = s3.w;

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

    // Steering scaled by how fast it is going, because a kart that pivots on
    // the spot reads as a bug. Clamped well short of a right angle: this is an
    // angle relative to the road, and past a quarter turn "forward" stops
    // meaning anything useful.
    const grip = min(abs(speed) / 7, 1);
    heading = clamp(heading + uSteer * dt * 2.4 * grip, -0.95, 0.95);

    // Braking bites harder than the throttle pushes, and lifting off is neither
    // — coasting is its own, gentler decay. Quadratic drag on top is what sets
    // the top speed, so there is no separate clamp pretending to be physics.
    const rate = mix(30, 15, step(0, uThrottle));
    speed = speed + uThrottle * rate * dt;
    speed = speed - speed * (1 - step(0.5, abs(uThrottle))) * dt * 0.9;
    speed = speed - speed * abs(speed) * dt * 0.02;
    speed = clamp(speed, -7, 34);

    // Where it is pointing: the track's own direction, turned by the steering.
    // Rebuilt from the current ring every frame, so holding nothing follows the
    // road round a corner and the steering angle means the same thing all lap.
    const dir = normalize(fwdT.scale(cos(heading)).add(sideT.scale(sin(heading))));
    pos = pos.add(dir.scale(speed * dt));

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
    vy = mix(vy, uJump * 12, landed);

    // Far enough under the road to have plainly lost it: back to the start.
    const lost = step(high, -50);
    const home = storageRead(uTrack, 0);
    pos = mix(pos, home.xyz, lost);
    speed = speed * (1 - lost);
    vy = vy * (1 - lost);
    heading = heading * (1 - lost);

    // Legs driven by distance covered rather than by the clock, so the gait
    // slows with the unicorn and stops dead when it does. The rate is set so
    // that a cruise lands near the 9 rad/s the gait was originally tuned at.
    gait = gait + abs(speed) * dt * 0.6;

    // The camera rides the *track*, not the unicorn: behind and above the body
    // along the road's own tangent, looking down the road. Steering turns the
    // unicorn inside a frame that holds still, which is the whole reason to
    // build the view here from fwdT and never from dir.
    const wantEye = pos.sub(fwdT.scale(8)).add(upT.scale(3));
    const wantAt = pos.add(fwdT.scale(5)).add(upT.scale(1));

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

    storageWrite(uState, 0, vec4(pos, heading));
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
  },
});
