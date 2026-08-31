import {
  shader,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  abs,
  floor,
  fract,
  max,
  mix,
  sign,
  step,
  dot,
  cross,
  smoothstep,
  length,
  normalize,
  storageRead,
  type Vec3,
} from 'brometal';

/**
 * Rotation in the x-y plane. The pony faces +x, so a leg swinging forward and
 * back moves in x-y — which is a rotation about z, not the x you first reach for.
 */
function spin(p: Vec3, a: number): Vec3 {
  const c = cos(a);
  const s = sin(a);
  return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
}

/**
 * One random number per lattice point, from the oldest trick there is: take a
 * smooth function, run it somewhere far from the origin at a frequency nothing
 * else in the shader shares, and keep only the fractional part. It is not a good
 * hash — it bands on some drivers if the coordinates get large — but the
 * coordinates here are model-space and never leave single digits.
 */
function hash(x: number, y: number): number {
  return fract(sin(x * 127.1 + y * 311.7) * 43758.5453);
}

/**
 * Value noise: the lattice above, interpolated with a smoothstep so the result
 * is continuous rather than a grid of hard tiles.
 *
 * The smoothing is the point. Sampling the hash directly gives white noise,
 * which is not fur — it is television static, and worse, it aliases into a
 * crawling shimmer the moment the model moves or shrinks, because neighbouring
 * pixels land on unrelated lattice cells. Interpolated, the field has a scale,
 * and a scale is what lets it read as fibre.
 *
 * Written in components because the DSL's `fract` and `floor` are scalar-only.
 */
function noise(px: number, py: number): number {
  const ix = floor(px);
  const iy = floor(py);
  const fx = px - ix;
  const fy = py - iy;
  // Hermite weights — the same curve `smoothstep` applies, inlined because it
  // is wanted on the two axes separately rather than on an edge pair.
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return mix(
    mix(hash(ix, iy), hash(ix + 1, iy), ux),
    mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux),
    uy,
  );
}

/**
 * A running unicorn: one continuous mesh, animated by moving its vertices.
 *
 * The body is a single surface lofted along a spine from rump to muzzle, and
 * each leg is a tube lofted from its hip. Nothing is assembled from primitives
 * and nothing is instanced — there is one mesh and one draw call, and the legs
 * run because this shader moves their vertices.
 *
 * **Skinning weights come free with a procedural mesh.** Every vertex is emitted
 * knowing how far along its limb it sits, so `aSkin.x` is a by-product of
 * generating it rather than data anyone had to author. That single number is
 * what drives the bend.
 *
 * **The knee is a blend, not a hinge.** `smoothstep` ramps the bend in across a
 * short span rather than switching at a threshold, so vertices near the joint
 * rotate partially and the leg *curves*. A hard cutoff gives a crease, which is
 * the giveaway that a limb is two rigid pieces rather than one skinned surface —
 * and avoiding that is most of the reason to do it this way at all.
 *
 * Body vertices carry zero amplitudes and a zero root, so the same arithmetic
 * leaves them exactly where they were generated. There is no branch.
 */
