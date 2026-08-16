// Sound effects, via ZzFX.
//
// Each effect is the parameter list ZzFX's designer emits, kept verbatim so a
// sound tweaked in the tool can be pasted straight back in. The holes are
// deliberate: a gap in an array literal is `undefined`, which ZzFX reads as
// "use the default for this one", so only the parameters that matter are
// written down.

const JUMP = [,,197,.01,.03,.09,,2.1,,90,,,,,,.1,,.55,.05];

addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  // Space scrolls the page, and held keys repeat about thirty times a second —
  // without both guards one press becomes a machine gun.
  e.preventDefault();
  // ZzFX has its own audio context, which the pause does not touch, so a paused
  // game would otherwise still answer the space bar.
  if (!e.repeat && !PAUSED) zzfx(...JUMP);
});
