'use strict';
const { ADDR } = require('./chain');
const { Interface } = require('ethers');
const fs = require('node:fs');
const path = require('node:path');
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const multicall = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] results)']);
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const validAddress = (a) => /^0x[0-9a-f]{40}$/i.test(a || '');
const raw = (v) => /^\d+$/.test(String(v ?? '')) ? BigInt(v) : null;
const share = (value, supply) => supply > 0n ? Number(value * 1000000n / supply) / 10000 : null;

function normalizeHolders(token, response, address, now = Date.now()) {
  const supply = raw(token?.total_supply);
  if (!token || !Array.isArray(response?.items) || supply == null || supply <= 0n) return { error: 'invalid_data' };
  const seen = new Set();
  const items = response.items.map((r) => {
    const a = r.address_hash || r.address;
    const hash = typeof a === 'string' ? a : a?.hash;
    const value = raw(r.value);
    if (!validAddress(hash) || value == null || value > supply || seen.has(hash.toLowerCase())) throw new Error('invalid_data');
    seen.add(hash.toLowerCase());
    const lower = hash.toLowerCase();
    return { address: lower, balance: String(value), percent: share(value, supply), isContract: a?.is_contract === true,
      kind: lower === ADDR.poolManager ? 'pool_manager' : /^0x0{40}$/.test(lower) || lower === '0x000000000000000000000000000000000000dead' ? 'burn' : a?.is_contract ? 'contract' : 'address' };
  }).sort((a, b) => BigInt(a.balance) > BigInt(b.balance) ? -1 : BigInt(a.balance) < BigInt(b.balance) ? 1 : 0);
  const total = items.reduce((sum, h) => sum + BigInt(h.balance), 0n);
  if (total > supply) return { error: 'invalid_data' };
  const count = Number(token.holders_count);
  return { token: address.toLowerCase(), holderCount: token.holders_count != null && Number.isSafeInteger(count) && count >= items.length ? count : null,
    totalSupply: String(supply), decimals: Number(token.decimals), items, hasMore: !!response.next_page_params,
    top10Pct: share(items.slice(0, 10).reduce((sum, h) => sum + BigInt(h.balance), 0n), supply),
    fetchedAt: now, source: 'Blockscout', url: `${EXPLORER}/token/${address}?tab=holders` };
}

function holders(market, address) {
  if (!validAddress(address) || /^0x0{40}$/i.test(address)) return Promise.resolve({ error: 'invalid_token' });
  const token = address.toLowerCase();
  return market.memo(`holders:${token}`, 5 * 60_000, async () => {
    const key = process.env.BLOCKSCOUT_API_KEY;
    const base = key ? 'https://api.blockscout.com/4663/api/v2' : `${EXPLORER}/api/v2`;
    const query = key ? `?apikey=${encodeURIComponent(key)}` : '';
    try {
      const [meta, list] = await Promise.all([
        market.json(`${base}/tokens/${token}${query}`), market.json(`${base}/tokens/${token}/holders${query}`),
      ]);
      return normalizeHolders(meta, list, token);
    } catch { return { token, error: 'unavailable', source: 'Blockscout', fetchedAt: Date.now() }; }
  });
}
module.exports = { holders, normalizeHolders };

