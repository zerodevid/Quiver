'use strict';
const { ensureChain } = require('./networks');
// Modal wallet yang sesungguhnya: berapa yang pernah disetor (dan ditarik), supaya
// dasbor bisa menunjukkan PnL BERSIH = nilai wallet sekarang − modal.
//
// "Total PnL" per-posisi (out − cost) sengaja tidak memuat biaya di luar posisi:
// fee + slippage zap swap saat masuk, gas ~200 tx, swap bolak-balik ETH↔USDG. Pemilik
// wallet menghitungnya dari sisi lain: "modal 400, sekarang 520, berarti untung 120".
// Angka itu yang dilacak di sini.
//
//   modal(t) = nilai wallet saat bot mulai mencatat (baseline)
//            + setoran eksternal setelahnya − penarikan eksternal setelahnya
//
// Setoran/penarikan dibaca lewat alchemy_getAssetTransfers (hanya kalau ada endpoint
// Alchemy di config) — transfer ETH/USDG/WETH yang lawan transaksinya BUKAN kontrak
// dan transaksinya BUKAN transaksi bot. Tanpa Alchemy, modal tidak diketahui dan
// dasbor kembali ke tampilan lama.
const { ethers } = require('ethers');

const MIN_USD = 0.05;   // di bawah ini debu (refund gas, airdrop iseng), bukan setoran

