'use strict';
// Uji: calldata dari API Kyber dibaca dan dicocokkan sebelum dikirim — penerima hasil,
// token, jumlah bayar, dan minimum terima. Angka di badan JSON API bisa berkata apa saja;
// yang dieksekusi chain adalah calldata-nya.
// Jalankan: node test/kyber-calldata.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Kyber, KYBER_NATIVE } = require('../src/kyber');
const { ADDR } = require('../src/chain');

const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const LAIN = '0x' + '99'.repeat(20);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const DESC = 'tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit)';
const IF = new ethers.Interface([
  `function swap(tuple(address callTarget,address approveTarget,bytes targetData,${DESC} desc,bytes clientData) execution)`,
  `function swapSimpleMode(address caller,${DESC} desc,bytes executorData,bytes clientData)`,
]);
const desc = (o) => [o.src, o.dst, [], [], [], [], o.to, o.amount, o.min, 0, '0x'];
const dataSwap = (o) => IF.encodeFunctionData('swap', [[LAIN, LAIN, '0x', desc(o), '0x']]);
const dataSimple = (o) => IF.encodeFunctionData('swapSimpleMode', [LAIN, desc(o), '0x', '0x']);

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); } }

function kyberWith(data, { amountIn = 100n, amountOut = 1000n } = {}) {
  const sent = [];
  const exec = {
    address: () => ME,
    send: async (tx, meta) => { sent.push(tx); return '0x' + '1'.repeat(64); },
    waitReceipt: async () => ({ ok: true, receipt: { logs: [] } }),
    balances: async () => new Map([[MEME, 0n], [ADDR.usdg, 0n]]),
  };
  const k = new Kyber({ exec, rpc: { ethCallMany: async () => ['0x' + (10n ** 30n).toString(16).padStart(64, '0')] }, cfg: {}, log: () => {} });
  k.quote = async () => ({ routeSummary: {}, routerAddress: k.router(), amountOut, usdIn: 1, usdOut: 1, dex: 'uji' });
  k.build = async () => ({ routerAddress: k.router(), transactionValue: '0', amountIn: String(amountIn), amountOut: String(amountOut), data });
  return { k, sent };
}
const good = { src: ADDR.usdg, dst: MEME, to: ME, amount: 100n, min: 980n };

(async () => {
  console.log('calldata Kyber:\n');

  await t('calldata wajar (swap & swapSimpleMode) lolos dan dikirim', async () => {
    for (const mk of [dataSwap, dataSimple]) {
      const { k, sent } = kyberWith(mk(good));
      const r = await k.swap(ADDR.usdg, MEME, 100n, { slippageBps: 100 });
      assert.ok(r?.hash); assert.strictEqual(sent.length, 1);
    }
  });

  await t('penerima hasil bukan wallet kita → ditolak, tidak dikirim', async () => {
    const { k, sent } = kyberWith(dataSwap({ ...good, to: LAIN }));
    await assert.rejects(k.swap(ADDR.usdg, MEME, 100n, { slippageBps: 100 }), /penerima .* bukan wallet kita/);
    assert.strictEqual(sent.length, 0);
  });

  await t('token tujuan / jumlah bayar / minReturn kosong → ditolak walau JSON API bilang benar', async () => {
    for (const [bad, re] of [
      [{ ...good, dst: LAIN }, /token/], [{ ...good, amount: 101n }, /jumlah bayar/], [{ ...good, min: 0n }, /minimum terima/], [{ ...good, min: 900n }, /minimum terima/],
    ]) {
      const { k, sent } = kyberWith(dataSwap(bad));
      await assert.rejects(k.swap(ADDR.usdg, MEME, 100n, { slippageBps: 100 }), re);
      assert.strictEqual(sent.length, 0);
    }
  });

  await t('ETH native dicocokkan dengan sentinel Kyber; selector asing tidak pernah dikirim', async () => {
    const { k, sent } = kyberWith(dataSwap({ ...good, src: KYBER_NATIVE, dst: ADDR.usdg }));
    k.build = async () => ({ routerAddress: k.router(), transactionValue: '100', amountIn: '100', amountOut: '1000', data: dataSwap({ ...good, src: KYBER_NATIVE, dst: ADDR.usdg }) });
    assert.ok(await k.swap(ADDR.native, ADDR.usdg, 100n, { slippageBps: 100 }));
    const { k: k2, sent: s2 } = kyberWith('0xdeadbeef' + '00'.repeat(64));
    await assert.rejects(k2.swap(ADDR.usdg, MEME, 100n, { slippageBps: 100 }), /tidak dikenali/);
    assert.strictEqual(s2.length, 0);
    assert.strictEqual(sent.length, 1);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
