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

module.exports = { dlmmShape, shapeWeight, binWeights, weightDistribution, weightShare0, resolveStrategy, strategyLabel, STRATEGIES, CURVE_MAX, BIDASK_MIN };
