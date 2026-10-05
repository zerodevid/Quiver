'use strict';
const { ensureChain } = require('./networks');
// The wallet's real capital: how much was ever deposited (and withdrawn), so the
// dashboard can show NET PnL = current wallet value − capital.
//
// Per-position "Total PnL" (out − cost) deliberately does not include costs outside the position:
// fee + zap swap slippage on entry, gas of ~200 txs, back-and-forth ETH↔USDG swaps. The wallet
// owner counts from the other side: "capital 400, now 520, so profit 120".
// That is the figure tracked here.
//
//   capital(t) = wallet value when the bot started recording (baseline)
//              + external deposits after it − external withdrawals after it
//
// Deposits/withdrawals are read from ordinary public RPC — it used to go through alchemy_getAssetTransfers,
// which stopped as soon as Alchemy's monthly quota ran out (two days of deposits were not recorded,
// net PnL jumped by the deposit amount). Two paths:
//   - USDG/WETH: Transfer logs to/from the wallet (eth_getLogs, a long range is fine —
//     the official endpoint answers 1.4m blocks in 0.3 seconds). Transfers from the
//     bot's own transactions or transactions we sent (manual swaps) are not deposits; going out
//     to a contract (router, pool) is not a withdrawal.
//   - ETH: a plain ETH transfer has no log. What is used is the balance difference: balance at
//     the window end − balance at the start − balance change from bot transactions (the tx
//     block's balance minus the previous block's, from an archive node). The remainder that bot
//     transactions do not explain = a deposit (positive) or a withdrawal (negative). Needs an
//     `archive: true` endpoint; without it only USDG/WETH is tracked.
const { ethers } = require('ethers');
const { getLogsSafe } = require('./scout');

const MIN_USD = 0.05;   // below this is dust (gas refund, prank airdrop), not a deposit
const ETH_TX_BLOCKS = 25; // bot tx blocks per sync for the ETH balance difference (2 archive getBalance per block)
const ETH_EVENTS = 3;     // unexplained change points traced per sync (~20 archive getBalance per point)
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const hex = (n) => '0x' + BigInt(n).toString(16);
const topicOf = (addr) => '0x' + String(addr).toLowerCase().slice(2).padStart(64, '0');
const addrOf = (topic) => '0x' + String(topic).slice(-40).toLowerCase();

