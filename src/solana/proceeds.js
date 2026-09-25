'use strict';
// Terealisasi vs belum untuk posisi Solana yang sudah ditutup — antrean FIFO, alokasi,
// dan pembukuan persis src/proceeds.js (diwarisi). Yang diganti hanya cara membaca
// chain:
//   - token yang sampai ke wallet di tx tarik: pre/post token balance tx itu
//   - transfer keluar/masuk: tanda tangan akun token wallet untuk mint itu (ATA SPL /
//     Token-2022 + akun lain yang sekarang dipegang), tiap tx dibaca sekali. Keluar
//     dengan aset kuotasi masuk di tx yang sama = penjualan (hasilnya dari saldo tx,
//     bukan harga pool); tanpa itu = dikirim ke luar (dinilai harga tutup).
//   - "blok" = slot; harga pool lampau tidak tersedia → cadangan harga tutup.
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { Proceeds } = require('../proceeds');
const { WSOL } = require('../networks');

const MAX_PAGES = 5;
const MAX_TX = 400;   // batas tx yang dibaca per token per pindai

class SolanaProceeds extends Proceeds {
  async getTx(sig) {
    this.txCache ??= new Map();
    if (this.txCache.has(sig)) return this.txCache.get(sig);
    const tx = await this.rpc.run((c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }), { needsHistory: true }).catch(() => null);
    if (this.txCache.size > 500) this.txCache.clear();
    this.txCache.set(sig, tx);
    return tx;
  }

  // Perubahan saldo milik wallet di satu tx: Map mint -> delta (SOL = native + wSOL,
  // biaya tx dikembalikan kalau wallet pembayarnya).
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

  // Tanpa saldo lampau: stok sebelum lot pertama dianggap nol (seperti EVM tanpa arsip).
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
    } catch { /* ATA cukup */ }
    return [...set];
  }

  async scanTransfers(wallet, token, lo, hi, { ethUsd, known, seenTx, lpTx }) {
    const sigs = new Map();
    for (const acc of await this.tokenAccounts(wallet, token)) {
      let before;
      for (let page = 0; page < MAX_PAGES; page++) {
        const list = await this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(acc), { limit: 1000, before }), { needsHistory: true }).catch(() => []);
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
        // Aset kuotasi yang masuk di tx yang sama = hasil jual (USD).
        let usd = 0;
        for (const [mint, v] of d) {
          const q = quotes[mint];
          if (!q || v <= 0n || mint === token) continue;
          usd += (Number(v) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1);
        }
        const sale = usd > 0 ? usd : null;
        this.store.run('INSERT OR REPLACE INTO wsales(chain,wallet,token,tx_hash,block,ts,tok_out,quote_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)',
          this.network, wallet, token, s.signature, s.slot, ts, (-tokD).toString(), sale, sale != null ? 'sell' : 'send');
        known.push({ tx_hash: s.signature, block: s.slot, tok_out: (-tokD).toString(), quote_usd: sale });
      } else if (tokD > 0n && !lpTx.has(s.signature)) {
        this.store.run('INSERT OR REPLACE INTO wflows(chain,wallet,token,tx_hash,block,ts,tok_in) VALUES(?,?,?,?,?,?,?)',
          this.network, wallet, token, s.signature, s.slot, ts, tokD.toString());
      }
    }
  }
}

module.exports = { SolanaProceeds };
