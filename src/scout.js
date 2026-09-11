'use strict';
// "Scout": nilai sebuah wallet SEBELUM dicopy.
//
// Yang bisa dihitung persis tanpa node arsip: posisi yang masih hidup — pasangan,
// rentang, nilai sekarang, fee yang sudah terkumpul tapi belum diklaim, umur.
// Rasio fee/nilai per jam adalah sinyal terkuat yang tersedia, dan angkanya eksak
// karena dibaca dari storage pool, bukan ditaksir.
const { ethers } = require('ethers');
const { ADDR, TOPIC, ABI } = require('./chain');
const { computePoolId } = require('./pools');
const { unclaimedV4 } = require('./fees');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const hex = (n) => '0x' + n.toString(16);

/**
 * getLogs dengan pemecahan rentang adaptif.
 * Gotcha yang pernah menggigit: kalau kegagalan query ditelan diam-diam, hasilnya
 * scan "sukses" tapi kosong — dan bot menyimpulkan wallet tidak punya posisi.
 * Di sini setiap kegagalan memecah rentang; kalau sudah tidak bisa dipecah, dilempar.
 */
const TRANSIENT = /network is busy|timeout|429|too many requests|503|502|temporarily|try again|tumbang/i;
const RATE_LIMIT = /429|too many requests|tumbang/i;

async function getLogsSafe(rpc, filter, lo, hi, depth = 0) {
  // Dua jenis kegagalan yang butuh penanganan BERBEDA:
  //  - rentang terlalu besar -> pecah dua
  //  - upstream sedang sibuk  -> tunggu lalu ulangi rentang yang SAMA
  // Memecah rentang untuk error sesaat itu sia-sia: ia mengecil sampai satu blok
  // lalu menyerah, padahal rentang aslinya tidak bermasalah.
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await rpc.getLogs({ ...filter, fromBlock: hex(lo), toBlock: hex(hi) });
    } catch (e) {
      if (!TRANSIENT.test(e.message)) {
        if (hi - lo < 2 || depth > 12) throw new Error(`getLogs ${lo}-${hi} gagal: ${e.message}`);
        const mid = Math.floor((lo + hi) / 2);
        const a = await getLogsSafe(rpc, filter, lo, mid, depth + 1);
        const b = await getLogsSafe(rpc, filter, mid + 1, hi, depth + 1);
        return a.concat(b);
      }
      // Dibatasi laju (429): memecah rentang justru MELIPATGANDAKAN jumlah permintaan
      // dan memperparah hukuman — jadi hanya menunggu lalu mengulang rentang yang sama.
      // "network is busy" berbeda: sering muncul untuk query berat, jadi setelah dua
      // kali gagal, rentangnya dipecah.
      const limited = RATE_LIMIT.test(e.message);
      const giveUpSplit = !limited && attempt >= 1;
      if (attempt === maxAttempts - 1 || giveUpSplit) {
        if (hi - lo < 2 || depth > 12) throw new Error(`getLogs ${lo}-${hi} gagal setelah ${attempt + 1} percobaan: ${e.message}`);
        const mid = Math.floor((lo + hi) / 2);
        const a = await getLogsSafe(rpc, filter, lo, mid, depth + 1);
        const b = await getLogsSafe(rpc, filter, mid + 1, hi, depth + 1);
        return a.concat(b);
      }
      await new Promise((r) => setTimeout(r, (limited ? 5000 : 1500) * (attempt + 1)));
    }
  }
  return [];
}

