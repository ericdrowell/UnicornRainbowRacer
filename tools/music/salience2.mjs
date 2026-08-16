// Salience, with the option to erase a voice already accounted for.
//
// The melody sits above the bass, and the bass's own harmonics reach right up
// into that register — often louder than the tune. Tracking the top line
// without removing them finds the bass's fifth and octave and holds them for
// bars, which reads as a drone rather than a melody. Erasing the comb first is
// what lets the actual top line show.
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function saliencePerRow(sep, { rowSec, phase, lo = 28, hi = 96, harmonics = 8, suppress = null, suppressHarmonics = 14 }) {
  const { H, rate, size, hop, F } = sep;
  const rows = Math.floor((sep.x.length / rate - phase) / rowSec);
  const nBins = H[0].length;
  // Copy so suppression does not damage the shared spectrogram.
  const W = [];
  for (let f = 0; f < F; f++) W.push(Float64Array.from(H[f]));
  if (suppress) {
    for (let r = 0; r < rows; r++) {
      const m = suppress[r];
      if (!m) continue;
      const t0 = phase + r * rowSec, t1 = t0 + rowSec;
      const f0 = Math.max(0, Math.round(t0 * rate / hop)), f1 = Math.min(F - 1, Math.round(t1 * rate / hop));
      const base = midiHz(m);
      for (let f = f0; f <= f1; f++) {
        for (let h = 1; h <= suppressHarmonics; h++) {
          const b = base * h * size / rate;
          if (b >= nBins - 1) break;
          for (let i = Math.max(0, Math.round(b) - 2); i <= Math.min(nBins - 1, Math.round(b) + 2); i++) W[f][i] = 0;
        }
      }
    }
  }
  const at = (spec, f) => { const b = f * size / rate, i = Math.floor(b);
    if (i < 1 || i + 1 >= spec.length) return 0; return spec[i] + (spec[i+1]-spec[i]) * (b - i); };
  const S = [];
  for (let r = 0; r < rows; r++) {
    const t0 = phase + r * rowSec, t1 = t0 + rowSec;
    const f0 = Math.max(0, Math.round(t0*rate/hop)), f1 = Math.min(F-1, Math.round(t1*rate/hop));
    const row = new Float64Array(hi - lo + 1);
    let n = 0;
    for (let f = f0; f <= f1; f++) {
      n++;
      for (let m = lo; m <= hi; m++) {
        const base = midiHz(m);
        let v = 0;
        for (let h = 1; h <= harmonics; h++) { const fh = base*h; if (fh > rate/2) break; v += at(W[f], fh) / Math.sqrt(h); }
        row[m-lo] += v * (0.35 + 0.65 * Math.min(1, at(W[f], base) / (v/harmonics + 1e-9)));
      }
    }
    for (let i = 0; i < row.length; i++) row[i] /= Math.max(1, n);
    S.push(row);
  }
  return { S, rows, lo, hi };
}
