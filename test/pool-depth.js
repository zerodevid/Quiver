'use strict';
const assert = require('node:assert/strict');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { poolDepth } = require('../src/pool-depth');
const { poolBase, tickSlot } = require('../src/fees');
const { ADDR } = require('../src/chain');
const coder = AbiCoder.defaultAbiCoder();
const multi = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns((bool success,bytes returnData)[])']);
const ext = new Interface(['function extsload(bytes32) view returns(bytes32)']);
const ref = '0x' + '1'.repeat(64), base = poolBase(ref), token = '0x' + '2'.repeat(40);
const hex = n => '0x' + n.toString(16).padStart(64, '0');
const slots = new Map();
slots.set(hex(base), hex((2n ** 96n) | (3000n << 208n)));
slots.set(hex(base + 3n), hex(1000n));
// Signed negative bitmap word: tick -60 is bit 255 in word -1.
const bitmap = word => keccak256(coder.encode(['int16', 'uint256'], [word, base + 5n]));
slots.set(bitmap(-1), hex(1n << 255n)); slots.set(bitmap(0), hex(2n));
slots.set(hex(tickSlot(base, -60)), hex(700n | (700n << 128n)));
slots.set(hex(tickSlot(base, 60)), hex(700n | (BigInt.asUintN(128, -700n) << 128n)));
let reads = 0;
const rpc = { blockNumber: async () => 123, call: async (method, [tx, tag]) => {
  assert.equal(method, 'eth_call'); assert.equal(tag, '0x7b'); reads++;
  const [calls] = multi.decodeFunctionData('aggregate3', tx.data);
  return multi.encodeFunctionResult('aggregate3', [calls.map(c => {
    assert.equal(c.target.toLowerCase(), ADDR.poolManager);
    const [slot] = ext.decodeFunctionData('extsload', c.callData);
    return [true, slots.get(slot) || hex(0n)];
  })]);
} };
(async () => {
  const d = await poolDepth({ rpc, store: { get: () => ({ token0: ADDR.usdg, token1: token, tick_spacing: 60, fee: 3000 }), all: () => [] }, chain: { tokens: async () => [{ address: token, decimals: 18 }] }, engine: { ethUsd: 2000 } }, ref);
  assert.equal(d.block, 123); assert.equal(d.liquidity, '1000'); assert.equal(d.dec0, 6); assert.equal(d.dec1, 18);
  assert.equal(d.buyFee, 0.003); assert.equal(d.sellFee, 0.003); assert.equal(d.missingPositions, false);
  assert.deepEqual(d.ticks, [{ tick: -60, net: '700' }, { tick: 60, net: '-700' }]); assert.ok(reads >= 3);
  console.log('Pool depth pins reads to one block and decodes signed bitmap/tick liquidity correctly');
})().catch(e => { console.error(e); process.exitCode = 1; });