class Capital {
  constructor({ rpc, store, chain, cfg, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.lastSync = 0;
    const ADDR = chain.ADDR;
    this.ASSETS = {
      eth: { symbol: chain.nativeSymbol, decimals: 18, token: ADDR.native, kind: 'eth' },
      [ADDR.usdg]: { symbol: chain.QUOTES[ADDR.usdg]?.symbol, decimals: chain.QUOTES[ADDR.usdg]?.decimals ?? 6, token: ADDR.usdg, kind: 'usd' },
      [ADDR.weth]: { symbol: chain.QUOTES[ADDR.weth]?.symbol, decimals: 18, token: ADDR.weth, kind: 'eth' },
    };
    // Lawan transaksi yang pasti bukan orang: uang yang ke sini bukan penarikan.
    // Kontrak lain (router Kyber, dsb.) ketahuan lewat eth_getCode dan diingat.
    this.KNOWN = new Set([ADDR.poolManager, ADDR.posmV4, ADDR.permit2, ADDR.weth, ADDR.npmV3,
      ...chain.venues.map((v) => v.npmV3)].filter(Boolean).map((a) => String(a).toLowerCase()));
    // deposits: berbagi satu tabel/DB antar chain (wallet sama) — chain jadi bagian
    // dari kuncinya supaya setoran/penarikan di satu chain tidak mencampuri baseline
    // modal chain yang lain.
    store.db.exec(`CREATE TABLE IF NOT EXISTS deposits (
      chain        TEXT NOT NULL DEFAULT 'robinhood',
      tx_hash      TEXT NOT NULL,
      uid          TEXT NOT NULL,        -- uniqueId Alchemy (satu tx bisa memuat beberapa transfer)
      ts           INTEGER NOT NULL, block INTEGER NOT NULL,
      kind         TEXT NOT NULL,        -- deposit | withdraw
      token        TEXT, symbol TEXT, amount TEXT,
      usd          REAL NOT NULL, eth_usd REAL,
      counterparty TEXT,
      PRIMARY KEY (chain, tx_hash, uid)
    )`);
    const cols = new Set(store.db.prepare('PRAGMA table_info(deposits)').all().map((c) => c.name));
    if (!cols.has('chain')) store.db.exec("ALTER TABLE deposits ADD COLUMN chain TEXT NOT NULL DEFAULT 'robinhood'");
  }

  alchemyUrl() {
    const ep = (this.cfg.chain?.endpoints || []).find((e) => /g\.alchemy\.com\/v2\/[^$]+$/.test(String(e.url || '')));
    return ep ? ep.url : null;
  }
  available() { return !!this.alchemyUrl(); }

  async alchemy(method, params) {
    const r = await fetch(this.alchemyUrl(), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }

  async transfers(wallet, dir, fromBlock) {
    const out = [];
    let pageKey = null;
    do {
      const params = {
        fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest', category: ['external', 'erc20'],
        contractAddresses: [this.chain.ADDR.usdg, this.chain.ADDR.weth], withMetadata: true, maxCount: '0x3e8', order: 'asc',
        [dir === 'in' ? 'toAddress' : 'fromAddress']: wallet,
      };
      if (pageKey) params.pageKey = pageKey;
      const res = await this.alchemy('alchemy_getAssetTransfers', [params]);
      // `contractAddresses` hanya menyaring erc20; transfer ETH (external) tetap ikut.
      out.push(...(res.transfers || []));
      pageKey = res.pageKey || null;
    } while (pageKey);
    return out;
  }

  // Alamat punya kode? (kontrak → bukan tujuan penarikan). Disimpan: jawabannya tetap.
  async isContract(addr) {
    const a = String(addr || '').toLowerCase();
    if (!a || a === '0x') return false;
    if (this.KNOWN.has(a)) return true;
    const k = `code:${this.chain.network}:${a}`;
    const c = this.store.getState(k);
    if (c != null) return c === '1';
    const code = await this.rpc.call('eth_getCode', [a, 'latest']);
    const yes = !!code && code !== '0x';
    this.store.setState(k, yes ? '1' : '0');
    return yes;
  }

  // Blok terakhir yang timestamp-nya ≤ ts (pencarian biner, ~26 panggilan; sekali saja).
  async blockAt(ts) {
    const sec = Math.floor(ts / 1000);
    const at = async (n) => parseInt((await this.rpc.call('eth_getBlockByNumber', ['0x' + n.toString(16), false]))?.timestamp || '0', 16);
    let lo = 0, hi = await this.rpc.blockNumber();
    if ((await at(hi)) <= sec) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((await at(mid)) <= sec) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Baseline: nilai wallet saat bot mulai mencatat ekuitas — kas di blok itu (arsip)
  // + modal posisi yang sudah ada (diadopsi). Dihitung sekali, disimpan di state.
  async baseline(wallet) {
    const bKey = `capital_baseline:${this.chain.network}`;
    const saved = this.store.getState(bKey);
    if (saved) return JSON.parse(saved);
    const first = this.store.get('SELECT MIN(ts) ts FROM equity WHERE chain=?', this.chain.network)?.ts;
    const ts = first || Date.now();
    const block = await this.blockAt(ts);
    // Saldo di blok lampau lewat Alchemy (arsip penuh). Endpoint arsip lain di kolam
    // bisa membalas "header not found" untuk blok lama, dan kolam menganggapnya jawaban.
    const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
    const data = IF.encodeFunctionData('balanceOf', [wallet]);
    const tag = '0x' + block.toString(16);
    const [usdgW, wethW, ethHex] = await Promise.all([
      this.alchemy('eth_call', [{ to: this.chain.ADDR.usdg, data }, tag]), this.alchemy('eth_call', [{ to: this.chain.ADDR.weth, data }, tag]),
      this.alchemy('eth_getBalance', [wallet, tag]),
    ]);
    const ethRaw = BigInt(ethHex);
    const usdg = Number(BigInt(usdgW && usdgW !== '0x' ? usdgW : 0)) / 10 ** (this.ASSETS[this.chain.ADDR.usdg]?.decimals ?? 6);
    const weth = Number(BigInt(wethW && wethW !== '0x' ? wethW : 0)) / 1e18;
    const eth = Number(ethRaw) / 1e18;
    const ethUsd = await this.chain.ethUsdAt(block);
    // posisi yang sudah terbuka sebelum titik ini: modalnya bagian dari baseline
    const ethLike = new Set([this.chain.nativeSymbol, this.chain.QUOTES[this.chain.ADDR.weth]?.symbol].filter(Boolean));
    const pos = this.store.all("SELECT cost_quote, quote_symbol FROM positions WHERE chain=? AND status IN ('open','closed') AND opened_ts IS NOT NULL AND opened_ts <= ?", this.chain.network, ts);
    const positionsUsd = pos.reduce((a, p) => a + (p.cost_quote || 0) * (ethLike.has(p.quote_symbol) ? ethUsd : 1), 0);
    const cashUsd = usdg + (eth + weth) * ethUsd;
    const b = { ts, block, usd: cashUsd + positionsUsd, cashUsd, positionsUsd, ethUsd, usdg, eth, weth };
    this.store.setState(bKey, JSON.stringify(b));
    this.store.setState(`deposits_scanned_to:${this.chain.network}`, String(block));
    this.log(`modal dasar (${this.chain.label}): $${b.usd.toFixed(2)} (kas $${cashUsd.toFixed(2)} + posisi $${positionsUsd.toFixed(2)}) pada blok ${block}`);
    return b;
  }

  // Pindai setoran/penarikan baru. Dipanggil berkala; murah kalau tidak ada yang baru.
  async sync(wallet) {
    if (!wallet || !this.available()) return null;
    this.lastSync = Date.now();   // juga saat gagal: jangan dihajar tiap tick
    const me = String(wallet).toLowerCase();
    const base = await this.baseline(me);
    const from = Number(this.store.getState(`deposits_scanned_to:${this.chain.network}`, base.block)) + 1;
    const head = await this.rpc.blockNumber();
    if (head < from) return { added: 0 };
    const [ins, outs] = await Promise.all([this.transfers(me, 'in', from), this.transfers(me, 'out', from)]);
    const ours = new Set(this.store.all('SELECT hash FROM txs WHERE chain=?', this.chain.network).map((r) => r.hash.toLowerCase()));
    const senderOf = new Map();
    const sender = async (hash) => {
      if (!senderOf.has(hash)) senderOf.set(hash, String((await this.rpc.call('eth_getTransactionByHash', [hash]))?.from || '').toLowerCase());
      return senderOf.get(hash);
    };
    let added = 0;
    for (const t of [...ins.map((x) => ({ dir: 'in', ...x })), ...outs.map((x) => ({ dir: 'out', ...x }))]) {
      const hash = String(t.hash).toLowerCase();
      if (ours.has(hash)) continue;                        // transaksi bot sendiri (swap, mint, tutup)
      const key = t.category === 'external' ? 'eth' : String(t.rawContract?.address || '').toLowerCase();
      const asset = this.ASSETS[key];
      if (!asset) continue;
      const raw = BigInt(t.rawContract?.value || '0x0');
      if (raw === 0n) continue;
      const cp = String(t.dir === 'in' ? t.from : t.to || '').toLowerCase();
      const from = await sender(hash);
      if (t.dir === 'in') {
        // uang masuk dari transaksi yang kita kirim sendiri = hasil swap/tutup, bukan setoran
        if (from === me) continue;
      } else {
        // keluar: hanya kalau kita yang mengirim, ke alamat yang bukan kontrak
        if (from !== me) continue;
        if (await this.isContract(cp)) continue;
      }
      const block = parseInt(t.blockNum, 16);
      const ts = Date.parse(t.metadata?.blockTimestamp) || Date.now();
      const amount = Number(raw) / 10 ** asset.decimals;
      const ethUsd = asset.kind === 'usd' ? null : await this.chain.ethUsdAt(block);
      const usd = asset.kind === 'usd' ? amount : amount * ethUsd;
      if (usd < MIN_USD) continue;
      const r = this.store.run(`INSERT OR IGNORE INTO deposits(chain,tx_hash,uid,ts,block,kind,token,symbol,amount,usd,eth_usd,counterparty)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, this.chain.network, hash, String(t.uniqueId || `${hash}:${t.dir}`), ts, block, t.dir === 'in' ? 'deposit' : 'withdraw',
      asset.token, asset.symbol, raw.toString(), usd, ethUsd, cp);
      if (Number(r.changes)) {
        added++;
        this.log(`${t.dir === 'in' ? 'setoran' : 'penarikan'} terdeteksi: ${amount} ${asset.symbol} ($${usd.toFixed(2)}) ${t.dir === 'in' ? 'dari' : 'ke'} ${cp.slice(0, 10)}… tx ${hash.slice(0, 10)}…`);
      }
    }
    this.store.setState(`deposits_scanned_to:${this.chain.network}`, String(head));
    this.syncedAt = Date.now();
    return { added };
  }

  rows() { return this.store.all('SELECT * FROM deposits WHERE chain=? ORDER BY ts', this.chain.network); }

  // Modal pada waktu `ts` (default: sekarang). null kalau baseline belum ada.
  capitalAt(ts = Date.now()) {
    const saved = this.store.getState(`capital_baseline:${this.chain.network}`);
    if (!saved) return null;
    const b = JSON.parse(saved);
    const d = this.store.get(`SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN usd ELSE -usd END),0) s FROM deposits WHERE chain=? AND ts <= ?`, this.chain.network, ts)?.s || 0;
    return b.usd + d;
  }

  summary() {
    const saved = this.store.getState(`capital_baseline:${this.chain.network}`);
    if (!saved) return null;
    const b = JSON.parse(saved);
    const agg = this.store.get(`SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN usd ELSE 0 END),0) dep,
      COALESCE(SUM(CASE WHEN kind='withdraw' THEN usd ELSE 0 END),0) wd, COUNT(*) n FROM deposits WHERE chain=?`, this.chain.network);
    return {
      baselineUsd: b.usd, baselineTs: b.ts, depositsUsd: agg.dep, withdrawalsUsd: agg.wd, count: agg.n,
      capitalUsd: b.usd + agg.dep - agg.wd, syncedAt: this.syncedAt || null,
    };
  }
}

module.exports = { Capital };
