'use strict';
// Terealisasi vs belum, untuk posisi yang sudah ditutup.
//
// Menutup posisi USDG/MEME mengembalikan dua hal: USDG (langsung uang) dan MEME
// (belum tentu uang — harganya bisa turun 80% lagi sebelum sempat dijual). Dulu
// keduanya dinilai di harga pool saat tutup lalu dianggap selesai, padahal MEME-nya
// masih duduk di wallet. Modul ini mengikuti token itu sampai benar-benar ditukar:
//   - aset kuotasi (USDG/ETH/WETH) yang diterima = terealisasi saat itu juga
//   - token lain: tiap Transfer keluar dari wallet dibaca receipt-nya; kalau di tx
//     yang sama ada aset kuotasi masuk, itu penjualan dan hasilnya yang dipakai
//     (bukan harga pool — jual 1 juta token kena price impact & fee router);
//     kalau tidak ada (dikirim ke wallet lain / ditukar ke memecoin lain), dinilai
//     harga pool di blok itu. Yang belum keluar = masih dipegang, dinilai harga
//     pool sekarang sebagai belum terealisasi.
//
// Satu wallet bisa menerima token yang sama dari beberapa posisi, dan mungkin sudah
// memegangnya sebelum posisi pertama. Penjualan dialokasikan FIFO: saldo yang sudah
// ada sebelum posisi pertama (dibaca dari balanceOf di blok itu) dihabiskan lebih
// dulu, lalu posisi demi posisi menurut urutan tutupnya.
const { ethers } = require('ethers');
const { ADDR, TOPIC, QUOTES } = require('./chain');
const { getLogsSafe } = require('./scout');

const IF_ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const IF_POOL3 = new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)']);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const big = (v) => BigInt(v || 0);

class Proceeds {
  constructor({ rpc, store, chain, research, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.research = research;
    this.log = log || (() => {});
  }

  // Sisi kuotasi & non-kuotasi sebuah baris wpositions.
  sides(r) {
    const q = this.chain.quoteSideOf(r.token0, r.token1);
    if (!q) return null;
    return { q, tok: q.side === 0 ? r.token1 : r.token0, side: q.side === 0 ? 1 : 0 };
  }

  // Nilai USD sejumlah token non-kuotasi pada harga sqrt pool baris ini.
  usdOf(r, sqrt, amount, ethUsd) {
    if (!sqrt || amount <= 0n) return 0;
    const s = this.sides(r);
    const v = this.chain.valueInQuote({
      sqrtPriceX96: sqrt, amount0: s.side === 0 ? amount : 0n, amount1: s.side === 1 ? amount : 0n,
      dec0: r.dec0, dec1: r.dec1, token0: r.token0, token1: r.token1,
    });
    return v ? v.value * (s.q.kind === 'eth' ? ethUsd : 1) : 0;
  }

  async sqrtNow(r) {
    try {
      const s = r.venue === 'v3' ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref);
      return s?.sqrtPriceX96 || null;
    } catch { return null; }
  }

  async sqrtAt(r, block) {
    try {
      if (r.venue !== 'v3') return await this.research.priceAt(r.pool_ref, block);
      if (!this.rpc.hasArchive()) return null;
      const w = await this.rpc.callAt(r.pool_ref, IF_POOL3.encodeFunctionData('slot0'), block);
      return BigInt(IF_POOL3.decodeFunctionResult('slot0', w)[0]);
    } catch { return null; }
  }

