// The circuits, and nothing else. A data file the way src/mesh.js is a data
// file — except that it holds no data: it holds a seed and the machine that
// turns one into a road.
//
// **A track is a number now.** The circuit this replaced was 142 hand-placed
// control points, delta-encoded, and it cost 252 zipped bytes. This costs about
// 110, and every *further* track costs two — a seed — where another authored one
// would have cost another 250. That is the whole argument: the saving on the
// first track is small, and the saving on the second and third is the feature.
//
// **Deterministic, and that is the point.** The same seed builds the same road
// down to the last decimal on every machine and every run: an integer LCG and
// arithmetic on doubles, with nothing read from the clock or the platform. A
// player learns a track and it stays learned.
//
// **Seeds are chosen here, not discovered by a player.** That is what makes a
// generator safe to ship. Generate a hundred, drive them, keep the ones that are
// worth racing; a bad one never reaches anybody. Everything below is written so
// that a *bad* seed is a boring track rather than a broken one — see the two
// guarantees in `circuit`.

/**
 * A deterministic stream of numbers in 0..1 from one integer.
 *
 * The oldest LCG there is. It is not a good generator — the low bits are
 * famously poor — and for shaping a race track it does not need to be one: the
 * numbers only pick radii and phases, and any of them look like a track.
 */
const seeded = (n) => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/**
 * A closed circuit from a seed: a list of places the road passes through, in
 * order, with the last joining back to the first.
 *
 * Absolute coordinates, not the steps the authored file used to hold. That
 * encoding existed to shrink a literal — small numbers with a narrow spread
 * model better than three-digit ones — and there is no literal any more, so the
 * running sum that decoded it is gone from game.js as well.
 *
 * ── Two guarantees ──────────────────────────────────────────────────────────
 *
 * **The ground path cannot cross itself.** It is drawn in polar form: an angle
 * that only ever increases, and a radius that stays positive. A shape like that
 * is star-shaped about the origin and has no way to intersect itself, whatever
 * the seed says. This matters more than it looks: the physics finds the surface
 * under a unicorn by nearest ring, so two pieces of road sharing the same air is
 * not a graphical glitch, it is a car falling through the world.
 *
 * **And the road is level where the grid stands.** The elevation is faded out
 * across the first and last few points, because ten unicorns are placed on a
 * grid stretching back from the start line and a slope there means the race
 * opens with the whole field sliding backwards.
 */
