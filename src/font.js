// A 3x5 pixel font, and nothing else. A data file, the way src/mesh.js and
// src/circuits.js are data files.
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
const FONT_SET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!:-&';

const FONT =
  // ␣      A      B      C      D      E      F      G
  '00000' + '75755' + '65656' + '74447' + '65556' + '74647' + '74644' + '74557' +
  // H      I      J      K      L      M      N      O
  '55755' + '72227' + '11157' + '55655' + '44447' + '57755' + '65555' + '75557' +
  // P      Q      R      S      T      U      V      W
  '75744' + '75571' + '75765' + '74717' + '72222' + '55557' + '55552' + '55775' +
  // X      Y      Z      0      1      2      3      4
  '55255' + '55222' + '71247' + '75557' + '26227' + '71747' + '71717' + '55711' +
  // 5      6      7      8      9      .      !      :      -      &
  //
  // Three pixels is not really enough for an ampersand. This is the
  // compromise — a bowl, a waist and a tail — and it reads as one at this
  // size because nothing else in the set has that shape.
  '74717' + '74757' + '71111' + '75757' + '75717' + '00002' + '22202' + '02020' + '00700' + '34253';
