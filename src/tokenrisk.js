'use strict';
// Entry-time token risk checks for EVM chains. Three questions about the memecoin side of a pool:
//   1. who created the token (the sender of the first mint transaction),
//   2. is that creator a serial launcher (many tokens minted straight to its wallet lately),
//   3. how concentrated is the supply (largest holder that is not the pool / burn address).
// The data comes from Alchemy's transfer index, read separately from the trading RPC queue.
// Everything fails open: no Alchemy endpoint, a timeout or a rate limit returns null and the entry
// is not blocked, the same as the pool-age filter when the age cannot be read.
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const MAX_PAGES = 3;        // a token with more than ~3000 transfers is not young; its holders are not scanned
const CALL_TIMEOUT_MS = 4000;
const lc = (s) => String(s || '').toLowerCase();

// Which side(s) of the pool are the memecoin: the non-quote token, or both when the pool has no quote asset.
function memeTokens(chain, act) {
  const q = chain.quoteSideOf(act.token0, act.token1);
  return (q ? [q.side === 0 ? act.token1 : act.token0] : [act.token0, act.token1]).map(lc);
}

function alchemyEndpoints(chain, cfg) {
  return (cfg.chain?.endpoints || []).filter((e) => { try { return new URL(e.url).hostname === chain.alchemyHost; } catch { return false; } });
}

// Pure decision from the gathered facts and the filters. Returns the skip reason, or null to allow.
function riskVerdict(info, f) {
  if (!info) return null;
  const bl = (f.deployer_blacklist || []).map(lc);
  const hit = [info.creator, info.mintTo].filter(Boolean).map(lc).find((a) => bl.includes(a));
  if (hit) return `pembuat token ${hit.slice(0, 10)}… ada di daftar hitam deployer`;
  if (f.max_deployer_tokens > 0 && info.deployerTokens != null && info.deployerTokens >= f.max_deployer_tokens) {
    return `pembuat token ${info.creator.slice(0, 10)}… sudah membuat ${info.deployerTokens} token dalam ${f.deployer_window_hours} jam (>= ${f.max_deployer_tokens})`;
  }
  if (f.max_top_holder_pct > 0 && info.topHolder && info.topHolder.pct > f.max_top_holder_pct) {
    return `satu dompet (${info.topHolder.address.slice(0, 10)}…) memegang ${info.topHolder.pct.toFixed(1)}% supply (> ${f.max_top_holder_pct}%)`;
  }
  return null;
}

