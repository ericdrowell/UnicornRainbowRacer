// Build a js13k entry: compile shaders, concatenate, minify, zip, and refuse to
// finish if the result is over budget.
//
// The size gate is the point. Knowing you have 9 kB left changes what you build
// next; finding out on submission day does not.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { Packer } from 'roadroller';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
// js13k: 13 * 1024. Overridable so a work-in-progress can be looked at before
// it fits — `BUDGET=200000 npm run build` reports the real number without the
// gate stopping the build.
const LIMIT = Number(process.env.BUDGET || 13312);

/** Path to a specific brometal CLI. Unset means the installed one. */
const CLI = process.env.BROMETAL_CLI;

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: root, stdio: 'pipe', ...opts });
  } catch (error) {
    // Without this the tool's own message is swallowed and the failure surfaces
    // later as a missing file, pointing at the wrong thing entirely.
    process.stderr.write(String(error.stdout ?? ''));
    process.stderr.write(String(error.stderr ?? ''));
    throw error;
  }
}

// The two builds write to different files and do not disturb each other, so a
// release build cannot quietly throw away the inspector you were in the middle
// of using. They used to share dist/index.html, and every size check silently
// replaced the debug page with one that has no overlay — which looks exactly
// like the feature having been removed.
const OUT = process.env.DEBUG ? 'debug.html' : 'index.html';
mkdirSync(dist, { recursive: true });
rmSync(join(dist, OUT), { force: true });

// 1. Shaders → dist/brometal.js + dist/shaders.js
if (CLI) {
  run('node', [CLI, 'prod', '--js13k', root]);
} else {
  run('npx', ['brometal', 'prod', '--js13k', root]);
}

// 2. One program: runtime, then shaders, then the game.
for (const required of ['dist/brometal.js', 'dist/shaders.js']) {
  if (!existsSync(join(root, required))) {
    console.error(
      `\n\u2717 ${required} was not produced.\n` +
        '  The installed brometal does not support --js13k. It needs a version\n' +
        '  that ships the js13k runtime; check the version in package.json.',
    );
    process.exit(1);
  }
}
// ── One program ─────────────────────────────────────────────────────────────
// Runtime, shaders, data, sound, then the game.
//
// **The sound has to come before game.js and that is not cosmetic.** The songs
// arrive as `const RACE_SONG = {...}`, and game.js reads them at the top level
// while it renders them — a const referenced before its own declaration line has
// run is a ReferenceError, not a hoist. They used to sit after game.js and it
// worked only because the code using them lived in a src/music.js appended after
// them; that file was a wrapper around four functions and has been folded into
// game.js, which is what forced this order.
//
// sonantx ships as an ES module and everything here is concatenated into one
// plain script, so its two `export` keywords are stripped — nothing else about
// the file needs touching, it has no imports and no other module syntax. The
// songs are JSON on disk, which is the format Sonant-X Live exports and
// therefore the format worth keeping them in; they become literals on the way in.
//
// ZzFX is NOT inlined. It was, for the jump sound, and when jump went so did the
// last live `zzfx(...)` call in the project — src/soundEffects.js is now entirely
// commented-out sound design, so the library was 1.2 kB of synthesiser shipping
// for nobody. The file stays in the tree because it is the scratchpad the effects
// get auditioned in; put both lines back the moment one of them is wired up:
//
//   readFileSync(join(root, 'node_modules', 'zzfx', 'ZzFXMicro.min.js'), 'utf8'),
//   readFileSync(join(root, 'src', 'soundEffects.js'), 'utf8'),
//
// Music is unaffected — that is sonantx, and it has nothing to do with ZzFX.
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const song = (name) => `const ${name[0]} = ${read('src', 'songs', name[1])};`;

// The inspector is appended only for `npm run debug`, so it cannot creep into a
// release: the file simply is not in the program that gets minified.
const parts = [
  read('dist', 'brometal.js'),
  read('dist', 'shaders.js'),
  read('src', 'mesh.js'),
  read('src', 'circuits.js'),
  read('src', 'font.js'),
  read('node_modules', 'sonantx', 'sonantx.js').replace(/^export /gm, ''),
  song(['RACE_SONG', 'dizzy-beats.json']),
  song(['MENU_SONG', 'dizzy-land-beginning.json']),
  read('src', 'game.js'),
];
if (process.env.DEBUG) parts.push(read('src', 'debug.js'));
let combined = parts.join('\n');

