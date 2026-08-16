// Shared: turn tracked pitches + detected onsets into Sonant note rows.
import { readWav, stft } from './dsp.mjs';
export const BPM = 135, PHASE = 0.013, ROW = 60 / BPM / 4, BAR = 9;
export const ROW_LEN = Math.round(60 * 44100 / 4 / BPM);
export const SONANT = 75;
export const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const name = (m) => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);

/** Onset strength per row within a frequency band. */
export function onsetRows(path, loHz, hiHz) {
  const { x, rate } = readWav(path);
  const SIZE = 1024, HOP = 128, fps = rate / HOP;
  const frames = stft(x, SIZE, HOP);
  const nyq = rate / 2, bin = (h) => Math.round(h / nyq * (SIZE / 2));
  const e = frames.map((f) => { let s = 0; for (let k = bin(loHz); k < bin(hiHz); k++) s += f[k]; return s; });
  const fl = new Float64Array(e.length);
  for (let i = 1; i < e.length; i++) fl[i] = Math.max(0, e[i] - e[i-1]);
  const rows = Math.floor((x.length / rate - PHASE) / ROW);
  const out = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const c = (PHASE + r * ROW) * fps;
    let p = 0;
    for (let i = Math.max(0, Math.floor(c) - 2); i <= Math.min(fl.length - 1, Math.ceil(c) + 3); i++) p = Math.max(p, fl[i]);
    out[r] = p;
  }
  let mean = 0; for (const v of out) mean += v; mean /= rows;
  return { onset: out, mean, rows };
}

/**
 * Pitch says *what*, onsets say *when*.
 *
 * The tracked line holds a pitch for bars at a time, which is right — it is the
 * harmony. Striking it only where the audio actually re-attacks is what turns a
 * held root into a bass part instead of a drone, and it is the half that was
 * missing when every row got its own note.
 */
export function strike(pitchPerRow, onset, mean, { mult = 1.0, minGap = 2, alsoOnChange = true } = {}) {
  const rows = pitchPerRow.length;
  const out = new Array(rows).fill(0);
  let last = -99;
  for (let r = 0; r < rows; r++) {
    const m = pitchPerRow[r];
    if (!m) continue;
    const changed = alsoOnChange && m !== pitchPerRow[r - 1];
    if ((changed || onset[r] > mean * mult) && r - last >= minGap) { out[r] = m + SONANT; last = r; }
  }
  return out;
}

/** Rows -> 32-row patterns, sharing repeats. */
export function patternise(rows, patterns) {
  const c = [], p = [], seen = new Map();
  for (let i = 0; i < patterns; i++) {
    const n = rows.slice(i * 32, i * 32 + 32);
    while (n.length < 32) n.push(0);
    if (n.every((v) => v === 0)) { p.push(0); continue; }
    const key = n.join(',');
    if (!seen.has(key)) { c.push({ n }); seen.set(key, c.length); }
    p.push(seen.get(key));
  }
  return { p, c };
}
