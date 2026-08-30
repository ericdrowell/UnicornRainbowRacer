// The circuits, and nothing else. A data file, the way src/mesh.js is a data
// file: the build concatenates it ahead of game.js, which picks one and turns it
// into a road.

/**
 * The circuits: each one a list of places the road passes through, in order,
 * with the last joining back to the first.
 *
 * Flat — x, y, z, x, y, z — rather than a list of triples. Three numbers is a
 * point and the reader below knows it, which is worth doing here and almost
 * nowhere else: this is by a distance the largest literal in the game, and the
 * brackets and commas around each triple cost more than the coordinates inside
 * them.
 *
 * **And they are steps, not places.** Each triple is how far the road moves from
 * the previous point, starting from the origin, so the first triple is the first
 * point and every one after it is a difference. Absolute coordinates run to
 * three digits and wander over a 900-unit course; the steps between them are all
 * within thirty of zero, which is one or two digits and a much narrower set of
 * values for the packer to model. Worth 203 bytes, and the reconstruction is
 * exact — these are integers, so the running sum cannot drift.
 *
 * The cost is that you can no longer read a position off this list, and moving
 * one point shifts every point after it. Editing is easier done by decoding to
 * absolutes, moving what you want, and re-encoding.
 *
 * A Catmull-Rom spline through them is what makes this a usable authoring
 * format — the curve *hits* every point rather than being pulled vaguely
 * towards it, so a point dropped at a corner apex is where the road actually
 * goes, and a point moved ten units moves the road ten units.
 *
 * **The loop is in here too, as points.** It is the run of tightly-spaced
 * entries around the 200 mark: the road climbs, goes over inverted, and comes
 * back down beside where it went up. Two things about it are worth knowing
 * before editing them.
 *
 * A loop has to double back on itself — a road is inverted only where its
 * tangent has swung past vertical, and a path whose forward motion never
 * reverses never gets there — so the climbing branch and the descending branch
 * want the same piece of air. They miss each other by 37 units because the road
 * steps sideways on the way in and crosses back at the crown. Squeeze that out
 * and the two branches interpenetrate, which the ribbon shows and the physics
 * cannot resolve at all: it finds the surface under a unicorn by nearest ring,
 * and would pick the wrong branch every time somebody drove in.
 *
 * The points are close together through it for the same reason they are close
 * together in a hairpin — a spline needs them where the curvature is. Thinning
 * them out flattens the loop into a bump.
 *
 * The road is level across the start line, and wants to stay that way: ten
 * unicorns are placed on a grid stretching back from it, and a slope there
 * means the race begins with the whole field sliding backwards.
 */
const CIRCUITS = [{
  points: [
      484, 0, 0, -12, 0, 28, -14, 1, 26, -17, 2, 25, -12, 1, 18, -5, 2, 17, -6, 3, 29, -6, 2, 13,
      -6, 4, 10, -4, 5, 7, -4, 6, 6, -4, 9, 5, -3, 9, 2, -2, 10, 1, 0, 7, -2, -1, 8, -3, 0, 6,
      -4, 1, 5, -6, 1, 4, -8, 1, 1, -5, 1, 0, -6, 1, -2, -6, 0, -3, -5, 0, -5, -6, -1, -6, -5,
      -1, -8, -3, -2, -7, -1, -2, -8, 1, -3, -9, 3, -4, -8, 5, -4, -6, 7, -4, -4, 8, -5, -3, 11,
      -4, 0, 11, -3, 2, 11, -2, 5, 30, -3, 4, 21, -4, 1, 9, -11, 3, 14, -20, 5, 16, -17, 3, 9,
      -17, 3, 4, -28, 4, 0, -29, 3, -5, -28, 3, -10, -27, 3, -14, -25, 2, -16, -24, 3, -18, -22,
      2, -21, -21, 2, -21, -20, 2, -22, -19, 2, -23, -8, 1, -7, -5, 1, -2, -2, 0, -1, -2, 0, 1,
      -2, 1, 0, -2, 0, 3, -6, 0, 9, -9, 1, 28, -10, 0, 28, -12, 0, 28, -13, 0, 27, -17, -1, 25,
      -18, 0, 24, -20, 0, 22, -23, -1, 19, -26, 0, 16, -27, -1, 12, -29, 0, 8, -30, 0, 4, -30, 0,
      1, -29, 0, -4, -30, 0, -6, -28, 1, -9, -27, 0, -13, -25, 1, -17, -23, 1, -20, -18, 1, -23,
      -14, 1, -27, -9, 1, -28, -3, 1, -30, -1, 1, -30, 4, 1, -30, 5, 0, -29, 7, 1, -30, 7, 1,
      -29, 5, 0, -29, 6, 0, -30, 6, 0, -29, 9, -1, -29, 13, 0, -27, 12, -1, -16, 23, -1, -19, 27,
      -1, -14, 28, -1, -8, 30, -1, -5, 30, -1, -2, 30, -1, 1, 30, -1, -1, 19, 0, -2, 6, -1, -2,
      4, 0, -4, 4, 0, -5, 2, -1, -8, 3, 0, -28, -2, 0, -29, 0, 0, -30, 2, 0, -30, 4, 0, -30, 8,
      1, -29, 14, 0, -27, 12, 1, -15, 11, 0, -9, 15, 0, -7, 15, 0, -3, 16, 1, 0, 15, 0, 4, 27, 0,
      13, 24, 0, 18, 21, 0, 22, 21, -1, 22, 20, -2, 21, 24, -2, 18, 22, -3, 10, 28, -4, 7, 29,
      -5, 6, 29, -5, 7, 28, -6, 8, 28, -6, 10, 27, -5, 12, 27, -5, 12, 27, -5, 13, 26, -4, 13,
      26, -4, 15, 24, -4, 18, 23, -3, 19, 19, -3, 23, 15, -2, 26, 8, -1, 27, 2, -1, 24, -3, -1,
      29
    ],
}];
