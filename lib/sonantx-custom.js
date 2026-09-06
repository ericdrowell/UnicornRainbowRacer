// The synthesiser, cut down to the two things this game asks of it.
//
// **This replaces the sonantx package, which was the single biggest line item in
// the build** — 1,227 zipped bytes, more than every visual effect in the game put
// together. What follows renders the same instrument format to the same samples,
// and the reason it is so much smaller is not cleverness: sonantx builds its
// output through the Web Audio graph, and this writes it into an array.
//
// sonantx renders a song by standing up an OfflineAudioContext, hanging a
// ScriptProcessorNode off a silent oscillator to get a callback, and wiring a
// DelayNode with a feedback loop for the echo — per track. That is four node
// types, a chain to start and stop, a block-boundary dance to carry a note
// across two `onaudioprocess` calls, and a Promise to wait for the render. None
// of it is needed to fill a Float32Array. The audio is the same because the
// oscillators, the envelope and the filter are the same arithmetic; only the
// plumbing is gone.
//
// **The echo is the one part that had to be derived rather than copied.**
// sonantx routes a track through `scriptNode → delayGain → delay → delayGain`,
// with the delay and the dry signal summing into a mixer. Writing that out: the
// delay line's output is `e[n] = a * (s[n-D] + e[n-D])`, and the mixed output is
// `out[n] = s[n] + e[n]` — so `s[n-D] + e[n-D]` is just `out[n-D]`, and the whole
// graph collapses to
//
//     out[n] = s[n] + a * out[n - D]
//
// one line over the buffer the track has already been written into. Which is
// what the original SoundBox player did before any of it was a Web Audio graph.
//
// **How closely this matches, measured rather than assumed.** Rendered against
// sonantx sample for sample, at 44100 and at 48000:
//
//   - with the echo off, the difference is *exactly zero* — the oscillators, the
//     envelope, the filter, the pan, the 16-bit fold and the note scheduling all
//     agree bit for bit;
//   - with the echo on, about 1.6% RMS. Web Audio inserts one render quantum
//     into any feedback cycle, so sonantx's repeats land 128 samples later each
//     time round the loop while these sit on the musical grid. Three milliseconds
//     a repeat, on a tail already down to a quarter volume;
//   - a noise channel differs completely, and would differ between two runs of
//     sonantx as well: `noise_fader` reads `Math.random`.
//
// sonantx also delivers everything 1024 samples late — two ScriptProcessorNode
// buffers of latency, silence at the head of every effect. That is gone too.
//
// **Not a general port.** It does the two calls this game makes — render a song,
// render one note of one instrument — and nothing else. There is no realtime
// player, no start/stop/connect, and it renders into an AudioBuffer belonging to
// the context you hand it rather than inventing one of its own.

/**
 * The four waveforms, indexed the way an instrument's `osc1_waveform` names them.
 *
 * The square is the sine's sign rather than a phase test of its own, which is
 * what sonantx does and is worth keeping: at exactly 0.5 the two disagree, and
 * that lands on a sample often enough to hear.
 */
const TAU = Math.PI * 2;
const OSC = [
  (v) => Math.sin(v * TAU),
  (v) => (Math.sin(v * TAU) < 0 ? -1 : 1),
  (v) => (v % 1) - 0.5,
  (v) => {
    const w = (v % 1) * 4;
    return w < 2 ? w - 1 : 3 - w;
  },
];

/**
 * A note number as a phase step: cycles per sample at 44100.
 *
 * 128 is the reference and 0.00390625 is 1/256, which puts note 128 a little
 * above 170 Hz. An instrument's own octave and detune are folded into `n` before
 * it gets here.
 */
const pitch = (n) => 0.00390625 * 1.059463094 ** (n - 128);

/**
 * Sixteen bits, on purpose.
 *
 * The sample is offset into unsigned 16-bit range, truncated to two bytes,
 * shifted back and multiplied by four. Anything past ±32768 therefore *wraps*
 * rather than clipping, and comes back the opposite polarity — a hard, fizzing
 * distortion that is very much part of how these instruments sound at high
 * `env_master`. Taking it out makes the songs sound wrong, not cleaner.
 *
 * The clamp afterwards is the only part that behaves: it catches the four-times
 * gain, which cannot wrap because it is applied after the truncation.
 */
const fold = (s) => {
  const y = 4 * (((32768 + s) & 65535) - 32768);
  return (y < -32768 ? -32768 : y > 32767 ? 32767 : y) / 32768;
};

/**
 * How many samples a tracker row lasts.
 *
 * Rounded, because a row boundary has to land on a sample: the note scheduler
 * multiplies this by the row number, and a fractional row would drift a whole
 * sample out over a pattern and put the echo taps off the grid.
 */