class Capital {
  constructor({ rpc, store, chain, cfg, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.lastSync = 0;
    this.backlog = false;
    const ADDR = chain.ADDR;
    this.ASSETS = {
      eth: { symbol: chain.nativeSymbol, decimals: 18, token: ADDR.native, kind: 'eth' },
      [ADDR.usdg]: { symbol: chain.QUOTES[ADDR.usdg]?.symbol, decimals: chain.QUOTES[ADDR.usdg]?.decimals ?? 6, token: ADDR.usdg, kind: 'usd' },
      [ADDR.weth]: { symbol: chain.QUOTES[ADDR.weth]?.symbol, decimals: 18, token: ADDR.weth, kind: 'eth' },
    };
    // Counterparties that are certainly not a person: money going here is not a withdrawal.
    // Other contracts (Kyber router, etc.) are detected via eth_getCode and remembered.
    // The zero address too: a manually unwrapped WETH is recorded as a Transfer to 0x0 —
    // the ETH stays in the wallet, not a withdrawal.
    this.KNOWN = new Set([ADDR.poolManager, ADDR.posmV4, ADDR.permit2, ADDR.weth, ADDR.npmV3, '0x' + '0'.repeat(40),
      ...chain.venues.map((v) => v.npmV3)].filter(Boolean).map((a) => String(a).toLowerCase()));
    // deposits: shares one table/DB between chains (same wallet) — the chain becomes part
    // of its key so a deposit/withdrawal on one chain does not interfere with the other chain's
    // capital baseline.
    store.db.exec(`CREATE TABLE IF NOT EXISTS deposits (
      chain        TEXT NOT NULL DEFAULT 'robinhood',
      tx_hash      TEXT NOT NULL,
      uid          TEXT NOT NULL,        -- hash:logIndex; setoran ETH dari selisih saldo: eth:<dari>-<sampai>
      ts           INTEGER NOT NULL, block INTEGER NOT NULL,
      kind         TEXT NOT NULL,        -- deposit | withdraw
      token        TEXT, symbol TEXT, amount TEXT,
      usd          REAL NOT NULL, eth_usd REAL,
      counterparty TEXT,
      PRIMARY KEY (chain, tx_hash, uid)
    )`);
    const cols = new Set(store.db.prepare('PRAGMA table_info(deposits)').all().map((c) => c.name));
    if (!cols.has('chain')) store.db.exec("ALTER TABLE deposits ADD COLUMN chain TEXT NOT NULL DEFAULT 'robinhood'");
  }

  available() { return true; }
  sk(k) { return `${k}:${this.chain.network}`; }

  // Several calls at once, results in order; one item erroring = the whole thing failed
  // (the window is rescanned later — nothing is recorded half-done).
  async many(calls, opts = {}) {
    if (!calls.length) return [];
    const res = await this.rpc.batch(calls, opts);
    return res.map((r, i) => {
      if (!r) throw new Error(`${calls[i].method}: tidak ada balasan`);
      if (r.error) throw new Error(`${calls[i].method}: ${r.error.message}`);
      return r.result;
    });
  }
  // Balance at a past block only to an archive endpoint. Without an archive in the pool: an ordinary endpoint
  // still answers for a recent block (the baseline is computed at the block when the bot starts).
  archiveOpt() { return { archive: !!this.rpc.hasArchive?.() }; }
  async balanceAt(wallet, block) {
    const r = await this.rpc.call('eth_getBalance', [wallet, hex(block)], this.archiveOpt());
    if (typeof r !== 'string' || !/^0x[0-9a-f]*$/i.test(r)) throw new Error(`eth_getBalance @${block}: balasan bukan angka`);
    return BigInt(r);
  }
  async blockTs(block) {
    const b = await this.rpc.call('eth_getBlockByNumber', [hex(block), false]);
    if (!b?.timestamp) throw new Error(`blok ${block} belum ada di endpoint`);
    return parseInt(b.timestamp, 16) * 1000;
  }

  // Does the address have code? (a contract → not a withdrawal destination). Stored: the answer stays the same.
  async isContract(addr) {
    const a = String(addr || '').toLowerCase();
    if (!a || a === '0x') return false;
    if (this.KNOWN.has(a)) return true;
    const k = `code:${this.chain.network}:${a}`;
    const c = this.store.getState(k);
    if (c != null) return c === '1';
    const code = await this.rpc.call('eth_getCode', [a, 'latest']);
    const yes = !!code && code !== '0x';
    this.store.setState(k, yes ? '1' : '0');
    return yes;
  }

  // The last block whose timestamp is ≤ ts (binary search, ~26 calls; only once).
  async blockAt(ts) {
    const sec = Math.floor(ts / 1000);
    const at = async (n) => parseInt((await this.rpc.call('eth_getBlockByNumber', ['0x' + n.toString(16), false]))?.timestamp || '0', 16);
    let lo = 0, hi = await this.rpc.blockNumber();
    if ((await at(hi)) <= sec) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((await at(mid)) <= sec) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Baseline: the wallet value when the bot started recording equity — cash at that block (archive)
  // + the capital of positions that already exist (adopted). Computed once, stored in state.
  async baseline(wallet) {
    const bKey = this.sk('capital_baseline');
    const saved = this.store.getState(bKey);
    if (saved) return JSON.parse(saved);
    const first = this.store.get('SELECT MIN(ts) ts FROM equity WHERE chain=?', this.chain.network)?.ts;
    const ts = first || Date.now();
    const block = await this.blockAt(ts);
    const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
    const data = IF.encodeFunctionData('balanceOf', [wallet]);
    const [usdgW, wethW, ethRaw] = await Promise.all([
      this.rpc.callAt(this.chain.ADDR.usdg, data, block), this.rpc.callAt(this.chain.ADDR.weth, data, block),
      this.balanceAt(wallet, block),
    ]);
    const usdg = Number(BigInt(usdgW && usdgW !== '0x' ? usdgW : 0)) / 10 ** (this.ASSETS[this.chain.ADDR.usdg]?.decimals ?? 6);
    const weth = Number(BigInt(wethW && wethW !== '0x' ? wethW : 0)) / 1e18;
    const eth = Number(ethRaw) / 1e18;
    const ethUsd = await this.chain.ethUsdAt(block);
    // positions already open before this point: their capital is part of the baseline
    const ethLike = new Set([this.chain.nativeSymbol, this.chain.QUOTES[this.chain.ADDR.weth]?.symbol].filter(Boolean));
    const pos = this.store.all("SELECT cost_quote, quote_symbol FROM positions WHERE chain=? AND status IN ('open','closed') AND opened_ts IS NOT NULL AND opened_ts <= ?", this.chain.network, ts);
    const positionsUsd = pos.reduce((a, p) => a + (p.cost_quote || 0) * (ethLike.has(p.quote_symbol) ? ethUsd : 1), 0);
    const cashUsd = usdg + (eth + weth) * ethUsd;
    const b = { ts, block, usd: cashUsd + positionsUsd, cashUsd, positionsUsd, ethUsd, usdg, eth, weth };
    this.store.setState(bKey, JSON.stringify(b));
    this.store.setState(this.sk('deposits_scanned_to'), String(block));
    // starting point of the ETH balance difference: the same balance as the baseline
    this.store.setState(this.sk('capital_eth_checkpoint'), JSON.stringify({ block, wei: ethRaw.toString(), ts }));
    this.log(`modal dasar (${this.chain.label}): $${b.usd.toFixed(2)} (kas $${cashUsd.toFixed(2)} + posisi $${positionsUsd.toFixed(2)}) pada blok ${block}`);
    return b;
  }

  // Scan for new deposits/withdrawals. Called periodically; cheap if nothing is new.
  // Two separate cursors (token logs; ETH balance difference) so a disturbance in the archive node
  // does not also hold up recording USDG deposits.
  async sync(wallet) {
    if (!wallet) return null;
    this.lastSync = Date.now();   // also on failure: do not hammer it every tick
    const me = String(wallet).toLowerCase();
    const base = await this.baseline(me);
    // A few blocks behind the tip: an endpoint that answers getLogs/getBalance can
    // lag behind the one that answers blockNumber (100 ms blocks) — no need to fail and retry.
    const head = (await this.rpc.blockNumber()) - 5;
    // The log cursor is read BEFORE being advanced: the starting point of the ETH balance difference (a database
    // from the Alchemy version does not have it yet) must be the last block already scanned, not the head.
    const scannedTo = Number(this.store.getState(this.sk('deposits_scanned_to'), base.block));
    await this.ethCheckpoint(me, scannedTo);
    // the bot's own transactions (swap, mint, close): their transfers are not deposits/withdrawals
    const ours = new Set(this.store.all('SELECT hash FROM txs WHERE chain=?', this.chain.network).map((r) => r.hash.toLowerCase()));
    let added = 0;
    added += await this.syncTokens(me, scannedTo, head, ours);
    added += await this.syncEth(me, head, ours);
    this.syncedAt = Date.now();
    return { added };
  }

  async syncTokens(me, scannedTo, head, ours) {
    const from = scannedTo + 1;
    if (head < from) return 0;
    const address = [this.chain.ADDR.usdg, this.chain.ADDR.weth].filter(Boolean);
    const [ins, outs] = await Promise.all([
      getLogsSafe(this.rpc, { address, topics: [TRANSFER, null, topicOf(me)] }, from, head),
      getLogsSafe(this.rpc, { address, topics: [TRANSFER, topicOf(me), null] }, from, head),
    ]);
    const logs = [...ins.map((l) => ({ dir: 'in', ...l })), ...outs.map((l) => ({ dir: 'out', ...l }))]
      .map((l) => ({ ...l, hash: String(l.transactionHash).toLowerCase() }))
      .filter((l) => !ours.has(l.hash) && this.ASSETS[String(l.address).toLowerCase()] && BigInt(l.data) > 0n);
    if (!logs.length) { this.store.setState(this.sk('deposits_scanned_to'), String(head)); return 0; }
    // sender of each tx + time of each block, once per hash/block
    const hashes = [...new Set(logs.map((l) => l.hash))];
    const blocks = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))];
    const [txs, hdrs] = await Promise.all([
      this.many(hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))),
      this.many(blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] }))),
    ]);
    const senderOf = new Map(hashes.map((h, i) => [h, String(txs[i]?.from || '').toLowerCase()]));
    const tsOf = new Map(blocks.map((b, i) => [b, parseInt(hdrs[i]?.timestamp || '0', 16) * 1000 || Date.now()]));
    let added = 0;
    for (const l of logs) {
      const asset = this.ASSETS[String(l.address).toLowerCase()];
      const cp = addrOf(l.dir === 'in' ? l.topics[1] : l.topics[2]);
      const from = senderOf.get(l.hash);
      if (l.dir === 'in') {
        // money coming in from a transaction we sent ourselves = swap/close proceeds, not a deposit
        if (from === me) continue;
      } else {
        // going out: only if we are the sender, to an address that is not a contract
        if (from !== me) continue;
        if (await this.isContract(cp)) continue;
      }
      const block = parseInt(l.blockNumber, 16);
      added += await this.record({ dir: l.dir, asset, raw: BigInt(l.data), block, ts: tsOf.get(block), hash: l.hash, uid: `${l.hash}:${parseInt(l.logIndex, 16)}`, cp });
    }
    this.store.setState(this.sk('deposits_scanned_to'), String(head));
    return added;
  }

  // Starting point of the balance difference. A database from the Alchemy version does not have it: start from
  // the last block already scanned — created BEFORE the log cursor advances, so an
  // ETH deposit between the two is not lost.
  async ethCheckpoint(me, scannedTo) {
    const ckKey = this.sk('capital_eth_checkpoint');
    const saved = JSON.parse(this.store.getState(ckKey) || 'null');
    if (saved) return saved;
    const ck = { block: scannedTo, wei: (await this.balanceAt(me, scannedTo)).toString(), ts: await this.blockTs(scannedTo) };
    this.store.setState(ckKey, JSON.stringify(ck));
    return ck;
  }

  // Plain ETH: the balance difference not explained by bot transactions. If there is a remainder,
  // its block is searched (bisect on "balance − bot tx effect", ~20 archive calls) then the
  // wallet's transactions in that block are read: sent from outside = deposit; sent by us to
  // a person (not a contract) = withdrawal; sent by us to a contract (manual swap via
  // the router, unwrap WETH) = conversion/cost, not a withdrawal — the value stays in the wallet
  // or is really lost as a cost, both are PnL matters. Without a wallet transaction in
  // that block (a contract sends ETH to us — a bridge): the sign of the remainder decides.
  // A deposit that lands in the same block as a bot transaction is counted as
  // an effect of that transaction (rare: 100 ms blocks).
  async syncEth(me, head, ours) {
    const ckKey = this.sk('capital_eth_checkpoint');
    const ck = JSON.parse(this.store.getState(ckKey));
    if (head <= ck.block) return 0;
    // Bot transactions that may have landed in this window (sent since the starting point,
    // with slack: a held-back tx can land in a block long after it was sent).
    const sent = this.store.all('SELECT hash FROM txs WHERE chain=? AND ts >= ?', this.chain.network, ck.ts - 30 * 60_000).map((r) => r.hash);
    const rcs = await this.many(sent.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    let blocks = [...new Set(rcs.map((r) => (r?.blockNumber ? parseInt(r.blockNumber, 16) : 0)).filter((b) => b > ck.block && b <= head))].sort((a, b) => a - b);
    // Public archive nodes limit calls per minute (blockmachine: 300 CU). A window
    // that piles up (two days without a scan = hundreds of bot txs) is paid in instalments: at most
    // ETH_TX_BLOCKS tx blocks per sync, its end point the last tx block counted —
    // its balance is already in hand, no extra call needed.
    let end = head, partial = false;
    if (blocks.length > ETH_TX_BLOCKS) { blocks = blocks.slice(0, ETH_TX_BLOCKS); end = blocks[blocks.length - 1]; partial = true; }
    const bals = await this.many([
      ...blocks.flatMap((b) => [{ method: 'eth_getBalance', params: [me, hex(b - 1)] }, { method: 'eth_getBalance', params: [me, hex(b)] }]),
      ...(partial ? [] : [{ method: 'eth_getBalance', params: [me, hex(end)] }]),
    ], this.archiveOpt());
    for (const [i, v] of bals.entries()) if (typeof v !== 'string' || !/^0x[0-9a-f]*$/i.test(v)) throw new Error(`eth_getBalance (${i}): balasan bukan angka`);
    const deltaAt = new Map(blocks.map((b, i) => [b, BigInt(bals[2 * i + 1]) - BigInt(bals[2 * i])]));
    const cache = new Map([[ck.block, BigInt(ck.wei)], [end, BigInt(bals[bals.length - 1])], ...blocks.flatMap((b, i) => [[b - 1, BigInt(bals[2 * i])], [b, BigInt(bals[2 * i + 1])]])]);
    const balAt = async (n) => { if (!cache.has(n)) cache.set(n, await this.balanceAt(me, n)); return cache.get(n); };
    // f(n) = balance at n − bot tx effect up to n: flat, unless there is an outside transfer.
    const f = async (n) => { let s = await balAt(n); for (const [b, d] of deltaAt) if (b <= n) s -= d; return s; };
    const fEnd = await f(end);
    let lo = ck.block, added = 0;
    for (let i = 0; i < ETH_EVENTS; i++) {
      const flo = await f(lo);
      if (flo === fEnd) break;
      let hi = end;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await f(mid)) === flo) lo = mid; else hi = mid; }
      const residual = (await f(hi)) - flo;
      // Re-read the two balances instead of trusting the bisect's cache: one inconsistent answer
      // from an archive node made a $314 "deposit" at a block where the balance did not move.
      // A real outside transfer shows as a jump at that block beyond the bot tx effect.
      const jump = (await this.balanceAt(me, hi)) - (await this.balanceAt(me, hi - 1)) - (deltaAt.get(hi) || 0n);
      if (jump === residual) {
        // Independent of any archive read: a real deposit/withdrawal moves the wallet value the
        // equity snapshots take from the live balance. Two false $300 deposits (blocks where the
        // balance was flat) passed the re-read above, so the equity curve has the last word.
        const seen = await this.equityConfirms(hi, residual);
        if (seen === null) break;   // no snapshot after the block yet: look again next sync
        if (seen) added += await this.ethEvent(me, hi, residual, ours);
        else this.log(`selisih saldo ETH di blok ${hi} tidak terlihat di ekuitas, dilewati`);
      } else this.log(`selisih saldo ETH di blok ${hi} tidak terbukti (lompatan ${jump} wei vs sisa ${residual} wei), dilewati`);
      lo = hi;
    }
    // There is still a remainder after ETH_EVENTS points: stop at the last point already
    // read; the rest is for the next sync's turn.
    if ((await f(lo)) !== fEnd) { end = lo; partial = true; }
    const tsEnd = await this.blockTs(end);
    this.store.setState(ckKey, JSON.stringify({ block: end, wei: (await balAt(end)).toString(), ts: tsEnd }));
    this.backlog = partial;   // the engine calls sync more closely while the instalments are not finished
    if (partial) this.log(`selisih saldo ETH: sampai blok ${end}, sisanya (${head - end} blok) di sync berikutnya`);
    return added;
  }

  // Does the equity curve step by about the event's size across the block? true/false, or null when
  // there is no snapshot after the block yet (cannot judge). Without any snapshot before it
  // (very first rows) the event is let through.
  async equityConfirms(block, residual) {
    const ts = await this.blockTs(block);
    const net = this.chain.network;
    const before = this.store.get('SELECT total_quote q FROM equity WHERE chain=? AND ts <= ? ORDER BY ts DESC LIMIT 1', net, ts);
    if (!before) return true;
    const after = this.store.get('SELECT total_quote q FROM equity WHERE chain=? AND ts > ? ORDER BY ts LIMIT 1', net, ts);
    if (!after) return null;
    const usd = (Number(residual) / 1e18) * await this.chain.ethUsdAt(block);
    return (after.q - before.q) * Math.sign(usd) >= Math.abs(usd) * 0.5;
  }

  // A block with an ETH balance change that is not from a bot transaction.
  async ethEvent(me, block, residual, ours) {
    const blk = await this.rpc.call('eth_getBlockByNumber', [hex(block), true]);
    if (!blk?.timestamp) throw new Error(`blok ${block} belum ada di endpoint`);
    const ts = parseInt(blk.timestamp, 16) * 1000;
    const mine = (blk.transactions || []).filter((t) => t && typeof t === 'object' && !ours.has(String(t.hash).toLowerCase())
      && [t.from, t.to].some((a) => String(a || '').toLowerCase() === me));
    if (!mine.length) {
      return this.record({ dir: residual > 0n ? 'in' : 'out', asset: this.ASSETS.eth, raw: residual < 0n ? -residual : residual, block, ts,
        hash: `eth:${block}`, uid: 'balance', cp: null });
    }
    let added = 0;
    for (const t of mine) {
      const from = String(t.from || '').toLowerCase(), to = String(t.to || '').toLowerCase();
      const value = BigInt(t.value || 0);
      if (value === 0n) continue;
      if (to === me && from !== me) added += await this.record({ dir: 'in', asset: this.ASSETS.eth, raw: value, block, ts, hash: String(t.hash).toLowerCase(), uid: 'eth', cp: from });
      else if (from === me && !(await this.isContract(to))) added += await this.record({ dir: 'out', asset: this.ASSETS.eth, raw: value, block, ts, hash: String(t.hash).toLowerCase(), uid: 'eth', cp: to });
    }
    return added;
  }

  async record({ dir, asset, raw, block, ts, hash, uid, cp }) {
    const amount = Number(raw) / 10 ** asset.decimals;
    const ethUsd = asset.kind === 'usd' ? null : await this.chain.ethUsdAt(block);
    const usd = asset.kind === 'usd' ? amount : amount * ethUsd;
    if (usd < MIN_USD) return 0;
    const r = this.store.run(`INSERT OR IGNORE INTO deposits(chain,tx_hash,uid,ts,block,kind,token,symbol,amount,usd,eth_usd,counterparty)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, this.chain.network, hash, uid, ts, block, dir === 'in' ? 'deposit' : 'withdraw',
    asset.token, asset.symbol, raw.toString(), usd, ethUsd, cp);
    if (!Number(r.changes)) return 0;
    this.log(`${dir === 'in' ? 'setoran' : 'penarikan'} terdeteksi: ${amount} ${asset.symbol} ($${usd.toFixed(2)}) ${cp ? `${dir === 'in' ? 'dari' : 'ke'} ${cp.slice(0, 10)}… tx ${hash.slice(0, 10)}…` : `(selisih saldo blok ${hash.slice(4)})`}`);
    return 1;
  }

  rows() { return this.store.all('SELECT * FROM deposits WHERE chain=? ORDER BY ts', this.chain.network); }

  // Capital at time `ts` (default: now). null if the baseline does not exist yet.
  capitalAt(ts = Date.now()) {
    const saved = this.store.getState(this.sk('capital_baseline'));
    if (!saved) return null;
    const b = JSON.parse(saved);
    const d = this.store.get(`SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN usd ELSE -usd END),0) s FROM deposits WHERE chain=? AND ts <= ?`, this.chain.network, ts)?.s || 0;
    return b.usd + d;
  }

  summary() {
    const saved = this.store.getState(this.sk('capital_baseline'));
    if (!saved) return null;
    const b = JSON.parse(saved);
    const agg = this.store.get(`SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN usd ELSE 0 END),0) dep,
      COALESCE(SUM(CASE WHEN kind='withdraw' THEN usd ELSE 0 END),0) wd, COUNT(*) n FROM deposits WHERE chain=?`, this.chain.network);
    return {
      baselineUsd: b.usd, baselineTs: b.ts, depositsUsd: agg.dep, withdrawalsUsd: agg.wd, count: agg.n,
      capitalUsd: b.usd + agg.dep - agg.wd, syncedAt: this.syncedAt || null,
    };
  }
}

module.exports = { Capital };
