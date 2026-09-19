'use strict';
// Kartu bagikan (share card): gambar PnL siap tempel ke X/Telegram, seperti yang
// dipunyai Based bot atau GMGN. Tiga jenis kartu dengan bingkai yang sama:
//   position  satu posisi LP: pasangan, PnL, harga masuk/keluar, fee, umur
//   total     seluruh portofolio: total PnL, win rate, fee, posisi terbaik
//   daily     satu hari: PnL terealisasi hari itu, posisi yang ditutup
//
// Tiap kartu bisa digambar dalam tiga ukuran (opts.size) dan tujuh tema warna
// (opts.theme), lihat SIZES dan THEMES. Tata letaknya satu: kepala (logo + konteks),
// judul + chip, angka besar, strip grafik (opts.chart: harga posisi / kurva PnL / batang
// harian), maskot, kisi statistik, kaki (tanggal + chain) — cuma
// koordinatnya yang berbeda per ukuran (geometry()).
//
// Digambar di server sebagai SVG lalu dirasterkan resvg — bukan di browser — supaya
// dasbor dan bot Telegram mengirim gambar yang persis sama dari satu sumber desain.
// Huruf dibawa sendiri (public/fonts/*.ttf: Sora untuk kartu, Pixelify Sans untuk tema
// piksel — empat bobot statis yang dibuat dari berkas variabel Google Fonts dengan
// fontTools) karena VPS tidak punya font sistem; lebar teks untuk chip dan judul
// dihitung dari tabel advance glyph (src/*-advances.json, dibuat dari font yang sama) —
// resvg tidak punya API pengukur teks, dan SVG tidak punya tata letak mengalir.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
// Huruf dasar kartu dan tabel lebar glyph-nya (dibuat dari berkas font yang sama,
// lihat catatan di atas measure()). Tema boleh mengganti lewat font/adv (piksel).
const BASE_FONT = { family: 'Sora', adv: require('./sora-advances.json') };
const ADV_PIXEL = require('./pixelify-advances.json');
const { tr, localeContext } = require('./telegram-i18n');

const PAD = 56, SCALE = 2;
// Ukuran kartu. wide = kartu tautan X/Telegram; square = umpan Instagram/Threads;
// story = Instagram Story / status WhatsApp (isi dijauhkan dari tepi atas-bawah yang
// tertutup UI aplikasi).
const SIZES = {
  wide: { W: 1200, H: 630, label: 'Lebar' },
  square: { W: 1080, H: 1080, label: 'Persegi' },
  story: { W: 1080, H: 1920, label: 'Story' },
};
// Tema warna. bg = gradien latar (kiri-atas → kanan-bawah); up/down/flat = warna PnL;
// accent = warna dekorasi latar (deco: kisi/titik/lingkaran/garis miring/papan catur);
// logo = warna wordmark (tema terang butuh logo gelap); font/adv = huruf lain beserta
// tabel lebarnya (piksel); sq = sudut kotak & garis tebal ala UI 8-bit.
const THEMES = {
  dark: {
    label: 'Grafit', bg: ['#191F22', '#101416'], text: '#F4F6F5', muted: '#A0AAA9', faint: '#84908F',
    line: 'rgba(255,255,255,0.09)', panel: 'rgba(255,255,255,0.025)', chip: 'rgba(255,255,255,0.06)',
    up: '#4ADE80', down: '#F87171', flat: '#C4C7D0', amber: '#FBBF24', accent: '#4ADE80', deco: null, glow: 0.16,
  },
  midnight: {
    label: 'Malam', bg: ['#101E48', '#070C1F'], text: '#EEF2FF', muted: '#9AA6C8', faint: '#6F7BA0',
    line: 'rgba(148,163,255,0.16)', panel: 'rgba(99,120,255,0.08)', chip: 'rgba(99,120,255,0.16)',
    up: '#5EEAD4', down: '#FB7185', flat: '#C7D2FE', amber: '#FCD34D', accent: '#818CF8', deco: 'dots', glow: 0.22,
  },
  sunset: {
    label: 'Senja', bg: ['#2A0B3D', '#5B1449', '#8A2E2E'], text: '#FFF4EC', muted: '#E6BBCB', faint: '#BC91A6',
    line: 'rgba(255,220,200,0.16)', panel: 'rgba(255,200,180,0.08)', chip: 'rgba(255,200,180,0.16)',
    up: '#86EFAC', down: '#FDA4AF', flat: '#F5D0C5', amber: '#FDE68A', accent: '#FDBA74', deco: 'rings', glow: 0.24,
  },
  neon: {
    label: 'Neon', bg: ['#05070C', '#0B0A16'], text: '#F8FAFC', muted: '#94A3B8', faint: '#64748B',
    line: 'rgba(34,211,238,0.2)', panel: 'rgba(34,211,238,0.05)', chip: 'rgba(34,211,238,0.12)',
    up: '#A3E635', down: '#F472B6', flat: '#E2E8F0', amber: '#FACC15', accent: '#22D3EE', deco: 'grid', glow: 0.26,
  },
  gold: {
    label: 'Emas', bg: ['#231B0A', '#0C0A05'], text: '#FBF5E6', muted: '#CDBB8E', faint: '#8F8262',
    line: 'rgba(217,174,69,0.2)', panel: 'rgba(217,174,69,0.06)', chip: 'rgba(217,174,69,0.14)',
    up: '#F0C75E', down: '#F08C7A', flat: '#E7DCC0', amber: '#F0C75E', accent: '#D9AE45', deco: 'stripes', glow: 0.22,
  },
  light: {
    label: 'Terang', bg: ['#FFFFFF', '#E9EEF1'], text: '#111827', muted: '#5B6670', faint: '#8A949C',
    line: 'rgba(17,24,39,0.1)', panel: 'rgba(17,24,39,0.035)', chip: 'rgba(17,24,39,0.06)',
    up: '#15803D', down: '#DC2626', flat: '#4B5563', amber: '#B45309', accent: '#15803D', deco: null, glow: 0.14, logo: '#111827',
  },
  pixel: {
    label: 'Piksel', bg: ['#1E1B3A', '#0D0B1A'], text: '#F4F1FF', muted: '#ABA5DA', faint: '#7E78A8',
    line: 'rgba(168,160,255,0.3)', panel: 'rgba(168,160,255,0.08)', chip: 'rgba(168,160,255,0.18)',
    up: '#6EF06E', down: '#FF6B6B', flat: '#D6D2FF', amber: '#FFD75E', accent: '#FF7AD9', deco: 'pixels', glow: 0.22,
    font: 'Pixelify Sans', adv: ADV_PIXEL, sq: true,
  },
};
const HIDDEN = '••••';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
// Semua .ttf di public/fonts dimuat; resvg memilih keluarga & bobot dari nama di dalam berkas.
const FONTS = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONT_DIR, f));
const MARK = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-white.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
// Ikon & nama chain di kaki kartu (logo resmi tiap chain di public/). Diset per render
// lewat opts.chain.
const CHAIN_BADGE = {
  robinhood: { label: 'Robinhood Chain', href: `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'robinhood-chain.jpg')).toString('base64')}` },
  bsc: { label: 'BNB Smart Chain', href: `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'bnb-chain.png')).toString('base64')}` },
};
let chainNow = CHAIN_BADGE.robinhood;
const chainName = () => chainNow.label;
// Maskot rubah, ekspresinya mengikuti PnL (public/mascots/*.png, PNG transparan,
// tinggi 900 px). Dimuat sekali per proses.
const MASCOT = Object.fromEntries(['flex', 'profit', 'loss', 'neutral'].map((m) => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'mascots', `${m}.png`));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  return [m, { href: `data:image/png;base64,${png.toString('base64')}`, w, h }];
}));
// flex: untung besar (≥ FLEX_PCT% dari modal); profit/loss: arah PnL; neutral: nol / belum ada data.
const FLEX_PCT = 20;
const mood = (pnl, pnlPct) => (pnl > 0.005 ? (pnlPct >= FLEX_PCT ? 'flex' : 'profit') : pnl < -0.005 ? 'loss' : 'neutral');
const QUOTE = new Set(['USDG', 'WETH', 'ETH', 'USDC', 'USDT']);

