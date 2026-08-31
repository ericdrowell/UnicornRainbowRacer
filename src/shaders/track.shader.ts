import {
  shader,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  dot,
  floor,
  fract,
  length,
  max,
  mix,
  mod,
  normalize,
  pow,
  smoothstep,
  storageRead,
  targetUv,
  texture,
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
 * **The tiles are flat, and nothing is drawn inside them or between them.** Two
 * things used to be: a sub-grid of four faint traces each way, and a
 * centre-to-seam falloff meant to read as a pane of glass. At twelve panels
 * across, seen at speed, the falloff read as black gridlines instead and the
 * traces aliased into moiré by mid-distance. Both are gone. What separates one
 * panel from the next is now only its own fixed brightness and the step in hue,
 * so neighbours that agree on both merge and the lattice quietly breaks up.
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
  uniforms: { uTime: 'float', uMirrorTex: 'sampler2D' },
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

  fragment({ uTime, uState, uMirrorTex }, { vU, vV, vWorld, vClip }) {
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

    // Flat, and over 1 for most panels, so the pastels clip towards white — the
    // only bloom this surface gets, since there is no post-process pass to give
    // it any. 1.32 against an average `lamp` of 0.87 lands the road at the same
    // exposure the old centre-lit panels averaged out to, so removing the
    // falloff changed the edges without changing the brightness.
    const lit = glass.scale(lamp * 1.32);

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
    // ── Who is standing on this piece of road ─────────────────────────────
    // There was a contact shadow here — a blob under each animal, the way kart
    // games have always done it. It is gone because the road already says where
    // a unicorn is: the ribbon glows, and every racer lays a reflection on it
    // that moves with them and is brighter and easier to read than a dark
    // smudge was.
    //
    // The loop survives the shadow, because the reflection needs exactly what it
    // was computing — which racers are near this fragment, and on which side.
    // Distance is measured in the caster's own road plane, so a shadow on a
    // banked or climbing stretch stays a disc lying on the surface instead of the
    // ellipse a world-space distance would smear it into.
    // Where the camera is, wanted twice below: once to decide which face of the
    // road this fragment is, and again for the fresnel further down.
    const eye = storageRead(uState, 8).xyz;
    // How much of a unicorn's reflection this piece of road is entitled to show.
    // Gathered in the same loop as the shadow because it wants the same two
    // numbers, and a second pass over ten racers to ask a nearly identical
    // question would be the expensive way to write this.
    let owns = 0;
    for (let j = 0; j < 10; j += 1) {
      const body = storageRead(uState, 16 + j * 5).xyz;
      const up = storageRead(uState, 16 + j * 5 + 2).xyz;
      const flat = vWorld.sub(body);
      const onPlane = flat.sub(up.scale(dot(flat, up)));
      // **How far this road is from the caster perpendicularly, which the line
      // above deliberately throws away.** Projecting into the caster's plane is
      // what keeps a shadow a disc on a banked surface, but it also means a
      // unicorn a hundred units overhead — on the far side of a loop, or on the
      // track above this one — sits at zero in-plane distance and casts a
      // full-strength blob straight through the road below it.
      //
      // A body is about two units tall, so anything more than a few units off
      // this surface is not standing on it. Airborne over a crest still darkens
      // the road, which is right: that is the one time a shadow is doing real
      // work, telling you how far up you are.
      const lift = 1 - smoothstep(1, 7, abs(dot(flat, up)));
      // **And which face of the road you are looking at.** Everything the road
      // paints on itself — the blob, the reflection — belongs to the surface the
      // unicorn is standing on, and a surface has two sides. Without this the
      // underside of the road carries them too, so a loop overhead shows you the
      // field walking about on the far side of it as though the road were glass.
      //
      // The caster's own up vector answers it, and it is already read: the camera
      // and the unicorn are on the same side when the camera is above the plane
      // the unicorn stands on. No surface normal per fragment is needed, which is
      // as well, because this stage has no attribute carrying one.
      const side = step(0, dot(eye.sub(body), up));
      // The strongest caster wins rather than the sum of them. Two unicorns
      // running abreast overlap their blobs in the gap between them, and adding
      // there lays a dark seam across the road exactly where the surface is in
      // plain view between two bodies at the same height above it.
      // Wider than the shadow, because a reflection is as tall as the thing
      // casting it and stretches away down the surface, where the shadow is a
      // disc under its feet.
      owns = max(owns, (1 - smoothstep(3, 11, length(onPlane))) * lift * side);
    }
    // ── The reflection ────────────────────────────────────────────────────
    // Sampled at this fragment's own place on screen, which is where the mirrored
    // unicorn was drawn, so the road picks up whatever of it lands here. No depth
    // test is involved: the reflection cannot be clipped by the road it is lying
    // on, which is what used to cut it in half wherever the surface rose.
    //
    // `w` is the coverage the reflection pass wrote. Multiplying by it keeps the
    // road untouched everywhere the unicorn does not reach.
    //
    // **And `owns` is what keeps it on the right piece of road.** Having no depth
    // test is what makes the lookup simple and is also its one hole: the target
    // is in screen space, so *any* road drawn at a pixel picks up whatever
    // reflection landed there — including the underside of a loop, or a stretch
    // of track hundreds of units away that happens to sit behind the field. From
    // below it reads as seeing the unicorns straight through the road. Asking
    // whether a caster is actually near this fragment costs one more term off a
    // loop that is already running.
    const mirrorUv = targetUv(vec4(vClip.x / vClip.w, vClip.y / vClip.w, 0, 1));
    const mirrorPx = texture(uMirrorTex, mirrorUv).mul(vec4(1, 1, 1, owns));
    // Fresnel: a glancing look at glass is nearly a mirror, straight down at it is
    // nearly clear. Without it the reflection is as strong underfoot as out at the
    // horizon, which reads as a decal rather than as a surface.
    const gaze = normalize(vWorld.sub(eye));
    const gloss = 0.25 + 0.45 * pow(1 - abs(dot(gaze, storageRead(uState, 2).xyz)), 3);

    const edge = abs(vU);
    const core = smoothstep(0.9, 1, edge);
    const lip = smoothstep(0.78, 0.97, edge);
    const halo = pow(smoothstep(0.3, 1, edge), 2);
    return vec4(
      mix(lit, mirrorPx.xyz, mirrorPx.w * gloss)
        .add(glass.scale(halo * 0.8))
        .add(vec3(0.55, 0.95, 1).scale(lip * 0.9))
        .add(vec3(1, 0.97, 1).scale(core * 3.4)),
      1,
    );
  },
});
