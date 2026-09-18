'use strict';
const { ensureChain } = require('./networks');
// Read a bounded initialized-tick curve and watched LPs at one block.
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { ABI } = require('./chain');
const { poolBase, tickSlot } = require('./fees');
const { unpackSlot0, computePoolId } = require('./pools');
const coder = AbiCoder.defaultAbiCoder();
const ext = new Interface(['function extsload(bytes32) view returns(bytes32)']);
const v3 = new Interface([...ABI.poolV3, 'function liquidity() view returns(uint128)', 'function tickBitmap(int16) view returns(uint256)', 'function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)']);
const pos3 = new Interface(ABI.npmV3), pos4 = new Interface(ABI.posmV4);
const multi = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns((bool success,bytes returnData)[])']);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function poolDepth({ rpc, chain, store, engine }, ref) {
  chain = ensureChain(chain);
  const pool = store.get('SELECT * FROM pools WHERE pool_ref=?', ref) || store.get('SELECT * FROM positions WHERE pool_ref=? LIMIT 1', ref);
  if (!pool) return { error: 'Pool belum memiliki metadata kedalaman.' };
  const metas = await chain.tokens([pool.token0, pool.token1]);
  const meta = (a) => chain.QUOTES[a] || metas.find((m) => m.address === a);
  const q = chain.QUOTES[pool.token0] ? 0 : chain.QUOTES[pool.token1] ? 1 : null;
  if (q == null) return { error: 'Aset kuotasi pool belum didukung.' };
  const block = await rpc.blockNumber(), tag = '0x' + block.toString(16);
  const read = async (calls, optional = false) => {
    const results = [];
    for (let i = 0; i < calls.length; i += 100) {
      const chunk = calls.slice(i, i + 100);
      const data = multi.encodeFunctionData('aggregate3', [chunk.map(([target, callData]) => ({ target, callData, allowFailure: optional }))]);
      const encoded = await rpc.call('eth_call', [{ to: '0xca11bde05977b3631167028862be2a173976ca11', data }, tag]);
      const [decoded] = multi.decodeFunctionResult('aggregate3', encoded);
      if (decoded.length !== chunk.length || (!optional && decoded.some((r) => !r.success))) throw new Error('Kedalaman pool tidak terbaca lengkap.');
      results.push(...decoded.map((r) => r.success ? r.returnData : null));
    }
    return results;
  };
  const is4 = ref.length === 66, base = is4 ? poolBase(ref) : null;
  const storage = (slot) => [chain.ADDR.poolManager, ext.encodeFunctionData('extsload', [hex(slot)])];
  let slot, L, spacing, fee;
  if (is4) {
    const r = await read([storage(base), storage(base + 3n)]);
    slot = unpackSlot0(r[0]); L = BigInt(r[1]) & ((1n << 128n) - 1n); spacing = Number(pool.tick_spacing); fee = slot.lpFee;
  } else {
    const r = await read(['slot0', 'liquidity', 'tickSpacing', 'fee'].map((f) => [ref, v3.encodeFunctionData(f)]));
    const s = v3.decodeFunctionResult('slot0', r[0]);
    slot = { sqrtPriceX96: s[0], tick: Number(s[1]), protocolFee: 0 }; L = BigInt(r[1]); spacing = Number(BigInt(r[2])); fee = Number(BigInt(r[3]));
  }
  if (!(spacing > 0 && spacing <= 32767) || slot.sqrtPriceX96 <= 0n) return { error: 'Harga atau tick spacing tidak tersedia.' };
  const start = Math.max(-887272, slot.tick - 14000), end = Math.min(887272, slot.tick + 14000);
  const first = Math.floor(Math.floor(start / spacing) / 256), last = Math.floor(Math.floor(end / spacing) / 256);
  if (last - first > 128) return { error: 'Rentang pembacaan kedalaman terlalu lebar.' };
  const words = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const maps = await read(words.map((word) => is4 ? storage(BigInt(keccak256(coder.encode(['int16', 'uint256'], [word, base + 5n])))) : [ref, v3.encodeFunctionData('tickBitmap', [word])]));
  const tickIds = [];
  maps.forEach((r, i) => { const bits = BigInt(r); for (let b = 0; b < 256; b++) { const t = (words[i] * 256 + b) * spacing; if ((bits & (1n << BigInt(b))) && t >= start && t <= end) tickIds.push(t); } });
  if (tickIds.length > 2048) return { error: 'Terlalu banyak tick untuk simulasi ringkas.' };
  const tickValues = await read(tickIds.map((t) => is4 ? storage(tickSlot(base, t)) : [ref, v3.encodeFunctionData('ticks', [t])]));
  const ticks = tickIds.map((tick, i) => ({ tick, net: String(is4 ? BigInt.asIntN(128, BigInt(tickValues[i]) >> 128n) : v3.decodeFunctionResult('ticks', tickValues[i])[1]) }));
  const own = store.all("SELECT * FROM positions WHERE pool_ref=? AND status='open'", ref);
  const watched = store.all("SELECT w.*, t.label FROM wpositions w JOIN targets t ON t.address=w.wallet WHERE w.pool_ref=? AND w.status='open'", ref);
  const requests = new Map();
  const add = (r, owner, kind, tokenId = r.token_id) => {
    if (!/^\d+$/.test(String(tokenId))) return;
    const key = `${is4 ? 'v4' : 'v3'}:${tokenId}`;
    if (!requests.has(key)) requests.set(key, { tokenId: String(tokenId), owner, kind, id: r.id, label: r.label || null });
  };
  for (const r of own) add(r, engine.exec.address(), 'own');
  for (const r of watched) add(r, r.wallet, 'target');
  for (const r of own) if (r.target && r.mirror_of) add(r, r.target, 'target', r.mirror_of);
  const limited = [...requests.values()].slice(0, 40), positions = [], unknown = requests.size > 40;
  const intf = is4 ? pos4 : pos3;
  const manager = is4 ? chain.ADDR.posmV4 : (chain.venues.find((v) => v.key === pool.venue)?.npmV3 || chain.ADDR.npmV3);
  let missingPositions = unknown;
  for (const r of limited) {
    try {
      const funcs = is4 ? ['getPoolAndPositionInfo', 'getPositionLiquidity', 'ownerOf'] : ['positions', 'ownerOf'];
      const values = await read(funcs.map((f) => [manager, intf.encodeFunctionData(f, [r.tokenId])]), true);
      if (values.some((v) => !v)) { missingPositions = true; continue; }
      const owner = intf.decodeFunctionResult('ownerOf', values[values.length - 1])[0].toLowerCase();
      if (owner !== r.owner?.toLowerCase()) { missingPositions = true; continue; }
      let lower, upper, liquidity;
      if (is4) {
        const d = intf.decodeFunctionResult('getPoolAndPositionInfo', values[0]);
        if (computePoolId(d[0]).toLowerCase() !== ref) { missingPositions = true; continue; }
        lower = Number(BigInt.asIntN(24, d[1] >> 8n)); upper = Number(BigInt.asIntN(24, d[1] >> 32n)); liquidity = BigInt(values[1]);
      } else {
        const d = intf.decodeFunctionResult('positions', values[0]);
        if (d[2].toLowerCase() !== pool.token0 || d[3].toLowerCase() !== pool.token1 || Number(d[4]) !== fee) { missingPositions = true; continue; }
        lower = Number(d[5]); upper = Number(d[6]); liquidity = d[7];
      }
      positions.push({ ...r, lower, upper, liquidity: String(liquidity) });
    } catch { missingPositions = true; }
  }
  const walletBalances = [];
  let missingWallets = false;
  const token = q === 0 ? pool.token1 : pool.token0, decimals = meta(token)?.decimals;
  const erc = new Interface(['function balanceOf(address) view returns(uint256)']);
  const owners = [...new Set(positions.filter((p) => p.kind === 'target').map((p) => p.owner))];
  const balances = await read(owners.map((owner) => [token, erc.encodeFunctionData('balanceOf', [owner])]), true);
  owners.forEach((owner, i) => { if (balances[i] && decimals != null) walletBalances.push({ owner, base: Number(BigInt(balances[i])) / 10 ** decimals }); else missingWallets = true; });
  const protocol = slot.protocolFee || 0;
  const combined = (zeroForOne) => { const p = zeroForOne ? protocol & 4095 : protocol >> 12; return (p + fee - p * fee / 1e6) / 1e6; };
  return { ref, block, fetchedAt: Date.now(), tick: slot.tick, sqrt: String(slot.sqrtPriceX96), liquidity: String(L), ticks, start, end,
    dec0: meta(pool.token0)?.decimals, dec1: meta(pool.token1)?.decimals, quoteSide: q, quoteUsd: chain.QUOTES[q === 0 ? pool.token0 : pool.token1].kind === 'eth' ? engine.ethUsd : 1,
    buyFee: combined(q === 0), sellFee: combined(q !== 0), hook: is4 && !!pool.hooks && !/^0x0{40}$/i.test(pool.hooks),
    positions, missingPositions, walletBalances, missingWallets, targetScope: 'watched_positions', dynamicFee: Number(pool.fee) >= 0x800000 };
}
module.exports = { poolDepth };
