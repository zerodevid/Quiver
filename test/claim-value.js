'use strict';
// A target's fee harvest is valued from the PoolManager's token transfers in its tx, so the close
// card can include it in the target's result.
const assert = require('node:assert');
const { Watcher } = require('../src/watcher');

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const T0 = '0x01e6301bc1118be90cc6bc2d1b5c0c44bb883111', T1 = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const to = '0x6a28ce2f06cb2821b1d2eb11da2896ee92ba2b75';

function watcher(logs) {
  const w = Object.create(Watcher.prototype);
  w.chain = {
    ADDR: { poolManager: PM },
    rpc: { call: async () => ({ logs }) },
    poolKeyOfId: async () => ({ currency0: T0, currency1: T1 }),
    slot0V4Many: async () => [{ sqrtPriceX96: 2040545522314459957605n }],
    tokens: async () => [{ decimals: 18 }, { decimals: 6 }],
    valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({
      value: (Number(amount0) / 1e18) * (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 1e12 + Number(amount1) / 1e6, symbol: 'USDG',
    }),
  };
  return w;
}
const logs = [
  { address: T0, topics: [TRANSFER, pad(PM), pad(to)], data: word(6678858205744740939132n) },
  { address: T1, topics: [TRANSFER, pad(PM), pad(to)], data: word(3931738n) },
];
const row = { l: { transactionHash: '0xabc', blockNumber: '0x10' }, poolId: '0x75' };

(async () => {
  const v = await watcher(logs).valueClaim(row, [{ transactionHash: '0xabc' }]);
  assert.ok(Math.abs(v.valueQuote - 8.36) < 0.05, `harvest value ${v.valueQuote}`);
  assert.equal(v.amount1, '3931738');
  // A tx that touches several positions cannot be attributed to one of them.
  assert.deepEqual(await watcher(logs).valueClaim(row, [{ transactionHash: '0xabc' }, { transactionHash: '0xabc' }]), {});
  console.log('ok   a target fee harvest is valued from the PoolManager transfers');
})().catch((e) => { console.error(e); process.exit(1); });
