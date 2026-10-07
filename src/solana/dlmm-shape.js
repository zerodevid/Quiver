'use strict';
// Meteora DLMM liquidity shapes (spot / curve / bid-ask).
//
// A DLMM position records how much it holds in every bin, so the strategy that built it
// can be read back from its shape without any transaction history. Measured in VALUE
// per bin (X side: amount × bin price relative to the active bin; Y side: amount), on
// mainnet:
//   spot    : flat — outer third / inner third = 1.00 on every position checked
//   curve   : peaks at the active bin and falls off (0.21 on a CurveImBalanced open)
//   bid-ask : grows toward the edges (> 1 by construction)
// Bins that price has already crossed are converted X↔Y but keep roughly their value, so
// a freshly opened position classifies cleanly; an old one that has drifted may land in
// the ambiguous band and falls back to spot.

const STRATEGIES = ['spot', 'curve', 'bidask'];
const CURVE_MAX = 0.7;
const BIDASK_MIN = 1.4;

// bins: [{ binId, x, y }] (numbers, strings or bigints). Returns
// { strategy, ratio } or null when no side has enough bins to tell (fewer than 3).
function dlmmShape(bins, activeId, binStep) {
  const r = 1 + Number(binStep) / 10_000;
  const sides = [[], []];
  for (const b of bins || []) {
    const k = Number(b.binId) - Number(activeId);
    if (k > 0) sides[0].push({ d: k, v: Number(b.x || 0) * r ** k });
    else if (k < 0) sides[1].push({ d: -k, v: Number(b.y || 0) });
  }
  let logSum = 0, weight = 0;
  for (const s of sides) {
    const xs = s.filter((e) => e.v > 0).sort((a, b) => a.d - b.d);
    if (xs.length < 3) continue;
    const t = Math.max(1, Math.floor(xs.length / 3));
    const mean = (a) => a.reduce((acc, e) => acc + e.v, 0) / a.length;
    const ratio = mean(xs.slice(-t)) / mean(xs.slice(0, t));
    if (!(ratio > 0) || !Number.isFinite(ratio)) continue;
    logSum += Math.log(ratio) * xs.length; weight += xs.length;
  }
  if (!weight) return null;
  const ratio = Math.exp(logSum / weight);
  const strategy = ratio <= CURVE_MAX ? 'curve' : ratio >= BIDASK_MIN ? 'bidask' : 'spot';
  return { strategy, ratio };
}

// Relative value weight of a bin `d` bins away from the active bin, in a range whose
// farthest bin is `n` away. Only used to split a value into X/Y before handing it to
// the SDK, which then lays out the actual shape.
function shapeWeight(strategy, d, n) {
  if (strategy === 'curve') return n - d + 1;
  if (strategy === 'bidask') return d + 1;
  return 1;
}

// The strategy an entry should use: `rule` from rules.range.dlmm_strategy; 'mirror'
// follows the shape read from the target's position (spot when unknown).
function resolveStrategy(rule, detected) {
  if (STRATEGIES.includes(rule)) return rule;
  return STRATEGIES.includes(detected) ? detected : 'spot';
}

// The VALUE per bin of a position, lower..upper (Y raw units: x × bin price + y), scaled to
// 0..65535. This is the position's exact shape — an automation that deposits by weight (no
// spot/curve/bid-ask preset) is copied bin for bin from it. null when there is nothing to read.
function binWeights(bins, lower, upper, binStep) {
  const r = 1 + Number(binStep) / 10_000;
  const v = new Array(upper - lower + 1).fill(0);
  for (const b of bins || []) {
    const k = Number(b.binId) - lower;
    if (k < 0 || k >= v.length) continue;
    v[k] = Number(b.x || 0) * r ** Number(b.binId) + Number(b.y || 0);
  }
  const max = Math.max(...v);
  if (!(max > 0) || !Number.isFinite(max)) return null;
  return v.map((x) => Math.round((x / max) * 65535));
}

// Value weights -> the SDK's by-weight distribution at the CURRENT active bin: bins above it
// take X, below it Y, the active bin half of each. Each side in bps of that side's total
// (summing to 10000, the rounding remainder on its largest bin); X bps are by amount, so a
// bin's value weight is divided by its price.
function weightDistribution(weights, lower, activeId, binStep) {
  const r = 1 + Number(binStep) / 10_000;
  const xs = [], ys = [];
  weights.forEach((w, k) => {
    const b = lower + k;
    xs.push(b > activeId ? w / r ** (b - activeId) : b === activeId ? w / 2 : 0);
    ys.push(b < activeId ? w : b === activeId ? w / 2 : 0);
  });
  const bps = (a) => {
    const sum = a.reduce((s, x) => s + x, 0);
    if (!(sum > 0)) return a.map(() => 0);
    const out = a.map((x) => Math.floor((x / sum) * 10_000));
    out[a.indexOf(Math.max(...a))] += 10_000 - out.reduce((s, x) => s + x, 0);
    return out;
  };
  const bx = bps(xs), by = bps(ys);
  return weights.map((_, k) => ({ binId: lower + k, x: bx[k], y: by[k] }));
}

