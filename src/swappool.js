'use strict';
// Pick the best pool for a DIRECT pool swap — the auto-swap fallback path.
//
// The main zap path stays Kyber: it routes across every DEX and pool on this chain.
// This fallback is used when Kyber has no route, the route loses too much, the tx is
// rejected by the chain repeatedly (stale quote), or Kyber is switched off in the config — the first
// three are all market matters. Kyber SAFEGUARD errors (router mismatch, calldata
// unreadable, receipt not yet confirmed) never fall through to here. The fallback
// used to use the position's own pool as it is — although that pool is often
// not the best place to swap: its fee can be 4–10%, its liquidity is so thin that
// even a small swap moves the price, and some pools (the hooked ones) refuse swaps via
// the UniversalRouter so the transaction reverts and the gas cost is burned for nothing.
//
// Here every pool containing that token pair is collected from the database,
// the results are estimated (fee + price impact), then the best candidate is SIMULATED with
// eth_call as the bot wallet. Only a swap whose simulation passes is sent: a pool
// that refuses swaps is filtered out at no cost. If none passes, the caller
// cancels the zap — the funds stay in the wallet.
//
// The estimate assumes constant liquidity throughout the price move (the same as the
// priceImpactBps the bot already uses). It is only for ORDERING candidates;
// the final truth is in the simulation, which uses the real amountOutMinimum.
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { RpcPool } = require('./rpc');
const { ensureChain } = require('./networks');
const m = require('./v3math');

const IF_POOL3 = new ethers.Interface(ABI.poolV3);
const lc = (t) => String(t || '').toLowerCase();
// The top bit of uint24 = dynamic fee marker, not a fee magnitude; the magnitude in effect
// now is read from the pool's slot0.
const DYNAMIC_FEE = 0x800000;
const MAX_CANDIDATES = 8;   // read from the chain
const MAX_SIMULATED = 4;    // simulated pools (v4: up to 2 calldatas per pool,
                            // see buildSwapV4) — all in one batch, not sequential

// Swap result (rough) in one pool, after fee, with liquidity assumed constant.
function estimate({ sqrtP, L, feePpm, amountIn, zeroForOne }) {
  if (!sqrtP || sqrtP <= 0n || L <= 0n || amountIn <= 0n) return null;
  if (!(feePpm >= 0) || feePpm >= 1_000_000) return null;
  const net = (amountIn * BigInt(1_000_000 - Math.round(feePpm))) / 1_000_000n;
  if (net <= 0n) return null;
  const after = m.sqrtAfterSwap(sqrtP, L, net, zeroForOne);
  if (after == null || after <= 0n) return null;
  const out = zeroForOne ? m.amount1ForLiquidity(after, sqrtP, L) : m.amount0ForLiquidity(sqrtP, after, L);
  if (out <= 0n) return null;
  return { out, impactBps: m.priceImpactBps(sqrtP, L, net, zeroForOne) };
}

// Pools containing EXACTLY this pair. The pair is matched as it is (without
// treating ETH as WETH): wrapping ETH is a step of its own, and a swap
// that needs that is no longer "one transaction to one pool".
function candidates(store, chain, tokenIn, tokenOut) {
  const a = lc(tokenIn), b = lc(tokenOut);
  return store.all(`SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks, pool_addr FROM pools
    WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?))`, chain.network, a, b, b, a);
}

/**
 * Pick a pool + swap transaction whose simulation passes.
 *
 * The caller MUST already have ensured the router allowance (ensureRouterAllowance) before this:
 * without an allowance every simulation fails and the result is "no pool accepts".
 *
 * @returns {{tx, pool, outEst, impactBps, sim}|null} null = nothing viable;
 *   `reason` on the object passed back via the `info` parameter explains why.
 */
