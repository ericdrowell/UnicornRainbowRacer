// The music repeats every 128 rows. Six passes over the same eight bars is six
// noisy readings of one pattern — so vote. Anything the transcriber only saw
// once was almost certainly never there.
import { readFileSync, writeFileSync } from 'node:fs';
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nm = (m) => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);
const { bass, lead } = JSON.parse(readFileSync('grid2.json', 'utf8'));
const ROWS = 792, CYCLE = 128;
const CYCLES = Math.floor(ROWS / CYCLE);

function vote(g, { need = 0.34 } = {}) {
  const out = new Array(CYCLE).fill(0);
  const conf = new Array(CYCLE).fill(0);
  for (let i = 0; i < CYCLE; i++) {
    const tally = new Map();
    let heard = 0;
    for (let c = 0; c < CYCLES; c++) {
      const cell = g[c * CYCLE + i];
      heard++;
      const k = cell ? cell.midi : 0;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    // A rest wins only if it is the clear majority; otherwise take the best pitch.
    const pitched = [...tally.entries()].filter(([k]) => k !== 0).sort((a,b) => b[1]-a[1]);
    const rest = tally.get(0) || 0;
    if (!pitched.length) continue;
    const [best, n] = pitched[0];
    if (n / heard >= need && n >= rest * 0.6) { out[i] = best; conf[i] = n / heard; }
  }
  return { out, conf };
}
const B = vote(bass, { need: 0.34 });
const L = vote(lead, { need: 0.34 });

const page = (label, v) => {
  console.log('\n' + label + ' — the 8-bar loop:');
  for (let bar = 0; bar < 8; bar++) {
    let line = '  bar ' + (bar+1) + ' |';
    for (let i = bar*16; i < bar*16+16; i++) line += (v.out[i] ? nm(v.out[i]).padEnd(4) : ' .  ');
    console.log(line);
  }
  const n = v.out.filter(Boolean).length;
  const avgConf = v.conf.filter(Boolean).reduce((a,b)=>a+b,0) / Math.max(1,n);
  console.log('  ' + n + ' of 128 rows, mean agreement across the six passes ' + (avgConf*100).toFixed(0) + '%');
};
page('BASS', B);
page('LEAD', L);
writeFileSync('loop.json', JSON.stringify({ bass: B.out, lead: L.out, cycle: CYCLE }));
