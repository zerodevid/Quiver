'use strict';
// Distribusi holder sebuah mint (panel "Kesehatan pool"), bentuk sama dengan holders.js:
// 20 akun token terbesar (getTokenLargestAccounts) → pemiliknya (satu pemilik bisa punya
// beberapa akun token, digabung), jenis pemilik dari program pemilik akunnya: vault pool
// Meteora/Orca/Raydium = likuiditas pool, incinerator = burn, akun program lain =
// kontrak. Jumlah holder dari Jupiter — tidak ada cara murah lewat RPC publik.
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
      // Permintaan terindeks: publicnode (no_history) memblokirnya dengan 403, dan web3.js
      // lalu meninggalkan promise tak tertangani — jangan dikirim ke sana sama sekali.
      rpc.run((c) => c.getTokenLargestAccounts(pk), { needsHistory: true }),
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
      // Wallet biasa = akun milik System Program. Tanpa akun (PDA otoritas) atau milik
      // program lain = kontrak.
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
    // RPC publik menolak getTokenLargestAccounts (publicnode "Request blocked",
    // mainnet-beta 429 per metode) — daftar lengkap butuh RPC berbayar (Helius dst).
    // Tanpa itu: jumlah holder & porsi top holder menurut audit Jupiter.
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