// Keadaan satu render: tema, geometri, zona waktu. Diset svgOf(), dipulihkan setelahnya.
let T = THEMES.dark;
let G = null;
let tz = null;
const TZ = () => tz || undefined;
// Warna PnL menurut tema.
const sign = (v) => (v > 0.005 ? T.up : v < -0.005 ? T.down : T.flat);
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// Koordinat tiap ukuran. k = skala teks; hero.right = batas kanan teks angka besar
// (kolom maskot mulai di sana); mascot.right / mascot.cx = rata kanan atau di tengah;
// stats.perRow = jumlah ubin statistik per baris; footY = garis kaki (tanggal + chain);
// chart = strip grafik di bawah angka besar (dari PAD sampai chart.x1, bawaan hero.right).
function geometry(size) {
  const { W, H } = SIZES[size] || SIZES.wide;
  if (size === 'story') {
    return { W, H, k: 1.25, logo: { y: 196, w: 200, h: 36 }, ctxY: 216, ruleY: 262, titleY: 352, iconR: 32,
      hero: { labelY: 456, bigY: 616, subY: 676, right: W - PAD, maxBig: 150 }, chart: { y0: 704, y1: 790 },
      mascot: { h: 450, y: 812, cx: W / 2 }, stats: { y: 1290, h: 160, perRow: 2 }, footY: 1700 };
  }
  if (size === 'square') {
    return { W, H, k: 1, logo: { y: 52, w: 154, h: 28 }, ctxY: 68, ruleY: 108, titleY: 172, iconR: 26,
      hero: { labelY: 262, bigY: 396, subY: 450, right: 660, maxBig: 132 }, chart: { y0: 504, y1: 660, x1: W - PAD },
      mascot: { h: 370, y: 122, right: W - PAD + 8 }, stats: { y: 690, h: 140, perRow: 2 }, footY: 1022 };
  }
  return { W, H, k: 1, logo: { y: 45, w: 154, h: 28 }, ctxY: 61, ruleY: 100, titleY: 154, iconR: 26,
    hero: { labelY: 212, bigY: 310, subY: 350, right: 850, maxBig: 96 }, chart: { y0: 370, y1: 432 },
    mascot: { h: 312, y: 104, right: W - PAD + 8 }, stats: { y: 448, h: 108, perRow: 4 }, footY: 588 };
}