const circuit = (seed) => {
  const rnd = seeded(seed);
  // Six harmonics for the radius and six for the height, each with its own
  // phase. Higher harmonics get proportionally smaller amplitudes, which is what
  // keeps the result a race track rather than a sawblade: the first term is the
  // long sweep of the circuit, and the sixth is a kink inside one corner.
  const shape = [];
  for (let k = 0; k < 12; k++) shape.push(rnd());

  // ── Where the loops go ──────────────────────────────────────────────────
  // Between two and five, spread around the lap and never within a few points
  // of the start line. Chosen before the path is walked so the walk can simply
  // ask "is there a loop here".
  const RUNGS = 96;
  const loops = {};
  const count = 2 + Math.floor(rnd() * 4);
  for (let k = 0; k < count; k++) {
    // Spaced by construction rather than by rejection: each loop lands in its
    // own equal slice of the lap, so two can never end up on top of each other
    // however the seed falls.
    const slot = 6 + Math.floor(((k + rnd()) * (RUNGS - 14)) / count);
    // How big the loop is, and how wide the corkscrew opens as it goes over.
    //
    // **The width has a floor, and it is a safety floor rather than a taste
    // one.** It is what holds the climbing branch off the descending one; at 18
    // the two came within 25 metres on a road 27 wide, and at 34 they clear by
    // 40 — wider than the authored circuit this replaced managed. The ceiling is
    // taste: past about 50 the loop opens out into a lazy spiral and stops
    // reading as a loop at all, and by 60 the road never goes inverted.
    loops[slot] = [34 + rnd() * 26, 34 + rnd() * 14];
  }

  const ground = (i) => {
    const a = ((i % RUNGS) / RUNGS) * Math.PI * 2;
    let rad = 430;
    let y = 0;
    for (let k = 0; k < 6; k++) {
      rad += Math.sin(a * (k + 1) + shape[k] * 6.28318) * (86 / (k + 1));
      y += Math.sin(a * (k + 1) + shape[k + 6] * 6.28318) * (30 / (k + 1));
    }
    // The start line, flattened. `flat` is 0 for the first and last five points
    // and 1 in the middle, eased so the road does not kink where it lands.
    const e = Math.min((i % RUNGS) / 5, (RUNGS - (i % RUNGS)) / 5, 1);
    return [Math.cos(a) * rad, y * e * e * (3 - 2 * e), Math.sin(a) * rad];
  };

  const points = [];
  // ── Walking the lap ─────────────────────────────────────────────────────
  // One ground point at a time, except where a loop stands up: a loop swallows
  // SPAN of them, because its entry and its exit have to end up far enough apart
  // that the two are unambiguously different pieces of road.
  //
  // **That distance is the whole safety argument, and it was got wrong first.**
  // The first version put the loop between one pair of ground points, about 28
  // metres. Measured, the climbing branch and the descending branch came within
  // 9 metres of each other near the bottom — on a road 27 wide, which is two
  // surfaces sharing the same air. The physics finds the ground under a unicorn
  // by nearest ring and would have picked whichever branch happened to be
  // closer. Over three ground points the same measurement is comfortably wider
  // than the road, which is where the authored circuit this replaced sat.
  const SPAN = 3;
  for (let i = 0; i < RUNGS; ) {
    const here = ground(i);
    points.push(here);
    const loop = loops[i];
    if (!loop) {
      i += 1;
      continue;
    }

    // ── Standing one loop up ────────────────────────────────────────────────
    // A vertical circle in the plane of travel, walked from the road and back to
    // it, replacing the run to the point SPAN ahead.
    //
    //     forward = R sin θ + A θ/2π      up = R (1 - cos θ)
    //
    // At θ = π the forward term is back to zero while the height is 2R: the road
    // has doubled back over itself, which is the only way to be inverted. A path
    // whose forward motion never reverses never gets there, however steeply it
    // climbs — it is a hill, not a loop. The `A θ/2π` term is the drift along
    // the track that carries the exit out to the far side.
    //
    // **The sideways term opens it into a corkscrew.** `W sin θ` pushes the
    // climbing and descending branches apart — at any height they are `2W sin θ`
    // apart — and returns to zero at both ends, so the loop rejoins the ground
    // path exactly rather than leaving a lateral kink for the rest of the lap to
    // absorb. A wider `W` is a lazier, more open loop.
    const [R, W] = loop;
    const next = ground(i + SPAN);
    const away = [next[0] - here[0], next[1] - here[1], next[2] - here[2]];
    const A = Math.hypot(away[0], away[1], away[2]);
    const t = away.map((c) => c / A);
    // Sideways is the tangent turned a quarter turn about world up. The loop
    // stands in the vertical plane containing the direction of travel, so world
    // up is the right up to use — the road is level here by construction
    // everywhere except mid-slope, where the tilt is a few degrees.
    const s = [-t[2], 0, t[0]];
    const sl = Math.hypot(s[0], s[2]) || 1;
    // Sixteen points around, because a spline needs them where the curvature is:
    // this is the tightest thing on the course by a long way, and thinning them
    // flattens the loop into a bump.
    for (let k = 1; k < 16; k++) {
      const th = (k / 16) * Math.PI * 2;
      const f = R * Math.sin(th) + (A * th) / (Math.PI * 2);
      const u = R * (1 - Math.cos(th));
      const w = (W * Math.sin(th)) / sl;
      points.push([
        here[0] + t[0] * f + s[0] * w,
        here[1] + t[1] * f + u,
        here[2] + t[2] * f + s[2] * w,
      ]);
    }
    i += SPAN;
  }
  return points;
};

/** The circuits this game ships, one seed each. */
const CIRCUITS = [circuit(20260830)];