const rowAt = (bpm, rate) => Math.round((15 * rate) / bpm);

/**
 * One note of one instrument, summed into a stereo pair at `at`.
 *
 * Named `voice` and not `play` because this file is concatenated raw into
 * tools/sounds.html, where the bench had its own `play` and the two collided
 * into a blank page. Nothing here is mangled on the way into that page the way
 * it is on the way into the game, so every top-level name in this file is a name
 * in that one too.
 *
 * Summed and not written: notes overlap, an instrument's release runs on under
 * the next row, and the whole point of a tracker is that a channel keeps
 * ringing.
 *
 * @param {*} inst    one entry of a song's `songData`
 * @param {number} n  the note, in the instrument's own numbering
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {number} at      first sample
 * @param {number} rowLen  samples in one tracker row, at this sample rate
 * @param {number} rate    samples a second
 */
const voice = (inst, n, L, R, at, rowLen, rate) => {
  const osc1 = OSC[inst.osc1_waveform];
  const osc2 = OSC[inst.osc2_waveform];
  const lfo = OSC[inst.lfo_waveform];
  // Both of these are "per row" rates turned into "per sample" ones, so a pan
  // sweep or an LFO keeps its musical speed whatever the tempo is.
  const panFreq = 2 ** (inst.fx_pan_freq - 8) / rowLen;
  const lfoFreq = 2 ** (inst.lfo_freq - 8) / rowLen;
  // Envelope times are quoted in samples at 44100, so they need scaling to
  // whatever the output device actually runs at — usually 48000.
  const k = rate / 44100;
  const attack = inst.env_attack * k;
  const sustain = inst.env_sustain * k;
  const release = inst.env_release * k;
  const q = inst.fx_resonance / 255;
  // Divided by k for the same reason the envelope multiplies by it: `pitch`
  // answers in cycles per sample at 44100, and a phase accumulator wants cycles
  // per sample here.
  const t1 =
    (pitch(n + (inst.osc1_oct - 8) * 12 + inst.osc1_det) * (1 + 0.0008 * inst.osc1_detune)) / k;
  const t2 =
    (pitch(n + (inst.osc2_oct - 8) * 12 + inst.osc2_det) * (1 + 0.0008 * inst.osc2_detune)) / k;
  const drive = 39 * inst.env_master;

  // Three things most instruments leave switched off, each of them a
  // transcendental function a sample if it stays in the loop. Skipping them is
  // exact rather than approximate: with the LFO unread its value is discarded,
  // with `fx_pan_amt` at zero the pan lands on 0.5 whatever the sine says, and
  // with `fx_filter` at zero the filter's state is never read back out.
  //
  // The cutoff coefficient is worth hoisting even when the filter *is* in use:
  // it only varies if the LFO is driving it, which is rare.
  const swings = inst.lfo_osc1_freq || inst.lfo_fx_freq;
  const pans = inst.fx_pan_amt;
  const mode = inst.fx_filter;
  const fixed = 1.5 * Math.sin((inst.fx_freq * Math.PI) / rate);

  let c1 = 0;
  let c2 = 0;
  let low = 0;
  let band = 0;
  const end = attack + sustain + release;
  for (let j = 0; j < end && at + j < L.length; j++) {
    const swing = swings ? (lfo(j * lfoFreq) * inst.lfo_amt) / 512 + 0.5 : 0;

    // Attack, hold, release — three straight lines, no curve and no decay stage.
    let e = 1;
    if (j < attack) e = j / attack;
    else if (j >= attack + sustain) e -= (j - attack - sustain) / release;

    // The two oscillators. `xenv` bends an oscillator's own pitch down with the
    // envelope, squared — which is how every kick drum in this format is made.
    let t = t1;
    if (inst.lfo_osc1_freq) t += swing;
    if (inst.osc1_xenv) t *= e * e;
    c1 += t;
    let s = osc1(c1) * inst.osc1_vol;

    t = t2;
    if (inst.osc2_xenv) t *= e * e;
    c2 += t;
    s += osc2(c2) * inst.osc2_vol;

    if (inst.noise_fader) s += (2 * Math.random() - 1) * inst.noise_fader * e;
    s *= e / 255;

    // A state-variable filter: one multiply-add a sample gives a low, a high and
    // a band output at once, and the instrument picks one of them.
    if (mode) {
      const f = inst.lfo_fx_freq ? 1.5 * Math.sin((inst.fx_freq * swing * Math.PI) / rate) : fixed;
      low += f * band;
      const high = q * (s - band) - low;
      band += f * high;
      if (mode === 1) s = high;
      else if (mode === 2) s = low;
      else if (mode === 3) s = band;
      else s = low + high;
    }

    t = pans ? (Math.sin(j * panFreq * TAU) * pans) / 512 + 0.5 : 0.5;
    s *= drive;

    L[at + j] += fold(s * (1 - t));
    R[at + j] += fold(s * t);
  }
};

