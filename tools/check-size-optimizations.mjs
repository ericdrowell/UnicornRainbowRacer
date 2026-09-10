// Run with: node tools/check-size-optimizations.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(resolve(root, ...parts), 'utf8');
const build = read('build.mjs');
const songCode = build.slice(build.indexOf('const SYNTH ='), build.indexOf('// The inspector is appended'));
const specialization = build.slice(build.indexOf('const instrumentData ='), build.indexOf('// Inline literals'));
const { instrumentData, synth } = runInNewContext(`${songCode}\n${specialization}\n({instrumentData,synth})`, { read, runInNewContext });

const audioContext = {
  sampleRate: 8000,
  createBuffer(channels, count) {
    const data = Array.from({ length: channels }, () => new Float32Array(count));
    return { data, getChannelData: i => data[i] };
  },
};
function render(source, instrument, note) {
  let seed = 123;
  const math = Object.create(Math);
  math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const renderNote = runInNewContext(`${source};renderNote`, { Math: math });
  return renderNote(audioContext, instrument, note).data;
}
let samples = 0;
for (const instrument of instrumentData) {
  for (const note of [47, 60, 89]) {
    const before = render(read('lib', 'sonantx-custom.js'), instrument, note);
    const after = render(synth, instrument, note);
    assert.deepEqual(after, before, 'Specialization changed audio samples');
    samples += before.reduce((sum, channel) => sum + channel.length, 0);
  }
}
console.log(`${samples} audio samples match exactly across all shipped instruments and three notes.`);

const helper = build.slice(build.indexOf('function compactShader('), build.indexOf('// Keep only glyphs'));
const compact = runInNewContext(`${helper};compactShader`);
const immutable = compact('fn f(p : f32) {\n let a = sin(p);\n return a;\n}');
assert(!immutable.includes('let a'));
assert(immutable.includes('return (sin(p))'));
for (const expression of ['state[0]', 'textureSample(t, s, uv)', 'sin(x)']) {
  const source = `fn f() {\n var x = 1.0;\n let a = ${expression};\n x = 2.0;\n return a;\n}`;
  assert(compact(source).includes(`let a = ${expression}`), 'Mutable or texture read was moved');
}
const swizzle = compact('fn f(p : vec2f) {\n let x = 2.0;\n return p.x + x;\n}');
assert(swizzle.includes('p.x + 2.0'));
const shadowed = 'fn f(x : f32) {\n if (x > 0.0) {let x = 2.0;}\n return x;\n}';
assert(compact(shadowed).includes('let x = 2.0'));
console.log('Shader substitution guards preserve mutable reads, texture calls, swizzles and shadowed names.');

const game = read('src', 'game.js');
const mapSource = game.slice(game.indexOf('  const drawMap ='), game.indexOf('  const CAPTIONS ='));
const { courses, racers } = runInNewContext([
  read('src', 'circuits.js'), read('src', 'unicorns.js'),
  '({courses:CIRCUITS.map(circuit),racers:UNICORNS})',
].join('\n'));
for (const course of courses) {
  const calls = [];
  const ctx = new Proxy({globalAlpha: 1, canvas: {}}, { get: (target, key) => target[key] ?? ((...args) => calls.push(key === 'stroke' ? [key, target.lineWidth, target.strokeStyle, target.globalAlpha] : key === 'drawImage' ? [key, ...args, target.globalAlpha] : [key, ...args])) });
  const dx = course[1][0] - course.at(-1)[0], dz = course[1][2] - course.at(-1)[2];
  const length = Math.hypot(dx, dz);
  const TRACK_DATA = [0, 0, 0, 0, dx / length, 0, dz / length];
  const mapRacers = new Float32Array(10 * 28);
  for (let i = 0; i < 10; i++) mapRacers.set(course[i], i * 28);
  const drawMap = runInNewContext(`${mapSource};drawMap`, {
    TRACK_DATA, TAU: Math.PI * 2, mapContext: ctx, trackContext: ctx, trackCanvas: {}, MAP_X: .8, MAP_Y: -.25, MAP_DOTS: 512,
    mapScale: .14 / Math.max(...course.flat().map(Math.abs)),
    RINGS: course.length, ring: i => course[(i + course.length) % course.length],
    FIELD: 10, RACER_SLOTS: 7, RACERS: racers, mapRacers,
  });
  drawMap();
  const strokes = calls.filter(c => c[0] === 'stroke');
  assert.equal(strokes.length, 3, 'Only the track and gate are stroked');
  assert.deepEqual(strokes[2], ['stroke', 6, '#ff9ead', 1]);
  assert.deepEqual(strokes[0], ['stroke', 10, '#555', 1]);
  assert.deepEqual(strokes[1], ['stroke', 8, '#fff', 1]);
  const composites = calls.filter(c => c[0] === 'drawImage');
  assert.equal(composites.length, 1);
  assert.equal(composites[0].at(-1), 77 / 255, 'Fade the completed track only once');
  assert.equal(calls.filter(c => c[0] === 'lineTo').length, 519);
  const path = calls.filter(c => c[0] === 'lineTo').slice(0, 512);
  assert(path[6][2] < path[0][2], 'Racers leave the start heading up');
  assert(path[0][1] < 1728, 'Course rotates 180 degrees rather than reflecting');
  const gate = calls.filter(c => c[0] === 'lineTo').slice(-2);
  const gateDx = gate[1][1] - gate[0][1], gateDy = gate[1][2] - gate[0][2];
  assert(Math.abs(Math.hypot(gateDx, gateDy) - 18) < 1e-9);
  assert(Math.abs(gateDx * TRACK_DATA[4] + gateDy * TRACK_DATA[6]) < 1e-9, 'Gate crosses the track');
  assert(calls.indexOf(strokes[2]) > calls.findLastIndex(c => c[0] === 'fill'), 'Gate overlays every racer');
  const markers = calls.filter(c => c[0] === 'arc');
  assert.equal(markers.length, 9);
  assert(markers.every(marker => marker[3] === 4.8));
  const tips = calls.filter(c => c[0] === 'lineTo').slice(512, 517);
  const center = [1, 2].map(axis => tips.reduce((sum, tip) => sum + tip[axis], 0) / 5);
  for (const [, x, y] of tips) assert(Math.abs(Math.hypot(x - center[0], y - center[1]) - 17.28) < 1e-9);
  assert(Math.abs(tips[0][2] - center[1] + 17.28) < 1e-9, 'First star tip points up');
  assert(calls.indexOf(tips[0]) > calls.indexOf(markers.at(-1)), 'Player must be drawn last');
  for (const [, x, y] of calls.filter(c => c[0] === 'lineTo' || c[0] === 'arc')) {
    assert(x > 1500 && x < 1880 && y > 500 && y < 850, 'Map escaped its HUD box');
  }
}
console.log('All four minimaps retain their stroke, start line, ten markers, player ordering and HUD bounds.');

