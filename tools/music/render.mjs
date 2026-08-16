// Sonant-X, rendered offline in Node. A faithful port of node_modules/sonantx
// so a song can be listened to and measured without a browser.
import { writeFileSync } from 'node:fs';
const RATE = 44100;
const osc_sin = (v) => Math.sin(v * 6.283184);
const osc_square = (v) => (osc_sin(v) < 0 ? -1 : 1);
const osc_saw = (v) => 2 * (v % 1) - 1;
const osc_tri = (v) => { const x = 4 * (v % 1); return x < 2 ? x - 1 : 3 - x; };
const OSC = [osc_sin, osc_square, osc_saw, osc_tri];
const noteFreq = (n) => 0.00390625 * Math.pow(1.059463094, n - 128);

export function renderSong(song, { seconds } = {}) {
  const rowLen = song.rowLen;
  const bpm = Math.round((60 * 44100 / 4) / rowLen);
  const endPattern = song.endPattern;
  const totalRows = (endPattern + 1) * 32;
  const len = Math.ceil((seconds ?? (totalRows * rowLen / RATE + 2)) * RATE);
  const L = new Float64Array(len), R = new Float64Array(len);

  for (const instr of song.songData) {
    const tl = new Float64Array(len), tr = new Float64Array(len);
    const o1 = OSC[instr.osc1_waveform], o2 = OSC[instr.osc2_waveform], ol = OSC[instr.lfo_waveform];
    const panFreq = Math.pow(2, instr.fx_pan_freq - 8) / rowLen;
    const lfoFreq = Math.pow(2, instr.lfo_freq - 8) / rowLen;
    const q = instr.fx_resonance / 255;
    const eA = instr.env_attack, eS = instr.env_sustain, eR = instr.env_release;

    for (let row = 0; row < totalRows; row++) {
      const pat = instr.p[Math.floor(row / 32) % (endPattern + 1)] || 0;
      const n = pat === 0 ? 0 : ((instr.c[pat - 1] || { n: [] }).n[row % 32] || 0);
      if (!n) continue;
      const start = row * rowLen;
      const o1t = noteFreq(n + (instr.osc1_oct - 8) * 12 + instr.osc1_det) * (1 + 0.0008 * instr.osc1_detune);
      const o2t = noteFreq(n + (instr.osc2_oct - 8) * 12 + instr.osc2_det) * (1 + 0.0008 * instr.osc2_detune);
      let c1 = 0, c2 = 0, low = 0, band = 0;
      for (let j = 0; j < eA + eS + eR; j++) {
        const c = start + j;
        if (c >= len) break;
        const lfor = ol(j * lfoFreq) * instr.lfo_amt / 512 + 0.5;
        let e = 1;
        if (j < eA) e = j / eA; else if (j >= eA + eS) e -= (j - eA - eS) / eR;
        let t = o1t;
        if (instr.lfo_osc1_freq) t += lfor;
        if (instr.osc1_xenv) t *= e * e;
        c1 += t;
        let s = o1(c1) * instr.osc1_vol;
        t = o2t;
        if (instr.osc2_xenv) t *= e * e;
        c2 += t;
        s += o2(c2) * instr.osc2_vol;
        if (instr.noise_fader) s += (2 * Math.random() - 1) * instr.noise_fader * e;
        s *= e / 255;
        let f = instr.fx_freq;
        if (instr.lfo_fx_freq) f *= lfor;
        f = 1.5 * Math.sin(f * Math.PI / RATE);
        low += f * band;
        const high = q * (s - band) - low;
        band += f * high;
        if (instr.fx_filter === 1) s = high;
        else if (instr.fx_filter === 2) s = low;
        else if (instr.fx_filter === 3) s = band;
        else if (instr.fx_filter === 4) s = low + high;
        const p = osc_sin(j * panFreq) * instr.fx_pan_amt / 512 + 0.5;
        s *= 39 * instr.env_master;
        tl[c] += s * (1 - p) / 32768 * 4;
        tr[c] += s * p / 32768 * 4;
      }
    }
    // Feedback delay, per track, as the runtime wires it.
    const dT = Math.round(instr.fx_delay_time * ((1 / (bpm / 60)) / 8) * RATE);
    const dA = instr.fx_delay_amt / 255;
    if (dT > 0 && dA > 0) {
      for (let i = dT; i < len; i++) { tl[i] += tl[i - dT] * dA; tr[i] += tr[i - dT] * dA; }
    }
    for (let i = 0; i < len; i++) { L[i] += tl[i]; R[i] += tr[i]; }
  }
  return { L, R };
}

export function writeWav(path, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const clip = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) { buf.writeInt16LE(clip(L[i]), 44 + i * 4); buf.writeInt16LE(clip(R[i]), 46 + i * 4); }
  writeFileSync(path, buf);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  return { peak };
}
