// Build the Sonant song from the voted 8-bar loop plus the drum figure.
import { readFileSync, writeFileSync } from 'node:fs';
import { REF } from './refinstruments.mjs';
import { renderSong, writeWav } from './render.mjs';
const SP = new URL('.', import.meta.url).pathname;
const BPM = 135, ROW_LEN = Math.round(60*44100/4/BPM), SONANT = 75;
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nm=(m)=>NAMES[((m%12)+12)%12]+(Math.floor(m/12)-1);
const loop = JSON.parse(readFileSync('loop.json','utf8'));      // 128 rows
const dr = JSON.parse(readFileSync('drumloop.json','utf8'));    // 32 rows

// Four 32-row patterns of notes, one of drums, played round and round. The
// whole song is the loop repeated — which is what a chiptune is, and what the
// reference song does with ten patterns for thirty-seven seconds.
const REPEATS = 6;                                   // 6 x 8 bars = 45s
const PATTERNS = 4 * REPEATS;
const rows = (src, cycle, map) => {
  const out = [];
  for (let i = 0; i < PATTERNS * 32; i++) out.push(map(src[i % cycle]));
  return out;
};
const bassRows  = rows(loop.bass, 128, (m) => (m ? m + SONANT : 0));
const leadRows  = rows(loop.lead, 128, (m) => (m ? m + SONANT : 0));
// A sustained root under it all: the first bass note of each 2-bar block.
const droneRows = new Array(PATTERNS*32).fill(0);
for (let b = 0; b < PATTERNS; b++) {
  for (let i = 0; i < 32; i++) {
    const m = loop.bass[(b*32 + i) % 128];
    if (m) { droneRows[b*32] = m - 12 + SONANT; break; }
  }
}
const kickRows  = rows(dr.kick, 32, (h) => (h ? 147 : 0));
const snareRows = rows(dr.snare, 32, (h) => (h ? 147 : 0));
const hatRows   = rows(dr.hat, 32, (h) => (h ? 147 : 0));

function patternise(r) {
  const c = [], p = [], seen = new Map();
  for (let i = 0; i < PATTERNS; i++) {
    const n = r.slice(i*32, i*32+32);
    if (n.every((v) => !v)) { p.push(0); continue; }
    const k = n.join(',');
    if (!seen.has(k)) { c.push({ n }); seen.set(k, c.length); }
    p.push(seen.get(k));
  }
  return { p, c };
}
const mk = (r, ins) => ({ ...ins, ...patternise(r) });
const channels = [
  mk(droneRows, REF.drone),
  mk(bassRows,  REF.arp),
  mk(leadRows,  REF.lead),
  mk(kickRows,  REF.kick),
  mk(snareRows, REF.snare),
  mk(hatRows,   REF.hat),
];
let song = { songLen: Math.ceil(PATTERNS*32*ROW_LEN/44100), rowLen: ROW_LEN, endPattern: PATTERNS-1, songData: channels };

// Trim the masters until it stops clipping — Sonant clamps rather than limits.
const peakOf = (s) => { const { L, R } = renderSong(s, { seconds: s.songLen + 2 });
  let p = 0; for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return { p, L, R }; };
let { p } = peakOf(song);
if (p > 0.82) {
  const g = 0.82 / p;
  song = { ...song, songData: song.songData.map((c) => ({ ...c, env_master: Math.max(1, Math.round(c.env_master*g)) })) };
}
const out = peakOf(song);
writeWav(SP + 'audio/v2-full.wav', out.L, out.R);
writeFileSync(SP + 'v2-song.json', JSON.stringify(song));

console.log('8-bar loop x' + REPEATS + ' = ' + song.songLen + 's, ' + PATTERNS + ' pattern slots');
const label = ['drone','bass','lead','kick','snare','hat'];
song.songData.forEach((c, i) => {
  const n = c.c.flatMap(x => x.n).filter(Boolean).length;
  console.log('  ' + label[i].padEnd(6) + c.c.length + ' distinct pattern' + (c.c.length===1?' ':'s') + '  ' + String(n).padStart(3) + ' notes stored');
});
console.log('  peak ' + out.p.toFixed(2) + '   json ' + (JSON.stringify(song).length/1024).toFixed(1) + ' kB');
console.log('\nbass loop : ' + [...new Set(loop.bass.filter(Boolean))].map(nm).join(' '));
console.log('lead loop : ' + [...new Set(loop.lead.filter(Boolean))].map(nm).join(' '));
