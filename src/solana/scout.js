'use strict';
// Scout Solana: potret posisi LP yang SEDANG dipegang sebuah wallet di Meteora DLMM,
// Orca Whirlpools, dan Raydium CLMM. Bentuk balikannya sama dengan scoutWallet EVM
// (src/scout.js) supaya dasbor & bot Telegram tidak perlu cabang.
//
// Beda sumber: EVM menelusuri Transfer NFT posisi dalam jendela blok; di sini posisi
// hidup dibaca langsung dari program (adapter.listPositions), dan umur posisi = waktu
// tanda tangan TERTUA di akun posisinya. "Dilepas" diambil dari riset wallet kalau
// wallet itu sudah pernah diriset (tanpa riwayat, jumlahnya tidak diketahui → 0).
const { PublicKey } = require('@solana/web3.js');
const m = require('../v3math');

const MAX_AGE_LOOKUPS = 40;

async function oldestTs(rpc, id) {
  let before, last = null;
  for (let page = 0; page < 3; page++) {
    const sigs = await rpc.run((c) => c.getSignaturesForAddress(new PublicKey(id), { limit: 1000, before }), { needsHistory: true });
    if (!sigs.length) break;
    last = sigs[sigs.length - 1];
    if (sigs.length < 1000) break;
    before = last.signature;
  }
  return last?.blockTime ? last.blockTime * 1000 : null;
}

