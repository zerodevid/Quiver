'use strict';
// Riset wallet: rekonstruksi seluruh riwayat posisi LP sebuah wallet dari chain,
// lengkap dengan modal, fee, dan PnL — untuk posisi yang masih hidup MAUPUN yang
// sudah ditutup.
//
// Kenapa dari chain, bukan API pihak ketiga: api.lpagent.io dijaga Cloudflare
// (403 bahkan untuk browser sungguhan), dan server kita juga tidak bisa menembus
// Blockscout. Jalur on-chain justru lebih akurat — lihat catatan pemisahan fee.
//
// Cara kerja, empat tahap:
//   1. Transfer NFT PositionManager (from/to terindeks) -> daftar tokenId + jendela hidupnya
//   2. poolId tiap tokenId: dari getPoolAndPositionInfo (masih hidup) atau dari receipt mint
//   3. ModifyLiquidity disaring per poolId (poolId terindeks, jadi murah) -> semua kejadian
//   4. receipt tiap tx -> jumlah token PERSIS yang berpindah antara wallet dan PoolManager
//
// Pemisahan pokok vs fee: penarikan mengembalikan pokok + fee tercampur dalam satu
// Transfer. Pokok dihitung dari (L, rentang, harga pool saat itu); sisanya fee.
// Menurunkan harga dari jumlah token TIDAK BISA dipakai di penarikan karena jumlahnya
// sudah tercemar fee — harganya harus diambil dari event Swap (yang membawa sqrtPriceX96,
// dan tick-nya cocok 100% saat diverifikasi silang).
const { ethers } = require('ethers');
const { ADDR, TOPIC, ABI, QUOTES } = require('./chain');
const { computePoolId } = require('./pools');
const { getLogsSafe } = require('./scout');
const { unclaimedV4, feesAtBlock } = require('./fees');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const ZERO = '0x0000000000000000000000000000000000000000';
const hex = (n) => '0x' + n.toString(16);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const w32 = (bytes, i) => BigInt(ethers.hexlify(bytes.slice(i * 32, i * 32 + 32)));

class WalletResearch {
  constructor({ rpc, store, chain, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
    this.priceCache = new Map();
  }

  // ---- harga pool pada blok tertentu --------------------------------------
  // Jalur utama: baca Slot0 pool LANGSUNG di blok sebelum kejadian lewat node arsip.
  // Ini eksak — diverifikasi dengan menghitung fee dua cara independen (dari
  // feeGrowthInside di storage vs dari "keluar dikurangi pokok"): hasilnya identik
  // sampai digit terakhir.
  //
  // Cadangan: harga dari event Swap terdekat. Untuk memecoin ini bisa meleset jauh —
  // harga bergerak beberapa persen dalam hitungan blok, dan pokok hasil hitung bisa
  // melebihi token yang benar-benar diterima (mustahil), jadi hasilnya diapit ke
  // rentang yang konsisten dengan jumlah yang diterima.
  async priceAt(poolId, block) {
    const key = `${poolId}:${block}`;
    if (this.priceCache.has(key)) return this.priceCache.get(key);
    const row = this.store.get('SELECT sqrt_price FROM wprices WHERE pool_ref=? AND block=?', poolId, block);
    if (row) { const v = BigInt(row.sqrt_price); this.priceCache.set(key, v); return v; }

    if (this.rpc.hasArchive()) {
      try {
        const slot = '0x' + BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
          .encode(['bytes32', 'uint256'], [poolId, 6n]))).toString(16).padStart(64, '0');
        const IF_EXT = new ethers.Interface(['function extsload(bytes32) view returns (bytes32)']);
        const w = await this.rpc.callAt(ADDR.poolManager, IF_EXT.encodeFunctionData('extsload', [slot]), block - 1);
        const sqrt = BigInt(w) & ((1n << 160n) - 1n);
        if (sqrt > 0n) {
          this.store.run('INSERT OR REPLACE INTO wprices(pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?)',
            poolId, block, sqrt.toString(), block - 1);
          this.priceCache.set(key, sqrt);
          return sqrt;
        }
      } catch (e) { this.log(`harga arsip ${poolId.slice(0, 10)} @${block} gagal: ${e.message}`); }
    }

