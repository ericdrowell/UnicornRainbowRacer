// Per-row polyphonic pitch estimation: whiten, then iteratively pull out the
// fundamental whose harmonic comb best explains what is left.
import { readWav, spectrum, hann } from './dsp.mjs';
export const BPM = 135, PHASE = 0.013;
export const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const noteName = (m) => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function loadRows(path, size = 4096) {
  const { x, rate } = readWav(path);
  const step = 60 / BPM / 4;
  const rows = Math.floor((x.length / rate - PHASE) / step);
  const win = hann(size);
  const out = [];
  for (let r = 0; r < rows; r++) {
    // Centred a little after the row starts, so an attack is inside the window.
    const c = Math.round((PHASE + r * step + step * 0.45) * rate);
    const mag = spectrum(x, c - size / 2, size, win);
    // Whiten against a smoothed envelope: without it the spectral tilt makes
    // every bass frequency look like a note and nothing above 1 kHz register.
    const env = new Float64Array(mag.length), R = 48;
    let run = 0;
    for (let i = 0; i < Math.min(R, mag.length); i++) run += mag[i];
    for (let i = 0; i < mag.length; i++) {
      const add = i + R < mag.length ? mag[i + R] : 0, sub = i - R >= 0 ? mag[i - R] : 0;
      run += add - sub;
      env[i] = run / (Math.min(mag.length, i + R) - Math.max(0, i - R)) + 1e-9;
    }
    const w = new Float64Array(mag.length);
    for (let i = 0; i < mag.length; i++) w[i] = Math.max(0, mag[i] / env[i] - 1);
    out.push({ mag, w, rate, size });
  }
  return { rowsData: out, rows, step, rate, x };
}

/** Whitened magnitude at an arbitrary frequency, linearly interpolated. */
const at = (f, s) => {
  const b = f * s.size / s.rate;
  const i = Math.floor(b);
  if (i < 1 || i + 1 >= s.w.length) return 0;
  return s.w[i] + (s.w[i + 1] - s.w[i]) * (b - i);
};

/** The notes sounding in one row, strongest first. */
export function pitchesIn(s, { lo = 28, hi = 96, take = 4, harmonics = 6 } = {}) {
  const left = Float64Array.from(s.w);
  const scratch = { ...s, w: left };
  const found = [];
  for (let pass = 0; pass < take; pass++) {
    let best = { m: -1, v: 0 };
    for (let m = lo; m <= hi; m++) {
      const f = midiHz(m);
      let v = 0;
      for (let h = 1; h <= harmonics; h++) {
        if (f * h > s.rate / 2) break;
        v += at(f * h, scratch) / h;
      }
      // An octave above a real note scores well on its own harmonics, so
      // require the fundamental itself to be present too.
      v *= 0.4 + 0.6 * Math.min(1, at(f, scratch) / 2);
      if (v > best.v) best = { m, v };
    }
    if (best.m < 0 || best.v < 1.2) break;
    found.push(best);
    // Subtract this note's comb so the next pass sees what it did not explain.
    const f = midiHz(best.m);
    for (let h = 1; h <= harmonics + 4; h++) {
      const fh = f * h;
      if (fh > s.rate / 2) break;
      const b = fh * s.size / s.rate;
      for (let i = Math.max(0, Math.floor(b) - 2); i <= Math.min(left.length - 1, Math.ceil(b) + 2); i++) left[i] = 0;
    }
  }
  return found;
}
