import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  fract,
  floor,
  max,
  mix,
  min,
  cross,
  dot,
  smoothstep,
  sqrt,
  normalize,
  storageRead,
  texture,
  targetUv,
  type Vec3,
} from 'brometal';

/**
 * The same cosine palette the road runs on, so the sky is made of the same
 * light. Written out again rather than imported from track.shader.ts: each
 * shader compiles to its own WGSL and there is nothing to import across, but the
 * compiler does emit this as one function per shader and call it, which is why
 * the nebula and the stars can both afford a full spectrum lookup.
 */
function spectrum(k: number): Vec3 {
  return vec3(0.5 + 0.5 * cos(k), 0.5 + 0.5 * cos(k + 2.09), 0.5 + 0.5 * cos(k + 4.19));
}

/**
 * One layer of stars: a lattice of cells the unit sphere cuts through, one star
 * at the centre of every cell whose hash clears `cut`.
 *
 * The cells are cubes and the sphere is not, so what reaches the eye is the
 * intersection of the two and carries none of the lattice's regularity — which
 * is why a star can sit at its cell's centre with no jitter and the sky still
 * looks scattered rather than woven.
 *
 * A function taking its scale, because one layer is a pattern and two are a sky.
 * A single field of stars all the same size sits flat against the back of the
 * scene no matter how many of them there are; a coarse layer of bright ones over
 * a fine layer of faint ones reads as depth, for the cost of a second call — the
 * DSL emits this once and calls it twice.
 *
 * Existence, brightness, twinkle phase and colour all come out of the one hash.
 * Re-hashing per property is the obvious way and buys nothing: these want to be
 * correlated anyway, because the rarest cells being the brightest is exactly how
 * a sky looks.
 */
function starLayer(dir: Vec3, scale: number, cut: number, t: number): Vec3 {
  const p = dir.scale(scale);
  const h = fract(sin(floor(p.x) * 12.99 + floor(p.y) * 78.23 + floor(p.z) * 45.16) * 43758.5);
  // Written as fracts rather than reusing the floors above, which was tried and
  // came out *larger*: three more named locals cost more in the emitted WGSL
  // than three repetitions of a string the compressor has already seen.
  const off = vec3(fract(p.x) - 0.5, fract(p.y) - 0.5, fract(p.z) - 0.5);

  // A ramp rather than a smoothstep — the curve at the ends of a smoothstep is
  // wasted on a threshold nothing is ever near, since a cell either holds a star
  // or does not. The divisor is constant-folded: `cut` arrives at compile time.
  const spark = max(h - cut, 0) / (1 - cut);
  // Each star keeps its own phase, from the same number, so they breathe
  // independently rather than pulsing as one field. Never all the way out at the
  // bottom of the cycle: a star that vanishes reads as a dead pixel.
  const twinkle = 0.7 + 0.3 * sin(t + h * 90);
  // A hard core with a soft skirt — the same analytic stand-in for bloom the road
  // uses, and the reason a star a couple of pixels across still reads as a light
  // rather than as a dot. On the *squared* distance, which skips a square root
  // and steepens the core for free: the falloff wanted a power curve anyway, so
  // the root would only have been undone by the exponent.
  const fall = max(1 - dot(off, off) * 4.8, 0);
  // Stars are not white. Tinting them from their own hash gives the sky its
  // blues, roses and golds — but only halfway, because a fully saturated star
  // stops looking hot.
  return mix(vec3(1, 1, 1), spectrum(h * 40), 0.45).scale(spark * twinkle * fall * fall * fall);
}

/**
 * The sky: stars, and the faint colour between them.
 *
 * **It is a sphere in every way that shows, and three vertices in the buffer.**
 * A sky sphere is geometry whose only job is to be a direction — nothing about
 * it is ever nearer or farther, and it is always exactly as far away as it needs
 * to be. So there is no sphere: one triangle covers the screen, and each
 * fragment works out which way the camera is looking through it and asks the
 * star field what is out there. That is an infinitely distant sphere by
 * construction, with no seam at the poles, no tessellation to choose, and no
 * vertices to send.
 *
 * **The ray comes out of the camera the physics stage already built.** Slots 4
 * to 7 hold the view-projection by column, and a column-major matrix keeps the
 * camera's own axes in its rows — so the three columns' x components are the
 * camera's right vector scaled by the horizontal focal length, their y
 * components are its up vector scaled by the vertical one, and their w
 * components are its forward vector outright. Dividing each by its own squared
 * length divides out the focal scaling without needing to know it, because the
 * axes underneath are unit vectors. No new uniform, no inverse matrix, and the
 * sky cannot drift out of step with the camera because it *is* the camera.
 *
 * **Drawn first and never into the depth buffer.** `zwrite: 0` is what makes
 * that safe: the triangle sits at half depth, in front of nothing and behind
 * nothing, and everything drawn afterwards tests against a depth buffer the sky
 * never touched. Painting it first and letting the road paint over it is the
 * whole of the ordering.
 */
