'use strict';
const assert = require('node:assert/strict');
const { createTokenRisk, riskVerdict, memeTokens } = require('../src/tokenrisk');
const { rulesFor, validateRules } = require('../src/policy');

const ZERO = '0x' + '0'.repeat(40);
const TOKEN = '0x97a7e74f19d35e95bc602832652d37c7ca9b2197';
const DEPLOYER = '0xa351c247f57a7e8d7a78611dcdd82650894d4079';
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WHALE = '0xf69cd0fe7280773bb9b7c93ab68420d07290afa9';
const hex = (n) => '0x' + BigInt(n).toString(16);

const chain = {
  alchemyHost: 'alch.test', blockMs: 100, ADDR: { poolManager: PM },
  quoteSideOf: (a) => (a.toLowerCase() === '0xusdg' ? { side: 0 } : null),
};
const cfg = { chain: { endpoints: [{ url: 'https://alch.test/v2/key', headers: {} }, { url: 'https://other.test/rpc', headers: {} }] } };

// A fake Alchemy: the token minted 250M to the deployer, which then moved it all into the pool manager,
// and a whale bought 161M out of the pool. Other tokens minted to the deployer: two more.
function fakeFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const reply = (result) => ({ json: async () => ({ id: body.id, result }) });
    const p = body.params[0];
    if (body.method === 'eth_blockNumber') return reply(hex(94_840_000));
    if (body.method === 'eth_call') return reply(hex(250_000_000n * 10n ** 18n));
    if (body.method === 'eth_getTransactionByHash') return reply({ from: DEPLOYER });
    if (body.method === 'alchemy_getAssetTransfers') {
      if (p.fromAddress === ZERO && p.toAddress === DEPLOYER) {
        return reply({ transfers: ['0xaa', '0xbb', TOKEN].map((a) => ({ rawContract: { address: a } })) });
      }
      if (p.fromAddress === ZERO) return reply({ transfers: [{ to: DEPLOYER, hash: '0xmint', rawContract: { address: TOKEN } }] });
      const amt = (n) => hex(BigInt(n) * 10n ** 18n);
      return reply({ transfers: [
        { from: ZERO, to: DEPLOYER, rawContract: { value: amt(250_000_000) } },
        { from: DEPLOYER, to: PM, rawContract: { value: amt(250_000_000) } },
        { from: PM, to: WHALE, rawContract: { value: amt(161_000_000) } },
      ] });
    }
    throw new Error('unexpected ' + body.method);
  };
}

(async () => {
  // defaults are off, so existing rules keep behaving as before
  const f0 = rulesFor({}, null).filters;
  assert.equal(f0.max_top_holder_pct, 0);
  assert.equal(f0.max_deployer_tokens, 0);
  assert.deepEqual(f0.deployer_blacklist, []);
  assert.equal(validateRules({ filters: { max_top_holder_pct: 120 } }).error?.includes('antara'), true);
  assert.equal(validateRules({ filters: { max_deployer_tokens: 2.5 } }).error?.includes('bulat'), true);
  assert.deepEqual(validateRules({ filters: { deployer_blacklist: 'a, b' } }).rules.filters.deployer_blacklist, ['a', 'b']);

  // meme side of a pool
  assert.deepEqual(memeTokens(chain, { token0: '0xUSDG', token1: TOKEN }), [TOKEN]);
  assert.equal(memeTokens(chain, { token0: TOKEN, token1: WHALE }).length, 2);

  // pure verdicts
  const base = { max_top_holder_pct: 0, max_deployer_tokens: 0, deployer_window_hours: 6, deployer_blacklist: [] };
  assert.equal(riskVerdict(null, { ...base, max_top_holder_pct: 10 }), null);
  assert.match(riskVerdict({ creator: DEPLOYER, mintTo: DEPLOYER }, { ...base, deployer_blacklist: [DEPLOYER.toUpperCase().replace('0X', '0x')] }), /daftar hitam deployer/);
  assert.match(riskVerdict({ creator: DEPLOYER, deployerTokens: 3 }, { ...base, max_deployer_tokens: 3 }), /sudah membuat 3 token dalam 6 jam/);
  assert.equal(riskVerdict({ creator: DEPLOYER, deployerTokens: 2 }, { ...base, max_deployer_tokens: 3 }), null);
  assert.match(riskVerdict({ topHolder: { address: WHALE, pct: 64.6 } }, { ...base, max_top_holder_pct: 30 }), /64\.6% supply/);
  assert.equal(riskVerdict({ topHolder: { address: WHALE, pct: 64.6 } }, base), null);

  // end to end with a fake Alchemy
  const calls = [];
  const risk = createTokenRisk({ chain, cfg, fetchImpl: fakeFetch(calls) });
  assert.equal(risk.enabled, true);
  const f = { ...base, max_top_holder_pct: 30, max_deployer_tokens: 3, deployer_blacklist: [] };
  const info = await risk.inspect(TOKEN, f, null);
  assert.equal(info.creator, DEPLOYER);
  assert.equal(info.deployerTokens, 3);
  // the pool manager is not a holder; the whale holds 161M of 250M
  assert.equal(info.topHolder.address, WHALE);
  assert.equal(Math.round(info.topHolder.pct * 10) / 10, 64.4);
  assert.match(riskVerdict(info, f), /sudah membuat 3 token/);

  // a second inspect is answered from the cache
  const before = calls.length;
  await risk.inspect(TOKEN, f, null);
  assert.equal(calls.length, before);

  // only what is switched on is fetched
  const calls2 = [];
  const lean = createTokenRisk({ chain, cfg, fetchImpl: fakeFetch(calls2) });
  await lean.inspect(TOKEN, { ...base, max_top_holder_pct: 30 }, null);
  assert.equal(calls2.includes('eth_getTransactionByHash'), false);

  // no Alchemy endpoint for the chain, or a failing one: unknown, never an exception
  const none = createTokenRisk({ chain, cfg: { chain: { endpoints: [] } }, fetchImpl: fakeFetch([]) });
  assert.equal(none.enabled, false);
  assert.equal(await none.inspect(TOKEN, f, null), null);
  const broken = createTokenRisk({ chain, cfg, fetchImpl: async () => { throw new Error('boom'); } });
  const bi = await broken.inspect(TOKEN, f, null);
  assert.equal(riskVerdict(bi, f), null);
  console.log('token-risk ok');
})().catch((e) => { console.error(e); process.exit(1); });
