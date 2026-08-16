import { readFileSync, writeFileSync } from 'node:fs';
const BPM = 135, PHASE = 0.0332, ROW = 60 / BPM / 4, ROWS = 792;
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nm = (m) => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);
const bp = JSON.parse(readFileSync('bp-notes.json', 'utf8'));

function grid(notes, pick) {
  const rows = new Array(ROWS).fill(null);
  for (const [t0, t1, midi, amp] of notes) {
    const r = Math.round((t0 - PHASE) / ROW);
    if (r < 0 || r >= ROWS) continue;
    const cand = { midi, amp, len: Math.max(1, Math.round((t1 - t0) / ROW)) };
    if (!rows[r] || pick(cand, rows[r])) rows[r] = cand;
  }
  return rows;
}
const bass = grid(bp.bass, (a,b) => a.midi < b.midi);
const lead = grid(bp.other, (a,b) => a.midi > b.midi);

/**
 * Where does the music repeat?
 *
 * A chiptune is a few short patterns played over and over. Finding that period
 * is what turns 792 rows of transcription into a song — and it is the thing
 * that was missing before, when every bar was treated as unique and the result
 * could only ever wander.
 */
function period(g) {
  const key = (r) => (g[r] ? g[r].midi : 0);
  const scores = [];
  for (let p = 8; p <= 256; p += 8) {
    let same = 0, n = 0;
    for (let r = 0; r + p < ROWS; r++) { if (key(r) === key(r + p)) same++; n++; }
    scores.push({ p, agree: same / n });
  }
  return scores.sort((a,b) => b.agree - a.agree).slice(0, 6);
}
console.log('BASS  repeat period (rows, agreement):');
for (const s of period(bass)) console.log('   ' + String(s.p).padStart(4) + ' rows = ' + (s.p/16).toFixed(1) + ' bars   ' + (s.agree*100).toFixed(1) + '%');
console.log('LEAD  repeat period:');
for (const s of period(lead)) console.log('   ' + String(s.p).padStart(4) + ' rows = ' + (s.p/16).toFixed(1) + ' bars   ' + (s.agree*100).toFixed(1) + '%');

// Where does each section start and end? Compare each 32-row block to every other.
const blocks = [];
for (let b = 0; b * 32 < ROWS; b++) {
  const sig = [];
  for (let r = b*32; r < (b+1)*32; r++) sig.push((bass[r]?bass[r].midi:0) + ':' + (lead[r]?lead[r].midi:0));
  blocks.push(sig.join(','));
}
const labels = []; const seen = new Map();
for (const s of blocks) { if (!seen.has(s)) seen.set(s, String.fromCharCode(65 + seen.size)); labels.push(seen.get(s)); }
console.log('\nblock map (each letter = one 32-row pattern, 2 bars):');
console.log('   ' + labels.join(' '));
console.log('   ' + seen.size + ' distinct blocks out of ' + blocks.length);
writeFileSync('grid2.json', JSON.stringify({ bass, lead }));