// ---- format angka, sama persis dengan web/src/fmt.js ----------------------------
const loc = () => (localeContext.getStore() === 'en' ? 'en-US' : 'id-ID');
const usd = (v, d = 2) => (v == null || Number.isNaN(v) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(loc(), { maximumFractionDigits: d }));
function price(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  const dot = (s) => s.replace('.', loc() === 'id-ID' ? ',' : '.');
  if (p >= 1e9) return dot(p.toExponential(2));
  if (p >= 1e6) return p.toLocaleString(loc(), { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(loc(), { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(loc(), { maximumSignificantDigits: 3 });
  return dot(p.toExponential(2));
}
const age = (h) => (h == null ? '—'
  : h < 1 ? tr('{0} mnt', [Math.round(h * 60)])
    : h < 24 ? tr('{0} jam', [h.toFixed(1)])
      : tr('{0} hari', [(h / 24).toFixed(1)]));
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(loc(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ() }) : '—');
const fmtDayOnly = (ts) => new Date(ts).toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ() });
const fmtDay = (ts) => new Date(ts).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ() });
// Harga dari sqrtPriceX96 / tick — salinan fmt.js.
function sqrtPrice(sqrtX96, dec0, dec1, quoteSide) {
  if (!sqrtX96) return null;
  const r = Number(sqrtX96) / 2 ** 96;
  const p1per0 = r * r * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}
function tickPrice(tick, dec0, dec1, quoteSide) {
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}

// ---- primitif SVG ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Lebar teks dari tabel advance font tema (bobot 500 & 600 tersedia; bobot lain memakai 600).
function measure(s, size, weight = 500) {
  const adv = T.adv || BASE_FONT.adv;
  const tab = adv[String(weight)] || adv['600'];
  let w = 0;
  for (const ch of String(s)) w += tab[ch] ?? 0.6;
  return w * size;
}
// `base` 'middle' meniru textBaseline canvas: garis dasar diturunkan ~0,36 em.
function txt(s, x, y, { size = 16, weight = 400, color = T.text, anchor = 'start', base = 'alphabetic', spans = '' } = {}) {
  const yy = base === 'middle' ? y + size * 0.36 : y;
  return `<text x="${x}" y="${yy}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}${spans}</text>`;
}
// Sudut membulat — nol di tema piksel.
const rx = (n) => (T.sq ? 0 : n);
function chip(s, x, y, { color = T.muted, fill = T.chip } = {}) {
  const size = 17 * G.k, w = measure(s, size, 500) + 24 * G.k, h = 32 * G.k;
  return { w, svg: `<rect x="${x}" y="${y - h / 2}" width="${w.toFixed(1)}" height="${h}" rx="${rx(8 * G.k)}" fill="${fill}"/>` + txt(s, x + 12 * G.k, y, { size, weight: 500, color, base: 'middle' }) };
}
// Chip status berwarna: warna teks dari tema, latar warna yang sama tapi transparan.
const tone = (color) => ({ color, fill: rgba(color, 0.13) });

// Layout uses bounded text widths so large values and long labels stay within the card.
function fit(s, width, size, weight = 500) {
  if (measure(s, size, weight) <= width) return String(s);
  const chars = Array.from(String(s));
  while (chars.length && measure(chars.join('') + '…', size, weight) > width) chars.pop();
  return chars.join('') + '…';
}
function fitted(s, x, y, width, options = {}) {
  const size = options.size || 16, weight = options.weight || 500;
  return txt(fit(s, width, size, weight), x, y, { ...options, size, weight });
}

// Dekorasi latar per tema: pola tipis di seluruh kartu, atau lingkaran di belakang maskot.
function deco(cx, cy, r) {
  const a = T.accent;
  if (T.deco === 'grid') {
    return `<defs><pattern id="deco" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${a}" stroke-opacity="0.1"/></pattern></defs>`
      + `<rect width="${G.W}" height="${G.H}" fill="url(#deco)"/>`;
  }
  if (T.deco === 'dots') {
    return `<defs><pattern id="deco" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="13" cy="13" r="1.6" fill="${a}" fill-opacity="0.18"/></pattern></defs>`
      + `<rect width="${G.W}" height="${G.H}" fill="url(#deco)"/>`;
  }
  if (T.deco === 'stripes') {
    return `<defs><pattern id="deco" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="18" stroke="${a}" stroke-opacity="0.09"/></pattern></defs>`
      + `<rect width="${G.W}" height="${G.H}" fill="url(#deco)"/>`;
  }
  if (T.deco === 'rings') {
    return [0.58, 0.82, 1.06, 1.3].map((m, i) => `<circle cx="${cx}" cy="${cy}" r="${(r * m).toFixed(0)}" fill="none" stroke="${a}" stroke-opacity="${(0.16 - i * 0.035).toFixed(3)}" stroke-width="1.5"/>`).join('');
  }
  if (T.deco === 'pixels') {
    // Papan catur halus + blok-blok acak (deterministik) seperti bintang 8-bit.
    let blocks = '';
    for (let i = 0; i < 40; i++) {
      const s = (i * 7919) % 1000, x = ((s * 37) % (G.W / 16)) * 16, y = ((s * 53) % (G.H / 16)) * 16;
      blocks += `<rect x="${x}" y="${y}" width="16" height="16" fill="${a}" fill-opacity="${i % 3 ? 0.06 : 0.12}"/>`;
    }
    return `<defs><pattern id="deco" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="${a}" fill-opacity="0.035"/><rect x="16" y="16" width="16" height="16" fill="${a}" fill-opacity="0.035"/></pattern></defs>`
      + `<rect width="${G.W}" height="${G.H}" fill="url(#deco)"/>` + blocks;
  }
  return '';
}
// Stempel miring di atas maskot ("UNTUNG BESAR" saat flex).
function stamp(s, cx, cy, color) {
  const size = 24 * G.k, w = measure(s, size, 600) + 48 * G.k, h = 52 * G.k;
  return `<g transform="translate(${cx} ${cy}) rotate(-12)" opacity="0.94">`
    + `<rect x="${-w / 2}" y="${-h / 2}" width="${w.toFixed(1)}" height="${h}" rx="${rx(10 * G.k)}" fill="${rgba(color, 0.1)}" stroke="${color}" stroke-width="${4 * G.k}"/>`
    + `<rect x="${-w / 2 + 7 * G.k}" y="${-h / 2 + 7 * G.k}" width="${(w - 14 * G.k).toFixed(1)}" height="${h - 14 * G.k}" rx="${rx(5 * G.k)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.6"/>`
    + txt(s, 0, 0, { size, weight: 700, color, anchor: 'middle', base: 'middle' }) + '</g>';
}

