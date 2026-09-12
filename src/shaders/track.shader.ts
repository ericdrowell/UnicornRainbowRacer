import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  floor,
  fract,
  max,
  min,
  mix,
  mod,
  normalize,
  sign,
  pow,
  exp,
  length,
  smoothstep,
  cross,
  dot,
  step,
  storageRead,
  type Vec3,
} from "brometal";

/**
 * The palette, as a cosine rather than a table.
 *
 * Six named colours would need six constants and a chain of comparisons to pick
 * between them; three cosines a third of a turn apart sweep the same hues for a
 * few characters, and the DSL has no arrays to hold a table in anyway.
 */
function spectrum(k: number): Vec3 {
  return vec3(
    0.5 + 0.5 * cos(k),
    0.5 + 0.5 * cos(k + 2.09),
    0.5 + 0.5 * cos(k + 4.19),
  );
}

/**
 * The rainbow road: one ribbon lofted along the track's centreline, surfaced as
 * a lattice of lit panels rather than as painted lanes.
 *
 * The geometry arrives already flattened — game.js sweeps the centre points into
 * a strip and hands over two numbers per vertex, how far across the road it sits
 * and how far along. Everything here is a function of those two, which is what
 * makes the surface independent of how finely the strip was tessellated: tiles
 * do not stretch on tight corners or compress on straights, because they are
 * measured in track distance rather than in vertices.
 *
 * **The lattice is fixed to the road and the colour is not.** A tile is a place
 * on the track — it has to be, or the grid slides underfoot while the unicorn
 * stands still — so nothing about the geometry moves. What moves is the hue
 * field washing over it, which is why the time term lives in the fragment, as a
 * drift in the colour, rather than in the vertex stage scrolling the surface
 * bodily.
 *
 * **Colour is sampled per tile, from a field that varies over hundreds of
 * metres.** Every fragment of a panel gets the hue at that panel's index, so
 * each one is flat and the gradient appears as steps from panel to panel — which
 * is the look: illuminated tiles that happen to form a rainbow, not a rainbow
 * with a grid drawn over it. Because the field's wavelength is far longer than a
 * tile, a whole stretch of road leans lavender, the next leans pink, and no
 * single view carries the entire spectrum at once. Sampling a *continuous*
 * rainbow instead is a real alternative and it was tried — the road becomes one
 * unbroken wash, softer and with nothing to hold the eye at mid-distance. This
 * is the tiled version of the same field, and the two differ only by a `floor`.
 *
 * **A panel is edged, and the edging is made of the panel.** Its interior is
 * flat; the outer eighth is the same colour scaled up or down, brighter towards
 * one corner and darker towards the opposite one, so each panel reads as a tile
 * with thickness rather than as a square of paint. Nothing is *added* to make
 * that edge — no white, no black, no line — because two things that were added
 * here before both failed the same way: a sub-grid of four faint traces each
 * way, which aliased into moiré by mid-distance, and a centre-to-seam falloff
 * that at twelve panels across, seen at speed, read as black gridlines lying
 * over the road. Scaling the panel's own colour cannot do either: a seam is
 * always a shade of the hue already there, so where two neighbours agree the
 * lattice still quietly breaks up.
 *
 * **There is no post-process bloom, so the bloom is built into the shapes.** The
 * runtime has no render targets — there is nowhere to draw a bright pass and
 * blur it back — so glow is analytic. Panels are driven past 1 so their pastels
 * clip towards white, the rail carries a wide skirt inboard of its core, and the
 * core itself is pushed well past white. What this cannot do is bleed *outward*,
 * past the edge of the ribbon into open space: there are no fragments out there
 * to brighten. The silhouette is a hard edge against the dark, and only a second
 * pass would soften it.
 */
