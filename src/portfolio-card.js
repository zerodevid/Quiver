'use strict';
// Grafik pertumbuhan portofolio sebagai GAMBAR untuk Telegram: garis nilai wallet
// atau PnL sepanjang waktu, diisi sampai garis nol, dengan puncak dan drawdown
// terdalam ditandai — kembaran web/src/components/GrowthChart.jsx.
//
// Kenapa digambar di server: sama seperti grafik posisi (src/chart-card.js) —
// pertanyaan "portofolio saya naik atau turun minggu ini" muncul di ponsel, dan
// Telegram tidak bisa menjalankan Recharts. Angkanya diambil dari /api/portfolio
// yang sama dengan dasbor, jadi gambar dan halaman Ringkasan tidak pernah berbeda.
//
// Tiga tampilan, satu sumbu (bukan dua garis berskala beda di satu grafik):
//  - net   : PnL bersih = nilai wallet − modal (baseline + setoran − penarikan).
//            Memuat biaya di luar posisi (zap, gas, swap). Hanya kalau modal terlacak.
//  - pnl   : PnL kumulatif = jumlah PnL posisi (out − cost); kebal setoran/penarikan.
//  - value : nilai wallet = kas + posisi + fee; hanya titik yang kasnya terbaca.
const { Resvg } = require('@resvg/resvg-js');
const { tr, localeContext } = require('./telegram-i18n');
const { prims } = require('./chart-card');

const { W, SCALE, PAD, AXIS_W, C, FONTS, txt, line, rect, poly, tag, usd, pct, clock, hhmm, dayShort, setTz } = prims;
const HEAD_H = 132;             // judul + angka besar + tertinggi/drawdown
const PLOT_H = 380;             // tinggi panel grafik
const FOOT_H = 78;              // sumbu waktu + catatan kaki
const HOUR = 3600e3, DAY = 864e5;

// Urutan = urutan tombol di Telegram; kuncinya ikut tersimpan di callback data.
const VIEWS = [['net', 'PnL bersih'], ['pnl', 'PnL kumulatif'], ['value', 'Nilai']];
const RANGES = ['24h', '7d', '30d', 'all'];
const RANGE_LABEL = { '24h': '24 jam', '7d': '7 hari', '30d': '30 hari', all: 'Semua' };
const RANGE_IN = { '24h': 'dalam 24 jam', '7d': 'dalam 7 hari', '30d': 'dalam 30 hari', all: 'sejak awal' };

// Kelipatan "bulat" (1-2-2,5-5 × 10ⁿ) untuk label sumbu — salinan GrowthChart.jsx.
function niceStep(span, target) {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function yScale(lo, hi, { zero, floor0 }) {
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += Math.max(1, Math.abs(hi) * 0.05); lo -= Math.max(1, Math.abs(lo) * 0.05); }
  const pad = (hi - lo) * 0.1;
  const dLo = floor0 && lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
  const dHi = hi + pad;
  const step = niceStep(dHi - dLo, 5);
  const ticks = [];
  for (let v = Math.ceil(dLo / step) * step; v <= dHi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { lo: dLo, hi: dHi, ticks, step };
}
// Tick waktu di batas jam/hari (zona waktu pengguna), bukan titik acak berlabel sama.
function timeTicks(t0, t1, tz, target = 7) {
  const span = Math.max(1, t1 - t0);
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const step = steps.find((s) => span / s <= target) || 30 * DAY;
  // Offset zona waktu supaya pembulatan ke jam/hari mengikuti jam lokal pengguna.
  const off = tz ? tzOffset(t0, tz) : new Date(t0).getTimezoneOffset() * -60000;
  const out = [];
  let v = Math.ceil((t0 + off) / step) * step - off;
  for (; v <= t1; v += step) out.push(v);
  return { ticks: out, step };
}
function tzOffset(ts, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts)).reduce((a, p) => (a[p.type] = p.value, a), {});
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ts / 1000) * 1000;
  } catch { return 0; }
}

