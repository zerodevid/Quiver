'use strict';
const { ensureChain } = require('./networks');
// Riset wallet untuk Uniswap v3.
//
// wallet.js merekonstruksi riwayat v4: di sana jumlah token harus digali dari receipt
// dan pokok dipisahkan dari fee lewat matematika likuiditas, karena event v4 tidak
// membawa jumlahnya. v3 lebih murah: NonfungiblePositionManager memancarkan jumlahnya
// langsung, dan memisahkan pokok dari fee dengan sendirinya —
//   IncreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)  -> modal masuk
//   DecreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)  -> POKOK yang ditarik
//   Collect(tokenId indexed, recipient, amount0, amount1)            -> yang benar-benar diterima
// sehingga fee = Collect − Decrease. Ketiganya mengindeks tokenId, jadi seluruh
// riwayat sebuah wallet bisa diambil dengan satu kueri per rombongan tokenId.
//
// Nilai tiap kejadian dihitung pada harga pool DI BLOK ITU (arsip kalau ada, kalau
// tidak dari event Swap terdekat) — sama seperti jalur v4. Memakai harga sekarang
// untuk modal yang disetor seminggu lalu akan menghasilkan PnL yang menyesatkan.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { getLogsSafe } = require('./scout');
const { unclaimedV3 } = require('./fees');
const m = require('./v3math');

const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_POOL = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const hex = (n) => '0x' + n.toString(16);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const idTopic = (id) => '0x' + BigInt(id).toString(16).padStart(64, '0');
const w32 = (b, i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));

class WalletV3 {
  // venue: kunci venue v3 di chain ini ('v3' Uniswap, 'pancakev3' PancakeSwap di BSC) —
  // satu instance per venue, masing-masing memindai NPM-nya sendiri.
  constructor({ rpc, store, chain, log, venue = 'v3' }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
    this.venue = venue; this.npm = chain.npmFor(venue); this.network = chain.network;
    this.priceCache = new Map();
  }

  // Harga pool v3 pada sebuah blok.
  //
  // Sumber utamanya event Swap, BUKAN node arsip — kebalikan dari jalur v4. Alasannya
  // terukur: pada satu posisi nyata, arsip menjawab 4,26e32 untuk blok keluar
  // sementara tiga Swap berturut-turut sesudahnya (jarak 9, 13, dan 92 blok) sepakat
  // di ~2,0e33, dan tidak ada satu pun Swap di antaranya yang bisa menjelaskan
  // selisih 4,7x itu — menarik likuiditas tidak menggerakkan harga di Uniswap v3.
  // Beberapa menit kemudian node yang sama menolak blok itu ("missing trie node"),
  // jadi jawabannya tadi berasal dari state yang sudah tidak utuh. Selisihnya bukan
  // kosmetik: PnL wallet yang sama berayun dari −$19rb ke +$231rb tergantung sumber.
  //
  // Log event tidak bisa salah — ia bagian dari blok itu sendiri. Arsip tetap dipakai,
  // tapi hanya kalau tidak ada Swap yang bisa ditemukan sama sekali.
  //
  // Mengembalikan { sqrt, jarak } — `jarak` (dalam blok) dipakai pemanggil untuk
  // menandai posisi yang harganya cuma taksiran.
  async priceAt(poolAddr, block) {
    const key = `${poolAddr}:${block}`;
    if (this.priceCache.has(key)) return this.priceCache.get(key);
    const row = this.store.get('SELECT sqrt_price, src_block FROM wprices WHERE chain=? AND pool_ref=? AND block=?', this.network, poolAddr, block);
    if (row) {
      const v = { sqrt: BigInt(row.sqrt_price), jarak: Math.abs((row.src_block ?? block) - block) };
      this.priceCache.set(key, v); return v;
    }
    const simpan = (sqrt, src) => {
      this.store.run('INSERT OR REPLACE INTO wprices(chain,pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?,?)',
        this.network, poolAddr, block, sqrt.toString(), src);
      const v = { sqrt, jarak: Math.abs(src - block) };
      this.priceCache.set(key, v);
      return v;
    };

    let best = null;
    for (const win of [400, 4000, 40_000, 400_000]) {
      let logs = [];
      try {
        logs = await this.rpc.getLogs({
          address: poolAddr, topics: [TOPIC.swapV3],
          fromBlock: hex(Math.max(0, block - win)), toBlock: hex(block + win),
        });
      } catch { /* rentang ditolak: coba jendela berikutnya */ }
      for (const l of logs) {
        const bn = parseInt(l.blockNumber, 16);
        // Seri: yang terjadi SEBELUM kejadian lebih benar daripada sesudahnya.
        const lebihBaik = !best || Math.abs(bn - block) < Math.abs(best.bn - block)
          || (Math.abs(bn - block) === Math.abs(best.bn - block) && bn <= block);
        if (lebihBaik) best = { bn, sqrt: w32(ethers.getBytes(l.data), 2) };
      }
      if (best) break;
    }
    if (best) return simpan(best.sqrt, best.bn);

    // Tidak ada Swap sama sekali di ±400rb blok: barulah arsip dicoba.
    if (this.rpc.hasArchive()) {
      try {
        const w = await this.rpc.callAt(poolAddr, IF_POOL.encodeFunctionData('slot0'), block - 1);
        if (w && w !== '0x') {
          const sqrt = BigInt(IF_POOL.decodeFunctionResult('slot0', w)[0]);
          if (sqrt > 0n) return simpan(sqrt, block - 1);
        }
      } catch (e) { this.log(`harga arsip v3 ${poolAddr.slice(0, 10)} @${block}: ${e.message}`); }
    }
    this.priceCache.set(key, null);
    return null;
  }

