'use strict';
// Swap history for the Swap page: not just manual swaps, but every tx that
// exchanges assets — the zap when opening an LP, leftover sale when closing, selling back the zap token
// of an LP that did not happen (failed mint), selling claimed fees, ETH/USDG bridge, gas top-up,
// wrap/unwrap WETH — plus fee claims and compounds. Every row gets a `method`
// (where the swap came from) and a `route` (Kyber or a direct pool).
//
// Old rows did not record token & amount; they are guessed as well as possible from the detail available
// (pay/buy zap, positionSales, bridge direction) and the related position. Whatever cannot be
// guessed is left empty — the page shows only its USD value.

const KINDS = ['swap_manual', 'zap_swap', 'sell_leftover', 'bridge_swap', 'gas_topup', 'wrap_eth', 'unwrap_weth', 'claim_fees', 'compound'];
const lc = (t) => (t == null ? null : String(t).toLowerCase());
const big = (v) => { try { return v == null || v === '' ? null : BigInt(v); } catch { return null; } };

// Origin of a leftover-queue sale. Rows before `source` was recorded: a filled position = proceeds
// of closing the position; an empty position = a zap without an LP or a wallet sweep (indistinguishable).
function leftoverMethod(d) {
  if (d.source === 'fee') return 'fee_sell';
  if (d.source === 'zap') return 'unwind';
  if (d.source === 'wallet') return 'sweep';
  if (d.source === 'exit') return 'exit';
  return d.position == null ? 'leftover' : 'exit';
}

function methodOf(kind, d) {
  switch (kind) {
    case 'swap_manual': return 'manual';
    case 'zap_swap': return 'zap';
    case 'sell_leftover': return leftoverMethod(d);
    case 'bridge_swap': return 'bridge';
    case 'gas_topup': return 'gas';
    case 'wrap_eth': return 'wrap';
    case 'unwrap_weth': return 'unwrap';
    case 'claim_fees': return 'claim';
    case 'compound': return 'compound';
    default: return kind;
  }
}

