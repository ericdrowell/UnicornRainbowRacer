import { shader, vec2, vec3, vec4, mix, min, max, step, texture, floor, fract, clamp } from 'brometal';

/** Browser-rendered glyph atlas: red is ink, alpha includes the rounded outline. */
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
    /** How many rows the atlas holds, and how tall one row is against its width. */
    uRows: 'float',
    uRatio: 'float',
    /** Horizontal/vertical padding, numeral pixel width in NDC, suffix scale. */
    uHud: 'vec4',
    uGlyphs: 'sampler2D',
  },
  varyings: { vUv: 'vec3' },

  vertex({ aCorner, aCell }, { uRows, uRatio, uHud }, v) {
    let fade = min(aCell.w, 1);
    // One line out of the atlas. Every string is baked into its own row of a
    // single texture, so a screenful of text is a handful of instances over one
    // image rather than a texture per caption.

    // Height follows from width and the row's own proportions, so the letters
    // keep their shape in the fixed 16:9 picture. The card covers the screen.
    const half = aCell.z;
    const tall = aCell.z * uRatio * (16 / 9);
    let x = (aCorner.x * 2 - 1) * half;
    // Values above one carry the title's opposing horizontal entrance offsets.
    x += max(0, aCell.w - 1) * (step(1, aCell.x) * 2 - 1);
    let y = aCell.y + (aCorner.y * 2 - 1) * tall;
    let texX = aCorner.x;
    if (aCell.w < 0) {
      if (aCell.w < -2) {
        // Gauge (-3) and label (-4): adjacent rows share the same edge.
        x = uHud.x - 1 + aCorner.x * 2 * half;
        y = uHud.y - 1 + (aCorner.y + (0 - aCell.w - 3) * 0.72) * 2 * tall;
      } else {
        const suffix = 0 - aCell.w - 1;
        // Ordinal half-widths are relative sizes. At the numeral's bottom,
        // suffix's right edge, shared top, and shared side, the local terms
        // become exactly 0 or 1 before applying the scale. Thus shared edges
        // have identical f32 coordinates instead of independent rounding.
        x = 1 - uHud.x + ((aCorner.x + suffix - 1) * aCell.z * 12 - uHud.w * 12 + (1 - suffix) * 2 + aCell.y) * uHud.z;
        y = uHud.y - 1 + (0.75 + (aCorner.y - 0.75) * aCell.z) * 12 * uHud.z * (16 / 9);
        texX = aCorner.x * uRatio + mix(0.5 + 38 * uRatio / 12, 1 - uRatio, suffix);
      }
      fade = 1;
    }
    v.vUv = vec3(texX, (aCell.x + 0.998 - aCorner.y * 0.996) / uRows, fade);
    return vec4(x, y, 0, 1);
  },

  fragment({ uGlyphs, uRows }, { vUv }) {
    // The card is atlas row -1, whose sampled y is negative throughout its
    // interior. Derive its flag here instead of interpolating another varying.
    // Two atlas columns permit 18x supersampling within the 8192 texture limit.
    const uv = vec2((vUv.x + floor(vUv.y)) / 2, fract(vUv.y));
    const px = texture(uGlyphs, uv);
    return vec4(px.xyz, px.w * vUv.z);
  },
});