  // Semua tokenId NPM v3 yang pernah dipegang wallet, beserta jendela hidupnya.
  async enumerate(wallet, fromBlock, toBlock) {
    const p = pad32(wallet);
    const [masuk, keluar] = await Promise.all([
      getLogsSafe(this.rpc, { address: this.npm, topics: [TOPIC.transfer, null, p] }, fromBlock, toBlock),
      getLogsSafe(this.rpc, { address: this.npm, topics: [TOPIC.transfer, p] }, fromBlock, toBlock),
    ]);
    const held = new Map();
    for (const l of [...masuk, ...keluar]) {
      if (!l.topics[3]) continue;
      const id = BigInt(l.topics[3]).toString();
      const bn = parseInt(l.blockNumber, 16);
      const li = parseInt(l.logIndex, 16);
      const e = held.get(id) || { first: bn, last: bn, heldNow: false, lastPos: -1 };
      e.first = Math.min(e.first, bn); e.last = Math.max(e.last, bn);
      // Kepemilikan ditentukan Transfer TERAKHIR, bukan sekadar ada/tidaknya —
      // satu tokenId bisa keluar-masuk berkali-kali.
      const pos = bn * 1e5 + li;
      if (pos > e.lastPos) { e.lastPos = pos; e.heldNow = asAddr(l.topics[2]) === wallet; }
      held.set(id, e);
    }
    return held;
  }

