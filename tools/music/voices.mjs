// Pull the note grid apart into voices, each a monophonic line, with a
// preference for staying near the previous note so a line does not flap
// between octaves when two candidates score similarly.
import { loadRows, pitchesIn, noteName, midiHz, BPM, PHASE } from './transcribe.mjs';
import { readWav, stft } from './dsp.mjs';

export function extract(path) {
  const { rowsData, rows, step, rate, x } = loadRows(path);
  const cand = rowsData.map((s) => pitchesIn(s, { take: 5 }));

  /** One voice: pick within a register, penalised for leaping. */
  function line(lo, hi, { jump = 0.35, floor = 1.4 } = {}) {
    const out = new Array(rows).fill(0);
    let prev = 0;
    for (let r = 0; r < rows; r++) {
      let best = { m: 0, v: 0 };
      for (const c of cand[r]) {
        if (c.m < lo || c.m > hi) continue;
        const leap = prev ? Math.abs(c.m - prev) : 0;
        const v = c.v * Math.exp(-jump * Math.min(leap, 24) / 12);
        if (v > best.v) best = { m: c.m, v: c.v };
      }
      if (best.v >= floor) { out[r] = best.m; prev = best.m; }
    }
    return out;
  }

  // Percussion, from broadband energy rather than pitch.
  const SIZE = 1024, HOP = 256, fps = rate / HOP;
  const frames = stft(x, SIZE, HOP);
  const band = (f, a, b) => { let s = 0; for (let k = a; k < b; k++) s += f[k]; return s; };
  const nyq = rate / 2, bin = (hz) => Math.round(hz / nyq * (SIZE / 2));
  const lowE = [], midE = [], hiE = [];
  for (const f of frames) { lowE.push(band(f, bin(30), bin(120))); midE.push(band(f, bin(150), bin(500))); hiE.push(band(f, bin(4000), bin(10000))); }
  const flux = (arr) => { const o = new Float64Array(arr.length); for (let i = 1; i < arr.length; i++) o[i] = Math.max(0, arr[i] - arr[i-1]); return o; };
  const kf = flux(lowE), sf = flux(midE), hf = flux(hiE);
  const rowHit = (fl, mult) => {
    const mean = fl.reduce((a,b)=>a+b,0) / fl.length;
    const out = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++) {
      const c = Math.round((PHASE + r * step) * fps);
      let peak = 0;
      for (let i = Math.max(0, c - 2); i <= Math.min(fl.length - 1, c + 3); i++) peak = Math.max(peak, fl[i]);
      if (peak > mean * mult) out[r] = 1;
    }
    return out;
  };
  return {
    rows, step,
    bass: line(28, 51, { jump: 0.5 }),
    mid:  line(52, 71),
    lead: line(72, 96, { jump: 0.25 }),
    kick: rowHit(kf, 2.2),
    snare: rowHit(sf, 2.6),
    hat: rowHit(hf, 1.9),
  };
}