function createTokenRisk({ chain, cfg, fetchImpl = fetch, now = Date.now }) {
  const endpoints = alchemyEndpoints(chain, cfg);
  const memo = new Map();
  // Cache the promise, so two entries on the same token in the same moment share one scan.
  const cached = (key, ttl, fn) => {
    const hit = memo.get(key);
    if (hit && hit.until > now()) return hit.p;
    const p = fn().catch(() => null);
    memo.set(key, { until: now() + ttl, p });
    p.then((v) => { if (v == null) memo.set(key, { until: now() + 30_000, p }); });
    if (memo.size > 200) for (const [k, e] of memo) if (e.until < now()) memo.delete(k);
    return p;
  };

  let id = 0, at = 0;
  async function rpc(method, params) {
    for (let attempt = 0; attempt < Math.min(2, endpoints.length); attempt++) {
      const ep = endpoints[(at + attempt) % endpoints.length];
      try {
        const res = await fetchImpl(ep.url, {
          method: 'POST', headers: { 'content-type': 'application/json', ...ep.headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const j = await res.json();
        if (j.error || j.result == null) throw new Error('rpc_error');
        return j.result;
      } catch { at = (at + 1) % endpoints.length; }
    }
    throw new Error('rpc_unavailable');
  }
  const transfers = (p) => rpc('alchemy_getAssetTransfers', [{ category: ['erc20'], ...p }]);

  // The first mint of the token: its recipient and the EOA that sent the transaction.
  const creatorOf = (token) => cached(`creator:${token}`, 24 * 3600_000, async () => {
    const r = await transfers({ fromBlock: '0x0', toBlock: 'latest', contractAddresses: [token], fromAddress: ZERO, maxCount: '0x1', order: 'asc' });
    const mint = r.transfers?.[0];
    if (!mint) return null;
    let from = null;
    try { from = lc((await rpc('eth_getTransactionByHash', [mint.hash])).from); } catch { /* fall back to the mint recipient */ }
    return { creator: from || lc(mint.to), mintTo: lc(mint.to) };
  });

  // Distinct tokens minted straight to the creator's wallet within the window.
  const mintedBy = (creator, hours) => cached(`serial:${creator}:${hours}`, 5 * 60_000, async () => {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const span = Math.ceil(hours * 3600_000 / chain.blockMs);
    const seen = new Set();
    let pageKey;
    for (let page = 0; page < 3; page++) {
      const r = await transfers({ fromBlock: '0x' + Math.max(0, head - span).toString(16), toBlock: 'latest', fromAddress: ZERO, toAddress: creator, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) });
      for (const t of r.transfers || []) if (t.rawContract?.address) seen.add(lc(t.rawContract.address));
      pageKey = r.pageKey;
      if (!pageKey) break;
    }
    return seen.size;
  });

  // Largest holder that is not the pool manager, the pool itself, or a burn address. Null when the
  // token has too much history to ledger quickly.
  const topHolderOf = (token, poolAddr) => cached(`holder:${token}:${poolAddr || ''}`, 2 * 60_000, async () => {
    const skip = new Set([ZERO, DEAD, lc(chain.ADDR.poolManager), lc(poolAddr)]);
    const supply = BigInt(await rpc('eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']));
    if (supply <= 0n) return null;
    const ledger = new Map();
    let pageKey, done = false;
    for (let page = 0; page < MAX_PAGES && !done; page++) {
      const r = await transfers({ fromBlock: '0x0', toBlock: 'latest', contractAddresses: [token], maxCount: '0x3e8', order: 'asc', excludeZeroValue: false, ...(pageKey ? { pageKey } : {}) });
      for (const t of r.transfers || []) {
        const v = t.rawContract?.value;
        if (!/^0x[0-9a-f]+$/i.test(v || '')) continue;
        const amt = BigInt(v);
        if (t.from) ledger.set(lc(t.from), (ledger.get(lc(t.from)) || 0n) - amt);
        if (t.to) ledger.set(lc(t.to), (ledger.get(lc(t.to)) || 0n) + amt);
      }
      pageKey = r.pageKey;
      done = !pageKey;
    }
    if (!done) return null;
    let best = null;
    for (const [a, bal] of ledger) if (!skip.has(a) && bal > 0n && (!best || bal > best.bal)) best = { address: a, bal };
    return best ? { address: best.address, pct: Number(best.bal * 1_000_000n / supply) / 10_000 } : { address: ZERO, pct: 0 };
  });

  // Only what the active filters need is fetched. Null = unknown.
  async function inspect(token, f, poolAddr) {
    if (!endpoints.length) return null;
    token = lc(token);
    const info = { token, creator: null, mintTo: null, deployerTokens: null, topHolder: null };
    const needCreator = f.max_deployer_tokens > 0 || (f.deployer_blacklist || []).length > 0;
    const jobs = [];
    if (needCreator) {
      jobs.push((async () => {
        const c = await creatorOf(token);
        if (!c) return;
        info.creator = c.creator; info.mintTo = c.mintTo;
        if (f.max_deployer_tokens > 0) info.deployerTokens = await mintedBy(c.creator, f.deployer_window_hours);
      })());
    }
    if (f.max_top_holder_pct > 0) jobs.push(topHolderOf(token, poolAddr).then((h) => { info.topHolder = h; }));
    await Promise.all(jobs);
    return info;
  }

  return { inspect, enabled: endpoints.length > 0 };
}

module.exports = { createTokenRisk, riskVerdict, memeTokens };
