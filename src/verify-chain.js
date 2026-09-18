'use strict';
// Verifikasi profil chain (networks.js) langsung ke chain-nya:
//   node src/verify-chain.js bsc [https://rpc-url]
// Memastikan chain id cocok, tiap alamat kontrak punya bytecode, dan relasi antar
// kontrak konsisten (NPM.factory() == factory yang dicatat, posmV4.poolManager() ==
// PoolManager, simbol/desimal aset kuotasi). Jalankan sebelum mematikan dry_run di
// chain baru — alamat yang salah satu digit pun berarti transaksi ke kontrak yang salah.
const { ethers } = require('ethers');
const { RpcPool } = require('./rpc');
const { build, NETWORKS } = require('./networks');
const { ABI } = require('./chain');
const { bscTemplate } = require('./multichain');

const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_ERC20 = new ethers.Interface(ABI.erc20);
const IF_FACT = new ethers.Interface(['function owner() view returns (address)', 'function feeAmountTickSpacing(uint24) view returns (int24)']);
const addrOf = (w) => (w && w !== '0x' ? ('0x' + w.slice(-40)).toLowerCase() : null);

async function verify(key, urls, log = console.log) {
  const p = build(key);
  const pool = new RpcPool(urls.map((u) => ({ url: u, max_batch: 10 })), () => {}, { max_inflight: 2, dns_over_https: false });
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'OK ' : 'GAGAL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
  const cid = parseInt(await pool.call('eth_chainId'), 16);
  check('chain id', cid === p.CHAIN_ID, `${cid} (harus ${p.CHAIN_ID})`);
  const head = await pool.blockNumber();
  check('blok terbaru terbaca', head > 0, String(head));

  const code = async (a) => { try { const c = await pool.call('eth_getCode', [a, 'latest']); return c && c !== '0x' ? c.length : 0; } catch { return -1; } };
  const named = Object.entries(p.ADDR).filter(([k, a]) => k !== 'native' && a);
  for (const [k, a] of named) {
    const n = await code(a);
    check(`bytecode ${k}`, n > 2, `${a} (${n > 2 ? `${Math.round(n / 2)} byte` : 'KOSONG'})`);
  }
  const call = async (to, data) => { try { const [w] = await pool.ethCallMany([{ to, data }], 'latest', { strict: true }); return w; } catch (e) { return null; } };

  // v3: NPM.factory() harus sama dengan factory yang dicatat untuk venue itu
  for (const v of p.venues) {
    const f = addrOf(await call(v.npmV3, IF_NPM.encodeFunctionData('factory')));
    if (v.factory) check(`venue ${v.key}: NPM.factory() == factory`, f === v.factory, `${f} vs ${v.factory}`);
    else check(`venue ${v.key}: NPM.factory() terbaca`, !!f, String(f));
    if (f) {
      // Tier 500 (tick spacing 10) ada di Uniswap v3 maupun PancakeSwap v3 (yang tidak punya tier 3000).
      const ts = await call(f, IF_FACT.encodeFunctionData('feeAmountTickSpacing', [500]));
      check(`venue ${v.key}: factory.feeAmountTickSpacing(500) == 10`, ts != null && Number(BigInt(ts)) === 10, ts != null ? String(Number(BigInt(ts))) : 'tidak terbaca');
    }
  }
  // v4: posmV4.poolManager() == poolManager
  const pm = addrOf(await call(p.ADDR.posmV4, IF_POSM.encodeFunctionData('poolManager')));
  check('posmV4.poolManager() == poolManager', pm === p.ADDR.poolManager, `${pm} vs ${p.ADDR.poolManager}`);
  const next = await call(p.ADDR.posmV4, IF_POSM.encodeFunctionData('nextTokenId'));
  check('posmV4.nextTokenId() terbaca', next != null, next != null ? `${BigInt(next)} posisi v4 pernah dibuat` : '');
  // aset kuotasi: simbol & desimal
  for (const [slot, meta] of Object.entries(NETWORKS[key].quoteMeta)) {
    if (slot === 'native') continue;
    const a = p.ADDR[slot];
    let sym = null, dec = null;
    try { sym = IF_ERC20.decodeFunctionResult('symbol', await call(a, IF_ERC20.encodeFunctionData('symbol')))[0]; } catch { /* */ }
    try { dec = Number(IF_ERC20.decodeFunctionResult('decimals', await call(a, IF_ERC20.encodeFunctionData('decimals')))[0]); } catch { /* */ }
    check(`${slot}: simbol ${meta.symbol}`, sym === meta.symbol, `terbaca ${sym}`);
    check(`${slot}: desimal ${meta.decimals}`, dec === meta.decimals, `terbaca ${dec}`);
  }
  const bad = results.filter((r) => !r.ok);
  log(bad.length ? `\n${bad.length} pemeriksaan GAGAL — jangan matikan dry_run untuk ${p.label}.` : `\nSemua ${results.length} pemeriksaan lolos untuk ${p.label}.`);
  return { ok: !bad.length, results };
}

if (require.main === module) {
  const key = process.argv[2] || 'bsc';
  const urls = process.argv[3] ? [process.argv[3]] : (key === 'bsc' ? bscTemplate().chain.endpoints.map((e) => e.url) : []);
  if (!urls.length) { console.error('pakai: node src/verify-chain.js <chain> <https://rpc-url>'); process.exit(1); }
  verify(key, urls).then((r) => process.exit(r.ok ? 0 : 2)).catch((e) => { console.error('gagal:', e.message); process.exit(1); });
}

module.exports = { verify };
