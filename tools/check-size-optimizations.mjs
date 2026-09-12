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

const helper = build.slice(build.indexOf('function compactShader('), build.indexOf('// Browser fonts supply glyphs'));
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
assert(!game.includes('const drawMap ='), 'Minimap was removed to retain glowing pickups');
// Generate each real course and validate the shared GPU state tail used by sorting.
const layoutContext = { document: { querySelector: () => ({}) } };
const layoutSource = [read('src', 'unicorns.js'), read('src', 'unicorn.js'), read('src', 'circuits.js'),
  game.slice(0, game.indexOf('lay();') + 6).replace('const MUSIC_ENABLED = true', 'const MUSIC_ENABLED = false'),
  `CIRCUITS.map((_, i) => {
    SELECTED_CIRCUIT = i; lay();
    return { stars: STAR_SLOTS, base: PALETTE + FIELD * 6,
      vertices: TE.map((marker, j) => marker === 10 && j % 2 === 0 ? TP[j / 2 * 3] : -1).filter(i => i >= 0) };
  })`,
].join('\n');
for (const layout of runInNewContext(layoutSource, layoutContext)) {
  assert.equal(layout.base, 146);
  assert.equal(layout.stars.length, 160);
  assert.equal(new Set(layout.stars.filter((_, i) => i % 4 === 0)).size, 40);
  assert.equal(layout.vertices.length, 160);
  for (let i = 0; i < 160; i++) assert.equal(layout.vertices[i], Math.floor(i / 4));
}
console.log('All four courses bind forty unique glow quads to the shared sort buffer.');


// Exercise the actual readback guard and callback without a GPU. A delayed
// read must prevent overlapping copies; completion permits the next frame.
const peekSource = game.slice(game.indexOf('  const peek ='), game.indexOf('      // Same wrap test for all ten')) + '\n});\n};\npeek;';
let copies = 0;
let finishRead;
const sample = new Float32Array(280);
sample[0] = 123;
const readback = {
  SCREEN: 2, RACE_STATE: 2, FLAG_STATE: 5, peeking: false,
  STATE: {}, RACER_BASE: 16,
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
  assert.equal(readback.peeking, false);
}
for (const screen of [0, 1, 3, 4]) {
  readback.SCREEN = screen;
  peek();
}
assert.equal(copies, 60, 'Readback started outside racing/countdown');
const frameStart = game.slice(game.indexOf('  bmLoop('), game.indexOf('    TIME = clock;'));
assert(frameStart.includes('    peek();') && !frameStart.includes('peekAt'));
console.log('Position readback runs at frame cadence, never overlaps, and skips inactive screens.');

