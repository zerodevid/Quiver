'use strict';
// Grafik posisi sebagai GAMBAR: lilin harga + indikator + pita rentang LP + garis BEP.
//
// Kenapa digambar di server: Telegram tidak bisa menjalankan KLineChart seperti dasbor,
// padahal pertanyaan "harga sekarang di mana terhadap rentang dan BEP saya" justru
// muncul saat sedang di jalan, bukan saat di depan browser. SVG dirasterkan resvg —
// pipa yang sama dengan kartu bagikan (src/share-card.js), termasuk fontnya — jadi
// gambar ini dan dasbor berbicara dengan bahasa visual yang sama.
//
// Indikator memakai parameter bawaan yang sama dengan dasbor (KLineChart):
//   MA 5/10/30/60 · EMA 6/12/20 · BOLL 20,2 · VOL + MA5/MA10 · RSI 6/12/24 · MACD 12/26/9
const { Resvg } = require('@resvg/resvg-js');
const fs = require('node:fs');
const path = require('node:path');
const { tr, localeContext } = require('./telegram-i18n');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const FONTS = ['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => path.join(FONT_DIR, `Inter-${w}.ttf`));
const W = 1200, SCALE = 2;
const PAD = 28;                 // tepi kiri/kanan
const AXIS_W = 104;             // kolom label harga di kanan
const HEAD_H = 104;             // judul + baris harga
const LEGEND_H = 26;            // baris legenda indikator di atas lilin
const MAIN_H = 392;             // tinggi panel lilin
const SUB_H = 116;              // tinggi tiap panel bawah (VOL/RSI/MACD)
const FOOT_H = 74;              // sumbu waktu + catatan kaki

const C = {
  bg0: '#101416', bg1: '#191F22', text: '#F4F6F5', muted: '#A0AAA9', faint: '#7C8786',
  grid: 'rgba(255,255,255,0.07)', line: 'rgba(255,255,255,0.12)',
  up: '#4ADE80', down: '#F87171', accent: '#7AA2F7', amber: '#FBBF24', gold: '#D9AE45',
  range: 'rgba(122,162,247,0.13)', rangeLine: 'rgba(122,162,247,0.55)',
  ind: ['#FF9600', '#935EBD', '#2196F3', '#E11D74'],
};

// Urutan bit = urutan tombol di Telegram. Nilainya ikut tersimpan di callback data,
// jadi JANGAN diubah-ubah urutannya: tombol lama di chat akan berarti indikator lain.
const INDICATORS = [
  { key: 'ma', bit: 1, label: 'MA', pane: 'main' },
  { key: 'ema', bit: 2, label: 'EMA', pane: 'main' },
  { key: 'boll', bit: 4, label: 'BOLL', pane: 'main' },
  { key: 'vol', bit: 8, label: 'VOL', pane: 'sub' },
  { key: 'rsi', bit: 16, label: 'RSI', pane: 'sub' },
  { key: 'macd', bit: 32, label: 'MACD', pane: 'sub' },
];
const DEFAULT_MASK = 2 | 8;      // EMA + VOL, sama seperti bawaan dasbor ditambah EMA
const has = (mask, key) => !!(mask & (INDICATORS.find((i) => i.key === key)?.bit || 0));

// ---- format angka (salinan perilaku web/src/fmt.js) ------------------------------
const loc = () => (localeContext.getStore() === 'en' ? 'en-US' : 'id-ID');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
function price(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  const dot = (s) => s.replace('.', loc() === 'id-ID' ? ',' : '.');
  if (p >= 1e9) return dot(p.toExponential(2));
  if (p >= 1e6) return p.toLocaleString(loc(), { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(loc(), { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(loc(), { maximumSignificantDigits: 3 });
  return dot(p.toExponential(2));
}
const compactNum = (v) => (v == null || !Number.isFinite(v) ? '—'
  : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + ' M'
    : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + ' jt'
      : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + ' rb' : v.toFixed(0));
let tz = null;
const clock = (ts) => new Date(ts).toLocaleString(loc(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
const hhmm = (ts) => new Date(ts).toLocaleString(loc(), { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
const dayShort = (ts) => new Date(ts).toLocaleDateString(loc(), { day: 'numeric', month: 'short', timeZone: tz || undefined });
// Cap waktu penanda: pada lilin harian cukup tanggalnya, selain itu sampai menit.
const stamp = (ts, secs) => (!ts ? '—' : secs >= 86400 ? dayShort(ts) : `${dayShort(ts)} ${hhmm(ts)}`);

// ---- indikator -------------------------------------------------------------------
const sma = (xs, n) => xs.map((_, i) => (i + 1 < n ? null : xs.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
function ema(xs, n) {
  const k = 2 / (n + 1); const out = []; let prev = null;
  xs.forEach((x, i) => { prev = i === 0 ? x : x * k + prev * (1 - k); out.push(i + 1 < n ? null : prev); });
  return out;
}
function boll(xs, n = 20, mult = 2) {
  const mid = sma(xs, n);
  const up = [], low = [];
  xs.forEach((_, i) => {
    if (mid[i] == null) { up.push(null); low.push(null); return; }
    const win = xs.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(win.reduce((a, x) => a + (x - mid[i]) ** 2, 0) / n);
    up.push(mid[i] + mult * sd); low.push(mid[i] - mult * sd);
  });
  return { mid, up, low };
}
// RSI Wilder, seperti yang dipakai KLineChart.
function rsi(xs, n) {
  const out = new Array(xs.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= n) { gain += g / n; loss += l / n; if (i === n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); continue; }
    gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function macd(xs, fast = 12, slow = 26, signal = 9) {
  const f = ema(xs, fast), s = ema(xs, slow);
  const diff = xs.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const seed = diff.map((v) => v ?? 0);
  const deaRaw = ema(seed, signal);
  const dea = diff.map((v, i) => (v == null ? null : deaRaw[i]));
  const bar = diff.map((v, i) => (v == null || dea[i] == null ? null : (v - dea[i]) * 2));
  return { diff, dea, bar };
}

// ---- primitif gambar -------------------------------------------------------------
const txt = (s, x, y, { size = 15, weight = 400, color = C.text, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}</text>`;
const line = (x1, y1, x2, y2, color, width = 1, dash = null) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} />`;
const rect = (x, y, w, h, fill, extra = '') =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}" ${extra} />`;
const poly = (pts, color, width = 1.6) => {
  // Titik kosong (indikator yang belum matang) memutus garis, bukan menariknya ke nol.
  const segs = [];
  let cur = [];
  for (const p of pts) {
    if (!p) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
    cur.push(p);
  }
  if (cur.length > 1) segs.push(cur);
  return segs.map((s) => `<polyline points="${s.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" />`).join('');
};
// Nama panel (VOL/RSI/MACD) berlatar gelap: garis indikator lewat persis di situ,
// dan tanpa latar teksnya tenggelam di antara garis.
const panelLabel = (s, x, y) =>
  rect(x - 4, y - 4, 8 + String(s).length * 6.6, 17, 'rgba(16,20,22,0.82)', 'rx="3"') + txt(s, x, y + 9, { size: 12, color: C.muted });

// Label harga di kolom kanan, dengan latar supaya tetap terbaca di atas lilin.
const tag = (s, x, y, color, { bg = C.bg0 } = {}) => {
  const w = 8 + String(s).length * 7.6;
  return rect(x, y - 11, w, 22, bg, `rx="4" stroke="${color}" stroke-opacity="0.5"`) + txt(s, x + 5, y + 4, { size: 13, weight: 600, color });
};

// ---- gambar utama ----------------------------------------------------------------
function chartSvg(d) {
  const cs = d.candles || [];
  const subs = INDICATORS.filter((i) => i.pane === 'sub' && has(d.mask, i.key));
  const H = HEAD_H + MAIN_H + subs.length * SUB_H + FOOT_H;
  const x0 = PAD, x1 = W - PAD - AXIS_W;
  const plotW = x1 - x0;
  // Tinggi ruang legenda mengikuti jumlah baris yang akan terpakai (MA 4 garis +
  // EMA 3 + BOLL = 8 entri → dua baris).
  const legendN = (has(d.mask, 'ma') ? 4 : 0) + (has(d.mask, 'ema') ? 3 : 0) + (has(d.mask, 'boll') ? 1 : 0);
  const legendH = legendN > 5 ? LEGEND_H + 17 : legendN ? LEGEND_H : 10;
  const mainY0 = HEAD_H + legendH, mainY1 = HEAD_H + MAIN_H;

  const closes = cs.map((c) => Number(c.c));
  const vols = cs.map((c) => Number(c.v) || 0);
  const n = cs.length;
  const step = n ? plotW / n : plotW;
  const cx = (i) => x0 + step * (i + 0.5);

  // Skala harga: lilin + rentang posisi + BEP harus semuanya muat, kalau tidak
  // gambar ini menjawab pertanyaan yang salah ("harga saja", tanpa rentangnya).
  const want = [...cs.map((c) => Number(c.h)), ...cs.map((c) => Number(c.l))].filter((v) => v > 0);
  for (const v of [d.lo, d.hi, d.now, d.entry, d.exit, d.bepPrice]) if (v > 0) want.push(v);
  let min = want.length ? Math.min(...want) : 0, max = want.length ? Math.max(...want) : 1;
  if (!(max > min)) { max = min * 1.05 || 1; min = min * 0.95; }
  const padY = (max - min) * 0.06;
  min -= padY; max += padY;
  const py = (p) => mainY1 - ((p - min) / (max - min)) * (mainY1 - mainY0);

  const parts = [];
  // Isi tiap panel dipotong pada batasnya (clipPath). Bollinger dan MA60 bisa jauh
  // di luar rentang harga lilin; tanpa ini garisnya menerobos ke panel VOL di bawah.
  parts.push(`<defs><clipPath id="cMain"><rect x="${x0}" y="${HEAD_H}" width="${plotW}" height="${mainY1 - HEAD_H}" /></clipPath></defs>`);
  parts.push(rect(0, 0, W, H, C.bg0));
  parts.push(rect(0, 0, W, HEAD_H, C.bg1));
  parts.push(line(0, HEAD_H, W, HEAD_H, C.line));

  // ---- kepala: pasangan, status, harga kini ----
  const st = d.closed ? tr("ditutup") : d.inRange == null ? tr("belum tersinkron") : d.inRange ? tr("in-range") : tr("di luar rentang");
  const stColor = d.closed ? C.muted : d.inRange == null ? C.muted : d.inRange ? C.up : C.amber;
  parts.push(txt(d.pair, PAD, 42, { size: 27, weight: 700 }));
  parts.push(txt(`#${d.positionId}${d.tokenId ? ` · NFT #${d.tokenId}` : ''}`, PAD, 72, { size: 14, color: C.faint }));
  // Lebar jendela yang benar-benar tergambar (jumlah lilin × ukurannya): pilihan
  // "30 hari" pada lilin 5 menit dipangkas ke batas lilin, dan itu harus terbaca.
  const jamJendela = n && d.secs ? (n * d.secs) / 3600 : 0;
  const d1 = (v) => v.toLocaleString(loc(), { maximumFractionDigits: 1 });
  const jendela = !jamJendela ? null : jamJendela < 48 ? tr("{0} jam", [Math.round(jamJendela)]) : tr("{0} hari", [d1(jamJendela / 24)]);
  const headMeta = [d.venue, d.fee != null ? `fee ${(d.fee / 10000).toFixed(2)}%` : null,
    jendela ? `${d.tf} × ${n} (${jendela})` : d.tf, st].filter(Boolean).join(' · ');
  parts.push(txt(headMeta, PAD, 92, { size: 14, color: stColor }));
  parts.push(txt(price(d.now), W - PAD, 42, { size: 27, weight: 700, anchor: 'end' }));
  parts.push(txt(`${d.quoteSymbol || ''} · ${d.change == null ? '—' : pct(d.change, 2)}`, W - PAD, 68, {
    size: 15, weight: 600, anchor: 'end', color: d.change > 0 ? C.up : d.change < 0 ? C.down : C.muted }));
  parts.push(txt(tr("PnL {0} · {1}", [usd(d.pnlUsd), pct(d.pnlPct, 2)]), W - PAD, 92, {
    size: 14, anchor: 'end', color: d.pnlUsd > 0 ? C.up : d.pnlUsd < 0 ? C.down : C.muted }));

  // ---- kisi + label harga ----
  // Label yang berimpit dengan penanda di kolom kanan (BEP, masuk, harga kini)
  // dilewati: dua teks di tempat yang sama saling menimpa dan keduanya jadi sampah.
  const marksY = [d.entry, d.exit, d.bepPrice, d.now]
    .filter((v) => v > 0 && v >= min && v <= max).map((v) => py(v));
  for (let i = 0; i <= 4; i++) {
    const y = mainY0 + ((mainY1 - mainY0) * i) / 4;
    const p = max - ((max - min) * i) / 4;
    parts.push(line(x0, y, x1, y, C.grid));
    if (!marksY.some((my) => Math.abs(my - y) < 14)) parts.push(txt(price(p), x1 + 10, y + 5, { size: 13, color: C.faint }));
  }

  const main = [];   // isi panel lilin (dipotong clipPath), label tepi ditaruh di luar

  // Posisi sebuah waktu di sumbu lilin. `before`/`after`: di luar jendela lilin.
  const tsX = (ts) => {
    if (!ts || !n || !d.secs) return null;
    const idx = (ts - cs[0].t) / (d.secs * 1000);
    return { x: cx(Math.max(0, Math.min(n - 1, idx))), before: idx < -0.5, after: idx > n - 0.5 };
  };

  // ---- pita rentang posisi LP ----
  // Pitanya dimulai di lilin saat posisi DIBUKA (dan berhenti di lilin saat ditutup),
  // bukan membentang seluruh grafik: rentang itu baru ada sejak kita masuk, dan
  // lilin sebelum masuk memang tidak "di dalam" maupun "di luar" rentang apa pun.
  if (d.lo > 0 && d.hi > d.lo) {
    const yHi = py(Math.min(d.hi, max)), yLo = py(Math.max(d.lo, min));
    const mulai = tsX(d.openedTs);
    const selesai = tsX(d.closedTs);
    const bx0 = mulai && !mulai.before ? mulai.x - step / 2 : x0;
    const bx1 = selesai && !selesai.after ? selesai.x + step / 2 : x1;
    main.push(rect(bx0, yHi, bx1 - bx0, yLo - yHi, C.range));
    main.push(line(bx0, yHi, bx1, yHi, C.rangeLine, 1.4, '6 5'));
    main.push(line(bx0, yLo, bx1, yLo, C.rangeLine, 1.4, '6 5'));
    // Label ikut di awal pita; kalau pitanya sempit di ujung kanan, label ditaruh di
    // kirinya supaya tidak keluar dari panel.
    const lx = bx1 - bx0 < 220 && bx0 > x0 + 220 ? bx0 - 8 : bx0 + 8;
    const anchor = lx < bx0 ? 'end' : 'start';
    main.push(txt(tr("batas atas {0}", [price(d.hi)]), lx, yHi - 8, { size: 12, color: C.accent, anchor }));
    // Batas bawah yang mepet dasar panel ditulis DI ATAS garisnya — kalau tidak,
    // teksnya jatuh ke panel volume di bawahnya.
    main.push(txt(tr("batas bawah {0}", [price(d.lo)]), lx, yLo + 17 > mainY1 - 6 ? yLo - 8 : yLo + 17, { size: 12, color: C.accent, anchor }));
  }

  // ---- lilin ----
  const bw = Math.max(1.5, Math.min(14, step * 0.66));
  cs.forEach((c, i) => {
    const o = Number(c.o), h = Number(c.h), l = Number(c.l), cl = Number(c.c);
    const col = cl >= o ? C.up : C.down;
    const x = cx(i);
    main.push(line(x, py(h), x, py(l), col, 1.2));
    const yo = py(o), yc = py(cl);
    main.push(rect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1.2, Math.abs(yc - yo)), col));
  });

  // ---- indikator di panel lilin ----
  const legend = [];
  const at = (arr) => arr.map((v, i) => (v == null ? null : [cx(i), py(v)]));
  if (has(d.mask, 'ma')) {
    [5, 10, 30, 60].forEach((p, k) => {
      const v = sma(closes, p);
      main.push(poly(at(v), C.ind[k % C.ind.length], 1.4));
      legend.push([`MA${p}`, C.ind[k % C.ind.length], price(v[v.length - 1])]);
    });
  }
  if (has(d.mask, 'ema')) {
    [6, 12, 20].forEach((p, k) => {
      const v = ema(closes, p);
      main.push(poly(at(v), C.ind[k % C.ind.length], 1.6));
      legend.push([`EMA${p}`, C.ind[k % C.ind.length], price(v[v.length - 1])]);
    });
  }
  if (has(d.mask, 'boll')) {
    const b = boll(closes, 20, 2);
    main.push(poly(at(b.up), C.ind[1], 1.3));
    main.push(poly(at(b.mid), C.ind[0], 1.3));
    main.push(poly(at(b.low), C.ind[1], 1.3));
    legend.push(['BOLL 20,2', C.ind[1], price(b.up[b.up.length - 1])]);
  }
  // Legenda indikator di atas lilin. Dengan semua indikator menyala isinya delapan
  // entri — satu baris tidak muat, jadi dibungkus ke baris berikutnya alih-alih
  // dipotong diam-diam (dulu BOLL hilang begitu MA dan EMA sama-sama menyala).
  const legendSvg = [];
  {
    let lx = PAD, ly = HEAD_H + 21;
    for (const [name, color, val] of legend) {
      const s = `${name} ${val}`;
      const w = 14 + s.length * 6.4 + 16;
      if (lx + w > W - PAD) { lx = PAD; ly += 17; }
      legendSvg.push(rect(lx - 3, ly - 12, w - 10, 17, 'rgba(16,20,22,0.82)', 'rx="3"'));
      legendSvg.push(rect(lx, ly - 9, 9, 9, color, 'rx="2"'));
      legendSvg.push(txt(s, lx + 14, ly, { size: 12, color: C.muted }));
      lx += w;
    }
  }

  // ---- KAPAN posisi dibuka/ditutup: garis tegak di lilin yang bersangkutan ----
  // Harga masuk saja tidak menjawab "saya masuk di bagian grafik yang mana" — dan
  // itu yang menentukan apakah rentangnya dipasang sebelum atau sesudah gerakan.
  const whenMark = (ts, p, color, label) => {
    const pos = tsX(ts);
    if (!pos) return;
    main.push(line(pos.x, mainY0, pos.x, mainY1, color, 1.4, '5 6'));
    // Di luar jendela lilin: garisnya menempel di tepi, tanda panah yang menjelaskan.
    const teks = pos.before ? `▸ ${label}` : pos.after ? `◂ ${label}` : label;
    const anchorRight = pos.x > x1 - 160;
    main.push(rect(anchorRight ? pos.x - (teks.length * 6.6 + 12) : pos.x + 4, mainY0 + 2, teks.length * 6.6 + 8, 17, 'rgba(16,20,22,0.85)', 'rx="3"'));
    main.push(txt(teks, anchorRight ? pos.x - 8 : pos.x + 8, mainY0 + 15, { size: 12, color, anchor: anchorRight ? 'end' : 'start' }));
    // Titik di perpotongan waktu × harga: "masuk di sini, di harga segini".
    if (p > 0 && p >= min && p <= max) {
      main.push(`<circle cx="${pos.x.toFixed(1)}" cy="${py(p).toFixed(1)}" r="5" fill="${color}" stroke="${C.bg0}" stroke-width="1.5" />`);
    }
  };
  whenMark(d.openedTs, d.entry, C.gold, tr("masuk {0}", [stamp(d.openedTs, d.secs)]));
  whenMark(d.closedTs, d.exit, C.muted, tr("keluar {0}", [stamp(d.closedTs, d.secs)]));

  // ---- garis penting: masuk, keluar, BEP, harga kini ----
  // Label di kolom kanan dikumpulkan dulu, baru digambar: harga masuk dan BEP sering
  // berdekatan, dan dua label di titik yang sama saling menimpa jadi sampah.
  const tags = [];
  const mark = (p, color, label, dash) => {
    if (!(p > 0) || p < min || p > max) return;
    main.push(line(x0, py(p), x1, py(p), color, 1.4, dash));
    tags.push({ y: py(p), label, color, bg: C.bg0 });
  };
  mark(d.entry, C.gold, tr("masuk {0}", [price(d.entry)]), '3 4');
  mark(d.exit, C.muted, tr("keluar {0}", [price(d.exit)]), '3 4');
  mark(d.bepPrice, C.amber, `BEP ${price(d.bepPrice)}`, '7 5');
  if (d.now > 0) {
    main.push(line(x0, py(d.now), x1, py(d.now), C.text, 1, '2 3'));
    tags.push({ y: py(d.now), label: price(d.now), color: C.text, bg: C.bg1 });
  }
  // Harga kini selalu di tempatnya; yang lain digeser kalau berimpit dengannya.
  tags.sort((a, b) => a.y - b.y);
  let prevY = -99;
  for (const tg of tags) {
    const y = Math.max(tg.y, prevY + 24);
    prevY = y;
    parts.push(tag(tg.label, x1 + 6, y, tg.color, { bg: tg.bg }));
  }
  parts.push(`<g clip-path="url(#cMain)">${main.join('')}</g>`);
  parts.push(legendSvg.join(''));

  // ---- panel bawah ----
  let y = mainY1;
  for (const ind of subs) {
    const top = y + 10, bot = y + SUB_H - 18;
    parts.push(line(0, y, W, y, C.line));
    if (ind.key === 'vol') {
      const vmax = Math.max(...vols, 1);
      const vy = (v) => bot - (v / vmax) * (bot - top);
      cs.forEach((c, i) => {
        const col = Number(c.c) >= Number(c.o) ? C.up : C.down;
        parts.push(rect(cx(i) - bw / 2, vy(vols[i]), bw, bot - vy(vols[i]), col, 'opacity="0.55"'));
      });
      [5, 10].forEach((p, k) => parts.push(poly(sma(vols, p).map((v, i) => (v == null ? null : [cx(i), vy(v)])), C.ind[k], 1.3)));
      parts.push(panelLabel(tr("VOL {0}", [compactNum(vols[vols.length - 1])]), PAD, top - 7));
      parts.push(txt(compactNum(vmax), x1 + 10, top + 6, { size: 12, color: C.faint }));
    } else if (ind.key === 'rsi') {
      const ry = (v) => bot - (v / 100) * (bot - top);
      for (const lv of [30, 50, 70]) {
        parts.push(line(x0, ry(lv), x1, ry(lv), C.grid, 1, lv === 50 ? '4 6' : null));
        parts.push(txt(String(lv), x1 + 10, ry(lv) + 4, { size: 11, color: C.faint }));
      }
      const vals = [6, 12, 24].map((p) => rsi(closes, p));
      vals.forEach((v, k) => parts.push(poly(v.map((x, i) => (x == null ? null : [cx(i), ry(x)])), C.ind[k], 1.4)));
      parts.push(panelLabel(`RSI ${vals.map((v, k) => `${[6, 12, 24][k]}:${v[v.length - 1] == null ? '—' : v[v.length - 1].toFixed(0)}`).join(' ')}`,
        PAD, top - 7));
    } else if (ind.key === 'macd') {
      const m = macd(closes);
      const all = [...m.diff, ...m.dea, ...m.bar].filter((v) => v != null && Number.isFinite(v));
      const amp = Math.max(...all.map(Math.abs), 1e-12);
      const mid = (top + bot) / 2;
      const my = (v) => mid - (v / amp) * ((bot - top) / 2);
      parts.push(line(x0, mid, x1, mid, C.grid));
      m.bar.forEach((v, i) => {
        if (v == null) return;
        const col = v >= 0 ? C.up : C.down;
        parts.push(rect(cx(i) - bw / 2, Math.min(mid, my(v)), bw, Math.abs(my(v) - mid), col, 'opacity="0.6"'));
      });
      parts.push(poly(m.diff.map((v, i) => (v == null ? null : [cx(i), my(v)])), C.ind[0], 1.4));
      parts.push(poly(m.dea.map((v, i) => (v == null ? null : [cx(i), my(v)])), C.ind[2], 1.4));
      parts.push(panelLabel('MACD 12,26,9', PAD, top - 7));
    }
    y += SUB_H;
  }

  // ---- sumbu waktu + kaki ----
  const axisY = y + 20;
  const ticks = Math.min(6, Math.max(2, Math.floor(plotW / 190)));
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round(((n - 1) * i) / (ticks - 1));
    const c = cs[idx];
    if (!c) continue;
    const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
    parts.push(txt(d.secs >= 86400 ? dayShort(c.t) : `${dayShort(c.t)} ${hhmm(c.t)}`, cx(idx), axisY, { size: 12, color: C.faint, anchor }));
  }
  parts.push(line(0, y + 32, W, y + 32, C.line));
  const kaki = [
    d.openedTs ? tr("masuk {0}{1}", [stamp(d.openedTs, d.secs),
      d.ageHours > 0 ? tr(" · dipegang {0}", [d.ageHours < 24 ? tr("{0} jam", [d1(d.ageHours)]) : tr("{0} hari", [d1(d.ageHours / 24)])]) : '']) : null,
    d.bepPrice > 0 ? tr("BEP {0}{1}", [price(d.bepPrice), d.now > 0 ? ` (${pct((d.bepPrice / d.now - 1) * 100, 2)})` : '']) : (d.bepNote || null),
    d.costUsd != null ? tr("modal {0}", [usd(d.costUsd)]) : null,
    d.feeUsd != null ? tr("fee belum diklaim {0}", [usd(d.feeUsd)]) : null,
    d.cost?.totalUsd ? tr("ongkos {0}", [usd(d.cost.totalUsd)]) : null,
  ].filter(Boolean).join('   ·   ');
  parts.push(txt(kaki, PAD, y + 56, { size: 14, color: C.muted }));
  // Lilin dari cadangan (GeckoTerminal sedang membatasi panggilan): katakan umurnya,
  // jangan biarkan gambar lama tampak seperti harga detik ini.
  const jam = d.staleAt ? tr("harga {0}", [clock(d.staleAt)]) : null;
  parts.push(txt(`${jam ? `${jam} · ` : ''}Quiver · ${clock(d.at || Date.now())}`, W - PAD, y + 56,
    { size: 13, color: jam ? C.amber : C.faint, anchor: 'end' }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

function render(data, { lang = 'id', timeZone = null } = {}) {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => {
    tz = timeZone;
    try {
      const svg = chartSvg(data);
      const r = new Resvg(svg, {
        fitTo: { mode: 'width', value: W * SCALE },
        font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
      });
      return Buffer.from(r.render().asPng());
    } finally { tz = null; }
  });
}

function caption(d, lang = 'id') {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => [
    `${d.pair} · ${d.tf}`,
    d.now > 0 ? tr("harga {0}", [price(d.now)]) : null,
    d.lo > 0 ? tr("rentang {0}–{1}", [price(d.lo), price(d.hi)]) : null,
    d.bepPrice > 0 ? `BEP ${price(d.bepPrice)}` : null,
  ].filter(Boolean).join(' · '));
}

module.exports = { render, caption, chartSvg, INDICATORS, DEFAULT_MASK, has };
