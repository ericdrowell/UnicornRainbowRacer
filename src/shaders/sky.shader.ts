import {
  shader,
  vec2,
  pow,
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
 * Both are worked out at build time and reach the shader as plain numbers — the
 * crescent is carved by a second disc offset from the first, and *offset* is the
 * whole trick: subtracting a shifted copy of a circle from a circle is a
 * crescent, with none of the trigonometry that drawing one as a shape would
 * need. Nudging the centre sideways and renormalising displaces it very nearly
 * tangentially, which is all the accuracy a shadow needs.
 *
 * The offset sets which way the crescent faces and how fat it is: at 0.45 of the
 * radius the moon is a little under half lit, which is the pose that reads as
 * "crescent" rather than as "circle with a dent" or "fingernail".
 */
// The two directions are written out as literals rather than computed up here,
// because a shader body can see nothing but its own parameters and local consts
// — no module-level values at all, which the compiler says plainly rather than
// compiling to something wrong.
//
// **They are aimed at the grid, not chosen by eye.** The flag-stage camera sits
// behind the player looking down the road: physics.shader.ts builds it as
// `chaseAt - chaseEye`, which is `courseDir * 18 - upT * 2`, with `upT` for its
// up. Solving that basis backwards for a direction that projects to NDC
// (-0.45, +0.45) puts the moon in the upper left, inboard of the star meter
// rather than under it.
//
// **One direction serves all four circuits**, which is luck worth recording: the
// starts head 359.3, 348.3, 3.7 and 4.3 degrees, all within about eight degrees
// of due +Z, so the same world vector lands between -0.74 and -0.34 across the
// set — left of centre and on screen on every grid. It survives the aspect
// range too, -0.54 at 4:3 out to -0.31 at ultrawide. Reseed a circuit into a
// very different start heading and this has to be solved again.
//
//   moon    = normalize(gaze - right * 0.45 * tan(0.5) * aspect
//                            + up    * 0.45 * tan(0.5))
//   shadow  = normalize(moon + (-0.45, 0.3, -0.011) * 0.037)
//
// **The negative x is the crescent facing right.** The offset decides which way
// it opens — the lit part is wherever the moon's disc is and the shadow's is
// not — so mirroring that offset about the camera's right axis mirrors the
// crescent on screen. Mirroring preserves its length, so the shape is identical
// and only handed the other way; the small z term is there because the road
// heads very nearly, but not exactly, along +Z, so the camera's right axis is
// not exactly world x.
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
function starLayer(dir: Vec3, scale: number, cut: number): Vec3 {
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
  // A hard core with a soft skirt — the same analytic stand-in for bloom the road
  // uses, and the reason a star a couple of pixels across still reads as a light
  // rather than as a dot. On the *squared* distance, which skips a square root
  // and steepens the core for free: the falloff wanted a power curve anyway, so
  // the root would only have been undone by the exponent.
  const fall = max(1 - dot(off, off) * 4.8, 0);
  // Stars are not white. Tinting them from their own hash gives the sky its
  // blues, roses and golds — but only halfway, because a fully saturated star
  // stops looking hot.
  return mix(vec3(1, 1, 1), spectrum(h * 40), 0.45).scale(spark * fall * fall * fall);
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
  /**
   * uOver is which of this shader's two jobs is being asked for: 0 draws the
   * sky, 1 draws the warp over the top of everything. Appended after uTime and
   * never in front of it — the block is filled by index from JS, so a uniform
   * inserted above another silently renumbers it.
   */
  uniforms: { uTime: 'float', uOver: 'float', uTitle: 'float' },
  storage: { uState: 'vec4' },
  varyings: { vNdc: 'vec2' },

  vertex({ aCorner }, { uOver }, v) {
    v.vNdc = aCorner;
    // **Two depths, because this triangle is drawn twice.** As the sky it sits
    // at half depth, in front of nothing and behind nothing, and everything
    // afterwards tests against a buffer it never touched. As the warp it is
    // drawn last and has to beat the road, and `depthCompare` is fixed at
    // `less` with no way to switch the test off — so it goes to the near plane
    // instead, where it passes against anything. Neither pass writes depth.
    return vec4(aCorner.x, aCorner.y, mix(0.5, 0 - 1, uOver), 1);
  },

  fragment({ uState, uTime, uOver, uTitle }, { vNdc }) {
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const right = vec3(c0.x, c1.x, c2.x);
    const up = vec3(c0.y, c1.y, c2.y);
    let dir = normalize(
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
    if (uTitle > 0.5) {
      const turn = uTime * -0.015;
      const x = vNdc.x * 0.8;
      const y = vNdc.y * 0.45;
      dir = normalize(vec3(x * cos(turn) + sin(turn), y, cos(turn) - x * sin(turn)));
    }
    const veil =
      sin(dir.x * 1.9 + dir.y * 2.7) * 1.4 +
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
    const field = starLayer(dir, 70, 0.86)
      .scale(3.2)
      .add(starLayer(dir, 165, 0.93).scale(1.4));

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
    const toMoon = dir.sub(vec3(0.3444, 0.1241, 0.9306));
    const r2 = dot(toMoon, toMoon);
    const toShadow = dir.sub(vec3(0.3292, 0.1358, 0.9344));
    const disc = (1 - smoothstep(0.001177, 0.001369, r2)) * (1 - uTitle);
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
    const wx = at.x;
    const wz = at.z;
    const puff =
      sin(wx * 0.009 + wz * 0.007 + drift) * 0.62;
    // Thresholded low, so the deck is mostly cloud with holes in it rather than
    // mostly holes with cloud in them. Four waves summing to about ±1.6 means a
    // floor of -1.05 leaves roughly three quarters covered — enough that the
    // black underneath reads as gaps rather than as the default.
    const cover = smoothstep(0 - 1.05, 0.42, puff);
    // Held off the horizon. The band right at eye level is where the plane is
    // most foreshortened and least convincing, so the deck simply is not drawn
    // there — it fades in once you are looking down at it properly.
    const near = smoothstep(0.04, 0.26, 0 - dir.y - uTitle * 0.18);
    const lit = mix(vec3(0.6, 0.6, 0.7), vec3(1, 1, 1), cover);
    const veilAmt = cover * near;

    // No moon any more. It was a crescent carved by subtracting a shifted disc
    // from a disc, with a wide cool halo around it and a mask that held the star
    // field out of the lit side — about forty lines and 127 zipped bytes for a
    // four-degree shape in one corner of a sky that is mostly rainbow and cloud.
    // git log has it if it is ever wanted back.
    // ── The warp ────────────────────────────────────────────────────────
    // **A second of hyperspace when a ring is taken.** Streaks racing outward
    // from the point the camera is aimed at, which is the point the road runs
    // to — so they converge exactly where the unicorn is going, and the effect
    // reads as travelling rather than as a filter laid over the frame.
    //
    // **No new pass, no new program, no new uniform.** The sky is already a
    // triangle over the whole screen with the state buffer bound, and the boost
    // clock is already in it — racer zero's slot 5, counting 3 down to 0. So
    // this is a few lines on the end of a shader that was going to run anyway,
    // where an overlay would have been a second pipeline, a second draw and a
    // blend state.
    //
    // The cost of that choice is that the road occludes the streaks, and it is
    // the right behaviour rather than a compromise: the tunnel is out in space,
    // and the rainbow is solid and in front of you.
    //
    // The clock starts at 3 and falls at one a second, so this reads seconds
    // since the ring backwards: full for the first half second, then seven
    // tenths of a second easing to nothing. The fade used to be a quarter of a
    // second ending exactly where the CPU stopped issuing the pass, which is two
    // ways of ending the same effect racing each other — and the visible result
    // was a cut rather than a fade whenever the readback landed first.
    //
    // Taking a second ring re-arms the clock to 3 and this fires again, which is
    // what a chain of rings should look like.
    //
    // **Star power drives the same streaks, off its own clock.** Slot 22 is
    // racer zero's sixth word and `.z` is the run's clock counting down —
    // whereas 21 is the boost clock in the slot before it. The two are held
    // apart by a `max` rather than added: they overlap whenever a starred player
    // takes a pad, and two full-strength warps summed is one clipped white
    // screen rather than a brighter tunnel.
    //
    // Full for the whole run and eased out over the last six tenths, against the
    // boost's ease-in from the top of its clock. The difference is deliberate:
    // a boost is an event that decays, and star power is a state that ends, so
    // this one wants to be *on* for the duration and to stop rather than to fade
    // from the moment it starts.
    // Pulled out of the `max` below because the tunnel is star power's alone —
    // the streaks are shared with the boost pad and this is not.
    const starLit = smoothstep(0, 0.6, storageRead(uState, 22).z);
    const hyper = max(smoothstep(1.8, 2.5, storageRead(uState, 21).x), starLit);
    // **The direction is quantised into spokes before it is hashed, and it has
    // to be.** Every pixel along one ray normalises to the same vector, so a
    // hash of that vector is constant down a whole streak — which is what makes
    // these radial with no angle ever computed, since `atan2` is not exported.
    // But hashing the direction *continuously* gives a different answer a pixel
    // over, and the streaks come out narrower than a pixel and alias into
    // nothing. That was the first version, and it drew an empty sky.
    //
    // Seventy cells to the unit lands about three hundred spokes round the
    // circle, a degree or so each. Fifty was the first try and it drew wedges
    // rather than stars — a warp field is made of *many thin* streaks, and the
    // count is what separates the two. They are not perfectly even, because the
    // cells are square and the circle is not, and that is closer to a real
    // starfield than an even fan would be.
    const nd = normalize(vNdc);
    const seed = fract(sin((floor(nd.x * 70) * 97 + floor(nd.y * 70)) * 12.99) * 43758.5);
    const rr = sqrt(dot(vNdc, vNdc));
    // Each streak runs its own lap of the screen, offset by its own seed so they
    // do not pulse together, and squared so the leading edge is hard and the
    // tail draws out behind it.
    // **Streaks are born a third of the way out, not at the middle.** Running
    // them from zero filled the centre of the frame and the effect read as a
    // starburst; a tunnel has a mouth, and the mouth is the hole they come from.
    // 0.3 out to 1.8 is that hole and the run to the corners.
    const gap = rr - (0.3 + fract(seed * 13.7 + uTime * 2.4) * 1.5);
    // Short, and cubed on top of that. Half the screen long was the first
    // version and it read as searchlights; a warp streak is a star smeared by a
    // frame or two of motion, not a beam.
    const body = 1 - smoothstep(0, 0.13, sqrt(gap * gap));
    // A quarter of the spokes carry one. Nothing at the vanishing point: a
    // streak that reaches the middle is a blob there, because every spoke
    // arrives at the same pixel.
    const bolt =
      smoothstep(0.74, 0.8, seed) * body * body * body * smoothstep(0.28, 0.58, rr) * hyper;
    // ── Tunnel vision ──────────────────────────────────────────────────────
    // **The edges wash out while the middle stays sharp.** Not a blur — a blur
    // means sampling the scene, and the scene is never in a texture: every pass
    // in this game draws straight at the screen, so putting one there would cost
    // a second target, a second program and a sampling pass to read it back.
    //
    // What is actually wanted from a blur here is *the periphery stops carrying
    // information*, and a veil does that for two terms. This pass is already
    // fullscreen and already only drawn while the clock is up, so the edges
    // simply fade into the same pastel the streaks are made of: detail out there
    // goes, the road ahead stays clean, and the eye is pushed down the middle of
    // the screen — which is where it wants to be at twice the speed anyway.
    //
    // `rr` is the distance from the centre in NDC, so it is 1 at the middle of
    // an edge and about 1.7 into a corner. Nothing at all inside half a screen
    // out, and thickest in the corners, which is the shape of looking down a
    // tube.
    //
    // **On `starLit` and not on `hyper`, which is the difference between the two
    // things this pass draws.** The streaks are shared: a boost pad and a run
    // both throw them, because both are "going faster than usual" and the
    // tunnel of light is what that looks like. Closing the edges down is not
    // that — it is the world narrowing to the road, and a pad taken on an
    // ordinary lap is not worth narrowing anything for. Three seconds of it
    // every lap would also stop it meaning anything by the time a run arrived.
    const rim = smoothstep(0.5, 1.35, rr) * starLit * 0.62;

    // **The warp is a second pass over the top, not part of the sky.** Drawn
    // into the sky it sat behind the road, which put the tunnel under the thing
    // you are driving on — and a tunnel you are inside does not have a floor
    // over it. So the same triangle is drawn again at the end of the frame with
    // the streaks as its colour and their brightness as its alpha, and the road
    // is inside the effect rather than in front of it.
    //
    // One shader, two programs, told apart by one uniform: the alternative was
    // a second shader that shared the ray reconstruction, the palette and the
    // hash with this one and would have had to be kept in step with all three.
    // **The hue has to survive the brightness, and it only does if the colour is
    // not flat.** Alpha carries the streak's falloff now, so a colour scaled by
    // a constant is that constant everywhere — at 2.6 every channel clipped and
    // every streak came out white. Tying the scale to the falloff instead puts a
    // white-hot core in the middle of each one and leaves the head and tail
    // under the clip, which is where the colour lives.
    //
    // And the palette is walked along the streak as well as between them:
    // `spectrum` takes the seed *plus the radius*, so each star shifts hue as it
    // runs outward rather than being one flat colour flying past.
    const sky = haze.add(field.scale(behind)).add(moon).scale(1 - veilAmt).add(lit.scale(veilAmt));
    return vec4(
      mix(
        sky,
        mix(vec3(1, 1, 1), spectrum(seed * 40 + rr * 2.5), 0.7).scale(0.85 + 1.9 * bolt),
        uOver,
      ),
      mix(1, min(bolt * 1.7 + rim, 1), uOver),
    );
  },
});
