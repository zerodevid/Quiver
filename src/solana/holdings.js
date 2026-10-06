'use strict';
// Holdings of any Solana wallet (the "Wallet holdings" panel & the balance column of the target
// list): native SOL (merged with wSOL — in a wallet it is the same money) and every SPL +
// Token-2022 token account with a balance. Same row shape as the EVM Holdings.
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { WSOL } = require('../networks');

// A memecoin wallet can hold hundreds of dust tokens; only this many are valued.
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
      // LP position NFTs (amount 1, 0 decimals) are not token balances
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

  // USD prices for all tokens at once (Jupiter), not one DexScreener call per token.
  async prices(mints) { return this.chain.jup.prices(mints).catch(() => new Map()); }
}

module.exports = { SolanaHoldings };