// Two changes the inspector needs and the release must never have. Flying the
// camera inside the model shows nothing with back faces culled — the inside of
// a surface is exactly what gets thrown away — and a 0.1 near plane clips
// through walls that are barely thicker than that.
//
// Patched here, in the concatenated source, rather than behind a runtime flag
// in game.js: a flag would cost bytes in every release to serve a build that
// never ships. The trade is that the debug build no longer renders quite like
// the real one, so each patch is announced rather than applied quietly, and the
// overlay says on screen that back faces are being drawn.
if (process.env.DEBUG) {
  for (const [from, to, why] of [
    ['cull: 1', 'cull: 0', 'back faces drawn'],
    // The near plane and the pose used to be patched here too, and neither is
    // any more. Both moved onto the GPU: the projection is built by the physics
    // stage and the unicorn is placed by its vertex shader, so there is no
    // longer a line in game.js to rewrite. debug.js takes the state buffer over
    // instead — its own near plane, and a parked unicorn at the origin — which
    // is a better arrangement anyway, because it is code that reads as code
    // rather than a string match that breaks silently when the source is
    // reworded. Only genuinely source-level patches belong here now.
    ['TIME = clock;', 'TIME = 0;', 'wall clock frozen'],
  ]) {
    if (!combined.includes(from)) throw new Error(`debug patch failed: no "${from}" in the sources`);
    combined = combined.replace(from, to);
    console.log(`  debug patch  ${why}`);
  }
}
const rawPath = join(dist, 'raw.js');
writeFileSync(rawPath, combined);

// 3. Minify the whole thing at once. --toplevel is what lets the mangler rename
// the runtime's API and drop the parts this game never calls; without it those
// names survive at full length.
const outPath = join(dist, 'g.js');
run('npx', [
  'terser', rawPath,
  '--compress', '--mangle', '--toplevel',
  '--format', 'comments=false',
  '-o', outPath,
]);

// 4. Pack it. This is the single largest saving in the whole build and it costs
// no features: 3.9 kB off a 20.8 kB entry when it went in.
//
// **Terser and this are not doing the same job.** Terser rewrites the program;
// RoadRoller compresses it, with a context-mixing model far stronger than the
// DEFLATE inside the zip, and ships a decoder that unpacks it at load. The zip
// then has almost nothing left to find, which is the point — the 13 kB is
// measured on the archive.
//
// The parameters below were found by RoadRoller's own search (`-O2`, about fifty
// seconds) and are cached here because re-searching every build is fifty seconds
// to rediscover the same twelve numbers. They drift slowly as the code changes:
// `PACK=search npm run build` runs the search again and prints what it found, and
// is worth doing after any large change. Everything else is `optimize()` picking
// its defaults, which is measurably worse than these.
//
// **Off by default, and that is the point of having two builds.** `npm run dev`
// and `npm run build` skip it; `npm run prod` is the one that packs and therefore
// the only one whose number means anything. Not for speed — with the parameters
// cached this costs about a second — but for debuggability: a packed page is a
// decoder and a blob, so an exception in it reports as `eval` at no line number,
// which is a bad trade while you are still changing things. The inspector build
// never packs.
const PACK = process.env.PACK ?? '0';
const CACHED = {
  numAbbreviations: 31,
  recipLearningRate: 1000,
  modelMaxCount: 4,
  modelRecipBaseCount: 42,
  sparseSelectors: [0, 1, 2, 3, 7, 13, 15, 42, 123, 195, 304, 401],
};

let script = readFileSync(outPath, 'utf8');
if (!process.env.DEBUG && PACK !== '0') {
  const packer = new Packer([{ data: script, type: 'js', action: 'eval' }], CACHED);
  if (PACK === 'search') {
    console.log('  packing      searching for parameters, this takes about a minute');
    const found = await packer.optimize(2);
    console.log(`  packing      ${JSON.stringify(found.best)}`);
  }
  const { firstLine, secondLine } = packer.makeDecoder();
  script = `${firstLine}\n${secondLine}`;
} else if (!process.env.DEBUG) {
  console.log('  packing      skipped — run `npm run prod` for the shippable number');
}

