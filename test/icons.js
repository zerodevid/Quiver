'use strict';
// Logo token: pengambilan dari GeckoTerminal, validasi berkas, dan cache.
// Jalankan: node test/icons.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { Icons, sniff } = require('../src/icons');

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20), D = '0x' + 'd4'.repeat(20);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(40)]);

function setup(images, { status = 200, ds = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpicons-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.dexscreener.com/')) {
      const addrs = url.split('/').pop().split(',');
      return { ok: true, status: 200, json: async () => addrs.filter((a) => ds[a]).map((a) => ({ baseToken: { address: a }, info: { imageUrl: ds[a] } })) };
    }
    if (url.startsWith('https://api.geckoterminal.com/')) {
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      const addrs = url.split('/').pop().split(',');
      return { ok: true, status: 200, json: async () => ({ data: addrs.filter((a) => a in images).map((a) => ({ attributes: { address: a, image_url: images[a].url } })) }) };
    }
    const hit = Object.values(images).find((x) => x.url === url) || (Object.values(ds).includes(url) ? { body: PNG } : null);
    return { ok: !!hit, status: hit ? 200 : 404, arrayBuffer: async () => hit.body };
  };
  const icons = new Icons({ store, dir: path.join(dir, 'icons'), fetchImpl, gapMs: 0 });
  return { icons, calls, store, dir };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('mengenali png/jpeg/gif/webp dari byte, menolak svg', () => {
  assert.deepStrictEqual(sniff(PNG), ['png', 'image/png']);
  assert.deepStrictEqual(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), ['jpg', 'image/jpeg']);
  assert.deepStrictEqual(sniff(Buffer.from('GIF89a......')), ['gif', 'image/gif']);
  assert.deepStrictEqual(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), ['webp', 'image/webp']);
  assert.strictEqual(sniff(SVG), null);
});

test('mengambil logo, menyimpannya, dan tidak bertanya lagi', async () => {
  const { icons, calls, dir } = setup({ [A]: { url: 'https://x/a.png', body: PNG } });
  const img = await icons.get(A, { wait: 2000 });
  assert.ok(img, 'logo ada');
  assert.strictEqual(img.ctype, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, 'icons', A + '.png')));
  const n = calls.length;
  const again = await icons.get(A, { wait: 2000 });
  assert.ok(again);
  assert.strictEqual(calls.length, n, 'kedua kalinya dari cache');
});

test('token tanpa logo dicatat "none" dan tidak ditanya ulang segera', async () => {
  const { icons, calls } = setup({ [B]: { url: 'https://assets.geckoterminal.com/missing.png', body: PNG } });
  assert.strictEqual(await icons.get(B, { wait: 2000 }), null);
  assert.strictEqual(icons.row(B).status, 'none');
  const n = calls.length;
  assert.strictEqual(await icons.get(B, { wait: 2000 }), null);
  assert.strictEqual(calls.length, n);
});

test('token tanpa logo di GeckoTerminal diambil dari DexScreener', async () => {
  const { icons, calls } = setup({ [D]: { url: 'https://assets.geckoterminal.com/missing.png', body: PNG } },
    { ds: { [D]: 'https://cdn.dexscreener.com/d.png' } });
  const img = await icons.get(D, { wait: 2000 });
  assert.ok(img, 'logo dari cadangan');
  assert.strictEqual(icons.row(D).src, 'https://cdn.dexscreener.com/d.png');
  assert.ok(calls.some((u) => u.startsWith('https://api.dexscreener.com/')));
});

test('SVG dari sumber ditolak walau server asal bilang image/*', async () => {
  const { icons } = setup({ [C]: { url: 'https://x/c.svg', body: SVG } });
  assert.strictEqual(await icons.get(C, { wait: 2000 }), null);
  assert.strictEqual(icons.row(C).status, 'none');
});

test('banyak permintaan sekaligus digabung jadi satu panggilan API', async () => {
  const imgs = {}; for (const a of [A, B, C, D]) imgs[a] = { url: `https://x/${a}.png`, body: PNG };
  const { icons, calls } = setup(imgs);
  const res = await Promise.all([A, B, C, D].map((a) => icons.get(a, { wait: 2000 })));
  assert.ok(res.every(Boolean));
  assert.strictEqual(calls.filter((u) => u.includes('geckoterminal.com/api')).length, 1);
});