// Use the existing Alchemy endpoint, separately from the trading RPC queue.
// Bounded background scans never delay the pool page or the copy engine.
const jobs = new WeakMap();
function alchemyHolders(market, cfg, address) {
  if (!validAddress(address) || /^0x0{40}$/i.test(address)) return Promise.resolve({ error: 'invalid_token' });
  const endpoints = cfg.chain?.endpoints?.filter((e) => { try { return new URL(e.url).hostname === 'robinhood-mainnet.g.alchemy.com'; } catch { return false; } });
  if (!endpoints?.length) return holders(market, address);
  let state = jobs.get(market);
  if (!state) { state = { running: false, cache: new Map(), histories: new Map() }; jobs.set(market, state); }
  const token = address.toLowerCase();
  const cacheFile = cfg.db?.path && cfg.db.path !== ':memory:' ? path.join(path.dirname(cfg.db.path), 'holders', `${token}.json`) : null;
  if (cacheFile && !state.cache.has(token) && !state.histories.has(token)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (saved.version === 1 && saved.value?.verifiedBalances === true && Array.isArray(saved.value.items) && saved.value?.token === token && /^0x[0-9a-f]+$/i.test(saved.block) && Array.isArray(saved.ledger) && saved.ledger.length <= 10000) {
        const ledger = new Map(saved.ledger.map(([a, v]) => { if (!validAddress(a) || raw(v) == null) throw new Error('bad_cache'); return [a, BigInt(v)]; }));
        state.histories.set(token, { block: saved.block, ledger });
        if (!saved.value.error && saved.value.fetchedAt > Date.now() - 15 * 60000) state.cache.set(token, { until: saved.value.fetchedAt + 15 * 60000, value: saved.value });
      }
    } catch { /* Optional cache; rebuild safely if absent or damaged. */ }
  }
  const hit = state.cache.get(token);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  if (state.running) return Promise.resolve({ token, error: 'scanning', source: 'Alchemy' });
  state.running = true;
  const pending = { token, error: 'scanning', source: 'Alchemy' };
  state.cache.set(token, { until: Date.now() + 660000, value: pending });
  scanAlchemy(market.fetch, endpoints, token, (progress) => { pending.progress = progress; }, state.histories.get(token) || state.histories.set(token, {}).get(token)).catch(() => ({ token, error: 'unavailable', source: 'Alchemy' })).then((value) => {
    state.cache.set(token, { until: Date.now() + (value.error === 'scan_limit' ? 6 * 3600000 : value.error ? 5 * 60000 : 15 * 60000), value });
    if (cacheFile && !value.error) {
      try {
        const history = state.histories.get(token);
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const saved = { version: 1, value, block: history.block, ledger: [...history.ledger].map(([a, v]) => [a, String(v)]) };
        fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(saved));
        fs.renameSync(cacheFile + '.tmp', cacheFile);
      } catch { /* Cached data is optional; never interrupt trading or the UI. */ }
    }
    state.running = false;
    if (state.cache.size > 20) for (const [key, entry] of state.cache) if (entry.until < Date.now()) { state.cache.delete(key); state.histories.delete(key); }
  });
  return Promise.resolve(pending);
}

