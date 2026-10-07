'use strict';
// Realized vs unrealized for closed Solana positions — FIFO queue, allocation and
// bookkeeping exactly as src/proceeds.js (inherited). Only how the chain is read changes:
//   - tokens that reached the wallet in the withdrawal tx: that tx's pre/post token balances
//   - transfers out/in: signatures of the wallet's token accounts for that mint (SPL /
//     Token-2022 ATA + other accounts held now), each tx read once. Out with a quote asset
//     coming in within the same tx = a sale (proceeds from the tx balances, not the pool
//     price); without it = sent away (valued at the close price).
//   - "block" = slot; past pool prices are unavailable → fall back to the close price.
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { Proceeds } = require('../proceeds');
const { WSOL } = require('../networks');

const MAX_PAGES = 5;
const MAX_TX = 400;   // max txs read per token per scan

class SolanaProceeds extends Proceeds {
  async getTx(sig) {
    this.txCache ??= new Map();
    if (this.txCache.has(sig)) return this.txCache.get(sig);
    let tx = null;
    try {
      tx = await this.rpc.run((c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }), { needsHistory: true });
    } catch {
      // A refused read (429) is NOT an answer: count it so the scan is not taken as complete,
      // and do not cache it.
      this.rpcFailures = (this.rpcFailures || 0) + 1;
      return null;
    }
    if (this.txCache.size > 500) this.txCache.clear();
    this.txCache.set(sig, tx);
    return tx;
  }

  // The wallet's balance changes in one tx: Map mint -> delta (SOL = native + wSOL, the tx
  // fee added back when the wallet paid it).
  static deltas(tx, wallet) {
    const out = new Map();
    const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k.pubkey || k)));
    const i = keys.indexOf(wallet);
    if (i >= 0) {
      let d = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
      if (i === 0) d += BigInt(tx.meta.fee || 0);
      out.set(WSOL, d);
    }
    for (const [list, sign] of [[tx.meta.preTokenBalances || [], -1n], [tx.meta.postTokenBalances || [], 1n]]) {
      for (const b of list) {
        if (b.owner !== wallet) continue;
        out.set(b.mint, (out.get(b.mint) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
      }
    }
    return out;
  }

  async receivedIn(txs, wallet, token) {
    const out = new Map();
    for (const sig of txs) {
      const tx = await this.getTx(sig);
      if (!tx?.meta) { out.set(sig, null); continue; }
      const d = SolanaProceeds.deltas(tx, wallet).get(token) || 0n;
      out.set(sig, d > 0n ? d : 0n);
    }
    return out;
  }

  // No historical balance: the stock before the first lot is taken as zero (like EVM without an archive node).
  async preBalance() { return 0n; }

  async sqrtNow(r) {
    try { return (await this.chain.pool(r.venue, r.pool_ref))?.sqrtX96 || null; } catch { return null; }
  }
  async sqrtAt() { return null; }

  async tokenAccounts(wallet, token) {
    const owner = new PublicKey(wallet), mint = new PublicKey(token);
    const set = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) => getAssociatedTokenAddressSync(mint, owner, true, p).toBase58()));
    try {
      const r = await this.rpc.run((c) => c.getTokenAccountsByOwner(owner, { mint }), { indexed: true });
      for (const a of r.value) set.add(a.pubkey.toBase58());
    } catch { /* the ATA is enough */ }
    return [...set];
  }

  // Returns false when part of the window could not be read (RPC refused a signature page or a
  // transaction): the caller must not remember the window as covered, or a sale in the
  // unread part would be missed forever and the tokens counted as still held.
  async scanTransfers(wallet, token, lo, hi, { ethUsd, known, seenTx, lpTx }) {
    const failuresBefore = this.rpcFailures || 0;
    let complete = true;
    const sigs = new Map();
    for (const acc of await this.tokenAccounts(wallet, token)) {
      let before;
      for (let page = 0; page < MAX_PAGES; page++) {
        let list;
        try {
          list = await this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(acc), { limit: 1000, before }), { needsHistory: true });
        } catch { complete = false; break; }
        for (const s of list) if (!s.err && s.slot >= lo && s.slot <= hi) sigs.set(s.signature, s);
        if (list.length < 1000 || list[list.length - 1].slot < lo) break;
        before = list[list.length - 1].signature;
      }
    }
    const todo = [...sigs.values()].filter((s) => !seenTx.has(s.signature)).sort((a, b) => a.slot - b.slot).slice(0, MAX_TX);
    const quotes = this.chain.QUOTES;
    for (const s of todo) {
      const tx = await this.getTx(s.signature);
      if (!tx?.meta || tx.meta.err) continue;
      seenTx.add(s.signature);
      const d = SolanaProceeds.deltas(tx, wallet);
      const tokD = d.get(token) || 0n;
      const ts = (tx.blockTime || s.blockTime || 0) * 1000;
      if (tokD < 0n) {
        // A quote asset coming in within the same tx = sale proceeds (USD).
        let usd = 0, otherOutUsd = 0, otherToken = false;
        for (const [mint, v] of d) {
          if (mint === token) continue;
          const q = quotes[mint];
          if (!q) { if (v < 0n) otherToken = true; continue; }
          const val = (Number(v < 0n ? -v : v) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1);
          if (v > 0n) usd += val; else if (v < 0n) otherOutUsd += val;
        }
        // A swap that also moved other assets out of the wallet (the position's own SOL, another
        // token) pays one lump of quote for all of them, so the quote that came in is not this
        // token's proceeds. Such a sale is left without a price (NULL) and valued at the close price.
        const mixed = otherToken || otherOutUsd > Math.max(0.05, usd * 0.02);
        const sale = usd > 0 && !mixed ? usd : null;
        this.store.run('INSERT OR REPLACE INTO wsales(chain,wallet,token,tx_hash,block,ts,tok_out,quote_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)',
          this.network, wallet, token, s.signature, s.slot, ts, (-tokD).toString(), sale, sale != null ? 'sell' : 'send');
        known.push({ tx_hash: s.signature, block: s.slot, tok_out: (-tokD).toString(), quote_usd: sale });
      } else if (tokD > 0n && !lpTx.has(s.signature)) {
        this.store.run('INSERT OR REPLACE INTO wflows(chain,wallet,token,tx_hash,block,ts,tok_in) VALUES(?,?,?,?,?,?,?)',
          this.network, wallet, token, s.signature, s.slot, ts, tokD.toString());
      }
    }
    return complete && (this.rpcFailures || 0) === failuresBefore;
  }
}

module.exports = { SolanaProceeds };
