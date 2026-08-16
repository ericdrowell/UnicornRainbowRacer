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

// jumps
/*
zzfx(...[1.3,,316,.02,.05,.09,,1.3,,21,,,,,,,.01,.88,.05,,-1400]); // Jump 107
zzfx(...[,,259,.03,.01,,,.4,9,,,,,.3,,,,.92,.02]); // Jump 115
zzfx(...[1.9,,539,.01,.03,.02,,.4,14,,-197,,,,,,.44,.85,.01,.1,-1467]); // Blip 285
zzfx(...[1.1,,119,.02,.03,.09,1,2,1,,,,,.5,,.1,,.63,.03]); // Jump 697
*/

// runnning sounds
/**
 zzfx(...[1.1,,57,.01,.03,.02,1,1.9,,,,,,,,,,.69,.02]); // Blip 235
 zzfx(...[,,68,.01,,.01,,3.5,,1,,,,.9,,.1,,.98,.01,.2]); // Blip 243
 zzfx(...[1.7,,58,.03,.01,.03,1,1.8,,7,,,,.1,.1,,.05,.91,.03,,-649]); // Blip 259
 */

// race life cycle sounds
/*
zzfx(...[1.9,0,65.40639,.05,.2,.13,,2.8,,,,,,.1,,,,.94,.14,,101]); // Music 344
zzfx(...[1.9,0,261.6256,.03,.93,.15,1,1.1,,,,,,,,,.1,.88,.08,,-1289]); // Music 378
zzfx(...[,,217,.08,.15,.11,,,4,-391,,,.02,,48,,,.94,.21]); // Powerup 516
 */

// speed boosts
/*
zzfx(...[.6,,642,.07,.22,.16,,2.3,,-276,54,.16,,,,.1,,.71,.17,,124]); // Powerup 419
zzfx(...[.9,,504,.06,.11,.35,1,2.6,,234,-78,.18,,,,,,.93,.19,,241]); // Powerup 451
zzfx(...[,,666,.05,.15,.38,,3.3,,-168,88,.08,.04,,,,,.89,.13,.04]); // Powerup 470
zzfx(...[1.1,,292,.04,.13,.31,1,3,-8,343,,,,,,.1,,.73,.17]); // Powerup 515
zzfx(...[1.3,,687,.02,.25,.15,,2.2,17,,,,,,,,.07,.89,.26]); // Powerup 551
*/

// slip stream
/*
zzfx(...[,,566,.07,.2,.31,,,1,,,,,.5,,,,.8,.23]); // Powerup 496
*/

// other interesting sounds
/*
zzfx(...[1.7,,681,.05,.27,.21,1,.9,,,-54,.13,.04,,,,.11,.55,.25,.2]); // Powerup 452
zzfx(...[1.3,,159,.02,.16,.21,5,.7,,3,,,,,.9,,.14,.85,.17]); // Powerup 461
zzfx(...[,,557,.08,.21,.09,,.3,,-2,,,,,,,,.96,.23]); // Powerup 569
*/

/* sounds that mean you did something wrong
zzfx(...[,,324,.06,.23,.22,,2.6,,,371,.16,,,38,,,.87,.29]); // Powerup 609

*/