// Share of value in X for the weights at the active bin (the planner's X/Y split).
function weightShare0(weights, lower, activeId) {
  let x = 0, all = 0;
  weights.forEach((w, k) => { const b = lower + k; all += w; if (b > activeId) x += w; else if (b === activeId) x += w / 2; });
  return all > 0 ? x / all : 0.5;
}

const strategyLabel = (s) => ({ spot: 'spot', curve: 'curve', bidask: 'bid-ask' }[s] || 'spot');

// Value weights -> the deposits of a Meteora rebalance_liquidity at `activeId`. A rebalance
// deposit is linear in the distance from the active bin: Y side (bins <= active)
// y = y0 + deltaY·(active − bin), X side (bins > active) x·price = x0 + deltaX·(bin − active),
// both in Y raw units — the same value units as binWeights. So each side is cut into the fewest
// straight segments that stay within a tolerance of the weights (a preset shape is 1 segment per
// side), loosened until it fits `maxSegments`: the instruction carries every segment and has to
// fit one transaction. `value` = total value to lay out (Y raw units). Zero bins at the edges
// are dropped (the program shrinks the position to the bins that hold liquidity anyway).
// Returns [{ minDeltaId, maxDeltaId, x0, y0, deltaX, deltaY }] (BigInt amounts, signed) or null.
function rebalanceDeposits(weights, lower, activeId, value, { maxSegments = 8 } = {}) {
  if (!Array.isArray(weights) || !weights.some((w) => w > 0) || !(Number(value) > 0)) return null;
  const sum = weights.reduce((s, w) => s + w, 0);
  const v = weights.map((w) => (Number(value) * w) / sum);
  const max = Math.max(...v);
  // sides as points [t = distance from active, value, bin]; Y side includes the active bin
  const bid = [], ask = [];
  v.forEach((x, k) => {
    const b = lower + k;
    if (b <= activeId) bid.push([activeId - b, x, b]); else ask.push([b - activeId, x, b]);
  });
  const trim = (pts) => {
    let i = 0, j = pts.length - 1;
    while (i <= j && !(pts[i][1] > 0)) i++;
    while (j >= i && !(pts[j][1] > 0)) j--;
    return pts.slice(i, j + 1);
  };
  const sides = [trim(bid.sort((a, b) => a[0] - b[0])), trim(ask.sort((a, b) => a[0] - b[0]))];
  const cut = (pts, tol) => {
    const segs = [];
    for (let i = 0; i < pts.length;) {
      let j = i;
      while (j + 1 < pts.length) {
        const [t0, v0] = pts[i], [t1, v1] = pts[j + 1];
        const ok = pts.slice(i + 1, j + 1).every(([t, x]) => Math.abs(v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) - x) <= tol);
        if (!ok) break;
        j++;
      }
      segs.push([i, j]);
      i = j + 1;
    }
    return segs;
  };
  let segs = null;
  for (const f of [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 1]) {
    const s = sides.map((pts) => cut(pts, f * max));
    if (s[0].length + s[1].length <= maxSegments || f === 1) { segs = s; break; }
  }
  const out = [];
  sides.forEach((pts, side) => {
    for (const [i, j] of segs[side]) {
      const [t0, v0] = pts[i], [t1, v1] = pts[j];
      const slope = t1 > t0 ? Math.round((v1 - v0) / (t1 - t0)) : 0;
      const base = Math.round(v0 - slope * t0);   // value at distance 0; the line passes through the first bin
      const lo = Math.min(pts[i][2], pts[j][2]) - activeId, hi = Math.max(pts[i][2], pts[j][2]) - activeId;
      out.push(side === 0
        ? { minDeltaId: lo, maxDeltaId: hi, x0: 0n, y0: BigInt(base), deltaX: 0n, deltaY: BigInt(slope) }
        : { minDeltaId: lo, maxDeltaId: hi, x0: BigInt(base), y0: 0n, deltaX: BigInt(slope), deltaY: 0n });
    }
  });
  return out.length ? out.sort((a, b) => a.minDeltaId - b.minDeltaId) : null;
}

module.exports = { dlmmShape, shapeWeight, binWeights, weightDistribution, weightShare0, rebalanceDeposits, resolveStrategy, strategyLabel, STRATEGIES, CURVE_MAX, BIDASK_MIN };