/** Kumpulkan tokenId v4 milik `owner` dari log Transfer, mundur `blocks` blok. */
async function enumerateV4(rpc, owner, headBlock, blocks, chunk = 60_000, onProgress) {
  const pad = '0x' + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const from = Math.max(0, headBlock - blocks);
  const events = [];
  for (let hi = headBlock; hi > from;) {
    const lo = Math.max(from, hi - chunk);
    for (const dir of ['to', 'from']) {
      const topics = dir === 'to' ? [TOPIC.transfer, null, pad] : [TOPIC.transfer, pad];
      const logs = await getLogsSafe(rpc, { address: ADDR.posmV4, topics }, lo, hi);
      for (const l of logs) {
        events.push({
          block: parseInt(l.blockNumber, 16),
          tokenId: BigInt(l.topics[3]).toString(),
          from: asAddr(l.topics[1]), to: asAddr(l.topics[2]),
        });
      }
    }
    if (onProgress) onProgress({ scanned: headBlock - lo, total: headBlock - from });
    hi = lo - 1;
  }
  events.sort((a, b) => a.block - b.block);
  const held = new Map();  // tokenId -> {sinceBlock}
  for (const e of events) {
    if (e.to === owner) held.set(e.tokenId, { sinceBlock: e.block, minted: e.from === '0x0000000000000000000000000000000000000000' });
    else if (e.from === owner) held.delete(e.tokenId);
  }
  return { held, events };
}

/** Rincian posisi v4 yang masih hidup (dipakai scout maupun pantau target). */
async function livePositions(rpc, chain, tokenIds) {
  if (!tokenIds.length) return [];
  const info = await rpc.ethCallMany(tokenIds.map((id) => ({
    to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(id)]),
  })));
  const liq = await rpc.ethCallMany(tokenIds.map((id) => ({
    to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(id)]),
  })));
  const rows = [];
  tokenIds.forEach((id, i) => {
    if (!info[i] || info[i] === '0x') return;
    let pk, inf;
    try {
      const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', info[i]);
      pk = { currency0: d[0].currency0.toLowerCase(), currency1: d[0].currency1.toLowerCase(), fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks.toLowerCase() };
      inf = d[1];
    } catch { return; }
    if (/^0x0+$/.test(pk.currency1) && pk.fee === 0) return; // sudah dibakar
    const L = liq[i] && liq[i] !== '0x' ? BigInt(liq[i]) : 0n;
    rows.push({
      tokenId: id, poolKey: pk, poolId: computePoolId(pk),
      tickLower: Number(BigInt.asIntN(24, (inf >> 8n) & 0xffffffn)),
      tickUpper: Number(BigInt.asIntN(24, (inf >> 32n) & 0xffffffn)),
      liquidity: L,
    });
  });
  const poolIds = [...new Set(rows.map((r) => r.poolId))];
  const slots = await chain.slot0V4Many(poolIds);
  const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
  const curTick = new Map([...slotBy.entries()].filter(([, s]) => s).map(([k, s]) => [k, s.tick]));
  const fees = await unclaimedV4(rpc, rows.filter((r) => r.liquidity > 0n)
    .map((r) => ({ poolId: r.poolId, tickLower: r.tickLower, tickUpper: r.tickUpper, tokenId: r.tokenId })), curTick);
  let fi = 0;
  const toks = new Set();
  for (const r of rows) { toks.add(r.poolKey.currency0); toks.add(r.poolKey.currency1); }
  const metas = await chain.tokens([...toks]);
  const metaBy = new Map(metas.map((t) => [t.address, t]));

  for (const r of rows) {
    const s = slotBy.get(r.poolId);
    const f = r.liquidity > 0n ? (fees[fi++] || { fee0: 0n, fee1: 0n }) : { fee0: 0n, fee1: 0n };
    const d0 = metaBy.get(r.poolKey.currency0)?.decimals ?? 18;
    const d1 = metaBy.get(r.poolKey.currency1)?.decimals ?? 18;
    r.symbol0 = metaBy.get(r.poolKey.currency0)?.symbol || '?';
    r.symbol1 = metaBy.get(r.poolKey.currency1)?.symbol || '?';
    r.dec0 = d0; r.dec1 = d1;
    r.quoteSide = chain.quoteSideOf(r.poolKey.currency0, r.poolKey.currency1)?.side ?? null;
    r.curTick = s?.tick ?? null;
    r.inRange = s ? m.sideOfRange(s.tick, r.tickLower, r.tickUpper) === 'both' : null;
    r.fee0 = f.fee0; r.fee1 = f.fee1;
    if (s && r.liquidity > 0n) {
      const amt = m.amountsForLiquidity(s.sqrtPriceX96, m.getSqrtRatioAtTick(r.tickLower), m.getSqrtRatioAtTick(r.tickUpper), r.liquidity);
      r.amount0 = amt.amount0; r.amount1 = amt.amount1;
      const v = chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1, dec0: d0, dec1: d1, token0: r.poolKey.currency0, token1: r.poolKey.currency1 });
      const vf = chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, amount0: f.fee0, amount1: f.fee1, dec0: d0, dec1: d1, token0: r.poolKey.currency0, token1: r.poolKey.currency1 });
      r.valueQuote = v?.value ?? null; r.feeQuote = vf?.value ?? null; r.quoteSymbol = v?.symbol ?? null;
      r.quoteKind = v?.kind ?? null;
    } else { r.valueQuote = 0; r.feeQuote = 0; }
    r.widthTicks = r.tickUpper - r.tickLower;
    r.widthPct = (1.0001 ** r.widthTicks - 1) * 100;
  }
  return rows;
}

