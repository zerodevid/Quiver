'use strict';
// Kedalaman harga & risiko keluar untuk pool Solana — bentuk balikan sama dengan
// src/pool-depth.js, jadi model di dasbor (web/src/liquidityRisk.mjs) dipakai apa adanya.
//
//   Orca / Raydium : tick array → tick terinisialisasi + liquidityNet (satuan Uniswap)
//   Meteora DLMM   : tiap bin (isi X & Y mentah) diubah jadi L setara di rentang tick
//                    bin itu — L = nilai bin dalam Y / (√P_atas − √P_bawah), sehingga
//                    menyeberangi bin penuh di model = menukar seluruh isi bin. Harga
//                    model diletakkan di tengah bin aktif (bin DLMM berharga tetap).
// Posisi (kita & target) dibaca live lewat adapter. Posisi DLMM tidak seragam per bin;
// di model ia diwakili L seragam yang nilainya sama di harga sekarang (perkiraan).
const { PublicKey } = require('@solana/web3.js');
const m = require('../v3math');
const u = require('./units');

const SPAN = 14_000;           // ± tick dari harga kini, sama dengan EVM
const MAX_ARRAYS = 64;         // per sisi (Orca/Raydium) — batas akun yang dibaca
const MAX_BINS = 700;          // per sisi (DLMM)
const Q96 = 2 ** 96;
const sqrtRaw = (tick) => Math.sqrt(1.0001 ** tick);

// L seragam setara untuk isi (a0, a1) di rentang [tl, tu) pada √harga s (mentah).
function uniformL(a0, a1, tl, tu, s) {
  const sa = sqrtRaw(tl), sb = sqrtRaw(tu), c = Math.max(sa, Math.min(sb, s));
  const v1 = Number(a1) + Number(a0) * s * s;                  // nilai dalam Y
  const per = (c - sa) + s * s * (1 / c - 1 / sb);              // nilai per 1 L
  return per > 0 ? v1 / per : 0;
}

