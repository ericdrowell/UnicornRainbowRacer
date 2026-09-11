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
    /** Atlas row, centre y, half-width, fade. HUD markers: -1 numeral, -2 suffix, -3 gauge, -4 label. */
    aCell: 'vec4',
  },
  uniforms: {
    uTime: 'float',
    /** How many rows the atlas holds, and how tall one row is against its width. */
    uRows: 'float',
    uRatio: 'float',
    /** Horizontal/vertical padding, numeral pixel width in NDC, suffix scale. */
    uHud: 'vec4',
    uGlyphs: 'sampler2D',
  },
  varyings: { vUv: 'vec2', vFade: 'float' },

  vertex({ aCorner, aCell }, { uRows, uRatio, uHud }, v) {
    const solid = 1 - step(0, aCell.x);
    v.vFade = aCell.w;
    // One line out of the atlas. Every string is baked into its own row of a
    // single texture, so a screenful of text is a handful of instances over one
    // image rather than a texture per caption.

    // Height follows from width and the row's own proportions, so the letters
    // keep their shape in the fixed 16:9 picture. The card covers the screen.
    const half = mix(aCell.z, 1, solid);
    const tall = mix(aCell.z * uRatio * (16 / 9), 1, solid);
    let x = (aCorner.x * 2 - 1) * half;
    let y = aCell.y + (aCorner.y * 2 - 1) * tall;
    let texX = aCorner.x;
    if (aCell.w < 0) {
      if (aCell.w < -2) {
        // Gauge (-3) and label (-4): adjacent rows share the same edge.
        x = uHud.x - 1 + aCorner.x * 2 * half;
        y = uHud.y - 1 + (aCorner.y - aCell.w - 3) * 2 * tall;
      } else {
        const suffix = 0 - aCell.w - 1;
        // Ordinal half-widths are relative sizes. At the numeral's bottom,
        // suffix's right edge, shared top, and shared side, the local terms
        // become exactly 0 or 1 before applying the scale. Thus shared edges
        // have identical f32 coordinates instead of independent rounding.
        x = 1 - uHud.x + ((aCorner.x + suffix - 1) * aCell.z - uHud.w) * 9 * uHud.z;
        y = uHud.y - 1 + (1 + (aCorner.y - 1) * aCell.z) * 7 * uHud.z * (16 / 9);
        texX = mix(
          0.5 + (39 + aCorner.x * 9) * uRatio / 7,
          1 - (10 - aCorner.x * 9) * uRatio / 7,
          suffix,
        );
      }
      v.vFade = 1;
    }
    v.vUv = vec2(texX, (aCell.x + 1 - aCorner.y) / uRows);
    return vec4(x, y, 0, 1);
  },

  fragment({ uTime, uGlyphs }, { vUv, vFade }) {
    // The card is atlas row -1, whose sampled y is negative throughout its
    // interior. Derive its flag here instead of interpolating another varying.
    const vSolid = 1 - step(0, vUv.y);
    // Red holds the letters; alpha also covers their thin outline.
    const px = texture(uGlyphs, vUv);
    const ink = px.x;
    const outline = px.w;

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
    // A translucent dark outline separates rainbow ink from bright scenery.
    return vec4(
      mix(vec3(0, 0, 0), paint, max(ink, vSolid)),
      mix(max(ink, outline * 0.65), 1, vSolid) * vFade,
    );
  },
});
