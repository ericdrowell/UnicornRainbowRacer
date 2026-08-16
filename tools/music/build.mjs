// Turn the analysed audio into a Sonant-X song.
import { writeFileSync } from 'node:fs';
import { extract } from './voices.mjs';
import { INSTRUMENTS } from './instruments.mjs';
import { noteName } from './transcribe.mjs';

const SP = new URL('.', import.meta.url).pathname;
const BPM = 135;
const ROW_LEN = Math.round(60 * 44100 / 4 / BPM);   // 4900
const SONANT_OFFSET = 75;                            // sonant note = midi + 75

const v = extract(SP + 'audio/mono.wav');
const ROWS = Math.ceil(v.rows / 32) * 32;            // pad to whole patterns
const PATTERNS = ROWS / 32;

/**
 * Turn a per-row pitch track into note *triggers*.
 *
 * A note is only struck when the pitch changes, or when the same pitch has been
 * held long enough to want restating. Retriggering every row turns a held note
 * into a machine gun, which is the single most common way a transcription like
 * this ends up sounding wrong.
 */
function trigger(track, { restate = 8 } = {}) {
  const out = new Array(ROWS).fill(0);
  let cur = 0, held = 0;
  for (let r = 0; r < v.rows; r++) {
    const m = track[r];
    if (!m) { cur = 0; held = 0; continue; }
    if (m !== cur || held >= restate) { out[r] = m + SONANT_OFFSET; cur = m; held = 1; }
    else held++;
  }
  return out;
}

/** Percussion: a hit is a 1, but never two rows running. */
function hits(track, { minGap = 2 } = {}) {
  const out = new Array(ROWS).fill(0);
  let last = -99;
  for (let r = 0; r < v.rows; r++) {
    if (track[r] && r - last >= minGap) { out[r] = 1; last = r; }
  }
  return out;
}

// Drums, as a repeating figure driven by the detected kick, with the snare on
// the backbeat and hats on the eighths — the detector finds the kick reliably
// and mistakes melody for snare, so only the kick is taken from it verbatim.
const kickRows = hits(v.kick, { minGap: 3 });
const snareRows = new Array(ROWS).fill(0);
const hatRows = new Array(ROWS).fill(0);
const BAR = 9;                                       // bar starts at row 9
for (let r = 0; r < v.rows; r++) {
  const p = ((r - BAR) % 16 + 16) % 16;
  if (p === 4 || p === 12) snareRows[r] = 1;
  if (p % 2 === 0) hatRows[r] = 1;
}

const tracks = {
  bass: trigger(v.bass, { restate: 4 }),
  lead: trigger(v.lead, { restate: 6 }),
  harmony: trigger(v.mid, { restate: 8 }),
  kick: kickRows.map((h) => (h ? 128 : 0)),
  snare: snareRows.map((h) => (h ? 128 : 0)),
  hat: hatRows.map((h) => (h ? 128 : 0)),
};

/** Slice a row track into 32-row patterns, sharing identical ones. */
function patternise(rows) {
  const c = [], p = [], seen = new Map();
  for (let i = 0; i < PATTERNS; i++) {
    const n = rows.slice(i * 32, i * 32 + 32);
    if (n.every((x) => x === 0)) { p.push(0); continue; }
    const key = n.join(',');
    if (!seen.has(key)) { c.push({ n }); seen.set(key, c.length); }
    p.push(seen.get(key));
  }
  return { p, c };
}

const songData = Object.entries(tracks).map(([name, rows]) => ({
  ...INSTRUMENTS[name],
  ...patternise(rows),
}));

const song = {
  songLen: Math.ceil(ROWS * ROW_LEN / 44100),
  songData,
  rowLen: ROW_LEN,
  endPattern: PATTERNS - 1,
};
writeFileSync(SP + 'song.json', JSON.stringify(song));
writeFileSync('/Users/ericrowell/workspace/UnicornRainbowRacer/src/song.json', JSON.stringify(song));

console.log('rows ' + v.rows + ' -> ' + ROWS + ' (' + PATTERNS + ' patterns)   rowLen ' + ROW_LEN + '   ' + song.songLen + 's');
for (const [i, [name, rows]] of Object.entries(tracks).entries()) {
  const notes = rows.filter(Boolean).length;
  console.log('  ' + name.padEnd(8) + String(notes).padStart(4) + ' triggers   ' +
    songData[i].c.length + ' distinct patterns');
}
console.log('\njson ' + (JSON.stringify(song).length / 1024).toFixed(1) + ' kB');
