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

// Penyamaran angka: semua nilai uang & jumlah token dikalikan faktor rahasia (QSCALE,
// default diturunkan dari token akses) — saldo, PnL, fee, grafik tetap konsisten satu
// sama lain dan persennya tidak berubah, tapi bukan angka aslinya. Harga, tick, sqrt,
// dan harga ETH tidak disentuh (itu data publik pool, bukan data wallet).
const SCALE = Number(process.env.QSCALE) || (0.45 + (parseInt(crypto.createHash('sha256').update('scale:' + TOKEN).digest('hex').slice(0, 4), 16) % 40) / 100);
// Kunci uang tanpa akhiran usd/quote, dibatasi konteks induknya (diinventarisasi dari
// respons API: series/baseline/extremes/now/wallet/byTarget/stats/cash/deposits).
const MONEY_SUFFIX = /(Usd|_usd|_quote|Quote)$/;
const PRICE_KEY = /^(eth|bnb|native)Usd$|^liquidityUsd$/;          // harga & data pool: publik, jangan diubah
const CTX = {
  series: /^(cash|pos|fee|total|pnl|net)$/, baseline: /^(cash|pos|fee|total|pnl|net)$/,
  now: /^(pnl|net|netPnl|value|capital|capitalNet)$/, wallet: /^(pnl|net|netPnl|value)$/,
  byTarget: /^(value|upnl|realized|realised)$/, summary: /^(value|upnl|realized|realised)$/,
  pnl: /^(hi|lo|dd)$/, net: /^(hi|lo|dd)$/, value: /^(hi|lo|dd)$/,
  stats: /^(best|worst|avgPnl)$/, cash: /^(usd|usdg|usdt|stable|native|eth|weth|bnb|wbnb)$/,
  deposits: /^amount$/, withdrawals: /^amount$/,
};
// jumlah token mentah (string BigInt): amount0/1, cost0/1, fee0/1, out0/1, liquidity, sisa token
const RAW_KEY = /^(amount|cost|fee|out|liquidity)[01]?$|^(left_amount|amountIn|amountOut)$/;
const scaleRaw = (v) => { try { return (BigInt(String(v)) * BigInt(Math.round(SCALE * 1e6)) / 1000000n).toString(); } catch { return v; } };
const fakeIds = new Map();
const fakeId = (id) => { const k = String(id); if (!fakeIds.has(k)) fakeIds.set(k, 1000000 + parseInt(crypto.createHash('sha256').update('id:' + k).digest('hex').slice(0, 8), 16) % 8999999); return fakeIds.get(k); };
const disguise = (v, key = '', parentKey = '') => {
  if (Array.isArray(v)) {
    // portfolio.closed = [[ts, pnl], …]
    if (parentKey === 'closed' && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[0] > 1e12) return [v[0], v[1] * SCALE];
    return v.map((x) => disguise(x, key, key));   // elemen array mewarisi kunci array-nya sebagai konteks
  }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = disguise(v[k], k, key || parentKey); return v; }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (/^(token_id|mirror_of)$/.test(key)) return fakeId(v);
    if (PRICE_KEY.test(key)) return v;
    if (MONEY_SUFFIX.test(key)) return v * SCALE;
    if (CTX[parentKey] && CTX[parentKey].test(key)) return v * SCALE;
    return v;
  }
  if (typeof v === 'string') {
    if (/^(token_id|mirror_of)$/.test(key) && /^\d+$/.test(v)) return String(fakeId(v));
    if (RAW_KEY.test(key) && /^\d{4,}$/.test(v)) return scaleRaw(v);
    if (fakeIds.size && /#\d{5,}/.test(v)) return v.replace(/#(\d{5,})(?!\d)/g, (m, id) => (fakeIds.has(id) ? '#' + fakeIds.get(id) : m));
    return v;
  }
  return v;
};
export const secretIds = () => [...fakeIds.keys()];

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
      if (entry.ct.includes('json')) { try { txt = JSON.stringify(disguise(stripNotes(JSON.parse(txt)))); } catch (e) { console.warn('  penyamaran gagal:', url.pathname, e.message); } }
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
  // ── Sensor modal: angka uang yang menyingkap besar dana (bukan PnL/fee/persen) ──
  // 1) potongan teks "capital $X", "cash $X", "in positions $X", "value $X"
  // 2) nilai uang/angka yang labelnya (baris KV, kartu Stat) berbau modal/kas/nilai/saldo
  // 3) sel tabel di kolom "Value"/"Nilai"
  const MONEY = /[−-]?\\$\\s?[\\d.,]+k?/g;
  const FRAG = /\\b(capital|modal|cash|kas|in positions|di posisi|proceeds|hasil|value|nilai|balance|saldo|lp|deposits?|setoran|withdrawals?|penarikan|idle in cash|menganggur di kas)\\s*[−-]?\\$\\s?[\\d.,]+k?|[−-]?\\$\\s?[\\d.,]+k?\\s+(now|sekarang)\\b|\\b(positions?|posisi)\\s*·\\s*[−-]?\\$\\s?[\\d.,]+k?/gi;
  const LABEL = /^(total portfolio|total portofolio|capital|modal|net capital|modal bersih|capital in positions|modal di posisi|liquidity value|nilai likuiditas|proceeds|hasil|value|nilai|holdings now|saldo|balance|cash|kas|in positions|di posisi|idle in cash|menganggur di kas|capital deposited|modal disetor|usdg|usdt|weth|eth|bnb|wbnb|lp positions|posisi lp|live positions|posisi terbuka|room left|sisa ruang|their balance|saldo mereka|deposits|setoran|withdrawals|penarikan|equity|ekuitas|wallet value|nilai wallet)/i;
  const NOT = /pnl|fee|win|realis|gas|price|harga|rate|drawdown|high|puncak|\\bvs\\b/i;
  // Veil: kotak blur di atas potongan teks (koordinat Range), tanpa memecah text node
  // milik React — memecahnya membuat React gagal saat re-render tabel yang dipoll.
  const veils = new Map();   // text node -> [ [start,end], ... ]
  let veilBox;
  const veilLayer = () => {
    if (!veilBox) { veilBox = document.createElement('div'); veilBox.id = 'q-veils'; veilBox.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645'; document.documentElement.appendChild(veilBox); }
    return veilBox;
  };
  const drawVeils = () => {
    const layer = veilLayer(); const rects = [];
    for (const [node, spans] of veils) {
      if (!node.isConnected) { veils.delete(node); continue; }
      for (const [a, b] of spans) {
        const r = document.createRange();
        try { r.setStart(node, a); r.setEnd(node, b); } catch { continue; }
        for (const q of r.getClientRects()) {
          if (!(q.width > 0 && q.height > 0)) continue;
          // teks yang tertutup laci/modal tidak perlu diveil (veil-nya akan melayang di atas laci)
          const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          const host = node.parentElement;
          if (!top || !(host.contains(top) || top.contains(host))) continue;
          rects.push(q);
        }
      }
    }
    while (layer.children.length < rects.length) { const d = document.createElement('div'); d.style.cssText = 'position:absolute;border-radius:3px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);background:color-mix(in oklab,currentColor 10%,transparent)'; layer.appendChild(d); }
    [...layer.children].forEach((d, i) => {
      const q = rects[i]; if (!q) { d.style.display = 'none'; return; }
      d.style.display = ''; d.style.left = (q.left - 2) + 'px'; d.style.top = (q.top - 1) + 'px'; d.style.width = (q.width + 4) + 'px'; d.style.height = (q.height + 2) + 'px';
    });
  };
  const veilLoop = () => { drawVeils(); requestAnimationFrame(veilLoop); };
  requestAnimationFrame(veilLoop);
  const addVeils = (node, re) => {
    const s = node.nodeValue; let m; re.lastIndex = 0; const spans = [];
    while ((m = re.exec(s))) { const off = m[0].search(/[−-]?\\$/); spans.push([m.index + (off > 0 ? off : 0), m.index + m[0].length]); }
    if (spans.length) veils.set(node, spans);
  };
  const labelOf = (el) => {
    // label langsung: saudara sebelumnya dari elemen ini atau leluhurnya (≤4 tingkat) —
    // "Value" di samping "$1,095.84", judul kartu Stat, kolom kiri baris KV.
    const txt = (n) => (n.innerText ?? n.textContent ?? '').trim();
    const cands = [];
    let anc = el;
    for (let i = 0; i < 4 && anc && anc.id !== 'root'; i++, anc = anc.parentElement) {
      if (anc.previousElementSibling) cands.push(txt(anc.previousElementSibling));
      else if (anc.previousSibling && anc.previousSibling.nodeType === 3) cands.push(anc.previousSibling.textContent.trim());
      if (cands.length) break;
    }
    const kv = el.closest('.kv-row'); if (kv && kv.firstElementChild) cands.push(txt(kv.firstElementChild));
    const own = (el.textContent || '').trim();
    const box = el.parentElement?.closest('div, li, td, th, section, a') || el.parentElement;
    const fallback = box ? ((box.innerText || '').split('\\n').map((x) => x.trim()).filter((x) => x && x !== own)[0] || '') : '';
    const direct = cands.filter((c) => c && c.split(/\\s+/).length <= 4);
    return direct[0] || fallback;
  };
  const markMoney = (root) => {
    if (!root || root.nodeType !== 1) return;
    // 3) kolom Value/Nilai
    for (const table of root.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th')].map((h) => (h.innerText || '').trim().toLowerCase());
      heads.forEach((h, i) => {
        if (!/^(value|nilai|capital|modal|proceeds|hasil|our positions|posisi kami|their balance|saldo mereka)$/.test(h)) return;
        for (const tr of table.querySelectorAll('tbody tr')) {
          const td = tr.children[i]; if (!td) continue;
          const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
          while (w.nextNode()) { const n = w.currentNode; if (MONEY.test(n.nodeValue)) { MONEY.lastIndex = 0; if (!veils.has(n)) addVeils(n, MONEY); } MONEY.lastIndex = 0; }
        }
      });
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const el = n.parentElement; if (!el || el.closest('.q-censor,#qd,#q-overlay,script,style,input,textarea')) continue;
      const s = n.nodeValue; if (!s || !/[\\d]/.test(s)) continue;
      if (FRAG.test(s)) { FRAG.lastIndex = 0; addVeils(n, FRAG); continue; }
      FRAG.lastIndex = 0;
      const own = s.trim();
      // uang, angka polos, atau angka + simbol token (110 USDG, 0.00125 ETH)
      const isMoney = /^[−-]?\\$\\s?[\\d.,]+k?$/.test(own) || /^[\\d.,]+(\\s+\\S{1,12})?$/.test(own);
      if (!isMoney) continue;
      const lab = labelOf(el);
      if (!LABEL.test(lab) || NOT.test(lab)) continue;
      // teks "110 " di samping <a>USDG</a>: elemennya punya anak, jadi angkanya diveil, bukan diblur utuh
      if (el.children.length === 0) el.classList.add('q-censor');
      else if (!veils.has(n)) addVeils(n, /[−-]?\\$?\\s?[\\d.,]+k?/g);
    }
  };
  const BLUR_MONEY = ${!!process.env.QMONEY_BLUR};   // angka sudah disamarkan di data; blur hanya kalau diminta
  const start = () => {
    document.head.appendChild(css);
    mark(document.body); if (BLUR_MONEY) markMoney(document.body);
    let pending = false;
    new MutationObserver((ms) => {
      for (const m of ms) for (const x of m.addedNodes) mark(x.nodeType === 3 ? x.parentNode || document.body : x);
      if (ms.some((m) => m.type === 'characterData')) mark(document.body);
      // sensor modal dijalankan sekali per frame (bukan per mutasi): mengubah DOM di dalam observer memicu observer lagi
      if (BLUR_MONEY && !pending) { pending = true; requestAnimationFrame(() => { pending = false; markMoney(document.body); }); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

export async function leakCheck(page, secrets) {
  const html = (await page.evaluate(() => document.documentElement.outerHTML + '\n' + location.href)).toLowerCase();
  const found = [];
  for (const a of secrets.addrs) if (html.includes(a)) found.push('addr ' + a.slice(0, 6) + '…');
  for (const [p, s] of secrets.shorts) if (new RegExp(p + '[0-9a-f]{0,4}(…|\\.\\.\\.|&hellip;)' + s).test(html)) found.push('short ' + p + '…');
  for (const l of secrets.labels) if (html.includes(l.toLowerCase())) found.push('label #' + l.length);
  for (const id of secretIds()) if (new RegExp('#' + id + '(?!\\d)').test(html)) found.push('position id ' + id.slice(0, 3) + '…');
  return found;
}