/** Rapor lengkap satu wallet. */
async function scoutWallet(rpc, chain, owner, { blocks = 2_600_000, ethUsd = 2500, onProgress } = {}) {
  const head = await rpc.blockNumber();
  const { held, events } = await enumerateV4(rpc, owner, head, blocks, 150_000, onProgress);
  const ids = [...held.keys()];
  const rows = await livePositions(rpc, chain, ids);
  const usd = (q, kind) => (kind === 'eth' ? q * ethUsd : q);

  for (const r of rows) {
    const h = held.get(r.tokenId);
    r.sinceBlock = h?.sinceBlock ?? null;
    r.ageHours = h ? ((head - h.sinceBlock) * 0.101) / 3600 : null;
    r.valueUsd = usd(r.valueQuote || 0, r.quoteKind);
    r.feeUsd = usd(r.feeQuote || 0, r.quoteKind);
    r.feePerHourUsd = r.ageHours > 0 ? r.feeUsd / r.ageHours : 0;
    r.aprPct = r.valueUsd > 0 && r.ageHours > 0 ? (r.feeUsd / r.valueUsd) * (8760 / r.ageHours) * 100 : 0;
  }
  const alive = rows.filter((r) => r.liquidity > 0n);
  const totalVal = alive.reduce((s, r) => s + r.valueUsd, 0);
  const totalFee = alive.reduce((s, r) => s + r.feeUsd, 0);
  const closedIds = new Set(events.filter((e) => e.from === owner).map((e) => e.tokenId));

  // profil rentang & pasangan
  const pairs = {};
  for (const r of alive) {
    const k = `${r.symbol0}/${r.symbol1}`;
    pairs[k] = pairs[k] || { n: 0, valueUsd: 0, feeUsd: 0, token0: r.poolKey.currency0, token1: r.poolKey.currency1, symbol0: r.symbol0, symbol1: r.symbol1 };
    pairs[k].n++; pairs[k].valueUsd += r.valueUsd; pairs[k].feeUsd += r.feeUsd;
  }
  const widths = alive.map((r) => r.widthPct).sort((a, b) => a - b);
  const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0);

  return {
    owner, headBlock: head, scannedBlocks: blocks,
    positionsHeld: ids.length, positionsAlive: alive.length,
    positionsClosed: closedIds.size,
    totalValueUsd: totalVal, totalUnclaimedFeeUsd: totalFee,
    feeRatioPct: totalVal > 0 ? (totalFee / totalVal) * 100 : 0,
    inRangePct: alive.length ? (alive.filter((r) => r.inRange).length / alive.length) * 100 : 0,
    medianPositionUsd: median(alive.map((r) => r.valueUsd).sort((a, b) => a - b)),
    medianWidthPct: median(widths),
    medianAgeHours: median(alive.map((r) => r.ageHours || 0).sort((a, b) => a - b)),
    blendedAprPct: totalVal > 0
      ? (totalFee / totalVal) * (8760 / Math.max(1, median(alive.map((r) => r.ageHours || 1).sort((a, b) => a - b)))) * 100
      : 0,
    pairs, positions: rows,
  };
}

module.exports = { scoutWallet, enumerateV4, livePositions, getLogsSafe };
