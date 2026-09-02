// The sound effects, and the one function that turns one into something you can
// call. The build concatenates this ahead of game.js, which names the three it
// wants and plays them.
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
// The alternative was a page of parameter arrays, twenty numbers a sound,
// against a second synthesiser that would have had to ship alongside them.
// Measured with three effects wired up: 598 zipped bytes that way, 170 this
// way. What the cheap route cannot do is sound un-musical — every effect is a
// note of a dizzy-beats instrument, so a scrape or a thud is out of reach.
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

// The carousel, one seat at a time. Two effects rather than one, five semitones
// apart: the higher note goes with moving right and the lower with moving left,
// so the direction you are travelling is audible without looking. It is the
// oldest trick a menu has, and it costs a second entry in this file and nothing
// else — the instrument is already rendered either way.
//
// **Track 0, and it had to move.** These pointed at track 4, and the menu song
// lost two of its five channels — an index into an array, so nothing would have
// complained on the way past: `songData[4]` comes back undefined and the render
// throws on the first line that reads a field off it, at module scope, before
// anything is on screen. Track 0 is a detuned pair of squares an octave apart
// with ten of attack, which is bright and immediate — what a menu wants over
// quiet. The interval is untouched, so the direction still reads.
const UNICORN_SELECT_NEXT = [MENU_SONG, 0, 74];
const UNICORN_SELECT_PREV = [MENU_SONG, 0, 69];

// The start line. Three of these, a second apart, and then a fourth beat of
// silence on which the race begins.
//
// **There is no start signal, and that is deliberate.** There was one, and it
// doubled: the race song opens on a hit of its own, so the flag already sounds
// like a flag the instant the track cuts in. Playing a note over the top of it
// muddied the one moment in the game that wants to be clean.
const READY_SIGNAL = [RACE_SONG, 1, 55];

// Hitting a boost pad. The same instrument the race is already playing
// underneath, so a pad reads as the track hitting a note rather than as an
// effect landing on top of one.
//
// One note for all three lanes. A note *per* lane was tried — 80, 82 and 84,
// rising left to right, so a boost going off in the field said which side of the
// road it was taken on. It cost the physics stage a latched lane in the state
// buffer, because the CPU only learns about a boost on the poll after it
// happened, by which time the racer has usually left the pad.
const BOOST = [RACE_SONG, 3, 97];

// Hitting something — another unicorn, or the rail that will not let you off the
// road. One sound for both, because from the driver's seat they are the same
// event: you wanted to be somewhere and something was already there.
//
const BUMP = [RACE_SONG, 2, 73];

// ── Playing one ─────────────────────────────────────────────────────────────
// An effect goes in, a function that plays it comes out.
//
// **Rendered at start-up, not on demand.** Synthesising a note takes a
// millisecond or so, which is nothing at load and far too much at the moment a
// key goes down. A buffer is instant. Nothing waits on it either — the returned
// function simply does nothing until the buffer exists.
//
// A fresh source per play, because an AudioBufferSourceNode is single-use:
// `start()` twice on one throws, and holding one to reuse is the bug where the
// second press is silent. They are cheap and self-disposing.
//
// **This reads `MUSIC` and `MUSIC_ENABLED` out of game.js, which is
// concatenated after this file.** That works because nothing here runs on the
// way past: `shot` is only ever *called* from game.js, by which point both
// exist. Rendering an effect at this point in the file instead — at the top
// level, where the constants above are declared — would be a ReferenceError.
// Rendered rather than played on demand: `generateSound` mixes through an
// OfflineAudioContext and hands back a promise, which is no use at the moment a
// key goes down. A buffer is. Nothing waits on it either — the play function
// simply does nothing until the buffer lands, which is a few milliseconds after
// load and long before a player reaches a screen that uses one.
//
// A fresh source per play, because an AudioBufferSourceNode is single-use:
// `start()` twice on one throws, and holding one to reuse is the bug where the
// second press is silent. They are cheap and self-disposing.
const shot = ([song, track, note], loud) => {
  let buf = null;
  if (MUSIC_ENABLED) {
    buf = renderNote(MUSIC, song.songData[track], note);
  }
  // The volume is optional and per-play, because the boost pads are: ten
  // unicorns can take one and the near ones have to be louder than the far
  // ones, which a gain fixed when the effect is built cannot do. Left out, it
  // falls back to the volume this effect was made with.
  return (vol = loud) => {
    if (!buf) return;
    const s = MUSIC.createBufferSource();
    s.buffer = buf;
    // Straight to the speakers, past MIX: an effect is a cue, and a cue that
    // ducks with the music it is competing with is no cue at all. `loud` lifts
    // the ones that have to carry over a track — a single note of an instrument
    // written to sit inside a mix is very quiet on its own.
    if (vol) {
      const g = MUSIC.createGain();
      g.gain.value = vol;
      s.connect(g);
      g.connect(MUSIC.destination);
    } else {
      s.connect(MUSIC.destination);
    }
    s.start();
  };
};
