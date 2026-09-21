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
// Setoran/penarikan dibaca dari RPC publik biasa — dulu lewat alchemy_getAssetTransfers,
// yang berhenti begitu kuota bulanan Alchemy habis (dua hari setoran tak tercatat,
// PnL bersih melonjak sebesar setoran). Dua jalur:
//   - USDG/WETH: log Transfer ke/dari wallet (eth_getLogs, rentang panjang boleh —
//     endpoint resmi menjawab 1,4 jt blok dalam 0,3 detik). Transfer dari transaksi
//     bot sendiri atau transaksi yang kita kirim (swap manual) bukan setoran; keluar
//     ke kontrak (router, pool) bukan penarikan.
//   - ETH: transfer ETH polos tidak punya log. Yang dipakai selisih saldo: saldo di
//     ujung jendela − saldo di awal − perubahan saldo oleh transaksi bot (saldo blok
//     tx dikurangi saldo blok sebelumnya, dari node arsip). Sisa yang tidak dijelaskan
//     transaksi bot = setoran (positif) atau penarikan (negatif). Butuh endpoint
//     `archive: true`; tanpa itu hanya USDG/WETH yang terlacak.
const { ethers } = require('ethers');
const { getLogsSafe } = require('./scout');

const MIN_USD = 0.05;   // di bawah ini debu (refund gas, airdrop iseng), bukan setoran
const ETH_TX_BLOCKS = 25; // blok tx bot per sync untuk selisih saldo ETH (2 getBalance arsip per blok)
const ETH_EVENTS = 3;     // titik perubahan tak dijelaskan yang ditelusuri per sync (~20 getBalance arsip tiap titik)
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const hex = (n) => '0x' + BigInt(n).toString(16);
const topicOf = (addr) => '0x' + String(addr).toLowerCase().slice(2).padStart(64, '0');
const addrOf = (topic) => '0x' + String(topic).slice(-40).toLowerCase();

