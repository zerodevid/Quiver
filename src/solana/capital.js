'use strict';
// Wallet capital on Solana (deposits & withdrawals) — the deposits table, summary, and net PnL
// formula as in src/capital.js (inherited). Only how it is read differs:
//
//   baseline : the wallet's value WHEN the tracker first runs (SOL/wSOL/USDC/USDT cash +
//              open position value). Solana has no public archive node for past balances,
//              so it is not computed back to the first equity point.
//   deposits : new signatures on the wallet AND its USDC/USDT/wSOL token accounts (ATAs) —
//              an SPL transfer to an ATA does not mention the wallet address at all. Each tx
//              is read (pre/post balances): an increase in the wallet's SOL / quote = deposit,
//              a decrease = withdrawal.
//   not      : the bot's own txs (txs table) and txs the wallet signed while calling other
//              programs (LP venues, Jupiter, …) — that is trading, not moving capital. Rent of
//              accounts created/closed in those txs too.
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { Capital } = require('../capital');
const { WSOL } = require('../networks');

// Programs allowed in a plain transfer tx.
const PLAIN = new Set([
  '11111111111111111111111111111111',               // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',    // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',    // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',   // Associated Token
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVTDHnXVyHAQpi',
]);
const PAGE = 1000;
const MAX_TX_PER_SYNC = 60;

class SolanaCapital extends Capital {
  constructor({ engine, ...rest }) {
    super(rest);
    this.engine = engine;
    const q = this.chain.QUOTES;
    this.ASSETS = {
      SOL: { symbol: 'SOL', decimals: 9, token: WSOL, kind: 'eth' },
      [this.chain.ADDR.usdg]: { symbol: q[this.chain.ADDR.usdg]?.symbol || 'USDC', decimals: 6, token: this.chain.ADDR.usdg, kind: 'usd' },
      [this.chain.ADDR.usdt]: { symbol: q[this.chain.ADDR.usdt]?.symbol || 'USDT', decimals: 6, token: this.chain.ADDR.usdt, kind: 'usd' },
    };
  }

  available() { return true; }

