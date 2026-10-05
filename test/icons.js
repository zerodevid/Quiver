'use strict';
// Token logos: fetching from GeckoTerminal, file validation, and cache.
// Run: node test/icons.js
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

test('recognises png/jpeg/gif/webp from bytes, rejects svg', () => {
  assert.deepStrictEqual(sniff(PNG), ['png', 'image/png']);
  assert.deepStrictEqual(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), ['jpg', 'image/jpeg']);
  assert.deepStrictEqual(sniff(Buffer.from('GIF89a......')), ['gif', 'image/gif']);
  assert.deepStrictEqual(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), ['webp', 'image/webp']);
  assert.strictEqual(sniff(SVG), null);
});

test('fetches the logo, stores it, and does not ask again', async () => {
  const { icons, calls, dir } = setup({ [A]: { url: 'https://x/a.png', body: PNG } });
  const img = await icons.get(A, { wait: 2000 });
  assert.ok(img, 'logo exists');
  assert.strictEqual(img.ctype, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, 'icons', A + '.png')));
  const n = calls.length;
  const again = await icons.get(A, { wait: 2000 });
  assert.ok(again);
  assert.strictEqual(calls.length, n, 'the second time from the cache');
});

test('a token without a logo is recorded "none" and not asked again right away', async () => {
  const { icons, calls } = setup({ [B]: { url: 'https://assets.geckoterminal.com/missing.png', body: PNG } });
  assert.strictEqual(await icons.get(B, { wait: 2000 }), null);
  assert.strictEqual(icons.row(B).status, 'none');
  const n = calls.length;
  assert.strictEqual(await icons.get(B, { wait: 2000 }), null);
  assert.strictEqual(calls.length, n);
});

test('a token without a logo on GeckoTerminal is taken from DexScreener', async () => {
  const { icons, calls } = setup({ [D]: { url: 'https://assets.geckoterminal.com/missing.png', body: PNG } },
    { ds: { [D]: 'https://cdn.dexscreener.com/d.png' } });
  const img = await icons.get(D, { wait: 2000 });
  assert.ok(img, 'logo from the fallback');
  assert.strictEqual(icons.row(D).src, 'https://cdn.dexscreener.com/d.png');
  assert.ok(calls.some((u) => u.startsWith('https://api.dexscreener.com/')));
});

test('SVG from the source is rejected even though the origin server says image/*', async () => {
  const { icons } = setup({ [C]: { url: 'https://x/c.svg', body: SVG } });
  assert.strictEqual(await icons.get(C, { wait: 2000 }), null);
  assert.strictEqual(icons.row(C).status, 'none');
});

test('many requests at once are merged into a single API call', async () => {
  const imgs = {}; for (const a of [A, B, C, D]) imgs[a] = { url: `https://x/${a}.png`, body: PNG };
  const { icons, calls } = setup(imgs);
  const res = await Promise.all([A, B, C, D].map((a) => icons.get(a, { wait: 2000 })));
  assert.ok(res.every(Boolean));
  assert.strictEqual(calls.filter((u) => u.includes('geckoterminal.com/api')).length, 1);
});

test('429 from GeckoTerminal is not recorded as "has no logo"', async () => {
  const { icons } = setup({ [A]: { url: 'https://x/a.png', body: PNG } }, { status: 429 });
  assert.strictEqual(await icons.get(A, { wait: 2000 }), null);
  assert.strictEqual(icons.row(A).status, 'err');
  assert.ok(icons.stale(icons.row(A)) === false, 'retried later, not immediately');
});

test('the CDN is asked for PNG/JPEG/GIF, not WebP — the share-card resvg cannot do WebP', async () => {
  const { icons } = setup({ [A]: { url: 'https://x/a.png', body: PNG } });
  const accept = [];
  icons.fetch = (orig => (url, opt) => { if (url === 'https://x/a.png') accept.push(opt.headers.accept); return orig(url, opt); })(icons.fetch);
  await icons.get(A, { wait: 2000 });
  assert.deepStrictEqual(accept, ['image/png,image/jpeg,image/gif']);
});

test('an old WebP logo is refetched as PNG; if that fails, the WebP is still used', async () => {
  const images = { [A]: { url: 'https://x/a', body: WEBP } };
  const { icons, calls, dir } = setup(images);
  let now = 1_000_000;
  icons.now = () => now;
  const first = await icons.get(A, { wait: 2000 });
  assert.strictEqual(first.ctype, 'image/webp', 'WebP is still stored for the dashboard');
  assert.ok(!icons.stale(icons.row(A)), 'just fetched, need not be retried yet');
  now += 13 * 3600e3;
  assert.ok(icons.stale(icons.row(A)), 'retried after 12 hours');
  // Source fails: the old logo is not lost.
  images[A].url = 'https://x/hilang';
  const n = calls.length;
  const kept = await icons.get(A, { wait: 2000 });
  assert.ok(calls.length > n, 'retried');
  assert.strictEqual(kept?.ctype, 'image/webp', 'the old logo is still used');
  assert.strictEqual(icons.row(A).status, 'ok');
  // Source now serves PNG: the WebP file is replaced.
  now += 13 * 3600e3;
  images[A] = { url: 'https://x/a.png', body: PNG };
  const png = await icons.get(A, { wait: 2000 });
  assert.strictEqual(png.ctype, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, 'icons', A + '.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'icons', A + '.webp')), 'the old WebP file is deleted');
  assert.ok(!icons.stale(icons.row(A)), 'PNG need not be retried');
});

test('429 while retrying a WebP logo does not delete the existing logo', async () => {
  const { icons, calls } = setup({ [A]: { url: 'https://x/a', body: WEBP } });
  let now = 1_000_000;
  icons.now = () => now;
  await icons.get(A, { wait: 2000 });
  now += 13 * 3600e3;
  icons.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const n = calls.length;
  const kept = await icons.get(A, { wait: 2000 });
  assert.strictEqual(kept?.ctype, 'image/webp', 'the old logo is still used');
  assert.strictEqual(icons.row(A).status, 'ok');
  assert.ok(!icons.stale(icons.row(A)), 'not retried immediately');
  now += 11 * 60e3;
  assert.ok(icons.stale(icons.row(A)), 'retried after the failure pause (10 minutes), not 12 hours');
});

test('an invalid address and native ETH call nothing', async () => {
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
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
