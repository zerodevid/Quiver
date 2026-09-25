'use strict';
// Uji: penilaian GMGN yang dipakai perisai indikator di daftar posisi, dan rute
// banyak-token yang memberinya makan.
//  - satu sumber ambang: gmgnSignals() dipakai panel Kesehatan pool DAN perisai,
//    jadi keduanya tidak boleh berbeda pendapat tentang token yang sama;
//  - "belum dinilai" bukan "aman": kolom kosong = abu-abu, bukan hijau;
//  - tanpa API key, rutenya menjawab enabled:false — UI lalu tidak menggambar apa pun.
// Jalankan: node test/gmgn-indikator.js
const assert = require('node:assert');

let lulus = 0, gagal = 0;
async function uji(nama, fn) {
  try { await fn(); lulus++; console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  GAGAL ${nama}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

(async () => {
  console.log('Indikator keamanan GMGN\n');
  const { gmgnSignals, poolHealth } = await import('../web/src/poolHealth.mjs');

  await uji('kontrak bersih dan terisi → hijau', () => {
    const r = gmgnSignals({ security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 0, openSource: true, ownerRenounced: true } });
    assert.strictEqual(r.level, 'ok');
    assert.strictEqual(r.graded, true);
    assert.deepStrictEqual(r.signals, []);
  });

  await uji('kolom keamanan kosong → abu-abu, BUKAN hijau', () => {
    const r = gmgnSignals({ security: { rugPct: null, insiderPct: null } });
    assert.strictEqual(r.level, 'unknown');
    assert.strictEqual(r.graded, false, 'tanpa honeypot/pajak/openSource tidak boleh dianggap dinilai');
    // Token yang GMGN sendiri tidak kenal juga abu-abu, bukan hijau.
    assert.strictEqual(gmgnSignals({}).level, 'unknown');
    assert.strictEqual(gmgnSignals(null).level, 'unknown');
  });

  await uji('honeypot / pajak ≥10% / rug ≥50% → merah', () => {
    assert.strictEqual(gmgnSignals({ security: { honeypot: true } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { sellTaxPct: 12 } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { rugPct: 50 } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { insiderPct: 40 } }).level, 'risk');
  });

  await uji('pajak ≥3% / rug ≥20% / dev jual / kontrak belum diverifikasi → kuning', () => {
    assert.strictEqual(gmgnSignals({ security: { sellTaxPct: 5 } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { rugPct: 20 } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { creatorSold: true } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { openSource: false } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { washTrading: true } }).level, 'warn');
  });

  await uji('perisai dan panel Kesehatan pool memakai ambang yang sama persis', () => {
    const gm = { address: '0xaa', security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 7, openSource: true, rugPct: 33 } };
    const sendiri = gmgnSignals(gm, { skipTop10: true }).signals.map((s) => s.key);
    // holdersOk = true → poolHealth melewatkan top-10 versi GMGN, sama dengan skipTop10.
    const lewatPanel = poolHealth({
      pool: { baseToken: '0xaa', fee: 3000 }, pair: null, gmgn: gm,
      holders: { token: '0xaa', items: [], holderCount: 500, fetchedAt: Date.now(), hasMore: false },
    }).signals.filter((s) => /GMGN/.test(s.key)).map((s) => s.key);
    assert.deepStrictEqual(lewatPanel, sendiri, 'dua tempat, satu daftar sinyal');
  });

  await uji('top-10 versi GMGN hanya dihitung kalau daftar holder kita tidak ada', () => {
    const gm = { security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 0, openSource: true, top10Pct: 70 } };
    assert.strictEqual(gmgnSignals(gm).level, 'risk', 'tanpa daftar holder: dipakai');
    assert.strictEqual(gmgnSignals(gm, { skipTop10: true }).level, 'ok', 'dengan daftar holder: tidak dihitung dua kali');
  });

  // ---- rute /api/gmgn/tokens ----
  const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
  const { Store } = require('../src/db');
  const { createServer } = require('../src/server');
  const buatServer = (apiKey) => {
    const store = new Store(':memory:');
    const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {}, gmgn: { api_key: apiKey } };
    const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-gmgn-')), 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const engine = {
      cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0 }, watcher: { unsupported: new Map() },
      exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [],
      dryRun: () => true, paused: () => false, compound: null,
    };
    const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
    return server;
  };

  await uji('tanpa API key: enabled:false dan nol panggilan ke GMGN', async () => {
    const calls = [];
    globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
    const s = buatServer(null);
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: '0x' + '11'.repeat(20) });
    assert.strictEqual(r.enabled, false);
    assert.deepStrictEqual(r.tokens, {});
    assert.strictEqual(calls.filter((u) => u.includes('gmgn')).length, 0);
  });

  await uji('dengan API key: alamat tak valid disaring, jawaban dipetakan per alamat', async () => {
    const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
    globalThis.fetch = async (u) => {
      const url = new URL(String(u));
      const addr = (url.searchParams.get('address') || '').toLowerCase();
      const body = url.pathname.includes('security')
        ? { code: 0, data: { security: { is_honeypot: addr === B ? 'yes' : 'no', buy_tax: '0', sell_tax: '0', open_source: 'yes' } } }
        : { code: 0, data: { token: { address: addr, symbol: addr === A ? 'AAA' : 'BBB' } } };
      return { ok: true, status: 200, json: async () => body };
    };
    const s = buatServer('kunci-uji');
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: `${A},bukan-alamat,${B},${A}` });
    assert.strictEqual(r.enabled, true);
    assert.deepStrictEqual(Object.keys(r.tokens).sort(), [A, B].sort(), 'hanya alamat valid, tanpa duplikat');
    assert.strictEqual(r.tokens[A].symbol, 'AAA');
    assert.strictEqual(r.tokens[A].security.honeypot, false);
    // Panel "Keamanan token" di laci riwayat memakai GmgnSecurity, yang membaca
    // fetchedAt (umur data) dan links.gmgn — keduanya harus ikut, bukan cuma security.
    assert.ok(Number.isFinite(r.tokens[A].fetchedAt), 'fetchedAt ikut terkirim');
    assert.ok('links' in r.tokens[A], 'links ikut terkirim');
    assert.strictEqual(r.tokens[B].security.honeypot, true);
    // Dan hasilnya memang menilai seperti yang dilihat perisai.
    assert.strictEqual(gmgnSignals(r.tokens[A]).level, 'ok');
    assert.strictEqual(gmgnSignals(r.tokens[B]).level, 'risk');
  });

  await uji('GMGN gagal untuk satu token → token itu bertanda error, sisanya tetap terjawab', async () => {
    const A = '0x' + 'cc'.repeat(20), B = '0x' + 'dd'.repeat(20);
    globalThis.fetch = async (u) => {
      const url = new URL(String(u));
      if ((url.searchParams.get('address') || '').toLowerCase() === B) throw new Error('fetch failed');
      return { ok: true, status: 200, json: async () => (url.pathname.includes('security')
        ? { code: 0, data: { security: { is_honeypot: 'no', buy_tax: '0', sell_tax: '0', open_source: 'yes' } } }
        : { code: 0, data: { token: { address: A, symbol: 'CCC' } } }) };
    };
    const s = buatServer('kunci-uji');
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: `${A},${B}` });
    assert.strictEqual(r.tokens[A].symbol, 'CCC');
    assert.ok(r.tokens[B].error, 'token yang gagal ditandai, bukan menjatuhkan seluruh jawaban');
    assert.strictEqual(gmgnSignals(r.tokens[B]).level, 'unknown');
  });

  console.log(`\n${lulus} lulus, ${gagal} gagal`);
  process.exit(gagal ? 1 : 0);
})();
