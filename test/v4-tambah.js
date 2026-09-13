'use strict';
// Uji: tambah likuiditas v4 memakai CLOSE_CURRENCY, bukan SETTLE_PAIR.
// INCREASE_LIQUIDITY ikut mencairkan fee posisi; kalau fee di satu token > setoran,
// deltanya positif dan SETTLE_PAIR revert DeltaNotNegative (dibuktikan di chain pada
// posisi #47: 0x000d revert 0x3351b260, CLOSE_CURRENCY lolos).
// Jalankan: node test/v4-tambah.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Executor } = require('../src/executor');
const { ADDR, ACT, ABI } = require('../src/chain');

const coder = ethers.AbiCoder.defaultAbiCoder();
const IF = new ethers.Interface(ABI.posmV4);
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); } }

const ex = new Executor({ rpc: {}, store: null, chain: null, cfg: { gas: {} }, log: () => {} });
ex.address = () => ME;
const decode = (tx) => {
  const [unlock] = IF.decodeFunctionData('modifyLiquidities', tx.data);
  const [acts, params] = coder.decode(['bytes', 'bytes[]'], unlock);
  return { acts: [...ethers.getBytes(acts)], params };
};

t('ERC20/ERC20: INCREASE + CLOSE_CURRENCY(c0) + CLOSE_CURRENCY(c1), tanpa nilai ETH', () => {
  const tx = ex.buildV4Increase({ tokenId: '7', poolKey: { currency0: ADDR.usdg, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native }, liquidity: '1000', amount0Max: '5', amount1Max: '6' }, 1);
  const { acts, params } = decode(tx);
  assert.deepStrictEqual(acts, [ACT.INCREASE_LIQUIDITY, ACT.CLOSE_CURRENCY, ACT.CLOSE_CURRENCY]);
  assert.strictEqual(coder.decode(['address'], params[1])[0].toLowerCase(), ADDR.usdg);
  assert.strictEqual(coder.decode(['address'], params[2])[0].toLowerCase(), MEME);
  const inc = coder.decode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], params[0]);
  assert.deepStrictEqual([inc[0], inc[1], inc[2], inc[3]].map(String), ['7', '1000', '5', '6']);
  assert.strictEqual(tx.value, '0');
  assert.strictEqual(tx.to, ADDR.posmV4);
});

t('ETH native sebagai currency0: nilai tx = amount0Max, ditutup dengan SWEEP ke wallet', () => {
  const tx = ex.buildV4Increase({ tokenId: '7', poolKey: { currency0: ADDR.native, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native }, liquidity: '1', amount0Max: '123', amount1Max: '0' }, 1);
  const { acts, params } = decode(tx);
  assert.deepStrictEqual(acts, [ACT.INCREASE_LIQUIDITY, ACT.CLOSE_CURRENCY, ACT.CLOSE_CURRENCY, ACT.SWEEP]);
  assert.strictEqual(tx.value, '123');
  const sw = coder.decode(['address', 'address'], params[3]);
  assert.strictEqual(sw[0].toLowerCase(), ADDR.native); assert.strictEqual(sw[1].toLowerCase(), ME);
});

t('mint tetap SETTLE_PAIR (posisi baru tidak punya fee)', () => {
  const tx = ex.buildV4Mint({ poolKey: { currency0: ADDR.usdg, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native }, tickLower: -60, tickUpper: 60, liquidity: '1', amount0Max: '1', amount1Max: '1' }, 1);
  assert.deepStrictEqual(decode(tx).acts, [ACT.MINT_POSITION, ACT.SETTLE_PAIR]);
});

console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail ? 1 : 0);