async function pickSwapPool({ store, chain, rpc, exec, log = () => {} }, {
  tokenIn, tokenOut, amountIn, minOut, maxImpactBps = 0, deadlineSec, extra = [], info = {},
}) {
  chain = ensureChain(chain);
  // `extra`: pools the caller already has in hand (e.g. the pool of the position being opened)
  // — also evaluated even if not yet recorded in the pools table.
  const rows = [...extra];
  for (const r of candidates(store, chain, tokenIn, tokenOut)) {
    if (!rows.some((x) => lc(x.pool_ref) === lc(r.pool_ref))) rows.push(r);
  }
  info.found = rows.length;
  if (!rows.length) { info.reason = 'tidak ada pool yang memuat pasangan token ini'; return null; }

  // Hooked pools refuse swaps more often; plain ones go first when candidates
  // have to be trimmed, but still participate if the quota is left over.
  const polos = (r) => !r.hooks || /^0x0+$/.test(r.hooks);
  const ordered = [...rows].sort((x, y) => (polos(y) ? 1 : 0) - (polos(x) ? 1 : 0));
  const list = ordered.slice(0, MAX_CANDIDATES);
  const v4 = list.filter((r) => r.venue === 'v4');
  const v3 = list.filter((r) => chain.isV3Venue(r.venue) && r.pool_addr);

  // Two batches for v4 (slot0 + liquidity) and one for v3 — not sequential calls
  // per pool, so the zap does not stretch when the RPC is busy.
  const [slots4, liq4, v3res] = await Promise.all([
    v4.length ? chain.slot0V4Many(v4.map((r) => r.pool_ref)) : [],
    v4.length ? chain.poolLiquidityMany(v4.map((r) => r.pool_ref)) : [],
    v3.length ? rpc.ethCallMany(v3.flatMap((r) => [
      { to: r.pool_addr, data: IF_POOL3.encodeFunctionData('slot0') },
      { to: r.pool_addr, data: IF_POOL3.encodeFunctionData('liquidity') },
    ])) : [],
  ]);

  const scored = [];
  const add = (row, sqrtP, L, feePpm) => {
    const zeroForOne = lc(tokenIn) === lc(row.token0);
    const est = estimate({ sqrtP, L, feePpm, amountIn, zeroForOne });
    if (!est) return;
    if (maxImpactBps > 0 && est.impactBps != null && est.impactBps > maxImpactBps) {
      info.tooDeep = (info.tooDeep || 0) + 1;
      info.bestImpactBps = Math.min(info.bestImpactBps ?? Infinity, est.impactBps);
      return;
    }
    scored.push({ row, zeroForOne, feePpm, ...est });
  };

  v4.forEach((r, i) => {
    const s = slots4[i];
    if (!s) return;
    // Dynamic fee: the magnitude in effect now is in slot0, not in the fee column.
    const feePpm = r.fee & DYNAMIC_FEE ? s.lpFee : r.fee;
    add(r, s.sqrtPriceX96, liq4[i] || 0n, feePpm);
  });
  v3.forEach((r, i) => {
    const w = v3res[i * 2], wl = v3res[i * 2 + 1];
    if (!w || w === '0x' || !wl || wl === '0x') return;
    let sqrtP;
    try { sqrtP = BigInt(IF_POOL3.decodeFunctionResult('slot0', w)[0]); } catch { return; }
    add(r, sqrtP, BigInt(wl), r.fee);
  });

  info.scored = scored.length;
  if (!scored.length) {
    info.reason = info.tooDeep
      ? `dampak harga ${Math.round(info.bestImpactBps)} bps di pool terbaik (batas ${maxImpactBps})`
      : 'pool pasangan ini kosong atau harganya tidak terbaca';
    return null;
  }

  // Largest result first. The estimate is only an orderer; the simulation decides.
  scored.sort((a, b) => (a.out < b.out ? 1 : a.out > b.out ? -1 : 0));
  const top = scored.slice(0, MAX_SIMULATED);
  // One v4 pool can produce TWO candidate calldatas: two shapes of swap params circulate
  // in v4-periphery and the wrong one reverts without a message (see Executor#buildSwapV4).
  // As long as the correct shape is not proven, both go into the same
  // simulation batch — one RPC round trip, rather than a guess that silently kills this fallback.
  const attempt = [];
  top.forEach((c, rank) => {
    if (chain.isV3Venue(c.row.venue)) {
      attempt.push({ ...c, rank, tx: exec.buildSwapV3(tokenIn, tokenOut, c.row.fee, amountIn, minOut, deadlineSec) });
      return;
    }
    const pk = {
      currency0: c.row.token0, currency1: c.row.token1,
      fee: c.row.fee, tickSpacing: c.row.tick_spacing, hooks: c.row.hooks || ethers.ZeroAddress,
    };
    for (const layout of exec.v4SwapLayouts()) {
      attempt.push({ ...c, rank, layout, tx: exec.buildSwapV4(pk, c.zeroForOne, amountIn, minOut, deadlineSec, layout) });
    }
  });
  const from = exec.address();
  const sim = await rpc.batch(attempt.map((c) => {
    const tx = { to: c.tx.to, data: c.tx.data, from };
    if (c.tx.value != null && BigInt(c.tx.value) > 0n) tx.value = '0x' + BigInt(c.tx.value).toString(16);
    return { method: 'eth_call', params: [tx, 'latest'] };
  }));
  const ok = sim.findIndex((r) => r && !r.error);
  info.simulated = top.length;
  if (ok < 0) {
    // "Refused by the pool" is only valid if the RPC really answered REVERT. A reply that is
    // missing or a quota error (this chain often returns 429) used to be read the same as a revert,
    // so a momentary RPC disturbance was reported as the market refusing — and the zap was cancelled
    // although there was nothing wrong with the pool.
    const blind = sim.filter((r) => !r || r.transient || (r.error && !RpcPool.isRevert(r.error))).length;
    info.reason = blind
      ? `simulasi swap tidak terjawab RPC (${blind} dari ${attempt.length} panggilan) — bukan penolakan pool`
      : `${top.length} pool teratas menolak swap saat disimulasikan`;
    return null;
  }
  const pick = attempt[ok];
  exec.rememberV4Layout(pick.layout);
  if (pick.rank > 0) log(`pool swap terbaik menolak simulasi — pakai pilihan ke-${pick.rank + 1}: ${pick.row.pool_ref.slice(0, 10)}…`);
  return {
    tx: pick.tx, pool: pick.row, outEst: pick.out,
    impactBps: pick.impactBps, feePpm: pick.feePpm, rank: pick.rank,
  };
}

module.exports = { pickSwapPool, estimate, DYNAMIC_FEE };
