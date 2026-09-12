'use strict';
// Uji urutan pemilihan endpoint RPC: urutan daftar = prioritas; yang istirahat turun
// ke belakang; kemampuan (getLogs/arsip) tetap menyaring lebih dulu.
// Jalankan: node test/rpc-prioritas.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const pool = () => new RpcPool([
  { url: 'https://a.example', no_logs: true },
  { url: 'https://b.example', archive: true },
  { url: 'https://c.example', max_log_blocks: 3000 },
], () => {}, { dns_over_https: false });
const hosts = (eps) => eps.map((e) => new URL(e.url).hostname[0]);

t('tanpa gangguan: persis urutan daftar, walau yang bawah lebih senggang/cepat', () => {
  const p = pool();
  p.eps[0].inflight = 5; p.eps[0].lastMs = 900; p.eps[2].lastMs = 10;
  assert.deepStrictEqual(hosts(p.usable()), ['a', 'b', 'c']);
});

t('yang istirahat dilewati; kembali ke atas setelah istirahatnya habis', () => {
  const p = pool();
  p.eps[0].cooldownUntil = Date.now() + 10_000;
  assert.deepStrictEqual(hosts(p.usable()), ['b', 'c']);
  p.eps[0].cooldownUntil = 0;
  assert.deepStrictEqual(hosts(p.usable()), ['a', 'b', 'c']);
});

t('semua istirahat: tetap dicoba, dari yang paling cepat pulih', () => {
  const p = pool();
  const now = Date.now();
  p.eps[0].cooldownUntil = now + 30_000; p.eps[1].cooldownUntil = now + 5_000; p.eps[2].cooldownUntil = now + 10_000;
  assert.deepStrictEqual(hosts(p.usable()), ['b', 'c', 'a']);
});

t('kemampuan menyaring dulu: getLogs lebar melewati no_logs & batas blok; arsip hanya b', () => {
  const p = pool();
  assert.deepStrictEqual(hosts(p.usable(true, 50_000)), ['b']);
  assert.deepStrictEqual(hosts(p.usable(true, 1000)), ['b', 'c']);
  assert.deepStrictEqual(hosts(p.usable(false, 0, true)), ['b']);
});

t('reconfigure dengan urutan baru mengubah prioritas tanpa kehilangan statistik', () => {
  const p = pool();
  p.eps[2].calls = 42;
  p.reconfigure([{ url: 'https://c.example', max_log_blocks: 3000 }, { url: 'https://a.example', no_logs: true }, { url: 'https://b.example', archive: true }]);
  assert.deepStrictEqual(hosts(p.usable()), ['c', 'a', 'b']);
  assert.strictEqual(p.eps[0].calls, 42);
});

console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail ? 1 : 0);
