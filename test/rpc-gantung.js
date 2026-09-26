'use strict';
// Uji: satu permintaan HTTP tidak boleh bisa menggantung selamanya.
// `timeout` bawaan https cuma mengukur DIAM-nya socket dan baru terpasang setelah
// permintaan dapat giliran socket dari agent; socket yang mati tanpa memancarkan
// 'error' maupun 'timeout' membuat Promise-nya tidak pernah selesai — dan satu saja
// yang begitu di jalur tick membekukan pemindaian selamanya (lpcopy3, 2026-09-25).
// Jalankan: node test/rpc-gantung.js
const assert = require('node:assert');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// Permintaan palsu: tidak pernah menjawab, dan hanya memancarkan apa yang disuruh.
function fakeRequest({ onDestroy = null, emitOnEnd = null } = {}) {
  const req = new EventEmitter();
  req.end = () => { if (emitOnEnd) setTimeout(() => req.emit(emitOnEnd.event, emitOnEnd.arg), 1); };
  req.destroy = (e) => { if (onDestroy) onDestroy(e); };
  return req;
}

(async () => {
  console.log('Permintaan RPC menggantung:\n');
  const asli = https.request;

  await t('tidak ada balasan sama sekali: ditolak oleh batas keras, bukan menggantung', async () => {
    let dibunuh = false;
    https.request = () => fakeRequest({ onDestroy: () => { dibunuh = true; } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30 });
      const t0 = Date.now();
      await assert.rejects(p.post('https://a.example', '{}', 20, null), /batas keras/);
      assert.ok(Date.now() - t0 < 1000, 'ditolak cepat, tidak menunggu selamanya');
      assert.ok(dibunuh, 'socketnya ikut dibereskan supaya tidak bocor');
    } finally { https.request = asli; }
  });

  await t('socket tertutup tanpa balasan: ditolak, bukan menggantung', async () => {
    https.request = () => fakeRequest({ emitOnEnd: { event: 'close' } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 60_000 });
      await assert.rejects(p.post('https://a.example', '{}', 60_000, null), /tertutup tanpa balasan/);
    } finally { https.request = asli; }
  });

  await t('batas keras tidak menimpa galat yang sudah muncul lebih dulu', async () => {
    https.request = () => fakeRequest({ emitOnEnd: { event: 'error', arg: new Error('connect ECONNREFUSED') } });
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30 });
      await assert.rejects(p.post('https://a.example', '{}', 20, null), /ECONNREFUSED/);
    } finally { https.request = asli; }
  });

  await t('permintaan yang menggantung tetap melepas jatah inflight', async () => {
    https.request = () => fakeRequest();
    try {
      const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false, hard_margin_ms: 30, max_inflight: 2 });
      await assert.rejects(p.batch([{ method: 'eth_blockNumber' }]), /tumbang/);
      assert.strictEqual(p.inflight, 0);
      assert.strictEqual(p.eps[0].inflight, 0);
    } finally { https.request = asli; }
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
