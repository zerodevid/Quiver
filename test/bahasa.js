'use strict';
// Uji: bahasa Inggris bot Telegram tidak boleh bolong.
//
// Kunci kamus ADALAH teks sumber berbahasa Indonesia, jadi kunci yang belum
// diterjemahkan tidak pernah meledak — ia cuma lolos apa adanya ke layar, dan
// pemakai berbahasa Inggris tiba-tiba membaca "Cadangan ETH" di tengah tabel.
// Kebocoran seperti itu pernah hidup berbulan-bulan tanpa ada yang menyadari;
// tes ini yang menyadarinya sekarang.
//
// Jalankan: node test/bahasa.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../src/locales/telegram.en.json');

const SUMBER = ['telegram.js', 'chart-card.js', 'portfolio-card.js', 'share-card.js']
  .map((f) => path.join(__dirname, '..', 'src', f));
const isi = SUMBER.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const unesc = (s, q) => s.replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
const literals = (re, group = 1, quote = "'") => {
  const out = new Set();
  for (const m of isi.matchAll(re)) out.add(unesc(m[group], quote));
  return out;
};

// 1) tr('...') / tr("...")
const dariTr = new Set([
  ...literals(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g, 1, "'"),
  ...literals(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g, 1, '"'),
]);
// 2) label & bantuan skema aturan — semuanya lewat localizeSchema()
const dariSkema = new Set([
  ...literals(/F\.\w+\(\s*'[^']+'\s*,\s*'((?:[^'\\]|\\.)*)'/g),
  ...literals(/\b(?:help|hint|title)\s*:\s*'((?:[^'\\]|\\.)*)'/g),
]);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.message).split('\n').slice(0, 6).join('\n        ')); fail++; } };

// Teks yang memang sama di kedua bahasa (nama produk, satuan, simbol).
const SAMA = /^(GMGN|HONEYPOT|ntfy|RPC|Tx|PnL|LP|ETH|USDG|WETH|v4, v3|⛽ Gas|Priority fee \(gwei\)|Gas|Status|Swap)$/;

console.log('Kelengkapan bahasa bot Telegram:\n');

t('setiap teks yang lewat tr() punya terjemahan Inggris', () => {
  const kurang = [...dariTr].filter((k) => en[k] == null && !SAMA.test(k));
  assert.deepStrictEqual(kurang, [], `belum diterjemahkan:\n  - ${kurang.map((k) => JSON.stringify(k.slice(0, 80))).join('\n  - ')}`);
});

t('label dan teks bantuan aturan punya terjemahan Inggris', () => {
  const kurang = [...dariSkema].filter((k) => en[k] == null && !SAMA.test(k));
  assert.deepStrictEqual(kurang, [], `belum diterjemahkan:\n  - ${kurang.map((k) => JSON.stringify(k.slice(0, 80))).join('\n  - ')}`);
});

t('bentuk jamak Inggris ditulis lengkap: "#n|" opsional, lalu tunggal|jamak', () => {
  for (const [k, v] of Object.entries(en)) {
    if (!v.includes('|')) continue;
    const m = /^#(\d+)\|/.exec(v);
    const badan = m ? v.slice(m[0].length) : v;
    assert.strictEqual(badan.split('|').length, 2, `dua bentuk saja: ${JSON.stringify(k)}`);
    const slot = m ? Number(m[1]) : 0;
    assert.ok(k.includes(`{${slot}}`), `pencacah {${slot}} tidak ada di kunci ${JSON.stringify(k)}`);
    for (const bentuk of badan.split('|')) {
      assert.ok(bentuk.includes(`{${slot}}`), `bentuk tanpa pencacah: ${JSON.stringify(bentuk.slice(0, 60))}`);
    }
  }
});

t('tidak ada kata Indonesia yang tertinggal di nilai bahasa Inggris', () => {
  // Kata-kata yang tidak mungkin muncul dalam kalimat Inggris yang benar. Sengaja
  // pendek: yang dicari kebocoran mentah, bukan gaya bahasa.
  const ID = /\b(yang|dengan|tidak|belum|sudah|untuk|dari|akan|bisa|dipakai|posisi|saldo|aturan|kirim|pilih|nilai|modal|harga|jumlah|cadangan|rata-rata)\b/i;
  const bocor = Object.entries(en).filter(([, v]) => ID.test(String(v).replace(/<[^>]+>/g, ' ')));
  assert.deepStrictEqual(bocor.map(([k]) => k), [], `nilai Inggris masih berbahasa Indonesia:\n  - ${bocor.map(([k, v]) => `${JSON.stringify(k.slice(0, 40))} → ${JSON.stringify(String(v).slice(0, 60))}`).join('\n  - ')}`);
});

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
