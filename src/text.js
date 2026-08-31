// Everything the game says, and the letters to say it with. A data file, the
// way src/mesh.js and src/circuits.js are data files.
//
// The glyphs and the strings live together because they are the same decision:
// a caption can only use characters the table below has, and the table only
// carries characters some caption asks for. Split across two files that
// invariant is invisible and gets broken — a name typed with an apostrophe
// renders a hole, silently, because the atlas baker skips what it cannot find.
//
// ── The font ────────────────────────────────────────────────────────────────
// A 3x5 pixel font.
//
// **Three by five is the smallest a Latin alphabet legibly goes.** At 3x4 the
// letters that need a waist — B, E, S, R — have nowhere to put it, and at 2
// wide there is no middle column to hang M, N, W or X off at all. Five rows is
// what buys the crossbar.
//
// Each glyph is five rows, each row three pixels, and three pixels is exactly
// one octal digit — so a glyph is five characters and the string *is* the
// bitmap. 7 is a solid row, 5 is a row with a hole in it, 2 is a single middle
// pixel. Reading down a glyph's five digits shows you the letter, and editing
// one is editing the pixels, which is the whole reason this is not a packed
// binary blob: the denser encodings save a hundred bytes before compression and
// none after it, because a run of octal digits is exactly what gzip is good at.
//
// The order matters and is the lookup: a character's glyph is at
// `FONT_SET.indexOf(ch) * 5`. Space is first and blank, so anything unknown
// landing at -1 is caught by the caller rather than reading off the end.
const FONT_SET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!:-<>&/';

const FONT =
  // ␣      A      B      C      D      E      F      G
  '00000' + '75755' + '65656' + '74447' + '65556' + '74647' + '74644' + '74557' +
  // H      I      J      K      L      M      N      O
  '55755' + '72227' + '11157' + '55655' + '44447' + '57755' + '65555' + '75557' +
  // P      Q      R      S      T      U      V      W
  '75744' + '75571' + '75765' + '74717' + '72222' + '55557' + '55552' + '55775' +
  // X      Y      Z      0      1      2      3      4
  '55255' + '55222' + '71247' + '75557' + '26227' + '71747' + '71717' + '55711' +
  // 5      6      7      8      9      .      !      :      -
  '74717' + '74757' + '71111' + '75757' + '75717' + '00002' + '22202' + '02020' + '00700' +
  // <      >
  //
  // Not really less-than and greater-than: solid triangles, borrowed into those
  // two slots because the selector wants arrows and the font is much the
  // cheapest place in this game to keep a shape.
  //
  // The alternative was tried and reverted: a triangle cut out of a quad by the
  // caption program's fragment stage, which meant a shape mode in the instance
  // format, a second meaning for two of its four components, and a branch in
  // both stages. It cost 74 bytes more than these ten octal digits.
  '13731' + '46764' +
  // &
  //
  // Three pixels is not really enough for an ampersand. This is the compromise —
  // a bowl, a waist and a tail — and it reads as one at this size because nothing
  // else in the set has that shape. It is here for exactly one racer's name.
  '34253' +
  // /
  //
  // A diagonal in three columns, which at this size is two pixels of rise per
  // column and reads cleanly enough. It is here for the lap counter.
  //
  // Last, and in the order FONT_SET lists it — this pair went in the other way
  // round once, and the lap counter drew an ampersand while M&M drew a slash.
  // Nothing checks the two strings agree; the glyph is just whatever five digits
  // land at five times the character's index.
  '11244';

