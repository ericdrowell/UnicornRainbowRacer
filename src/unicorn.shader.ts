import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  max,
  mix,
  dot,
  smoothstep,
  normalize,
  type Vec3,
} from 'brometal';

/**
 * Rotation in the x-y plane. The pony faces +x, so a leg swinging forward and
 * back moves in x-y — which is a rotation about z, not the x you first reach for.
 */
function spin(p: Vec3, a: number): Vec3 {
  const c = cos(a);
  const s = sin(a);
  return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
}

/**
 * A running unicorn: one continuous mesh, animated by moving its vertices.
 *
 * The body is a single surface lofted along a spine from rump to muzzle, and
 * each leg is a tube lofted from its hip. Nothing is assembled from primitives
 * and nothing is instanced — there is one mesh and one draw call, and the legs
 * run because this shader moves their vertices.
 *
 * **Skinning weights come free with a procedural mesh.** Every vertex is emitted
 * knowing how far along its limb it sits, so `aSkin.x` is a by-product of
 * generating it rather than data anyone had to author. That single number is
 * what drives the bend.
 *
 * **The knee is a blend, not a hinge.** `smoothstep` ramps the bend in across a
 * short span rather than switching at a threshold, so vertices near the joint
 * rotate partially and the leg *curves*. A hard cutoff gives a crease, which is
 * the giveaway that a limb is two rigid pieces rather than one skinned surface —
 * and avoiding that is most of the reason to do it this way at all.
 *
 * Body vertices carry zero amplitudes and a zero root, so the same arithmetic
 * leaves them exactly where they were generated. There is no branch.
 */
export const Unicorn = shader({
  attributes: {
    /** Position, relative to `aRoot`. */
    aPos: 'vec3',
    aNrm: 'vec3',
    /** The joint this vertex swings about — the hip, or the origin for the body. */
    aRoot: 'vec3',
    /** Distance along the limb, gait phase, swing amplitude, knee amplitude. */
    aSkin: 'vec4',
    /** Colour, plus 1 to replace it with the flowing rainbow. */
    aColor: 'vec4',
  },
  uniforms: { uViewProj: 'mat4', uTime: 'float' },
  varyings: { vNormal: 'vec3', vColor: 'vec3' },

  vertex({ aPos, aNrm, aRoot, aSkin, aColor }, { uViewProj, uTime }, v) {
    const gait = uTime * 9 + aSkin.y;
    // Weighted by distance along the limb, and that is what welds it: the ring
    // shared with the barrel has t = 0, so it never moves, while everything
    // below swings freely. Rotate the leg rigidly instead and the top ring tears
    // away from the body it is part of.
    const hip = aSkin.z * sin(gait) * smoothstep(0, 0.28, aSkin.x);
    // Knees only fold one way, so the bend is clamped to the half of the cycle
    // where the hoof is coming through — a knee bending backwards reads as a
    // broken leg immediately.
    const knee = aSkin.w * max(sin(gait + 2.2), 0);
    const bend = knee * smoothstep(0.32, 0.56, aSkin.x);

    // Where the knee sits below the hip, in leg units. A local const because the
    // DSL scopes to shader parameters and locals — module-level values are not
    // in scope, which it says plainly rather than compiling to something wrong.
    const kneeY = 0.3;
    const atKnee = spin(vec3(aPos.x, aPos.y + kneeY, aPos.z), bend);
    const limb = spin(vec3(atKnee.x, atKnee.y - kneeY, atKnee.z), hip);
    // The barrel rises and falls at twice the stride, which sells a run more
    // than the legs do.
    const bob = sin(uTime * 18) * 0.03;
    const world = limb.add(aRoot).add(vec3(0, bob, 0));

    v.vNormal = spin(spin(aNrm, bend), hip);

    // Bands run diagonally and drift, so the mane and tail flow rather than sit.
    // The multiplier is high because a mane spans barely half a unit: at a gentle
    // rate the whole thing lands inside one arc of the palette and comes out a
    // single colour with a slight gradient, which is not a rainbow.
    const band = (world.x + world.y * 2.2) * 7 - uTime * 2.4;
    const rainbow = vec3(
      0.5 + 0.5 * cos(band),
      0.5 + 0.5 * cos(band + 2.09),
      0.5 + 0.5 * cos(band + 4.19),
    );
    v.vColor = mix(aColor.xyz, rainbow, aColor.w);
    return uViewProj.mul(vec4(world, 1));
  },

  fragment({}, { vNormal, vColor }) {
    // Renormalised, unlike the faceted version: skinning rotates each vertex by
    // its own amount, so along a bending leg the normals genuinely differ across
    // a face and the interpolated value is no longer unit length.
    const n = normalize(vNormal);
    const lit = max(dot(n, normalize(vec3(0.55, 0.7, 0.85))), 0);
    const sky = vec3(0.72, 0.78, 0.95).scale(0.6 + 0.26 * n.y);
    const key = vec3(1, 0.97, 0.9).scale(lit * 0.72);
    return vec4(vColor.mul(sky.add(key)), 1);
  },
});
