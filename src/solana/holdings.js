'use strict';
// Isi wallet mana pun di Solana (panel "Wallet holdings" & kolom saldo daftar target):
// SOL native (digabung dengan wSOL — di dompet itu uang yang sama) dan semua akun
// token SPL + Token-2022 yang bersaldo. Bentuk barisnya sama dengan Holdings EVM.
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { WSOL } = require('../networks');

// Wallet memecoin bisa memegang ratusan token debu; yang dinilai dibatasi.
const MAX_TOKENS = 150;

class SolanaHoldings {
  constructor({ rpc, chain }) { this.rpc = rpc; this.chain = chain; }

  async of(owner) {
    const pk = new PublicKey(owner);
    const [lamports, a, b] = await Promise.all([
      this.rpc.run((c) => c.getBalance(pk, 'confirmed')),
      this.rpc.run((c) => c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID }), { indexed: true }),
      this.rpc.run((c) => c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM_ID }), { indexed: true }),
    ]);
    const raw = new Map([[WSOL, BigInt(lamports)]]);
    const decs = new Map([[WSOL, 9]]);
    for (const { account } of [...a.value, ...b.value]) {
      const info = account.data?.parsed?.info;
      const amt = BigInt(info?.tokenAmount?.amount || '0');
      // NFT posisi LP (jumlah 1, desimal 0) bukan saldo token
      if (!info || amt === 0n || info.tokenAmount.decimals === 0) continue;
      raw.set(info.mint, (raw.get(info.mint) || 0n) + amt);
      decs.set(info.mint, info.tokenAmount.decimals);
    }
    const mints = [...raw.keys()].slice(0, MAX_TOKENS);
    const metas = await this.chain.tokens(mints).catch(() => []);
    const metaBy = new Map(metas.filter(Boolean).map((t) => [t.address, t]));
    const { QUOTES } = this.chain;
    return mints.map((m) => {
      const meta = metaBy.get(m) || {};
      const dec = meta.decimals ?? decs.get(m) ?? 9;
      const r = raw.get(m);
      return {
        address: m, symbol: m === WSOL ? 'SOL' : meta.symbol || QUOTES[m]?.symbol || m.slice(0, 6),
        name: m === WSOL ? 'SOL (native + wSOL)' : meta.name || null, decimals: dec,
        raw: r.toString(), amount: Number(r) / 10 ** dec,
        isQuote: !!QUOTES[m], native: m === WSOL,
      };
    });
  }

  // Harga USD sekaligus untuk semua token (Jupiter), bukan satu DexScreener per token.
  async prices(mints) { return this.chain.jup.prices(mints).catch(() => new Map()); }
}

module.exports = { SolanaHoldings };
