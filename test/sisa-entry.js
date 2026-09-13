'use strict';
// Uji: token yang sedang dikumpulkan sebuah entry tidak dijual antrean sisa / tombol jual
// / swap manual sampai entry itu selesai.
// Kasus: MEME dari posisi lama tersangkut di antrean; target masuk lagi ke pool MEME,
// bot zap membeli MEME, dan antrean (tiap detik) menjual saldo MEME itu sebelum mint.
// Jalankan: node test/sisa-entry.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');

const USDG = ADDR.usdg;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const LAIN = '0x' + '42'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

function engineWith() {
  const store = new Store(':memory:');
  const eng = new Engine({ rpc: { call: async () => null, ethCallMany: async (c) => c.map(() => null) }, store,
    chain: { token: async (a) => ({ address: a, symbol: 'MEME', decimals: 18 }) },
    cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
  eng.exec.balances = async (list) => new Map(list.map((x) => [String(x).toLowerCase(), 10n ** 21n]));
  eng.topUpGas = async () => {};
  eng.notify = () => {};
  const swaps = [];
  eng.kyber.quote = async () => ({ amountOut: 1n, usdIn: 10, usdOut: 9.9, dex: 'uji' });
  eng.kyber.swap = async (a) => { swaps.push(a); return { hash: '0x' + '1'.repeat(64), amountOut: 1n, quote: { usdOut: 9.9, dex: 'uji' } }; };
  return { eng, store, swaps };
}

(async () => {
  console.log('Sisa vs entry yang berjalan:\n');

  await t('selama entry MEME berjalan: antrean, tombol jual, dan swap manual tidak menjual MEME; token lain tetap jalan', async () => {
    const { eng, swaps } = engineWith();
    eng.keepLeftover({ posId: 1, target: null, token: MEME, quote: USDG, amount: '1000', tries: 0, since: Date.now() }, 'uji');
    eng.keepLeftover({ posId: 2, target: null, token: LAIN, quote: USDG, amount: '1000', tries: 0, since: Date.now() }, 'uji');
    eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0 })));

    let release;
    const gate = new Promise((r) => { release = r; });
    let midSwaps = null;
    eng.sendEntry = async () => {
      await eng.retryLeftovers();
      await eng.sellToken({ posId: 1, target: null, token: MEME, quote: USDG, amount: '1000', tries: 0 });
      const { Manual } = require('../src/manual');
      const man = new Manual({ engine: eng, store: eng.store, chain: eng.chain, rpc: eng.rpc, log: () => {} });
      await assert.rejects(man.doSwap({ tokenIn: MEME, tokenOut: USDG, amountRaw: 5n }), /sedang dipakai membuka posisi/);
      midSwaps = [...swaps];
      await gate;
      return { txHash: '0xmint', positionId: 9 };
    };
    const entry = eng.executeEntry({ poolRef: '0xpool', token0: USDG, token1: MEME }, {});
    await new Promise((r) => setTimeout(r, 30));
    release();
    await entry;
    assert.deepStrictEqual(midSwaps, [LAIN], 'hanya token lain yang terjual selama entry');
    assert.ok(eng.leftovers().some((x) => x.token === MEME), 'MEME tetap di antrean');

    eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0 })));
    await eng.retryLeftovers();
    assert.deepStrictEqual(swaps, [LAIN, MEME], 'sesudah entry selesai MEME dijual');
    assert.strictEqual(eng.tokenInEntry(MEME), false);
  });

  await t('entry gagal pun melepas penanda token', async () => {
    const { eng } = engineWith();
    eng.entryRetryWaits = [];
    eng.sendEntry = async () => { throw new Error('kas kurang: uji'); };
    await assert.rejects(eng.executeEntry({ poolRef: '0xpool', token0: USDG, token1: MEME }, {}), /kas kurang/);
    assert.strictEqual(eng.tokenInEntry(MEME), false);
    assert.strictEqual(eng.tokenInEntry(USDG), false);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
