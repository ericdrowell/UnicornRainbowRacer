// The roster, and nothing else. A data file, the way src/mesh.js and
// src/circuits.js are data files: the build concatenates it ahead of src/text.js
// — which spells the names into the caption atlas — and ahead of game.js, which
// picks one to ride and puts the rest on the grid.
//
// Four unicorns, differing in body colour, horn colour, and the colours their
// mane and tail run between. Everything else — hooves, eyes — is shared, so a
// new one is a handful of numbers and a name rather than a new model.
//
// `horn` and `eye` are both optional — gold and near-black when left out, which
// is what nearly every entry wants. Spelling them on every line to say what the
// default already says is noise around the ones that differ.
//
// There used to be a `wing` colour here as well. The wings are gone: 88 of the
// model's 339 triangles for a pair of pads that a chase camera only ever sees
// the back of, and 1.2 kB of a budget that is 8 kB over.
//
// The mane is a gradient rather than one flat colour, because the mane already
// has a band coordinate running along it for the rainbow and a single colour
// throws that away: the crest goes matte and stops reading as hair. `mane: 0`
// means the original spectrum instead.
//
// Six numbers are two colours and the crest runs between them; nine are three
// and it runs through the middle one on the way. Two is enough whenever the
// colour wanted in the middle is the mix of the ends — pink to blue passes
// through lavender on its own — and three is for when it is not, which is any
// mane naming hues from opposite sides of the wheel.

const UNICORNS = [
  { name: 'Starlight', body: [1, 0.97, 0.99], mane: 0 },
  { name: 'Ember', body: [1, 0.55, 0.15], mane: [0.88, 0.15, 0.12, 1, 0.8, 0.2] },
  { name: 'Midnight', body: [0.1, 0.09, 0.15], horn: [1, 1, 1], eye: [1, 1, 1], mane: [0.25, 0.09, 0.4, 0.42, 0.18, 0.58] },
  { name: 'Bubble Gum', body: [1, 0.8, 0.88], mane: [0.72, 0.09, 0.38, 0.88, 0.22, 0.52] },
  {
    name: 'Sparkle',
    body: [0.55, 0.32, 0.78],
    horn: [1, 0.55, 0.78],
    mane: [1, 0.97, 0.99, 0.95, 0.45, 0.72],
  },
  {
    name: 'Goldfish',
    body: [0.9, 0.72, 0.28],
    horn: [0.72, 0.45, 0.2],
    mane: [0.85, 0.87, 0.9, 0.72, 0.45, 0.2],
  },
  // Pink and blue, and the purple comes free. A mane is two colours blended
  // along a band that runs the length of the crest, so the middle of it is
  // already the mix of the ends — and pink mixed with blue is exactly the
  // lavender this one wants in the middle. Storing a third colour to put it
  // there would be a fifth palette slot for every racer to say what the two it
  // already has were going to say anyway.
  {
    name: 'Cupcake',
    body: [0.62, 0.82, 0.95],
    horn: [1, 0.72, 0.82],
    mane: [1, 0.45, 0.72, 0.42, 0.6, 1],
  },
  // The palest of the roster: hide and mane are within a few hundredths of each
  // other, so the gold horn is the only thing on it with any contrast, and it
  // takes the default rather than naming one. The mane still runs between two
  // tones rather than sitting on one — cream to a warmer peach — because a
  // single colour on a crest that already has a band coordinate through it
  // comes out matte and stops reading as hair. Two near-identical tones are
  // enough to keep it.
  {
    name: 'Seashell',
    body: [1, 0.82, 0.85],
    mane: [1, 0.89, 0.8, 0.96, 0.8, 0.68],
  },
  // The first mane that genuinely needs three stops. Blue to red on its own runs
  // through purple, and blue to green runs through teal — there is no pair whose
  // midpoint is the other colour, which is what the two-colour form has always
  // relied on.
  {
    name: 'M&M',
    body: [0.12, 0.18, 0.48],
    horn: [0.25, 0.78, 0.35],
    mane: [0.2, 0.35, 0.9, 0.2, 0.75, 0.3, 0.85, 0.15, 0.15],
  },
  // Back to two stops: light blue to dark blue is one hue at two brightnesses,
  // so the middle takes care of itself.
  {
    name: 'Spidey',
    body: [0.85, 0.14, 0.16],
    horn: [0.85, 0.14, 0.16],
    eye: [1, 1, 1],
    mane: [0.45, 0.72, 1, 0.1, 0.22, 0.6],
  },
];
