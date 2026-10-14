'use strict';
// A cached "already approved" answer must not outlive the Permit2 allowance expiry: lp1 kept
// skipping the renewal in a long-lived process and every v4 mint reverted at estimateGas.
// Run: node test/permit2-expiry.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Executor } = require('../src/executor');

const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ADDR = { permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', posmV4: '0x58daec3116aae6d93017baaea7749052e8a04fa7' };
const MAX = (1n << 256n) - 1n;
const MAX160 = (1n << 160n) - 1n;
const coder = ethers.AbiCoder.defaultAbiCoder();

function exec(getExpirySec) {
  const rpc = {
    ethCallMany: async ([c]) => [c.to === ADDR.permit2
      ? coder.encode(['uint160', 'uint48', 'uint48'], [MAX160, getExpirySec(), 0])
      : coder.encode(['uint256'], [MAX])],
  };
  const ex = new Executor({ rpc, store: null, chain: { ADDR }, cfg: {}, log: () => {} });
  ex.address = () => '0xe9c209fd02A1562761c99700fc3D126E64b981ee';
  return ex;
}

(async () => {
  console.log('permit2 expiry:');
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
  };
  const now = () => Math.floor(Date.now() / 1000);

  await t('valid allowance is cached', async () => {
    const ex = exec(() => now() + 30 * 86400);
    assert.deepStrictEqual(await ex.ensureAllowance(TOKEN, { forV4: true }), []);
    assert.ok(ex.isApproved(`${TOKEN}|v4`));
  });

  await t('cached answer lapses once the allowance expiry is near, and a renewal is sent', async () => {
    let expiry = now() + 2 * 86400;
    const ex = exec(() => expiry);
    assert.deepStrictEqual(await ex.ensureAllowance(TOKEN, { forV4: true }), []);
    ex.approved.set(`${TOKEN}|v4`, Date.now() - 1);
    expiry = now() - 100;
    const txs = await ex.ensureAllowance(TOKEN, { forV4: true });
    assert.deepStrictEqual(txs.map((x) => x.kind), ['approve_permit2']);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