export const Unicorn = shader({
  attributes: {
    /** Position, relative to `aRoot`. */
    aPos: 'vec3',
    aNrm: 'vec3',
    /** The joint this vertex swings about — the hip, or the origin for the body. */
    aRoot: 'vec3',
    /** Distance along the limb, gait phase, swing amplitude, knee amplitude. */
    aSkin: 'vec4',
    /**
     * Colour, plus a code in w for what to do with it: 0 keep it, 1 replace it
     * with the mane, 2 with this racer's hide, 3 with its horn.
     *
     * The last two used to be resolved on the CPU while the mesh was built, by
     * matching the converter's colours against the chosen unicorn's. That works
     * for one unicorn and cannot work for ten: the vertex buffer is shared by
     * every instance, so a colour baked into it is the same colour on all of
     * them. Baking the *question* instead — which part is this? — leaves the
     * answer to the instance.
     *
     * Code 3 was the wings, and is now the horn — a slot that came free the day
     * the wings went, and wanted filling the day a black unicorn needed a horn
     * that was not gold.
     */
    aColor: 'vec4',
  },
  /**
   * Per racer, not per vertex: which unicorn of the ten this instance is.
   *
   * One float, and one instance buffer, because that is all there is room for.
   * WebGPU guarantees eight vertex buffers and the mesh already spends five, so
   * the four colours that make one unicorn not another cannot come this way —
   * they live in the state buffer instead, which this stage already binds and
   * which costs no binding at all to read further into. See `PALETTE` below.
   *
   * It is a float because every value in this language is; the compiler narrows
   * it to u32 where it becomes an index.
   */
  instanceAttributes: {
    aRacer: 'float',
  },
  uniforms: {
    uTime: 'float',
    uRun: 'float',
    uMirror: 'float',
    /**
     * How big to draw the model. 1 on the track; larger on the select screen,
     * where the whole point is a close look at one unicorn.
     *
     * Applied to the posed offset rather than to the world position, so a
     * unicorn grows about its own hooves instead of being flung away from the
     * origin — and so the gait, the bob and the lean all scale with it and stay
     * in proportion.
     */
    uScale: 'float',
    /** 1 on the select screen, where the roster rides a carousel. */
    uSelect: 'float',
    /** How far round the ring has wound, in seats. Eased, so fractional. */
    uPick: 'float',
    /** How many unicorns are on the ring, for the wrap above. */
    uCount: 'float',
  },
  // Written by the physics stage, read-only here: where the body is, which way
  // it faces, which way the road says is up, and the camera it is seen through.
  storage: { uState: 'vec4' },
  varyings: {
    vNormal: 'vec3',
    vColor: 'vec3',
    vFace: 'vec3',
    vHair: 'float',
    vAlong: 'float',
    /**
     * This racer's eye colour, fetched in the vertex stage and carried down.
     *
     * The palette is read where every other livery colour is read — up there,
     * once per vertex — because `aRacer` is an instance attribute and the
     * fragment stage cannot see it. Handing the answer down costs an
     * interpolator; handing the *index* down and reading the palette per pixel
     * would cost a storage fetch on every fragment of every unicorn instead.
     */
    vEye: 'vec3',
  },

  vertex({ aPos, aNrm, aRoot, aSkin, aColor, aRacer }, { uState, uTime, uRun, uMirror, uScale, uSelect, uPick, uCount }, v) {
    // This racer's block. The layout mirrors the player's old fixed slots —
    // position, drawn facing with speed, surface normal with gait — so
    // everything below reads exactly as it did when there was only one.
    const mine = 16 + aRacer * 5;
    // This racer's colours, written once at start-up and never touched again:
    // hide with the mane's spectrum flag, the three stops the mane runs through,
    // the horn, and the eye.
    const pal = 80 + aRacer * 6;
    const aHide = storageRead(uState, pal).xyz;
    const aRainbow = storageRead(uState, pal).w;
    const aManeA = storageRead(uState, pal + 1).xyz;
    const aManeB = storageRead(uState, pal + 2).xyz;
    const aManeC = storageRead(uState, pal + 3).xyz;
    const aHorn = storageRead(uState, pal + 4).xyz;
    v.vEye = storageRead(uState, pal + 5).xyz;
    const onRoad = storageRead(uState, mine);
    const facingRoad = storageRead(uState, mine + 1);
    const normalRoad = storageRead(uState, mine + 2);

    // ── The carousel ───────────────────────────────────────────────────────
    // On the select screen the roster leaves the road and rides a ring hung in
    // the air in front of the camera, one seat per unicorn.
    //
    // **It lives here, in the renderer, and not in the physics stage.** There is
    // one position per racer and the simulation reads its bodies out of it, so a
    // seat written there is a body that has moved: the camera is built from
    // racer zero's position and the ring is placed relative to the camera, which
    // made the shot chase its own carousel a little further every frame — and
    // the four racers then started the race hanging in mid-air where the ring
    // had left them. Placing them here touches nothing the simulation reads.
    //
    // Sizes come from the ring rather than a scale per seat: the front one sits
    // five units from the eye and its neighbours fifteen, so perspective alone
    // makes the choice three times the size of the ones beside it.
    const camEye = storageRead(uState, 8).xyz;
    const gazeRaw = storageRead(uState, 9).xyz.sub(camEye);
    const gaze = gazeRaw.scale(1 / max(length(gazeRaw), 0.0001));
    const camUp = storageRead(uState, 10).xyz;
    const sideRaw = cross(gaze, camUp);
    const ringSide = sideRaw.scale(1 / max(length(sideRaw), 0.0001));
    // Up on *screen*, not up in the world: the shot looks down at the circuit,
    // so world up runs into the frame at an angle and lifting by it moves the
    // ring sideways as much as upward.
    const upRaw = camUp.sub(gaze.scale(dot(camUp, gaze)));
    const screenUp = upRaw.scale(1 / max(length(upRaw), 0.0001));
    // Far enough out that the camera is not standing inside the choice. At
    // scale 4 the model is about five units long, so a front seat five units
    // from the eye put the lens in its ribcage — and with back faces culled an
    // inside-out unicorn is not a big unicorn, it is no unicorn at all. Twenty
    // two out with a ten-unit ring leaves the front one twelve away and its
    // neighbours twenty four, which is the same two-to-one the ring is for.
    // Dropped below the eye line rather than lifted above it. The model's origin
    // is its hooves — everything is posed upward from there — so a seat on the
    // centre line puts the body entirely in the top half of the frame, which is
    // where the first attempt at this put the heads: out of shot. Half the
    // model's height down centres the unicorn instead of its feet.
    const hub = camEye.add(gaze.scale(20)).sub(screenUp.scale(1.6));

    // Where this unicorn sits relative to the chosen one, wrapped into the
    // half-open range either side of it. **The wrap is what makes the carousel
    // endless**: `uPick` counts turns of the wheel rather than an index into the
    // roster, so it climbs forever, and taking it modulo the count means the
    // unicorn that has just left one edge is already arriving at the other. Hold
    // the right arrow and it goes round and round.
    const rel = aRacer - uPick;
    const d = rel - uCount * floor(rel / uCount + 0.5);

    // A shallow arc rather than a full circle. Only three seats are ever meant
    // to be on screen — the choice and the one either side of it — so the ring
    // only has to bend far enough to push the neighbours back and away, not far
    // enough to bring a fourth round behind them.
    // A gentle arc. Steep enough to read as a ring in depth, shallow enough that
    // the neighbours stay well inside the frame — swing it wider and the size
    // difference grows, but they slide off the edges long before it is enough.
    const phi = d * 0.95;
    const seat = hub.add(ringSide.scale(sin(phi) * 7)).sub(gaze.scale(cos(phi) * 7));

    // How much this one *is* the choice: 1 at the front, 0 at a neighbour.
    const chosen = 1 - min(abs(d), 1);

    // Neighbours are shrunk on purpose as well as by distance. Perspective alone
    // cannot do this job: a ring deep enough to halve their size is also wide
    // enough to push them off the sides, so the depth sells the shape and this
    // sells the hierarchy.
    // Anything past a neighbour collapses to nothing. Scaling it away rather
    // than skipping the draw keeps the instance count fixed at the whole roster,
    // which is what lets one of them be mid-hand-over from one edge to the other
    // without the draw call changing under it.
    const near = 1 - smoothstep(1.15, 1.55, abs(d));
    // The neighbours are *not* dimmed. They were, briefly, and it was wrong: a
    // multiply over the whole model does not read as "further back", it reads as
    // a different unicorn — a lilac one goes grey and a cream one goes brown, so
    // the two liveries either side of the choice were being misreported at the
    // exact moment the player was trying to compare them. Size alone carries the
    // hierarchy, and size is the one cue that cannot lie about colour.
    // Facing out of the ring, so the one at the front looks at the camera and
    // the rest are caught turning away from it.
    const outRaw = seat.sub(hub);
    const outward = outRaw.scale(1 / max(length(outRaw), 0.0001));

    // Every seat turns on the spot, at one shared rate, so you can see what you
    // are choosing from every side.
    //
    // **The rate cannot be weighted by which one is chosen, and that is not a
    // stylistic call.** It was `uTime * 1.15 * chosen`, so that only the front
    // one spun — and multiplying a clock that grows without bound by a weight
    // that changes is a trap: when `chosen` swings from 0 to 1 thirty seconds in,
    // the angle swings thirty-four radians with it, in whatever fraction of a
    // second the ring takes to turn. The unicorns whipped round harder the longer
    // the screen had been open. Fixing it by integrating the rate would need
    // somewhere to keep the accumulated angle, and this stage has no state at
    // all; one rate for everybody needs none and cannot drift.
    //
    // A plain two-term rotation is enough because `outward` is square to
    // `screenUp` by construction: the ring lies in the plane of the gaze and the
    // sideways, and both of those are perpendicular to screen up. The third term
    // of a general axis-angle rotation would be multiplied by zero.
    const turn = uTime * 1.15;
    const turned = outward.scale(cos(turn)).add(cross(screenUp, outward).scale(sin(turn)));

    const body = vec4(mix(onRoad.xyz, seat, uSelect), onRoad.w);
    const facing = vec4(mix(facingRoad.xyz, turned, uSelect), facingRoad.w);
    // Legs at a steady canter. The gait is a distance, so this is the distance a
    // unicorn would have covered by now at a believable speed.
    const normal = vec4(mix(normalRoad.xyz, screenUp, uSelect), mix(normalRoad.w, uTime * 26, uSelect));
    // ── Which gait ─────────────────────────────────────────────────────────
    // Two of them, chosen by how fast the unicorn is actually going. `aSkin.y`
    // carries the walk's phase for this leg, generated with the mesh; the
    // gallop's is worked out here.
    //
    // Which leg this vertex belongs to comes from its own hip rather than from
    // another attribute: front hips sit forward of the origin, hind hips
    // behind, and the sign of z says which side. That is already in aRoot, and
    // a fifth attribute would be twelve more bytes on every vertex to say
    // something the model's own geometry has said all along.
    const front = step(0, aRoot.x);
    const side = sign(aRoot.z);

    // The walk is a trot: diagonal pairs, so each leg is half a cycle from the
    // one beside it. A gallop is the opposite — the front pair swings together
    // and the hind pair swings together, with the two pairs half a cycle apart,
    // which is what makes it read as bounding rather than marching.
    //
    // Not *quite* together, though. Perfectly matched legs read as one wide leg
    // rather than two, so each pair is nudged a fifth of a radian either side of
    // its beat. A real gallop has a lead leg for the same reason it looks right.
    const gallop = mix(3.14159, 0, front) + side * 0.2;

    // Blended rather than switched, and blended on the *phase*, so a change of
    // gait drifts into step over a stride or two instead of snapping there
    // mid-air.
    //
    // Forwards is always the gallop, at any speed above nothing. It used to be
    // `smoothstep(6, 15, abs(facing.w))` — the walk below fifteen units, the
    // gallop above — which meant the unicorn spent every corner and every start
    // marching, and a racer that is not galloping reads as a racer that is not
    // trying.
    //
    // Backwards is the walk, because nothing reverses at a gallop. The edges
    // straddle a standstill rather than testing the sign, so the changeover
    // spreads across the first few units of reverse instead of flipping in one
    // frame. That matters here and nowhere else: run scales each leg's phase
    // *offset*, so switching it outright moves four legs by up to half a cycle
    // between one frame and the next, and they teleport rather than fall into
    // step. Three units of reverse is a tenth of a second at the braking rate,
    // so it still reads as immediate.
    //
    // uRun on the front of it is the screen, not the driving: 1 on the track and
    // 0 on the select screen, where the unicorn walks on the spot whichever way
    // it is nominally facing.
    const run = uRun * smoothstep(-3, 0, facing.w);
    const gait = normal.w + mix(aSkin.y, gallop, run);

    // Weighted by distance along the limb, and that is what welds it: the ring
    // shared with the barrel has t = 0, so it never moves, while everything
    // below swings freely. Rotate the leg rigidly instead and the top ring tears
    // away from the body it is part of.
    //
    // A gallop reaches further than a walk, so the swing opens up with it. The
    // knee follows, less so — it is already folding as far as the joint allows.
    const hip = aSkin.z * (1 + 0.45 * run) * sin(gait) * smoothstep(0, 0.28, aSkin.x);
    // Knees only fold one way, so the bend is clamped to the half of the cycle
    // where the hoof is coming through — a knee bending backwards reads as a
    // broken leg immediately.
    const knee = aSkin.w * (1 + 0.25 * run) * max(sin(gait + 2.2), 0);
    const bend = knee * smoothstep(0.32, 0.56, aSkin.x);

    // Where the knee sits below the hip, in leg units. A local const because the
    // DSL scopes to shader parameters and locals — module-level values are not
    // in scope, which it says plainly rather than compiling to something wrong.
    const kneeY = 0.3;

    const atKnee = spin(vec3(aPos.x, aPos.y + kneeY, aPos.z), bend);
    const limb = spin(vec3(atKnee.x, atKnee.y - kneeY, atKnee.z), hip);
    // The barrel rises and falls, which sells a run more than the legs do. Tied
    // to the gait rather than the clock for the same reason the legs are — a
    // standing unicorn should not be breathing hard.
    //
    // Off `normal.w`, the body's own phase, and deliberately not off `gait`:
    // gait carries this leg's offset, so a bob built from it lifts each leg by a
    // different amount and prises them off the barrel they are joined to. The
    // bob has to be one number for the whole model.
    //
    // Twice a stride at a walk, because a trot's diagonal pairs land twice a
    // cycle. A gallop lands once and lands harder, so it heaves once, deeper.
    const bob = mix(sin(normal.w * 2) * 0.03, sin(normal.w) * 0.07, run);
    const local = limb.add(aRoot).add(vec3(0, bob, 0));

    // Onto the track. The model is built facing +x with +y up, so its own axes
    // map straight onto the road's: forward, the surface normal, and the third
    // one taken as their cross product rather than read from the buffer. That
    // keeps the basis right-handed with the model's, and a basis that quietly
    // flips handedness mirrors the mesh and turns every face inside out.
    const across = cross(facing.xyz, normal.xyz);
    // Size, and the collapse that hides everything past a neighbour.
    const grow = uScale * mix(1, near * mix(0.58, 1, chosen), uSelect);
    const world = body.xyz
      .add(facing.xyz.scale(local.x * grow))
      .add(normal.xyz.scale(local.y * grow))
      .add(across.scale(local.z * grow));

    // The normal rides the same basis. Skipping this leaves the lighting fixed
    // to the world while the unicorn turns under it, so the lit side stays put
    // as the body rotates — subtle enough to look like a lighting bug and not a
    // transform one.
    const posed = spin(spin(aNrm, bend), hip);
    v.vNormal = facing.xyz
      .scale(posed.x)
      .add(normal.xyz.scale(posed.y))
      .add(across.scale(posed.z));

    // Bands run diagonally across the mane and tail. The multiplier is high
    // because a mane spans barely half a unit: at a gentle rate the whole thing
    // lands inside one arc of the palette and comes out a single colour with a
    // slight gradient, which is not a rainbow.
    //
    // **Fixed, not flowing.** This used to carry a `- uTime * 2.4` term, which
    // sent the palette cycling through the hair. Dropping it makes the stripes a
    // property of the unicorn rather than an effect playing on it — the mane is
    // dyed, and dyed hair does not change colour while you watch. It also stops
    // the rainbow competing with the road, which is the thing in this scene that
    // is supposed to be moving.
    //
    // Measured on the *undeformed* model, not on `local`. `local` is the posed
    // position: it carries the gait and, more to the point, the bob — the whole
    // body rising and falling as it runs. Keying the palette off that cycles the
    // mane through the spectrum in time with the footfalls, which is the drift
    // this was supposed to have lost. It is the same trap the eye below is
    // written to avoid, and the same fix: read the rest coordinate.
    const band = ((aPos.x + aRoot.x) + (aPos.y + aRoot.y) * 2.2) * 7;
    const rainbow = vec3(
      0.5 + 0.5 * cos(band),
      0.5 + 0.5 * cos(band + 2.09),
      0.5 + 0.5 * cos(band + 4.19),
    );
    // The other unicorns run their mane through three colours along the same band
    // the spectrum uses, so the crest keeps its depth instead of going flat.
    //
    // Three and not two, because a two-stop gradient can only ever put the mix of
    // its ends in the middle — fine for pink to blue, which passes through
    // lavender on its own, and no use at all to a mane that wants blue, green and
    // red. A two-colour mane is still one line of authoring: game.js stores it as
    // three stops with the middle at the midpoint, which is the same straight
    // line, so there is nothing to branch on here.
    //
    // `t * 2 - half` and not `fract(t * 2)`: fract of exactly 2 is 0, so the very
    // tip of the band would snap back to the middle colour instead of reaching
    // the last one.
    const t = 0.5 + 0.5 * cos(band);
    const half = step(0.5, t);
    const dyed = mix(mix(aManeA, aManeB, half), mix(aManeB, aManeC, half), t * 2 - half);
    // The codes, as ranges rather than equality tests: these arrive as
    // interpolated floats and comparing one for equality against 2 is the kind
    // of thing that works on the machine it was written on.
    const hair = step(0.5, aColor.w) * (1 - step(1.5, aColor.w));
    const hide = step(1.5, aColor.w) * (1 - step(2.5, aColor.w));
    const horn = step(2.5, aColor.w);
    const worn = mix(mix(aColor.xyz, aHide, hide), aHorn, horn);
    v.vColor = mix(worn, mix(dyed, rainbow, aRainbow), hair);
    // The same flag the rainbow is keyed off, handed to the fragment stage so it
    // can shade hair as hair. It costs an interpolator and saves the alternative,
    // which is guessing from position where the mane stops and the neck starts.
    v.vHair = hair;
    // How far along the road this racer is, in the track shader's own units,
    // carried down to the fragment stage so the bounce light below can be the
    // colour of the panel *this* unicorn is standing on. It used to read the
    // player's slot directly, which with a field of ten would have lit every
    // one of them the colour of whatever the player was over.
    v.vAlong = storageRead(uState, mine + 3).w;
    // Where this vertex sits on the *undeformed* model, which is what the eye
    // below is drawn against. `aPos` is relative to its hip, so adding the root
    // recovers the original coordinate; this deliberately skips the gait and the
    // bob, or the pupil would slide about the face as the body rose and fell.
    //
    // The eye test below still reads only x and y: the two eyes sit at the same
    // place on the head and differ solely in the sign of z, so ignoring z draws
    // both from one test, and the only surfaces anywhere near this x and y are
    // the two cheeks.
    //
    // z rides along for the hair. A mane is a thin crest whose width runs in z,
    // so an x-y coordinate is constant across it — noise sampled on x and y alone
    // can only band *along* the mane, which is precisely the wrong way for
    // something meant to read as strands hanging down it.
    v.vFace = vec3(aPos.x + aRoot.x, aPos.y + aRoot.y, aPos.z + aRoot.z);

    // ── The reflection ────────────────────────────────────────────────────
    // A straight mirror through the road plane, and nothing else. Seen by the
    // same camera the mirrored model already lands exactly where its reflection
    // belongs on screen — that is what a planar reflection *is* — so no projection
    // and no depth trickery is wanted.
    //
    // This draw goes to an offscreen target, and that is what buys the simplicity.
    // Rendered straight into the frame it has to fight the road for depth and
    // loses, and blending it per-triangle stacks every overlapping face of the
    // model on top of itself. Given its own target it resolves opaquely against
    // its own depth and arrives as one flat image with a coverage mask — and the
    // road then decides how much of it to show, once, against a finished picture.
    const plane = body.xyz;
    const upT = normal.xyz;
    const shown = mix(world, world.sub(upT.scale(2 * dot(world.sub(plane), upT))), uMirror);

    const c0 = storageRead(uState, 4);
    const c1 = storageRead(uState, 5);
    const c2 = storageRead(uState, 6);
    const c3 = storageRead(uState, 7);
    return c0.scale(shown.x).add(c1.scale(shown.y)).add(c2.scale(shown.z)).add(c3);
  },

  fragment({ uState, uTime, uMirror, uSelect }, { vNormal, vColor, vFace, vHair, vAlong, vEye }) {
    // ── The pile ───────────────────────────────────────────────────────────
    // What makes a plush toy read as plush is not its colour, it is that the
    // surface never resolves: light lands on thousands of fibre tips at slightly
    // different angles, so the shading stays grainy at a scale far below the
    // silhouette. A smooth normal cannot produce that at any lighting setting,
    // which is why the wrapped key light below — already doing its best to fake
    // a soft material — still left the model looking moulded.
    //
    // The grain goes into the normal, not the colour. Tilting the normal makes
    // every light term break up at once, including the road's bounce and the rim
    // of the wrap, exactly as a real pile would. Painting the same pattern onto
    // the albedo instead gives dirt, because it stays put when the light moves.
    //
    // **Two octaves, because fur is not one scale.** The coarse one is clumping —
    // the way pile parts into tufts — and the fine one is the fibre tips inside a
    // clump. With only the fine octave the surface reads as sandpaper: uniform
    // grain is still uniform, which was the original complaint in a smaller size.
    //
    // Three samples at unrelated offsets, used as a tilt vector. This is not the
    // true gradient of the field — that would want finite differences along two
    // surface tangents, and there are no tangents on this mesh to take them
    // along. Three decorrelated values tilt the normal in an arbitrary direction
    // instead, which for a material whose fibres genuinely do point every which
    // way is not an approximation of the right answer so much as the right answer
    // arrived at cheaply.
    //
    // Sampled off `vFace`, the *undeformed* model coordinate the eye is drawn
    // against, and for the same reason: in world space the fur would boil as the
    // unicorn drove, and after skinning it would crawl along the legs as they
    // swung. Locked to the undeformed surface, the pile belongs to the toy.
    const fx = vFace.x;
    const fy = vFace.y;
    const clump = vec3(
      noise(fx * 30, fy * 9),
      noise(fx * 30 + 37.2, fy * 9 + 17.9),
      noise(fx * 30 + 91.7, fy * 9 + 63.4),
    ).sub(vec3(0.5, 0.5, 0.5));
    const fibre = vec3(
      noise(fx * 110, fy * 30),
      noise(fx * 110 + 51.3, fy * 30 + 22.6),
      noise(fx * 110 + 13.8, fy * 30 + 77.1),
    ).sub(vec3(0.5, 0.5, 0.5));
    const fuzz = clump.scale(0.30).add(fibre.scale(0.45));

    // ── The mane and tail ──────────────────────────────────────────────────
    // Hair is not fur with a different colour. Fur is a field of short fibres
    // pointing outward, which is why the pile above is nearly isotropic; hair
    // hangs in long strands that clump and part, and the thing that makes it
    // read is that the highlights run *along* the strand while the variation
    // runs across it. So the noise here is stretched far harder than the pile's
    // — roughly seven to one — and the long axis points down, the way hair falls.
    //
    // The frequency across the strand is set by how big the mane actually is on
    // screen, not by what looks right in isolation: it spans about half a model
    // unit and lands in roughly thirty pixels, so strands about two pixels apart
    // means a cell size near 1/60th of a unit. Finer than that and neighbouring
    // pixels sample unrelated cells, which is not finer hair — it is a crawling
    // shimmer that gets worse the further away the unicorn is.
    const across = vFace.z * 60;
    const along = (fx + fy * 2.2) * 7;
    const s1 = noise(across, along);
    const strand = vec3(s1, noise(across + 19.4, along + 55.2), noise(across + 82.1, along + 31.7))
      .sub(vec3(0.5, 0.5, 0.5));

    // Hair also *self-shadows* in a way pile does not: strands sit over one
    // another, and the gaps between clumps go genuinely dark rather than merely
    // turning away from the light. Tilting the normal alone cannot produce that,
    // because a tilted normal still catches the ambient bounce. This multiplies
    // it out, and it is most of why the mane reads as separate locks instead of
    // a painted ribbon.
    const locks = mix(1, 0.55 + 0.9 * s1, vHair);

    // Renormalised, unlike the faceted version: skinning rotates each vertex by
    // its own amount, so along a bending leg the normals genuinely differ across
    // a face and the interpolated value is no longer unit length. The tilt rides
    // in before the normalise, so it perturbs a direction rather than a length.
    const n = normalize(vNormal.add(mix(fuzz, strand.scale(0.85), vHair)));

    // Lit from below, by the road. There is no sky any more — the scene clears
    // to almost black — so the ambient that used to pour blue daylight over
    // everything would now be light arriving from an empty space, and it showed:
    // a bright unicorn on a dark ribbon, plainly pasted on.
    //
    // The colour is the panel it is standing on, not an average or a guess. The
    // physics stage leaves the distance along the road in the state buffer, and
    // running it through the same lattice and the same hue field as the track
    // shader arrives at the same answer, so the bounce genuinely changes as the
    // unicorn crosses from a lavender stretch into a pink one. Column six of
    // twelve — the middle of the road — folded into the constant as 6 * 0.5 +
    // 1.3, because the whole model gets one colour; it is far too small to
    // straddle a gradient worth resolving.
    //
    // These constants are the track shader's, repeated, and they have to match:
    // each shader compiles to its own WGSL and the DSL has no imports inside a
    // stage, so there is nowhere to put the one copy. Retuning the road's
    // lattice without retuning this is a silent wrong answer, not an error —
    // it happened once already, and the only symptom was a unicorn lit the
    // colour of a panel some way up the track.
    // The time term goes *inside* both waves, exactly as it does over there: the
    // light flows along the road rather than the palette shifting under it, and a
    // bounce that shifted while the road flowed would drift out of agreement
    // within a second or two of standing still.
    const flow = floor(vAlong * 0.4456) + uTime * 12;
    const wash = sin(flow * 0.05) * 2.6 + sin(flow * 0.017 + 4.3) * 1.6;
    // Over halfway to white, which is much further than the road's own panels go.
    // Bounced light is weak light: at the road's saturation the model came out
    // painted the colour of the panel under it — a green unicorn — rather than a
    // white one catching green off the floor, and it lost its own markings with
    // it. Washed out this far, the tint is unmistakable and the unicorn is still
    // the unicorn.
    //
    // Taken all the way to white on the select screen. The road there is
    // scenery, not a light: the unicorns are hanging in the air well clear of it
    // and the player is trying to compare four liveries, so a floor that tints
    // them turns "which colour do I want" into "which colour is it under this
    // bit of track". They are still shaded — the falloff and the key light below
    // both stay, or a unicorn is a flat cut-out — but nothing about the road
    // reaches them.
    const glow = mix(
      vec3(0.5 + 0.5 * cos(wash), 0.5 + 0.5 * cos(wash + 2.09), 0.5 + 0.5 * cos(wash + 4.19)),
      vec3(1, 1, 1),
      mix(0.55, 1, uSelect),
    );

    // Strongest on the underside and falling off over the top, which is what an
    // enormous glowing floor does. Not zero up there: the rails throw light
    // across the whole model, and a completely unlit topline reads as a hole.
    const bounce = glow.scale(1.05 - 0.5 * n.y);
    // What is left of the key light, kept dim and pointed down the road so the
    // form still reads. Warm, so it separates from the road's pastels rather
    // than dissolving into them.
    //
    // **Wrapped, not clamped.** `max(dot, 0)` puts the terminator exactly where
    // the surface turns ninety degrees from the light, and that hard edge is
    // what a billiard ball looks like. Remapping the dot product through
    // `(d + w) / (1 + w)` lets the light bend a little way past the horizon, so
    // it dies out gradually — which is what happens on anything fuzzy, because
    // the fibres standing off the surface catch light the surface itself cannot.
    // It is the cheapest thing that reads as fabric rather than plastic, and it
    // costs an add and a divide that fold into constants.
    const wrap = max((dot(n, normalize(vec3(0.55, 0.7, 0.85))) + 0.65) / 1.65, 0);
    // Squared, because a soft material's falloff is not linear either: wrapping
    // alone flattens the form into something evenly lit, and this puts the
    // gradient back without putting the hard edge back with it.
    const key = vec3(1, 0.97, 0.9).scale(wrap * wrap * 0.5);
    // ── The eyes ───────────────────────────────────────────────────────────
    // A circle, painted on the face in model space, 0.0675 across — half the
    // width of the flat patch the model ships with, which is the size this eye
    // has always been.
    //
    // Two cleverer versions came before it and both were worse. Ray-tracing a
    // sphere *embedded* in the head makes the outline the curve where sphere
    // meets skull, which follows the facets and is never round. Drawing the
    // sphere's silhouette instead is round, but needs a near-side test to stop
    // the far eye printing through the back of the head, and that test cuts the
    // circle into a slash the moment the head turns. A decal has neither problem:
    // it is round because it is defined round, and it is on the cheek because
    // the cheek is the only thing at these coordinates.
    //
    // It projects to an ellipse when the head is seen at an angle, which is what
    // a circle drawn on a curved surface does, and is what makes it read as an
    // eye rather than as a sticker facing the camera.
    const pupil = 1 - smoothstep(0.062, 0.0675, length(vFace.xy.sub(vec2(0.6401, 1.4904))));
    // Alpha 1 either way. In the reflection pass this is coverage rather than
    // opacity — the target clears transparent, so solid alpha is what tells the
    // road which pixels the unicorn actually reaches.
    return vec4(mix(vColor.mul(bounce.add(key)).scale(locks), vEye, pupil), 1);
  },
});
