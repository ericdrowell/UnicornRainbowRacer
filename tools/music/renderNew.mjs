import { readFileSync } from 'node:fs';
import { renderSong, writeWav } from './render.mjs';
const SP = new URL('.', import.meta.url).pathname;
const song = JSON.parse(readFileSync(SP + 'song.json', 'utf8'));
const t0 = Date.now();
const { L, R } = renderSong(song, { seconds: 90 });
// Normalise to a sensible level rather than letting it clip.
let peak = 0; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
console.log('raw peak ' + peak.toFixed(2) + (peak > 1 ? '  (would clip in the browser)' : ''));
const r = writeWav(SP + 'audio/cover.wav', L, R);
let rms = 0; for (const x of L) rms += x * x;
console.log('rendered in ' + ((Date.now()-t0)/1000).toFixed(1) + 's: ' + (L.length/44100).toFixed(1) + 's, rms ' + Math.sqrt(rms/L.length).toFixed(4));