    let best = null;
    for (const win of [400, 4000, 40000, 400000]) {
      let logs = [];
      try {
        logs = await this.rpc.getLogs({
          address: ADDR.poolManager, topics: [TOPIC.swapV4, poolId],
          fromBlock: hex(Math.max(0, block - win)), toBlock: hex(block + win),
        });
      } catch { /* rentang terlalu besar: coba jendela berikutnya */ }
      for (const l of logs) {
        const bn = parseInt(l.blockNumber, 16);
        if (!best || Math.abs(bn - block) < Math.abs(best.bn - block)) {
          best = { bn, sqrt: w32(ethers.getBytes(l.data), 2) };
        }
      }
      if (best) break;
    }
    if (!best) { this.priceCache.set(key, null); return null; }
    this.store.run('INSERT OR REPLACE INTO wprices(pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?)',
      poolId, block, best.sqrt.toString(), best.bn);
    this.priceCache.set(key, best.sqrt);
    return best.sqrt;
  }

  // ---- tahap 1: tokenId yang pernah dipegang -------------------------------
  async enumerate(wallet, fromBlock, toBlock, onProgress) {
    const p = pad32(wallet);
    const held = new Map();   // tokenId -> {first, last, mintTx, acquiredByMint}
    // Query Transfer yang disaring alamat wallet itu murah: endpoint resmi menjawab
    // 900rb blok dalam 0,34 detik. Potongan kecil (dulu 40rb) cuma memperbanyak
    // panggilan dan memicu 429; kalau sebuah potongan gagal, getLogsSafe memecahnya.
    const chunk = 1_000_000;
    for (let hi = toBlock; hi > fromBlock;) {
      const lo = Math.max(fromBlock, hi - chunk);
      // Arah masuk & keluar dipindai bersamaan — dulu berurutan dan itu yang membuat
      // enumerasi 1 hari makan >14 menit saat RPC sedang sibuk.
      const [logsTo, logsFrom] = await Promise.all([
        getLogsSafe(this.rpc, { address: ADDR.posmV4, topics: [TOPIC.transfer, null, p] }, lo, hi),
        getLogsSafe(this.rpc, { address: ADDR.posmV4, topics: [TOPIC.transfer, p] }, lo, hi),
      ]);
      for (const logs of [logsTo, logsFrom]) {
        for (const l of logs) {
          const id = BigInt(l.topics[3]).toString();
          const bn = parseInt(l.blockNumber, 16);
          const from = asAddr(l.topics[1]);
          const e = held.get(id) || { first: bn, last: bn, mintTx: null, acquiredByMint: false };
          e.first = Math.min(e.first, bn); e.last = Math.max(e.last, bn);
          if (from === ZERO && asAddr(l.topics[2]) === wallet) { e.mintTx = l.transactionHash; e.acquiredByMint = true; e.first = bn; }
          held.set(id, e);
        }
      }
      if (onProgress) onProgress({ phase: 'transfer', scanned: toBlock - lo, total: toBlock - fromBlock });
      hi = lo - 1;
    }
    return held;
  }

  // ---- tahap 2: poolKey tiap tokenId --------------------------------------
  async poolKeys(ids, held) {
    const out = new Map();
    // hidup: langsung dari PositionManager
    const res = await this.rpc.ethCallMany(ids.map((id) => ({
      to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(id)]),
    })));
    const needMint = [];
    ids.forEach((id, i) => {
      if (!res[i] || res[i] === '0x') { needMint.push(id); return; }
      try {
        const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', res[i]);
        const pk = {
          currency0: d[0].currency0.toLowerCase(), currency1: d[0].currency1.toLowerCase(),
          fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks.toLowerCase(),
        };
        // posisi yang sudah dibakar mengembalikan poolKey nol
        if (/^0x0+$/.test(pk.currency1) && pk.fee === 0) { needMint.push(id); return; }
        out.set(id, {
          poolKey: pk, poolId: computePoolId(d[0]),
          tickLower: Number(BigInt.asIntN(24, (d[1] >> 8n) & 0xffffffn)),
          tickUpper: Number(BigInt.asIntN(24, (d[1] >> 32n) & 0xffffffn)),
        });
      } catch { needMint.push(id); }
    });

    // sudah dibakar: ambil dari receipt tx mint-nya
    const txs = [...new Set(needMint.map((id) => held.get(id)?.mintTx).filter(Boolean))];
    if (txs.length) {
      const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
      const byTx = new Map(txs.map((h, i) => [h, rcs[i] && !rcs[i].error ? rcs[i].result : null]));
      for (const id of needMint) {
        const rc = byTx.get(held.get(id)?.mintTx);
        if (!rc) continue;
        for (const l of rc.logs || []) {
          if (l.topics[0] !== TOPIC.modifyLiquidity) continue;
          const b = ethers.getBytes(l.data);
          if (w32(b, 3).toString() !== id) continue;
          out.set(id, {
            poolId: l.topics[1], poolKey: null, hintBlock: parseInt(l.blockNumber, 16), hintTx: rc.transactionHash,
            tickLower: Number(BigInt.asIntN(24, w32(b, 0))),
            tickUpper: Number(BigInt.asIntN(24, w32(b, 1))),
          });
          break;
        }
      }
    }
    return out;
  }

  // ---- tahap 3+4: kejadian tiap posisi ------------------------------------
  async positionEvents(wallet, id, info, span) {
    const logs = await getLogsSafe(this.rpc,
      { address: ADDR.poolManager, topics: [TOPIC.modifyLiquidity, info.poolId] },
      span.first, span.last);
    const mine = [];
    for (const l of logs) {
      const b = ethers.getBytes(l.data);
      if (w32(b, 3).toString() !== id) continue;
      const delta = BigInt.asIntN(256, w32(b, 2));
      // delta nol = klaim fee tanpa mengubah likuiditas. Dulu dilewati, padahal fee
      // yang diklaim di situ adalah bagian dari hasil posisi.
      if (delta === 0n && !this.rpc.hasArchive()) continue;
      mine.push({
        block: parseInt(l.blockNumber, 16), tx: l.transactionHash,
        logIndex: parseInt(l.logIndex, 16), delta,
        tickLower: Number(BigInt.asIntN(24, w32(b, 0))), tickUpper: Number(BigInt.asIntN(24, w32(b, 1))),
      });
    }
    if (!mine.length) return [];

    // receipt per tx (satu tx bisa memuat beberapa kejadian)
    const txs = [...new Set(mine.map((e) => e.tx))];
    const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    const byTx = new Map(txs.map((h, i) => [h, rcs[i] && !rcs[i].error ? rcs[i].result : null]));

    for (const ev of mine) {
      const rc = byTx.get(ev.tx);
      ev.moved = { in0: 0n, in1: 0n, out0: 0n, out1: 0n };
      if (!rc) continue;
      const c0 = info.poolKey?.currency0, c1 = info.poolKey?.currency1;
      for (const l of rc.logs || []) {
        if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
        const tok = l.address.toLowerCase();
        const from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
        const amt = BigInt(l.data);
        const side = tok === c0 ? 0 : tok === c1 ? 1 : null;
        if (side === null) continue;
        // arus antara wallet (atau routernya) dan PoolManager
        if (to === ADDR.poolManager) ev.moved[side === 0 ? 'in0' : 'in1'] += amt;
        else if (from === ADDR.poolManager) ev.moved[side === 0 ? 'out0' : 'out1'] += amt;
      }
      // ETH native tidak punya Transfer ERC20 — pakai nilai tx-nya
      if (c0 === ADDR.native) {
        const tx = await this.rpc.call('eth_getTransactionByHash', [ev.tx]).catch(() => null);
        if (tx && BigInt(tx.value || 0) > 0n && ev.delta > 0n) ev.moved.in0 += BigInt(tx.value);
      }
    }
    return mine;
  }

  // ---- gabungkan jadi satu posisi -----------------------------------------
  async buildPosition(wallet, id, info, span, ethUsd) {
    // poolKey HARUS diselesaikan LEBIH DULU. Pencocokan Transfer ERC20 di
    // positionEvents membutuhkan alamat kedua token; kalau urutannya terbalik,
    // sisi "keluar" tidak pernah cocok dan SETIAP posisi tertutup terlihat rugi
    // sebesar seluruh modalnya — sisi masuk tetap benar karena punya cadangan
    // hitungan pokok, jadi bugnya menyamar sebagai "semua posisi merah".
    if (!info.poolKey) {
      info.poolKey = await this.chain.poolKeyOfId(info.poolId, info.hintBlock || span.first, info.hintTx);
    }
    const events = await this.positionEvents(wallet, id, info, span);
    if (!events.length) return null;

    const toks = info.poolKey
      ? await this.chain.tokens([info.poolKey.currency0, info.poolKey.currency1])
      : null;
    const d0 = toks?.[0]?.decimals ?? 18, d1 = toks?.[1]?.decimals ?? 18;
    const q = info.poolKey ? this.chain.quoteSideOf(info.poolKey.currency0, info.poolKey.currency1) : null;

    const agg = { in0: 0n, in1: 0n, out0: 0n, out1: 0n, fee0: 0n, fee1: 0n };
    let investedQ = 0, returnedQ = 0, feesQ = 0;
    const rows = [];
    let liq = 0n;

    for (const ev of events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
      const abs = ev.delta < 0n ? -ev.delta : ev.delta;
      const sa = m.getSqrtRatioAtTick(ev.tickLower), sb = m.getSqrtRatioAtTick(ev.tickUpper);

      // ---- jalur eksak: state pool & posisi di blok sebelum kejadian (node arsip) ----
      // Tidak bergantung pada Transfer, jadi kebal terhadap netting flash accounting
      // pada rebalance otomatis (tutup + buka dalam satu transaksi).
      let exact = null;
      if (this.rpc.hasArchive()) {
        try {
          exact = await feesAtBlock(this.rpc, {
            poolId: info.poolId, tickLower: ev.tickLower, tickUpper: ev.tickUpper, tokenId: id, block: ev.block,
          });
        } catch (e) { this.log(`fee arsip #${id} @${ev.block} gagal: ${e.message}`); }
      }
      if (exact) {
        const sqrtE = exact.sqrtPriceX96;
        const pr = m.amountsForLiquidity(sqrtE, sa, sb, abs);
        const valE = (a0, a1) => {
          if (!q) return 0;
          const v = this.chain.valueInQuote({
            sqrtPriceX96: sqrtE, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
            token0: info.poolKey.currency0, token1: info.poolKey.currency1,
          });
          return v ? v.value : 0;
        };
        const fv = valE(exact.fee0, exact.fee1);
        feesQ += fv;
        agg.fee0 += exact.fee0; agg.fee1 += exact.fee1;
        let kindE;
        if (ev.delta > 0n) {
          kindE = liq === 0n ? 'mint' : 'increase';
          agg.in0 += pr.amount0; agg.in1 += pr.amount1;
          investedQ += valE(pr.amount0, pr.amount1);
          returnedQ += fv;                    // fee yang terutang ikut dibayarkan saat menambah
        } else if (ev.delta < 0n) {
          kindE = 'decrease';
          agg.out0 += pr.amount0 + exact.fee0; agg.out1 += pr.amount1 + exact.fee1;
          returnedQ += valE(pr.amount0, pr.amount1) + fv;
        } else {
          kindE = 'collect';
          agg.out0 += exact.fee0; agg.out1 += exact.fee1;
          returnedQ += fv;
        }
        liq += ev.delta;
        if (liq < 0n) liq = 0n;
        rows.push({
          block: ev.block, tx: ev.tx, logIndex: ev.logIndex, kind: kindE, delta: ev.delta,
          moved: ev.moved, princ: pr, fee0: exact.fee0, fee1: exact.fee1, sqrt: sqrtE,
          valueQ: valE(pr.amount0, pr.amount1) + (ev.delta > 0n ? 0 : fv),
          tickLower: ev.tickLower, tickUpper: ev.tickUpper,
        });
        continue;
      }
      if (ev.delta === 0n) continue;           // cadangan tidak bisa menilai klaim fee

      // ---- jalur cadangan: harga dari Swap terdekat + jumlah dari Transfer ----
      let sqrt = await this.priceAt(info.poolId, ev.block);
      let princ = { amount0: 0n, amount1: 0n };
      if (sqrt) {
        princ = m.amountsForLiquidity(sqrt, sa, sb, abs);
        // Pengaman: pokok tidak mungkin melebihi yang benar-benar keluar. Kalau itu
        // terjadi, harganya salah (biasanya harga cadangan dari Swap yang jauh) —
        // geser ke harga batas yang membuat pokok = yang diterima di sisi itu.
        if (ev.delta < 0n && (ev.moved.out0 > 0n || ev.moved.out1 > 0n)) {
          if (princ.amount0 > ev.moved.out0 && ev.moved.out0 > 0n) {
            // token0 kebanyakan -> harga terlalu rendah; naikkan sampai a0 = out0
            const s2 = (abs * m.Q96 * sb) / (ev.moved.out0 * sb + abs * m.Q96);
            if (s2 > sa && s2 < sb) sqrt = s2;
          } else if (princ.amount1 > ev.moved.out1 && ev.moved.out1 > 0n) {
            const s2 = sa + (ev.moved.out1 * m.Q96) / abs;
            if (s2 > sa && s2 < sb) sqrt = s2;
          }
          princ = m.amountsForLiquidity(sqrt, sa, sb, abs);
        }
      }
      const val = (a0, a1) => {
        if (!sqrt || !q) return 0;
        const v = this.chain.valueInQuote({
          sqrtPriceX96: sqrt, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
          token0: info.poolKey.currency0, token1: info.poolKey.currency1,
        });
        return v ? v.value : 0;
      };

      let f0 = 0n, f1 = 0n, kind;
      if (ev.delta > 0n) {
        kind = liq === 0n ? 'mint' : 'increase';
        agg.in0 += ev.moved.in0; agg.in1 += ev.moved.in1;
        investedQ += val(ev.moved.in0 || princ.amount0, ev.moved.in1 || princ.amount1);
      } else {
        // Yang keluar = pokok + fee. Pokok dihitung dari L & harga; sisanya fee.
        // Cadangan: kalau Transfer tidak terbaca, setidaknya pokoknya diketahui
        // dari L + harga — lebih baik daripada mencatat nol dan menampilkan posisi
        // seolah rugi total.
        const got0 = ev.moved.out0 > 0n ? ev.moved.out0 : princ.amount0;
        const got1 = ev.moved.out1 > 0n ? ev.moved.out1 : princ.amount1;
        f0 = got0 > princ.amount0 ? got0 - princ.amount0 : 0n;
        f1 = got1 > princ.amount1 ? got1 - princ.amount1 : 0n;
        agg.out0 += got0; agg.out1 += got1;
        agg.fee0 += f0; agg.fee1 += f1;
        returnedQ += val(got0, got1);
        feesQ += val(f0, f1);
        kind = 'decrease';
      }
      liq += ev.delta;
      if (liq < 0n) liq = 0n;

      rows.push({
        block: ev.block, tx: ev.tx, logIndex: ev.logIndex, kind, delta: ev.delta,
        moved: ev.moved, princ, fee0: f0, fee1: f1, sqrt,
        valueQ: val(ev.delta > 0n ? (ev.moved.in0 || princ.amount0) : (ev.moved.out0 || princ.amount0),
          ev.delta > 0n ? (ev.moved.in1 || princ.amount1) : (ev.moved.out1 || princ.amount1)),
      });
    }

    const first = rows[0], last = rows[rows.length - 1];
    const closed = liq === 0n;

    // Posisi yang masih terbuka belum mengembalikan apa pun, jadi "returned" dari
    // riwayat = 0. PnL-nya bukan minus seluruh modal — melainkan nilai posisi
    // SEKARANG plus fee yang belum diklaim, dikurangi modal.
    let liveValueQ = 0, liveFeeQ = 0, inRange = null, curTick = null;
    if (!closed && info.poolKey) {
      const s0 = await this.chain.slot0V4(info.poolId);
      if (s0) {
        curTick = s0.tick;
        const tl = info.tickLower ?? first.tickLower, tu = info.tickUpper ?? first.tickUpper;
        inRange = m.sideOfRange(s0.tick, tl, tu) === 'both';
        const amt = m.amountsForLiquidity(s0.sqrtPriceX96, m.getSqrtRatioAtTick(tl), m.getSqrtRatioAtTick(tu), liq);
        const vq = (a0, a1) => {
          const v = this.chain.valueInQuote({
            sqrtPriceX96: s0.sqrtPriceX96, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
            token0: info.poolKey.currency0, token1: info.poolKey.currency1,
          });
          return v ? v.value : 0;
        };
        liveValueQ = vq(amt.amount0, amt.amount1);
        try {
          const [f] = await unclaimedV4(this.rpc,
            [{ poolId: info.poolId, tickLower: tl, tickUpper: tu, tokenId: id }],
            new Map([[info.poolId, s0.tick]]));
          if (f) liveFeeQ = vq(f.fee0, f.fee1);
        } catch { /* fee tidak terbaca: biarkan 0 */ }
      }
    }
    // Posisi terbuka yang sudah pernah menarik sebagian: hasil penarikan itu (returnedQ)
    // sudah masuk kantong dan harus ikut dihitung — kalau tidak, keuntungan yang sudah
    // diklaim jadi tak terlihat selama posisinya masih berjalan.
    const pnlQ = closed ? (returnedQ - investedQ) : (liveValueQ + liveFeeQ + returnedQ - investedQ);

    return {
      wallet, venue: 'v4', tokenId: id, poolId: info.poolId, poolKey: info.poolKey,
      tickLower: info.tickLower ?? first.tickLower ?? null,
      tickUpper: info.tickUpper ?? first.tickUpper ?? null,
      liquidity: liq, agg,
      investedQ, returnedQ, feesQ, pnlQ,
      liveValueQ, liveFeeQ, inRange, curTick,
      quoteSymbol: q?.symbol || null, quoteKind: q?.kind || 'usd',
      openedBlock: first.block, closedBlock: closed ? last.block : null,
      status: closed ? 'closed' : 'open',
      events: rows,
      symbol0: toks?.[0]?.symbol || '?', symbol1: toks?.[1]?.symbol || '?',
      dec0: d0, dec1: d1,
      // Riwayat bisa terpotong kalau posisi sudah ada sebelum jendela pindai:
      // kejadian pertama yang terlihat bukan mint -> modal awalnya tidak diketahui.
      incomplete: first.kind !== 'mint',
    };
  }

  // ---- pemindaian penuh ---------------------------------------------------
  async scan(wallet, { blocks = 900_000, ethUsd = 2500, onProgress } = {}) {
    wallet = wallet.toLowerCase();
    const head = await this.rpc.blockNumber();
    const from = Math.max(0, head - blocks);
    const held = await this.enumerate(wallet, from, head, onProgress);
    const ids = [...held.keys()];
    if (!ids.length) return { wallet, positions: [], head, from };

    const infos = await this.poolKeys(ids, held);
    const out = [];
    let done = 0;
    for (const id of ids) {
      const info = infos.get(id);
      done++;
      if (onProgress) onProgress({ phase: 'posisi', scanned: done, total: ids.length });
      if (!info) continue;
      const span = held.get(id);
      try {
        const pos = await this.buildPosition(wallet, id, info, { first: span.first, last: Math.min(head, span.last + 5) }, ethUsd);
        if (pos) out.push(pos);
      } catch (e) { this.log(`posisi ${id} gagal: ${e.message}`); }
    }
    await this.persist(wallet, out, { from, head, ethUsd });
    return { wallet, positions: out, head, from };
  }

  // ---- simpan -------------------------------------------------------------
  async persist(wallet, positions, { from, head, ethUsd }) {
    const usd = (v, kind) => (kind === 'eth' ? v * ethUsd : v);
    // Buang sisa pindai lama di dalam jendela ini yang tidak muncul lagi (mis. hasil
    // pindai yang gagal di tengah jalan: posisi tanpa pasangan token dan serba nol).
    // Posisi di luar jendela ini dibiarkan — pindai yang lebih pendek tidak boleh
    // menghapus hasil pindai yang lebih panjang.
    const keep = new Set(positions.map((p) => p.tokenId));
    const stale = this.store.all(
      'SELECT token_id FROM wpositions WHERE wallet=? AND (opened_block IS NULL OR opened_block >= ?)', wallet, from)
      .map((r) => r.token_id).filter((id) => !keep.has(id));
    // Baris tanpa pasangan token = sisa pindai yang gagal di tengah jalan; tidak
    // bisa dinilai dan cuma tampil sebagai "?/?" bernilai nol di mana pun letaknya.
    const broken = this.store.all('SELECT token_id FROM wpositions WHERE wallet=? AND token0 IS NULL', wallet)
      .map((r) => r.token_id).filter((id) => !keep.has(id));
    for (const id of [...stale, ...broken]) {
      this.store.run('DELETE FROM wpositions WHERE wallet=? AND token_id=?', wallet, id);
      this.store.run('DELETE FROM wevents WHERE wallet=? AND token_id=?', wallet, id);
    }
    // Waktu ditaksir dari nomor blok (blok RH chain ~0,101 detik) — dipakai untuk
    // mengelompokkan profit per hari di kalender.
    const tsOf = async (b) => (b == null ? null : await this.chain.blockTs(b));
    for (const p of positions) {
      const openedTs = await tsOf(p.openedBlock);
      const closedTs = await tsOf(p.closedBlock);
      this.store.run(
        `INSERT OR REPLACE INTO wpositions
         (wallet,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
          in0,in1,out0,out1,fee0,fee1,invested_q,returned_q,fees_q,pnl_q,quote_symbol,
          opened_block,opened_ts,closed_block,closed_ts,status,events_n,incomplete,
          live_value_q,live_fee_q,in_range)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        wallet, p.venue, p.tokenId, p.poolId,
        p.poolKey?.currency0 ?? null, p.poolKey?.currency1 ?? null, p.poolKey?.fee ?? null,
        p.poolKey?.tickSpacing ?? null, p.poolKey?.hooks ?? null,
        p.tickLower, p.tickUpper, p.liquidity.toString(),
        p.agg.in0.toString(), p.agg.in1.toString(), p.agg.out0.toString(), p.agg.out1.toString(),
        p.agg.fee0.toString(), p.agg.fee1.toString(),
        usd(p.investedQ, p.quoteKind), usd(p.returnedQ, p.quoteKind), usd(p.feesQ, p.quoteKind), usd(p.pnlQ, p.quoteKind),
        p.quoteSymbol, p.openedBlock, openedTs, p.closedBlock, closedTs, p.status, p.events.length, p.incomplete ? 1 : 0,
        usd(p.liveValueQ || 0, p.quoteKind), usd(p.liveFeeQ || 0, p.quoteKind),
        p.inRange == null ? null : (p.inRange ? 1 : 0));
      p.openedTs = openedTs; p.closedTs = closedTs;

      for (const e of p.events) {
        e.ts = await tsOf(e.block);
        this.store.run(
          `INSERT OR REPLACE INTO wevents
           (wallet,token_id,block,ts,tx_hash,log_index,kind,liq_delta,amount0,amount1,princ0,princ1,fee0,fee1,sqrt_price,value_q)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          wallet, p.tokenId, e.block, e.ts, e.tx, e.logIndex, e.kind, e.delta.toString(),
          (e.delta > 0n ? e.moved.in0 : e.moved.out0).toString(),
          (e.delta > 0n ? e.moved.in1 : e.moved.out1).toString(),
          e.princ.amount0.toString(), e.princ.amount1.toString(),
          e.fee0.toString(), e.fee1.toString(),
          e.sqrt ? e.sqrt.toString() : null, usd(e.valueQ, p.quoteKind));
      }
    }
    const stats = summarize(positions, ethUsd);
    this.store.run(
      `INSERT INTO wallets(address,first_block,scanned_to,last_scan_ts,stats,positions_n) VALUES(?,?,?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET first_block=MIN(first_block,excluded.first_block),
         scanned_to=MAX(scanned_to,excluded.scanned_to), last_scan_ts=excluded.last_scan_ts,
         stats=excluded.stats, positions_n=excluded.positions_n`,
      wallet, from, head, Date.now(), JSON.stringify(stats), positions.length);
    return stats;
  }
}

