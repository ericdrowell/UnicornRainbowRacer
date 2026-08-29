import {
  shader,
  vec2,
  vec3,
  vec4,
  floor,
  fract,
  sin,
  mod,
  min,
  mix,
  exp,
  pow,
  clamp,
  smoothstep,
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
 * else — `sampler3D` exists in the DSL but there is no `bmTexture3D` to fill
 * one. Reading it costs two fetches and a lerp — the two slices either side of
 * z, blended — where computing the noise arithmetically costs eight hashes and a
 * pile of interpolation. That difference is the whole reason this shader runs:
 * an earlier march that evaluated its noise instead of reading it ran the game
 * at a tenth of a frame per second.
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
 * The lump scale: two octaves, near 52 and 25 world units at `DOMAIN`.
 *
 * Both of them are things the march can actually see, which is why the top one
 * can carry real weight now. The march steps 14, so by Nyquist it resolves down
 * to 28 units — and the second octave, at 25, sits just inside that. It did not
 * used to. At the old domain the same octave landed at 8 units and the one above
 * it at 4, far below the sampling rate, and neither was detail: they were a
 * fresh random number at every sample, which the dithered ray starts scattered
 * across pixels as grain. Coarsening the domain is what turned the top octave
 * from noise into the roughness that makes a lump look like a lump.
 */
function fbm(tex: Sampler2D, p: Vec3): number {
  return volume(tex, p) * 0.7 + volume(tex, p.scale(2.1)) * 0.3;
}

/**
 * The weather scale: one octave near 150 units, pushed towards its extremes.
 *
 * This is the term that stops the sky reading as one even blanket, and it has to
 * be *separate* from the fBM rather than another octave inside it. Octaves get
 * averaged: a third one an octave below the rest still lands close to the mean
 * over the span of a whole view, which modulates every bank by about the same
 * amount and leaves the deck as uniform as it started. What varies a sky is
 * regional — this stretch overcast, that one broken — and that means a term with
 * a wavelength longer than the view and a distribution that avoids its own
 * middle.
 *
 * The smoothstep is what does the second part. Value noise piles up around 0.5,
 * so used raw it is mostly "average weather everywhere"; remapped across a
 * narrow band it spends its time near 0 or near 1, and the transitions between
 * them get short. Under it, `shape` swings the cloud top through about a hundred
 * units, so one part of the sky towers and the next opens out — and because its
 * wavelength is three times the lump scale, a bank and the gap beside it belong
 * to the same weather rather than alternating every few clouds.
 */
function coverage(tex: Sampler2D, p: Vec3): number {
  return smoothstep(0.36, 0.64, volume(tex, p.scale(0.34)));
}

/**
 * The shaping the two densities share: a capped half-space, the weather, and a
 * hard ceiling.
 *
 * **The half-space makes the sea and the sky out of one term.** It is positive
 * below its reference height and negative above, so as a ray descends the
 * density climbs until it saturates — a solid floor of cloud with a soft top —
 * while higher up the same term subtracts, thinning the fBM into scattered banks
 * and finally into clear air.
 *
 * **The cap on it is what lets the weather win.** Uncapped, it keeps growing the
 * further down the ray goes, and a few hundred units below the deck it is large
 * enough that no amount of clear weather can subtract its way back to zero — so
 * the underside is solid everywhere and a hole is only ever a dent in the top.
 * Clamped at 0.8 the floor stops deepening, and `coverage` can carry a whole
 * column to nothing.
 *
 * **The ceiling keeps the weather under the road.** The half-space alone does
 * not: it is a soft threshold, and the fBM's tallest peaks satisfy it well above
 * the track, whose ribbon spans y = 0 to 23. Those peaks are the ones that used
 * to swallow the road. Multiplying by a smoothstep that reaches zero at y = −4
 * is a guarantee rather than a tuning: nothing can be drawn above that line
 * however the noise falls, so the road always has clear air around it.
 */
function shape(n: number, cov: number, y: number): number {
  const deck = min((0 - 34 - y) * 0.02, 0.8);
  return (
    clamp(n * 4.2 - 1.9 + (cov - 0.5) * 2.4 + deck, 0, 1) * (1 - smoothstep(0 - 26, 0 - 4, y))
  );
}

/** How much cloud is at a point, in 0..1. The march's own, at full detail. */
function density(tex: Sampler2D, p: Vec3, t: number): number {
  // The domain the noise is sampled in, and how fast the weather crosses it.
  const DOMAIN = 0.0024;
  const WIND = 3.5;
  const q = p.add(vec3(0 - t * WIND, 0, 0)).scale(DOMAIN);
  return shape(fbm(tex, q), coverage(tex, q), p.y);
}

/**
 * The same field, cheap, for the light march.
 *
 * One octave and no weather term: a shadow does not need detail it is only going
 * to integrate away, and this gets summed over four light steps inside every one
 * of sixty-four march samples, so what it costs is multiplied by both. Holding
 * `cov` at its mean makes shadows in a heavily overcast stretch slightly lighter
 * than they should be — the one place this approximation shows, and it shows
 * where the cloud is already at full density and reading as white anyway.
 */
function densityLo(tex: Sampler2D, p: Vec3, t: number): number {
  const DOMAIN = 0.0024;
  const WIND = 3.5;
  return shape(volume(tex, p.add(vec3(0 - t * WIND, 0, 0)).scale(DOMAIN)), 0.5, p.y);
}

/**
 * Henyey-Greenstein, without the 1/4π — that is a constant, and it folds into
 * the moon's intensity where it costs nothing.
 */
function hg(g: number, mu: number): number {
  const gg = g * g;
  return (1 - gg) / pow(1 + gg - 2 * g * mu, 1.5);
}

/**
 * The dual-lobe phase function: how much of the light scattering at a point goes
 * the way the eye is looking.
 *
 * A single lobe scatters forward and cannot do the other half of what clouds do.
 * Mixing a forward lobe with a backward one, weighted 0.8 to the forward, gives
 * both at once: a bank between the eye and the moon rims up to about 2.2, the
 * shaded side away from it still returns 0.86 rather than going flat, and the
 * sideways case sits at 0.8. That spread — a factor of two and a half across the
 * sky, out of geometry alone — is most of what makes a cloud look lit rather
 * than painted, and it replaces this shader's entire old lighting model, which
 * was one density difference that could and did go negative.
 */
function phase(mu: number): number {
  return mix(hg(-0.3, mu), hg(0.3, mu), 0.8) * 0.77;
}

/**
 * How much moonlight reaches a point inside the cloud.
 *
 * Four samples along the way to the moon, summed into an optical depth and put
 * through Beer's law. This is the piece the old shader did not have. It shaded
 * the whole sky from a single density difference one stride toward the light —
 * `d - density(p + light * 26)` — which is a forward difference, not a shadow:
 * it knows whether the cloud is thinning that way but nothing about what stands
 * between here and the moon, so a bank could not cast onto the one behind it,
 * and the value went negative wherever the cloud thickened toward the light,
 * subtracting colour from the accumulator.
 *
 * `exp(-depth)` cannot go negative, saturates instead of running away, and
 * darkens a sample by what is actually shadowing it. One octave and four steps,
 * because this gets integrated over sixty-four march samples and detail in it is
 * detail nobody sees.
 */
function sunlight(tex: Sampler2D, p: Vec3, moon: Vec3, t: number): number {
  const SUN_STEPS = 4;
  const SUN_STRIDE = 26;
  const SIGMA = 0.028;
  let depth = 0;
  for (let i = 0; i < SUN_STEPS; i++) {
    // Midpoint sampling: offset by half a step so the first sample sits inside
    // the first interval rather than on top of the point being shaded.
    depth = depth + densityLo(tex, p.add(moon.scale((i + 0.5) * SUN_STRIDE)), t);
  }
  return exp(0 - depth * SUN_STRIDE * SIGMA);
}

/**
 * Volumetric clouds, after Leonardo Awen Freitas' "Volumetric Clouds (game
 * ready)". The scattering integral, the Beer's-law light march and the dual-lobe
 * phase function are that shader's, adapted to a sky with no bounding box and to
 * a runtime with no 3D textures, no blue-noise texture and no `gl_FragCoord`.
 *
 * **The change that matters is that this integrates radiance instead of
 * compositing tiles of colour.** The old march did
 * `alpha += d * 0.85 * (1 - alpha)` — a per-step alpha blend with no step length
 * anywhere in it. One sample of dense cloud took alpha from 0 to 0.85, so a
 * pixel's entire appearance was decided by *which fourteen-unit shell its ray
 * happened to land in*, and dithering the ray starts turned that quantisation
 * into per-pixel noise. The grain was never a noise problem. It was the
 * accumulator.
 *
 * Here a step contributes `density * stride * sigma`, an optical depth
 * proportional to how far the ray actually travelled, and transmittance decays
 * as `exp(-that)`. Two things follow, and both are the point:
 *
 * - **No single sample dominates.** At full density a step is 0.39 of optical
 *   depth, so it takes about thirteen of them to reach opaque and each one
 *   carries a thirteenth of the answer. Moving a ray half a step changes almost
 *   nothing, which is what smooth means here.
 * - **Step count and appearance are independent.** Halve the stride and each
 *   step's optical depth halves while the number of steps doubles; the integral
 *   comes out the same. The old formulation had no such property — its constant
 *   had to be retuned by hand every time the step count moved, which is exactly
 *   the trap it kept falling into.
 *
 * Colour accumulates front to back and premultiplied, which is what the sky
 * expects: it composites with `sky * (1 - a) + rgb`.
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
    const moon = vec3(0.8873, 0.2307, -0.3993);

    // Sixty-four steps of fourteen units, and the extinction per unit of density
    // per unit of distance. These two are no longer coupled to the look — see
    // the note above — so the step count is now purely a quality dial.
    const STEPS = 64;
    const STRIDE = 14;
    const SIGMA = 0.028;

    // Moonlight, and the light the sky throws back into the undersides. The
    // ambient term is deliberately blue and deliberately not small: it is the
    // only thing lighting a shadowed base, and without it the underside of the
    // deck goes to black and the sea of cloud turns into a cutout.
    const beam = vec3(1.02, 1, 0.94);
    const ambient = vec3(0.09, 0.12, 0.24);
    // Extinction, tinted. Red is absorbed hardest and blue least, so the further
    // light travels inside a bank the bluer what survives becomes — depth in a
    // cloud reads as colour rather than only as darkness.
    const ext = vec3(1.06, 1, 0.88);

    // Dithered ray starts, because a fixed offset lays rings across the sky
    // wherever the step is coarser than the cloud it is sampling. This matters
    // far less than it used to — the integral is what removed the banding, and
    // this only cleans up the remainder — but it is nearly free.
    //
    // The `sin` is load-bearing. `fract` of a *linear* function of x and y — what
    // this once was — is a sawtooth plane, not a hash: it ramps and wraps along
    // the direction (431.7, 289.3), so every pixel in a band started its march at
    // the same offset and the sawtooth's own wrap lines were ruled across the sky
    // as dark diagonals. Folding it through a sine decorrelates neighbours.
    const jitter = fract(sin(vNdc.x * 431.7 + vNdc.y * 289.3) * 43758.5) * STRIDE;

    // The phase is fixed for the whole ray: it depends on the angle between the
    // view and the moon, and that does not change along a straight line. One
    // evaluation, not sixty-four.
    const ph = phase(dot(dir, moon));

    let scattered = vec3(0, 0, 0);
    let trans = vec3(1, 1, 1);
    for (let i = 0; i < STEPS; i++) {
      // Stop once the ray is effectively blocked. Green, as the middle channel —
      // with tinted extinction the three no longer agree, and the one in the
      // middle keeps the cut-off honest for all of them.
      if (trans.y > 0.02) {
        const p = eye.add(dir.scale(jitter + i * STRIDE));
        const d = density(uNoise, p, uTime);
        if (d > 0.01) {
          // Optical depth of this step: how much cloud, over how far. Everything
          // else here is a function of this one number.
          const tau = d * STRIDE * SIGMA;
          // What this parcel of cloud sends toward the eye — moonlight that got
          // here, aimed by the phase function, plus the ambient it picks up from
          // the sky — weighted by tau and by whatever is still transparent in
          // front of it, which is the front-to-back `over` written out.
          const lit = beam.scale(sunlight(uNoise, p, moon, uTime) * ph).add(ambient);
          scattered = scattered.add(trans.mul(lit).scale(tau));
          // Beer-Lambert, per channel. Three exps rather than one because the
          // DSL's `exp` is scalar, and a vec3 transmittance is what gives deep
          // cloud its colour.
          trans = trans.mul(vec3(exp(0 - tau * ext.x), exp(0 - tau * ext.y), exp(0 - tau * ext.z)));
        }
      }
    }

    // Premultiplied, so the sky's `sky * (1 - a) + rgb` is a straight `over`.
    return vec4(scattered, 1 - trans.y);
  },
});
