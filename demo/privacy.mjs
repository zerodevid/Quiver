// Lapisan sensor untuk rekaman demo Quiver.
//
// 1. Data: setiap respons /api/* ditulis ulang SEBELUM sampai ke browser —
//    alamat wallet target / wallet riset / wallet bot diganti alamat palsu,
//    label target diganti "Trader A/B/C…", catatan target (notes teks) dikosongkan. Karena yang
//    asli tidak pernah masuk DOM, blur tidak bisa "dibalik" untuk membongkarnya.
// 2. Keamanan: semua request non-GET ke /api diblokir — rekaman tidak bisa
//    menutup posisi, klaim fee, atau menyalakan LIVE di bot produksi.
// 3. Visual: alamat (0x…) dan label samaran diberi blur (lihat CENSOR_CSS).
// 4. Audit: leakCheck() memindai seluruh HTML (teks + atribut) dari halaman
//    untuk alamat/label asli; recorder berhenti kalau ada yang lolos.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = process.env.QBASE || 'http://127.0.0.1:20150';
const TOKEN = process.env.QTOKEN;
if (!TOKEN) throw new Error('QTOKEN kosong');
const AUTH = { authorization: 'Bearer ' + TOKEN };

const api = async (p) => {
  const f = path.resolve('out/cache/mask-' + p.replace(/\W+/g, '_') + '.json');
  if (!process.env.QREFRESH && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + p, { headers: AUTH, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
      const j = await r.json(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); return j;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800)); }
  }
  throw last;
};

const fakeAddr = (real) => '0x' + crypto.createHash('sha256').update('quiver-demo:' + real).digest('hex').slice(0, 40);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function buildMask() {
  const [tg, ws, ov] = await Promise.all([api('/api/targets'), api('/api/wallets'), api('/api/overview')]);
  const targets = tg.targets || [];
  const addrs = new Set();
  const labels = new Map();   // label asli -> samaran
  targets.forEach((t, i) => {
    addrs.add(t.address.toLowerCase());
    if (t.label) labels.set(t.label, 'Trader ' + String.fromCharCode(65 + i));
  });
  let n = targets.length;
  for (const w of ws.wallets || []) {
    addrs.add(w.address.toLowerCase());
    if (w.label && !labels.has(w.label)) labels.set(w.label, 'Wallet ' + String.fromCharCode(65 + n++));
  }
  // wallet bot sendiri juga disamarkan — tidak diminta, tapi murah dan lebih aman
  const own = JSON.stringify(ov.mode || {}).match(/0x[0-9a-fA-F]{40}/g) || [];
  own.forEach((a) => addrs.add(a.toLowerCase()));

  const toFake = new Map([...addrs].map((a) => [a, fakeAddr(a)]));
  const toReal = new Map([...toFake].map(([r, f]) => [f, r]));
  // label pendek (≤3 huruf) terlalu gampang menabrak simbol token; lewati di penggantian
  const labelList = [...labels].filter(([l]) => l.length >= 4).sort((a, b) => b[0].length - a[0].length);
  const labelRe = labelList.length ? new RegExp(labelList.map(([l]) => esc(JSON.stringify(l).slice(1, -1))).join('|'), 'g') : null;

  const addrRe = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
  // bentuk pendek yang mungkin dirakit server di pesan log: 0xabcd…1234 / 0xabcdef...1234
  const shortRe = /0x([0-9a-fA-F]{4,6})(…|\.\.\.|\\u2026)([0-9a-fA-F]{4})(?![0-9a-fA-F])/g;
  const shortMap = new Map();
  for (const [r, f] of toFake) for (const k of [4, 5, 6]) shortMap.set(r.slice(2, 2 + k) + '|' + r.slice(-4), [f.slice(2, 2 + k), f.slice(-4)]);

  const scrub = (text) => {
    let out = text.replace(addrRe, (a) => toFake.get(a.toLowerCase()) ?? a);
    out = out.replace(shortRe, (m, p, sep, s) => {
      const hit = shortMap.get(p.toLowerCase() + '|' + s.toLowerCase());
      return hit ? `0x${hit[0]}${sep}${hit[1]}` : m;
    });
    if (labelRe) {
      const lm = new Map(labelList.map(([l, f]) => [JSON.stringify(l).slice(1, -1), f]));
      out = out.replace(labelRe, (m) => lm.get(m));
    }
    return out;
  };
  const unscrubUrl = (url) => url.replace(addrRe, (a) => toReal.get(a.toLowerCase()) ?? a);

  const secrets = {
    addrs: [...addrs],
    shorts: [...addrs].map((a) => [a.slice(0, 6), a.slice(-4)]),
    labels: [...labels.keys()].filter((l) => l.length >= 4),
  };
  return { scrub, unscrubUrl, secrets, pseudonyms: [...new Set(labels.values())], counts: { addrs: addrs.size, labels: labels.size } };
}

