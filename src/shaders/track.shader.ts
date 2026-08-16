import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  floor,
  fract,
  smoothstep,
  storageRead,
  type Vec3,
} from 'brometal';

/**
 * The palette, as a cosine rather than a table.
 *
 * Six named colours would need six constants and a chain of comparisons to pick
 * between them; three cosines a third of a turn apart sweep the same hues for a
 * few characters, and the DSL has no arrays to hold a table in anyway.
 */
function spectrum(k: number): Vec3 {
  return vec3(0.5 + 0.5 * cos(k), 0.5 + 0.5 * cos(k + 2.09), 0.5 + 0.5 * cos(k + 4.19));
}

/**
 * The rainbow road: one ribbon lofted along the track's centreline.
 *
 * The geometry arrives already flattened — game.js sweeps the centre points into
 * a strip and hands over two numbers per vertex, how far across the road it sits
 * and how far along. Everything here is a function of those two, which is what
 * makes the surface independent of how finely the strip was tessellated: bands
 * do not stretch on tight corners or compress on straights, because they are
 * measured in track distance rather than in vertices.
 *
 * **Lanes are quantised, the glow is not.** Flooring the across-coordinate into
 * bands gives the hard-edged stripes the look depends on, while the brightness
 * riding over them stays continuous — a lit strip reads as one surface with
 * colours painted on it rather than as a row of separate coloured planes.
 */
export const Track = shader({
  attributes: {
    aPos: 'vec3',
    /** Across the road in -1..1, and distance travelled along it. */
    aEdge: 'vec2',
  },
  uniforms: { uTime: 'float' },
  // Read-only here. Physics writes it, and a read_write binding could not be
  // visible to a vertex stage at all — the camera would have to come back
  // through the CPU, a frame late, to arrive as a uniform instead.
  storage: { uState: 'vec4' },
  varyings: { vU: 'float', vV: 'float' },

  vertex({ aPos, aEdge }, { uState, uTime }, v) {
    v.vU = aEdge.x;
    // Time folded into the distance here rather than read in the fragment: the
    // scroll is a shift along the road, so it belongs to the coordinate.
    v.vV = aEdge.y - uTime * 4;
    // The view-projection, four columns from slot 4. A column-major matrix
    // times a point is its columns weighted by that point's components, which
    // is all `mat4.mul` was doing — the DSL has no mat4 in a storage buffer to
    // reconstruct, and it does not need one.
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const c3 = storageRead(uState, 7);
    return c0.scale(aPos.x).add(c1.scale(aPos.y)).add(c2.scale(aPos.z)).add(c3);
  },

  fragment({}, { vU, vV }) {
    // Seven lanes across, each a flat colour.
    const band = (vU * 0.5 + 0.5) * 7;
    const hue = spectrum(floor(band) * 0.897);

    // A dark seam between lanes, so the stripes read as separate at a distance
    // instead of blurring into one wash.
    const within = fract(band);
    const seam = smoothstep(0, 0.08, within) * smoothstep(0, 0.08, 1 - within);

    // Light running along the road. One wave alone reads as a rolling barber's
    // pole; a second at a third of the rate beats against it into a much longer
    // pattern. Exactly a third, rather than something irrational that would
    // never repeat at all: the track is a loop, and game.js sizes its distances
    // so that a lap is a whole number of these — which it can only do if both
    // waves close at the same place.
    const pulse = 0.62 + 0.24 * sin(vV * 0.7) + 0.14 * sin(vV * 0.23333 + 1.7);

    // Rails: the outer sixth of the width burns out to white. This is what sells
    // it as a ribbon in space rather than a painted floor — the edge is the only
    // part of a road with nothing beyond it, so it is the part that has to glow.
    const rail = smoothstep(0.84, 1, abs(vU));

    const lit = hue.scale(pulse * (0.3 + 0.7 * seam));
    return vec4(lit.add(vec3(1, 0.95, 1).scale(rail * 0.85)), 1);
  },
});
