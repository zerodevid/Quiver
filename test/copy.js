'use strict';
const assert = require('node:assert/strict');
const { formatNote } = require('../src/message-copy.mjs');
const { localeContext, tr } = require('../src/telegram-i18n');
const en = require('../src/locales/telegram.en.json');
const id = require('../src/locales/telegram.id.json');
const cases = [
 ['LP ditutup: tutup penuh posisi #9', 'Position closed: Fully closed position #9'],
 ['target menutup posisi — tutup penuh posisi #9', 'The target closed its position — Fully closed position #9'],
 ['jual sisa #9: 6.882e+5 DRIPPYPIGEON belum terjual: rute Kyber rugi 60.8% (batas 15.0%) — $229.44 → $90.01',
  'Leftover sale for position #9: 6.882e+5 DRIPPYPIGEON remains unsold: Kyber route loss is 60.8% (limit 15.0%) — $229.44 → $90.01'],
 ['dipotong oleh batas per posisi ($200.00) — USDG/DRIPPYPIGEON $200.00',
  'Position size capped by the per-position limit ($200.00) — USDG/DRIPPYPIGEON $200.00'],
 ['posisi #9: sisa terjual, hasil USDG 156.89 menggantikan taksiran tutup 90.01',
  'Position #9: leftover sale proceeds of USDG 156.89 replace the closing estimate of 90.01'],
 ['mode simulasi: tidak mengirim transaksi', 'Simulation mode is enabled. No transaction was submitted.'],
 ['RPC 429: rate limit (0xabcdef123)', 'RPC 429: rate limit (0xabcdef123)'],
];
for (const [source, expected] of cases) assert.equal(formatNote(source, 'en'), expected);
assert.equal(formatNote('LP ditutup: tutup penuh posisi #9', 'id'), 'Posisi ditutup: Menutup seluruh posisi #9');
assert.equal(formatNote(null, 'en'), null);
for (const catalog of [en, id]) for (const [key,value] of Object.entries(catalog)) {
 const slots = s => [...new Set(s.match(/\{\d+\}/g) || [])].sort();
 assert.deepEqual(slots(key), slots(value), `Translation must preserve all values: ${key}`);
}
localeContext.run('en', () => {
 assert.equal(tr('✅ Posisi #{0} ditutup.{1}{2}\nTx: <code>{3}</code>', [9, '', '', '0x123']),
 '✅ Position #9 closed.\nTransaction: <code>0x123</code>');
});
console.log(`${cases.length + 4} pemeriksaan copy lulus; ${Object.keys(en).length} terjemahan Inggris tervalidasi`);
