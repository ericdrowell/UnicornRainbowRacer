// Music. One Sonant-X song, rendered once at load and looped while you drive.
// Whether it is playing at all is game.js's business — a pause silences it —
// so this file only renders it and reports for duty. See syncMusic.
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

// ── Trim the song to what is actually written ───────────────────────────────
// A SoundBox export carries two numbers that disagree with its own patterns, and
// both of them break a loop.
//
// `endPattern` is how many pattern slots the scheduler cycles through, and it is
// set in the editor rather than derived — so a song written as four bars but
// left with the length slider at six declares six. The scheduler does
// `p[floor(row / 32) % (endPattern + 1)] || 0`, and the two slots past the end of
// `p` come back undefined, fall through the `||`, and play as silence. Every
// song here is like that: four bars of music and two of nothing, every time
// round, which does not sound like a gap in a loop — it sounds like the music
// stopped.
//
// `songLen` is the render length in seconds, also authored by hand, and it
// truncates whatever it is shorter than. Derived instead from the tempo the
// scheduler actually runs at: `bpm` is *rounded* off rowLen inside sonant-x, so
// the row it schedules is 60/bpm/4 rather than rowLen/44100, and computing this
// from rowLen directly drifts a few milliseconds by the end of the loop.
//
// The clamp is one-directional on purpose. A song asking for *fewer* slots than
// it has patterns is a deliberately short loop and is left alone; only the
// over-declaration is corrected.
const SLOTS = Math.min(
  RACE_SONG.endPattern + 1,
  Math.max(...RACE_SONG.songData.map((ch) => ch.p.length)),
);
RACE_SONG.endPattern = SLOTS - 1;
/** How long one time round is, in seconds. */
const LOOP = (SLOTS * 32 * 60) / (Math.round(661500 / RACE_SONG.rowLen) * 4);
// Rendered twice over on purpose — see the second time round, below.
RACE_SONG.songLen = LOOP * 2;

if (MUSIC_ENABLED) {
  generateSong(RACE_SONG, MUSIC.sampleRate).then((raw) => {
    // ── Keep the second time round, not the first ──────────────────────────
    // Cutting the render at the loop point leaves every note that was still
    // releasing chopped off mid-decay, and the jump from that to the silence of
    // the first sample is a click once round — measured at 0.69 against a peak
    // of 1.83, which is not subtle.
    //
    // The fix is not to render a little extra and add it back over the start.
    // That was the first attempt and it made things worse: the scheduler already
    // wraps its pattern list, so the samples past the loop point are not the
    // ring-out of the last bar, they are *the first bar playing again*. Adding
    // them to the start doubled the opening — its RMS went from 0.33 to 1.19.
    //
    // What is actually wanted is a slice of the song mid-performance, with the
    // previous time round already ringing through it. So it is rendered twice
    // and the *second* pass is kept. Its opening carries the tail of the first
    // pass, and because both passes play identical notes, that tail is exactly
    // what this pass's own ending will hand to whatever follows it. The buffer
    // therefore joins to itself: the end runs into a start that is already
    // expecting it.
    //
    // Twice is enough, and three times would buy nothing. The tail rings for
    // less than a bar and every pass is the same music, so pass two is already
    // indistinguishable from pass two hundred.
    const rate = raw.sampleRate;
    const len = Math.round(LOOP * rate);
    const buffer = MUSIC.createBuffer(raw.numberOfChannels, len, rate);
    for (let ch = 0; ch < raw.numberOfChannels; ch++) {
      buffer.getChannelData(ch).set(raw.getChannelData(ch).subarray(len, len * 2));
    }
    SONG = buffer;
    syncMusic();

    // Autoplay is not something a page gets to decide. Every current browser
    // starts an AudioContext suspended until the user has interacted with the
    // page, so "start on load" really means "start as soon as it is allowed to".
    // The source syncMusic just made is already running either way — a suspended
    // context has a stopped clock, so nothing is missed and the track begins at
    // its first note rather than partway through.
    //
    // Through syncMusic rather than resume, because this gesture might be the
    // Escape that just paused the game — and unconditionally resuming here
    // undid that pause, so the first Escape after loading started the music
    // instead of stopping it. Asking the game what it wants gives the same
    // answer whichever handler runs last.
    if (MUSIC.state === 'suspended') {
      const start = () => {
        syncMusic();
        removeEventListener('pointerdown', start);
        removeEventListener('keydown', start);
      };
      addEventListener('pointerdown', start);
      addEventListener('keydown', start);
    }
  });
}
