'use strict';
// Test: a single HTTP request must not be able to hang forever.
// https' built-in `timeout` only measures socket IDLENESS and is only installed after the
// request gets its turn for a socket from the agent; a socket that dies without emitting
// 'error' or 'timeout' leaves the Promise never settled — and just one
// such request on the tick path freezes the scan forever (lpcopy3, 2026-09-25).
// Run: node test/rpc-hung.js
const assert = require('node:assert');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// Fake request: never answers, and only emits what it is told to.
function fakeRequest({ onDestroy = null, emitOnEnd = null } = {}) {
  const req = new EventEmitter();
  req.end = () => { if (emitOnEnd) setTimeout(() => req.emit(emitOnEnd.event, emitOnEnd.arg), 1); };
  req.destroy = (e) => { if (onDestroy) onDestroy(e); };
  return req;
}

(async () => {
  console.log('Permintaan RPC menggantung:\n');
  const original = https.request;

  await t('no reply at all: rejected by the hard limit, not hanging', async () => {
    let dibunuh = false;
    https.request = () => fakeRequest({ onDestroy: () => { dibunuh = true; } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30 });
      const t0 = Date.now();
      await assert.rejects(p.post('https://a.example', '{}', 20, null), /batas keras/);
      assert.ok(Date.now() - t0 < 1000, 'rejected quickly, not waiting forever');
      assert.ok(dibunuh, 'its socket is also cleaned up so it does not leak');
    } finally { https.request = original; }
  });

  await t('socket closed without a reply: rejected, not hanging', async () => {
    https.request = () => fakeRequest({ emitOnEnd: { event: 'close' } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 60_000 });
      await assert.rejects(p.post('https://a.example', '{}', 60_000, null), /tertutup tanpa balasan/);
    } finally { https.request = original; }
  });

  await t('the hard limit does not overwrite an error that appeared earlier', async () => {
    https.request = () => fakeRequest({ emitOnEnd: { event: 'error', arg: new Error('connect ECONNREFUSED') } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30 });
      await assert.rejects(p.post('https://a.example', '{}', 20, null), /ECONNREFUSED/);
    } finally { https.request = original; }
  });

  await t('a hanging request still releases its inflight quota', async () => {
    https.request = () => fakeRequest();
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30, max_inflight: 2 });
      await assert.rejects(p.batch([{ method: 'eth_blockNumber' }]), /tumbang/);
      assert.strictEqual(p.inflight, 0);
      assert.strictEqual(p.eps[0].inflight, 0);
    } finally { https.request = original; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
