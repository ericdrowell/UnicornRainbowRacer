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
    484, 0, 0, 472, 0, 28, 458, 1, 54,
    441, 3, 79, 429, 4, 97, 424, 6, 114,
    418, 9, 143, 412, 11, 156, 406, 15, 166,
    402, 20, 173, 398, 26, 179, 394, 35, 184,
    391, 44, 186, 389, 54, 187, 389, 61, 185,
    388, 69, 182, 388, 75, 178, 389, 80, 172,
    390, 84, 164, 391, 85, 159, 392, 85, 153,
    393, 83, 147, 393, 80, 142, 393, 75, 136,
    392, 69, 131, 391, 61, 128, 389, 54, 127,
    387, 46, 128, 384, 37, 131, 380, 29, 136,
    376, 23, 143, 372, 19, 151, 367, 16, 162,
    363, 16, 173, 360, 18, 184, 358, 23, 214,
    355, 27, 235, 351, 28, 244, 340, 31, 258,
    320, 36, 274, 303, 39, 283, 286, 42, 287,
    258, 46, 287, 229, 49, 282, 201, 52, 272,
    174, 55, 258, 149, 57, 242, 125, 60, 224,
    103, 62, 203, 82, 64, 182, 62, 66, 160,
    43, 68, 137, 35, 69, 130, 30, 70, 128,
    28, 70, 127, 26, 70, 128, 24, 71, 128,
    22, 71, 131, 16, 71, 140, 7, 72, 168,
    -3, 72, 196, -15, 72, 224, -28, 72, 251,
    -45, 71, 276, -63, 71, 300, -83, 71, 322,
    -106, 70, 341, -132, 70, 357, -159, 69, 369,
    -188, 69, 377, -218, 69, 381, -248, 69, 382,
    -277, 69, 378, -307, 69, 372, -335, 70, 363,
    -362, 70, 350, -387, 71, 333, -410, 72, 313,
    -428, 73, 290, -442, 74, 263, -451, 75, 235,
    -454, 76, 205, -455, 77, 175, -451, 78, 145,
    -446, 78, 116, -439, 79, 86, -432, 80, 57,
    -427, 80, 28, -421, 80, -2, -415, 80, -31,
    -406, 79, -60, -393, 79, -87, -381, 78, -103,
    -358, 77, -122, -331, 76, -136, -303, 75, -144,
    -273, 74, -149, -243, 73, -151, -213, 72, -150,
    -183, 71, -151, -164, 71, -153, -158, 70, -155,
    -154, 70, -159, -150, 70, -164, -148, 69, -172,
    -145, 69, -200, -147, 69, -229, -147, 69, -259,
    -145, 69, -289, -141, 69, -319, -133, 70, -348,
    -119, 70, -375, -107, 71, -390, -96, 71, -399,
    -81, 71, -406, -66, 71, -409, -50, 72, -409,
    -35, 72, -405, -8, 72, -392, 16, 72, -374,
    37, 72, -352, 58, 71, -330, 78, 69, -309,
    102, 67, -291, 124, 64, -281, 152, 60, -274,
    181, 55, -268, 210, 50, -261, 238, 44, -253,
    266, 38, -243, 293, 33, -231, 320, 28, -219,
    347, 23, -206, 373, 19, -193, 399, 15, -178,
    423, 11, -160, 446, 8, -141, 465, 5, -118,
    480, 3, -92, 488, 2, -65, 490, 1, -41,
    487, 0, -12,
  ],
}];