  // Berapa token yang benar-benar sampai ke wallet di tx penarikan — zap-out lewat
  // router menjual token itu di tx yang sama, dan yang seperti itu sudah dinilai di
  // harga tutup oleh pemindai (sudah terealisasi, bukan dipegang).
  async receivedIn(txs, wallet, token) {
    const out = new Map();
    if (!txs.length) return out;
    const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    txs.forEach((h, i) => {
      const rc = rcs[i] && !rcs[i].error ? rcs[i].result : null;
      let got = 0n;
      for (const l of rc?.logs || []) {
        if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3 || l.address.toLowerCase() !== token) continue;
        if (asAddr(l.topics[2]) === wallet) got += BigInt(l.data);
      }
      out.set(h, rc ? got : null);
    });
    return out;
  }

  // Satu tx yang mengeluarkan token dari wallet: berapa yang pergi, berapa USD masuk.
  async analyzeSale(wallet, token, tx, ethUsd) {
    const [rcR, txR] = await this.rpc.batch([
      { method: 'eth_getTransactionReceipt', params: [tx] },
      { method: 'eth_getTransactionByHash', params: [tx] },
    ]);
    const rc = rcR?.result, t = txR?.result;
    if (!rc) return null;
    const bn = parseInt(rc.blockNumber, 16);
    // hasil jual ke ETH/WETH dinilai dengan harga ETH pada blok itu, bukan sekarang
    const ethThen = await this.chain.ethUsdAt(bn, ethUsd);
    let tokOut = 0n, usd = 0;
    for (const l of rc.logs || []) {
      if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
      const a = l.address.toLowerCase(), from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
      if (a === token && from === wallet) tokOut += BigInt(l.data);
      if (to === wallet && QUOTES[a]) {
        const q = QUOTES[a];
        usd += (Number(BigInt(l.data)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethThen : 1);
      }
    }
    // ETH native tidak ber-Transfer: selisih saldo sebelum-sesudah blok, dikembalikan
    // gas & value tx ini. Butuh node arsip; tanpa itu hasil jual ke ETH tidak terbaca
    // dan tx-nya dinilai di harga pool.
    if (this.rpc.hasArchive() && t && t.from.toLowerCase() === wallet) {
      try {
        const [b0, b1] = await this.rpc.batch([
          { method: 'eth_getBalance', params: [wallet, '0x' + (bn - 1).toString(16)] },
          { method: 'eth_getBalance', params: [wallet, '0x' + bn.toString(16)] },
        ], { archive: true });
        if (!b0?.result || !b1?.result) throw new Error(b0?.error?.message || b1?.error?.message || 'saldo tidak terbaca');
        const gas = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || t.gasPrice || 0);
        const delta = BigInt(b1.result) - BigInt(b0.result) + gas + BigInt(t.value || 0);
        if (delta > 0n) usd += (Number(delta) / 1e18) * ethThen;
      } catch (e) {
        // State blok lama sudah dipangkas node arsip ("missing trie node"): tidak akan
        // pernah terbaca — pakai yang ada (dinilai harga pool kalau tidak ada USDG masuk).
        // Kegagalan lain (429, timeout) sementara: lebih baik gagal sekarang supaya token
        // ini dicoba lagi pada pembaruan berikutnya, daripada tercatat salah permanen.
        if (!/missing trie|not available|not found/i.test(e.message)) {
          throw new Error(`saldo ETH ${tx.slice(0, 10)}… tidak terbaca: ${e.message}`);
        }
      }
    }
    return { tokOut, usd: usd > 0 ? usd : null, block: bn };
  }

  // Lacak semua posisi tertutup wallet ini. Dipanggil setelah persist menulis baris.
  async track(wallet, { head, ethUsd }) {
    const rows = this.store.all(`SELECT wallet, venue, token_id, pool_ref, token0, token1, out0, out1,
      returned_q, invested_q, quote_symbol, closed_block, held_tok, sold_tok, tracked_to
      FROM wpositions WHERE wallet=? AND status='closed'`, wallet);
    const toks = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]).filter(Boolean))]);
    const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
    for (const r of rows) { r.dec0 = dec.get(r.token0) ?? 18; r.dec1 = dec.get(r.token1) ?? 18; }

    // kelompokkan per token non-kuotasi
    const byTok = new Map();
    for (const r of rows) {
      const s = this.sides(r);
      if (!s) continue;
      r.outN = big(s.side === 0 ? r.out0 : r.out1);
      r.tok = s.tok; r.s = s;
      if (r.outN === 0n) {
        // semua yang kembali adalah aset kuotasi: terealisasi seluruhnya
        if (r.tracked_to == null) this.setRow(r, { held: 0n, sold: 0n, realized: r.returned_q || 0, unrealized: 0, head });
        continue;
      }
      if (!byTok.has(r.tok)) byTok.set(r.tok, []);
      byTok.get(r.tok).push(r);
    }

    for (const [token, lots] of byTok) {
      // Cuma token yang masih ada urusannya: posisi baru tutup atau token masih dipegang.
      if (!lots.some((r) => r.tracked_to == null || big(r.held_tok) > 0n)) continue;
      try { await this.trackToken(wallet, token, lots, { head, ethUsd }); }
      catch (e) { this.log(`lacak ${token.slice(0, 10)}…: ${e.message}`); }
    }
  }

  async trackToken(wallet, token, lots, { head, ethUsd }) {
    lots.sort((a, b) => a.closed_block - b.closed_block);
    // Ukuran lot = token yang benar-benar diterima wallet saat penarikan.
    const fresh = lots.filter((r) => r.tracked_to == null);
    const txOf = new Map();
    for (const r of fresh) {
      // v4: token keluar pada 'decrease'/'collect'; v3: hanya pada 'collect' (baris
      // 'decrease'-nya bernilai nol), jadi kedua jenis dijumlahkan saja.
      const ev = this.store.all(`SELECT tx_hash, ${r.s.side === 0 ? 'amount0' : 'amount1'} AS amt FROM wevents
        WHERE wallet=? AND token_id=? AND kind IN ('decrease','collect') ORDER BY block`, wallet, r.token_id);
      txOf.set(r, ev);
    }
    const allTx = [...new Set([...txOf.values()].flat().map((e) => e.tx_hash))];
    const recv = await this.receivedIn(allTx, wallet, token);
    for (const r of fresh) {
      let lot = 0n;
      const seen = new Set();
      for (const e of txOf.get(r)) {
        if (seen.has(e.tx_hash)) continue;
        seen.add(e.tx_hash);
        const got = recv.get(e.tx_hash);
        // receipt tidak terbaca: anggap semua diterima (lebih aman daripada nol)
        lot += got == null ? big(e.amt) : got;
      }
      if (lot > r.outN) lot = r.outN;
      r.lot = lot;
    }
    for (const r of lots) if (r.lot == null) r.lot = big(r.held_tok) + big(r.sold_tok);

    // Saldo yang sudah ada sebelum lot pertama — dihabiskan lebih dulu (FIFO).
    const first = lots[0].closed_block;
    const preKey = `wpre:${wallet}:${token}:${first}`;
    let pre = this.store.getState(preKey);
    if (pre == null) {
      pre = '0';
      if (this.rpc.hasArchive()) {
        try {
          const w = await this.rpc.callAt(token, IF_ERC20.encodeFunctionData('balanceOf', [wallet]), first - 1);
          pre = BigInt(w).toString();
        } catch (e) { this.log(`saldo awal ${token.slice(0, 10)} gagal: ${e.message}`); }
      }
      this.store.setState(preKey, pre);
    }

    // Transfer keluar: jendela [lot pertama, head], hanya bagian yang belum dibaca.
    // Lot yang baru muncul bisa lebih awal dari jendela lama (pindai ulang yang lebih
    // panjang), jadi jendela yang sudah tercakup disimpan per token.
    const spanKey = `wsales_span:${wallet}:${token}`;
    let span = null;
    try { span = JSON.parse(this.store.getState(spanKey) || 'null'); } catch { span = null; }
    const parts = [];
    if (!span) parts.push([first, head]);
    else {
      if (first < span.from) parts.push([first, span.from - 1]);
      if (span.to < head) parts.push([span.to + 1, head]);
    }
    const known = this.store.all('SELECT tx_hash, block, tok_out, quote_usd FROM wsales WHERE wallet=? AND token=? ORDER BY block', wallet, token);
    const seenTx = new Set(known.map((k) => k.tx_hash));
    for (const [lo, hi] of parts) {
      if (lo > hi) continue;
      const logs = await getLogsSafe(this.rpc, { address: token, topics: [TOPIC.transfer, pad32(wallet)] }, lo, hi);
      for (const tx of [...new Set(logs.map((l) => l.transactionHash))]) {
        if (seenTx.has(tx)) continue;
        seenTx.add(tx);
        const a = await this.analyzeSale(wallet, token, tx, ethUsd);
        if (!a || a.tokOut === 0n) continue;
        const ts = await this.chain.blockTs(a.block);
        this.store.run('INSERT OR REPLACE INTO wsales(wallet,token,tx_hash,block,ts,tok_out,quote_usd,kind) VALUES(?,?,?,?,?,?,?,?)',
          wallet, token, tx, a.block, ts, a.tokOut.toString(), a.usd, a.usd != null ? 'sell' : 'send');
        known.push({ tx_hash: tx, block: a.block, tok_out: a.tokOut.toString(), quote_usd: a.usd });
      }
    }
    this.store.setState(spanKey, JSON.stringify({ from: Math.min(first, span?.from ?? first), to: head }));
    known.sort((x, y) => x.block - y.block);

    // Nilai sisi non-kuotasi di harga tutup, per satuan mentah — cadangan kalau harga
    // pool di blok penjualan / sekarang tidak terbaca (lebih jujur daripada nol).
    for (const r of lots) {
      r.quoteOutUsd = (Number(big(r.s.side === 0 ? r.out1 : r.out0)) / 10 ** (r.s.side === 0 ? r.dec1 : r.dec0))
        * (r.s.q.kind === 'eth' ? ethUsd : 1);
      const nonQuoteCloseUsd = Math.max(0, (r.returned_q || 0) - r.quoteOutUsd);
      r.closeUnit = r.outN > 0n ? nonQuoteCloseUsd / Number(r.outN) : 0;
    }

    // Alokasi FIFO.
    const queue = [{ pre: true, left: big(pre) }, ...lots.map((r) => ({ r, left: r.lot, sold: 0n, usd: 0 }))];
    for (const k of known) {
      let rem = big(k.tok_out);
      const total = rem;
      for (const q of queue) {
        if (rem === 0n) break;
        if (q.left === 0n) continue;
        const take = q.left < rem ? q.left : rem;
        q.left -= take; rem -= take;
        if (q.pre) continue;
        q.sold += take;
        if (k.quote_usd != null) { q.usd += k.quote_usd * Number(take) / Number(total); continue; }
        const sq = await this.sqrtAt(q.r, k.block);
        q.usd += sq ? this.usdOf(q.r, sq, take, ethUsd) : q.r.closeUnit * Number(take);
      }
    }

    // Tulis hasil per posisi.
    const sqrtCache = new Map();
    for (const q of queue) {
      if (q.pre) continue;
      const r = q.r;
      // bagian yang tidak pernah sampai ke wallet (zap-out) sudah dinilai di harga tutup
      const closeUsd = r.closeUnit * Number(r.outN - r.lot);
      const held = q.left;
      let unrealized = 0;
      if (held > 0n) {
        if (!sqrtCache.has(r.pool_ref)) sqrtCache.set(r.pool_ref, await this.sqrtNow(r));
        const sq = sqrtCache.get(r.pool_ref);
        unrealized = sq ? this.usdOf(r, sq, held, ethUsd) : r.closeUnit * Number(held);
      }
      this.setRow(r, { held, sold: q.sold, realized: r.quoteOutUsd + closeUsd + q.usd, unrealized, head });
    }
  }

  setRow(r, { held, sold, realized, unrealized, head }) {
    const pnl = realized + unrealized - (r.invested_q || 0);
    this.store.run(`UPDATE wpositions SET held_tok=?, sold_tok=?, realized_q=?, unrealized_q=?, pnl_q=?, tracked_to=?
      WHERE wallet=? AND venue=? AND token_id=?`,
    held.toString(), sold.toString(), realized, unrealized, pnl, head, r.wallet, r.venue, r.token_id);
  }

  // Nilai "belum terealisasi" yang segar untuk tampilan: harga pool sekarang, tanpa
  // menulis ke DB. Baris yang tidak memegang apa-apa dikembalikan apa adanya.
  async refreshHeld(rows, ethUsd) {
    const held = rows.filter((r) => r.status === 'closed' && big(r.held_tok) > 0n && r.realized_q != null);
    if (!held.length) return;
    const bySqrt = new Map();
    for (const r of held) {
      if (!bySqrt.has(r.pool_ref)) bySqrt.set(r.pool_ref, await this.sqrtNow(r));
      const u = this.usdOf(r, bySqrt.get(r.pool_ref), big(r.held_tok), ethUsd);
      r.unrealized_q = u;
      r.pnl_q = r.realized_q + u - (r.invested_q || 0);
    }
  }
}

module.exports = { Proceeds };
