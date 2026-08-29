import {
  shader,
  vec2,
  vec3,
  vec4,
  floor,
  fract,
  sin,
  mod,
  max,
  min,
  mix,
  clamp,
  dot,
  normalize,
  texture,
  storageRead,
  type Vec3,
  type Sampler2D,
} from 'brometal';

/**
 * One sample of the noise volume.
 *
 * **The volume is a 64³ texture folded into a 512×512 sheet**, eight slices
 * across by eight down, because the js13k runtime has 2D textures and nothing
 * else. Reading it costs two fetches and a lerp — the two slices either side of
 * z, blended — where a real `sampler3D` would cost one, and where computing the
 * noise arithmetically costs eight hashes and a pile of interpolation. That last
 * difference is the whole reason this shader runs: an earlier march that
 * evaluated its noise instead of reading it ran the game at a tenth of a frame
 * per second.
 *
 * The `xy` inset by half a texel is not optional. Slices are neighbours in the
 * sheet but strangers in the volume, and a linear filter at a slice's edge
 * happily blends in the one packed beside it — which shows up as a grid of seams
 * ruled across the sky.
 */
function volume(tex: Sampler2D, p: Vec3): number {
  const q = vec3(fract(p.x), fract(p.y), fract(p.z));
  const z = q.z * 64;
  const zi = floor(z);
  const uv = q.xy.scale(0.984375).add(vec2(0.0078125, 0.0078125));
  const s0 = vec2(mod(zi, 8), floor(zi / 8)).add(uv).scale(0.125);
  const n1 = mod(zi + 1, 64);
  const s1 = vec2(mod(n1, 8), floor(n1 / 8)).add(uv).scale(0.125);
  return mix(texture(tex, s0).x, texture(tex, s1).x, z - zi);
}

/**
 * One octave, which is all a fourteen-unit — now seven-unit — step can resolve.
 *
 * This was three, and the top two were not detail. The volume repeats every
 * `1/0.0075` = 133 world units, so its lattice cell is about 17 units across and
 * the octaves sat at feature sizes of roughly 17, 8 and 4. A march sampling
 * every 14 units resolves nothing finer than 28, so 42% of the fBM's weight was
 * below its own sampling rate: not structure, just a fresh random number at
 * every sample. Dithered starts then spread that across pixels as grain, and the
 * quarter-size cloud target magnified each of those pixels into a 4×4 block.
 *
 * Adding a fourth octave "showed nothing", as the old note here said. It was the
 * same effect one step further along — and the reason the third showed nothing
 * either.
 *
 * Dropping to one is also what pays for the finer stride below: two texture
 * fetches per density sample instead of six, so twice the steps still costs a
 * third less than three octaves at sixty-four did.
 */
function fbm(tex: Sampler2D, p: Vec3): number {
  return volume(tex, p) * 0.97;
}

/**
 * How much cloud is at a point.
 *
 * **One expression gives both the sea and the sky.** The half-space term is
 * positive below its height and negative above, so as a ray descends the density
 * climbs until it saturates — a solid floor of cloud with a soft top — while
 * higher up the same term subtracts, thinning the fBM into scattered banks and
 * finally into clear air. There is no separate deck, no slab to intersect, and
 * no boundary anywhere for a cloud to be cut off against.
 *
 * Straight from the aviation demo's `GetSceneDensity`, which is
 * `fbm(p) + GetPlaneDens(p, up, h) * k` clamped to 0..1, with the constants
 * moved into this world's scale: its floor sat at y = -18 in a scene a few tens
 * of units across, ours at -14 under a track that spans 0 to 23.
 */
function density(tex: Sampler2D, p: Vec3, t: number): number {
  const q = p.add(vec3(0 - t * 3.5, 0, 0)).scale(0.0075);
  return clamp(fbm(tex, q) * 1.9 - 0.72 + (0 - 30 - p.y) * 0.011, 0, 1);
}

