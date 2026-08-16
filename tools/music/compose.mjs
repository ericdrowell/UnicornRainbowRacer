import { writeFileSync, readFileSync } from 'node:fs';
import { separate } from './hpss.mjs';
import { saliencePerRow } from './salience.mjs';
import { saliencePerRow as salienceMinus } from './salience2.mjs';
import { viterbi, segment } from './track.mjs';
import { onsetRows, strike, patternise, ROW, PHASE, BAR, ROW_LEN, SONANT, name } from './layer.mjs';
import { REF } from './refinstruments.mjs';
import { renderSong, writeWav } from './render.mjs';
const SP = new URL('.', import.meta.url).pathname;
const WAV = SP + 'audio/mono.wav';

console.log('separating harmonic from percussive...');
const sep = separate(WAV);
const rows = Math.floor((sep.x.length / sep.rate - PHASE) / ROW);
const PATTERNS = Math.ceil(rows / 32);
const mk = (rowsArr, instr) => ({ ...instr, ...patternise(rowsArr, PATTERNS) });
const song = (channels) => ({ songLen: Math.ceil(PATTERNS*32*ROW_LEN/44100), rowLen: ROW_LEN, endPattern: PATTERNS-1, songData: channels });

// ── 1. Harmony: the chord root, one sustained note per chord ────────────────
const bassSal = saliencePerRow(sep, { rowSec: ROW, phase: PHASE, lo: 28, hi: 55 });
const bassPath = viterbi(bassSal.S, bassSal, { switchCost: 3.0, leapCost: 0.2, restCost: 1.6 });
const byClass = new Map();
for (const m of bassPath) if (m) byClass.set(m % 12, (byClass.get(m % 12) || []).concat(m));
const octave = new Map();
for (const [k, list] of byClass) {
  const c = {}; for (const m of list) c[m] = (c[m] || 0) + 1;
  octave.set(k, +Object.entries(c).sort((a,b)=>b[1]-a[1])[0][0]);
}
const roots = bassPath.map((m) => (m ? octave.get(m % 12) : 0));
const chords = segment(roots, { minRows: 4 });
// The drone patch has a 90ms attack and a 2.3s release: it wants one long note
// per chord, which is exactly how the original used it. Striking it per beat
// would just smear.
const droneRows = new Array(rows).fill(0);
for (const c of chords) droneRows[c.row] = c.midi + SONANT;

// ── 2. The bass part proper: the root an octave up, struck to the rhythm ────
// The arp patch is a square pair through a highpass at 982Hz, so it has no
// bottom end to speak of — put the true root on it and the fundamental
// disappears. An octave up is where it speaks, and it doubles the drone rather
// than fighting it.
const bassOn = onsetRows(WAV, 55, 320);
const arpPitch = roots.map((m) => (m ? m + 12 : 0));
const arpRows = strike(arpPitch, bassOn.onset, bassOn.mean, { mult: 1.15, minGap: 2 });

// ── 3. Drums, from the percussive component only ────────────────────────────
const { P, rate, hop, F, bins, size } = sep;
const binOf = (hz) => Math.round(hz / (rate/2) * (size/2));
const bandFlux = (lo, hi) => {
  const b0 = Math.min(bins-1, binOf(lo)), b1 = Math.min(bins, binOf(hi));
  const e = []; for (let f = 0; f < F; f++) { let s = 0; for (let k = b0; k < b1; k++) s += P[f][k]; e.push(s); }
  const fl = new Float64Array(F); for (let i = 1; i < F; i++) fl[i] = Math.max(0, e[i]-e[i-1]);
  return fl;
};
const perRow = (fl) => { const o = new Float64Array(rows);
  for (let r = 0; r < rows; r++) { const c = (PHASE + r*ROW)*rate/hop; let p = 0;
    for (let i = Math.max(0,Math.floor(c)-1); i <= Math.min(F-1,Math.ceil(c)+2); i++) p = Math.max(p, fl[i]); o[r] = p; }
  return o; };
