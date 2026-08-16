// Does the cover play the same notes as the original, row by row?
import { loadRows, pitchesIn, noteName } from './transcribe.mjs';
const SP = new URL('.', import.meta.url).pathname;
const A = loadRows(SP + 'audio/mono.wav');
const B = loadRows(SP + 'audio/cover_mono.wav');
const rows = Math.min(A.rows, B.rows);
let pcHit = 0, octHit = 0, both = 0;
const conf = new Map();
for (let r = 0; r < rows; r++) {
  const a = pitchesIn(A.rowsData[r], { take: 3 }).map(p => p.m);
  const b = pitchesIn(B.rowsData[r], { take: 3 }).map(p => p.m);
  if (!a.length || !b.length) continue;
  both++;
  if (b.some(m => a.some(n => ((m - n) % 12 + 12) % 12 === 0))) octHit++;   // same note class
  if (b.some(m => a.includes(m))) pcHit++;                                   // same exact note
}
console.log('rows where both have pitch: ' + both);
console.log('  exact note match      ' + (100*pcHit/both).toFixed(1) + '%');
console.log('  same pitch class      ' + (100*octHit/both).toFixed(1) + '%   (octave-tolerant)');
