'use strict';
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { ensureChain } = require('./networks');
const { unclaimedV4, unclaimedV3 } = require('./fees');
const { quoteToUsd } = require('./policy');
const m = require('./v3math');
const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);

// Panen fee otomatis, dua rasa:
//   compound — fee dikembalikan jadi likuiditas di posisi yang sama. v4 memakai satu
//              batch INCREASE+TAKE_PAIR; v3 memakai multicall collect+increaseLiquidity.
//              Tidak ada swap, jadi tidak ada dampak harga dan tidak ada uang keluar.
//   claim    — fee ditarik ke wallet. Sisi aset kuotasi langsung jadi uang; sisi
//              memecoin-nya dijual ke aset kuotasi pool itu juga (kalau sellFee menyala),
//              lewat antrean jual yang sama dengan sisa penutupan posisi.
// Keduanya memakai satu baris pengaturan per posisi: minimum nilai fee dan seberapa
// sering diperiksa.
const MODES = new Set(['compound', 'claim']);

class Compound {
  constructor(engine) {
    this.engine = engine;
    this.store = engine.store;
    this.chain = ensureChain(engine.chain);
    this.network = this.chain.network;
    this.running = false;
  }

  // v3 dan v4 sama-sama bisa dipanen; venue lain (pool langsung tanpa NFT) tidak.
  supported(pos) { return pos.venue === 'v4' || this.chain.isV3Venue(pos.venue); }

  status(pos) {
    const s = this.store.get('SELECT * FROM compound_settings WHERE position_id=?', pos.id);
    const q = this.store.get('SELECT COALESCE(SUM(reinvested_quote),0) total FROM compound_runs WHERE position_id=?', pos.id)?.total || 0;
    return { supported: this.supported(pos), enabled: !!s?.enabled,
      mode: s?.mode === 'claim' ? 'claim' : 'compound',
      // Baris lama tidak punya kolomnya: menjual sisi memecoin adalah perilaku baku
      // mode klaim — menimbun memecoin bukan tujuan copy-LP.
      sellFee: s?.sell_fee == null ? true : !!s.sell_fee,
      minUsd: s?.min_usd ?? 5,
      intervalMinutes: s?.interval_minutes ?? 30, lastCheck: s?.last_check || null,
      lastTx: s?.last_tx || null, lastNote: s?.last_note || null,
      compoundedUsd: q * (this.chain.isEthLike(pos.quote_symbol) ? this.engine.ethUsd : 1) };
  }