// Exercise the actual readback guard and callback without a GPU. A delayed
// read must prevent overlapping copies; completion permits the next frame.
const peekSource = game.slice(game.indexOf('  const peek ='), game.indexOf('      // Same wrap test for all ten')) + '\n});\n};\npeek;';
let copies = 0;
let finishRead;
const sample = new Float32Array(280);
sample[0] = 123;
const readback = {
  SCREEN: 2, RACE_STATE: 2, FLAG_STATE: 5, peeking: false,
  STATE: {}, RACER_BASE: 16, mapRacers: null,
  bmDevice: {
    createCommandEncoder: () => ({ copyBufferToBuffer: () => copies++, finish: () => ({}) }),
    queue: { submit() {} },
  },
  lapPeek: {
    size: sample.byteLength,
    mapAsync: () => new Promise(resolve => { finishRead = resolve; }),
    getMappedRange: () => sample.buffer,
    unmap() {},
  },
};
const peek = runInNewContext(peekSource, readback);
for (let frame = 0; frame < 60; frame++) {
  peek();
  peek(); // Simulate another frame arriving before the transfer completes.
  assert.equal(copies, frame + 1, 'Overlapping GPU readback');
  finishRead();
  await Promise.resolve();
  assert.equal(readback.mapRacers[0], 123);
}
for (const screen of [0, 1, 3, 4]) {
  readback.SCREEN = screen;
  peek();
}
assert.equal(copies, 60, 'Readback started outside racing/countdown');
const frameStart = game.slice(game.indexOf('  bmLoop('), game.indexOf('    TIME = clock;'));
assert(frameStart.includes('    peek();') && !frameStart.includes('peekAt'));
console.log('Position readback runs at frame cadence, never overlaps, and skips inactive screens.');

const fontCode = build.slice(build.indexOf('const textSource ='), build.indexOf('\nconst parts ='));
const { font, packedText } = runInNewContext(`${fontCode};({font,packedText})`, {read, runInNewContext});
const compactFont = runInNewContext([
  read('src', 'unicorns.js'), read('src', 'circuits.js'), packedText,
  '({FONT_SET,FONT,LINES})',
].join('\n'));
assert.deepEqual(JSON.parse(JSON.stringify(compactFont.LINES)), JSON.parse(JSON.stringify(font.LINES)));
for (const char of new Set(font.LINES.join(''))) {
  const before = font.FONT_SET.indexOf(char), after = compactFont.FONT_SET.indexOf(char);
  assert.equal(after < 0, before < 0);
  if (before >= 0) assert.equal(compactFont.FONT.slice(after * 5, after * 5 + 5), font.FONT.slice(before * 5, before * 5 + 5));
}
console.log('Font pruning preserves every displayed caption and glyph bitmap.');
