'use strict';
// Automatic fee harvesting on Solana — settings, schedule, modes and bookkeeping exactly as
// src/compound.js (inherited). Only the transactions differ:
//   compound — claim the fees then add them back to the same position (two transactions,
//              through the venue adapter). Fees that go back in = profit kept inside the LP
//              (compound_runs), not new capital; only what is left in the wallet is booked
//              as a fee claim.
//   claim    — engine.claimFees (claim + sell the memecoin side when sellFee is on).
const { Compound } = require('../compound');
const { quoteToUsd } = require('../policy');

class SolanaCompound extends Compound {
  supported(pos) { return !!this.chain.isSolVenue?.(pos.venue); }
  // Booked right after confirmation — there are no pending transactions to reconcile.
  pending() { return null; }
  async reconcile() {}

  async runCompound(pos, st) {
    const e = this.engine;
    const ad = this.chain.adapter(pos.venue);
    const owner = e.exec.address();
    const rules = e.rulesFrom(pos.target);
    e.exiting.add(pos.id);
    try {
      const read = async () => (await ad.getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(pos.token_id);
      const before = await read();
      if (!before) throw new Error('posisi tidak terbaca');
      const pool = await this.chain.pool(pos.venue, pos.pool_ref, { maxAgeMs: 0 });
      const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
      const val = (a0, a1) => this.chain.valueInQuote({ sqrtPriceX96: pool.sqrtX96, amount0: a0, amount1: a1, dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 });
      const fv = val(before.fee0, before.fee1);
      const feeUsd = fv ? quoteToUsd(fv.value, fv.kind, e.ethUsd) : 0;
      if (!(feeUsd >= st.minUsd)) { this.note(pos.id, `fee $${feeUsd.toFixed(2)} belum mencapai minimum compound $${st.minUsd}`); return; }
      // Position value & exposure limits — as on EVM: compounding must not push a position
      // past the caps that also limit entries.
      const cur = val(before.amount0, before.amount1);
      const curUsd = cur ? quoteToUsd(cur.value, cur.kind, e.ethUsd) : 0;
      const cap = Math.min(rules.sizing.max_quote_per_position_usd - curUsd, rules.sizing.max_total_exposure_usd - e.positions.summary(e.ethUsd).exposureUsd);
      if (!(cap > 0)) { this.note(pos.id, 'batas nilai posisi atau eksposur sudah tercapai'); return; }
      const scale = feeUsd > cap ? cap / feeUsd : 1;
      const slip = BigInt(rules.swap.max_slippage_bps);
      const usable = (x) => (BigInt(Math.floor(Number(x) * scale)) * (10_000n - slip)) / 10_000n;
      if (e.dryRun() || e.paused() || !this.status(pos).enabled) return;

      // 1) claim
      const claim = await ad.buildClaim({ pool: pos.pool_ref, position: pos.token_id, owner });
      const c = await e.exec.sendGroups(claim.groups, { kind: 'compound', detail: { position: pos.id, step: 'claim' } });
      const claimHash = c.hashes[c.hashes.length - 1] || null;
      if (!c.ok) throw new Error(`klaim fee untuk compound gagal${claimHash ? ` (${claimHash})` : ''}`);
      // 2) add liquidity with the fees just claimed
      let addHash = null, dep0 = 0n, dep1 = 0n, after = null;
      const a0 = usable(before.fee0), a1 = usable(before.fee1);
      if (a0 > 0n || a1 > 0n) {
        try {
          // DLMM: reinvest in the shape the position was opened with (null = read it from the bins).
          let strategy = null;
          try { strategy = JSON.parse(pos.ext || '{}')?.strategy || null; } catch { strategy = null; }
          const inc = await ad.buildIncrease({ pool: pos.pool_ref, position: pos.token_id, amount0: a0, amount1: a1, slippageBps: Number(slip), owner, strategy });
          const r = await e.exec.sendGroups(inc.groups, { kind: 'compound', detail: { position: pos.id, step: 'increase' } });
          addHash = r.hashes[r.hashes.length - 1] || null;
          if (r.ok) {
            after = await read();
            if (after) {
              const d0 = BigInt(after.amount0) - BigInt(before.amount0), d1 = BigInt(after.amount1) - BigInt(before.amount1);
              dep0 = d0 > 0n ? (d0 < BigInt(before.fee0) ? d0 : BigInt(before.fee0)) : 0n;
              dep1 = d1 > 0n ? (d1 < BigInt(before.fee1) ? d1 : BigInt(before.fee1)) : 0n;
            }
          }
        } catch (err) { this.store.log('warn', `compound #${pos.id}: fee sudah diklaim, penambahan likuiditas gagal (${err.message}) — sisanya dibukukan sebagai klaim`, { quiet: true }); }
      }
      // 3) bookkeeping: what went back in → compound_runs; the rest → a plain fee claim
      const dv = val(dep0, dep1);
      if (addHash && (dep0 > 0n || dep1 > 0n)) {
        const dL = after ? BigInt(after.liquidity) - BigInt(before.liquidity) : 0n;
        this.store.run('INSERT OR IGNORE INTO compound_runs(tx_hash,position_id,ts,liquidity,reinvested_quote) VALUES(?,?,?,?,?)',
          addHash, pos.id, Date.now(), dL.toString(), dv?.value ?? 0);
      }
      const r0 = BigInt(before.fee0) - dep0, r1 = BigInt(before.fee1) - dep1;
      if (r0 > 0n || r1 > 0n) await e.bookFeeClaim(pos, r0, r1, claimHash);
      this.store.run('UPDATE compound_settings SET last_tx=?,last_note=? WHERE position_id=?', addHash || claimHash,
        addHash ? `compound berhasil · $${quoteToUsd(dv?.value ?? 0, dv?.kind, e.ethUsd).toFixed(2)} masuk lagi ke posisi` : 'fee diklaim; penambahan likuiditas tidak terjadi', pos.id);
      e.notify(`compound posisi #${pos.id}: $${feeUsd.toFixed(2)} fee${addHash ? ' dimasukkan lagi ke posisi' : ' diklaim'}`, { kind: 'fee_claim', positionId: pos.id, txHash: addHash || claimHash, usd: feeUsd, auto: true });
      try { await e.positions.sync(e.ethUsd); } catch { /* next sync */ }
    } catch (err) {
      this.note(pos.id, err.message);
      this.store.log('warn', `auto-compound #${pos.id}: ${err.message}`, { quiet: true });
    } finally { e.exiting.delete(pos.id); }
  }
}

module.exports = { SolanaCompound };
