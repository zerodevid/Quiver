'use strict';
// Memilih pool terbaik untuk swap LANGSUNG ke pool — jalur cadangan auto-swap.
//
// Jalur utama zap tetap Kyber: ia merutekan lintas semua DEX dan pool di chain ini.
// Cadangan ini dipakai kalau Kyber tidak punya rute, rutenya terlalu rugi, tx-nya
// ditolak chain berkali-kali (kutipan basi), atau Kyber dimatikan di config — tiga yang
// pertama sama-sama soal pasar. Galat PENGAMAN Kyber (router tidak cocok, calldata tidak
// terbaca, receipt belum terkonfirmasi) tidak pernah jatuh ke sini. Dulu
// cadangannya memakai pool posisi itu sendiri apa adanya — padahal pool itu sering
// bukan tempat terbaik untuk menukar: fee-nya bisa 4–10%, likuiditasnya tipis sehingga
// swap kecil pun menggeser harga, dan sebagian pool (yang ber-hook) menolak swap lewat
// UniversalRouter sehingga transaksinya revert dan ongkos gas hangus percuma.
//
// Di sini semua pool yang memuat pasangan token itu dikumpulkan dari basis data,
// hasilnya ditaksir (fee + dampak harga), lalu kandidat terbaik DISIMULASIKAN dengan
// eth_call sebagai wallet bot. Yang dikirim hanya swap yang simulasinya lolos: pool
// yang menolak swap tersaring tanpa biaya. Kalau tidak ada yang lolos, pemanggil
// membatalkan zap — dana tetap di wallet.
//
// Taksirannya menganggap likuiditas tetap sepanjang pergerakan harga (sama seperti
// priceImpactBps yang sudah dipakai bot). Itu hanya untuk MENGURUTKAN kandidat;
// kebenaran terakhirnya ada di simulasi, yang memakai amountOutMinimum sungguhan.
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { ensureChain } = require('./networks');
const m = require('./v3math');

const IF_POOL3 = new ethers.Interface(ABI.poolV3);
const lc = (t) => String(t || '').toLowerCase();
// Bit tertinggi uint24 = penanda fee dinamis, bukan besaran fee; besaran yang berlaku
// sekarang dibaca dari slot0 pool.
const DYNAMIC_FEE = 0x800000;
const MAX_CANDIDATES = 8;   // dibaca dari chain
const MAX_SIMULATED = 4;    // disimulasikan; keduanya satu batch, bukan panggilan beruntun

// Hasil swap (kasar) di satu pool, setelah fee, dengan likuiditas dianggap tetap.
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

// Pool yang memuat PERSIS pasangan ini. Pasangan dicocokkan apa adanya (tanpa
// menyamakan ETH dengan WETH): membungkus ETH adalah langkah tersendiri, dan swap
// yang butuh itu bukan lagi "satu transaksi ke satu pool".
function candidates(store, chain, tokenIn, tokenOut) {
  const a = lc(tokenIn), b = lc(tokenOut);
  return store.all(`SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks, pool_addr FROM pools
    WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?))`, chain.network, a, b, b, a);
}

/**
 * Pilih pool + transaksi swap yang simulasinya lolos.
 *
 * Pemanggil WAJIB sudah memastikan izin router (ensureRouterAllowance) sebelum ini:
 * tanpa izin, semua simulasi gagal dan hasilnya "tidak ada pool yang menerima".
 *
 * @returns {{tx, pool, outEst, impactBps, sim}|null} null = tidak ada yang layak;
 *   `reason` pada objek yang dikembalikan lewat parameter `info` menjelaskan kenapa.
 */
async function pickSwapPool({ store, chain, rpc, exec, log = () => {} }, {
  tokenIn, tokenOut, amountIn, minOut, maxImpactBps = 0, deadlineSec, extra = [], info = {},
}) {
  chain = ensureChain(chain);
  // `extra`: pool yang sudah di tangan pemanggil (mis. pool posisi yang sedang dibuka)
  // — ikut dinilai walau belum tercatat di tabel pools.
  const rows = [...extra];
  for (const r of candidates(store, chain, tokenIn, tokenOut)) {
    if (!rows.some((x) => lc(x.pool_ref) === lc(r.pool_ref))) rows.push(r);
  }
  info.found = rows.length;
  if (!rows.length) { info.reason = 'tidak ada pool yang memuat pasangan token ini'; return null; }

  // Pool ber-hook lebih sering menolak swap; yang polos didahulukan saat kandidat
  // harus dipangkas, tetapi tetap ikut kalau kuotanya masih sisa.
  const polos = (r) => !r.hooks || /^0x0+$/.test(r.hooks);
  const urut = [...rows].sort((x, y) => (polos(y) ? 1 : 0) - (polos(x) ? 1 : 0));
  const list = urut.slice(0, MAX_CANDIDATES);
  const v4 = list.filter((r) => r.venue === 'v4');
  const v3 = list.filter((r) => chain.isV3Venue(r.venue) && r.pool_addr);

  // Dua batch untuk v4 (slot0 + likuiditas) dan satu untuk v3 — bukan panggilan
  // beruntun per pool, supaya zap tidak melar saat RPC sedang sibuk.
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
    // Fee dinamis: besaran yang berlaku sekarang ada di slot0, bukan di kolom fee.
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

  // Hasil terbanyak dulu. Taksiran cuma pengurut; simulasi yang memutuskan.
  scored.sort((a, b) => (a.out < b.out ? 1 : a.out > b.out ? -1 : 0));
  const coba = scored.slice(0, MAX_SIMULATED).map((c) => ({
    ...c,
    tx: chain.isV3Venue(c.row.venue)
      ? exec.buildSwapV3(tokenIn, tokenOut, c.row.fee, amountIn, minOut, deadlineSec)
      : exec.buildSwapV4({
        currency0: c.row.token0, currency1: c.row.token1,
        fee: c.row.fee, tickSpacing: c.row.tick_spacing, hooks: c.row.hooks || ethers.ZeroAddress,
      }, c.zeroForOne, amountIn, minOut, deadlineSec),
  }));
  const from = exec.address();
  const sim = await rpc.ethCallMany(coba.map((c) => ({ to: c.tx.to, data: c.tx.data, from, value: c.tx.value })));
  const ok = coba.findIndex((c, i) => sim[i] != null);
  info.simulated = coba.length;
  if (ok < 0) {
    info.reason = `${coba.length} pool teratas menolak swap saat disimulasikan`;
    return null;
  }
  const pick = coba[ok];
  if (ok > 0) log(`pool swap terbaik menolak simulasi — pakai pilihan ke-${ok + 1}: ${pick.row.pool_ref.slice(0, 10)}…`);
  return {
    tx: pick.tx, pool: pick.row, outEst: pick.out,
    impactBps: pick.impactBps, feePpm: pick.feePpm, rank: ok,
  };
}

module.exports = { pickSwapPool, estimate, DYNAMIC_FEE };
