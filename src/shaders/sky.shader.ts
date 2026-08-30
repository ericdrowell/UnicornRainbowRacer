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
 * Where the moon hangs, and where its shadow does.
 *
 * Both are worked out here in TypeScript, at build time, and reach the shader as
 * plain numbers — the crescent is carved by a second disc offset from the first,
 * and *offset* is the whole trick: subtracting a shifted copy of a circle from a
 * circle is a crescent, with none of the trigonometry that drawing one as a
 * shape would need. Nudging the centre sideways and renormalising displaces it
 * very nearly tangentially, which is all the accuracy a shadow needs.
 *
 * The offset sets which way the crescent faces and how fat it is: at 0.45 of the
 * radius the moon is a little under half lit, which is the pose that reads as
 * "crescent" rather than as "circle with a dent" or "fingernail".
 */
// The two directions are written out as literals rather than computed up here,
// because a shader body can see nothing but its own parameters and local consts
// — no module-level values at all, which the compiler says plainly rather than
// compiling to something wrong. They are unit vectors, and this is the recipe:
//
//   moon    = normalize(1, 0.26, -0.45)  — up and left of the opening view
//   shadow  = normalize(moon + (0.45, 0.3, 0) * 0.037)
//
// Moving the moon means running those two lines again, in a REPL, not editing
// the numbers by hand: the second depends on the first, and a shadow that is no
// longer a unit vector stops being a circle on the sky.

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
  uniforms: { uTime: 'float', uClouds: 'sampler2D' },
  storage: { uState: 'vec4' },
  varyings: { vNdc: 'vec2' },

  vertex({ aCorner }, {}, v) {
    v.vNdc = aCorner;
    // Straight through, at a depth chosen only to pass a `less` test against a
    // cleared buffer. Nothing depends on the value: this program writes no depth.
    return vec4(aCorner.x, aCorner.y, 0.5, 1);
  },

  fragment({ uState, uTime, uClouds }, { vNdc }) {
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

    // The moon: one disc with a second, shifted disc taken out of it.
    //
    // `1 - smoothstep(in, out, r2)` and never `smoothstep(out, in, r2)`, which is
    // the obvious way to write a disc and is undefined in WGSL when the first
    // edge is the larger — it happens to work on some drivers, which is worse
    // than if it never did.
    // Both compared against *squared chord length* rather than angle: for unit
    // vectors the chord is the angle to well within a moon's width at this size,
    // and it costs a subtract and a dot where an acos would cost an acos. The
    // radius is 0.037 radians, a little over four degrees across — a storybook
    // moon rather than the half-degree coin the real one is.
    const toMoon = dir.sub(vec3(0.8873, 0.2307, -0.3993));
    const r2 = dot(toMoon, toMoon);
    const toShadow = dir.sub(vec3(0.8885, 0.2377, -0.3925));
    const disc = 1 - smoothstep(0.001177, 0.001369, r2);
    const bite = 1 - smoothstep(0.001068, 0.001232, dot(toShadow, toShadow));

    // **The moon is a body, not a light.** It stands in front of the star field
    // and stops it: `behind` multiplies the stars out, so none survives inside
    // the disc on either side of the terminator. It used to be additive, and the
    // stars carried on straight through the moon as though it were coloured
    // glass.
    //
    // What the dark limb then shows is `haze` and the halo — not a colour picked
    // to resemble the sky but the same two expressions the sky itself is made of,
    // sampled at the same direction. They cannot drift apart and there is no
    // seam at the limb to find.
    //
    // Which is exactly why the mask stops at the stars. Masking the halo too was
    // tried, on the reasoning that a halo belongs to the moon rather than to the
    // sky, and it turned the dark side into a hole: visibly darker than the lit
    // sky an inch away from it, a black disc rather than an unlit limb. The
    // stars are the only thing the moon is in front of. Everything else is the
    // sky, and the sky is continuous.
    const behind = 1 - disc;
    // Driven to two and a half so the crescent clips and blooms into the sky the
    // way the rails do, since there is no pass that could blur it afterwards.
    // Warm, against a sky biased cold — a moon that shares the nebula's colour
    // stops reading as a body and becomes a bright patch of it.
    const moon = vec3(1, 0.96, 0.9).scale(disc * (1 - bite) * 2.5);
    // And its halo, wide and cool and very faint. This is what makes it look
    // bright — nothing on screen is brighter than the clipped crescent itself,
    // so the light has to be implied by what it does to the sky around it.
    //
    // Centred on the moon and running right across it, unmasked, so the dark
    // limb sits in the same wash of light as the sky around it.
    const air = max(1 - r2 * 42, 0);
    const glow = vec3(0.7, 0.85, 1).scale(air * air * air * 0.45);

    // The clouds, marched at quarter resolution into a target and composited
    // here rather than in a pass of their own — the sky already covers every
    // pixel exactly once, so this costs fetches and saves a whole program.
    //
    // Four taps on a diagonal cross: the march dithers each ray's start to break
    // up banding, and averaging neighbours removes exactly the noise that dither
    // introduced. Through targetUv, because a target's rows run top to bottom
    // while NDC +y points at the first of them.
    const cloud = texture(uClouds, targetUv(vec4(vNdc.x - 0.004, vNdc.y - 0.006, 0, 1)))
      .add(texture(uClouds, targetUv(vec4(vNdc.x + 0.004, vNdc.y - 0.006, 0, 1))))
      .add(texture(uClouds, targetUv(vec4(vNdc.x - 0.004, vNdc.y + 0.006, 0, 1))))
      .add(texture(uClouds, targetUv(vec4(vNdc.x + 0.004, vNdc.y + 0.006, 0, 1))))
      .scale(0.25);
    const sky = haze.add(field.scale(behind)).add(glow).add(moon);
    return vec4(sky.scale(1 - cloud.w).add(cloud.xyz), 1);
  },
});