async function scanAlchemy(fetchImpl, endpoint, token, progress = () => {}, history = {}) {
  const snapshotAt = history.discovery?.snapshotAt || Date.now();
  const deadline = Date.now() + 600000;
  let id = 0, activeEndpoint = 0;
  const endpoints = Array.isArray(endpoint) ? endpoint : [endpoint];
  const once = async (calls) => {
    if (Date.now() >= deadline) throw new Error('scan_timeout');
    const body = calls.map(([method, params]) => ({ jsonrpc: '2.0', id: ++id, method, params }));
    const selected = endpoints[activeEndpoint];
    const response = await fetchImpl(selected.url, { method: 'POST', headers: { 'content-type': 'application/json', ...selected.headers }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now())) });
    if (!response.ok) throw new Error('rpc_unavailable');
    const json = await response.json(), results = Array.isArray(json) ? json : [json];
    return body.map((call) => { const r = results.find((x) => x.id === call.id); if (!r || r.error || r.result == null) throw new Error('rpc_unavailable'); return r.result; });
  };
  const request = async (calls) => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(calls); }
      catch (e) { if (attempt >= 3 || Date.now() >= deadline) throw e; activeEndpoint = (activeEndpoint + 1) % endpoints.length; await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)); }
    }
  };
  const [latestBlock] = await request([['eth_blockNumber', []]]);
  const block = history.discovery?.block || latestBlock;
  const [supplyHex, decimalsHex] = await request([
    ['eth_call', [{ to: token, data: '0x18160ddd' }, block]],
    ['eth_call', [{ to: token, data: '0x313ce567' }, block]],
  ]);
  const supply = BigInt(supplyHex), candidates = new Set(), seenPages = new Set();
  const ledger = new Map(history.discovery?.ledger || history.ledger || []);
  const fromBlock = history.block ? '0x' + (BigInt(history.block) + 1n).toString(16) : '0x0';
  let pageKey, complete = !!history.discovery;
  for (let page = 0; !history.discovery && page < 500; page++) {
    const [r] = await request([['alchemy_getAssetTransfers', [{ fromBlock, toBlock: block, contractAddresses: [token], category: ['erc20'], maxCount: '0x3e8', order: 'asc', excludeZeroValue: false, ...(pageKey ? { pageKey } : {}) }]]]);
    if (!Array.isArray(r.transfers)) throw new Error('invalid_data');
    for (const tx of r.transfers) {
      if (tx.rawContract?.address?.toLowerCase() !== token) throw new Error('invalid_token');
      const amount = tx.rawContract?.value;
      if (!/^0x[0-9a-f]+$/i.test(amount || '') && !/^\d+$/.test(amount || '')) throw new Error('invalid_transfer');
      for (const [a, sign] of [[tx.from, -1n], [tx.to, 1n]]) if (validAddress(a) && !/^0x0{40}$/i.test(a)) {
        const key = a.toLowerCase();
        candidates.add(key);
        ledger.set(key, (ledger.get(key) || 0n) + sign * BigInt(amount));
      }
    }
    if (candidates.size > 50000) break;
    progress({ phase: 'history', pages: page + 1, addresses: candidates.size });
    pageKey = r.pageKey;
    if (!pageKey) { complete = true; break; }
    if (seenPages.has(pageKey)) throw new Error('invalid_page');
    seenPages.add(pageKey);
  }
  if (!complete) return { token, error: 'scan_limit', source: 'Alchemy' };
  history.discovery = { block, ledger, snapshotAt };
  const addresses = [...ledger].filter(([, value]) => value > 0n).map(([address]) => address), balances = [];
  if (addresses.length > 10000) return { token, error: 'scan_limit', source: 'Alchemy' };
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const batch = addresses.slice(offset, offset + 100);
    const data = multicall.encodeFunctionData('aggregate3', [batch.map((a) => ({ target: token, allowFailure: false, callData: '0x70a08231' + a.slice(2).padStart(64, '0') }))]);
    const [encoded] = await request([['eth_call', [{ to: MULTICALL, data }, block]]]);
    const [decoded] = multicall.decodeFunctionResult('aggregate3', encoded);
    if (decoded.length !== batch.length || decoded.some((r) => !r.success)) throw new Error('invalid_balances');
    const values = decoded.map((r) => r.returnData);
    progress({ phase: 'balances', checked: Math.min(offset + 100, addresses.length), total: addresses.length });
    values.forEach((v, i) => { const balance = BigInt(v); if (balance > 0n) balances.push({ address_hash: { hash: batch[i] }, value: balance.toString() }); });
  }
  // Sum equality catches missing indexed recipients, rebasing/event anomalies and
  // an indexer which hasn't caught up. Never expose a partial holder count as total.
  if (balances.reduce((s, r) => s + BigInt(r.value), 0n) !== supply) { delete history.discovery; return { token, error: 'incomplete', source: 'Alchemy' }; }
  balances.sort((a, b) => BigInt(a.value) > BigInt(b.value) ? -1 : BigInt(a.value) < BigInt(b.value) ? 1 : 0);
  const top = balances.slice(0, 50);
  if (top.length) {
    const code = await request(top.slice(0, 10).map((r) => ['eth_getCode', [r.address_hash.hash, block]]));
    top.slice(0, 10).forEach((r, i) => { r.address_hash.is_contract = code[i] !== '0x'; });
  }
  const result = normalizeHolders({ total_supply: supply.toString(), holders_count: balances.length, decimals: Number(BigInt(decimalsHex)) }, { items: top, next_page_params: balances.length > top.length ? {} : null }, token);
  if (!result.error) { delete history.discovery; history.block = block; history.ledger = new Map(balances.map((r) => [r.address_hash.hash, BigInt(r.value)])); }
  return { ...result, source: 'Alchemy', block: Number(BigInt(block)), snapshotAt, verifiedBalances: true };
}
module.exports.alchemyHolders = alchemyHolders;
module.exports.scanAlchemy = scanAlchemy;
