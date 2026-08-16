// Small DSP kit: WAV reading, FFT, STFT magnitudes.
import { readFileSync } from 'node:fs';

export function readWav(path) {
  const b = readFileSync(path);
  let off = 12, rate = 22050;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') {
      const n = sz / 2, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return { x, rate };
    }
    off += 8 + sz;
  }
  throw new Error('no data chunk');
}

/** In-place iterative radix-2 FFT. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

/** Magnitude spectrum of one window. */
export function spectrum(x, start, size, win) {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) { const s = start + i; re[i] = (s >= 0 && s < x.length ? x[s] : 0) * win[i]; }
  fft(re, im);
  const half = size >> 1, mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

export function stft(x, size, hop) {
  const win = hann(size), frames = [];
  for (let s = 0; s + size <= x.length; s += hop) frames.push(spectrum(x, s, size, win));
  return frames;
}
export { hann };
