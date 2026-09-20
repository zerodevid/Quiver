// Transaksi swap satu pool dari GeckoTerminal — dipakai server (market.js) DAN
// browser (web: TradesTape). Dipisah supaya browser bisa memanggil GeckoTerminal
// langsung: jatah ~30 panggilan/menit dihitung per IP, dan IP VPS sudah dipakai
// tiga instance bot untuk lilin harga. Dari browser, jatahnya milik penonton
// sendiri; server tinggal jadi cadangan kalau browser gagal (jaringan/429).
export const gtTradesUrl = (slug, pool) =>
  `https://api.geckoterminal.com/api/v2/networks/${slug}/pools/${pool}/trades?trade_volume_in_usd_greater_than=0`;

// Menyeragamkan jawaban GeckoTerminal: terbaru di depan.
//  - token: alamat token spekulatif; arah beli/jual dinyatakan terhadap token itu,
//    bukan terhadap "base" versi GeckoTerminal yang bisa terbalik dari UI.
//  - harga dalam aset kuotasi pool dihitung dari jumlah kedua sisi swap (bukan
//    price_*_in_currency_token, yang dihargai dalam koin native jaringan).
export function normalizeTrades(json, { token = null, limit = 80 } = {}) {
  const t = String(token || '').toLowerCase();
  const n = Math.max(10, Math.min(300, Number(limit) || 80));
  const lc = (a) => String(a || '').toLowerCase();
  const trades = [];
  for (const row of json?.data || []) {
    const a = row?.attributes; if (!a) continue;
    const from = lc(a.from_token_address), to = lc(a.to_token_address);
    // Beli = token spekulatif keluar dari pool ke wallet; tanpa alamat token,
    // ikut label GeckoTerminal.
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
