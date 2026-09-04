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
  pow,
  smoothstep,
  sqrt,
  cross,
  dot,
  step,
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
    aPos: 'vec3',
    /** Across the road in -1..1, and distance travelled along it. */
    aEdge: 'vec2',
  },
  // The unicorn, mirrored through the road plane and drawn to its own target.
  // Sampled here rather than blended into the frame directly, so the road can lay
  // down one resolved image instead of every overlapping triangle of the model in
  // turn.
  uniforms: {
    uTime: 'float',
    /**
     * Tile rows to road-ring index — `1 / (PATTERN * 0.4456 * 2)`. A boost ring
     * knows which slot it is and nothing else; this is how it finds the piece of
     * road it stands on.
     */
    uStep: 'float',
    /** Where the ring lane table starts in `uTrack`. See game.js. */
    uBase: 'float',
  },
  // Read-only here. Physics writes it, and a read_write binding could not be
  // visible to a vertex stage at all — the camera would have to come back
  // through the CPU, a frame late, to arrive as a uniform instead.
  storage: { uState: 'vec4', uTrack: 'vec4' },
  varyings: { vU: 'float', vV: 'float', vWorld: 'vec3', vClip: 'vec4' },

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
    const isRing = step(2, aEdge.x);
    const slot = aPos.x * isRing;
    const ri = floor((slot * 64 + 32) * uStep) * 3;
    const arm = cross(storageRead(uTrack, ri + 1).xyz, storageRead(uTrack, ri + 2).xyz);
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
    const hub = storageRead(uTrack, ri)
      .xyz.add(arm.scale((storageRead(uTrack, uBase + slot).x - 1) * 9))
      .add(up.scale(4.5 + sin(uTime * 1.2 + slot) * 1.2));
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
    const th = aPos.y * 6.2832;
    const ph = aPos.z * 6.2832;
    const cp = cos(ph);
    const sp = sin(ph);
    const tng = storageRead(uTrack, ri + 1).xyz;
    const rad = arm.scale(cos(th)).add(up.scale(sin(th)));
    const world = mix(
      aPos,
      hub.add(rad.scale(4.5 + 0.6 * cp)).add(tng.scale(0.6 * sp)),
      isRing,
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
    // The marker carries the ring's colour with it. 9 is still the flag — no
    // road vertex reaches 2 — and the fraction on top is this ring's own hash,
    // so `vU - 9` in the fragment is the seed. A varying that was going to be a
    // constant is a varying wasted; this is the same trick the quad corner used
    // to ride on.
    v.vU = mix(aEdge.x, 9 + fract(sin(slot * 12.99) * 43758.5), isRing);
    v.vV = mix(
      aEdge.y,
      0.22 + 0.78 * max(dot(rad.scale(cp).add(tng.scale(sp)), vec3(0.28, 0.86, 0.43)), 0),
      isRing,
    );
    // The road point itself, unprojected. The shadow below is cast in world
    // space, so it needs where this fragment actually is — the position this
    // stage returns has already been through the camera and lost that.
    v.vWorld = world;
    // The view-projection, four columns from slot 4. A column-major matrix
    // times a point is its columns weighted by that point's components, which
    // is all `mat4.mul` was doing — the DSL has no mat4 in a storage buffer to
    // reconstruct, and it does not need one.
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const c3 = storageRead(uState, 7);
    // Kept so the fragment can find itself on screen: the reflection target is in
    // screen space, and the divide by w has to happen per fragment rather than
    // per vertex or the lookup skews across a triangle.
    const clip = c0.scale(world.x).add(c1.scale(world.y)).add(c2.scale(world.z)).add(c3);
    v.vClip = clip;
    return clip;
  },

  fragment({ uTime, uState }, { vU, vV, vWorld, vClip }) {
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
    const flow = row + uTime * 12;
    const wash = sin(flow * 0.05) * 2.6 + sin(flow * 0.017 + col * 0.5 + 1.3) * 1.6;
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
    // The rings take their colours from the stars, off the same palette and the
    // same 0.45 toward white — the pastels overhead, on the road. `vU - 9` is
    // the ring's hash, laid into the marker by the vertex stage.
    const tint = mix(vec3(1, 1, 1), spectrum((vU - 9) * 40), 0.45);
    return vec4(
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
        tint.scale(0.85 + 3.4 * gold * gold),
        step(2, vU),
      ),
      1,
    );
  },
});