// Titik-titik yang digambar untuk satu tampilan, dari balasan /api/portfolio.
function pointsOf(p, view) {
  const s = p.series || [];
  if (view === 'net') return s.filter((e) => e.net != null).map((e) => ({ t: e.ts, v: e.net }));
  if (view === 'pnl') return s.filter((e) => e.pnl != null).map((e) => ({ t: e.ts, v: e.pnl }));
  return s.filter((e) => e.cash != null).map((e) => ({ t: e.ts, v: e.total }));
}

// Bahan gambar dari balasan /api/portfolio: tampilan yang diminta (net jatuh ke pnl
// kalau modal tidak terlacak, seperti dasbor), titik, selisih, dan penanda.
function prepare(p, view) {
  const v = VIEWS.some(([k]) => k === view) ? view : 'net';
  const eff = v === 'net' && p.now?.netPnl == null ? 'pnl' : v;
  const pts = pointsOf(p, eff);
  const isPnl = eff !== 'value';
  const first = pts[0]?.v ?? 0, last = pts[pts.length - 1]?.v ?? 0;
  // Rentang "Semua" dari nol; selain itu dari patokan sebelum jendela — kalau
  // riwayat mulai di dalam jendela, dari nol, bukan dari titik pertama yang sudah berisi laba.
  const delta = eff === 'net' ? last - (p.range === 'all' ? 0 : (p.baseline?.net ?? 0))
    : eff === 'pnl' ? last - (p.range === 'all' ? 0 : (p.baseline?.pnl ?? 0))
      : last - first;
  const cap = p.now?.capitalNet ?? p.now?.capital ?? null;
  const ex = p.extremes?.[eff] || {};
  const vals = pts.map((x) => x.v);
  const vMin = vals.length ? Math.min(...vals) : 0, vMax = vals.length ? Math.max(...vals) : 0;
  let peak = -Infinity, dd = 0;
  for (const x of pts) { peak = Math.max(peak, x.v); dd = Math.max(dd, peak - x.v); }
  return {
    view: eff, range: p.range, pts, isPnl, delta, cap,
    hi: ex.hi ?? vMax, lo: ex.lo ?? vMin, dd: ex.dd ?? dd,
    hiTs: ex.hiTs ?? null, ddPeakTs: ex.ddPeakTs ?? null, ddTroughTs: ex.ddTroughTs ?? null,
    now: p.now || null, stats: p.stats || null, at: Date.now(),
  };
}

const viewLabel = (v) => tr(VIEWS.find(([k]) => k === v)?.[1] || v);

