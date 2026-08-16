// Basic Pitch gives notes in seconds. Snap them to the 16th-note grid, resolve
// each voice to something monophonic, and look at the result as a tracker page.
import { readFileSync, writeFileSync } from 'node:fs';
const BPM = 135, PHASE = 0.013, ROW = 60 / BPM / 4;
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nm = (m) => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);
const bp = JSON.parse(readFileSync('bp-notes.json', 'utf8'));
const ROWS = 792;

// How well do the model's onsets agree with my grid? If this is poor the tempo
// is wrong and everything downstream inherits it.
for (const stem of ['bass','other']) {
  let err = 0, n = 0;
  for (const [t] of bp[stem]) { const k = (t - PHASE) / ROW; err += Math.abs(k - Math.round(k)); n++; }
  console.log(stem + ': mean onset offset from the grid ' + (err/n).toFixed(3) + ' of a 16th  (0.25 = random)');
}

/** Snap to rows, then keep one note per row per voice. */
function grid(notes, pick) {
  const rows = new Array(ROWS).fill(null);
  for (const [t0, t1, midi, amp] of notes) {
    const r = Math.round((t0 - PHASE) / ROW);
    if (r < 0 || r >= ROWS) continue;
    const len = Math.max(1, Math.round((t1 - t0) / ROW));
    const cand = { midi, amp, len };
    if (!rows[r] || pick(cand, rows[r])) rows[r] = cand;
  }
  return rows;
}
const bass = grid(bp.bass, (a, b) => a.midi < b.midi);          // lowest wins
const lead = grid(bp.other, (a, b) => a.midi > b.midi);          // highest wins
const inner = grid(bp.other, (a, b) => a.amp > b.amp);           // loudest wins

const page = (label, g, from, to) => {
  console.log('\n' + label + '  rows ' + from + '-' + to + ':');
  let line = '';
  for (let r = from; r < to; r++) {
    if ((r - 9) % 16 === 0) line += '|';
    line += (g[r] ? nm(g[r].midi).padEnd(4) : ' .  ');
    if ((r - 9) % 16 === 15) { console.log('   ' + line); line = ''; }
  }
  if (line) console.log('   ' + line);
};
page('BASS ', bass, 9, 73);
page('LEAD (top of `other`)', lead, 9, 73);
page('INNER (loudest of `other`)', inner, 9, 73);
writeFileSync('grid.json', JSON.stringify({ bass, lead, inner }));
const count = (g) => g.filter(Boolean).length;
console.log('\nfilled rows: bass ' + count(bass) + '  lead ' + count(lead) + '  inner ' + count(inner) + '  of ' + ROWS);
