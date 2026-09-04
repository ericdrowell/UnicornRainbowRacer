const UNICORN_SELECT_NEXT = [MENU_SONG, 0, 93];
const UNICORN_SELECT_PREV = [MENU_SONG, 0, 86];
const READY_SIGNAL = [RACE_SONG, 1, 55];
// A whoosh is noise with a moving filter on it, not a pitch, so no note of any
// instrument in the songs can be one. This is its own instrument instead, spread
// from the race song's fourth track — already noise behind a swept filter
// (`noise_fader` full, `lfo_fx_freq` on), just shaped as a percussive hit.
const WHOOSH = {
  ...RACE_SONG.songData[3],
  osc1_vol: 0, // drop the tone, leave only the noise
  osc2_vol: 0,
  env_attack: 7500, // a swell and a long fall, not a 1ms hit. 1.77s all told
  env_sustain: 10500,
  env_release: 60000,
  fx_filter: 3, // band-pass; the inherited high-pass just opens onto hiss
  fx_freq: 2600, // the top of the sweep, so this is what sets the pitch
  // The LFO period is rowLen * 2^(8 - freq) samples = 96000 here, against a
  // 78000-sample effect: one arc, up and most of the way back down, rather than
  // the two-and-a-half whooshes a faster LFO gives over a sound this long.
  lfo_freq: 4,
  lfo_amt: 255,
  fx_delay_amt: 0,
};
const BOOST = [WHOOSH, 0, 60];
const MISTAKE = [RACE_SONG, 0, 47];


const shot = ([song, track, note], loud) => {
  let buf = null;
  if (MUSIC_ENABLED) {
    // Either a song to take a track from, or an instrument outright (WHOOSH).
    buf = renderNote(MUSIC, song.songData ? song.songData[track] : song, note);
  }
  return (vol = loud) => {
    if (!buf) return;
    const s = MUSIC.createBufferSource();
    s.buffer = buf;
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