// ── The captions ────────────────────────────────────────────────────────────
// Every line the game ever shows, in the order the atlas bakes them.
//
// **The index comments are not decoration.** game.js addresses rows by number,
// so inserting a line silently repoints every caption after it. That happened
// once: splitting the select screen's instructions in two moved PAUSED and both
// win lines down by one each, and a pause then read "ENTER TO RACE".
const SAYS = [
  'UNICORN RAINBOW RACER',       // 0
  'PRESS ANY KEY TO START',      // 1
  'CHOOSE YOUR RACER',           // 2
  'PRESS LEFT OR RIGHT TO CHOOSE', // 3
  'PRESS ENTER TO RACE',          // 4
  'PAUSED',                      // 5
  'PRESS ANY KEY TO CONTINUE',   // 6
  // Not "YOU WIN" — this screen shows up whenever racer zero crosses the line
  // for the last time, in whatever place it managed, so a win is exactly the
  // one case it cannot claim. "FINISH!" is the flag, and the position readout
  // in the corner is left to say how it went.
  'FINISH!',                     // 7
  'PRESS ENTER KEY FOR TITLE',   // 8
  // The selector's arrows, and they are a caption because that is far the
  // cheapest thing they can be.
  //
  // `say` centres a row's glyphs across its quad and offers no way to place
  // one at an x of its own — the four numbers an instance carries are row,
  // centre y, half-width and fade, with nothing spare. So instead of a
  // position this uses width: a row as long as the widest line in the game,
  // with ink only at its two ends, lands those ends at the edges of whatever
  // quad it is drawn into. Widen the caption and the arrows move apart.
  //
  // Where they land depends only on how long *this* row is, not on how wide the
  // atlas ends up: a row is centred in the padding and the type scales with the
  // atlas, and the two cancel. Twenty-nine characters puts them at ±0.78.
  // Lengthen the row to push them apart.
  '<                           >', // 9
  // What to do with the keys, shown on the grid and gone the moment the flag
  // drops.
  'PRESS UP TO GO',                         // 10
  'PRESS LEFT AND RIGHT TO STEER',          // 11
  // The countdown, and then the flag. One glyph a beat, drawn huge in the middle
  // of the screen — see the note on sizing where game.js draws them.
  //
  // Separate rows from the place numerals further down, which are the same three
  // characters. Those are padded to sit against the right-hand edge, and ink at
  // the edge of its quad is exactly what a centred caption must not have.
  '3',                                      // 12
  '2',                                      // 13
  '1',                                      // 14
  'GO!',                                    // 15
];

/**
 * How wide the atlas is, in characters.
 *
 * **The widest row wins, and these padded ones are it** — every caption above is
 * shorter than this, so the two corner readouts below set the atlas width
 * themselves. It was measured off the longest caption until the grid's
 * instruction shrank to four words; a measured width would now be 29, and the
 * suffix has to start further right than that to sit against the numeral.
 *
 * Widening it does not resize a single letter. A glyph's size is a caption's
 * half-width over the atlas width, and game.js scales its half-widths off this
 * (`TYPE = CARD_W / 116`), so the two cancel — the same cancellation that keeps
 * the arrows and the place readout where they are whatever this says. What it
 * does change is how far a padded row can reach: full width is exactly the edge
 * of the quad, which is how the lap counter gets into its corner.
 */
const WIDE = 43;

const LINES = [
  ...SAYS,
  // Which circuit this is, one row each. Built from the roster of seeds rather
  // than written out, so adding a track adds its own caption — and the "/ 2"
  // on every one of them corrects itself, which a hand-written list would not.
  //
  // This is why circuits.js is concatenated ahead of this file: the count is
  // read here, at module scope, not at some later call.
  ...CIRCUITS.map((_, i) => `CIRCUIT ${i + 1} / ${CIRCUITS.length}`),
  // The running order, top right, in two pieces.
  //
  // **The number and its suffix are separate rows because they are different
  // sizes** — a big numeral with a small "ST" tucked against it, the way every
  // kart game has drawn a position since the arcade. One row cannot hold two
  // sizes: a caption is one quad at one half-width.
  //
  // Both are right-aligned by padding, for the same reason the arrows are a row
  // with ink at both ends: a caption carries a row, a centre y, a half-width and
  // a fade, and nothing that says where across the screen to put it. Rows of
  // mostly spaces cost almost nothing — it is the one thing a compressor is best
  // at.
  //
  // **Padded to 24 and not the full width, because size and position are the
  // same number here.** A glyph's size is the half-width over the atlas width,
  // and the right edge of a full-width row is the right edge of the quad — so
  // drawing this bigger by widening the quad also throws it off the side of the
  // screen. Padding shorter pulls the ink inboard, which is what buys the room
  // to scale up. 24 leaves the numeral ending at 0.81, with the suffix sitting
  // in the gap from 0.83 to 0.91.
  //
  // A count and not WIDE, and that is not an oversight: the pad and the atlas
  // width cancel, so this row ends at 0.81 whatever WIDE is.
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((n) => n.padStart(24)),
  // Four suffixes, not ten: first, second, third, and then everything else.
  ...['ST', 'ND', 'RD', 'TH'].map((x) => x.padStart(WIDE)),
  // The lap, top left, one row a lap.
  //
  // Padded the other way for the other corner, and to the full width because
  // that is as far left as a caption reaches: the ink of a full-width row starts
  // at the quad's own left edge, so the leftmost a caption can sit is minus its
  // own half-width. Reaching the edge of the screen therefore *requires* a
  // half-width of about 0.8 — which is why the lap is drawn at LARGE and not at
  // MEDIUM. Smaller type simply cannot get to the corner.
  //
  // Two rows because the race is two laps. Add a lap and add a row.
  ...['LAP 1/2', 'LAP 2/2'].map((l) => l.padEnd(WIDE)),
  ...UNICORNS.map((u) => u.name.toUpperCase()),
];