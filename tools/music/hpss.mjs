// Harmonic/percussive separation. Drums are broadband and brief: they look like
// a vertical stripe in a spectrogram. Notes are narrow and sustained: horizontal
// stripes. Median-filtering along time keeps what persists (harmonic), along
// frequency keeps what is broadband (percussive). Separating them first is the
// single biggest thing that was missing — the pitch estimator was being fed
// cymbals and reading them as notes.
import { readWav, stft } from './dsp.mjs';

const medianOf = (arr) => { const a = Float64Array.from(arr).sort(); const n = a.length; return n % 2 ? a[(n-1)>>1] : (a[n/2-1]+a[n/2])/2; };

export function separate(path, { size = 4096, hop = 612, bins = 460, kt = 17, kf = 17 } = {}) {
  const { x, rate } = readWav(path);
  const frames = stft(x, size, hop);
  const F = frames.length;
  const H = [], P = [];
  for (let f = 0; f < F; f++) { H.push(new Float64Array(bins)); P.push(new Float64Array(bins)); }
  const half = kt >> 1, halfF = kf >> 1;
  const buf = new Float64Array(kt), bufF = new Float64Array(kf);
  for (let k = 0; k < bins; k++) {
    for (let f = 0; f < F; f++) {
      for (let i = 0; i < kt; i++) { const j = Math.min(F-1, Math.max(0, f - half + i)); buf[i] = frames[j][k]; }
      H[f][k] = medianOf(buf);
    }
  }
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < bins; k++) {
      for (let i = 0; i < kf; i++) { const j = Math.min(bins-1, Math.max(0, k - halfF + i)); bufF[i] = frames[f][j]; }
      P[f][k] = medianOf(bufF);
    }
  }
  // Soft masks, so energy is shared rather than double counted.
  for (let f = 0; f < F; f++) for (let k = 0; k < bins; k++) {
    const h = H[f][k], p = P[f][k], t = h + p + 1e-12;
    const m = frames[f][k];
    H[f][k] = m * (h / t);
    P[f][k] = m * (p / t);
  }
  return { H, P, frames, rate, size, hop, F, bins, x };
}
