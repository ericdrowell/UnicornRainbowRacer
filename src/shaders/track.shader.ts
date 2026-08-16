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
 * lit glass panels rather than as painted lanes.
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
 * field washing over it, which is why the time term left the vertex stage (where
 * it used to scroll the whole surface bodily) and became a drift in the colour
 * down in the fragment.
 *
 * **Colour is sampled per tile, from a field that varies over hundreds of
 * metres.** Every fragment of a panel gets the hue at that panel's index, so
 * each one is flat and the gradient appears as steps from panel to panel — which
 * is the look: illuminated tiles that happen to form a rainbow, not a rainbow
 * with a grid drawn over it. Because the field's wavelength is far longer than a
 * tile, a whole stretch of road leans lavender, the next leans pink, and no
 * single view carries the entire spectrum at once. Sampling a *continuous*
 * rainbow instead gave uniform noise: every colour present everywhere, which
 * reads as chaos rather than as light.
 *
 * **There is no post-process bloom, so the bloom is built into the shapes.** The
 * runtime has no render targets — there is nowhere to draw a bright pass and
 * blur it back — so glow is analytic. Panels are lit from the middle and fall
 * off into their seams rather than ending at them, the rail carries a wide skirt
 * inboard of its core, and the core itself is driven well past white so it
 * clips. What this cannot do is bleed *outward*, past the edge of the ribbon
 * into open space: there are no fragments out there to brighten. The silhouette
 * is a hard edge against the dark, and only a second pass would soften it.
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

  vertex({ aPos, aEdge }, { uState }, v) {
    v.vU = aEdge.x;
    v.vV = aEdge.y;
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

  fragment({ uTime }, { vU, vV }) {
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
    const inX = fract(across);
    const inY = fract(along);

    // The hue field. Two waves, both slow: one turns over about every 380 metres
    // of road, the other about every 1100 and leans across the width as it goes,
    // so the wash arrives diagonally rather than as bands lying square across
    // the track. Their sum swings wide enough to reach right round the wheel, so
    // no colour is missing from the road — only from any one stretch of it.
    //
    // Sampled at `row`/`col`, the panel's index, rather than at the fragment:
    // that is what makes a panel one flat colour.
    const wash = sin(row * 0.05) * 2.6 + sin(row * 0.017 + col * 0.5 + 1.3) * 1.6 + uTime * 0.35;
    // Pastel, not pigment. Glass lit from inside washes out towards white as it
    // brightens, and a saturated hue at full strength reads as paint instead.
    // Only a fifth of the way there, though: the panel's own falloff below takes
    // its middle to white on its own, so mixing much white in here as well left
    // the whole road frosted and took the rainbow out of it.
    const glass = mix(spectrum(wash), vec3(1, 1, 1), 0.2);

    // Panels are not identical: each gets a fixed brightness of its own, so the
    // surface reads as a field of separate lamps rather than one printed sheet.
    // The usual hashed sine — cheap, and the banding it is notorious for is
    // invisible once the result only has to look like manufacturing tolerance.
    const lamp = 0.74 + 0.26 * fract(sin(col * 12.99 + row * 78.23) * 43758.5);

    // How far into its panel a fragment is: 0 hard against a seam, 0.5 dead
    // centre. One number for all four sides, rather than a smoothstep per side
    // multiplied together, which is both fewer instructions and the reason two
    // separate profiles below are affordable at all.
    const depth = min(min(inX, 1 - inX), min(inY, 1 - inY));

    // The light inside the pane, spread over the whole width of it. This is the
    // one that makes the road read as illuminated rather than painted: a broad
    // dome that blows the middle of every panel past white and lets the hue
    // survive around the rim, which is what a lit thing behind glass looks like.
    // A near-flat plateau with a fast rolloff — the first attempt — lights the
    // panel evenly and lands straight back on flat coloured rectangles.
    const glowIn = smoothstep(0, 0.42, depth);
    // And the join itself: a hairline, dark but never black. A wide dark gap
    // draws a grid of grout over the road and turns lit glass into paving.
    const seam = smoothstep(0, 0.045, depth);

    // Circuitry under the glass: four faint lines each way inside every panel.
    // Dim on purpose — this is the detail that says "illuminated technology"
    // from a few metres away and should be gone by mid-distance, where it would
    // otherwise alias into moiré.
    const trace = max(
      smoothstep(0.46, 0.5, abs(fract(across * 4) - 0.5)),
      smoothstep(0.46, 0.5, abs(fract(along * 4) - 0.5)),
    );

    // Over 1 across the middle of a panel, and deliberately so. Everything that
    // reads as glow in a single pass is headroom being spent: the centres clip
    // towards white, the hue survives at the rim where the falloff brings it
    // back under 1, and the panel ends up bright core with coloured surround —
    // which is what a bloomed light looks like. Kept under it, the same panel is
    // a flat coloured rectangle no matter how the seams are drawn.
    //
    // The floor it sits on is low on purpose. The road wants to be dark glass
    // that happens to be full of light, not a uniformly bright surface: it is
    // the distance between an unlit rim and a clipped centre that sells the
    // material, and raising the floor to light the panels evenly — which the
    // first pass did — flattens exactly that.
    const lit = glass.scale(lamp * (0.16 + 1.25 * glowIn) * (0.32 + 0.68 * seam) + trace * 0.14);

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