// Strip grafik di bawah angka besar: garis harga / kurva PnL (kind 'line') atau batang
// PnL harian sebulan (kind 'bars').
//   line: pts [[t, v]], band [lo, hi] (rentang LP), marks [{t, v}] (masuk/keluar), zero (garis nol)
//   bars: bars [{ v, on }] — `on` = hari yang dibagikan
function chartSvg(c, tint) {
  if (!c) return '';
  const x0 = PAD, { y0, y1 } = G.chart, x1 = G.chart.x1 ?? G.hero.right, w = x1 - x0, h = y1 - y0;
  const px = T.sq;
  if (c.kind === 'bars') {
    const bars = c.bars || [];
    if (!bars.length) return '';
    let vMin = Math.min(0, ...bars.map((b) => b.v)), vMax = Math.max(0, ...bars.map((b) => b.v));
    if (vMax === vMin) vMax = vMin + 1;
    const gap = 4, bw = w / bars.length - gap, yOf = (v) => y1 - ((v - vMin) / (vMax - vMin)) * h;
    let out = `<line x1="${x0}" y1="${yOf(0).toFixed(1)}" x2="${x1}" y2="${yOf(0).toFixed(1)}" stroke="${T.muted}" stroke-opacity="0.3"/>`;
    bars.forEach((b, i) => {
      const x = x0 + i * (w / bars.length) + gap / 2, top = Math.min(yOf(0), yOf(b.v)), hh = Math.max(2, Math.abs(yOf(b.v) - yOf(0)));
      out += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="${rx(3)}" fill="${sign(b.v)}" fill-opacity="${b.on ? 0.85 : b.v ? 0.22 : 0.08}"${b.on ? ` stroke="${T.text}" stroke-opacity="0.6"` : ''}/>`;
    });
    return out;
  }
  let pts = (c.pts || []).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (pts.length < 2) return '';
  // Paling banyak ~160 titik: riwayat portofolio tiap 5 menit bisa ribuan.
  if (pts.length > 160) { const step = Math.ceil(pts.length / 160); pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1); }
  const marks = (c.marks || []).filter((m) => Number.isFinite(m.t) && Number.isFinite(m.v));
  const vals = [...pts.map(([, v]) => v), ...marks.map((m) => m.v)];
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (c.zero) { vMin = Math.min(vMin, 0); vMax = Math.max(vMax, 0); }
  // Rentang LP ikut kalau tidak terlalu jauh dari harga; kalau jauh, dipotong di tepi.
  const span0 = Math.max(vMax - vMin, Math.abs(vMax) * 1e-6, 1e-12);
  if (c.band) {
    vMin = Math.min(vMin, Math.max(c.band[0], vMin - span0 * 0.6));
    vMax = Math.max(vMax, Math.min(c.band[1], vMax + span0 * 0.6));
  }
  const span = (vMax - vMin) || 1;
  vMin -= span * 0.08; vMax += span * 0.08;
  const t0 = Math.min(pts[0][0], ...marks.map((m) => m.t)), t1 = Math.max(pts[pts.length - 1][0], ...marks.map((m) => m.t));
  const xOf = (t) => x0 + ((t - t0) / Math.max(t1 - t0, 1)) * w, yOf = (v) => y1 - ((v - vMin) / (vMax - vMin)) * h;
  // Tema piksel: garis bertangga (langkah), bukan diagonal.
  let d = '';
  pts.forEach(([t, v], i) => {
    const x = xOf(t).toFixed(1), y = yOf(v).toFixed(1);
    d += i === 0 ? `M${x} ${y}` : px ? ` H${x} V${y}` : ` L${x} ${y}`;
  });
  const xl = xOf(pts[pts.length - 1][0]).toFixed(1), xf = xOf(pts[0][0]).toFixed(1);
  let out = `<defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${tint}" stop-opacity="0.32"/><stop offset="1" stop-color="${tint}" stop-opacity="0.02"/></linearGradient></defs>`;
  if (c.band) {
    const [lo, hi] = c.band, yLo = Math.min(y1, yOf(lo)), yHi = Math.max(y0, yOf(hi));
    // Isian pita hanya kalau rentangnya tidak memenuhi hampir seluruh pita (kalau ya, cukup garisnya).
    if (yLo - yHi < h * 0.85) out += `<rect x="${x0}" y="${yHi.toFixed(1)}" width="${w}" height="${Math.max(0, yLo - yHi).toFixed(1)}" fill="${T.up}" fill-opacity="0.05"/>`;
    for (const v of [lo, hi]) if (v >= vMin && v <= vMax) out += `<line x1="${x0}" y1="${yOf(v).toFixed(1)}" x2="${x1}" y2="${yOf(v).toFixed(1)}" stroke="${T.up}" stroke-opacity="0.4" stroke-dasharray="${px ? '8 8' : '6 6'}"/>`;
  }
  if (c.zero && 0 >= vMin && 0 <= vMax) out += `<line x1="${x0}" y1="${yOf(0).toFixed(1)}" x2="${x1}" y2="${yOf(0).toFixed(1)}" stroke="${T.muted}" stroke-opacity="0.3" stroke-dasharray="6 6"/>`;
  out += `<path d="${d} V${y1} H${xf} Z" fill="url(#chartFill)"/>`
    + `<path d="${d}" fill="none" stroke="${tint}" stroke-opacity="0.95" stroke-width="${px ? 4 : 2.5}" stroke-linejoin="${px ? 'miter' : 'round'}" stroke-linecap="${px ? 'square' : 'round'}"/>`;
  for (const m of marks) {
    out += `<line x1="${xOf(m.t).toFixed(1)}" y1="${y0}" x2="${xOf(m.t).toFixed(1)}" y2="${y1}" stroke="${T.muted}" stroke-opacity="0.35" stroke-dasharray="4 5"/>`
      + `<${px ? 'rect' : 'circle'} ${px ? `x="${(xOf(m.t) - 5).toFixed(1)}" y="${(yOf(m.v) - 5).toFixed(1)}" width="10" height="10"` : `cx="${xOf(m.t).toFixed(1)}" cy="${yOf(m.v).toFixed(1)}" r="5"`} fill="${T.text}" stroke="${T.bg[T.bg.length - 1]}" stroke-width="2"/>`;
  }
  const yl = yOf(pts[pts.length - 1][1]).toFixed(1);
  out += px ? `<rect x="${xl - 6}" y="${yl - 6}" width="12" height="12" fill="${tint}"/>`
    : `<circle cx="${xl}" cy="${yl}" r="10" fill="${tint}" fill-opacity="0.25"/><circle cx="${xl}" cy="${yl}" r="5" fill="${tint}"/>`;
  return out;
}
function frame(tint, right, body, mascotKey, stampText, chart) {
  const { W, H, k } = G;
  const context = right.replace(` · ${chainName()}`, '');
  const m = MASCOT[mascotKey], mh = G.mascot.h, mw = Math.round((m.w / m.h) * mh);
  const mx = G.mascot.cx != null ? Math.round(G.mascot.cx - mw / 2) : G.mascot.right - mw, my = G.mascot.y;
  const gcx = mx + mw / 2, gcy = my + mh / 2;
  const stops = T.bg.map((c, i) => `<stop offset="${(i / (T.bg.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('');
  // Lencana chain di kaki kanan: ikon bulat + nama, rata kanan.
  const badgeSize = 17 * k, badgeW = measure(chainName(), badgeSize, 500), iconR = 10 * k;
  const badge = (chainNow.href ? `<image x="${W - PAD - badgeW - 12 * k - iconR * 2}" y="${G.footY - 6 * k - iconR}" width="${iconR * 2}" height="${iconR * 2}" clip-path="url(#chain-icon)" href="${chainNow.href}"/>` : '')
    + txt(chainName(), W - PAD, G.footY - 5 * k, { size: badgeSize, weight: 500, color: T.muted, anchor: 'end', base: 'middle' });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${T.font || BASE_FONT.family}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>
  <radialGradient id="glow" cx="${gcx}" cy="${gcy}" r="${mh * 0.95}" gradientUnits="userSpaceOnUse"><stop stop-color="${tint}" stop-opacity="${T.glow}"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient>
  <clipPath id="chain-icon"><circle cx="${W - PAD - badgeW - 12 * k - iconR}" cy="${G.footY - 6 * k}" r="${iconR}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${deco(gcx, gcy, mh / 2)}<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect x="0" y="0" width="${W}" height="${(T.sq ? 6 : 3) * k}" fill="${tint}"/>
<svg x="${PAD}" y="${G.logo.y}" width="${G.logo.w}" height="${G.logo.h}" viewBox="0 0 264 48">${MARK.replace('fill="#fff"', `fill="${T.logo || T.text}"`)}</svg>
${txt(context, W - PAD, G.ctxY, { size: 17 * k, weight: 500, color: T.muted, anchor: 'end', base: 'middle' })}
<line x1="${PAD}" y1="${G.ruleY}" x2="${W - PAD}" y2="${G.ruleY}" stroke="${T.line}"${T.sq ? ' stroke-width="2"' : ''}/>
${badge}
<image x="${mx}" y="${my}" width="${mw}" height="${mh}" href="${m.href}"/>
${stampText ? stamp(stampText, mx + mw * 0.24, my + mh * 0.8, tint) : ''}
${chartSvg(chart, tint)}
${body}
</svg>`;
}

// Judul + chip; berhenti sebelum `right` (kolom maskot di ukuran lebar/persegi).
function title(s, chips, x0 = PAD, right = G.hero.right) {
  const y = G.titleY, k = G.k, size = 32 * k;
  const active = chips.filter(([label]) => label);
  const chipWidth = active.reduce((sum, [label]) => sum + measure(label, 17 * k, 500) + 34 * k, 0);
  const available = right - x0 - chipWidth - 22 * k;
  const text = fit(s, Math.max(120, available), size, 600);
  let x = x0 + measure(text, size, 600) + 22 * k;
  let out = txt(text, x0, y, { size, weight: 600, base: 'middle' });
  for (const [label, style] of active) {
    const c = chip(label, x, y, style); out += c.svg; x += c.w + 10 * k;
  }
  return out;
}
// Angka besar lalu angka kedua di sebelahnya (dolar ↔ persen), keduanya berhenti sebelum
// kolom maskot; ukuran menyusut kalau angkanya panjang.
function hero({ label, big, bigColor, side, sub, subColor = T.muted }) {
  const { labelY, bigY, subY, right, maxBig } = G.hero, k = G.k;
  const room = right - PAD;
  const sideSize = side ? Math.min(40 * k, (room * 0.4) / Math.max(measure(side, 1, 600), 1)) : 0;
  const sideW = side ? measure(side, sideSize, 600) + 22 : 0;
  const size = Math.min(maxBig, (room - sideW) / Math.max(measure(big, 1, 700), 1));
  let out = txt(label, PAD, labelY, { size: 18 * k, weight: 500, color: T.muted });
  out += txt(big, PAD - 3, bigY, { size, weight: 700, color: bigColor });
  if (side) out += txt(side, PAD - 3 + measure(big, size, 700) + 22, bigY, { size: sideSize, weight: 600, color: bigColor });
  if (sub) out += fitted(sub, PAD, subY, room, { size: 19 * k, color: subColor });
  return out;
}
// Kisi ubin statistik (perRow per baris) lalu teks kaki di kiri bawah.
function statsRow(cols, footer) {
  const { W, k } = G, { y, h, perRow } = G.stats, gap = 12;
  const cw = (W - PAD * 2 - gap * (perRow - 1)) / perRow;
  const tall = h >= 140;
  let out = '';
  cols.forEach(([label, value, o = {}], i) => {
    const x = PAD + (i % perRow) * (cw + gap), ty = y + Math.floor(i / perRow) * (h + gap);
    out += `<rect x="${x.toFixed(1)}" y="${ty}" width="${cw.toFixed(1)}" height="${h}" rx="${rx(14)}" fill="${T.panel}" stroke="${T.line}"${T.sq ? ' stroke-width="3"' : ''}/>`;
    const cx = x + 18, width = cw - 36;
    out += fitted(label, cx, ty + (tall ? 34 : 30) * k, width, { size: (tall ? 17 : 15) * k, color: T.muted });
    const size = Math.min((tall ? 50 : 32) * k, width / Math.max(measure(value, 1, 600), 1));
    out += txt(value, cx, ty + (h * 0.55 + (tall ? 12 : 6)) * k, { size, weight: 600, color: o.color || T.text });
    if (o.extra) out += fitted(o.extra[0], cx, ty + (h * 0.8 + 8) * k, width, { size: (tall ? 16 : 15) * k, color: o.extra[1] });
  });
  if (footer) out += fitted(footer, PAD, G.footY, W - PAD * 2 - measure(chainName(), 17 * k, 500) - 60 * k, { size: 15 * k, color: T.faint });
  return out;
}
// Lambang token: logo bulat (PNG/JPEG/GIF yang tersimpan di server — resvg tidak bisa
// WebP, lihat ACCEPT di src/icons.js), atau lingkaran
// berwarna dengan inisial — rona dari alamat, sama dengan TokenIcon di dasbor.
function hue(addr = '') {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}
function token(icon, { address, symbol }, x, y, r, id) {
  const ring = `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${T.bg[T.bg.length - 1]}" stroke-width="3"/>`;
  if (icon && /^image\/(png|jpeg|gif)$/.test(icon.ctype)) {
    return `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>`
      + `<circle cx="${x}" cy="${y}" r="${r}" fill="${T.bg[0]}"/>`
      + `<image x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice" href="data:${icon.ctype};base64,${icon.buf.toString('base64')}"/>` + ring;
  }
  const initials = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${hue((address || '').toLowerCase())}, 45%, 55%)"/>`
    + txt(initials, x, y + 1, { size: Math.round(r * 0.8), weight: 600, color: '#fff', anchor: 'middle', base: 'middle' }) + ring;
}
// Stempel hanya untuk untung besar; kartu rugi tidak perlu ditertawakan.
const stampFor = (m) => (m === 'flex' ? tr('UNTUNG BESAR') : null);

// ---- kartu posisi -----------------------------------------------------------------
// p: baris dari GET /api/position; icons: { token0, token1 } hasil icons.read().
function positionSvg(p, { hideAmounts = false, icons = {}, chart = null } = {}) {
  const closed = p.status === 'closed';
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pNow = closed ? sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide)
    : p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide)
      : p.curTick != null ? tickPrice(p.curTick, p.dec0, p.dec1, p.quoteSide) : null;
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const base = p.quoteSide === 0 ? p.symbol1 : p.symbol0;
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  // Fee yang benar-benar diperoleh: sudah diklaim + (kalau masih terbuka) yang belum.
  const feeUsd = (p.claimedUsd || 0) + (closed ? 0 : (p.feeUsd || 0));
  const status = closed ? tr('Ditutup') : p.empty ? tr('Likuiditas kosong') : p.inRange == null ? tr('belum tersinkron') : p.inRange ? 'in-range' : tr('di luar rentang');
  const pair = `${p.symbol0 || '?'} / ${p.symbol1 || '?'}`;
  const y = G.titleY, r = G.iconR;
  let body = token(icons.token0, { address: p.token0, symbol: p.symbol0 }, PAD + r, y, r, 'c0')
    + token(icons.token1, { address: p.token1, symbol: p.symbol1 }, PAD + r + 38 * G.k, y, r, 'c1');
  body += title(pair, [
    [p.fee != null ? tr('fee {0}%', [num(p.fee / 10000, 2)]) : null],
    [status, closed ? {} : p.inRange ? tone(T.up) : tone(T.amber)],
  ], PAD + 2 * r + 56 * G.k);
  body += hero({
    label: 'PnL', big: p.pnlPct == null ? '—' : pct(p.pnlPct, 2), bigColor: sign(p.pnlUsd),
    side: hideAmounts ? null : usd(p.pnlUsd),
    sub: hideAmounts ? tr('Nominal disembunyikan')
      : tr('{0} modal › {1} {2}', [usd(p.costUsd), usd(closed ? p.outUsd : (p.valueUsd || 0) + (p.feeUsd || 0)), tr(closed ? 'hasil keluar' : 'nilai + fee')]),
    subColor: hideAmounts ? T.faint : T.muted,
  });
  // Harga dinyatakan sebagai pasangan (OPAI/USDG), bukan dolar: itu satuan pool-nya.
  const unit = quote ? ` · ${base}/${quote}` : '';
  body += statsRow([
    [tr('Harga masuk') + unit, price(pEntry)],
    [tr(closed ? 'Harga keluar' : 'Harga sekarang') + unit, price(pNow), { extra: move != null ? [pct(move, 1), sign(move)] : null }],
    [tr('Fee diperoleh'), hideAmounts ? HIDDEN : usd(feeUsd), { color: T.up }],
    [tr(closed ? 'Ditahan' : 'Umur'), age(p.ageHours)],
  ], closed ? `${fmtDate(p.opened_ts)} › ${fmtDate(p.closed_ts)}` : tr('masuk {0}', [fmtDate(p.opened_ts)]));
  const m = mood(p.pnlUsd, p.pnlPct);
  return frame(sign(p.pnlUsd), `${venueName(p.venue)} · ${chainName()}`, body, m, stampFor(m), chart);
}

// ---- kartu total portofolio -------------------------------------------------------
// now/stats: bentuk yang sama dengan /api/portfolio; since: posisi pertama dibuka.
// Angka utamanya sama dengan kartu "PnL bersih" di dasbor: nilai wallet dikurangi modal
// nyata (memuat gas, zap, swap) kalau modal terlacak; kalau tidak, jumlah PnL per posisi.
const totalPnl = (now) => (now.netPnl != null && now.capitalNet != null
  ? { net: true, pnl: now.netPnl, cap: now.capitalNet }
  : { net: false, pnl: now.pnl, cap: now.capital });
function totalSvg({ now, stats, since }, { hideAmounts = false, chart = null } = {}) {
  const { net, pnl, cap } = totalPnl(now);
  const pnlPct = cap > 0 ? (pnl / cap) * 100 : null;
  const wr = stats?.winRatePct;
  const body = title(tr(net ? 'PnL bersih' : 'Total PnL'), [
    [tr('{0} posisi terbuka', [now.openCount || 0])],
    [stats?.closedCount ? tr('{0} ditutup', [stats.closedCount]) : null],
  ]) + hero({
    label: 'PnL', bigColor: sign(pnl),
    big: hideAmounts ? (pnlPct == null ? HIDDEN : pct(pnlPct, 2)) : usd(pnl),
    side: hideAmounts || pnlPct == null ? null : pct(pnlPct, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan')
      : net ? tr('modal {0} · PnL posisi {1}', [usd(cap), usd(now.pnl)])
        : tr('terealisasi {0} · berjalan {1}', [usd(now.realizedUsd), usd(now.unrealizedUsd)]),
    subColor: hideAmounts ? T.faint : T.muted,
  }) + statsRow([
    [tr('Total portofolio'), hideAmounts ? HIDDEN : usd(now.value)],
    [tr('Win rate'), wr == null ? '—' : `${num(wr, 0)}%`, { color: wr == null ? T.text : wr >= 50 ? T.up : T.down,
      extra: stats?.closedCount ? [tr('{0} menang · {1} kalah', [stats.wins, stats.losses]), T.muted] : null }],
    [tr('Fee terkumpul'), hideAmounts ? HIDDEN : usd(now.feeUsd), { color: T.up }],
    [tr('Posisi terbaik'), stats?.best == null ? '—' : hideAmounts ? HIDDEN : usd(stats.best), { color: sign(stats?.best) }],
  ], since ? tr('sejak {0} · {1}', [fmtDayOnly(since), fmtDate(Date.now())]) : fmtDate(Date.now()));
  const m = mood(pnl, pnlPct);
  return frame(sign(pnl), tr('Seluruh portofolio') + ` · ${chainName()}`, body, m, stampFor(m), chart);
}

// ---- kartu PnL harian ---------------------------------------------------------------
// day 'YYYY-MM-DD'; rows: posisi yang ditutup hari itu [{symbol0,symbol1,pnl,cost}];
// total/count dari kalender (daftar posisi tertutup bisa terpotong); monthTotal: PnL bulan itu.
function dailySvg({ day, rows, total: totalIn, count, monthTotal }, { hideAmounts = false, chart = null } = {}) {
  const total = totalIn ?? rows.reduce((a, r) => a + r.pnl, 0);
  const ts = new Date(day + 'T12:00:00').getTime();
  const wins = rows.filter((r) => r.pnl > 0.005).length, losses = rows.filter((r) => r.pnl < -0.005).length;
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const dayPct = cost > 0 ? (total / cost) * 100 : null;
  const best = rows.reduce((a, r) => (a == null || r.pnl > a.pnl ? r : a), null);
  const worst = rows.reduce((a, r) => (a == null || r.pnl < a.pnl ? r : a), null);
  // Cukup token spekulatifnya: "USDG/OPAI" terlalu panjang untuk satu kolom.
  const nameOf = (r) => (r ? ` · ${QUOTE.has(r.symbol0) ? r.symbol1 || '?' : r.symbol0 || '?'}` : '');
  const val = (r) => (r ? (hideAmounts ? (r.cost > 0 ? pct((r.pnl / r.cost) * 100, 1) : HIDDEN) : usd(r.pnl)) : '—');
  const body = title(fmtDay(ts), [[tr('{0} posisi ditutup', [count ?? rows.length])]]) + hero({
    label: tr('PnL terealisasi'), bigColor: sign(total),
    big: hideAmounts ? (dayPct == null ? HIDDEN : pct(dayPct, 2)) : usd(total),
    side: hideAmounts || dayPct == null ? null : pct(dayPct, 2),
    sub: tr('{0} menang · {1} kalah', [wins, losses]) + (hideAmounts || !(cost > 0) ? '' : ` · ${tr('modal diputar {0}', [usd(cost)])}`),
  }) + statsRow([
    [tr('Posisi terbaik') + nameOf(best), val(best), { color: sign(best?.pnl) }],
    [tr('Posisi terburuk') + nameOf(worst), val(worst), { color: sign(worst?.pnl) }],
    [tr('Win rate'), rows.length ? `${num((wins / rows.length) * 100, 0)}%` : '—', { color: !rows.length ? T.text : wins / rows.length >= 0.5 ? T.up : T.down }],
    [tr('Bulan ini'), hideAmounts ? HIDDEN : usd(monthTotal), { color: sign(monthTotal) }],
  ], tr('PnL terealisasi dari posisi yang ditutup pada {0}', [fmtDayOnly(ts)]));
  const m = mood(total, dayPct);
  return frame(sign(total), tr('PnL harian') + ` · ${chainName()}`, body, m, stampFor(m), chart);
}

// Pilih kartu dan gambar. lang 'id'|'en'; timeZone nama IANA (mis. 'Asia/Jakarta');
// size/theme salah satu kunci SIZES/THEMES (yang tidak dikenal jatuh ke bawaan).
const sizeKey = (s) => (SIZES[s] ? s : 'wide');
const themeKey = (t) => (THEMES[t] ? t : 'dark');
function svgOf(kind, data, opts = {}) {
  return localeContext.run(opts.lang === 'en' ? 'en' : 'id', () => {
    tz = opts.timeZone || null;
    T = THEMES[themeKey(opts.theme)];
    G = geometry(sizeKey(opts.size));
    chainNow = CHAIN_BADGE[opts.chain?.key] || { label: opts.chain?.label || CHAIN_BADGE.robinhood.label, href: '' };
    try {
      if (kind === 'position') return positionSvg(data, opts);
      if (kind === 'total') return totalSvg(data, opts);
      if (kind === 'daily') return dailySvg(data, opts);
      throw new Error(`jenis kartu tidak dikenal: ${kind}`);
    } finally { tz = null; T = THEMES.dark; G = null; chainNow = CHAIN_BADGE.robinhood; }
  });
}
// Nama venue untuk kartu: v4/v3 = Uniswap, pancakev3 = PancakeSwap.
const venueName = (v) => (v === 'pancakev3' ? 'PancakeSwap V3' : `Uniswap ${String(v || '').toUpperCase()}`);
function renderPng(svg, size) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZES[sizeKey(size)].W * SCALE },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: BASE_FONT.family },
  });
  return Buffer.from(r.render().asPng());
}
const render = (kind, data, opts = {}) => renderPng(svgOf(kind, data, opts), opts.size);

// Teks pendamping (caption Telegram / teks Web Share) — angka mengikuti bahasa.
function caption(kind, data, lang) {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => {
    if (kind === 'position') return `${data.symbol0 || '?'} / ${data.symbol1 || '?'} ${data.pnlPct == null ? '' : pct(data.pnlPct, 2)} · Quiver`;
    if (kind === 'total') { const { net, pnl } = totalPnl(data.now); return `${tr(net ? 'PnL bersih' : 'Total PnL')} ${usd(pnl)} · Quiver`; }
    return `PnL ${data.day}: ${usd(data.total ?? data.rows.reduce((a, r) => a + r.pnl, 0))} · Quiver`;
  });
}

module.exports = { svgOf, renderPng, render, caption, sizeKey, themeKey, SIZES, THEMES, W: SIZES.wide.W, H: SIZES.wide.H, SCALE };