function swapHistory({ store, chain, ethUsd = 0, limit = 40, kinds = KINDS }) {
  const { ADDR, QUOTES } = chain;
  const net = chain.network;
  const metaCache = new Map();
  const meta = (a) => {
    a = lc(a);
    if (!a) return null;
    if (!metaCache.has(a)) {
      const q = QUOTES[a];
      const r = q ? null : store.get('SELECT symbol, decimals FROM tokens WHERE chain=? AND address=?', net, a);
      metaCache.set(a, { symbol: q?.symbol || r?.symbol || null, decimals: q?.decimals ?? r?.decimals ?? 18 });
    }
    return metaCache.get(a);
  };
  const posCache = new Map();
  const pos = (id) => {
    if (id == null) return null;
    if (!posCache.has(id)) posCache.set(id, store.get('SELECT id, token0, token1 FROM positions WHERE id=?', id) || null);
    return posCache.get(id);
  };
  // [non-quote token, quote token] of a position.
  const sides = (p) => {
    if (!p) return [null, null];
    const t0 = lc(p.token0), t1 = lc(p.token1);
    if (QUOTES[t1] && !QUOTES[t0]) return [t0, t1];
    if (QUOTES[t0] && !QUOTES[t1]) return [t1, t0];
    return [t0, t1];
  };
  const human = (raw, token) => (raw == null || !token ? null : Number(raw) / 10 ** (meta(token)?.decimals ?? 18));
  const sym = (token) => meta(token)?.symbol || (token ? token.slice(0, 8) : null);

  const pick = kinds.filter((k) => KINDS.includes(k));
  if (!pick.length) return [];
  const rows = store.all(`SELECT hash, ts, kind, status, error, detail, gas_used, gas_price FROM txs
    WHERE chain=? AND kind IN (${pick.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT ?`, net, ...pick, limit);

  return rows.map((r) => {
    let d = {};
    try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* abaikan */ }
    const method = methodOf(r.kind, d);
    let tokenIn = lc(d.tokenIn), tokenOut = lc(d.tokenOut);
    let inRaw = big(d.amountInRaw), outRaw = big(d.gotOut);
    const p = pos(d.position);

    if (r.kind === 'zap_swap') {
      tokenIn = tokenIn || lc(d.pay); tokenOut = tokenOut || lc(d.buy);
      inRaw = inRaw ?? big(d.payRaw);
    } else if (r.kind === 'sell_leftover') {
      const [meme, quote] = sides(p);
      tokenIn = tokenIn || meme; tokenOut = tokenOut || quote;
      if (inRaw == null && Array.isArray(d.positionSales)) {
        inRaw = d.positionSales.reduce((a, x) => a + (big(x.amount) || 0n), 0n) || null;
      }
    } else if (r.kind === 'bridge_swap') {
      if (!tokenIn && d.wantEth != null) {
        tokenIn = d.wantEth ? ADDR.usdg : ADDR.native; tokenOut = d.wantEth ? ADDR.native : ADDR.usdg;
      }
      inRaw = inRaw ?? big(d.payRaw);
    } else if (r.kind === 'gas_topup') {
      tokenIn = tokenIn || ADDR.usdg; tokenOut = tokenOut || ADDR.native;
    } else if (r.kind === 'wrap_eth') {
      tokenIn = ADDR.native; tokenOut = ADDR.weth; outRaw = inRaw;
    } else if (r.kind === 'unwrap_weth') {
      tokenIn = ADDR.weth; tokenOut = ADDR.native; outRaw = inRaw;
    }

    // Fee claim: amount per side from fee_claims (read from the receipt when booked).
    let claim = null;
    if (r.kind === 'claim_fees' && p) {
      const c = store.get('SELECT amount0, amount1, value_quote FROM fee_claims WHERE tx_hash=?', r.hash);
      const t0 = lc(p.token0), t1 = lc(p.token1);
      claim = {
        token0: t0, token1: t1, symbol0: sym(t0), symbol1: sym(t1),
        amount0: c ? human(c.amount0, t0) : null, amount1: c ? human(c.amount1, t1) : null,
      };
      const [, quote] = sides(p);
      const q = QUOTES[quote];
      if (c && q) claim.usd = c.value_quote * (q.kind === 'eth' ? ethUsd : 1);
    }

    const swap = !['claim_fees', 'compound'].includes(r.kind);
    // Route: Kyber (aggregator) or a direct pool. `via` holds the poolRef for a direct
    // pool and 'kyber' for Kyber; manual swaps/gas top-ups are always Kyber.
    const direct = (d.via && d.via !== 'kyber') || (r.kind === 'bridge_swap' && d.pool && !d.dex) || /^pool /.test(d.dex || '');
    const route = !swap || r.kind === 'wrap_eth' || r.kind === 'unwrap_weth' ? null : direct ? 'pool' : d.aggregator || 'kyber';

    const gasUsd = r.gas_used && r.gas_price && ethUsd
      ? (Number(r.gas_used) * Number(BigInt(r.gas_price))) / 1e18 * ethUsd : null;
    const posPair = p ? `${sym(sides(p)[0])}/${sym(sides(p)[1])}` : null;
    return {
      hash: r.hash, ts: r.ts, status: r.status, error: r.error, kind: r.kind, method, route,
      position: d.position ?? null, pair: posPair, gasUsd, claim,
      detail: swap ? {
        tokenIn, tokenOut,
        symbolIn: d.symbolIn || sym(tokenIn), symbolOut: d.symbolOut || sym(tokenOut),
        amountIn: d.amountIn ?? human(inRaw, tokenIn),
        amountOut: d.amountOut ?? human(outRaw, tokenOut),
        usdIn: d.usdIn ?? null, usdOut: d.usdOut ?? null,
        dex: route === 'pool' ? null : route !== 'kyber' ? String(d.dex || '').replace(/^[^:]+: /, '') || null : d.dex || null,
      } : { usdIn: d.valueUsd ?? claim?.usd ?? null },
    };
  });
}

module.exports = { swapHistory, methodOf, KINDS };
