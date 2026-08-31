import { shader, vec2, vec3, vec4, mix, sin, step, texture } from 'brometal';

/**
 * The title card: one quad, one texture, one draw.
 *
 * **The text is baked on the CPU rather than rasterised here.** game.js paints
 * the strings into a small canvas from the 3x5 table in font.js and hands over
 * an image; this stage only samples it. The alternative — carrying the glyph
 * table into a storage buffer and picking bits out of it per fragment — is a
 * real technique and the right one for a lap counter that changes every frame,
 * but this text never changes, and rendering it once at start-up costs a canvas
 * and about ten lines instead of a shader that can do bit arithmetic.
 *
 * Sampled with a nearest filter, so a 3x5 letter blown up forty times stays a
 * 3x5 letter. Linear sampling would smear each pixel into its neighbours and
 * turn a deliberately blocky font into a blurry one.
 */
export const Text = shader({
  attributes: {
    /** A unit quad in 0..1, placed by the uniforms below. */
    aCorner: 'vec2',
  },
  /**
   * One caption per instance: which row of the atlas, where it sits, how wide it
   * is, and how far faded.
   *
   * **Per instance and not per draw, because a uniform cannot change between two
   * draws in the same pass.** `bmUniforms` is a queue write, and queue writes are
   * ordered against submission rather than interleaved with commands — so two
   * draws with a uniform write between them both see the *second* write. The
   * first attempt at this drew every line of a screen with the last line's
   * position, which looked like only one of them existing.
   *
   * A negative row means the flat card instead of a line of text: it is the one
   * bit of per-instance state that is not a number, and spending a whole
   * component on it to avoid a sign test would cost more than it explains.
   */
  instanceAttributes: {
    /** Atlas row, centre y in NDC, half-width in NDC, fade. */
    aCell: 'vec4',
  },
  uniforms: {
    uTime: 'float',
    /** Viewport aspect, so letters keep their shape whatever the window does. */
    uAspect: 'float',
    /** How many rows the atlas holds, and how tall one row is against its width. */
    uRows: 'float',
    uRatio: 'float',
    uGlyphs: 'sampler2D',
  },
  varyings: { vUv: 'vec2', vFade: 'float', vSolid: 'float' },

  vertex({ aCorner, aCell }, { uAspect, uRows, uRatio }, v) {
    const solid = 1 - step(0, aCell.x);
    v.vSolid = solid;
    v.vFade = aCell.w;
    // One line out of the atlas. Every string is baked into its own row of a
    // single texture, so a screenful of text is a handful of instances over one
    // image rather than a texture per caption.
    v.vUv = vec2(aCorner.x, (aCell.x + 1 - aCorner.y) / uRows);
    // Height follows from width and the row's own proportions, so the letters
    // never stretch. The card ignores all of that and covers the screen.
    const half = mix(aCell.z, 1, solid);
    const tall = mix(aCell.z * uRatio * uAspect, 1, solid);
    // No vertical fudge: a glyph is five pixels in a seven-pixel cell with a
    // spare above and below, so its ink already sits at the middle of the quad.
    // At the old pitch of six the spare was all below, the ink rode a twelfth
    // high, and this line had to push every caption back down.
    return vec4((aCorner.x * 2 - 1) * half, aCell.y + (aCorner.y * 2 - 1) * tall, 0, 1);
  },

  fragment({ uTime, uGlyphs }, { vUv, vFade, vSolid }) {
    // One sample, two answers. Alpha is coverage — the plate and the letter
    // together — and red is which: 1 on the letterform, 0 on the black
    // rectangle behind it. Both are baked into the atlas by game.js, so the
    // plate costs this stage nothing but the swizzle.
    //
    // It used to be a second sample of the same texture a texel up and left,
    // which drew a drop shadow instead of a plate. That reads well over flat
    // colour and badly over a rainbow: half the letter still lands on whatever
    // the road is doing. A box under the whole glyph does not care.
    const px = texture(uGlyphs, vUv);
    const ink = px.x;
    const plate = px.w;

    // The road's own palette, running across the text rather than along it, so
    // the words read as cut out of the rainbow the game is made of. Slow — text
    // that strobes is text nobody reads.
    const wash = vUv.x * 4.5 - uTime * 0.8;
    const rainbow = vec3(
      0.55 + 0.45 * sin(wash),
      0.55 + 0.45 * sin(wash + 2.09),
      0.55 + 0.45 * sin(wash + 4.19),
    );

    // Driven past white so the letters bloom, the way everything else in this
    // scene does. There is no post-process pass to do it afterwards — see the
    // road and the clouds — so brightness is the effect.
    //
    // The card is the title screen's ground: a flat pink, opaque, covering the
    // world entirely. Same program because it is the same quad with the same
    // blend state, and a second pipeline to draw one rectangle is one wasted.
    const paint = mix(
      mix(rainbow, vec3(1, 1, 1), 0.35).scale(1.7),
      vec3(0.95, 0.36, 0.62),
      vSolid,
    );
    // The letter out of the rainbow, the plate black behind it at half alpha —
    // enough to hold a letterform against a white road without stamping a solid
    // block over the scene.
    //
    // Half of the *plate*, not of the pair: where the letter covers a pixel the
    // alpha is still 1, so the glyph itself stays fully opaque.
    //
    // The card takes neither: it is a flat fill with no ink and no box.
    return vec4(
      mix(vec3(0, 0, 0), paint, max(ink, vSolid)),
      mix(max(ink, plate * 0.5), 1, vSolid) * vFade,
    );
  },
});
