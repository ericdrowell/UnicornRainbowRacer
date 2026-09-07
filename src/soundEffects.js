const UNICORN_SELECT_NEXT = [0, 93];
const UNICORN_SELECT_PREV = [0, 86];
const READY_SIGNAL = [1, 55];
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
const BOOST = [WHOOSH, 60];

const MISTAKE = [0, 47];

// Picking one up — and it is a power-up, not a chime, because a star is a
// quarter of a run rather than a thing you collected. Three notes climbing a
// major triad is what that has sounded like since the arcade.
//
// One buffer, played three times at three `playbackRate`s, and not three
// renders: resampling a note up a third and a fifth is a couple of dozen bytes
// against a couple of hundred, and on a note this short the artefacts of doing
// it that way are the arcade sound rather than a flaw in it.
const GRAB = [1, 89];



const shot = ([track, note], loud) => {
  let buf = null;
  if (MUSIC_ENABLED) {
    // Tracks always come from the race song; WHOOSH supplies an instrument directly.
    buf = renderNote(MUSIC, RACE_SONG.songData[track] || track, note);
  }
  return (vol = loud, rate) => {
    // **Star power used to silence this, and it does not any more.** Every
    // effect in the game comes through here, so one test against `starLeft` was
    // the whole of a mode where the run was a heartbeat and nothing
    // else. That was built around a song of its own; the run plays the race
    // music now, with a pulse beaten over it, and against that a floor that
    // drops out of everything else is not a different mode — it is a bug that
    // eats the pickup you just took.
    if (!buf) return;
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