/**
 * Volumetric clouds, after the raymarcher in Anderson Mancini's "Glide Through
 * Clouds".
 *
 * Its shape is that this is a *cheap* march and unashamed of it: sixty-four
 * fixed steps, no adaptive stepping, and lighting from a single extra density
 * sample one stride toward the moon. The difference between the density here and
 * the density a little closer to the light is how much thinner the cloud is that
 * way, and that one number — no light march, no Beer's law, no phase function —
 * is what shades the whole sky. A more principled version of this is what I
 * built twice before, and it was slower and looked worse.
 *
 * Marched front to back, accumulating premultiplied colour and stopping once the
 * ray is effectively opaque.
 */
export const Cloud = shader({
  attributes: { aCorner: 'vec2' },
  uniforms: { uTime: 'float', uNoise: 'sampler2D' },
  storage: { uState: 'vec4' },
  varyings: { vNdc: 'vec2' },

  vertex({ aCorner }, {}, v) {
    v.vNdc = aCorner;
    return vec4(aCorner.x, aCorner.y, 0.5, 1);
  },

  fragment({ uState, uTime, uNoise }, { vNdc }) {
    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const right = vec3(c0.x, c1.x, c2.x);
    const up = vec3(c0.y, c1.y, c2.y);
    const dir = normalize(
      right
        .scale(vNdc.x / dot(right, right))
        .add(up.scale(vNdc.y / dot(up, up)))
        .add(vec3(c0.w, c1.w, c2.w)),
    );
    const eye = storageRead(uState, 8).xyz;
    const light = vec3(0.8873, 0.2307, -0.3993);

    // A hundred and twenty-eight steps of seven units, over the same nine hundred
    // as sixty-four of fourteen. Dithered starts, because a fixed offset lays
    // concentric rings across the sky wherever the step is coarser than the
    // cloud it is sampling.
    //
    // Halving the stride does two things the dither cannot. It doubles what the
    // march can resolve, which is what lets the noise keep its remaining
    // structure instead of aliasing it; and it halves the opacity any one sample
    // can contribute, so a pixel's colour is settled by two or three samples
    // rather than by which single fourteen-unit shell it happened to land in.
    // That second part is most of the smoothness: dither turns step banding into
    // per-pixel noise, but only more samples average that noise away.
    //
    // The `sin` is load-bearing. `fract` of a *linear* function of x and y —
    // which is what this was — is a sawtooth plane, not a hash: it ramps 0..1
    // and wraps, over and over, along the direction (431.7, 289.3). Every pixel
    // in one of those bands started its march at the same offset and sampled the
    // density field in lockstep, so the bands stopped cancelling each other out
    // and the sawtooth's own wrap lines were ruled across the sky as dark
    // diagonals. Folding the ramp through a sine decorrelates neighbours — 0.6
    // radians of argument per pixel, multiplied up past 43758 — which is what
    // makes this a dither rather than a pattern.
    const jitter = fract(sin(vNdc.x * 431.7 + vNdc.y * 289.3) * 43758.5) * 7;

    let acc = vec3(0, 0, 0);
    let alpha = 0;
    for (let i = 0; i < 128; i++) {
      if (alpha < 0.98) {
        const p = eye.add(dir.scale(jitter + i * 7));
        const d = density(uNoise, p, uTime);
        if (d > 0.001) {
          // Denser is darker and bluer: the deep parts of a cloud are where the
          // light did not reach. Premultiplied, so the accumulation below is a
          // straight `over`.
          const body = mix(vec3(0.86, 0.88, 0.96), vec3(0.22, 0.26, 0.42), min(d * 2.4, 1)).scale(d);
          // The whole lighting model: how much thinner the cloud is one stride
          // toward the moon. Positive on a surface facing it, negative in the
          // shade behind a bank, and it costs one more density sample.
          const lift = d - density(uNoise, p.add(light.scale(26)), uTime) / 0.95;
          const litColour = body.add(vec3(0.55, 0.56, 0.62).scale(lift * 1.9));
          acc = acc.add(litColour.scale(1 - alpha));
          // Half the stride, half the opacity per step, so a ray crossing a
          // given depth of cloud ends up as opaque as it was before. This is the
          // number that has to move with the step count or the whole sky changes
          // density.
          alpha = alpha + d * 0.425 * (1 - alpha);
        }
      }
    }

    return vec4(acc, alpha);
  },
});
