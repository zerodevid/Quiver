'use strict';
// Penyeragaman data OpenAPI GMGN (src/gmgn.js) dan pemanggilannya lewat Market.
// Jalankan: node test/gmgn.js
const assert = require('node:assert');
const { normalizeTokenInfo, normalizeTokenSecurity, normalizeWallets, normalizeWalletStats } = require('../src/gmgn');
const { Market } = require('../src/market');

let lulus = 0, gagal = 0;
async function uji(nama, fn) {
  try { await fn(); lulus++; console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  GAGAL ${nama}\n       ${e.message}`); }
}

const INFO = {
  address: '0xAbC', symbol: 'X', name: 'Token X', decimals: 18, total_supply: '1000000', circulating_supply: '800000',
  price: { price: '0.5', price_1h: '0.4', price_24h: '1', buys_1h: '10', sells_1h: '4', volume_1h: '1234', buy_volume_1h: '900', sell_volume_1h: '334', swaps_1h: '14', hot_level: 2 },
  liquidity: '50000', holder_count: 321, ath_price: '2', locked_ratio: '0.25', og: true, creation_timestamp: 1700000000,
  pool: { pool_address: '0xP00L', exchange: 'uniswap_v4', quote_symbol: 'USDG', liquidity: '50000', fee_ratio: '0.03' },
  dev: { creator_address: '0xDEV', creator_token_status: 'sell', creator_open_count: 7, cto_flag: 1, top_10_holder_rate: '0.62', ath_token_info: { ath_token: '0xOLD', symbol: 'OLD', ath_mc: '123456' } },
  link: { twitter_username: '@tokenx', website: 'https://x.io', gmgn: 'https://gmgn.ai/robinhood/token/0xabc' },
  stat: { top_10_holder_rate: '0.62', creator_hold_rate: '0.01', top_bundler_trader_percentage: '0.3', fresh_wallet_rate: '' },
  wallet_tags_stat: { smart_wallets: 3, renowned_wallets: 1, sniper_wallets: 0, whale_wallets: '2' },
};

(async () => {
  console.log('gmgn');

  await uji('token/info: string jadi angka, rasio jadi persen, perubahan harga per jendela dihitung', () => {
    const t = normalizeTokenInfo(INFO);
    assert.strictEqual(t.address, '0xabc');
    assert.strictEqual(t.priceUsd, 0.5);
    assert.strictEqual(t.mcapUsd, 0.5 * 800000, 'mcap = harga × pasokan beredar');
    assert.strictEqual(t.windows['1h'].change, 25, '0.4 -> 0.5 = +25%');
    assert.strictEqual(t.windows['24h'].change, -50);
    assert.strictEqual(t.windows['5m'].change, null, 'jendela tanpa data = null');
    assert.deepStrictEqual([t.windows['1h'].buys, t.windows['1h'].sells, t.windows['1h'].volume], [10, 4, 1234]);
    assert.strictEqual(t.stat.top10Pct, 62);
    assert.strictEqual(t.stat.freshWalletPct, null, 'string kosong = tidak ada');
    assert.strictEqual(t.tags.whale, 2);
    assert.strictEqual(t.dev.status, 'sell'); assert.strictEqual(t.dev.cto, true); assert.strictEqual(t.dev.athToken.mcapUsd, 123456);
    assert.strictEqual(t.links.twitter, 'https://x.com/tokenx');
    assert.strictEqual(t.pool.feePct, 3); assert.strictEqual(t.createdAt, 1700000000000);
    assert.strictEqual(t.lockedPct, 25);
  });

  await uji('token/security: yes/no jadi boolean, pajak & rug jadi persen, status dev diterjemahkan', () => {
    const s = normalizeTokenSecurity({ is_honeypot: 'no', open_source: 'yes', owner_renounced: 'unknown', buy_tax: '0.03', sell_tax: '0', rug_ratio: '0.42', is_wash_trading: true, creator_token_status: 'creator_close', sniper_count: '5', burn_status: 'burn' });
    assert.strictEqual(s.honeypot, false); assert.strictEqual(s.openSource, true); assert.strictEqual(s.ownerRenounced, null);
    assert.strictEqual(s.buyTaxPct, 3); assert.strictEqual(s.sellTaxPct, 0); assert.strictEqual(s.rugPct, 42);
    assert.strictEqual(s.washTrading, true); assert.strictEqual(s.creatorSold, true); assert.strictEqual(s.sniperCount, 5); assert.strictEqual(s.lpBurned, true);
    assert.strictEqual(normalizeTokenSecurity({ is_honeypot: '' }).honeypot, null, 'SOL mengirim string kosong');
  });

  await uji('top holders/traders: baris diseragamkan, pool ditandai, tag dibawa', () => {
    const rows = normalizeWallets({ list: [
      { address: '0xAA', wallet_tag_v2: 'TOP1', addr_type: 2, exchange: 'uniswap_v4', amount_percentage: '0.4', usd_value: '1000' },
      { address: '0xBB', addr_type: 0, amount_percentage: '0.05', balance: '5000', avg_cost: '0.1', sell_amount_percentage: '1', profit: '-12.5', profit_change: '-0.2', is_new: true, tags: ['kol'], maker_token_tags: ['paper_hands'], start_holding_at: 1700000000, end_holding_at: 1700003600, native_transfer: { address: '0xFUND', name: 'binance' } },
      { nope: true },
    ] });
    assert.strictEqual(rows.length, 2);
    assert.ok(rows[0].isPool && rows[0].exchange === 'uniswap_v4' && rows[0].pct === 40 && rows[0].usd === 1000);
    const b = rows[1];
    assert.ok(!b.isPool && b.pct === 5 && b.balance === 5000 && b.avgCost === 0.1 && b.soldPct === 100 && b.profit === -12.5 && b.profitPct === -20);
    assert.ok(b.isNew && b.tags[0] === 'kol' && b.tokenTags[0] === 'paper_hands' && b.exitAt === 1700003600000 && b.fundFrom === '0xfund' && b.fundFromName === 'binance');
    assert.strictEqual(normalizeWallets([{ address: '0xCC' }]).length, 1, 'array telanjang diterima');
  });

  await uji('wallet_stats: objek telanjang atau array; identitas dari common', () => {
    const raw = { realized_profit: '120.5', unrealized_profit: '-3', winrate: '0.6', total_cost: '1000', buy_count: 12, sell_count: 9, pnl: '0.1205', common: { name: 'whale1', tags: ['smart_money'], twitter_username: 'w1', followers_count: '1500', created_at: 1600000000, fund_from: 'Binance', fund_from_address: '0xF' } };
    const w = normalizeWalletStats(raw, '7d');
    assert.strictEqual(w.realized, 120.5); assert.strictEqual(w.winratePct, 60); assert.ok(Math.abs(w.pnlPct - 12.05) < 1e-9);
    assert.strictEqual(w.name, 'whale1'); assert.deepStrictEqual(w.tags, ['smart_money']); assert.strictEqual(w.followers, 1500); assert.strictEqual(w.createdAt, 1600000000000);
    assert.strictEqual(normalizeWalletStats([raw]).buys, 12, 'batch = array');
    assert.strictEqual(normalizeWalletStats({ realized_profit: '1' }).tags.length, 0, 'tanpa common tidak meledak');
    // Bentuk nyata jawaban server (beda dari dokumentasi): buy/sell, realized_profit_pnl, pnl_stat.*
    const real = normalizeWalletStats({ realized_profit: '-407.99', realized_profit_pnl: '-0.0293', buy: 26, sell: 156, total_cost: '14106', last_timestamp: 1789961619,
      pnl_stat: { token_num: 100, winrate: 0.194, pnl_lt_nd5_num: 5, pnl_nd5_0x_num: 49, pnl_0x_2x_num: 46, pnl_2x_5x_num: 0, pnl_gt_5x_num: 0, avg_holding_period: 231843 }, common: { name: '', tags: [], fund_from_address: '0x22D9' } });
    assert.strictEqual(real.buys, 26); assert.strictEqual(real.sells, 156); assert.ok(Math.abs(real.pnlPct + 2.93) < 1e-9); assert.ok(Math.abs(real.winratePct - 19.4) < 1e-9);
    assert.strictEqual(real.tokens, 100); assert.deepStrictEqual(real.dist, [5, 49, 46, 0, 0]); assert.strictEqual(real.avgHoldSec, 231843); assert.strictEqual(real.lastActive, 1789961619000);
    assert.strictEqual(real.name, null, 'string kosong = tidak ada'); assert.strictEqual(real.fundFromAddress, '0x22d9');
  });

  await uji('status dev: hold/sell (token/info) dan creator_hold/creator_close (security) disamakan', () => {
    for (const [raw, want] of [['hold', 'hold'], ['sell', 'sell'], ['creator_hold', 'hold'], ['creator_close', 'sell'], ['', null], [undefined, null]]) {
      assert.strictEqual(normalizeTokenInfo({ dev: { creator_token_status: raw } }).dev.status, want, String(raw));
    }
  });

  await uji('Market.gmgn: kena limit dicoba ulang sekali setelah jeda; panggilan diberi jarak sesuai bobot', async () => {
    let n = 0; const at = [];
    const mk = new Market({ chain: { gmgn: 'robinhood' }, gmgnKey: () => 'k', fetch: async () => {
      n++; at.push(Date.now());
      if (n === 1) return { ok: false, status: 200, json: async () => ({ code: 1, error: 'RATE_LIMIT_EXCEEDED', message: 'IP rate limit exceeded' }) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ address: '0xAA', amount_percentage: '0.1' }] } }) };
    } });
    const t0 = Date.now();
    const r = await mk.gmgnWallets('0xabc', { kind: 'traders' });
    assert.strictEqual(r.rows.length, 1, 'percobaan kedua lolos');
    assert.strictEqual(n, 2);
    assert.ok(Date.now() - t0 >= 1400, 'ada jeda sebelum percobaan ulang');
    assert.strictEqual(mk.gmgnCooldown, 0, 'lolos = tidak ada penahanan');
    // Bobot 5 baru saja dipakai: panggilan berikutnya (bobot 1) menunggu ~1 detik.
    const t1 = Date.now();
    await mk.gmgn('/v1/token/info', { address: '0xabc' });
    assert.ok(Date.now() - t1 >= 900, `jarak antar panggilan ${Date.now() - t1} ms`);
  });

  await uji('Market: tanpa key semua endpoint GMGN menjawab enabled:false tanpa panggilan keluar', async () => {
    const calls = [];
    const mk = new Market({ fetch: async (u) => { calls.push(u); throw new Error('tidak boleh dipanggil'); } });
    assert.deepStrictEqual(await mk.gmgnToken('0xabc'), { enabled: false });
    assert.deepStrictEqual(await mk.gmgnWallets('0xabc'), { enabled: false });
    assert.deepStrictEqual(await mk.gmgnWallet('0xabc'), { enabled: false });
    assert.strictEqual(calls.length, 0);
  });

  await uji('Market.gmgnToken: info + security paralel, satu gagal tetap jalan, di-cache 60 detik', async () => {
    const calls = [];
    const mk = new Market({ chain: { gmgn: 'robinhood' }, gmgnKey: () => 'k', fetch: async (u) => {
      calls.push(u);
      if (u.includes('/v1/token/security')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: INFO }) };
    } });
    const r = await mk.gmgnToken('0xABC');
    assert.ok(r.enabled && r.symbol === 'X' && r.security === null && /500/.test(r.securityError), JSON.stringify(r).slice(0, 200));
    assert.ok(calls.some((u) => u.includes('/v1/token/info?') && u.includes('chain=robinhood') && u.includes('address=0xabc')));
    await mk.gmgnToken('0xabc');
    assert.strictEqual(calls.length, 2, 'panggilan kedua dari cache');
  });

  await uji('Market.gmgnWallets/gmgnWallet: jalur, parameter, dan bentuk jawaban', async () => {
    const calls = [];
    const mk = new Market({ chain: { gmgn: 'bsc' }, gmgnKey: () => 'k', fetch: async (u) => {
      calls.push(new URL(u));
      if (u.includes('wallet_stats')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { winrate: '0.5', realized_profit: '1' } }) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ address: '0xAA', amount_percentage: '0.1' }] } }) };
    } });
    const h = await mk.gmgnWallets('0xabc', { kind: 'traders', limit: 20, orderBy: 'profit' });
    assert.strictEqual(h.kind, 'traders'); assert.strictEqual(h.rows[0].pct, 10);
    const u = calls[0];
    assert.strictEqual(u.pathname, '/v1/market/token_top_traders');
    assert.strictEqual(u.searchParams.get('chain'), 'bsc'); assert.strictEqual(u.searchParams.get('limit'), '20'); assert.strictEqual(u.searchParams.get('order_by'), 'profit');
    const w = await mk.gmgnWallet('0xDEF', { period: '30d' });
    assert.strictEqual(w.winratePct, 50); assert.strictEqual(w.period, '30d');
    assert.strictEqual(calls[1].pathname, '/v1/user/wallet_stats'); assert.strictEqual(calls[1].searchParams.get('wallet_address'), '0xdef'); assert.strictEqual(calls[1].searchParams.get('period'), '30d');
  });

  console.log(`\n${lulus} lulus, ${gagal} gagal`);
  process.exit(gagal ? 1 : 0);
})();