function portfolioSvg(d, tz) {
  const H = HEAD_H + PLOT_H + FOOT_H;
  const x0 = PAD, x1 = W - PAD - AXIS_W;
  const y0 = HEAD_H, y1 = HEAD_H + PLOT_H - 8;
  const parts = [];
  parts.push(rect(0, 0, W, H, C.bg0));
  parts.push(`<defs>
    <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.up}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.up}" stop-opacity="0.03"/></linearGradient>
    <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.down}" stop-opacity="0.03"/><stop offset="1" stop-color="${C.down}" stop-opacity="0.35"/></linearGradient>
    <linearGradient id="gFlat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0.03"/></linearGradient>
  </defs>`);

  // ---- kepala ----
  const judul = `${tr("Portofolio")} · ${viewLabel(d.view)} · ${tr(RANGE_LABEL[d.range] || d.range)}`;
  parts.push(txt(judul, PAD, 40, { size: 22, weight: 600 }));
  parts.push(txt(`Quiver · ${clock(d.at)}`, W - PAD, 40, { size: 13, color: C.faint, anchor: 'end' }));
  const tone = d.delta > 0 ? C.up : d.delta < 0 ? C.down : C.text;
  const besar = (d.delta > 0 ? '+' : '') + usd(d.delta);
  parts.push(txt(besar, PAD, 92, { size: 40, weight: 700, color: tone }));
  const bx = PAD + besar.length * 22.5 + 16;   // taksiran lebar angka besar (Inter 40px)
  if (d.isPnl && d.cap > 0) parts.push(txt(pct((d.delta / d.cap) * 100, 2), bx, 92, { size: 18, weight: 500, color: tone }));
  parts.push(txt(tr(RANGE_IN[d.range] || d.range) + (d.view === 'value' ? ` · ${tr("termasuk setoran & penarikan")}` : ''), PAD, 116, { size: 13, color: C.muted }));
  // Tertinggi & drawdown/terendah di kanan, sejajar angka besar.
  const kanan = d.isPnl
    ? [[tr("Tertinggi"), usd(d.hi), C.text], [tr("Drawdown maks"), (d.dd > 0.005 ? '−' : '') + usd(d.dd), d.dd > 0.005 ? C.down : C.text]]
    : [[tr("Tertinggi"), usd(d.hi), C.text], [tr("Terendah"), usd(d.lo), C.text]];
  let kx = W - PAD;
  for (const [label, val, col] of kanan.reverse()) {
    parts.push(txt(val, kx, 92, { size: 20, weight: 600, color: col, anchor: 'end' }));
    parts.push(txt(label, kx, 112, { size: 12, color: C.muted, anchor: 'end' }));
    kx -= Math.max(label.length * 7, val.length * 12) + 34;
  }
  parts.push(line(0, HEAD_H - 4, W, HEAD_H - 4, C.line));

  const pts = d.pts;
  if (pts.length < 2) {
    parts.push(txt(tr("Belum ada riwayat"), (x0 + x1) / 2, (y0 + y1) / 2, { size: 18, weight: 500, color: C.muted, anchor: 'middle' }));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
  }

  // ---- skala ----
  const vals = pts.map((x) => x.v);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  const Y = yScale(Math.min(d.lo, vMin), Math.max(d.hi, vMax), { zero: d.isPnl, floor0: !d.isPnl });
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const px = (t) => x0 + ((t - t0) / Math.max(1, t1 - t0)) * (x1 - x0);
  const py = (v) => y1 - ((v - Y.lo) / (Y.hi - Y.lo)) * (y1 - y0 - 14);
  const yDec = Y.step < 1 ? 2 : 0;
  for (const v of Y.ticks) {
    parts.push(line(x0, py(v), x1, py(v), v === 0 && d.isPnl ? C.line : C.grid, 1, v === 0 && d.isPnl ? null : null));
    parts.push(txt(usd(v, yDec), x1 + 10, py(v) + 4, { size: 12, color: C.faint }));
  }
  const X = timeTicks(t0, t1, tz);
  for (const t of X.ticks) parts.push(line(px(t), y0, px(t), y1, C.grid));

  // ---- area + garis ----
  // Diisi sampai garis nol (PnL) atau dasar grafik (nilai). Warna menurut tanda:
  // bagian di atas nol hijau, di bawah nol merah — dua clip-path atas gambar yang sama.
  const zeroY = d.isPnl ? py(0) : y1;
  const linePts = pts.map((x) => [px(x.t), py(x.v)]);
  const areaPath = `M${linePts[0][0].toFixed(1)},${zeroY.toFixed(1)} ` + linePts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ` L${linePts[linePts.length - 1][0].toFixed(1)},${zeroY.toFixed(1)} Z`;
  if (d.isPnl) {
    parts.push(`<clipPath id="cUp"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${Math.max(0, zeroY - y0)}"/></clipPath>`);
    parts.push(`<clipPath id="cDown"><rect x="${x0}" y="${zeroY}" width="${x1 - x0}" height="${Math.max(0, y1 - zeroY)}"/></clipPath>`);
    parts.push(`<g clip-path="url(#cUp)"><path d="${areaPath}" fill="url(#gUp)"/>${poly(linePts, C.up, 2)}</g>`);
    parts.push(`<g clip-path="url(#cDown)"><path d="${areaPath}" fill="url(#gDown)"/>${poly(linePts, C.down, 2)}</g>`);
  } else {
    parts.push(`<path d="${areaPath}" fill="url(#gFlat)"/>`);
    parts.push(poly(linePts, C.accent, 2));
  }

  // ---- penanda: puncak (bukan titik terakhir) dan pita drawdown terdalam ----
  const at = (ts) => pts.find((x) => x.t === ts);
  const peakPt = at(d.hiTs);
  if (peakPt && d.hiTs !== t1 && d.hi - Math.min(pts[0].v, pts[pts.length - 1].v) > Y.step * 0.25) {
    const [x, y] = [px(peakPt.t), py(peakPt.v)];
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${C.bg0}" stroke="${d.isPnl ? C.up : C.accent}" stroke-width="2"/>`);
    parts.push(txt(usd(d.hi), Math.min(x, x1 - 70), y - 12, { size: 12, weight: 600, color: C.text, anchor: x > x1 - 70 ? 'end' : 'middle' }));
  }
  const ddA = at(d.ddPeakTs), ddB = at(d.ddTroughTs);
  if (d.isPnl && d.dd > 0.005 && ddA && ddB && d.dd > (Y.hi - Y.lo) * 0.08) {
    const xa = px(ddA.t), xb = px(ddB.t);
    parts.push(rect(xa, y0, Math.max(2, xb - xa), y1 - y0, 'rgba(248,113,113,0.10)'));
    parts.push(line(xb, py(ddA.v), xb, py(ddB.v), C.down, 1.2, '3 3'));
    parts.push(txt(`−${usd(d.dd)}`, xb + 10, (py(ddA.v) + py(ddB.v)) / 2 + 4, { size: 12, weight: 600, color: C.down, anchor: xb > x1 - 90 ? 'end' : 'start' }));
  }
  // Titik terakhir + label nilainya di kolom kanan.
  const lastPt = linePts[linePts.length - 1];
  const lastCol = d.isPnl ? (pts[pts.length - 1].v < 0 ? C.down : C.up) : C.accent;
  parts.push(`<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="4" fill="${lastCol}"/>`);
  parts.push(tag(usd(pts[pts.length - 1].v), x1 + 6, lastPt[1], lastCol, { bg: C.bg1 }));

  // ---- sumbu waktu ----
  const axisY = y1 + 22;
  for (const t of X.ticks) {
    const label = X.step >= DAY ? dayShort(t) : `${dayShort(t)} ${hhmm(t)}`;
    parts.push(txt(label, px(t), axisY, { size: 12, color: C.faint, anchor: 'middle' }));
  }

  // ---- kaki ----
  parts.push(line(0, y1 + 34, W, y1 + 34, C.line));
  const n = d.now, st = d.stats;
  const kaki = [
    n?.cash ? tr("nilai {0}", [usd(n.value)]) : null,
    n?.cash ? tr("kas {0}", [usd(n.cash.usd)]) : null,
    n ? tr("di posisi {0}", [usd((n.positionsUsd || 0) + (n.feeUsd || 0))]) : null,
    n?.capitalNet != null ? tr("modal {0}", [usd(n.capitalNet)]) : null,
    st?.closedCount ? tr("{0} ditutup · win rate {1}%", [st.closedCount, Math.round(st.winRatePct || 0)]) : null,
    n?.openCount ? tr("{0} terbuka", [n.openCount]) : null,
  ].filter(Boolean).join('   ·   ');
  parts.push(txt(kaki, PAD, y1 + 58, { size: 14, color: C.muted }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

function render(d, { lang = 'id', timeZone = null } = {}) {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => {
    setTz(timeZone);
    try {
      const svg = portfolioSvg(d, timeZone);
      const r = new Resvg(svg, {
        fitTo: { mode: 'width', value: W * SCALE },
        font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
      });
      return Buffer.from(r.render().asPng());
    } finally { setTz(null); }
  });
}

function caption(d, lang = 'id') {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => [
    `${tr("Portofolio")} · ${viewLabel(d.view)} · ${tr(RANGE_LABEL[d.range] || d.range)}`,
    `${d.delta > 0 ? '+' : ''}${usd(d.delta)}${d.isPnl && d.cap > 0 ? ` (${pct((d.delta / d.cap) * 100, 2)})` : ''}`,
    d.now?.cash ? tr("nilai {0}", [usd(d.now.value)]) : null,
  ].filter(Boolean).join(' · '));
}

module.exports = { render, caption, prepare, portfolioSvg, VIEWS, RANGES };
