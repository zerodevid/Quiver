'use strict';
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { ensureChain } = require('./networks');
const { unclaimedV4 } = require('./fees');
const { quoteToUsd } = require('./policy');
const m = require('./v3math');
const IF_POSM = new ethers.Interface(ABI.posmV4);

class Compound {
  constructor(engine) {
    this.engine = engine;
    this.store = engine.store;
    this.chain = ensureChain(engine.chain);
    this.running = false;
  }

  status(pos) {
    const s = this.store.get('SELECT * FROM compound_settings WHERE position_id=?', pos.id);
    const q = this.store.get('SELECT COALESCE(SUM(reinvested_quote),0) total FROM compound_runs WHERE position_id=?', pos.id)?.total || 0;
    return { supported: pos.venue === 'v4', enabled: !!s?.enabled, minUsd: s?.min_usd ?? 5,
      intervalMinutes: s?.interval_minutes ?? 30, lastCheck: s?.last_check || null,
      lastTx: s?.last_tx || null, lastNote: s?.last_note || null,
      compoundedUsd: q * (this.chain.isEthLike(pos.quote_symbol) ? this.engine.ethUsd : 1) };
  }

  configure(id, input) {
    const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", id);
    if (!pos) throw new Error('posisi tidak ditemukan');
    if (pos.venue !== 'v4') throw new Error('auto-compound tersedia untuk posisi Uniswap v4');
    const old = this.status(pos);
    const enabled = input.enabled ?? old.enabled;
    const minUsd = Number(input.minUsd ?? old.minUsd), intervalMinutes = Number(input.intervalMinutes ?? old.intervalMinutes);
    if (typeof enabled !== 'boolean') throw new Error('enabled harus boolean');
    if (!Number.isFinite(minUsd) || minUsd < 0.01 || minUsd > 1_000_000) throw new Error('minimum compound harus $0,01 sampai $1.000.000');
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) throw new Error('interval compound harus 1 sampai 10.080 menit');
    this.store.run(`INSERT INTO compound_settings(position_id,enabled,min_usd,interval_minutes) VALUES(?,?,?,?)
      ON CONFLICT(position_id) DO UPDATE SET enabled=excluded.enabled,min_usd=excluded.min_usd,
      interval_minutes=excluded.interval_minutes`, id, enabled ? 1 : 0, minUsd, intervalMinutes);
    return this.status(pos);
  }

  pending(id) {
    return this.store.get(`SELECT t.* FROM txs t LEFT JOIN compound_runs c ON c.tx_hash=t.hash
      WHERE t.kind='compound' AND t.status!='gagal' AND c.tx_hash IS NULL
      AND json_extract(t.detail,'$.position')=? ORDER BY t.ts LIMIT 1`, id);
  }

  async plan(pos) {
    const e = this.engine;
    const slot = await e.chain.slot0V4(pos.pool_ref);
    if (!slot) throw new Error('harga pool belum terbaca');
    const [fees] = await unclaimedV4(this.chain, [{ poolId: pos.pool_ref, tickLower: pos.tick_lower,
      tickUpper: pos.tick_upper, tokenId: pos.token_id }], new Map([[pos.pool_ref, slot.tick]]), e.rpc);
    const rules = e.rulesFrom(pos.target);
    if (pos.hooks && !/^0x0+$/i.test(pos.hooks) && !rules.filters.allow_hooks) return { skip: 'pool ber-hook belum diizinkan' };
    const slip = Number(rules.swap.max_slippage_bps);
    if (!Number.isInteger(slip) || slip < 0 || slip >= 10000) throw new Error('slippage tidak valid untuk compound');
    const usable = (n) => { const v = n * BigInt(10000 - slip) / 10000n; return v > 2n ? v - 2n : 0n; };
    const sa = m.getSqrtRatioAtTick(pos.tick_lower), sb = m.getSqrtRatioAtTick(pos.tick_upper);
    let L = m.liquidityForAmounts(slot.sqrtPriceX96, sa, sb, usable(fees.fee0), usable(fees.fee1));
    if (L <= 0n) return { skip: 'fee belum cukup atau rasio token belum cocok untuk compound' };
    const [t0, t1] = await e.chain.tokens([pos.token0, pos.token1]);
    const value = (liquidity) => {
      const amounts = m.amountsForLiquidity(slot.sqrtPriceX96, sa, sb, liquidity);
      const v = e.chain.valueInQuote({ sqrtPriceX96: slot.sqrtPriceX96, ...amounts,
        dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 });
      if (!v || !Number.isFinite(v.value)) throw new Error('nilai compound belum terbaca');
      return { ...amounts, valueQuote: v.value, valueUsd: quoteToUsd(v.value, v.kind, e.ethUsd) };
    };
    let est = value(L);
    const current = value(fees.liquidity);
    const cap = Math.min(rules.sizing.max_quote_per_position_usd - current.valueUsd,
      rules.sizing.max_total_exposure_usd - e.positions.summary(e.ethUsd).exposureUsd);
    if (!(cap > 0)) return { skip: 'batas nilai posisi atau eksposur sudah tercapai' };
    if (est.valueUsd > cap) {
      L = L * BigInt(Math.floor(cap * 1e6)) / BigInt(Math.ceil(est.valueUsd * 1e6));
      est = value(L);
    }
    if (L <= 0n || est.valueUsd < this.status(pos).minUsd) return { skip: 'fee yang bisa ditambahkan belum mencapai minimum compound' };
    const max = (n, fee) => { const padded = (n * BigInt(10000 + slip) + 9999n) / 10000n + 2n; return padded < fee ? padded : fee; };
    const poolKey = await e.poolKeyOf(pos);
    if (!poolKey) throw new Error('poolKey posisi tidak terbaca');
    return { tokenId: pos.token_id, poolKey, liquidity: L.toString(),
      amount0Max: max(est.amount0, fees.fee0).toString(), amount1Max: max(est.amount1, fees.fee1).toString(),
      valueQuote: est.valueQuote, valueUsd: est.valueUsd };
  }

  async finish(pos, hash, receipt) {
    const d = JSON.parse(this.store.get('SELECT detail FROM txs WHERE hash=?', hash)?.detail || '{}');
    // Fixed L is encoded in the successful transaction. Sync reads the resulting
    // onchain liquidity; do not add it to a DB row that may already be synced.
    this.store.run('INSERT OR IGNORE INTO compound_runs(tx_hash,position_id,ts,liquidity,reinvested_quote) VALUES(?,?,?,?,?)',
      hash, pos.id, Date.now(), d.liquidity, d.valueQuote);
    this.store.run('UPDATE compound_settings SET last_tx=?,last_note=? WHERE position_id=?', hash, 'compound berhasil', pos.id);
    // Only residual tokens reached the wallet. Reinvested fees remain profit
    // inside the LP, not fresh capital and not a second realized gain.
    try { await this.engine.recordFeeClaim(pos, hash, receipt); }
    catch (e) { this.store.log('warn', `sisa compound ${hash} menunggu pencatatan: ${e.message}`, { quiet: true }); }
  }

  async reconcile() {
    const rows = this.store.all(`SELECT t.* FROM txs t LEFT JOIN compound_runs c ON c.tx_hash=t.hash
      WHERE t.kind='compound' AND t.status!='gagal' AND c.tx_hash IS NULL ORDER BY t.ts LIMIT 20`);
    for (const row of rows) {
      const id = JSON.parse(row.detail || '{}').position;
      if (this.engine.exiting.has(id)) continue;
      const pos = this.store.get('SELECT * FROM positions WHERE id=?', id);
      if (!pos) continue;
      this.engine.exiting.add(id);
      try {
        const receipt = await this.engine.rpc.call('eth_getTransactionReceipt', [row.hash]);
        if (!receipt) {
          // Tx yang tidak pernah masuk (terbuang dari mempool) dulu tetap "pending" selamanya
          // — dan executeExit menolak menutup posisi selama compound-nya belum selesai:
          // posisi tidak bisa ditutup sama sekali. Setelah 30 menit dan chain tidak mengenal
          // hash-nya, ditandai gagal.
          if (Date.now() - row.ts > 30 * 60_000) {
            const known = await this.engine.rpc.call('eth_getTransactionByHash', [row.hash]).catch(() => 'tak terbaca');
            if (!known) {
              this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", row.hash);
              this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', 'transaksi compound tidak pernah masuk', id);
            }
          }
          continue;
        }
        const ok = BigInt(receipt.status) === 1n;
        this.store.run('UPDATE txs SET status=? WHERE hash=?', ok ? 'sukses' : 'gagal', row.hash);
        if (ok) await this.finish(pos, row.hash, receipt);
        else this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', 'transaksi compound revert', id);
      } finally { this.engine.exiting.delete(id); }
    }
  }

  async tick(now = Date.now(), exitIds = new Set()) {
    const e = this.engine;
    if (this.running || e.busy || e.activeEntries || e.exiting.size || e.dryRun() || e.paused() || !e.exec.address()) return;
    const rows = this.store.all(`SELECT p.* FROM positions p JOIN compound_settings c ON c.position_id=p.id
      WHERE p.status='open' AND p.venue='v4' AND c.enabled=1
      AND (c.last_check IS NULL OR c.last_check+c.interval_minutes*60000<=?) ORDER BY c.last_check,p.id`, now);
    if (!rows.length) return;
    this.running = true;
    try {
      for (const pos of rows) {
        if (e.dryRun() || e.paused()) break;
        if (exitIds.has(pos.id)) continue;
        if (!this.status(pos).enabled) continue;
        if (e.exiting.has(pos.id) || this.pending(pos.id) || e.pendingFeeClaim(pos.id)) continue;
        const fresh = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", pos.id);
        if (!fresh) continue;
        e.exiting.add(pos.id);
        this.store.run('UPDATE compound_settings SET last_check=? WHERE position_id=?', now, pos.id);
        try {
          const plan = await this.plan(fresh);
          if (plan.skip) {
            this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', plan.skip, pos.id);
            continue;
          }
          const [ownerData] = await e.rpc.ethCallMany([{ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('ownerOf', [pos.token_id]) }]);
          const owner = IF_POSM.decodeFunctionResult('ownerOf', ownerData)[0].toLowerCase();
          if (owner !== e.exec.address().toLowerCase()) throw new Error('NFT posisi bukan milik wallet bot');
          const tx = e.exec.buildV4Compound(plan, e.exec.deadline());
          // Check mode/settings again after RPC waits; OFF cancels unsent work.
          if (e.dryRun() || e.paused() || !this.status(pos).enabled) continue;
          const hash = await e.exec.send(tx, { kind: 'compound', detail: { position: pos.id, wallet: owner,
            pool: pos.pool_ref, liquidity: plan.liquidity, valueQuote: plan.valueQuote, valueUsd: plan.valueUsd },
            guard: () => !e.dryRun() && !e.paused() && this.status(pos).enabled });
          this.store.run('UPDATE compound_settings SET last_tx=?,last_note=? WHERE position_id=?', hash, 'compound menunggu konfirmasi', pos.id);
          const rc = await e.exec.waitReceipt(hash, 90_000);
          if (rc.timeout) continue;
          if (!rc.ok) throw new Error(`compound revert (${hash})`);
          await this.finish(pos, hash, rc.receipt);
          try { await e.positions.sync(e.ethUsd); } catch { /* next regular sync */ }
        } catch (err) {
          this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', err.message, pos.id);
          this.store.log('warn', `auto-compound #${pos.id}: ${err.message}`, { quiet: true });
        } finally { e.exiting.delete(pos.id); }
      }
    } finally { this.running = false; }
  }
}
module.exports = { Compound };