  // Watched addresses: the wallet + its quote ATAs (including wSOL).
  watched(wallet) {
    const owner = new PublicKey(wallet);
    const atas = [this.chain.ADDR.usdg, this.chain.ADDR.usdt, WSOL]
      .map((mint) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, TOKEN_PROGRAM_ID).toBase58());
    return [wallet, ...atas];
  }

  async baseline(wallet) {
    const bKey = this.sk('capital_baseline');
    const saved = this.store.getState(bKey);
    if (saved) return JSON.parse(saved);
    const e = this.engine;
    const b = await e.exec.balances();
    const sol = Number((b.get('SOL') || 0n) + (b.get(WSOL) || 0n)) / 1e9;
    const usd = Number((b.get(this.chain.ADDR.usdg) || 0n) + (b.get(this.chain.ADDR.usdt) || 0n)) / 1e6;
    const ethUsd = e.ethUsd;
    const positionsUsd = e.positions.summary(ethUsd).exposureUsd || 0;
    const cashUsd = usd + sol * ethUsd;
    const slot = await this.rpc.slot();
    // Each address's cursor = its newest signature now: anything older is already in the baseline.
    for (const a of this.watched(wallet)) {
      const top = await this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(a), { limit: 1 }), { needsHistory: true }).catch(() => []);
      this.store.setState(this.sk(`sol_cap_cursor:${a}`), top[0]?.signature || '');
    }
    const base = { ts: Date.now(), block: slot, usd: cashUsd + positionsUsd, cashUsd, positionsUsd, ethUsd, usdg: usd, eth: sol, weth: 0 };
    this.store.setState(bKey, JSON.stringify(base));
    this.log(`modal dasar (${this.chain.label}): $${base.usd.toFixed(2)} (kas $${cashUsd.toFixed(2)} + posisi $${positionsUsd.toFixed(2)})`);
    return base;
  }

  // New signatures of an address since its cursor (oldest first). An empty cursor = never
  // had a tx: everything is new.
  async newSigs(addr) {
    const cursor = this.store.getState(this.sk(`sol_cap_cursor:${addr}`), '');
    const pages = async (until) => {
      const out = [];
      let before;
      for (let i = 0; i < 5; i++) {
        const page = await this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(addr), { limit: PAGE, before, until }), { needsHistory: true });
        out.push(...page);
        if (page.length < PAGE) break;
        before = page[page.length - 1].signature;
      }
      return out;
    };
    let out;
    try { out = await pages(cursor || undefined); }
    catch (e) {
      // An endpoint that does not keep the cursor tx answers "Transaction … not found":
      // fetch without `until` and cut at the cursor (same as the watcher).
      if (!cursor || !/not found/i.test(String(e.message))) throw e;
      const all = await pages(undefined);
      const i = all.findIndex((x) => x.signature === cursor);
      out = i >= 0 ? all.slice(0, i) : all;
    }
    return out.reverse();
  }

  async sync(wallet) {
    if (!wallet) return null;
    this.lastSync = Date.now();
    await this.baseline(wallet);
    const ours = new Set(this.store.all('SELECT hash FROM txs WHERE chain=?', this.chain.network).map((r) => r.hash));
    // New signatures of all addresses merged, ordered by slot; each tx is read once.
    const perAddr = [];
    for (const a of this.watched(wallet)) perAddr.push([a, await this.newSigs(a)]);
    const all = new Map();
    for (const [, sigs] of perAddr) for (const s of sigs) if (!s.err && !all.has(s.signature)) all.set(s.signature, s);
    const todo = [...all.values()].sort((a, b) => a.slot - b.slot);
    this.backlog = todo.length > MAX_TX_PER_SYNC;
    const batch = todo.slice(0, MAX_TX_PER_SYNC);
    let added = 0;
    for (const s of batch) {
      if (!ours.has(s.signature)) added += await this.readTx(wallet, s);
    }
    // The cursor only advances to the last tx actually read (the rest next sync).
    const doneSlot = batch.length ? batch[batch.length - 1].slot : Infinity;
    for (const [a, sigs] of perAddr) {
      const last = [...sigs].reverse().find((x) => x.slot <= doneSlot);
      if (last) this.store.setState(this.sk(`sol_cap_cursor:${a}`), last.signature);
    }
    this.syncedAt = Date.now();
    return { added };
  }

  // The wallet's SOL & quote changes in one tx → deposit / withdrawal.
  async readTx(wallet, s) {
    const tx = await this.rpc.run((c) => c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }), { needsHistory: true });
    if (!tx?.meta || tx.meta.err) return 0;
    const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k.pubkey || k)));
    const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => (k.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k.pubkey))));
    const programs = new Set([
      ...tx.transaction.message.instructions.map((ix) => ix.programId?.toBase58?.() || String(ix.programId)),
      ...(tx.meta.innerInstructions || []).flatMap((x) => x.instructions.map((ix) => ix.programId?.toBase58?.() || String(ix.programId))),
    ]);
    const plain = [...programs].every((p) => PLAIN.has(p));
    // Signed by the bot wallet + calling another program = trading (swap/LP outside txs).
    if (signers.has(wallet) && !plain) return 0;
    const ts = (tx.blockTime || s.blockTime || Math.floor(Date.now() / 1000)) * 1000;
    let added = 0;
    // SOL = the wallet's native + wSOL (wrapping/unwrapping is not moving capital). The tx
    // fee is added back first when the wallet paid it.
    const tokDelta = new Map();
    const i = keys.indexOf(wallet);
    if (i >= 0) {
      let d = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
      if (i === 0) d += BigInt(tx.meta.fee || 0);
      tokDelta.set('SOL', d);
    }
    for (const [list, sign] of [[tx.meta.preTokenBalances || [], -1n], [tx.meta.postTokenBalances || [], 1n]]) {
      for (const b of list) {
        if (b.owner !== wallet) continue;
        const mint = b.mint === WSOL ? 'SOL' : b.mint;
        if (!this.ASSETS[mint]) continue;
        tokDelta.set(mint, (tokDelta.get(mint) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
      }
    }
    for (const [mint, d] of tokDelta) {
      if (d === 0n) continue;
      added += await this.record({ dir: d > 0n ? 'in' : 'out', asset: this.ASSETS[mint], raw: d > 0n ? d : -d, block: s.slot, ts, hash: s.signature, uid: mint, cp: this.counterparty(tx, wallet, keys) });
    }
    return added;
  }

  counterparty(tx, wallet, keys) {
    const payer = keys[0];
    return payer && payer !== wallet ? payer : keys.find((k) => k !== wallet && !PLAIN.has(k)) || null;
  }
}

module.exports = { SolanaCapital };
