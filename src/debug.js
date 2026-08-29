// Triangle inspector — development only.
//
// Built in with `npm run debug`, left out of the real build entirely, so none of
// this counts against the 13 kB.
//
// Hover any triangle to highlight it and read what it is: its index, which part
// of the model it came from, whether it is rigged to a leg, and the skin weight
// on each of its corners. The point is to be able to say "triangle 812 is the
// static one" instead of "there's a weird triangle near the shoulder".
//
// The picking is done on the CPU against the *animated* positions, which means
// this file repeats the vertex shader's skinning in JavaScript. That duplication
// is deliberate and worth stating: if the two ever disagree, the highlight will
// visibly lag the model, which is itself a useful signal that the shader is not
// doing what this thinks it is.

(() => {
  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
  document.body.appendChild(overlay);
  const ctx = overlay.getContext('2d');

  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;z-index:11;pointer-events:none;display:none;padding:7px 10px;' +
    'background:rgba(12,12,20,.92);border:1px solid #3a3a52;border-radius:6px;' +
    'color:#e8eaf2;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.5)';
  document.body.appendChild(tip);

  const fit = () => {
    overlay.width = innerWidth * devicePixelRatio;
    overlay.height = innerHeight * devicePixelRatio;
    overlay.style.width = innerWidth + 'px';
    overlay.style.height = innerHeight + 'px';
  };
  fit();
  addEventListener('resize', fit);

  /** The vertex shader's skinning, in JS. Must match unicorn.shader.ts. */
  const KNEE_Y = 0.3;
  const smooth = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const spin = (p, a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
  };
  // ── The pose the inspector shows ───────────────────────────────────────────
  // SPEED and GAIT are what this build writes into the state buffer, and the
  // shader reads both from there: SPEED picks the gait, GAIT is how far through
  // its cycle. Driven from a clock here rather than from distance travelled,
  // because nothing is travelling — the model is parked at the origin.
  //
  // R switches direction, F starts and stops. Stopped is what the picker wants,
  // since a triangle you are trying to point at should hold still; running is
  // what the animation wants. Having both is the reason this is a variable
  // rather than the constant zero it used to be.
  const RUN_SPEED = 20;
  const WALK_SPEED = -4;
  let SPEED = RUN_SPEED;
  // Frozen on arrival. The animation is the thing this build exists to inspect,
  // and a moving target is the one thing you cannot inspect — the picker wants a
  // triangle that holds still, and so does anyone looking closely at a seam. F
  // starts it.
  let MOVING = 0;
  let GAIT = 0;
  addEventListener('keydown', (e) => {
    // Forward gallops, reverse walks — so R has to cross zero to show both, and
    // the old forward-slow setting showed nothing the fast one did not.
    if (e.code === 'KeyR') SPEED = SPEED === RUN_SPEED ? WALK_SPEED : RUN_SPEED;
    if (e.code === 'KeyF') MOVING = 1 - MOVING;
  });
  /** The shader's own gait select, on the same threshold it now uses.
   *
   *  This used to be `smooth(6, 15, |SPEED|)`, matching a shader that blended
   *  walk into gallop as the unicorn got quicker. It does not any more: forwards
   *  is always the gallop and only reverse walks, so the blend is on the *signed*
   *  speed across the first few units of backing up. Left stale, the picker's
   *  highlight would sit on a pose the shader is not drawing. */
  const runBlend = () => smooth(-3, 0, SPEED);

  // Everything below repeats unicorn.shader.ts in JavaScript, gait selection
  // included. That duplication is the point: these are the positions the mouse
  // ray is tested against, so if this and the shader ever disagree the
  // highlight visibly slides off the face it names, which says so immediately.
  function posed(v) {
    const t = SK[v * 4];
    const run = runBlend();
    // Which leg, from its hip — exactly as the vertex shader recovers it.
    const gallop = (RT[v * 3] >= 0 ? 0 : Math.PI) + Math.sign(RT[v * 3 + 2]) * 0.2;
    const gait = GAIT + SK[v * 4 + 1] * (1 - run) + gallop * run;
    const hip = SK[v * 4 + 2] * (1 + 0.45 * run) * Math.sin(gait) * smooth(0, 0.28, t);
    const knee = SK[v * 4 + 3] * (1 + 0.25 * run) * Math.max(Math.sin(gait + 2.2), 0);
    const bend = knee * smooth(0.32, 0.56, t);
    const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    const a = spin([p[0], p[1] + KNEE_Y, p[2]], bend);
    const b = spin([a[0], a[1] - KNEE_Y, a[2]], hip);
    // Off GAIT, not off `gait`: the bob is one number for the whole model, and
    // building it from a value carrying this leg's phase would lift each leg by
    // a different amount.
    const bob = Math.sin(GAIT * 2) * 0.03 * (1 - run) + Math.sin(GAIT) * 0.07 * run;
    // No body transform: this build parks the unicorn at the origin facing +x,
    // so model space and world space are the same thing and the ray below can
    // be cast straight at these.
    return [b[0] + RT[v * 3], b[1] + RT[v * 3 + 1] + bob, b[2] + RT[v * 3 + 2]];
  }

  /**
   * Colour is the part label — each piece was given its own at conversion.
   *
   * Hide and wing are matched against the roster rather than by hue, because CL
   * holds the repainted colour, not the converter's. Loose hue tests used to be
   * enough when only the hide was substituted and the wing was always pink; now
   * that a unicorn can have white wings, "bright and unsaturated" no longer
   * means body. Mirroring and the skipped socket faces put CL out of step with
   * MESH_C, so reading the original colour by index is not an option.
   */
  function partOf(v) {
    const r = CL[v * 4];
    const g = CL[v * 4 + 1];
    const b = CL[v * 4 + 2];
    if (CL[v * 4 + 3] > 0.5) return 'mane / tail';
    if (is(r, g, b, SKIN.wing)) return 'wing';
    if (is(r, g, b, SKIN.body)) return 'body';
    if (r > 0.9 && g > 0.7 && b < 0.5) return 'horn';
    if (r < 0.1) return 'eye';
    return 'hoof';
  }

  // Where the canvas actually is on screen. It no longer fills the window: the
  // pixel grid sizes it to a whole number of art pixels and blows it up with a
  // transform, so its box is both offset and a different size from the viewport.
  // getBoundingClientRect reports the box after the transform, which is exactly
  // the region the cursor is pointing at.
  const box = () => canvas.getBoundingClientRect();

  const project = (p) => {
    const w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15];
    const r = box();
    const d = devicePixelRatio;
    return [
      (r.left + ((((VP[0] * p[0] + VP[4] * p[1] + VP[8] * p[2] + VP[12]) / w) * 0.5 + 0.5)) * r.width) * d,
      (r.top + (0.5 - ((VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13]) / w) * 0.5) * r.height) * d,
      w,
    ];
  };

  /** Möller–Trumbore. Returns the distance along the ray, or null. */
  function hit(o, d, a, b, c) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-9) return null;
    const f = 1 / det;
    const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
    if (u < 0 || u > 1) return null;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
    if (v < 0 || u + v > 1) return null;
    const t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
    return t > 1e-4 ? t : null;
  }

  // ── The inspector's own camera ─────────────────────────────────────────────
  // The release has no CPU camera at all: the physics stage builds the
  // view-projection on the GPU and writes it into the state buffer, and nothing
  // reads it back. That is right for racing and useless for inspecting, so this
  // build takes the buffer over.
  //
  // Each frame, before anything is drawn, this overwrites the whole of STATE:
  // an identity body — origin, facing +x, +y up — carrying this file's own
  // speed and gait, and an orbit matrix built here on the CPU. The unicorn
  // therefore renders exactly in model space, which is what lets the picker
  // below compare a mouse ray against `posed()` positions and be right. Let the
  // physics keep the buffer and the model would be somewhere down the track, in
  // a pose the CPU would have to reproduce to pick against.
  //
  // Writing over a storage buffer from JavaScript works because bmStore creates
  // them COPY_DST. There is no reading one back, which is the whole reason the
  // camera is on the GPU in the first place — but writing is free.
  let YAW = 0.6;
  let PITCH = 0.22;
  let VP = null;
  const TARGET = [0, 1.02, 0];
  const body = new Float32Array(32);
  body.set([0, 0, 0, 0, /* facing +x */ 1, 0, 0, 0, /* up +y */ 0, 1, 0, 0, /* across */ 0, 0, 1, 0]);

  // The release ties the gait to distance covered, so the legs stop when the
  // unicorn does. Nothing here covers any distance, so the inspector winds it by
  // hand at the rate the release would reach at this speed — physics accumulates
  // gait at speed * 0.6, and matching that is what makes the stride you watch
  // here the stride you get on the track.
  let lastTick = 0;
  function camera() {
    const now = performance.now() / 1000;
    // The rate physics uses: 0.6 radians per unit travelled, but never slower
    // than 20 rad/s once moving forward at all — the floor that makes a standing
    // start look like effort. Winding this by hand at plain `SPEED * 0.6`, as it
    // used to, ran the legs at a third of the speed the track shows.
    const churn = Math.max(Math.abs(SPEED) * 0.6, 20 * smooth(0, 2, SPEED));
    if (lastTick) GAIT += (now - lastTick) * churn * Math.sign(SPEED) * MOVING;
    lastTick = now;
    body[7] = SPEED; // slot 1.w — the shader picks walk or run from this
    body[11] = GAIT; // slot 2.w — and how far through the cycle it is

    const view = bmLook(eyePos(), TARGET, [0, 1, 0]);
    // 0.004 rather than the release's 0.1, because flying the camera inside the
    // model is the point and at 0.1 the surface clips away as you reach it.
    const proj = bmPersp(1, canvas.width / canvas.height, 0.004, 500);
    VP = bmMul(proj, view);
    body.set(VP, 16);
    bmDevice.queue.writeBuffer(STATE, 0, body);
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    YAW -= (e.clientX - lastX) * 0.01;
    // Clamped short of the poles: at exactly overhead the up vector and the view
    // direction line up and the view matrix has no way to decide which way is up.
    PITCH = Math.min(Math.max(PITCH + (e.clientY - lastY) * 0.008, -1.4), 1.4);
    lastX = e.clientX;
    lastY = e.clientY;
  });

  // ── Zoom ───────────────────────────────────────────────────────────────────
  // Scroll to pull the camera in towards the centre of the model or back out
  // again. A fixed distance is right for looking at the unicorn and no use for
  // looking *inside* it — and geometry sealed inside cannot be judged from
  // outside.
  let dist = 3.6;
  function eyePos() {
    const c = Math.cos(PITCH);
    return [
      TARGET[0] + dist * c * Math.sin(YAW),
      TARGET[1] + dist * Math.sin(PITCH),
      TARGET[2] + dist * c * Math.cos(YAW),
    ];
  }
  addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Multiplied, not stepped: a fixed amount per notch crawls when you are
      // far out and jumps clean through the model once you are close.
      //
      // The floor is well inside the unicorn — that is the point — which is why
      // this build's near plane is 0.004. At the release's 0.1 the surface you
      // are trying to look at would clip away as you reached it.
      dist = Math.min(Math.max(dist * Math.exp(e.deltaY * 0.0012), 0.04), 24);
    },
    // Explicitly not passive: listeners on wheel default to passive, and a
    // passive listener may not preventDefault, so the page would scroll too.
    { passive: false },
  );

  // ── Nothing but the unicorn ────────────────────────────────────────────────
  // The road, the sky and the clouds are all still being drawn, and every one of
  // them is in the way: the ribbon passes through the origin, so any orbit that
  // dips below the horizon puts a wall of rainbow between the camera and the
  // model, and the cloud march costs most of the frame to render scenery nobody
  // is inspecting.
  //
  // Discriminated by vertex buffer count rather than by identity, because game.js
  // keeps its programs in local consts this file cannot see. The unicorn is the
  // only one with five attribute streams — position, normal, root, skin, colour;
  // the road has two, the sky and the clouds one each. That is a fact about the
  // model rather than about the draw order, so it survives the frame being
  // reordered, which a "skip the second draw" rule would not.
  const drawOnly = bmDraw;
  bmDraw = (prog, count) => {
    if (prog.b.length === 5) drawOnly(prog, count);
  };

  // Take the state buffer over, immediately after the physics stage has filled
  // it and before bmLoop submits the frame that reads it. Wrapping the global
  // is what gets the ordering right: a separate requestAnimationFrame would
  // race the render loop's, and writeBuffer only beats a submit it is queued
  // ahead of. bmDispatch is a plain function declaration in the shared scope,
  // so it can be replaced the way anything else here is.
  const dispatch = bmDispatch;
  bmDispatch = (prog, x, y, z) => {
    dispatch(prog, x, y, z);
    camera();
  };

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:10px;top:10px;z-index:11;pointer-events:none;padding:7px 10px;' +
    'background:rgba(12,12,20,.82);border:1px solid #3a3a52;border-radius:6px;' +
    'color:#c9cde0;font:11px/1.6 ui-monospace,Menlo,monospace;white-space:pre';
  document.body.appendChild(hud);

  let picked = -1;
  // Hung off window so the picker can be driven from a script — checking that a
  // hit really is under the cursor is exactly the kind of thing worth asserting
  // rather than eyeballing.
  self.DBG = { posed, pick: () => picked, vp: () => VP, tris: () => P.length / 9 };
  addEventListener('pointermove', (e) => {
    if (!VP) return;
    // Ray from the eye through the cursor, built from the camera basis rather
    // than by inverting the matrix — fewer places to get a sign wrong.
    const eye = eyePos();
    const f = [TARGET[0] - eye[0], TARGET[1] - eye[1], TARGET[2] - eye[2]];
    const fl = Math.hypot(...f);
    for (let i = 0; i < 3; i++) f[i] /= fl;
    // cross(forward, worldUp). Negated, this points left instead of right, and
    // since `up` below is derived from it the whole picture mirrors on both
    // axes — the cursor picks the triangle opposite the one under it.
    const r = [-f[2], 0, f[0]];
    const rl = Math.hypot(...r) || 1;
    for (let i = 0; i < 3; i++) r[i] /= rl;
    const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const r0 = box();
    // Aspect from the drawing buffer, which is what bmPersp was given — the
    // element's box is a whole number of art pixels and can differ from it.
    const aspect = canvas.width / canvas.height;
    const tan = Math.tan(0.5); // bmPersp is called with fov = 1 radian
    const nx = ((e.clientX - r0.left) / r0.width) * 2 - 1;
    const ny = 1 - ((e.clientY - r0.top) / r0.height) * 2;
    const d = f.map((_, i) => f[i] + r[i] * nx * tan * aspect + up[i] * ny * tan);
    const dl = Math.hypot(...d);
    for (let i = 0; i < 3; i++) d[i] /= dl;

    let best = Infinity;
    picked = -1;
    for (let t = 0; t < P.length / 9; t++) {
      const a = posed(t * 3);
      const b = posed(t * 3 + 1);
      const c = posed(t * 3 + 2);
      const k = hit(eye, d, a, b, c);
      if (k !== null && k < best) {
        best = k;
        picked = t;
      }
    }

    if (picked < 0) {
      tip.style.display = 'none';
      return;
    }
    const v = picked * 3;
    const ws = [posed(v), posed(v + 1), posed(v + 2)];
    const ys = ws.map((w) => w[1]);
    const rooted = RT[v * 3] !== 0 || RT[v * 3 + 1] !== 0 || RT[v * 3 + 2] !== 0;
    const leg = rooted
      ? `${RT[v * 3] > 0 ? 'front' : 'hind'} ${RT[v * 3 + 2] > 0 ? 'right' : 'left'}`
      : 'body (static)';
    const w0 = [0, 1, 2].map((k) => SK[(v + k) * 4].toFixed(2)).join('  ');
    tip.textContent =
      `triangle  ${picked}\n` +
      `part      ${partOf(v)}\n` +
      `rigged to ${leg}\n` +
      `weights   ${w0}\n` +
      `root      ${[0, 1, 2].map((k) => RT[v * 3 + k].toFixed(2)).join(', ')}\n` +
      `y span    ${Math.min(...ys).toFixed(3)} .. ${Math.max(...ys).toFixed(3)}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 190) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  });

  (function draw() {
    requestAnimationFrame(draw);
    hud.textContent =
      `distance  ${dist.toFixed(2)}\n` +
      `gait      ${SPEED > 0 ? 'gallop' : 'walk (reverse)'} at ${SPEED} m/s${MOVING ? '' : ' — frozen'}\n` +
      'scroll to zoom · drag to rotate\n' +
      `R forward/reverse · F ${MOVING ? 'freeze' : 'run'}\n` +
      'unicorn only · back faces drawn · parked at the origin (debug build)';

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (picked < 0 || !VP) return;
    const v = picked * 3;
    const pts = [0, 1, 2].map((k) => project(posed(v + k)));
    if (pts.some((p) => p[2] <= 0)) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.closePath();
    // Redrawn every frame rather than on hover: the triangle is being animated,
    // so a highlight painted once would slide off the face it belongs to.
    ctx.fillStyle = 'rgba(255,80,160,.45)';
    ctx.fill();
    ctx.strokeStyle = '#ff4fa3';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.stroke();
  })();
})();