function figure(E, keep, minPer) {
  const acc = new Float64Array(16), cnt = new Float64Array(16);
  for (let r = 0; r < rows; r++) { const p = ((r-BAR)%16+16)%16; acc[p] += E[r]; cnt[p]++; }
  const avg = Array.from(acc, (v,i) => v/cnt[i]); const mx = Math.max(...avg);
  const allowed = avg.map((v) => v/mx >= keep);
  let mean = 0; for (const v of E) mean += v; mean /= rows;
  const out = new Array(rows).fill(0);
  for (let r = 0; r < rows; r++) { const p = ((r-BAR)%16+16)%16; if (allowed[p] && E[r] > mean*minPer) out[r] = 147; }
  return { out, allowed };
}
const kick = figure(perRow(bandFlux(30,130)), 0.55, 0.5);
const snare = figure(perRow(bandFlux(200,2400)), 0.62, 0.5);
const hatRows = new Array(rows).fill(0);
for (let r = 0; r < rows; r++) if (((r-BAR)%16+16)%16 % 2 === 0) hatRows[r] = 147;

// ── 4. Melody ───────────────────────────────────────────────────────────────
// With the chord's harmonic comb erased first — the bass reaches into this
// register loudly enough that tracking it raw finds the root's own fifth and
// octave and holds them for bars, which is a drone, not a tune.
const leadSal = salienceMinus(sep, { rowSec: ROW, phase: PHASE, lo: 74, hi: 95, suppress: roots });
const leadPath = viterbi(leadSal.S, leadSal, { switchCost: 1.2, leapCost: 0.1, restCost: 1.4 });
const leadNotes = segment(leadPath, { minRows: 2 });
const leadClean = new Array(rows).fill(0);
for (const n of leadNotes) for (let i = 0; i < n.len; i++) leadClean[n.row + i] = n.midi;
const leadOn = onsetRows(WAV, 500, 4000);
const leadRows = strike(leadClean, leadOn.onset, leadOn.mean, { mult: 1.6, minGap: 2 });

// ── Report + render each layer ──────────────────────────────────────────────
const stat = (label, arr, seg) => {
  const n = arr.filter(Boolean).length;
  console.log('  ' + label.padEnd(8) + String(n).padStart(4) + ' notes = ' + (n/88).toFixed(2) + '/sec' +
    (seg ? '   median length ' + seg.map(s=>s.len).sort((a,b)=>a-b)[Math.floor(seg.length/2)] + ' rows, ' + new Set(seg.map(s=>s.midi)).size + ' pitches' : ''));
};
console.log('\nLAYERS');
stat('drone', droneRows, chords);
stat('arp', arpRows);
stat('kick', kick.out); stat('snare', snare.out); stat('hat', hatRows);
stat('lead', leadRows, leadNotes);
console.log('  lead pitches: ' + [...new Set(leadNotes.map(n=>n.midi))].sort((a,b)=>a-b).map(name).join(' '));
console.log('  kick   ' + kick.allowed.map(a=>a?'X':'.').join('') + '\n  snare  ' + snare.allowed.map(a=>a?'X':'.').join(''));

const L1 = song([mk(droneRows, REF.drone), mk(arpRows, REF.arp)]);
const L2 = song([...L1.songData, mk(kick.out, REF.kick), mk(snare.out, REF.snare), mk(hatRows, REF.hat)]);
const L3 = song([...L2.songData, mk(leadRows, REF.lead)]);
/**
 * Trim the master volumes until the mix stops clipping.
 *
 * The reference patches were balanced for their own song and run hot — stacked
 * up here they peak near three, and Sonant clamps rather than compresses, so
 * everything above one comes back as buzz. Measured and scaled rather than
 * guessed at.
 */
function normalise(s, target = 0.82) {
  let { L, R } = renderSong(s, { seconds: 90 });
  let peak = 0; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak <= target) return { song: s, L, R, peak, gain: 1 };
  const gain = target / peak;
  const scaled = { ...s, songData: s.songData.map((c) => ({ ...c, env_master: Math.max(1, Math.round(c.env_master * gain)) })) };
  ({ L, R } = renderSong(scaled, { seconds: 90 }));
  let p2 = 0; for (let i = 0; i < L.length; i++) p2 = Math.max(p2, Math.abs(L[i]), Math.abs(R[i]));
  return { song: scaled, L, R, peak: p2, gain };
}
for (const [file, s] of [['layer1-bass', L1], ['layer2-bass-drums', L2], ['layer3-full', L3]]) {
  const out = normalise(s);
  writeWav(SP + 'audio/' + file + '.wav', out.L, out.R);
  writeFileSync(SP + file + '.json', JSON.stringify(out.song));
  console.log('  ' + file.padEnd(18) + ' peak ' + out.peak.toFixed(2) + '  (master x' + out.gain.toFixed(2) + ')');
}