export const Track = shader({
  attributes: {
    aPos: "vec3",
    /** Across the road in -1..1, and distance travelled along it. */
    aEdge: "vec2",
  },
  // The unicorn, mirrored through the road plane and drawn to its own target.
  // Sampled here rather than blended into the frame directly, so the road can lay
  // down one resolved image instead of every overlapping triangle of the model in
  // turn.
  uniforms: {
    uTime: "float",
    /**
     * Tile rows to road-ring index — `1 / (PATTERN * 0.4456 * 2)`. A boost ring
     * knows which slot it is and nothing else; this is how it finds the piece of
     * road it stands on.
     */
    uStep: "float",
    /** Where the pickup table starts in `uTrack`, one vec4 a slot. See game.js. */
    uBase: "float",
  },
  // Read-only here. Physics writes it, and a read_write binding could not be
  // visible to a vertex stage at all — the camera would have to come back
  // through the CPU, a frame late, to arrive as a uniform instead.
  storage: { uState: "vec4", uTrack: "vec4" },
  varyings: { vU: "float", vV: "float", vWorld: "vec3" },

  vertex({ aPos, aEdge }, { uState, uTrack, uTime, uStep, uBase }, v) {
    // ── Boost rings ────────────────────────────────────────────────────────
    // **Four vertices that are not a position.** A ring rides in the road's own
    // buffers so it costs no second program, and it is marked by an `aEdge.x` no
    // road vertex can have — the road's runs -1 to 1. What its `aPos` carries is
    // the slot it belongs to and which corner of the quad it is, because where a
    // ring *is* depends on the road beneath it, and the road is a storage buffer
    // this stage can read. Building it on the CPU would mean a second copy of
    // the centreline in JavaScript.
    //
    // `slot` is zeroed for road vertices so both reads stay in range: this runs
    // for every vertex on the track, and there is no branch to hide it behind.
    //
    // One marker, 9, and the road's own `aEdge.x` runs -1 to 1 so it cannot
    // collide with it. It says only "this is a pickup" — that `aPos` is a slot
    // and two angles rather than a position.
    //
    // There were three, and then two. 3 was a gumball in flight and then a beam
    // hung off the horn, and both went with the shooting. 5 was a star against
    // 9 for a ring, which put *which pickup this is* in the vertex attribute —
    // and it is in the table, one read below, where the physics stage reads it
    // from too. A fact in two places is a fact that can disagree.
    const isSpec = step(4, aEdge.x);
    // **8 is the finish gate, 9 is a pickup**, and both are past the 4 that tells
    // a swept vertex from a road one — so everything below is shared and only
    // three numbers differ. It costs a marker value rather than a program, a
    // vertex format or a second copy of the centreline in JavaScript.
    const isFin = isSpec * (1 - step(8.5, aEdge.x));
    // The skin over the hole, marked in the other component so `aEdge.x` keeps
    // meaning one thing. It rides every stage of the sweep below and changes
    // three of them: the radius, the normal and the alpha.
    const isFilm = isSpec * aEdge.y;
    const isStar = step(9.5, aEdge.x);
    let slot = aPos.x * isSpec;
    if (isStar > 0.5) slot = storageRead(uState, 146 + aPos.x).x;
    // Sixteen rows to a slot and the pickup seated eight rows in, which is the
    // number physics.shader.ts seats its hitbox on: a hitbox anywhere but where
    // this hangs the thing is a pickup off a piece of empty road.
    // Zeroed for the gate, which is what stands it on the start line: the slot
    // arithmetic is a pickup's, and the gate belongs to the lap rather than to a
    // piece of road some way along it.
    const ri = floor((slot * 16 + 8) * uStep) * 3 * (1 - isFin);
    // The slot, whole: `.x` the lane, `.y` the type — 0 a ring, 1 a star — and
    // `.z` the time a star was collected, nought until it was. One read, and it
    // is what decides which shape the sweep below turns into.
    const rec = storageRead(uTrack, uBase + slot);
    const lane = rec.x;
    // ── A star that has been taken ─────────────────────────────────────────
    // **It goes, but not on the frame it is touched.** A pickup that simply
    // stops being drawn gives the player nothing to confirm what happened — at
    // ninety metres a second it is behind the camera before the eye gets to it,
    // and all that is left is a gauge that went up for reasons you have to
    // infer. A fifth of a second of collapsing to a point is the whole
    // acknowledgement, and it is enough: it is gone by the time you are level
    // with where it was, and the eye still catches that something happened.
    //
    // It lingered for three seconds once, spinning off and rising as it went,
    // back when a star had points to spin. A sphere has nothing to show a spin
    // with, and three seconds of a ball sitting on the road slowly getting
    // smaller reads as a bug rather than as a pickup.
    //
    // Shrinking rather than dissolving, because this pass is opaque — there is
    // no alpha to fade and no sorted transparent pass to put one in.
    //
    // Everything here is gated to nought for a star that has not been taken, and
    // gated by the *stamp* rather than by a branch: `sGone` is nought when `.z`
    // is, which makes `sAge` nought, which makes the fade one. An untouched star
    // falls through unchanged and no `mix` is needed to protect it.
    const sGone = step(0.001, rec.z);
    const sAge = (uTime - rec.z) * sGone;
    const sFade = 1 - smoothstep(0, 0.2, sAge);
    const arm = cross(
      storageRead(uTrack, ri + 1).xyz,
      storageRead(uTrack, ri + 2).xyz,
    );
    const up = storageRead(uTrack, ri + 2).xyz;
    // Nine metres between lane centres — a third of the road — and the ring's
    // own radius is 4.5, so it sits with its bottom on the surface and bobs a
    // metre either side of that. It does dip through the road at the bottom of
    // the cycle: hanging it clear of the surface instead was tried, and a ring
    // that never breaks the road reads as floating well above it.
    //
    // The bob is decoration: what decides a boost is the same lateral band it
    // always was, in physics.shader.ts, which never looks at height. A unicorn
    // cannot jump, so a ring it had to be under would be a ring it could miss
    // for reasons it could do nothing about.
    //
    // **A star hangs from this too.** Same lane centres, same bob on the same
    // clock off the same slot — so a run of three sits in one lane and rides one
    // wave, a radian of phase apart because the slot number is in the angle.
    //
    // **It rides lower, and that is the one thing about the placement that is
    // not a ring's.** A ring is 4.5 across and centred at 4.5, so it stands on
    // the road with its hole where a body goes through; a sphere of 1.5 hung at
    // the same height floats at head level with clear air under it, which reads
    // as scenery passing overhead rather than as something on the road to
    // collect. Centred at 2.7 with a bob of 0.9 it comes down to 1.8 at the
    // bottom of the wave — the sphere's underside 0.3 clear of the surface,
    // close enough to skim it — and lifts to 3.6, still inside the body's own
    // height. It is a thing on the road at every point in the cycle.
    //
    // Two numbers, the same way the shape is two numbers below: a height and an
    // amplitude, mixed off the type. The lane and the clock stay shared.
    const H = 4.5 - 1.8 * isStar;
    const A = 1.2 - 0.3 * isStar;
    // The gate takes neither the lane offset nor the bob: it is centred on the
    // centreline and centred on the road *surface*, so the ribbon runs through
    // the middle of it and the arch stands over the whole width. A gate that
    // bobbed would be a gate the lap line moved under.
    // **The gate sits high, not centred.** Hung on the centreline with its middle
    // on the road surface it is half buried, and the half you see is a hoop with
    // its widest point at knee height — which reads as a ring lying *on* the road
    // rather than an arch over it. Lifting the centre 5.44 metres puts roughly
    // two thirds of the ring above the surface: the road still runs through it,
    // the sides still come down past the edges, and the shape overhead is the
    // one the eye picks up from a long way back.
    const hub = storageRead(uTrack, ri)
      .xyz.add(arm.scale((lane - 1) * 9 * (1 - isFin)))
      .add(
        up.scale(
          (H + sin(uTime * 1.2 + slot) * A) * (1 - isFin) + 5.44 * isFin,
        ),
      );
    // **A torus, swept here rather than stored.** `aPos.y` runs round the ring
    // and `aPos.z` round the tube, both 0 to 1, and the two angles they become
    // are all a torus is. `rad` is the outward direction in the ring's plane —
    // the plane the quad used to span — and the tube is swept from `rad` toward
    // the road's tangent, which is the ring's axis and therefore the direction
    // you drive through it.
    //
    // Every basis vector here is already unit length and mutually perpendicular
    // (`arm` is the cross of the other two), so `nrm` comes out unit without a
    // normalize: it is a unit combination of two orthogonal unit vectors.
    //
    // 4.5 is the radius the ring has always had, a third of the road. 0.6 is the
    // tube — thick enough to catch a highlight across it, thin enough that the
    // hole is still the thing you aim at.
    // **They turn, because everything out here is drifting.** A quarter of a
    // radian a second is a corner every three seconds or so at ten sides — slow
    // enough to read as float rather than as spin.
    //
    // **Off for a star, and that is a constraint rather than a taste.** A ring is
    // a circle sampled at ten angles, so turning the angles turns the polygon and
    // nothing else moves. A star is not: its points come from `sin(5 * th)`, and
    // they are *sharp* only because game.js lands its ten vertices exactly on
    // that swing's peaks and troughs. Rotate the angle continuously and the
    // vertices slide off the peaks — the radii sampled stop being the extremes,
    // and the star does not spin, it melts into a decagon and back twice a turn.
    // Rings and the gate have no such alignment to lose.
    const th = aPos.y * 6.2832 + uTime * 0.25;
    // **Half a turn for the star, a whole one for the ring**, and that is not a
    // tidy-up — it is the difference between a clean surface and a flickering
    // one. The ring is a tube and needs the full circle to close it. The star's
    // profile depends on `cos(ph)` and nothing else, so `ph` and `2pi - ph` land
    // on exactly the same point: sweep a whole turn and every facet is drawn
    // twice, coincident, at identical depth.
    //
    // Two coincident sheets would be harmless if they agreed. They do not: the
    // rim rings sit at `cos(pi/2)` and `cos(3pi/2)`, which come out as plus and
    // minus a hundred-millionth rather than nought, so `sign(cp)` below hands
    // one of them the front face's normal and the other the back's. Two sheets,
    // same depth, different shading — which reads as the colour tearing across
    // the star as it turns. Sweeping half a turn covers the surface once and
    // there is nothing left to disagree with.
    const ph = aPos.z * 6.2832;
    const cp = cos(ph);
    const sp = sin(ph);
    const tng = storageRead(uTrack, ri + 1).xyz;
    const rad = arm.scale(cos(th)).add(up.scale(sin(th)));
    // **A star is this same torus with the hole closed up.** A torus is a circle
    // of radius `r` swept round a circle of radius `R`, and at `R = 0` that is a
    // sphere: `rad` is a unit vector in the road's upright plane and `tng` is
    // perpendicular to it, so `rad * cos(ph) + tng * sin(ph)` is a unit vector,
    // and sweeping `th` through it covers the whole ball.
    //
    // So there is no second shape here at all. Two numbers change — the major
    // radius goes to nought, the minor opens out — and the three lines that draw
    // a ring draw a sphere. **The normal does not even change:** a torus's is
    // `rad * cos(ph) + tng * sin(ph)` whatever `R` is, and at `R = 0` that is
    // the sphere's own outward direction, so `vV` below is untouched.
    //
    // It replaces a five-pointed star that was its own sweep, its own facet
    // normal, its own facet coordinates riding on `vWorld`, its own seam
    // highlight and its own rim-to-centre colour ramp — a whole parallel object
    // for a thing on the road you drive at.
    //
    // Shrinking to nothing over the three seconds after it is taken, which is
    // all that is left of the collect animation: a sphere does not read as
    // spinning, so the spin went with the points that used to show it.
    // **The ring is a circle; the pickup is a star**, and they are the same two
    // lines with different numbers in them. Everything a shape needs here is how
    // far out from the axis it sits and how far along it — `radial` and `axial` —
    // so that is what the type picks between.
    //
    // The ring holds 4.5 the whole way round and comes out as a ten-sided ring —
    // ten because that is how finely game.js divides the sweep, and at the size a
    // ring is read at, ten sides is a circle. It was a star for a while, and a
    // star is the wrong thing for the shape you aim *through*: the hole stops
    // being a hole you can judge, because how much room is left depends on which
    // way round the points happen to sit.
    //
    // **The pickup is a bipyramid over a star polygon**, which is what a 3D star
    // is: a flat five-pointed star with its centre pulled out to a point on both
    // faces, so every arm carries a ridge down its spine and each side of that
    // ridge catches the light differently. the swung radius is the polygon — the radius swung
    // five times round the sweep, `sin(5 * th)`, ten corners alternating point
    // and valley — and the two lines under it turn that outline into a solid.
    //
    // `sin` rather than `cos` is what stands it upright: `th` is measured from
    // `arm`, across the road, so `up` is a quarter turn along at `th = pi/2`,
    // where `sin(5 * pi/2)` is 1 and the swing is at its widest. A point sits
    // directly over the centre and it reads as a star rather than a pinwheel.
    // game.js offsets its divisions half a step so the ten corners land on
    // vertices; between them the sweep would cut every one of them flat.
    //
    // **`1 - abs(cp)` against `cp` is the whole bipyramid.** As `cp` runs 1 to
    // -1 the radius goes nought, full, nought while the height goes `+T`, 0,
    // `-T` — apex, rim, apex. Both are *linear* in `cp`, and that is the point:
    // a linear profile means every intermediate ring lands on the same plane as
    // its neighbours, so the faces come out genuinely flat and the silhouette
    // stays the polygon rather than bulging off it. The apex is a single point
    // because the radius is nought there for every `th` at once.
    //
    // This replaced a spindle torus — the same star outline with a round
    // cross-section — which read as a jewel with a star painted on it rather
    // than as a star, because a curved face has no ridge and no facets to shade.
    //
    // 0.35 is the half-thickness against the polygon, so the arms are about a
    // fifth as deep as they are long: enough of a ridge to split every arm into
    // two shades, flat enough to still read as a star seen face-on.
    //
    // 1.2 against the ring's 4.5 is what makes it the small one: the pickup
    // measures 1.7 across at its widest against the ring's 9, so the two never
    // read as the same object even when they sit in the same lane.
    // The rotating decagon must clear both road edges even when a flat faces
    // them. With a 13.5 m half-width, 5.44 m hub height and 2.4 m tube,
    // R >= 2.4 + length(vec2(13.5, 5.44)) / cos(pi / 10) = 17.704.
    // 17.9 leaves about 20 cm of clearance at each road edge at every angle.
    // The gate's tube is four times a boost ring's. It is drawn at three and a
    // half times the radius and read from much further off, and 0.6 at that size
    // is a wire — thin enough that the arch breaks up against the star field
    // instead of reading as one solid loop.
    const tube = mix(0.6, 2.4, isFin);
    // The film is a flat fan, so its radius is simply the fraction of the way
    // out — from nought at the middle to the tube's *inner* edge, where it meets
    // the ring without poking through it.
    const ringR = mix(4.5, 17.9, isFin);
    // Only rings and films reach the mesh shading; light quads override it.
    const radial = mix(ringR + tube * cp, (ringR - tube) * aPos.z, isFilm);
    const axial = tube * sp;
    const nrm = mix(rad.scale(cp).add(tng.scale(sp)), tng, isFilm);
    let world = mix(
      aPos,
      hub.add(rad.scale(radial)).add(tng.scale(axial)),
      isSpec,
    );

    // The ring's corner rides out on the road's own two varyings rather than a
    // third: 9 is outside anything `vU` can otherwise be, so `vU - 9` is the
    // corner and the marker at once.
    // Lit here, once a vertex, and sent down as a single number. A normal wants
    // a varying of its own, and the fragment stage does not need one for this:
    // the surface is a smooth swept tube with no texture on it, so between two
    // vertices there is nothing for a per-pixel normal to say that interpolating
    // the shading does not already say. The marker keeps its own varying; the
    // light rides in the other, in place of the corner it no longer needs.
    //
    // Fixed in world space, near enough overhead, so the highlight stays put on
    // the ring as the road rolls and banks under it — the one cue that says this
    // is an object sitting in the scene rather than a sprite turning with the
    // camera.
    // The marker carries the pickup's colour with it. 9 is still the flag — no
    // road vertex reaches 2 — and the fraction on top is this slot's own hash,
    // so `fract(vU)` in the fragment is the seed. A varying that was going to be
    // a constant is a varying wasted; this is the same trick the quad corner
    // used to ride on.
    //
    // It carried the type as well while a star was shaded differently from a
    // ring. It is not, any more — same palette, same brightness curve, same
    // everything — so the fragment stage has nothing left to branch on and this
    // is one number again.
    // 20 and up is the film, 9 and up is everything else swept, and the slot's
    // hash still rides in the fraction either way — so the fragment stage gets a
    // third case for one `step` and no new varying.
    // **A star is always gold; a ring keeps the slot's own hue.** The fragment
    // builds its tint from `fract(vU)` through the same cosine palette the sky
    // uses, so pinning that fraction pins the colour — no branch down there, no
    // extra varying, and one expression still serves all three shapes.
    //
    // 0.131 is not a guess. The fragment reads it as `fract(vU) * 40`, so this is
    // 5.24 radians into the palette, which is where its red and green curves
    // cross at 0.751 with blue at nought — the one pure yellow the wheel has.
    // Everything else lands on a pastel, which is right for a ring you drive
    // through and wrong for a thing called a star.
    // **Three bands, one number.** 9 and up is a ring or the gate, 20 and up a
    // star, 31 and up a film — and the slot's hash still rides in the fraction
    // of all three. The fragment tells them apart with two `step`s and needs no
    // varying of its own for either.
    //
    // A star and a film are mutually exclusive — only a ring has a hole to skin
    // — so the two offsets can simply add.
    // Keep interpolated material IDs away from integer boundaries: slot zero
    // otherwise lands exactly on the film cutoff and the tint's fract seam.
    v.vU = mix(
      aEdge.x,
      9.01 + 22 * isFilm + fract(sin(slot * 12.99) * 43758.5) * 0.98,
      isSpec,
    );
    // A film sends the radius out where a ring sends its light, which is what
    // gives the fragment something to build a rim out of.
    v.vV = mix(
      aEdge.y,
      mix(
        0.22 + 0.78 * max(dot(nrm, vec3(0.28, 0.86, 0.43)), 0),
        aPos.z,
        isFilm,
      ),
      isSpec,
    );
    // The road point itself, unprojected. The shadow below is cast in world
    // space, so it needs where this fragment actually is — the position this
    // stage returns has already been through the camera and lost that.
    // The road point itself, unprojected. The shadow below is cast in world
    // space, so it needs where this fragment actually is — the position this
    // stage returns has already been through the camera and lost that.
    //
    // It carried facet coordinates for a star for a while, because a faceted
    // star needed to know where on a facet a pixel sat and there was no third
    // varying free. A sphere has no facets and wants nothing here.
    // Film coordinates stay attached to the gate and have the same scale on
    // boost rings and the finish gate. Other surfaces do not use these coordinates.
    v.vWorld = vec3(cos(th) * aPos.z, sin(th) * aPos.z, 0);
    // The view-projection, four columns from slot 4. A column-major matrix
    // times a point is its columns weighted by that point's components, which
    // is all `mat4.mul` was doing — the DSL has no mat4 in a storage buffer to
    // reconstruct, and it does not need one.
    if (isStar > 0.5) world = hub;
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const c3 = storageRead(uState, 7);
    // Kept so the fragment can find itself on screen: the reflection target is in
    // screen space, and the divide by w has to happen per fragment rather than
    // per vertex or the lookup skews across a triangle.
    let clip = c0
      .scale(world.x)
      .add(c1.scale(world.y))
      .add(c2.scale(world.z))
      .add(c3);
    // A point-like light carried by a quad, always facing the camera.
    // Keep the actual pickup's depth so roads and racers occlude its glow.
    if (isStar > 0.5) {
      v.vU = 40;
      v.vV = sFade;
      v.vWorld = vec3(aPos.y, aPos.z, slot);
      clip = clip.add(vec4(aPos.y * 55.08 * (9 / 16) * sFade,
        aPos.z * 55.08 * sFade, 0, 0));
    }
    return clip;
  },

  fragment({ uTime, uState }, { vU, vV, vWorld }) {
    let result = vec4(0, 0, 0, 0);
    if (vU > 39) {
      const r = length(vec3(vWorld.x, vWorld.y, 0));
      const phase = vWorld.z;
      const time = uTime;
      let rays = 0;
      // Each ray wanders and breathes independently; no rigid spinning star.
      for (let i = 0; i < 6; i++) {
        const seed = phase + i * 2.17;
        const wave = sin(time * 1.4 + seed);
        const angle = i * 1.0472 + wave * 0.28;
        const along = vWorld.x * cos(angle) + vWorld.y * sin(angle);
        const across = abs(vWorld.y * cos(angle) - vWorld.x * sin(angle));
        const reach = 0.48 + 0.3 * wave;
        const width = 0.014;
        rays += exp(0 - across / width)
          * pow(max(0, 1 - max(0, along) / reach), 2)
          * step(0, along);
      }
      const core = exp(0 - r * r * 1500) * 2.5;
      const halo = exp(0 - r * 7) * 0.22;
      const energy = core + halo + rays * 0.9;
      const alpha = min(1, energy) * (1 - smoothstep(0.8, 1, r));
      const tint = mix(vec3(1, 0.78, 0.3), vec3(1, 1, 1), min(1, energy));
      result = vec4(tint.scale(1.35), alpha * vV);
    } else {

    // Twelve panels across a road 27 wide, and 0.4456 along, which is four panels
    // to each 2π/0.7 of `vV` — so they come out square, and a lap holds a whole
    // number of them. That second part is not decoration. game.js sizes `vV` so
    // that a lap is a whole number of wave periods, and a tiling that does not
    // divide into the same period leaves one short row of panels across the
    // start line, which is precisely where the player is looking at lap end.
    const across = (vU * 0.5 + 0.5) * 12;
    const along = vV * 0.4456;
    const col = floor(across);
    const row = floor(along);

    // The hue field. Two waves, both slow: one turns over about every 280 metres
    // of road, the other about every 830 and leans across the width as it goes,
    // so the wash arrives diagonally rather than as bands lying square across
    // the track. Their sum swings wide enough to reach right round the wheel, so
    // no colour is missing from the road — only from any one stretch of it.
    //
    // Sampled at `row`/`col`, the panel's index, rather than at the fragment:
    // that is what makes a panel one flat colour.
    //
    // **Time moves the field along the road, it does not shift the palette.**
    // Those are different things and they look nothing alike. Added on the
    // outside — which is where it used to be — every panel on the track changes
    // hue in lockstep and the road pulses as one surface. Added to `row`, on the
    // inside of both waves, the pattern *travels*: each panel takes the colour
    // its neighbour had a moment ago, and light appears to run along the ribbon
    // while the panels themselves stay where they are.
    //
    // `+ uTime` and not `-` is what sends it the way it goes. A feature of the
    // wave sits where its argument is constant, so `row + kt` holds a colour at
    // `row = c - kt` — decreasing, back down the track, against the direction of
    // travel. Standing still you watch it come towards you; driving, you run
    // into it, which is the way round that reads as speed.
    //
    // Twelve panels a second, about twenty-seven metres of road — the light now
    // runs backwards down the track faster than the unicorn can drive forwards
    // over most of its range. What that means for a single panel is not the
    // wavelength divided by the speed: the amplitudes multiply into the rate
    // too, and a panel's hue moves at `k * (0.05 * 2.6 + 0.017 * 1.6)` radians a
    // second at the fastest part of the swing. At this k that is a full turn
    // round the wheel in about four seconds.
    //
    // It has been up and down — 4.5, halved to 2.5, then 6, now 12 — and none of
    // them flicker, because none of them can: neighbouring panels are a fraction
    // of a radian apart, so a panel only ever slides to a colour next door to
    // the one it had. What the rate decides is whether the road drifts or races,
    // not whether it strobes, which is why it takes being turned this far up.
    //
    // **And five times that under star power**, delivered as accumulated phase
    // rather than as a raised rate — see `.w` of slot 6 in physics.shader.ts for
    // why. 22 is racer zero's sixth word: the road is the player's road, so it
    // is the player's run that speeds it up and not whichever rival happens to
    // be in shot.
    //
    // **48, and it started at 12.** Twelve was arithmetically a doubling and
    // visually nothing, because the player is doing 120 metres a second by then:
    // the pattern's own 27 m/s going to 54 is a small addition on top of that,
    // and the warp streaks and the camera rumble are covering the road at the
    // same time. What the eye is comparing is not the flow against its old self,
    // it is the flow against everything else moving — so the number has to clear
    // that, not merely beat what it was. 48 on top of the base 12 is sixty
    // panels a second, five times normal, about 135 m/s of pattern against 120
    // of driving: the light finally outruns the unicorn.
    const flow = row + uTime * 12 + storageRead(uState, 22).w * 48;
    const wash =
      sin(flow * 0.05) * 2.6 + sin(flow * 0.017 + col * 0.5 + 1.3) * 1.6;
    // Pastel, not pigment. Glass lit from inside washes out towards white as it
    // brightens, and a saturated hue at full strength reads as paint instead.
    // Only a fifth of the way there, though: mixing much white in here as well
    // leaves the whole road frosted and takes the rainbow out of it.
    const glass = mix(spectrum(wash), vec3(1, 1, 1), 0.2);

    // Panels are not identical: each gets a fixed brightness of its own, so the
    // surface reads as a field of separate lamps rather than one printed sheet.
    // The usual hashed sine — cheap, and the banding it is notorious for is
    // invisible once the result only has to look like manufacturing tolerance.
    //
    // This is now the *only* thing distinguishing one panel from the next
    // besides the step in hue, and that is the point. Two things used to be
    // drawn inside a panel and both are gone: four faint lines each way — the
    // sub-grid — and a centre-to-edge falloff that darkened every panel into its
    // own border. The falloff was there to say "pane of glass"; what it actually
    // said, twelve panels across at speed, was "black gridlines". Without it a
    // panel is flat edge to edge, and where two neighbours happen to agree on
    // both `lamp` and hue they merge outright and the lattice disappears for a
    // square or two.
    const lamp = 0.74 + 0.26 * fract(sin(col * 12.99 + row * 78.23) * 43758.5);

    // The edging. Where the panel sits inside its own cell, centred: -0.5 at one
    // seam, +0.5 at the other, in both directions.
    const du = fract(across) - 0.5;
    const dv = fract(along) - 0.5;
    // A band along all four seams — the outer eighth of the cell, softened so it
    // does not crawl at distance.
    const rim = smoothstep(0.4, 0.5, max(abs(du), abs(dv)));

    // **The edging is the panel's own colour, lit from a corner, never a line
    // drawn on top of it.** A black or white border is the obvious way to say
    // "tile" and it is the wrong one here: at twelve panels across, seen at
    // speed, an ink border is what the old centre-to-seam falloff turned into —
    // a grid of dark lines lying over the road rather than a surface made of
    // pieces. So nothing is added; `lit` is only scaled, which keeps every seam
    // in the hue of the panel it belongs to and cannot introduce a colour the
    // rainbow does not already have there.
    //
    // Scaled by which corner it faces, not by distance from the centre, so the
    // ring is not uniform: `du + dv` runs -1 at the near-left corner to +1 at
    // the far-right, so two sides of every panel come up brighter and two fall
    // away, as a bevelled tile does under a single light. A uniform ring reads
    // as an outline; this reads as thickness.
    //
    // ±0.45 at the corners, and only inside `rim`. Enough that the lattice is
    // legible standing still, small enough that at mid-distance neighbouring
    // panels still merge where their hue agrees — which is the break-up the flat
    // panels were tuned for, and what this must not undo.
    //
    // Inlined into `lit` below rather than named: at 44 bytes of budget the
    // `let` for it was four of them over.

    // ── The boost pads ─────────────────────────────────────────────────────
    // Placed, not drawn from data: this is the same arithmetic the physics stage
    // runs to decide whether a unicorn is standing on one, on the same two
    // coordinates, so the painted pad and the working pad cannot drift apart.
    // See the long note in physics.shader.ts.
    //
    // Four of the twelve columns — a third of the road — in the left, middle or
    // right third as the seed says, three tile rows long, one slot every 64
    // rows, and one slot in four left empty so they scatter.
    // ── The start line ─────────────────────────────────────────────────────
    // Two tile rows of checker laid across the road at `along` zero, which is
    // where the ribbon begins and therefore where the lap closes: the strip is
    // emitted from ring zero and its last quad carries a full lap's distance, so
    // this band is the start line and the finish line at once without being
    // drawn twice.
    //
    // Its own grid rather than the road's. A checker on the tiles would be four
    // and a half metres to a square, which reads as two rows of enormous
    // blocks; halving both axes gives a metre or so, which is what a real one
    // looks like. That the two grids share an origin is what keeps the band's
    // outer edge flush with a tile seam instead of cutting one in half.
    //
    // Black is 0.05 and white is 1.6, not 0 and 1. Everything else on this
    // surface is driven past white, so a checker painted at 1 would read as the
    // dullest thing on the road — and a true 0 would be the only place the
    // rainbow goes completely dark.
    const ink = 0.05 + mod(floor(across * 2) + floor(along * 2), 2) * 1.55;
    const lit = mix(
      glass.scale(lamp * 1.32 * (1 - (du + dv) * 0.9 * rim)),
      vec3(ink, ink, ink),
      1 - step(2, along),
    );

    // The rails. This is what sells it as a ribbon in space rather than a
    // painted floor — the edge is the only part of a road with nothing beyond
    // it, so it is the part that has to glow.
    //
    // Three lights in one, because a single stripe is a stripe and three is a
    // lamp: a hot white core clipped well past 1, a cyan-white inner lip just
    // off it, and a skirt spread a third of the way in over the panels, tinted
    // with the road's own colour so the spill belongs to the stretch it lights.
    //
    // The first pass at this was a thin `smoothstep(0.93, 1)` at 1.7, and from
    // the driver's seat the ribbon simply had no edge — the one thing holding
    // the silhouette against black space, and it was a hairline visible only in
    // the far distance where perspective stacked it up. Widened to a fifth of
    // the half-width and driven to 3.4, it is a light source with a body to it.
    // ── What used to be here ──────────────────────────────────────────────
    // A contact shadow first — a blob under each animal — and then, when that
    // went, a reflection: every racer drawn a second time into a full-screen
    // target, mirrored through its own road plane, and sampled back here at this
    // fragment's own place on screen.
    //
    // Both are gone, and the loop that fed them with them: ten storage reads a
    // fragment to ask which racers were near this piece of road and on which
    // side of it, plus a fresnel to keep the reflection from reading as a decal.
    // 351 zipped bytes across this stage, the model's vertex stage, and the pass
    // and render target in game.js — the single largest visual saving available,
    // on a road that is already a lit rainbow and does not much need to be a
    // mirror too.
    //
    // It is worth knowing what the reflection was solving, if it ever comes
    // back: the target is in screen space and has no depth test, so *any* road
    // at a pixel picked up whatever landed there, including the underside of a
    // loop. `owns` — the near-and-on-this-side term off that same loop — is what
    // stopped you seeing the field through the road from below.
    const edge = abs(vU);
    const core = smoothstep(0.9, 1, edge);
    const lip = smoothstep(0.78, 0.97, edge);
    const halo = pow(smoothstep(0.3, 1, edge), 2);

    // ── The ring ───────────────────────────────────────────────────────────
    // **Nothing to compute: the shape arrived as triangles.** This was a disc
    // drawn out of `length(uv)` on a flat quad, and the whole of it — the radius
    // test, the tube normal reconstructed from a cross-section coordinate, the
    // hand-written light — existed to imply a solid that was not there. The
    // vertex stage sweeps a real torus now, so all that is left here is the gold
    // it is made of and the light it already carries in `vV`.
    //
    // **Gold is a ratio, and only survives if it is under the clip.** Driving
    // red and green both past 1 gives (1, 1, b), which is yellow by definition
    // and no adjustment underneath can fix it, because the clip has thrown the
    // ratio away. Green sits at 0.78 of red at full light — bright enough to
    // read as gold rather than bronze, short enough of red to stay gold rather
    // than turn into a highlighter.
    //
    // The specular is the only white, and `pow(vV, 30)` keeps it to a hotspot
    // the size a real one would be on a tube this thin.
    //
    // Opaque, so the alpha is 1 for the road and the rings alike, and the
    // separate depth-write-off pass that the transparent version needed is gone.
    // **`min` here is load-bearing.** `vV` carries the light on a ring and the
    // distance travelled on the road — hundreds, thousands by the last lap — and
    // this branch is evaluated for *every* fragment, the road's included,
    // because `mix` computes both sides before it picks one. Left unclamped that
    // put a number in the billions through the ring branch; when that reached
    // `pow` it became Inf, and `mix(road, Inf, 0)` is not `road`, it is
    // `road + 0 * (Inf - road)` — and `0 * Inf` is NaN. The whole road went dark
    // and it was not dark, it was undefined. On a ring this is already 0.22 to 1
    // and the clamp never bites.
    const gold = min(vV, 1);
    const film = step(31, vU);
    // Broad, slowly drifting interference colours, softly diluted with white.
    // The center stays almost clear; grazing reflections gather at the rim.
    const swirl = sin(vWorld.x * 2 + sin(vWorld.y * 3 - uTime * 0.12)) +
      sin(vWorld.y * 2.5 + uTime * 0.09);
    const thick = 5.5 + swirl * 1.2 + gold * gold * 2;
    const iris = mix(vec3(1, 1, 1), vec3(
      0.5 + 0.5 * cos(thick),
      0.5 + 0.5 * cos(thick * 1.18),
      0.5 + 0.5 * cos(thick * 1.44),
    ), 0.42);
    const filmRim = pow(gold, 4);
    // A soft upper-left reflection breaks up the silhouette. Clamp its input
    // because this expression also runs on world coordinates for the road.
    const reflection = pow(min(1, max(0, -vWorld.x * 0.6 + vWorld.y * 0.8)), 8);
    const sheen = filmRim * (0.12 + reflection * 0.55);
    // Both kinds take their colour from the sky, off the same cosine palette and
    // the same 0.45 toward white — the pastels overhead, on the road.
    // `fract(vU)` is the slot's hash, laid into the marker by the vertex stage.
    //
    // **One tint, because there is one shape.** A star had its own: the palette
    // at the rim going white toward the middle, keyed off facet coordinates this
    // stage no longer receives. It was there because a faceted star needed the
    // facets to read, and a sphere has none — it is lit by its own normal like
    // the ring's tube, out of `vV`, and wants nothing said about it here.
    // A ring takes the slot's own pastel off the sky's palette. **A star is
    // always gold**, and not a pastel gold: the palette run through `mix` toward
    // white lands on cream, which is what a star looked like before. This is the
    // colour named outright, saturated, and it is the one pickup on the road
    // that should read the same every time you see it.
    const tint = mix(vec3(1, 1, 1), spectrum(fract(vU) * 40), 0.45);
    result = vec4(
      mix(
        mix(
          lit
            .add(glass.scale(halo * 0.8))
            .add(vec3(0.55, 0.95, 1).scale(lip * 0.9))
            .add(vec3(1, 0.97, 1).scale(core * 3.4)),
          // **Driven past 1, which is the only bloom on this road.** There is no
          // post-process anywhere here: everything that glows does it by being
          // brighter than the display can hold, so the core clips to white and the
          // colour survives in the falloff either side. 2.2 on a squared lambert
          // takes the lit crown of the tube well past the clip while the shaded
          // underside stays at 0.55 — lifted, so a ring reads as something
          // emitting rather than something lit, and is still legible from the far
          // side of a corner where nothing is shining on it.
          //
          // Squared rather than linear so the falloff from the crown is quick;
          // linear spreads the bright band over most of the tube and the whole
          // thing washes out to white.
          // **No emissive floor on a star, and that is what keeps it a star.** A
        // constant added here lifts every facet past the clip at once: red and
        // green peg at 1 whatever the light is doing, the ten faces stop
        // differing from each other, and the thing renders as a glowing ball
        // with no shape in it. Left alone, blue runs from 0.16 on the shaded
        // facets to 0.68 on the lit ones, and that spread is the whole silhouette
        // — the gold reads because the facets differ, not because they are
        // bright.
        tint.scale(0.85 + 3.4 * gold * gold),
          step(4, vU),
        ),
        iris.add(vec3(1, 1, 1).scale(sheen)),
        film,
      ),
      // Films blend after opaque geometry, testing depth without writing it.
      // The opacity is identical from either side of the gate.
      mix(1, 0.36 + filmRim * 0.22 + sheen * 0.28, film),
    );
    }
    return result;
  },
});
