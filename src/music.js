// Music. One Sonant-X song, rendered once at load and looped forever.
//
// Sonant-X is a synthesiser, not a player: `generateSong` runs the instruments
// through an OfflineAudioContext and hands back finished samples. That is the
// whole reason it suits a 13 kB budget — the song ships as a few hundred bytes
// of note data and becomes half a minute of audio at runtime, where any real
// audio file would eat the entire entry.
//
// Rendering takes a moment and blocks nothing: it returns a promise, the unicorn
// carries on drawing, and the sound joins when it is ready.

const MUSIC = new (AudioContext || webkitAudioContext)();

generateSong(SONG, MUSIC.sampleRate).then((buffer) => {
  const source = MUSIC.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(MUSIC.destination);
  source.start();

  // Autoplay is not something a page gets to decide. Every current browser
  // starts an AudioContext suspended until the user has interacted with the
  // page, so "start on load" really means "start as soon as it is allowed to".
  // The source is already running either way — a suspended context has a
  // stopped clock, so nothing is missed and the track begins at its first note
  // rather than partway through.
  if (MUSIC.state === 'suspended') {
    const start = () => {
      MUSIC.resume();
      removeEventListener('pointerdown', start);
      removeEventListener('keydown', start);
    };
    addEventListener('pointerdown', start);
    addEventListener('keydown', start);
  }
});
