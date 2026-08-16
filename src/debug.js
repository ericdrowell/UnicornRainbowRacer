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
  function posed(v) {
    const t = SK[v * 4];
    const gait = TIME * 9 + SK[v * 4 + 1];
    const hip = SK[v * 4 + 2] * Math.sin(gait) * smooth(0, 0.28, t);
    const knee = SK[v * 4 + 3] * Math.max(Math.sin(gait + 2.2), 0);
    const bend = knee * smooth(0.32, 0.56, t);
    const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    const a = spin([p[0], p[1] + KNEE_Y, p[2]], bend);
    const b = spin([a[0], a[1] - KNEE_Y, a[2]], hip);
    const bob = Math.sin(TIME * 18) * 0.03;
    return [b[0] + RT[v * 3], b[1] + RT[v * 3 + 1] + bob, b[2] + RT[v * 3 + 2]];
  }

  /** Colour is the part label — each piece was given its own at conversion. */
  function partOf(v) {
    const r = CL[v * 4];
    const g = CL[v * 4 + 1];
    const b = CL[v * 4 + 2];
    if (CL[v * 4 + 3] > 0.5) return 'mane / tail';
    if (r > 0.9 && g > 0.9 && b > 0.9) return 'body';
    if (r > 0.9 && g < 0.75 && b > 0.6) return 'wing';
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

  // ── Zoom ───────────────────────────────────────────────────────────────────
  // Scroll to pull the camera in towards the centre of the model or back out
  // again. game.js orbits at a fixed distance, which is right for looking at the
  // unicorn and no use for looking *inside* it — and geometry sealed inside
  // cannot be judged from outside. Its eye is a reassignable function, so this
  // lives entirely here and the release carries none of it.
  const orbitEye = eyePos;
  let dist = Math.hypot(...orbitEye().map((n, i) => n - TARGET[i]));
  eyePos = () => {
    const c = Math.cos(PITCH);
    return [
      TARGET[0] + dist * c * Math.sin(YAW),
      TARGET[1] + dist * Math.sin(PITCH),
      TARGET[2] + dist * c * Math.cos(YAW),
    ];
  };
  addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Multiplied, not stepped: a fixed amount per notch crawls when you are
      // far out and jumps clean through the model once you are close.
      //
      // The floor is well inside the unicorn — that is the point — which is why
      // debug builds also drop the near plane to 0.004. At the release's 0.1 the
      // surface you are trying to look at would clip away as you reached it.
      dist = Math.min(Math.max(dist * Math.exp(e.deltaY * 0.0012), 0.04), 24);
    },
    // Explicitly not passive: listeners on wheel default to passive, and a
    // passive listener may not preventDefault, so the page would scroll too.
    { passive: false },
  );

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
      'scroll to zoom · drag to rotate\n' +
      'back faces drawn · gait frozen (debug build)';

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