test('429 dari GeckoTerminal tidak dicatat sebagai "tidak punya logo"', async () => {
  const { icons } = setup({ [A]: { url: 'https://x/a.png', body: PNG } }, { status: 429 });
  assert.strictEqual(await icons.get(A, { wait: 2000 }), null);
  assert.strictEqual(icons.row(A).status, 'err');
  assert.ok(icons.stale(icons.row(A)) === false, 'dicoba lagi nanti, bukan langsung');
});

test('CDN diminta PNG/JPEG/GIF, bukan WebP — resvg kartu bagikan tidak bisa WebP', async () => {
  const { icons } = setup({ [A]: { url: 'https://x/a.png', body: PNG } });
  const accept = [];
  icons.fetch = (orig => (url, opt) => { if (url === 'https://x/a.png') accept.push(opt.headers.accept); return orig(url, opt); })(icons.fetch);
  await icons.get(A, { wait: 2000 });
  assert.deepStrictEqual(accept, ['image/png,image/jpeg,image/gif']);
});

test('logo WebP lama diambil ulang jadi PNG; kalau gagal, WebP-nya tetap dipakai', async () => {
  const images = { [A]: { url: 'https://x/a', body: WEBP } };
  const { icons, calls, dir } = setup(images);
  let now = 1_000_000;
  icons.now = () => now;
  const first = await icons.get(A, { wait: 2000 });
  assert.strictEqual(first.ctype, 'image/webp', 'WebP tetap disimpan untuk dasbor');
  assert.ok(!icons.stale(icons.row(A)), 'baru diambil, belum perlu dicoba lagi');
  now += 13 * 3600e3;
  assert.ok(icons.stale(icons.row(A)), 'setelah 12 jam dicoba lagi');
  // Sumber gagal: logo lama tidak hilang.
  images[A].url = 'https://x/hilang';
  const n = calls.length;
  const kept = await icons.get(A, { wait: 2000 });
  assert.ok(calls.length > n, 'dicoba lagi');
  assert.strictEqual(kept?.ctype, 'image/webp', 'logo lama tetap dipakai');
  assert.strictEqual(icons.row(A).status, 'ok');
  // Sumber kini mengirim PNG: berkas WebP diganti.
  now += 13 * 3600e3;
  images[A] = { url: 'https://x/a.png', body: PNG };
  const png = await icons.get(A, { wait: 2000 });
  assert.strictEqual(png.ctype, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, 'icons', A + '.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'icons', A + '.webp')), 'berkas WebP lama dihapus');
  assert.ok(!icons.stale(icons.row(A)), 'PNG tidak perlu dicoba lagi');
});

test('429 saat mencoba ulang logo WebP tidak menghapus logo yang ada', async () => {
  const { icons, calls } = setup({ [A]: { url: 'https://x/a', body: WEBP } });
  let now = 1_000_000;
  icons.now = () => now;
  await icons.get(A, { wait: 2000 });
  now += 13 * 3600e3;
  icons.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const n = calls.length;
  const kept = await icons.get(A, { wait: 2000 });
  assert.strictEqual(kept?.ctype, 'image/webp', 'logo lama tetap dipakai');
  assert.strictEqual(icons.row(A).status, 'ok');
  assert.ok(!icons.stale(icons.row(A)), 'tidak langsung dicoba lagi');
  now += 11 * 60e3;
  assert.ok(icons.stale(icons.row(A)), 'dicoba lagi setelah jeda kegagalan (10 menit), bukan 12 jam');
});

test('alamat tidak sah dan ETH native tidak memanggil apa pun', async () => {
  const { icons, calls } = setup({});
  assert.strictEqual(await icons.get('bukan-alamat', { wait: 100 }), null);
  assert.strictEqual(await icons.get('0x' + '0'.repeat(40), { wait: 100 }), null);
  assert.strictEqual(await icons.get("0x' OR 1=1 --", { wait: 100 }), null);
  assert.strictEqual(calls.length, 0);
});

(async () => {
  let ok = 0, bad = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('  ✓', name); }
    catch (e) { bad++; console.log('  ✗', name, '\n     ', e.message); }
  }
  console.log(`\n${ok} lulus, ${bad} gagal`);
  process.exit(bad ? 1 : 0);
})();
