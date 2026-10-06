'use strict';
// Holder distribution of a mint (the "Pool health" panel), same shape as holders.js:
// the 20 largest token accounts (getTokenLargestAccounts) → their owners (one owner can hold
// several token accounts, merged), owner kind from the program that owns the account: a
// Meteora/Orca/Raydium pool vault = pool liquidity, the incinerator = burn, another program's
// account = contract. Holder count from Jupiter — there is no cheap way over public RPC.
const { PublicKey } = require('@solana/web3.js');

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const cache = new Map();   // mint -> {until, value}

async function solanaHolders({ rpc, chain }, mint) {
  let pk;
  try { pk = new PublicKey(mint); } catch { return { error: 'invalid_token' }; }
  const hit = cache.get(mint);
  if (hit && hit.until > Date.now()) return hit.value;
  const share = (v, sup) => (sup > 0n ? Number((v * 1_000_000n) / sup) / 10_000 : null);
  let value, rec = null;
  try {
    let sup, largest;
    [sup, largest, rec] = await Promise.all([
      rpc.run((c) => c.getTokenSupply(pk)),
      // Indexed request: never sent to an endpoint that refuses it (rpc.js no_indexed).
      rpc.run((c) => c.getTokenLargestAccounts(pk), { indexed: true }),
      chain.jup.tokenRecord(mint).catch(() => null),
    ]);
    const supply = BigInt(sup.value.amount);
    const accs = largest.value.filter((x) => BigInt(x.amount) > 0n);
    const parsed = await rpc.run((c) => c.getMultipleParsedAccounts(accs.map((x) => x.address)));
    const byOwner = new Map();
    accs.forEach((x, i) => {
      const owner = parsed.value[i]?.data?.parsed?.info?.owner || x.address.toBase58();
      byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(x.amount));
    });
    const owners = [...byOwner.keys()];
    const infos = owners.length ? await rpc.run((c) => c.getMultipleAccountsInfo(owners.map((o) => new PublicKey(o)))) : [];
    const venuePrograms = new Set(Object.values(chain.adapters).map((a) => a.program));
    const items = owners.map((o, i) => {
      const prog = infos[i]?.owner?.toBase58() || null;
      // A plain wallet = an account owned by the System Program. No account (an authority PDA)
      // or owned by another program = contract.
      const isContract = prog !== SYSTEM;
      const kind = o === INCINERATOR ? 'burn' : venuePrograms.has(prog) ? 'pool_manager' : isContract ? 'contract' : 'address';
      const bal = byOwner.get(o);
      return { address: o, balance: String(bal), percent: share(bal, supply), isContract, kind, program: prog };
    }).sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));
    const count = Number(rec?.holderCount);
    value = {
      token: mint, holderCount: Number.isSafeInteger(count) && count >= items.length ? count : null,
      totalSupply: String(supply), decimals: sup.value.decimals, items, hasMore: largest.value.length >= 20,
      top10Pct: share(items.slice(0, 10).reduce((a, h) => a + BigInt(h.balance), 0n), supply),
      fetchedAt: Date.now(), source: 'Solana RPC', url: chain.explorerTokenUrl ? chain.explorerTokenUrl(mint) : null,
    };
  } catch (e) {
    // Public RPC refuses getTokenLargestAccounts (publicnode "Request blocked",
    // mainnet-beta 429 per method) — the full list needs a paid RPC (Helius etc.).
    // Without it: holder count & top-holder share from Jupiter's audit.
    rec ??= await chain.jup.tokenRecord(mint).catch(() => null);
    const count = Number(rec?.holderCount), top = Number(rec?.audit?.topHoldersPercentage);
    value = rec && (Number.isSafeInteger(count) || Number.isFinite(top))
      ? { token: mint, holderCount: Number.isSafeInteger(count) ? count : null, totalSupply: null, decimals: rec.decimals ?? null,
        items: [], hasMore: true, top10Pct: Number.isFinite(top) ? top : null, fetchedAt: Date.now(), source: 'Jupiter',
        url: chain.explorerTokenUrl ? chain.explorerTokenUrl(mint) : null, note: 'daftar holder butuh RPC yang mendukung getTokenLargestAccounts' }
      : { token: mint, error: 'unavailable', source: 'Solana RPC', detail: String(e.message).slice(0, 120), fetchedAt: Date.now() };
  }
  cache.set(mint, { until: Date.now() + (value.error ? 60_000 : 5 * 60_000), value });
  if (cache.size > 200) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  return value;
}

module.exports = { solanaHolders };
