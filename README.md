# Unicorn Rainbow Racer

A [js13k 2026](https://js13kgames.com/) entry, built with
[BroMetal](https://brometal.dev/js13k) — WebGPU, with shaders written in typed
TypeScript and compiled to WGSL on this machine, so the compiler never counts
against the 13 kB.

Right now it is the starter: a spinning textured cube.

```bash
npm install
npm run build
open dist/index.html
```

Everything is inlined into that one file, so it opens straight from disk — no
server needed, because `file://` is a secure context and WebGPU works there.

## The budget

The build prints what is left and **fails if the zip exceeds 13,312 bytes**:

```
  index.html   6204 bytes
  game.zip     3008 bytes
  budget       3008 / 13312  (22.6%)

✓ 10304 bytes remaining
```

Run it often. Knowing there are 10 kB left changes what gets built next;
finding out on submission day does not.

## Layout

| | |
|---|---|
| `src/*.shader.ts` | shaders, in BroMetal's typed DSL |
| `src/game.js` | the game — plain globals, no imports |
| `src/index.html` | the page shell; the build inlines the script into a copy |
| `dist/brometal.js` | generated: the runtime |
| `dist/shaders.js` | generated: the compiled shaders |
| `dist/index.html` | **the whole game in one file** — open this |
| `dist/game.zip` | what gets submitted |

Everything written by hand lives in `src/`; everything in `dist/` is generated
and gitignored, so it is always safe to delete.

## How the build works

1. `brometal prod --js13k` compiles `src/*.shader.ts` into `dist/shaders.js` and
   writes the runtime to `dist/brometal.js` from the same version.
2. Runtime + shaders + game are concatenated into one program.
3. `terser --toplevel --mangle` minifies all of it in a single pass.
4. The result is inlined into a copy of `src/index.html`, written to
   `dist/index.html`, and zipped.

Step 3 is why the runtime ships as readable source: minified jointly, the
mangler renames its API and deletes every function the game never calls.

## Adding a shader

Add `src/thing.shader.ts` exporting `export const Thing = shader({...})` and it
becomes the global `Thing` in `dist/shaders.js`. The name comes from the export,
not the filename — nothing is derived, so there is no second name to look up.

The uniform block is a flat `Float32Array`; the float offset of each uniform is
written as a comment above its entry in `dist/shaders.js`.

## Requires WebGPU

Chrome/Edge 113+, Firefox 141+, Safari 26+. On iOS every browser is WebKit
underneath, so the iOS version is what decides it.