// ---- ringkasan ------------------------------------------------------------
function summarize(positions, ethUsd = 2500) {
  const usd = (v, kind) => (kind === 'eth' ? v * ethUsd : v);
  const closed = positions.filter((p) => p.status === 'closed' && !p.incomplete);
  const open = positions.filter((p) => p.status === 'open');
  const pnls = closed.map((p) => usd(p.pnlQ, p.quoteKind));
  // Ambang 1 sen: PnL -0,0000001 akibat pembulatan float bukan kekalahan.
  const wins = pnls.filter((x) => x > 0.01).length;
  const decided = pnls.filter((x) => Math.abs(x) > 0.01).length;
  const invested = closed.reduce((s, p) => s + usd(p.investedQ, p.quoteKind), 0);
  return {
    positionsTotal: positions.length,
    openCount: open.length,
    closedCount: closed.length,
    incompleteCount: positions.filter((p) => p.incomplete).length,
    totalProfitUsd: pnls.reduce((s, x) => s + x, 0),
    unrealizedUsd: open.reduce((s, p) => s + usd(p.pnlQ || 0, p.quoteKind), 0),
    openValueUsd: open.reduce((s, p) => s + usd(p.liveValueQ || 0, p.quoteKind), 0),
    openFeeUsd: open.reduce((s, p) => s + usd(p.liveFeeQ || 0, p.quoteKind), 0),
    feeEarnedUsd: positions.reduce((s, p) => s + usd(p.feesQ, p.quoteKind) + usd(p.liveFeeQ || 0, p.quoteKind), 0),
    winRatePct: decided ? (wins / decided) * 100 : 0,
    avgInvestedUsd: closed.length ? invested / closed.length : 0,
    expectedValueUsd: closed.length ? pnls.reduce((s, x) => s + x, 0) / closed.length : 0,
    bestUsd: pnls.length ? Math.max(...pnls) : 0,
    worstUsd: pnls.length ? Math.min(...pnls) : 0,
  };
}

module.exports = { WalletResearch, summarize };