// 5. Inline the script into the page. One file rather than two: a js13k entry
// is judged as a zip, and every extra member carries its own header and central
// directory record — so two files cost more than the same bytes in one. It also
// makes the result openable straight from disk, since file:// is a secure
// context and WebGPU works there.
const page = readFileSync(join(root, 'src', 'index.html'), 'utf8').replace(
  /<script src=g\.js><\/script>/,
  // Escaping the closing tag guards the case where minified code contains it
  // inside a string, which would end the block early and truncate the game.
  () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`,
);
writeFileSync(join(dist, OUT), page);

// The debug build is not a deliverable — it carries the inspector and has been
// patched away from how the release renders — so it is neither zipped nor
// measured against the budget. Reporting a number for it would only invite
// comparing it with one that means something.
if (process.env.DEBUG) {
  rmSync(rawPath, { force: true });
  rmSync(outPath, { force: true });
  console.log(`  dist/${OUT}   ${statSync(join(dist, OUT)).size} bytes  (inspector build, not measured)`);
  process.exit(0);
}

// 6. Zip — js13k measures the archive, not the files.
//
// **Then recompress it, because `zip -9` is not the best DEFLATE there is.**
// advzip re-encodes the same stream with Zopfli, which searches much harder for
// the cheapest way to say the same bytes; the archive still unzips anywhere,
// since Zopfli emits ordinary DEFLATE. Worth 390 bytes here, which is the
// difference between two features and one.
//
// It also normalises the headers on its way through, and that quietly collects a
// second saving. Info-ZIP on macOS and Linux writes Unix extra fields into every
// entry — a high-resolution timestamp and a uid/gid pair, 24 bytes a header —
// that a zip written on Windows simply does not have. `zip -X` suppresses them
// and is the usual advice; advzip drops them regardless, so the flag is
// redundant once this runs. Measured both ways: identical to the byte.
//
// Optional on purpose. It is `brew install advancecomp` (or apt advancecomp) and
// a machine without it still produces a valid, submittable archive — 390 bytes
// larger, and the build says so rather than quietly reporting a number that was
// never going to be the real one.
let zipBytes = null;
let packedZip = false;
try {
  run('zip', ['-9', '-q', '-j', 'game.zip', 'index.html'], { cwd: dist });
  try {
    run('advzip', ['-z', '-4', '-i', '200', '-q', 'game.zip'], { cwd: dist });
    packedZip = true;
  } catch {
    // No advzip. Not an error — the plain archive is still the deliverable.
  }
  zipBytes = statSync(join(dist, 'game.zip')).size;
} catch {
  // No zip binary (Windows, minimal CI image). Fall back to the raw total so
  // the build still reports something honest rather than silently passing.
  zipBytes = null;
}

const jsBytes = statSync(join(dist, 'index.html')).size;
const measured = zipBytes ?? jsBytes;
const label = zipBytes === null ? 'index.html (no zip binary)' : 'game.zip';

writeFileSync(
  join(root, '.size.json'),
  JSON.stringify({ js: jsBytes, zip: zipBytes, limit: LIMIT }, null, 2),
);

// The concatenated and minified intermediates have served their purpose; the
// deliverable is one file. Leaving them invites shipping the wrong thing.
rmSync(rawPath, { force: true });
rmSync(outPath, { force: true });

const pct = ((measured / LIMIT) * 100).toFixed(1);
console.log(`  index.html   ${jsBytes} bytes`);
if (zipBytes !== null) {
  console.log(`  game.zip     ${zipBytes} bytes${packedZip ? '' : '  (no advzip — about 390 more than it needs to be)'}`);
}
console.log(`  budget       ${measured} / ${LIMIT}  (${pct}%)`);

// Reported, never enforced. The gate used to fail the build, which sounds like
// discipline and works out as the opposite: the way this thing gets made is add
// something, see it, then win the bytes back, and a build that refuses to
// produce a file in the middle of that loop just means the thing cannot be
// looked at until it is already paid for. The number is what does the work —
// knowing there are 200 bytes to find changes what gets built next, and it says
// so just as loudly in red as it does by exiting.
if (measured > LIMIT) {
  console.log(`\n! over by ${measured - LIMIT} bytes (${label}) — built anyway`);
} else {
  console.log(`\n✓ ${LIMIT - measured} bytes remaining`);
}
