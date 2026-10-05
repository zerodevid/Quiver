// Swap transactions of one pool from GeckoTerminal — used by the server (market.js) AND the
// browser (web: TradesTape). Split out so the browser can call GeckoTerminal
// directly: the ~30 calls/minute quota is counted per IP, and the VPS IP is already used by
// three bot instances for price candles. From the browser the quota belongs to the viewer,
// and the server only acts as a fallback when the browser fails (network/429).
export const gtTradesUrl = (slug, pool) =>
  `https://api.geckoterminal.com/api/v2/networks/${slug}/pools/${pool}/trades?trade_volume_in_usd_greater_than=0`;

// Normalises GeckoTerminal's response: newest first.
//  - token: the speculative token address; buy/sell direction is stated relative to that token,
//    not to GeckoTerminal's "base", which can be inverted relative to the UI.
//  - the price in the pool's quote asset is computed from the amounts on both sides of the swap (not
//    price_*_in_currency_token, which is priced in the network's native coin).
export function normalizeTrades(json, { token = null, limit = 80 } = {}) {
  const t = String(token || '').toLowerCase();
  const n = Math.max(10, Math.min(300, Number(limit) || 80));
  const lc = (a) => String(a || '').toLowerCase();
  const trades = [];
  for (const row of json?.data || []) {
    const a = row?.attributes; if (!a) continue;
    const from = lc(a.from_token_address), to = lc(a.to_token_address);
    // Buy = the speculative token leaves the pool for the wallet; without a token address,
    // follow GeckoTerminal's label.
    const buy = t ? to === t : a.kind === 'buy';
    const fromAmt = Number(a.from_token_amount), toAmt = Number(a.to_token_amount);
    const base = buy ? toAmt : fromAmt, quote = buy ? fromAmt : toAmt;
    trades.push({
      ts: Date.parse(a.block_timestamp) || null, block: a.block_number ?? null, tx: a.tx_hash || null,
      wallet: lc(a.tx_from_address) || null, side: buy ? 'buy' : 'sell',
      base: Number.isFinite(base) ? base : null, quote: Number.isFinite(quote) ? quote : null,
      priceUsd: Number(buy ? a.price_to_in_usd : a.price_from_in_usd) || null,
      priceQuote: base > 0 && quote > 0 ? quote / base : null,
      usd: Number(a.volume_in_usd) || null,
    });
  }
  trades.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return trades.slice(0, n);
}