export const Sky = shader({
  attributes: {
    /** One oversized triangle in clip space: (-1,-1), (3,-1), (-1,3). */
    aCorner: 'vec2',
  },
  uniforms: { uTime: 'float' },
  storage: { uState: 'vec4' },
  varyings: { vNdc: 'vec2' },

  vertex({ aCorner }, {}, v) {
    v.vNdc = aCorner;
    // Straight through, at a depth chosen only to pass a `less` test against a
    // cleared buffer. Nothing depends on the value: this program writes no depth.
    return vec4(aCorner.x, aCorner.y, 0.5, 1);
  },

  fragment({ uState, uTime }, { vNdc }) {
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const right = vec3(c0.x, c1.x, c2.x);
    const up = vec3(c0.y, c1.y, c2.y);
    const dir = normalize(
      right
        .scale(vNdc.x / dot(right, right))
        .add(up.scale(vNdc.y / dot(up, up)))
        .add(vec3(c0.w, c1.w, c2.w)),
    );

    // The colour between the stars: three waves over the direction itself, so it
    // is nebula rather than gradient — soft banks of violet and teal that the
    // road rides through, drifting over about two minutes. Three rather than two
    // because two produce a single smooth swell that reads as a lit backdrop; it
    // takes a third, faster one to break the banks up into something with an
    // inside and an edge.
    //
    // Dim, because it is competing with a road that clips to white. Any brighter
    // and the sky stops being deep space and becomes a coloured wall a few
    // metres behind the track.
    const veil =
      sin(dir.x * 1.9 + dir.y * 2.7) * 1.4 +
      sin(dir.z * 1.3 - dir.y * 0.9) * 1.1 +
      sin(dir.x * 4.1 - dir.z * 3.3) * 0.6 +
      uTime * 0.05;
    // Biased cold. Straight off the palette the nebula spends most of its range
    // in the warm half and comes out plum and sepia — which reads as dusty
    // rather than as deep space. Weighting the channels leaves the variation
    // intact and moves where it sits: violets and teals, with the warm banks
    // surviving as embers rather than as the main event.
    const haze = spectrum(veil).mul(vec3(0.75, 0.85, 1.3)).scale(0.1 + 0.06 * dir.y);

    // Two layers. Seventy cells to the radian puts a coarse cell at about eight
    // tenths of a degree — those are the stars you notice, bright and slow. The
    // fine layer is more than twice as dense and cut far harder, so it reads as
    // dust behind them, and it twinkles at its own rate: two fields breathing in
    // step would announce themselves as one field immediately.
    const field = starLayer(dir, 70, 0.86, uTime * 3)
      .scale(3.2)
      .add(starLayer(dir, 165, 0.93, uTime * 5.1).scale(1.4));

    // ── The clouds ──────────────────────────────────────────────────────
    // A flat deck, found by intersecting the view ray with one horizontal plane
    // and shading whatever it hits. No volume, no march, no target.
    //
    // **What this replaces was a real volumetric renderer** — sixty-four steps a
    // ray through a 64-cubed noise texture built on the CPU, lit by a second
    // march towards the sun, drawn into a quarter-size target and composited
    // back here. It looked better than this does. It also cost about a kilobyte
    // once the shader, the volume builder, the render target and the extra
    // program were counted, which is most of a feature on a budget this tight.
    //
    // The deck sits below the road, which is the one thing the old clouds and
    // this have in common and the reason either works: you are always looking
    // *down* on them from a rainbow in the sky, so a plane with texture on it
    // reads as a cloud layer. Seen from underneath it would read as a painted
    // ceiling, and the camera never goes there.
    const eye = storageRead(uState, 8).xyz;
    // Only rays heading downward meet the plane. Clamping the divisor rather
    // than branching keeps the horizon from dividing by zero and sends
    // near-horizontal rays somewhere far away instead, which is where the deck
    // should vanish anyway.
    const drop = min(dir.y, 0 - 0.02);
    const reach = (0 - 55 - eye.y) / drop;
    const at = eye.add(dir.scale(reach));
    // Three waves at different rates and angles, the same trick as the nebula
    // above: two give a single smooth swell, and it takes a third to break the
    // banks into something with an inside and an edge. Scaled small because the
    // deck is hundreds of units across.
    const drift = uTime * 0.006;
    // Warped before it is sampled. Straight sine waves on a plane seen almost
    // edge-on come out as horizontal ribbons — perspective squashes the whole
    // distance into a few pixels near the horizon, and ribbons read as water,
    // not weather. Offsetting the sample point by a slower wave bends them into
    // lobes, which is the cheapest thing that stops it looking like a lake.
    const warp = sin(at.z * 0.004 - drift) * 26 + sin(at.x * 0.0031 + drift * 1.7) * 22;
    const wx = at.x + warp;
    const wz = at.z + sin(at.x * 0.0052 + drift * 0.9) * 24;
    const puff =
      sin(wx * 0.009 + wz * 0.007 + drift) * 0.62 +
      sin(wz * 0.013 - wx * 0.005 - drift * 1.3) * 0.5 +
      sin((wx + wz) * 0.024 + drift * 0.7) * 0.3 +
      sin((wx - wz) * 0.047 - drift * 2.1) * 0.16;
    // Thresholded low, so the deck is mostly cloud with holes in it rather than
    // mostly holes with cloud in them. Four waves summing to about ±1.6 means a
    // floor of -1.05 leaves roughly three quarters covered — enough that the
    // black underneath reads as gaps rather than as the default.
    const cover = smoothstep(0 - 1.05, 0.42, puff);
    // Held off the horizon. The band right at eye level is where the plane is
    // most foreshortened and least convincing, so the deck simply is not drawn
    // there — it fades in once you are looking down at it properly.
    const near = smoothstep(0.04, 0.26, 0 - dir.y);
    const lit = mix(vec3(0.55, 0.59, 0.74), vec3(1.05, 1.05, 1.12), cover);
    const veilAmt = cover * near;

    // No moon any more. It was a crescent carved by subtracting a shifted disc
    // from a disc, with a wide cool halo around it and a mask that held the star
    // field out of the lit side — about forty lines and 127 zipped bytes for a
    // four-degree shape in one corner of a sky that is mostly rainbow and cloud.
    // git log has it if it is ever wanted back.
    const sky = haze.add(field);
    return vec4(sky.scale(1 - veilAmt).add(lit.scale(veilAmt)), 1);
  },
});
