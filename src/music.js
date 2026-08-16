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

//
// MUSIC_ENABLED, from game.js, gates the whole file — and it is the switch
// itself that every guard tests, not the context it produces. Testing `MUSIC`
// instead reads better and costs 18 kB of source: game.js refers to MUSIC
// before this file declares it, and a const that is used ahead of its
// declaration is one terser will not fold, so the branch survives minification
// and drags the synthesiser and the song data through with it. Naming the
// switch directly, in a file that comes after the one declaring it, is a value
// terser can see is false — and then everything below is unreachable and goes.
const MUSIC = MUSIC_ENABLED && new (AudioContext || webkitAudioContext)();

if (MUSIC_ENABLED) {
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
}
