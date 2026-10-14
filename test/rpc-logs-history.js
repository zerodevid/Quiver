'use strict';
// logs_history_blocks: an endpoint that only keeps recent logs (publicnode on Ethereum) gets
// getLogs for recent ranges, while older ranges go straight to the endpoints that keep history.
// Run: node test/rpc-logs-history.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function pool(hit) {
  const p = new RpcPool([
    { url: 'https://recent.example', logs_history_blocks: 9000 },
    { url: 'https://archive.example' },
  ], () => {}, { dns_over_https: false, logs_gap_ms: 0 });
  p.resolve = async () => [];
  p.post = async (url, body) => {
    const host = new URL(url).hostname.split('.')[0];
    const req = JSON.parse(body);
    const one = (r) => {
      hit.push(`${host}:${r.method}`);
      return { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getLogs' ? [] : { number: r.params[0] } };
    };
    return Array.isArray(req) ? req.map(one) : one(req);
  };
  p.noteHead(1_000_000);
  return p;
}
const range = (from, to) => ({ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [] });

(async () => {
  console.log('rpc-logs-history:');

  await t('a recent range stays on the first endpoint', async () => {
    const hit = [];
    await pool(hit).getLogs(range(995_000, 999_000));
    assert.deepStrictEqual(hit.filter((h) => h.endsWith('eth_getLogs')), ['recent:eth_getLogs']);
  });

  await t('a range older than logs_history_blocks skips it', async () => {
    const hit = [];
    await pool(hit).getLogs(range(500_000, 505_000));
    assert.deepStrictEqual(hit.filter((h) => h.endsWith('eth_getLogs')), ['archive:eth_getLogs']);
  });

  await t('eth_call is not affected', async () => {
    const hit = [];
    await pool(hit).call('eth_blockNumber');
    assert.deepStrictEqual(hit, ['recent:eth_blockNumber']);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