  configure(id, input) {
    const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", id);
    if (!pos) throw new Error('posisi tidak ditemukan');
    if (!this.supported(pos)) throw new Error('panen fee otomatis tersedia untuk posisi Uniswap v3 dan v4');
    const old = this.status(pos);
    const enabled = input.enabled ?? old.enabled;
    const mode = input.mode ?? old.mode;
    const sellFee = input.sellFee ?? old.sellFee;
    const minUsd = Number(input.minUsd ?? old.minUsd), intervalMinutes = Number(input.intervalMinutes ?? old.intervalMinutes);
    if (typeof enabled !== 'boolean') throw new Error('enabled harus boolean');
    if (typeof sellFee !== 'boolean') throw new Error('sellFee harus boolean');
    if (!MODES.has(mode)) throw new Error('mode panen fee tidak dikenal');
    if (!Number.isFinite(minUsd) || minUsd < 0.01 || minUsd > 1_000_000) throw new Error('minimum panen harus $0,01 sampai $1.000.000');
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) throw new Error('interval panen harus 1 sampai 10.080 menit');
    this.store.run(`INSERT INTO compound_settings(position_id,enabled,min_usd,interval_minutes,mode,sell_fee) VALUES(?,?,?,?,?,?)
      ON CONFLICT(position_id) DO UPDATE SET enabled=excluded.enabled,min_usd=excluded.min_usd,
      interval_minutes=excluded.interval_minutes,mode=excluded.mode,sell_fee=excluded.sell_fee`,
    id, enabled ? 1 : 0, minUsd, intervalMinutes, mode, sellFee ? 1 : 0);
    return this.status(pos);
  }

  pending(id) {
    return this.store.get(`SELECT t.* FROM txs t LEFT JOIN compound_runs c ON c.tx_hash=t.hash
      WHERE t.kind='compound' AND t.status!='gagal' AND c.tx_hash IS NULL
      AND json_extract(t.detail,'$.position')=? ORDER BY t.ts LIMIT 1`, id);
  }

  async ownerOf(pos) {
    const v3 = this.chain.isV3Venue(pos.venue);
    const iface = v3 ? IF_NPM : IF_POSM;
    const [data] = await this.engine.rpc.ethCallMany([{ to: v3 ? this.chain.npmFor(pos.venue) : this.chain.ADDR.posmV4,
      data: iface.encodeFunctionData('ownerOf', [pos.token_id]) }]);
    return iface.decodeFunctionResult('ownerOf', data)[0].toLowerCase();
  }

  // Fee yang belum diklaim, dalam aset kuotasi posisi -> dolar. Dibaca dari hasil
  // sinkron terakhir (tiap 30 detik), bukan RPC baru: ini cuma gerbang minimum.
  feeUsd(pos) {
    return (pos.fees_quote || 0) * (this.chain.isEthLike(pos.quote_symbol) ? this.engine.ethUsd : 1);
  }

  note(id, text) {
    this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', String(text).slice(0, 300), id);
  }

  // Berapa likuiditas yang bisa ditambahkan dari fee yang ada, dan berapa nilainya.
  // Sama untuk v3 dan v4; yang berbeda hanya dari mana fee & harga pool dibaca dan
  // bentuk transaksinya.
  async plan(pos) {
    const e = this.engine;
    const v3 = this.chain.isV3Venue(pos.venue);
    const slot = v3 ? await e.chain.slot0V3(pos.pool_ref) : await e.chain.slot0V4(pos.pool_ref);
    if (!slot) throw new Error('harga pool belum terbaca');
    const fees = v3
      ? (await unclaimedV3(this.chain, [pos.token_id], e.exec.address(), this.chain.npmFor(pos.venue), e.rpc))[0]
      : (await unclaimedV4(this.chain, [{ poolId: pos.pool_ref, tickLower: pos.tick_lower,
        tickUpper: pos.tick_upper, tokenId: pos.token_id }], new Map([[pos.pool_ref, slot.tick]]), e.rpc))[0];
    if (!fees) throw new Error('fee posisi belum terbaca');
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
    // Likuiditas posisi: v4 membacanya bersama fee, v3 memakai catatan sinkron terakhir.
    const current = value(v3 ? BigInt(pos.liquidity || '0') : fees.liquidity);
    const cap = Math.min(rules.sizing.max_quote_per_position_usd - current.valueUsd,
      rules.sizing.max_total_exposure_usd - e.positions.summary(e.ethUsd).exposureUsd);
    if (!(cap > 0)) return { skip: 'batas nilai posisi atau eksposur sudah tercapai' };
    if (est.valueUsd > cap) {
      L = L * BigInt(Math.floor(cap * 1e6)) / BigInt(Math.ceil(est.valueUsd * 1e6));
      est = value(L);
    }
    if (L <= 0n || est.valueUsd < this.status(pos).minUsd) return { skip: 'fee yang bisa ditambahkan belum mencapai minimum compound' };
    if (v3) {
      // v3 menarik fee lewat transferFrom sesudah collect: yang diminta adalah jumlah
      // yang muat di rasio LP (sudah dipotong slippage lewat usable), dan mins menjaga
      // kalau harga bergerak antara dibangun dan masuk blok. Sisanya tetap di wallet.
      const minOf = (n) => (n * BigInt(10000 - slip) / 10000n).toString();
      return { tokenId: pos.token_id, venue: pos.venue, liquidity: L.toString(),
        amount0Max: est.amount0.toString(), amount1Max: est.amount1.toString(),
        amount0Min: minOf(est.amount0), amount1Min: minOf(est.amount1),
        valueQuote: est.valueQuote, valueUsd: est.valueUsd };
    }
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
        if (BigInt(receipt.status) === 1n) await this.finish(pos, row.hash, receipt);
        else this.store.run('UPDATE compound_settings SET last_note=? WHERE position_id=?', 'transaksi compound revert', id);
      } finally { this.engine.exiting.delete(id); }
    }
  }

  // Satu posisi, mode compound: fee jadi likuiditas lagi.
  async runCompound(pos, st) {
    const e = this.engine;
    const v3 = this.chain.isV3Venue(pos.venue);
    e.exiting.add(pos.id);
    try {
      const plan = await this.plan(pos);
      if (plan.skip) { this.note(pos.id, plan.skip); return; }
      if (await this.ownerOf(pos) !== e.exec.address().toLowerCase()) throw new Error('NFT posisi bukan milik wallet bot');
      const owner = e.exec.address().toLowerCase();
      if (v3) {
        // increaseLiquidity menarik fee yang baru di-collect dari wallet lewat
        // transferFrom: tanpa izin ERC20 ke NPM, multicall-nya revert.
        for (const tok of [pos.token0, pos.token1]) {
          if (BigInt(tok === pos.token0 ? plan.amount0Max : plan.amount1Max) === 0n) continue;
          for (const a of await e.exec.ensureAllowance(tok, { forV4: false, venue: pos.venue })) {
            const h = await e.exec.send(a, { kind: a.kind });
            await e.exec.waitReceipt(h);
          }
        }
      }
      const tx = v3 ? e.exec.buildV3Compound(plan, e.exec.deadline()) : e.exec.buildV4Compound(plan, e.exec.deadline());
      // Check mode/settings again after RPC waits; OFF cancels unsent work.
      if (e.dryRun() || e.paused() || !this.status(pos).enabled) return;
      const hash = await e.exec.send(tx, { kind: 'compound', detail: { position: pos.id, wallet: owner,
        pool: pos.pool_ref, liquidity: plan.liquidity, valueQuote: plan.valueQuote, valueUsd: plan.valueUsd },
      guard: () => !e.dryRun() && !e.paused() && this.status(pos).enabled });
      this.store.run('UPDATE compound_settings SET last_tx=?,last_note=? WHERE position_id=?', hash, 'compound menunggu konfirmasi', pos.id);
      const rc = await e.exec.waitReceipt(hash, 90_000);
      if (rc.timeout) return;
      if (!rc.ok) throw new Error(`compound revert (${hash})`);
      await this.finish(pos, hash, rc.receipt);
      try { await e.positions.sync(e.ethUsd); } catch { /* next regular sync */ }
    } catch (err) {
      this.note(pos.id, err.message);
      this.store.log('warn', `auto-compound #${pos.id}: ${err.message}`, { quiet: true });
    } finally { e.exiting.delete(pos.id); }
  }

  // Satu posisi, mode claim: fee ditarik ke wallet (dan sisi memecoin-nya dijual).
  // Kunci posisi TIDAK dipegang di sini — claimFees memasang kuncinya sendiri.
  async runClaim(pos, st) {
    const e = this.engine;
    const feeUsd = this.feeUsd(pos);
    if (!(feeUsd >= st.minUsd)) {
      this.note(pos.id, `fee $${feeUsd.toFixed(2)} belum mencapai minimum klaim $${st.minUsd}`);
      return;
    }
    try {
      const r = await e.claimFees(pos.id, { sell: st.sellFee });
      if (r?.pending) { this.note(pos.id, 'klaim fee menunggu konfirmasi'); return; }
      this.store.run('UPDATE compound_settings SET last_tx=?,last_note=? WHERE position_id=?',
        r?.tx || null, 'klaim fee berhasil', pos.id);
      const usd = r?.claimedUsd ?? feeUsd;
      e.notify(`panen fee posisi #${pos.id}: $${usd.toFixed(2)}${r?.sold ? ` · ${r.sold}` : ''}`,
        { kind: 'fee_claim', positionId: pos.id, txHash: r?.tx || null, usd, sold: r?.sold || null, auto: true });
    } catch (err) {
      this.note(pos.id, err.message);
      this.store.log('warn', `auto-klaim fee #${pos.id}: ${err.message}`, { quiet: true });
    }
  }

  async tick(now = Date.now(), exitIds = new Set()) {
    const e = this.engine;
    if (this.running || e.busy || e.activeEntries || e.exiting.size || e.dryRun() || e.paused() || !e.exec.address()) return;
    // Satu DB bisa memuat posisi beberapa chain; tiap mesin hanya memanen chain-nya.
    const rows = this.store.all(`SELECT p.* FROM positions p JOIN compound_settings c ON c.position_id=p.id
      WHERE p.chain=? AND p.status='open' AND c.enabled=1
      AND (c.last_check IS NULL OR c.last_check+c.interval_minutes*60000<=?) ORDER BY c.last_check,p.id`, this.network, now);
    if (!rows.length) return;
    this.running = true;
    try {
      for (const pos of rows) {
        if (e.dryRun() || e.paused()) break;
        if (exitIds.has(pos.id)) continue;
        const st = this.status(pos);
        if (!st.enabled || !st.supported) continue;
        if (e.exiting.has(pos.id) || this.pending(pos.id) || e.pendingFeeClaim(pos.id)) continue;
        const fresh = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", pos.id);
        if (!fresh) continue;
        this.store.run('UPDATE compound_settings SET last_check=? WHERE position_id=?', now, pos.id);
        if (st.mode === 'claim') await this.runClaim(fresh, st);
        else await this.runCompound(fresh, st);
      }
    } finally { this.running = false; }
  }
}
module.exports = { Compound };
