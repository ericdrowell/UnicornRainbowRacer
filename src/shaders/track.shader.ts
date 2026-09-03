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
    // metre either side of that. The bob is decoration: what decides a boost is
    // the same lateral band it always was, in physics.shader.ts. A unicorn
    // cannot jump, so a ring it had to be under would be a ring it could miss
    // for reasons it could do nothing about.
    const hub = storageRead(uTrack, ri)
      .xyz.add(arm.scale((storageRead(uTrack, uBase + slot).x - 1) * 9))
      .add(up.scale(4.5 + sin(uTime * 1.2 + slot) * 1.2));
    const world = mix(
      aPos,
      hub.add(arm.scale(aPos.y * 6)).add(up.scale(aPos.z * 6)),
      isRing,
    );

    // The ring's corner rides out on the road's own two varyings rather than a
    // third: 9 is outside anything `vU` can otherwise be, so `vU - 9` is the
    // corner and the marker at once.
    v.vU = mix(aEdge.x, 9 + aPos.y, isRing);
    v.vV = mix(aEdge.y, aPos.z, isRing);
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
    // **Drawn out of `length(uv)`, not out of geometry.** A torus of triangles
    // has a silhouette; this has a falloff, on a surface where every other light
    // is analytic for exactly that reason. It is also four vertices a ring
    // instead of forty.
    //
    // 0.75 is the ring's radius in a quad whose half-width is 6 metres, which
    // puts the ring at 4.5 across — a third of the road, as asked — and leaves a
    // metre and a half of quad outside it for the glow to spread into.
    //
    // The alpha is the glow. That is what keeps the corners of the quad from
    // being opaque black over the road behind: the program blends, the road
    // returns 1 and is untouched by it, and the ring fades out into nothing
    // before it reaches its own edges.
    //
    // Gold, and the animation moved from hue to brightness: a bright band travels
    // round the ring instead of the colour changing. Cheaper too — a rainbow cost
    // a `spectrum` call, which is three cosines, and this is one sine.
    //
    // 2.2 and 1.45 against 0.3 of blue is past 1 in two channels, so the core
    // clips to a warm white and the gold lives in the falloff either side of it.
    // That is how the rails and the tiles are lit; a gold painted at 1 would be
    // the dullest thing on a road that is already glowing.
    const rx = vU - 9;
    const glow = pow(1 - smoothstep(0, 0.32, abs(sqrt(rx * rx + vV * vV) - 0.75)), 3);
    return vec4(
      mix(
        lit
          .add(glass.scale(halo * 0.8))
          .add(vec3(0.55, 0.95, 1).scale(lip * 0.9))
          .add(vec3(1, 0.97, 1).scale(core * 3.4)),
        vec3(2.2, 1.45, 0.3).scale(glow * (1.6 + 0.5 * sin(rx * 3 + vV * 2 + uTime * 3))),
        step(2, vU),
      ),
      mix(1, min(glow * 1.6, 1), step(2, vU)),
    );
  },
});
