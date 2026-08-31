// The sound effects, and nothing else. A data file, the way src/mesh.js and
// src/circuits.js are data files: the build concatenates it ahead of game.js,
// which renders every entry once at start-up and plays them by name.
//
// **An effect is a song, a channel and a note, not a waveform.** sonantx is
// already in the program for the music, and it already carries `generateSound` —
// a one-shot player for a single note of any instrument. So an effect borrows an
// instrument that is already here and says which note to hit it at.
//
// Either song can be borrowed from, and they are not interchangeable: the race
// song's instruments are the ones playing underneath a race, so an effect built
// from them sits in the mix; the menu song's are softer and cut through better
// over quiet. Naming the song rather than assuming one is why this file is
// concatenated after them — see build.mjs.
//
// The file this replaced was a page of ZzFX parameter arrays, twenty numbers a
// sound, against a synthesiser that would have had to ship alongside them.
// Measured with three effects wired up: ZzFX 598 zipped bytes, this 170. What
// the cheap route cannot do is sound un-musical — every effect is a note of a
// dizzy-beats instrument, so a scrape or a thud is out of reach.
//
// The channel is an index into that song's `songData`, so what an effect sounds
// like is decided by whatever the track's instrument is; edit the song and the
// effects move with it. The note is sonantx's own numbering, where 128 is F3 —
// so 72 is a good way up the register, which is what makes a click a click
// rather than a thud.
// One const per effect rather than a table keyed by name: a key is a string, and
// a string survives the minifier at full length, so a map of five effects ships
// five names for nothing. These get mangled to a letter each.
//
// The channel is an index into that song's `songData`, so what an effect sounds
// like is decided by whatever the track's instrument is; edit the song and the
// effects move with it. The note is sonantx's own numbering, where 128 is F3 —
// so 72 is a good way up the register, which is what makes a click a click
// rather than a thud.

// The carousel, one seat at a time. Two effects rather than one, four semitones
// apart: the higher note goes with moving right and the lower with moving left,
// so the direction you are travelling is audible without looking. It is the
// oldest trick a menu has, and it costs a second entry in this file and nothing
// else — the instrument is already rendered either way.
const UNICORN_SELECT_NEXT = [MENU_SONG, 4, 93];
const UNICORN_SELECT_PREV = [MENU_SONG, 4, 89];

// The start line. Three of these, a second apart, and then a fourth beat of
// silence on which the race begins.
//
// **There is no start signal, and that is deliberate.** There was one, and it
// doubled: the race song opens on a hit of its own, so the flag already sounds
// like a flag the instant the track cuts in. Playing a note over the top of it
// muddied the one moment in the game that wants to be clean.
const READY_SIGNAL = [RACE_SONG, 1, 55];