const stripNotes = (v) => {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = k === 'notes' && typeof v[k] === 'string' ? '' : stripNotes(v[k]);   // catatan target (teks); array log di riwayat posisi dibiarkan
  }
  return v;
};

// Cache respons: setiap URL (asli, sebelum disamarkan) disimpan sekali di out/cache,
// rekaman berikutnya dilayani dari disk — kebal jaringan putus dan deterministik.
// QREFRESH=1 mengabaikan cache (ambil ulang semuanya).
const CACHE = path.resolve('out/cache');
fs.mkdirSync(CACHE, { recursive: true });
const cacheKey = (url) => path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');

export async function attach(context, mask, { hold } = {}) {
  await context.setExtraHTTPHeaders(AUTH);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== new URL(BASE).origin) return route.continue();
    if (url.pathname.startsWith('/api/') && req.method() !== 'GET') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"demo read-only"}' });
    }
    if (hold && url.pathname === '/api/overview') await hold();
    const realUrl = mask.unscrubUrl(req.url());
    const key = cacheKey(realUrl);
    let entry = null;
    if (!process.env.QREFRESH && fs.existsSync(key)) entry = JSON.parse(fs.readFileSync(key, 'utf8'));
    if (!entry) {
      let resp, lastErr;
      for (let i = 0; i < 4 && !resp; i++) {
        try { resp = await route.fetch({ url: realUrl, timeout: 25000 }); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800)); }
      }
      if (!resp) {
        // pesan error Playwright memuat header (termasuk token) — jangan dicetak utuh
        console.warn('  fetch gagal:', url.pathname, String(lastErr?.message).split('\n')[0].replace(/Bearer\s+\S+/g, 'Bearer ***'));
        return route.abort().catch(() => {});
      }
      const ct = resp.headers()['content-type'] || '';
      entry = { url: url.pathname + url.search, status: resp.status(), ct, body: (await resp.body()).toString('base64') };
      if (resp.status() === 200) fs.writeFileSync(key, JSON.stringify(entry));
    }
    let body = Buffer.from(entry.body, 'base64');
    if (/json|text|javascript/.test(entry.ct)) {
      let txt = mask.scrub(body.toString('utf8'));
      if (entry.ct.includes('json')) { try { txt = JSON.stringify(stripNotes(JSON.parse(txt))); } catch { /* biarkan */ } }
      body = Buffer.from(txt, 'utf8');
    }
    return route.fulfill({ status: entry.status, headers: { 'content-type': entry.ct, 'cache-control': 'no-store' }, body }).catch(() => {});
  });
}

// Blur untuk alamat & label samaran. Dipasang lewat MutationObserver supaya
// tabel yang dipoll ulang tetap tertutup.
export const censorScript = (pseudonyms) => `(() => {
  const PSEUDO = ${JSON.stringify(pseudonyms)};
  const RE = /0x[0-9a-fA-F]{4,}(…|\\.\\.\\.)?[0-9a-fA-F]{0,}/;
  const css = document.createElement('style');
  css.textContent = '.q-censor{filter:blur(5px);user-select:none;border-radius:4px;background:color-mix(in oklab,currentColor 12%,transparent);}';
  const mark = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const n = walker.currentNode; const s = n.nodeValue;
      if (!s || !s.trim()) continue;
      if (RE.test(s) || PSEUDO.some((p) => s.includes(p))) hits.push(n);
    }
    for (const n of hits) {
      const el = n.parentElement;
      if (!el || el.closest('.q-censor,#q-overlay,script,style')) continue;
      el.classList.add('q-censor');
    }
  };
  const start = () => {
    document.head.appendChild(css);
    mark(document.body);
    new MutationObserver((ms) => { for (const m of ms) for (const x of m.addedNodes) mark(x.nodeType === 3 ? x.parentNode || document.body : x); if (ms.some((m) => m.type === 'characterData')) mark(document.body); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

export async function leakCheck(page, secrets) {
  const html = (await page.evaluate(() => document.documentElement.outerHTML + '\n' + location.href)).toLowerCase();
  const found = [];
  for (const a of secrets.addrs) if (html.includes(a)) found.push('addr ' + a.slice(0, 6) + '…');
  for (const [p, s] of secrets.shorts) if (new RegExp(p + '[0-9a-f]{0,4}(…|\\.\\.\\.|&hellip;)' + s).test(html)) found.push('short ' + p + '…');
  for (const l of secrets.labels) if (html.includes(l.toLowerCase())) found.push('label #' + l.length);
  return found;
}