async function scoutWalletSol(rpc, chain, owner, { ethUsd = 150, onProgress = () => {}, store = null } = {}) {
  const usd = (q, kind) => (kind === 'eth' ? q * ethUsd : q);
  const live = [];
  const failed = [];
  const venues = Object.values(chain.adapters);
  let step = 0;
  const total = venues.length + 2;
  // RPC publik sering 429 untuk getProgramAccounts: tiap venue dicoba sampai 3 kali.
  for (const a of venues) {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try { live.push(...await a.listPositions(owner, (mm) => chain.decimalsMap(mm))); ok = true; }
      catch { if (i < 2) await new Promise((r) => setTimeout(r, 2500 * (i + 1))); }
    }
    if (!ok) failed.push(a.key);
    onProgress({ scanned: ++step, total });
  }
  if (failed.length === venues.length) throw new Error(`posisi tidak terbaca dari RPC (${failed.join(', ')}) — endpoint butuh getProgramAccounts`);

  // State pool & metadata token sekaligus
  const byVenue = new Map();
  for (const p of live) byVenue.set(p.venue, [...new Set([...(byVenue.get(p.venue) || []), p.pool])]);
  const states = new Map();
  for (const [venue, pools] of byVenue) {
    const got = await chain.pools(venue, pools).catch(() => new Map());
    for (const [k, st] of got) states.set(k, st);
  }
  const metas = await chain.tokens([...new Set([...states.values()].flatMap((s) => [s.token0, s.token1]))]).catch(() => []);
  const metaBy = new Map(metas.filter(Boolean).map((t) => [t.address, t]));
  onProgress({ scanned: ++step, total });

  // Umur: tanda tangan tertua akun posisi (paling banyak 40 posisi terbesar, 3 sekaligus).
  const ages = new Map();
  const queue = live.filter((p) => BigInt(p.liquidity || '0') > 0n).slice(0, MAX_AGE_LOOKUPS).map((p) => p.id);
  await Promise.all([0, 1, 2].map(async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try { ages.set(id, await oldestTs(rpc, id)); } catch { /* umur tidak diketahui */ }
    }
  }));
  onProgress({ scanned: ++step, total });

  const now = Date.now();
  const rows = live.map((p) => {
    const st = states.get(p.pool) || null;
    const t0 = st?.token0 ?? p.token0, t1 = st?.token1 ?? p.token1;
    const dec0 = st?.dec0 ?? metaBy.get(t0)?.decimals ?? 9, dec1 = st?.dec1 ?? metaBy.get(t1)?.decimals ?? 9;
    const L = BigInt(p.liquidity || '0');
    const a0 = BigInt(p.amount0 ?? 0n), a1 = BigInt(p.amount1 ?? 0n), f0 = BigInt(p.fee0 ?? 0n), f1 = BigInt(p.fee1 ?? 0n);
    const val = (x0, x1) => (st ? chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: x0, amount1: x1, dec0, dec1, token0: t0, token1: t1 }) : null);
    const v = L > 0n ? val(a0, a1) : null, vf = L > 0n ? val(f0, f1) : null;
    const since = ages.get(p.id) ?? null;
    const r = {
      tokenId: p.id, venue: p.venue, poolId: p.pool,
      poolKey: { currency0: t0, currency1: t1, fee: st?.fee ?? null, tickSpacing: st?.tickSpacing ?? null, hooks: null },
      liqKnown: true, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: L,
      lower: p.lower ?? p.tickLower, upper: p.upper ?? p.tickUpper,
      symbol0: metaBy.get(t0)?.symbol || '?', symbol1: metaBy.get(t1)?.symbol || '?', dec0, dec1,
      quoteSide: chain.quoteSideOf(t0, t1)?.side ?? null,
      curTick: st?.tick ?? null,
      inRange: st ? m.sideOfRange(st.tick, p.tickLower, p.tickUpper) === 'both' : null,
      fee0: f0, fee1: f1, amount0: a0, amount1: a1,
      valueQuote: v?.value ?? 0, feeQuote: vf?.value ?? 0, quoteSymbol: v?.symbol ?? null, quoteKind: v?.kind ?? null,
      widthTicks: p.tickUpper - p.tickLower,
      sinceTs: since, sinceBlock: null,
      ageHours: since ? (now - since) / 3_600_000 : null,
    };
    r.widthPct = (1.0001 ** r.widthTicks - 1) * 100;
    r.valueUsd = usd(r.valueQuote || 0, r.quoteKind);
    r.feeUsd = usd(r.feeQuote || 0, r.quoteKind);
    r.feePerHourUsd = r.ageHours > 0 ? r.feeUsd / r.ageHours : 0;
    r.aprPct = r.valueUsd > 0 && r.ageHours > 0 ? (r.feeUsd / r.valueUsd) * (8760 / r.ageHours) * 100 : 0;
    return r;
  });

  const alive = rows.filter((r) => r.liquidity > 0n);
  const totalVal = alive.reduce((s, r) => s + r.valueUsd, 0);
  const totalFee = alive.reduce((s, r) => s + r.feeUsd, 0);
  const pairs = {};
  for (const r of alive) {
    const k = `${r.symbol0}/${r.symbol1}`;
    pairs[k] = pairs[k] || { n: 0, valueUsd: 0, feeUsd: 0, token0: r.poolKey.currency0, token1: r.poolKey.currency1, symbol0: r.symbol0, symbol1: r.symbol1 };
    pairs[k].n++; pairs[k].valueUsd += r.valueUsd; pairs[k].feeUsd += r.feeUsd;
  }
  const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0);
  const closed = store
    ? store.get("SELECT COUNT(*) n FROM wpositions WHERE chain=? AND wallet=? AND status='closed'", chain.network, owner)?.n ?? 0
    : 0;
  const slot = await rpc.slot?.().catch(() => null);
  return {
    owner, headBlock: slot ?? null, scannedBlocks: null,
    positionsHeld: rows.length, positionsAlive: alive.length,
    positionsClosed: closed,
    totalValueUsd: totalVal, totalUnclaimedFeeUsd: totalFee,
    feeRatioPct: totalVal > 0 ? (totalFee / totalVal) * 100 : 0,
    inRangePct: alive.length ? (alive.filter((r) => r.inRange).length / alive.length) * 100 : 0,
    medianPositionUsd: median(alive.map((r) => r.valueUsd).sort((a, b) => a - b)),
    medianWidthPct: median(alive.map((r) => r.widthPct).sort((a, b) => a - b)),
    medianAgeHours: median(alive.map((r) => r.ageHours || 0).sort((a, b) => a - b)),
    blendedAprPct: totalVal > 0
      ? (totalFee / totalVal) * (8760 / Math.max(1, median(alive.map((r) => r.ageHours || 1).sort((a, b) => a - b)))) * 100
      : 0,
    venuesFailed: failed,
    pairs, positions: rows,
  };
}

module.exports = { scoutWalletSol };
