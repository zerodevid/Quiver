'use strict';
// Test: the English version of the Telegram bot must have no gaps.
//
// Dictionary keys ARE the Indonesian source text, so a key that has not been
// translated never blows up — it just passes through to the screen as-is, and
// an English-speaking user suddenly reads "Cadangan ETH" in the middle of a table.
// A leak like that once lived for months with nobody noticing;
// this test is what notices it now.
//
// Run: node test/language.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../src/locales/telegram.en.json');

const SOURCE = ['telegram.js', 'chart-card.js', 'portfolio-card.js', 'share-card.js']
  .map((f) => path.join(__dirname, '..', 'src', f));
const content = SOURCE.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const unesc = (s, q) => s.replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
const literals = (re, group = 1, quote = "'") => {
  const out = new Set();
  for (const m of content.matchAll(re)) out.add(unesc(m[group], quote));
  return out;
};

// 1) tr('...') / tr("...")
const fromTr = new Set([
  ...literals(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g, 1, "'"),
  ...literals(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g, 1, '"'),
]);
// 2) rules schema labels & help — all go through localizeSchema()
const fromSchema = new Set([
  ...literals(/F\.\w+\(\s*'[^']+'\s*,\s*'((?:[^'\\]|\\.)*)'/g),
  ...literals(/\b(?:help|hint|title)\s*:\s*'((?:[^'\\]|\\.)*)'/g),
]);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.message).split('\n').slice(0, 6).join('\n        ')); fail++; } };

// Text that is genuinely the same in both languages (product names, units, symbols).
const SAME = /^(GMGN|HONEYPOT|ntfy|RPC|Tx|PnL|LP|ETH|USDG|WETH|v4, v3|⛽ Gas|Priority fee \(gwei\)|Gas|Status|Swap)$/;

console.log('Telegram bot language completeness:\n');

t('every text passing through tr() has an English translation', () => {
  const short = [...fromTr].filter((k) => en[k] == null && !SAME.test(k));
  assert.deepStrictEqual(short, [], `not yet translated:\n  - ${short.map((k) => JSON.stringify(k.slice(0, 80))).join('\n  - ')}`);
});

t('rule labels and help texts have English translations', () => {
  const short = [...fromSchema].filter((k) => en[k] == null && !SAME.test(k));
  assert.deepStrictEqual(short, [], `not yet translated:\n  - ${short.map((k) => JSON.stringify(k.slice(0, 80))).join('\n  - ')}`);
});

t('English plural forms are written out in full: "#n|" optional, then singular|plural', () => {
  for (const [k, v] of Object.entries(en)) {
    if (!v.includes('|')) continue;
    const m = /^#(\d+)\|/.exec(v);
    const badan = m ? v.slice(m[0].length) : v;
    assert.strictEqual(badan.split('|').length, 2, `dua bentuk saja: ${JSON.stringify(k)}`);
    const slot = m ? Number(m[1]) : 0;
    assert.ok(k.includes(`{${slot}}`), `counter {${slot}} is missing from key ${JSON.stringify(k)}`);
    for (const shape of badan.split('|')) {
      assert.ok(shape.includes(`{${slot}}`), `bentuk tanpa pencacah: ${JSON.stringify(shape.slice(0, 60))}`);
    }
  }
});

t('no Indonesian words are left in the English-language values', () => {
  // Words that cannot appear in a correct English sentence. Deliberately
  // short: what is sought is raw leaks, not style.
  const ID = /\b(yang|dengan|tidak|belum|sudah|untuk|dari|akan|bisa|dipakai|posisi|saldo|aturan|kirim|pilih|nilai|modal|harga|jumlah|cadangan|rata-rata)\b/i;
  const bocor = Object.entries(en).filter(([, v]) => ID.test(String(v).replace(/<[^>]+>/g, ' ')));
  assert.deepStrictEqual(bocor.map(([k]) => k), [], `English values that are still Indonesian:\n  - ${bocor.map(([k, v]) => `${JSON.stringify(k.slice(0, 40))} → ${JSON.stringify(String(v).slice(0, 60))}`).join('\n  - ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
