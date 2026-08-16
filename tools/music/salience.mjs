// Pitch salience per row, from the harmonic spectrogram only.
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function saliencePerRow(sep, { rowSec, phase, lo = 28, hi = 96, harmonics = 8 }) {
  const { H, rate, size, hop, F } = sep;
  const rows = Math.floor((sep.x.length / rate - phase) / rowSec);
  const at = (spec, f) => {
    const b = f * size / rate;
    const i = Math.floor(b);
    if (i < 1 || i + 1 >= spec.length) return 0;
    return spec[i] + (spec[i+1] - spec[i]) * (b - i);
  };
  const S = [];
  for (let r = 0; r < rows; r++) {
    const t0 = phase + r * rowSec, t1 = t0 + rowSec;
    const f0 = Math.max(0, Math.round(t0 * rate / hop)), f1 = Math.min(F - 1, Math.round(t1 * rate / hop));
    const row = new Float64Array(hi - lo + 1);
    let frames = 0;
    for (let f = f0; f <= f1; f++) {
      frames++;
      for (let m = lo; m <= hi; m++) {
        const base = midiHz(m);
        let v = 0;
        for (let h = 1; h <= harmonics; h++) {
          const fh = base * h;
          if (fh > rate / 2) break;
          v += at(H[f], fh) / Math.sqrt(h);
        }
        // Require the fundamental itself, or every note's octave scores as well
        // as the note and the line jumps between them.
        row[m - lo] += v * (0.35 + 0.65 * Math.min(1, at(H[f], base) / (v / harmonics + 1e-9)));
      }
    }
    for (let i = 0; i < row.length; i++) row[i] /= Math.max(1, frames);
    S.push(row);
  }
  return { S, rows, lo, hi };
}
