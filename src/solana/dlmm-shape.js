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

const strategyLabel = (s) => ({ spot: 'spot', curve: 'curve', bidask: 'bid-ask' }[s] || 'spot');

module.exports = { dlmmShape, shapeWeight, resolveStrategy, strategyLabel, STRATEGIES, CURVE_MAX, BIDASK_MIN };
