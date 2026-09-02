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
  mix,
  mod,
  pow,
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
     * The circuit's boost phase — see `points.b` in src/circuits.js. The pads are
     * placed by hashing it against a pad's index down the road, and the physics
     * stage places them by running the identical arithmetic on the identical two
     * coordinates. Neither is the authority; the arithmetic is.
     */
    uSeed: 'float',
  },
  // Read-only here. Physics writes it, and a read_write binding could not be
  // visible to a vertex stage at all — the camera would have to come back
  // through the CPU, a frame late, to arrive as a uniform instead.
  storage: { uState: 'vec4' },
  varyings: { vU: 'float', vV: 'float', vWorld: 'vec3', vClip: 'vec4' },

  vertex({ aPos, aEdge }, { uState }, v) {
    v.vU = aEdge.x;
    v.vV = aEdge.y;
    // The road point itself, unprojected. The shadow below is cast in world
    // space, so it needs where this fragment actually is — the position this
    // stage returns has already been through the camera and lost that.
    v.vWorld = aPos;
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
    const clip = c0.scale(aPos.x).add(c1.scale(aPos.y)).add(c2.scale(aPos.z)).add(c3);
    v.vClip = clip;
    return clip;
  },

  fragment({ uTime, uSeed, uState }, { vU, vV, vWorld, vClip }) {
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
    // Thirty rows into the slot rather than at its edge, which is what keeps the
    // start line clear — see the note in physics.shader.ts. Rows before that
    // land in slot -1 at an offset of 34 or more, which is outside every pad, so
    // the first sixty-odd metres of the lap are pad-free by construction.
    const seat = row - 30;
    const slot = floor(seat * 0.015625);
    const pick = floor(fract(sin(slot * 91.7 + uSeed) * 43758.5) * 4);
    const down = seat - slot * 64;
    const pad = step(abs(floor(across * 0.25) - pick), 0.5) * (1 - step(3, down));

    // One solid triangle, apex forward, sliding up the pad and looping — the
    // next enters the bottom before the last leaves the top.
    //
    // **Pad-local coordinates, but taken from `along`, not from `row`.** The two
    // halves of that sentence are each a bug this went through. Phrased in road
    // coordinates the pattern is wallpaper painted across the whole circuit with
    // each pad cut out of it as a window, so no two pads show the same thing;
    // phrased in `row` it is pad-local and correct and *quantised*, because
    // `row` is `floor(along)` — three integers up the length of a pad, so a
    // triangle can only ever be three stair steps. That is what "blocky" was,
    // through every attempt to fix it by changing the shape. `deep` is the same
    // pad-local coordinate carried at full precision.
    //
    // `solid` is a triangle, as a signed inside-ness: 1 at the middle of the
    // base, falling to 0 along the two sloping sides. A triangle is one
    // expression — a linear ramp back from the base, minus a linear ramp out
    // from the centre line.
    //
    // **A chevron is that triangle with the same triangle cut out of its
    // bottom, and because `solid` is linear it is just a slice of it.** Its
    // level sets are nested copies of the triangle, so `0 < solid < 0.77` is the
    // band between two of them: two arms of even thickness meeting at a point,
    // open at the base. No second shape to write and no second coordinate — the
    // cut-out is the same expression read at a different level.
    //
    // 0.77 is the width that makes the arm and the gap the same, which is what
    // gives the conveyor-belt read. The band's extent down the pad is the slice
    // width over 1.54 whatever the distance from the centre line, so 0.77 is
    // half a loop everywhere across the pad, not just along the middle — the
    // arms and the gaps stay matched right out to the edges.
    //
    // `smoothstep(0, 0.02)` is two centimetres of road on each edge, enough to
    // stop the sides stair-stepping and not enough to see.
    const wide = across - pick * 4;
    const deep = along - 30 - slot * 64;
    const solid = 1 - fract(deep * 0.333 - uTime * 1.5) * 1.54 - abs(wide - 2) * 0.5;
    // **Lit the way the rails are, because analytic glow is the only glow this
    // game has.** There is no post-process pass to draw a bright shape and blur
    // it back, so a glow has to be two reads of the same field: a core driven
    // past 1 so it clips towards white, and a skirt spread around it carrying
    // the colour. `max(0 - solid, solid - 0.77)` is distance *out* of the
    // chevron — negative inside it, and how far outside once you leave — so one
    // expression skirts both the outer sides and the cut-out at the base.
    //
    // A step in `solid` is about two units of road across and about two along,
    // so a skirt measured in it comes out very nearly round rather than smeared
    // one way. That is luck rather than design, but it is why this can be one
    // number instead of two.
    //
    // The chevron itself stays a hairline — the glow is *around* the shape, not
    // instead of its edge. Softening the edge to make it glow was an earlier
    // attempt and it produced an orange smear with a chevron somewhere inside.
    const band = smoothstep(0, 0.02, solid) - smoothstep(0.77, 0.79, solid);
    const bloom = 1 - smoothstep(0, 0.28, max(0 - solid, solid - 0.77));
    const fire = vec3(1.2, 0.3, 0.03)
      .add(vec3(1.5, 0.55, 0.04).scale(bloom * bloom))
      .add(vec3(1.9, 1.2, 0.25).scale(band * 1.5));

    // Flat, and over 1 for most panels, so the pastels clip towards white — the
    // only bloom this surface gets, since there is no post-process pass to give
    // it any. 1.32 against an average `lamp` of 0.87 lands the road at the same
    // exposure the old centre-lit panels averaged out to, so removing the
    // falloff changed the edges without changing the brightness — and the bevel
    // keeps it, being symmetric about 1 across a panel.
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
      mix(glass.scale(lamp * 1.32 * (1 - (du + dv) * 0.9 * rim)), fire, pad),
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
    return vec4(
      lit
        .add(glass.scale(halo * 0.8))
        .add(vec3(0.55, 0.95, 1).scale(lip * 0.9))
        .add(vec3(1, 0.97, 1).scale(core * 3.4)),
      1,
    );
  },
});