/**
 * The feedback echo, in place, over a track that has already been rendered.
 *
 * See the note at the top of the file: this one line is the whole of sonantx's
 * per-track delay graph. Reading forwards is what makes it feed back — by the
 * time the loop reaches `n`, the sample at `n - d` already carries its own
 * echoes.
 */
const echo = (inst, L, R, bpm, rate) => {
  const amt = inst.fx_delay_amt / 255;
  if (!amt) return;
  const d = Math.round(((inst.fx_delay_time * 7.5) / bpm) * rate);
  for (let n = d; n < L.length; n++) {
    L[n] += amt * L[n - d];
    R[n] += amt * R[n - d];
  }
};

/**
 * Give the page one turn of the event loop.
 *
 * **A message and not a timer**, which looks like the long way round until you
 * try it: `setTimeout` is clamped to four milliseconds once it is nested, and a
 * tab in the background is clamped to a full second. Sixteen of those a track
 * turned a one-second render into a minute the moment someone looked at another
 * window. A message port has neither clamp, and still yields properly — the
 * browser gets to paint a frame before it comes back.
 *
 * requestAnimationFrame is the other obvious answer and is worse: a hidden tab
 * stops painting altogether, so the render would not merely crawl, it would
 * stop, and a player who alt-tabbed through the load would come back to silence.
 */
const breathe = () =>
  new Promise((go) => {
    const c = new MessageChannel();
    c.port1.onmessage = go;
    c.port2.postMessage(0);
  });

/**
 * A whole song, into a buffer belonging to the context that will play it.
 *
 * **Length in samples, not the format's `songLen` in seconds.** The caller
 * renders two laps of a loop so it can keep the second one — the pass where the
 * echoes are already ringing — and it wants a buffer it can cut exactly in half.
 * Seconds times a sample rate lands on a half sample often enough that rounding
 * leaves the second half one sample short, which reads as silence.
 */
const renderSong = async (ctx, song, samples) => {
  const rate = ctx.sampleRate;
  const bpm = Math.round(661500 / song.rowLen);
  const rowLen = rowAt(bpm, rate);
  const out = ctx.createBuffer(2, samples, rate);
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  // A scratch pair per track, because the echo has to run over that track alone
  // before it joins the mix — every channel has its own delay time and feedback,
  // and one shared buffer would smear all of them together.
  const tl = new Float32Array(samples);
  const tr = new Float32Array(samples);
  for (const inst of song.songData) {
    tl.fill(0);
    tr.fill(0);
    for (let row = 0; row * rowLen < samples; row++) {
      // Which pattern is playing, and which note of it. A zero in either place
      // is a rest, and the two zeros mean different things: no pattern in this
      // slot at all, or a pattern with nothing on this row.
      const pat = inst.p[Math.floor(row / 32) % (song.endPattern + 1)] || 0;
      const n = pat ? (inst.c[pat - 1] || { n: [] }).n[row % 32] || 0 : 0;
      if (n) voice(inst, n, tl, tr, row * rowLen, rowLen, rate);
      // A breath every sixteen rows, and the only reason this function is async.
      // Half a minute of stereo across four voices is about a second of
      // arithmetic, and a second in one go is a frozen title screen. sonantx got
      // this for free by rendering on the audio thread; the price of doing it
      // here is having to hand the frame loop back deliberately.
      if (!(row % 16)) await breathe();
    }
    echo(inst, tl, tr, bpm, rate);
    for (let i = 0; i < samples; i++) {
      L[i] += tl[i];
      R[i] += tr[i];
    }
  }
  return out;
};

/**
 * One note of one instrument — a sound effect.
 *
 * +75 because that is the offset sonantx's own `generateSound` applied, and
 * src/soundEffects.js is written in the numbers that produced. It is not
 * meaningful; it is just where two numberings meet.
 *
 * The buffer is the envelope plus room for the echo to die away. sonantx gave
 * every effect a flat four seconds whatever it was, so a click carried nearly
 * four seconds of silence around with it.
 *
 * Synchronous, unlike a song: one note is a millisecond of work.
 */
const renderNote = (ctx, inst, n, bpm = 120) => {
  const rate = ctx.sampleRate;
  const k = rate / 44100;
  const body = Math.ceil((inst.env_attack + inst.env_sustain + inst.env_release) * k);
  const d = Math.round(((inst.fx_delay_time * 7.5) / bpm) * rate);
  const out = ctx.createBuffer(2, body + (inst.fx_delay_amt ? d * 6 : 0), rate);
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  voice(inst, n + 75, L, R, 0, rowAt(bpm, rate), rate);
  echo(inst, L, R, bpm, rate);
  return out;
};
