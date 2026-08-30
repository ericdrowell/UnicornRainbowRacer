import {
  shader,
  vec2,
  vec3,
  vec4,
  cos,
  abs,
  min,
  max,
  length,
  smoothstep,
  storageRead,
  type Vec3,
} from 'brometal';

/** The road's palette, repeated here — a shader cannot import across stages. */
function spectrum(k: number): Vec3 {
  return vec3(0.5 + 0.5 * cos(k), 0.5 + 0.5 * cos(k + 2.09), 0.5 + 0.5 * cos(k + 4.19));
}

/**
 * The course map: the whole circuit drawn flat in the corner, with the unicorn
 * on it as a star.
 *
 * **A quad in the corner, not a fullscreen pass.** The line is found by asking
 * every pixel how far it is from the nearest point of the centreline, which is a
 * loop over a couple of hundred rings — affordable across the twenty thousand
 * pixels of a corner box, ruinous across a million. Sizing the geometry to the
 * box is what keeps the loop off the rest of the screen; an early return in the
 * fragment would not, because the neighbouring lanes still pay for it.
 *
 * Distance to the ring *points* rather than to the segments between them. The
 * rings sit two units apart on a course hundreds of units across, so in map
 * space they overlap several times over and the point field is already
 * continuous — segment distance would cost a projection and a clamp each to draw
 * exactly the same line.
 */
export const Minimap = shader({
  attributes: { aCorner: 'vec2' },
  /**
   * uMapX/uMapZ/uMapR frame the course: its centre in world coordinates and the
   * half-width that fits it. Computed once on the CPU, which already has the
   * centreline in hand, rather than by scanning the buffer here every frame.
   */
  uniforms: {
    uAspect: 'float',
    uMapX: 'float',
    uMapZ: 'float',
    uMapR: 'float',
    uRings: 'float',
  },
  storage: { uState: 'vec4', uTrack: 'vec4' },
  varyings: { vMap: 'vec2' },

  vertex({ aCorner }, { uAspect }, v) {
    // Square on screen, so the x half-size is divided by the aspect: in NDC the
    // horizontal axis is the stretched one, and a box built from equal halves
    // comes out as a rectangle that changes shape with the window.
    const halfY = 0.17;
    const halfX = halfY / uAspect;
    v.vMap = aCorner;
    return vec4(1 - halfX - 0.03 + aCorner.x * halfX, 0 - 1 + halfY + 0.03 + aCorner.y * halfY, 0, 1);
  },

  fragment({ uMapX, uMapZ, uMapR, uRings, uState, uTrack }, { vMap }) {
    // Map space to world. y is negated because the map is a view from above with
    // north up, and screen y climbs while world z runs away from the camera.
    const here = vec2(uMapX + vMap.x * uMapR, uMapZ - vMap.y * uMapR);

    // Nearest point on the course, and how far along the course it is. The
    // distance draws the line; the along-value colours it, so the gradient runs
    // with the circuit rather than across the box.
    // Every sixth ring, three vec4s apart.
    //
    // The stride is what keeps this affordable. It is a search over the whole
    // circuit run *per pixel*, and the circuit went from 190 rings to sixteen
    // hundred — at one ring each that is a couple of thousand distance tests for
    // every pixel of the map, every frame, to draw a line four pixels wide.
    // Twelve metres between samples is far finer than the line is thick, so
    // sixth-ing it costs nothing anyone can see and gives back five sixths of
    // the work.
    let near = 1000000;
    let alongAt = 0;
    for (let i = 0; i < uRings; i += 6) {
      const c = storageRead(uTrack, i * 3);
      const d = length(vec2(c.x, c.z).sub(here));
      if (d < near) {
        near = d;
        alongAt = c.w;
      }
    }

    // Width in world units, so the ribbon holds its thickness on screen whatever
    // the course measures.
    const wide = uMapR * 0.045;
    // Just the ribbon. The smoothstep across its own edge is the only softening
    // wanted — a wider glow around it was reading as a drop shadow, because a dim
    // colour at low alpha over a bright road darkens rather than glows.
    const line = 1 - smoothstep(wide * 0.55, wide, near);

    // The unicorn, as the same four-point star the sky uses. Drawn from the body
    // position in the state buffer, put through the same mapping as the course so
    // it cannot drift off the line it is supposed to be standing on.
    const body = storageRead(uState, 0);
    const star = vec2(body.x, body.z).sub(here);
    const rx = abs(star.x);
    const rz = abs(star.y);
    const reach = uMapR * 0.085;
    const thin = uMapR * 0.013;
    const core = 1 - smoothstep(0, reach * 0.42, length(star));
    const spikes = max(
      (1 - smoothstep(0, reach, rx)) * (1 - smoothstep(0, thin, rz)),
      (1 - smoothstep(0, thin, rx)) * (1 - smoothstep(0, reach, rz)),
    );

    // ── The rest of the field ──────────────────────────────────────────────
    // Nine plain dots, no star: the star is how the player finds itself at a
    // glance, and giving everyone one would take that away. Small, dim and the
    // same for all of them — this is for reading gaps, not for telling Pinkie
    // Fly from Hot Fluff at four millimetres across.
    //
    // Racer zero is skipped by starting at one; it is the player, and it is
    // already drawn above as the star.
    let pack = 0;
    for (let j = 1; j < 10; j += 1) {
      const them = storageRead(uState, 16 + j * 5);
      pack = max(pack, 1 - smoothstep(0, uMapR * 0.03, length(vec2(them.x, them.z).sub(here))));
    }

    // One turn of the wheel over one lap, so the map is a single sweep of the
    // spectrum rather than a barber's pole.
    //
    // This was `alongAt * 0.06`, a fixed rate — fine on the 380-unit test track,
    // where it came to about three and a half turns, and nonsense on a circuit
    // eight times longer, where it wound round thirty times and the map became a
    // repeating stripe with no sense of direction in it.
    //
    // The lap length comes out of the ring buffer rather than a uniform. game.js
    // emits ring zero a second time at the end carrying the full lap distance
    // instead of nought — it does that so the last segment interpolates forwards
    // — and that spare word is exactly the number wanted here.
    const lap = storageRead(uTrack, uRings * 3).w;
    const ink = spectrum((alongAt / lap) * 6.2832);
    const paint = ink.scale(line)
      .add(vec3(0.75, 0.82, 1).scale(pack * 1.1))
      .add(vec3(1, 0.99, 0.95).scale(core * 2.2 + spikes * 1.3));
    // Alpha comes from the ribbon and the star and nothing else, so the map is a
    // line and a star floating on the scene — no pane behind it, no glow around
    // it, and glass everywhere neither of them reaches.
    return vec4(paint, min(line + core + spikes * 0.8 + pack, 1));
  },
});