  async scan(wallet, { from, head, ethUsd = 2500, onProgress } = {}) {
    wallet = wallet.toLowerCase();
    const held = await this.enumerate(wallet, from, head);
    const ids = [...held.keys()];
    if (!ids.length) return [];

    // 1. bentuk posisi: pasangan token, fee, rentang, likuiditas sekarang
    const info = new Map();
    for (let i = 0; i < ids.length; i += 40) {
      const bagian = ids.slice(i, i + 40);
      const res = await this.rpc.ethCallMany(bagian.map((id) => ({
        to: this.npm, data: IF_NPM.encodeFunctionData('positions', [BigInt(id)]),
      })));
      bagian.forEach((id, k) => {
        const w = res[k];
        if (!w || w === '0x') return;
        try {
          const d = IF_NPM.decodeFunctionResult('positions', w);
          info.set(id, {
            token0: String(d[2]).toLowerCase(), token1: String(d[3]).toLowerCase(), fee: Number(d[4]),
            tickLower: Number(d[5]), tickUpper: Number(d[6]), liquidity: BigInt(d[7]),
          });
        } catch { /* NFT sudah dibakar: tidak terbaca lagi, dilewati */ }
      });
      if (onProgress) onProgress({ phase: 'posisi v3', scanned: i + bagian.length, total: ids.length * 2 });
    }
    // 2. seluruh kejadian, satu kueri per rombongan tokenId (tokenId terindeks).
    // Dikumpulkan untuk SEMUA tokenId, termasuk yang positions()-nya sudah tidak
    // menjawab: NFT yang dibakar setelah ditutup tetap punya riwayat yang berharga.
    const kejadian = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += 25) {
      const bagian = ids.slice(i, i + 25);
      const span = bagian.reduce((a, id) => ({
        lo: Math.min(a.lo, held.get(id).first),
        hi: Math.max(a.hi, held.get(id).heldNow ? head : Math.min(head, held.get(id).last + 5)),
      }), { lo: head, hi: 0 });
      let logs = [];
      try {
        logs = await getLogsSafe(this.rpc, {
          address: this.npm,
          topics: [[TOPIC.increaseLiq, TOPIC.decreaseLiq, TOPIC.collectV3], bagian.map(idTopic)],
        }, span.lo, span.hi);
      } catch (e) { this.log(`kejadian v3: ${e.message}`); }
      for (const l of logs) {
        const id = BigInt(l.topics[1]).toString();
        if (!kejadian.has(id)) continue;
        const b = ethers.getBytes(l.data);
        const t0 = l.topics[0];
        // Increase/Decrease: [likuiditas, amount0, amount1]. Collect: [penerima, amount0, amount1].
        kejadian.get(id).push({
          block: parseInt(l.blockNumber, 16), tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16),
          kind: t0 === TOPIC.increaseLiq ? 'increase' : t0 === TOPIC.decreaseLiq ? 'decrease' : 'collect',
          liq: t0 === TOPIC.collectV3 ? 0n : w32(b, 0),
          amount0: w32(b, 1), amount1: w32(b, 2),
        });
      }
      if (onProgress) onProgress({ phase: 'kejadian v3', scanned: ids.length + i + bagian.length, total: ids.length * 2 });
    }

    // 2b. Posisi yang NFT-nya sudah dibakar: positions() tidak menjawab lagi, tapi
    // transaksi pembukaannya masih ada. Kontrak POOL memancarkan Mint di situ —
    // alamat lognya ADALAH alamat poolnya, dan tick-nya ada di topiknya. Tanpa ini
    // lebih dari separuh riwayat wallet yang rajin membakar NFT-nya hilang, dan yang
    // tersisa condong ke posisi yang kebetulan belum dibakar.
    const hilang = ids.filter((id) => !info.has(id) && (kejadian.get(id) || []).some((e) => e.kind === 'increase'));
    for (const id of hilang) {
      const buka = kejadian.get(id).find((e) => e.kind === 'increase');
      try {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [buka.tx]);
        const l = (rc?.logs || []).find((x) => x.topics?.[0] === TOPIC.mintV3Pool
          && asAddr(x.topics[1] || '') === this.npm);
        if (!l) continue;
        const pool = String(l.address).toLowerCase();
        const [t0, t1, fee] = await this.rpc.ethCallMany([
          { to: pool, data: '0x0dfe1681' },   // token0()
          { to: pool, data: '0xd21220a7' },   // token1()
          { to: pool, data: '0xddca3f43' },   // fee()
        ]);
        if (!t0 || t0 === '0x' || !t1 || t1 === '0x') continue;
        info.set(id, {
          token0: asAddr(t0), token1: asAddr(t1), fee: fee && fee !== '0x' ? Number(BigInt(fee)) : null,
          tickLower: Number(BigInt.asIntN(24, BigInt(l.topics[2]))),
          tickUpper: Number(BigInt.asIntN(24, BigInt(l.topics[3]))),
          liquidity: 0n, poolAddr: pool, dibakar: true,
        });
      } catch (e) { this.log(`pulihkan posisi v3 ${id}: ${e.message}`); }
    }
    const hidup = [...info.keys()];
    if (!hidup.length) return [];

    // 3. alamat & harga pool sekarang, sekali per pool
    const poolOf = new Map();
    for (const inf of info.values()) {
      if (inf.poolAddr) continue;                 // sudah diketahui dari log Mint
      const key = `${inf.token0}|${inf.token1}|${inf.fee}`;
      if (!poolOf.has(key)) poolOf.set(key, await this.chain.poolV3Addr(inf.token0, inf.token1, inf.fee, this.npm).catch(() => null));
      inf.poolAddr = poolOf.get(key);
    }
    const alamat = [...new Set([...info.values()].map((i) => i.poolAddr).filter(Boolean))];
    const slot = new Map();
    for (const a of alamat) slot.set(a, await this.chain.slot0V3(a).catch(() => null));

    // 4. fee yang belum diklaim untuk posisi yang masih dipegang & berlikuiditas
    const owedIds = hidup.filter((id) => held.get(id).heldNow && info.get(id).liquidity > 0n);
    let owed = [];
    try { owed = owedIds.length ? await unclaimedV3(this.chain, owedIds.map((x) => BigInt(x)), wallet, this.npm, this.rpc) : []; }
    catch { owed = []; }
    const owedBy = new Map(owedIds.map((id, i) => [id, owed[i] || { fee0: 0n, fee1: 0n }]));

    // 5. rakit
    const out = [];
    for (const id of hidup) {
      try {
        const pos = await this.build(wallet, id, info.get(id), kejadian.get(id) || [], held.get(id), slot, owedBy.get(id), head);
        if (pos) out.push(pos);
      } catch (e) { this.log(`posisi v3 ${id}: ${e.message}`); }
    }
    return out;
  }

  async build(wallet, id, inf, evs, span, slot, owed, head) {
    if (!inf.token0 || !inf.poolAddr) return null;
    const [t0, t1] = await this.chain.tokens([inf.token0, inf.token1]);
    const d0 = t0?.decimals ?? 18, d1 = t1?.decimals ?? 18;
    const q = this.chain.quoteSideOf(inf.token0, inf.token1);
    const s0 = slot.get(inf.poolAddr);

    // Kalau harga di blok itu tidak terbaca (pool tanpa Swap di sekitarnya, tanpa
    // node arsip), sisi KUOTASI tetap bisa dinilai persis — ia memang uangnya.
    // Yang hilang hanya sisi spekulatifnya. Itu jauh lebih baik daripada menilai
    // seluruh kejadian nol, yang membuat posisi tampak bermodal nol.
    let taksiran = false;
    const nilai = (a0, a1, sqrt) => {
      if (a0 === 0n && a1 === 0n) return 0;
      if (sqrt) {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: sqrt, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
          token0: inf.token0, token1: inf.token1,
        });
        if (v) return v.value;
      }
      if (!q) return 0;
      const lain = q.side === 0 ? a1 : a0;
      if (lain > 0n) taksiran = true;
      return q.side === 0 ? Number(a0) / 10 ** d0 : Number(a1) / 10 ** d1;
    };

    evs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const agg = { in0: 0n, in1: 0n, out0: 0n, out1: 0n, fee0: 0n, fee1: 0n };
    let investedQ = 0, returnedQ = 0, feesQ = 0;
    const rows = [];
    // Decrease menaruh POKOK ke dalam "terutang", Collect membayarkannya bersama fee.
    // Fee = yang dibayarkan − pokok yang menunggu dibayarkan, dihitung berjalan supaya
    // klaim fee tanpa penarikan (Collect tanpa Decrease) ikut terbaca utuh.
    let tunggu0 = 0n, tunggu1 = 0n;
    // Harga yang diambil dari Swap yang jauh dari blok kejadian adalah taksiran —
    // pada memecoin, beberapa menit bisa berarti berkali-kali lipat.
    const JAUH = 2000;   // ~3,4 menit di chain ini
    for (const e of evs) {
      const h = await this.priceAt(inf.poolAddr, e.block);
      const sqrt = h?.sqrt ?? null;
      if (h && h.jarak > JAUH) taksiran = true;
      let princ0 = 0n, princ1 = 0n, fee0 = 0n, fee1 = 0n;
      if (e.kind === 'increase') {
        agg.in0 += e.amount0; agg.in1 += e.amount1;
        princ0 = e.amount0; princ1 = e.amount1;
        investedQ += nilai(e.amount0, e.amount1, sqrt);
      } else if (e.kind === 'decrease') {
        agg.out0 += e.amount0; agg.out1 += e.amount1;
        princ0 = e.amount0; princ1 = e.amount1;
        tunggu0 += e.amount0; tunggu1 += e.amount1;
      } else {
        princ0 = e.amount0 < tunggu0 ? e.amount0 : tunggu0;
        princ1 = e.amount1 < tunggu1 ? e.amount1 : tunggu1;
        fee0 = e.amount0 - princ0; fee1 = e.amount1 - princ1;
        tunggu0 -= princ0; tunggu1 -= princ1;
        agg.fee0 += fee0; agg.fee1 += fee1;
        returnedQ += nilai(e.amount0, e.amount1, sqrt);
        feesQ += nilai(fee0, fee1, sqrt);
      }
      rows.push({
        block: e.block, tx: e.tx, logIndex: e.logIndex, kind: e.kind,
        delta: e.kind === 'decrease' ? -e.liq : e.liq,
        moved: {
          in0: e.kind === 'increase' ? e.amount0 : 0n, in1: e.kind === 'increase' ? e.amount1 : 0n,
          out0: e.kind === 'collect' ? e.amount0 : 0n, out1: e.kind === 'collect' ? e.amount1 : 0n,
        },
        princ: { amount0: princ0, amount1: princ1 },
        fee0, fee1, sqrt,
        valueQ: nilai(e.amount0, e.amount1, sqrt),
      });
    }

    const punya = span.heldNow && inf.liquidity > 0n && !inf.dibakar;
    let liveValueQ = 0, liveFeeQ = 0, inRange = null;
    if (punya && s0) {
      const a = m.getSqrtRatioAtTick(inf.tickLower), b = m.getSqrtRatioAtTick(inf.tickUpper);
      const amt = m.amountsForLiquidity(s0.sqrtPriceX96, a, b, inf.liquidity);
      liveValueQ = nilai(amt.amount0, amt.amount1, s0.sqrtPriceX96);
      inRange = m.sideOfRange(s0.tick, inf.tickLower, inf.tickUpper) === 'both';
      if (owed) liveFeeQ = nilai(owed.fee0, owed.fee1, s0.sqrtPriceX96);
    }
    const closed = !punya;
    const pnlQ = closed ? (returnedQ - investedQ) : (liveValueQ + liveFeeQ + returnedQ - investedQ);

    return {
      wallet, venue: this.venue, tokenId: id, poolId: inf.poolAddr,
      // persist() membaca pasangan token dari poolKey; v3 tidak punya struktur itu,
      // jadi dibuatkan yang setara supaya jalur penyimpanannya tidak bercabang.
      poolKey: { currency0: inf.token0, currency1: inf.token1, fee: inf.fee, tickSpacing: null, hooks: null },
      tickLower: inf.tickLower, tickUpper: inf.tickUpper,
      liquidity: inf.liquidity, agg,
      investedQ, returnedQ, feesQ, pnlQ,
      liveValueQ, liveFeeQ, inRange, curTick: s0?.tick ?? null,
      quoteSymbol: q?.symbol || null, quoteKind: q?.kind || 'usd',
      openedBlock: evs.length ? evs[0].block : span.first,
      closedBlock: closed ? (evs.length ? evs[evs.length - 1].block : span.last) : null,
      status: closed ? 'closed' : 'open',
      events: rows,
      symbol0: t0?.symbol || '?', symbol1: t1?.symbol || '?', dec0: d0, dec1: d1,
      // "tidak lengkap" juga berlaku kalau ada kejadian yang harganya tidak terbaca:
      // angkanya tetap ditampilkan, tapi ditandai supaya tidak dibaca sebagai pasti.
      incomplete: !evs.some((e) => e.kind === 'increase') || taksiran,
      head,
    };
  }
}

module.exports = { WalletV3 };
