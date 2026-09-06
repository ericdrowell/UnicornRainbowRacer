const UNICORN_SELECT_NEXT = [MENU_SONG, 0, 93];
const UNICORN_SELECT_PREV = [MENU_SONG, 0, 86];
const READY_SIGNAL = [RACE_SONG, 1, 55];
// A whoosh is noise with a moving filter on it, not a pitch, so no note of any
// instrument in the songs can be one. This is its own instrument instead, spread
// from the race song's fourth track — already noise behind a swept filter
// (`noise_fader` full, `lfo_fx_freq` on), just shaped as a percussive hit.
// Indices are the flattened instrument's — see SYNTH in build.mjs for the order
// and the legend in lib/sonantx-custom.js for what each slot is.
const WHOOSH = [...RACE_SONG.songData[3]];
WHOOSH[4] = WHOOSH[10] = 0; // drop both tones, leave only the noise
WHOOSH[13] = 7500; // a swell and a long fall, not a 1ms hit. 1.77s all told
WHOOSH[14] = 10500;
WHOOSH[15] = 60000;
WHOOSH[17] = 3; // band-pass; the inherited high-pass just opens onto hiss
WHOOSH[18] = 2600; // the top of the sweep, so this is what sets the pitch
// The LFO period is rowLen * 2^(8 - freq) samples = 96000 here, against a
// 78000-sample effect: one arc, up and most of the way back down, rather than
// the two-and-a-half whooshes a faster LFO gives over a sound this long.
WHOOSH[26] = 4;
WHOOSH[27] = 255;
WHOOSH[21] = 0;
const BOOST = [WHOOSH, 0, 60];

const MISTAKE = [RACE_SONG, 0, 47];

// Picking one up — and it is a power-up, not a chime, because a star is a
// quarter of a run rather than a thing you collected. Three notes climbing a
// major triad is what that has sounded like since the arcade.
//
// One buffer, played three times at three `playbackRate`s, and not three
// renders: resampling a note up a third and a fifth is a couple of dozen bytes
// against a couple of hundred, and on a note this short the artefacts of doing
// it that way are the arcade sound rather than a flaw in it.
const GRAB = [RACE_SONG, 1, 89];


const shot = ([song, track, note], loud) => {
  let buf = null;
  if (MUSIC_ENABLED) {
    // Either a song to take a track from, or an instrument outright (WHOOSH).
    buf = renderNote(MUSIC, song.songData ? song.songData[track] : song, note);
  }
  return (vol = loud, rate) => {
    // **Nothing sounds while star power is up.** Every effect in the game comes
    // through here — the pad, the pickup triad, the mistake, the countdown — so
    // one test is the whole of it, and the seven seconds are the heartbeat and
    // nothing else. The silence is the point: it is what makes a run feel like
    // a different mode rather than a faster one, and a boost pad chirping
    // through it would put the ordinary race back in the player's ear.
    //
    // The whoosh that *announces* a run still sounds, and that is not an
    // exception to this — it fires on the frame the clock goes up, from the edge
    // test in game.js, which reads `starLeft` before it is assigned. The gate
    // closes immediately behind it. That is the order the effect wants: one
    // sound, and then the floor drops out.
    //
    // `starLeft` lives in game.js, which is concatenated after this file. Safe
    // because nothing here runs at load — a `let` is only in its dead zone until
    // its own line has run, and by the time a player can make a noise happen
    // every line in the bundle has.
    if (!buf || starLeft) return;
    const s = MUSIC.createBufferSource();
    s.buffer = buf;
    // Pitch by resampling. The power-up asks for it so one rendered note can be
    // three.
    if (rate) s.playbackRate.value = rate;
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