class Capital {
  constructor({ rpc, store, chain, cfg, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.lastSync = 0;
    this.backlog = false;
    const ADDR = chain.ADDR;
    this.ASSETS = {
      eth: { symbol: chain.nativeSymbol, decimals: 18, token: ADDR.native, kind: 'eth' },
      [ADDR.usdg]: { symbol: chain.QUOTES[ADDR.usdg]?.symbol, decimals: chain.QUOTES[ADDR.usdg]?.decimals ?? 6, token: ADDR.usdg, kind: 'usd' },
      [ADDR.weth]: { symbol: chain.QUOTES[ADDR.weth]?.symbol, decimals: 18, token: ADDR.weth, kind: 'eth' },
    };
    // Lawan transaksi yang pasti bukan orang: uang yang ke sini bukan penarikan.
    // Kontrak lain (router Kyber, dsb.) ketahuan lewat eth_getCode dan diingat.
    // Alamat nol ikut: WETH yang di-unwrap manual tercatat sebagai Transfer ke 0x0 —
    // ETH-nya tetap di wallet, bukan penarikan.
    this.KNOWN = new Set([ADDR.poolManager, ADDR.posmV4, ADDR.permit2, ADDR.weth, ADDR.npmV3, '0x' + '0'.repeat(40),
      ...chain.venues.map((v) => v.npmV3)].filter(Boolean).map((a) => String(a).toLowerCase()));
    // deposits: berbagi satu tabel/DB antar chain (wallet sama) — chain jadi bagian
    // dari kuncinya supaya setoran/penarikan di satu chain tidak mencampuri baseline
    // modal chain yang lain.
    store.db.exec(`CREATE TABLE IF NOT EXISTS deposits (
      chain        TEXT NOT NULL DEFAULT 'robinhood',
      tx_hash      TEXT NOT NULL,
      uid          TEXT NOT NULL,        -- hash:logIndex; setoran ETH dari selisih saldo: eth:<dari>-<sampai>
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

  available() { return true; }
  sk(k) { return `${k}:${this.chain.network}`; }

  // Beberapa panggilan sekaligus, hasilnya urut; satu item galat = seluruhnya gagal
  // (jendela dipindai ulang nanti — tidak ada yang dicatat setengah).
  async many(calls, opts = {}) {
    if (!calls.length) return [];
    const res = await this.rpc.batch(calls, opts);
    return res.map((r, i) => {
      if (!r) throw new Error(`${calls[i].method}: tidak ada balasan`);
      if (r.error) throw new Error(`${calls[i].method}: ${r.error.message}`);
      return r.result;
    });
  }
  // Saldo di blok lampau hanya ke endpoint arsip. Tanpa arsip di kolam: endpoint biasa
  // masih menjawab untuk blok baru (baseline dihitung di blok saat bot mulai).
  archiveOpt() { return { archive: !!this.rpc.hasArchive?.() }; }
  async balanceAt(wallet, block) {
    const r = await this.rpc.call('eth_getBalance', [wallet, hex(block)], this.archiveOpt());
    if (typeof r !== 'string' || !/^0x[0-9a-f]*$/i.test(r)) throw new Error(`eth_getBalance @${block}: balasan bukan angka`);
    return BigInt(r);
  }
  async blockTs(block) {
    const b = await this.rpc.call('eth_getBlockByNumber', [hex(block), false]);
    if (!b?.timestamp) throw new Error(`blok ${block} belum ada di endpoint`);
    return parseInt(b.timestamp, 16) * 1000;
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
    const bKey = this.sk('capital_baseline');
    const saved = this.store.getState(bKey);
    if (saved) return JSON.parse(saved);
    const first = this.store.get('SELECT MIN(ts) ts FROM equity WHERE chain=?', this.chain.network)?.ts;
    const ts = first || Date.now();
    const block = await this.blockAt(ts);
    const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
    const data = IF.encodeFunctionData('balanceOf', [wallet]);
    const [usdgW, wethW, ethRaw] = await Promise.all([
      this.rpc.callAt(this.chain.ADDR.usdg, data, block), this.rpc.callAt(this.chain.ADDR.weth, data, block),
      this.balanceAt(wallet, block),
    ]);
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
    this.store.setState(this.sk('deposits_scanned_to'), String(block));
    // titik awal selisih saldo ETH: saldo yang sama dengan baseline
    this.store.setState(this.sk('capital_eth_checkpoint'), JSON.stringify({ block, wei: ethRaw.toString(), ts }));
    this.log(`modal dasar (${this.chain.label}): $${b.usd.toFixed(2)} (kas $${cashUsd.toFixed(2)} + posisi $${positionsUsd.toFixed(2)}) pada blok ${block}`);
    return b;
  }

  // Pindai setoran/penarikan baru. Dipanggil berkala; murah kalau tidak ada yang baru.
  // Dua kursor terpisah (log token; selisih saldo ETH) supaya gangguan node arsip
  // tidak ikut menahan pencatatan setoran USDG.
  async sync(wallet) {
    if (!wallet) return null;
    this.lastSync = Date.now();   // juga saat gagal: jangan dihajar tiap tick
    const me = String(wallet).toLowerCase();
    const base = await this.baseline(me);
    // Beberapa blok di belakang ujung: endpoint yang menjawab getLogs/getBalance bisa
    // tertinggal dari yang menjawab blockNumber (blok 100 ms) — tidak perlu gagal-ulang.
    const head = (await this.rpc.blockNumber()) - 5;
    // Kursor log dibaca SEBELUM dimajukan: titik awal selisih saldo ETH (basis data
    // dari versi Alchemy belum punya) harus blok terakhir yang sudah dipindai, bukan head.
    const scannedTo = Number(this.store.getState(this.sk('deposits_scanned_to'), base.block));
    await this.ethCheckpoint(me, scannedTo);
    // transaksi bot sendiri (swap, mint, tutup): transfernya bukan setoran/penarikan
    const ours = new Set(this.store.all('SELECT hash FROM txs WHERE chain=?', this.chain.network).map((r) => r.hash.toLowerCase()));
    let added = 0;
    added += await this.syncTokens(me, scannedTo, head, ours);
    added += await this.syncEth(me, head, ours);
    this.syncedAt = Date.now();
    return { added };
  }

  async syncTokens(me, scannedTo, head, ours) {
    const from = scannedTo + 1;
    if (head < from) return 0;
    const address = [this.chain.ADDR.usdg, this.chain.ADDR.weth].filter(Boolean);
    const [ins, outs] = await Promise.all([
      getLogsSafe(this.rpc, { address, topics: [TRANSFER, null, topicOf(me)] }, from, head),
      getLogsSafe(this.rpc, { address, topics: [TRANSFER, topicOf(me), null] }, from, head),
    ]);
    const logs = [...ins.map((l) => ({ dir: 'in', ...l })), ...outs.map((l) => ({ dir: 'out', ...l }))]
      .map((l) => ({ ...l, hash: String(l.transactionHash).toLowerCase() }))
      .filter((l) => !ours.has(l.hash) && this.ASSETS[String(l.address).toLowerCase()] && BigInt(l.data) > 0n);
    if (!logs.length) { this.store.setState(this.sk('deposits_scanned_to'), String(head)); return 0; }
    // pengirim tiap tx + waktu tiap blok, sekali per hash/blok
    const hashes = [...new Set(logs.map((l) => l.hash))];
    const blocks = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))];
    const [txs, hdrs] = await Promise.all([
      this.many(hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))),
      this.many(blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] }))),
    ]);
    const senderOf = new Map(hashes.map((h, i) => [h, String(txs[i]?.from || '').toLowerCase()]));
    const tsOf = new Map(blocks.map((b, i) => [b, parseInt(hdrs[i]?.timestamp || '0', 16) * 1000 || Date.now()]));
    let added = 0;
    for (const l of logs) {
      const asset = this.ASSETS[String(l.address).toLowerCase()];
      const cp = addrOf(l.dir === 'in' ? l.topics[1] : l.topics[2]);
      const from = senderOf.get(l.hash);
      if (l.dir === 'in') {
        // uang masuk dari transaksi yang kita kirim sendiri = hasil swap/tutup, bukan setoran
        if (from === me) continue;
      } else {
        // keluar: hanya kalau kita yang mengirim, ke alamat yang bukan kontrak
        if (from !== me) continue;
        if (await this.isContract(cp)) continue;
      }
      const block = parseInt(l.blockNumber, 16);
      added += await this.record({ dir: l.dir, asset, raw: BigInt(l.data), block, ts: tsOf.get(block), hash: l.hash, uid: `${l.hash}:${parseInt(l.logIndex, 16)}`, cp });
    }
    this.store.setState(this.sk('deposits_scanned_to'), String(head));
    return added;
  }

  // Titik awal selisih saldo. Basis data dari versi Alchemy belum punya: mulai dari
  // blok terakhir yang sudah dipindai — dibuat SEBELUM kursor log maju, supaya
  // setoran ETH di antara keduanya tidak hilang.
  async ethCheckpoint(me, scannedTo) {
    const ckKey = this.sk('capital_eth_checkpoint');
    const saved = JSON.parse(this.store.getState(ckKey) || 'null');
    if (saved) return saved;
    const ck = { block: scannedTo, wei: (await this.balanceAt(me, scannedTo)).toString(), ts: await this.blockTs(scannedTo) };
    this.store.setState(ckKey, JSON.stringify(ck));
    return ck;
  }

  // ETH polos: selisih saldo yang tidak dijelaskan transaksi bot. Kalau ada sisa,
  // bloknya dicari (bisect atas "saldo − efek tx bot", ~20 panggilan arsip) lalu
  // transaksi wallet di blok itu dibaca: kiriman dari luar = setoran; kiriman kita ke
  // orang (bukan kontrak) = penarikan; kiriman kita ke kontrak (swap manual lewat
  // router, unwrap WETH) = konversi/biaya, bukan penarikan — nilainya tetap di wallet
  // atau memang hilang sebagai biaya, dua-duanya urusan PnL. Tanpa transaksi wallet di
  // blok itu (kontrak mengirim ETH ke kita — jembatan): tanda sisanya yang menentukan.
  // Setoran yang mendarat di blok yang sama dengan transaksi bot ikut terhitung sebagai
  // efek transaksi itu (jarang: blok 100 ms).
  async syncEth(me, head, ours) {
    const ckKey = this.sk('capital_eth_checkpoint');
    const ck = JSON.parse(this.store.getState(ckKey));
    if (head <= ck.block) return 0;
    // Transaksi bot yang mungkin mendarat di jendela ini (dikirim sejak titik awal,
    // dengan kelonggaran: tx tertahan bisa masuk blok jauh setelah dikirim).
    const sent = this.store.all('SELECT hash FROM txs WHERE chain=? AND ts >= ?', this.chain.network, ck.ts - 30 * 60_000).map((r) => r.hash);
    const rcs = await this.many(sent.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    let blocks = [...new Set(rcs.map((r) => (r?.blockNumber ? parseInt(r.blockNumber, 16) : 0)).filter((b) => b > ck.block && b <= head))].sort((a, b) => a - b);
    // Node arsip publik membatasi panggilan per menit (blockmachine: 300 CU). Jendela
    // yang menumpuk (dua hari tanpa pindai = ratusan tx bot) dicicil: paling banyak
    // ETH_TX_BLOCKS blok tx per sync, titik akhirnya blok tx terakhir yang dihitung —
    // saldonya sudah di tangan, tidak perlu panggilan tambahan.
    let end = head, partial = false;
    if (blocks.length > ETH_TX_BLOCKS) { blocks = blocks.slice(0, ETH_TX_BLOCKS); end = blocks[blocks.length - 1]; partial = true; }
    const bals = await this.many([
      ...blocks.flatMap((b) => [{ method: 'eth_getBalance', params: [me, hex(b - 1)] }, { method: 'eth_getBalance', params: [me, hex(b)] }]),
      ...(partial ? [] : [{ method: 'eth_getBalance', params: [me, hex(end)] }]),
    ], this.archiveOpt());
    for (const [i, v] of bals.entries()) if (typeof v !== 'string' || !/^0x[0-9a-f]*$/i.test(v)) throw new Error(`eth_getBalance (${i}): balasan bukan angka`);
    const deltaAt = new Map(blocks.map((b, i) => [b, BigInt(bals[2 * i + 1]) - BigInt(bals[2 * i])]));
    const cache = new Map([[ck.block, BigInt(ck.wei)], [end, BigInt(bals[bals.length - 1])], ...blocks.flatMap((b, i) => [[b - 1, BigInt(bals[2 * i])], [b, BigInt(bals[2 * i + 1])]])]);
    const balAt = async (n) => { if (!cache.has(n)) cache.set(n, await this.balanceAt(me, n)); return cache.get(n); };
    // f(n) = saldo di n − efek tx bot sampai n: datar, kecuali ada transfer dari luar.
    const f = async (n) => { let s = await balAt(n); for (const [b, d] of deltaAt) if (b <= n) s -= d; return s; };
    const fEnd = await f(end);
    let lo = ck.block, added = 0;
    for (let i = 0; i < ETH_EVENTS; i++) {
      const flo = await f(lo);
      if (flo === fEnd) break;
      let hi = end;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await f(mid)) === flo) lo = mid; else hi = mid; }
      added += await this.ethEvent(me, hi, (await f(hi)) - flo, ours);
      lo = hi;
    }
    // Masih ada sisa setelah ETH_EVENTS titik: berhenti di titik terakhir yang sudah
    // dibaca; sisanya giliran sync berikutnya.
    if ((await f(lo)) !== fEnd) { end = lo; partial = true; }
    const tsEnd = await this.blockTs(end);
    this.store.setState(ckKey, JSON.stringify({ block: end, wei: (await balAt(end)).toString(), ts: tsEnd }));
    this.backlog = partial;   // mesin memanggil sync lebih rapat selama cicilan belum selesai
    if (partial) this.log(`selisih saldo ETH: sampai blok ${end}, sisanya (${head - end} blok) di sync berikutnya`);
    return added;
  }

  // Satu blok dengan perubahan saldo ETH yang bukan dari transaksi bot.
  async ethEvent(me, block, residual, ours) {
    const blk = await this.rpc.call('eth_getBlockByNumber', [hex(block), true]);
    if (!blk?.timestamp) throw new Error(`blok ${block} belum ada di endpoint`);
    const ts = parseInt(blk.timestamp, 16) * 1000;
    const mine = (blk.transactions || []).filter((t) => t && typeof t === 'object' && !ours.has(String(t.hash).toLowerCase())
      && [t.from, t.to].some((a) => String(a || '').toLowerCase() === me));
    if (!mine.length) {
      return this.record({ dir: residual > 0n ? 'in' : 'out', asset: this.ASSETS.eth, raw: residual < 0n ? -residual : residual, block, ts,
        hash: `eth:${block}`, uid: 'balance', cp: null });
    }
    let added = 0;
    for (const t of mine) {
      const from = String(t.from || '').toLowerCase(), to = String(t.to || '').toLowerCase();
      const value = BigInt(t.value || 0);
      if (value === 0n) continue;
      if (to === me && from !== me) added += await this.record({ dir: 'in', asset: this.ASSETS.eth, raw: value, block, ts, hash: String(t.hash).toLowerCase(), uid: 'eth', cp: from });
      else if (from === me && !(await this.isContract(to))) added += await this.record({ dir: 'out', asset: this.ASSETS.eth, raw: value, block, ts, hash: String(t.hash).toLowerCase(), uid: 'eth', cp: to });
    }
    return added;
  }

  async record({ dir, asset, raw, block, ts, hash, uid, cp }) {
    const amount = Number(raw) / 10 ** asset.decimals;
    const ethUsd = asset.kind === 'usd' ? null : await this.chain.ethUsdAt(block);
    const usd = asset.kind === 'usd' ? amount : amount * ethUsd;
    if (usd < MIN_USD) return 0;
    const r = this.store.run(`INSERT OR IGNORE INTO deposits(chain,tx_hash,uid,ts,block,kind,token,symbol,amount,usd,eth_usd,counterparty)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, this.chain.network, hash, uid, ts, block, dir === 'in' ? 'deposit' : 'withdraw',
    asset.token, asset.symbol, raw.toString(), usd, ethUsd, cp);
    if (!Number(r.changes)) return 0;
    this.log(`${dir === 'in' ? 'setoran' : 'penarikan'} terdeteksi: ${amount} ${asset.symbol} ($${usd.toFixed(2)}) ${cp ? `${dir === 'in' ? 'dari' : 'ke'} ${cp.slice(0, 10)}… tx ${hash.slice(0, 10)}…` : `(selisih saldo blok ${hash.slice(4)})`}`);
    return 1;
  }

  rows() { return this.store.all('SELECT * FROM deposits WHERE chain=? ORDER BY ts', this.chain.network); }

  // Modal pada waktu `ts` (default: sekarang). null kalau baseline belum ada.
  capitalAt(ts = Date.now()) {
    const saved = this.store.getState(this.sk('capital_baseline'));
    if (!saved) return null;
    const b = JSON.parse(saved);
    const d = this.store.get(`SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN usd ELSE -usd END),0) s FROM deposits WHERE chain=? AND ts <= ?`, this.chain.network, ts)?.s || 0;
    return b.usd + d;
  }

  summary() {
    const saved = this.store.getState(this.sk('capital_baseline'));
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