async function poolDepthSol({ rpc, chain, store, engine }, ref) {
  const venue = await chain.venueOfPool(ref).catch(() => null);
  if (!venue) return { error: 'Pool belum memiliki metadata kedalaman.' };
  const pool = await chain.pool(venue, ref, { maxAgeMs: 0 });
  if (!pool || pool.dec0 == null) return { error: 'Harga pool tidak tersedia.' };
  const q = chain.QUOTES[pool.token0] ? (chain.quoteSideOf(pool.token0, pool.token1)?.side ?? 0) : chain.QUOTES[pool.token1] ? 1 : null;
  if (q == null) return { error: 'Aset kuotasi pool belum didukung.' };
  const ad = chain.adapter(venue);
  const slot = await rpc.slot().catch(() => null);

  let ticks = [], L, tick = pool.tick, sqrt = pool.sqrtX96, start, end;
  if (venue === 'meteora') {
    const tpb = u.ticksPerBin(pool.binStep);
    const n = Math.min(MAX_BINS, Math.ceil(SPAN / tpb));
    const bins = (await ad.depth(pool, n, n)).sort((a, b) => a.bin - b.bin);
    const Ls = new Map();
    for (const b of bins) {
      const { tickLower: tl, tickUpper: tu } = u.binRangeToTicks(b.bin, b.bin, pool.binStep);
      const p = (1 + pool.binStep / 10_000) ** b.bin;              // Y per X mentah
      const den = sqrtRaw(tu) - sqrtRaw(tl);
      Ls.set(b.bin, den > 0 ? (Number(b.y) + Number(b.x) * p) / den : 0);
    }
    // Batas tiap bin: net = L bin ini − L bin di bawahnya.
    let prev = 0;
    const lo = bins[0]?.bin ?? pool.current, hi = bins[bins.length - 1]?.bin ?? pool.current;
    for (let b = lo; b <= hi + 1; b++) {
      const cur = b <= hi ? (Ls.get(b) || 0) : 0;
      const net = cur - prev;
      if (Math.abs(net) > 0) ticks.push({ tick: u.binToTick(b, pool.binStep), net: BigInt(Math.round(net)).toString() });
      prev = cur;
    }
    L = BigInt(Math.round(Ls.get(pool.current) || 0));
    const { tickLower: tl, tickUpper: tu } = u.binRangeToTicks(pool.current, pool.current, pool.binStep);
    tick = tl;
    sqrt = m.getSqrtRatioAtTick(Math.floor((tl + tu) / 2));
    start = u.binToTick(lo, pool.binStep); end = u.binToTick(hi + 1, pool.binStep);
  } else {
    const span = (venue === 'orca' ? 88 : 60) * pool.spacing;
    const reach = Math.min(SPAN, MAX_ARRAYS * span);
    start = Math.max(-443636, pool.tick - reach); end = Math.min(443636, pool.tick + reach);
    ticks = await ad.depth(pool, start, end);
    L = BigInt(pool.liquidity ?? 0n);
  }

  // Posisi kita & target di pool ini, dibaca live.
  const own = store.all("SELECT * FROM positions WHERE chain=? AND pool_ref=? AND status='open' AND token_id IS NOT NULL", chain.network, ref);
  const watched = store.all("SELECT w.*, t.label FROM wpositions w JOIN targets t ON t.address=w.wallet AND t.chain=w.chain WHERE w.chain=? AND w.pool_ref=? AND w.status='open'", chain.network, ref);
  const req = new Map();
  const add = (id, owner, kind, rowId, label = null) => { if (id && !req.has(id)) req.set(id, { tokenId: id, owner, kind, id: rowId, label }); };
  for (const r of own) add(r.token_id, engine.exec.address(), 'own', r.id);
  for (const r of watched) add(r.token_id, r.wallet, 'target', r.id, r.label);
  for (const r of own) if (r.target && r.mirror_of) add(r.mirror_of, r.target, 'target', r.id);
  const list = [...req.values()].slice(0, 40);
  let missingPositions = req.size > 40;
  const positions = [];
  if (list.length) {
    let live = new Map();
    try { live = await ad.getPositions(list.map((r) => ({ id: r.tokenId, pool: ref })), (mm) => chain.decimalsMap(mm)); }
    catch { missingPositions = true; }
    const s = Number(sqrt) / Q96;
    for (const r of list) {
      const p = live.get(r.tokenId);
      if (!p) { missingPositions = true; continue; }
      if (r.owner && p.owner && p.owner !== r.owner) { missingPositions = true; continue; }
      const liquidity = venue === 'meteora'
        ? String(Math.round(uniformL(p.amount0, p.amount1, p.tickLower, p.tickUpper, s)))
        : String(p.liquidity);
      positions.push({ ...r, lower: p.tickLower, upper: p.tickUpper, liquidity });
    }
  }

  // Saldo token dasar di wallet target (skenario "jual juga yang di wallet").
  const base = q === 0 ? pool.token1 : pool.token0, dec = q === 0 ? pool.dec1 : pool.dec0;
  const walletBalances = [];
  let missingWallets = false;
  for (const owner of [...new Set(positions.filter((p) => p.kind === 'target').map((p) => p.owner))]) {
    try {
      const r = await rpc.run((c) => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(base) }), { indexed: true });
      const raw = r.value.reduce((a, x) => a + BigInt(x.account.data?.parsed?.info?.tokenAmount?.amount || '0'), 0n);
      walletBalances.push({ owner, base: Number(raw) / 10 ** dec });
    } catch { missingWallets = true; }
  }

  const fee = (pool.fee || 0) / 1e6;
  const qt = q === 0 ? pool.token0 : pool.token1;
  return {
    ref, block: slot, fetchedAt: Date.now(), tick, sqrt: String(sqrt), liquidity: String(L), ticks, start, end,
    dec0: pool.dec0, dec1: pool.dec1, quoteSide: q, quoteUsd: chain.QUOTES[qt].kind === 'eth' ? engine.ethUsd : 1,
    buyFee: fee, sellFee: fee, hook: false,
    positions, missingPositions, walletBalances, missingWallets, targetScope: 'watched_positions',
    // Fee DLMM = fee dasar + fee variabel yang naik saat volatil.
    dynamicFee: venue === 'meteora', venue,
  };
}

module.exports = { poolDepthSol, uniformL };
