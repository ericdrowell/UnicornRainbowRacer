// Track one monophonic line through the salience matrix with Viterbi.
//
// This is the fix for the noise. Picking the best pitch per row independently
// lets detector jitter become melody — a new note every 16th. Here the whole
// line is chosen at once, and changing note costs something, so a note is held
// unless the evidence for moving genuinely outweighs the penalty. Continuity
// stops being a nudge and becomes part of what is being optimised.
export function viterbi(S, { lo, hi, rows }, { switchCost = 2.4, leapCost = 0.16, restCost = 1.1, floor = 0.0 } = {}) {
  const N = hi - lo + 2;                       // state 0 = silence, then pitches
  const emit = (r, s) => (s === 0 ? floor : Math.log(1 + S[r][s - 1]));
  const cost = new Float64Array(N).fill(-1e9);
  const back = [];
  for (let s = 0; s < N; s++) cost[s] = emit(0, s) - (s === 0 ? 0 : restCost);
  for (let r = 1; r < rows; r++) {
    const next = new Float64Array(N).fill(-1e9);
    const bp = new Int16Array(N);
    for (let s = 0; s < N; s++) {
      const e = emit(r, s);
      for (let p = 0; p < N; p++) {
        let t = 0;
        if (p !== s) {
          t = -switchCost;
          if (p > 0 && s > 0) t -= leapCost * Math.min(24, Math.abs(s - p));
          if (s === 0 || p === 0) t = -restCost;
        }
        const v = cost[p] + t + e;
        if (v > next[s]) { next[s] = v; bp[s] = p; }
      }
    }
    back.push(bp);
    cost.set(next);
  }
  let s = 0, bestV = -1e9;
  for (let i = 0; i < N; i++) if (cost[i] > bestV) { bestV = cost[i]; s = i; }
  const path = new Array(rows);
  path[rows - 1] = s;
  for (let r = rows - 2; r >= 0; r--) { s = back[r][s]; path[r] = s; }
  return path.map((v) => (v === 0 ? 0 : v - 1 + lo));
}

/** Runs of equal pitch become notes; short ones are dropped as jitter. */
export function segment(path, { minRows = 2 } = {}) {
  const notes = [];
  let cur = 0, start = 0;
  const flush = (end) => { if (cur && end - start >= minRows) notes.push({ row: start, len: end - start, midi: cur }); };
  for (let r = 0; r < path.length; r++) {
    if (path[r] !== cur) { flush(r); cur = path[r]; start = r; }
  }
  flush(path.length);
  return notes;
}
