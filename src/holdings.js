// Holdings of any wallet (target, research wallet): which tokens it holds and
// what balance. Complements the LP research — positions tell how it plays,
// the portfolio tells what it is holding outside positions (close proceeds
// not yet sold, tokens being accumulated, ETH/USDG cash ready to use).
//
// The chain has no "list of tokens owned by address X", so the candidates are assembled from:
//   - quote assets (ETH, USDG, WETH) — always checked;
//   - tokens from LP positions it has opened (wpositions table);
//   - every token the bot has ever known (tokens table);
//   - ERC-20 Transfer logs whose `to` is this wallet (incremental scan, like
//     Manual.seenTokens for the bot wallet).
// Then the balances are read once in a single batch, and only those with a balance are returned.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { ensureChain } = require('./networks');
const { getLogsSafe } = require('./scout');

const IF_ERC20 = new ethers.Interface(ABI.erc20);
const lc = (t) => String(t || '').toLowerCase();
const isNative = (t) => /^0x0{40}$/.test(lc(t));
// The first scan window follows the wallet research default: 900k blocks (~1 day).
const FIRST_WINDOW = 900_000;
// Scan logs at most every 5 minutes per wallet — getLogs is the heaviest RPC
// call, and the target detail page is polled repeatedly.
const RESCAN_MS = 5 * 60_000;

class Holdings {
  constructor({ rpc, store, chain, log }) {
    this.rpc = rpc; this.store = store; this.chain = ensureChain(chain); this.log = log || (() => {});
  }

  // ERC-20 tokens that have ever ARRIVED in the wallet — from Transfer logs. Blocks already
  // seen are stored in state, so after the first scan each call only
  // reads new blocks. If the RPC fails, the old list is still used.
  async seenTokens(wallet) {
    const key = `held_seen:${this.chain.network}:${wallet}`;
    let st = { block: 0, ts: 0, tokens: [] };
    try { st = { ...st, ...JSON.parse(this.store.getState(key, '{}')) }; } catch { /* start from zero */ }
    if (st.block && Date.now() - st.ts < RESCAN_MS) return st.tokens;
    try {
      const head = await this.rpc.blockNumber();
      const lo = st.block ? st.block + 1 : Math.max(0, head - FIRST_WINDOW);
      if (head >= lo) {
        const logs = await getLogsSafe(this.rpc, { topics: [TOPIC.transfer, null, ethers.zeroPadValue(wallet, 32)] }, lo, head);
        const set = new Set(st.tokens);
        // ERC-721 Transfer has the same topic but its tokenId is in topics[3];
        // ERC-20 uses data for the amount.
        for (const l of logs) if (l.topics.length === 3 && l.address) set.add(lc(l.address));
        st = { block: head, ts: Date.now(), tokens: [...set].slice(-300) };
        this.store.setState(key, JSON.stringify(st));
      }
    } catch (e) { this.log(`pindai token ${wallet}: ${e.message}`); }
    return st.tokens;
  }

  // `tokens` balances of `owner` in one batch (native ETH via eth_getBalance).
  async balances(owner, tokens) {
    const out = new Map();
    const erc = tokens.filter((t) => !isNative(t));
    if (tokens.some(isNative)) out.set(this.chain.ADDR.native, BigInt(await this.rpc.call('eth_getBalance', [owner, 'latest'])));
    if (erc.length) {
      const res = await this.rpc.ethCallMany(erc.map((t) => ({ to: t, data: IF_ERC20.encodeFunctionData('balanceOf', [owner]) })));
      erc.forEach((t, i) => out.set(lc(t), res[i] && res[i] !== '0x' && res[i].length <= 66 ? BigInt(res[i]) : 0n));
    }
    return out;
  }

  // List of tokens with a balance held by the wallet, with metadata. ETH is always included (cash),
  // other tokens only if their balance is > 0.
  async of(wallet) {
    const w = lc(wallet);
    const { ADDR, QUOTES } = this.chain;
    const set = new Set([ADDR.native, ADDR.usdg, ADDR.weth]);
    for (const r of this.store.all('SELECT DISTINCT token0, token1 FROM wpositions WHERE chain=? AND wallet=?', this.chain.network, w)) {
      if (r.token0) set.add(lc(r.token0));
      if (r.token1) set.add(lc(r.token1));
    }
    for (const a of await this.seenTokens(w)) set.add(a);
    for (const r of this.store.all('SELECT address FROM tokens WHERE chain=?', this.chain.network)) if (r.address) set.add(lc(r.address));
    const list = [...set];
    const bal = await this.balances(w, list);
    const keep = list.filter((a) => isNative(a) || (bal.get(a) || 0n) > 0n);
    // Metadata of a token that has a balance but is not yet known is read from the chain (and stored).
    const metas = await this.chain.tokens(keep);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [lc(t.address), t]));
    return keep.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = bal.get(a) || 0n;
      const dec = meta.decimals ?? (QUOTES[a]?.decimals ?? 18);
      return {
        address: a, symbol: meta.symbol || QUOTES[a]?.symbol || a.slice(0, 8), name: meta.name || null, decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!QUOTES[a], native: isNative(a),
      };
    });
  }
}

module.exports = { Holdings };
