'use strict';
// Share card: a PnL image ready to paste into X/Telegram, like the ones
// Based bot or GMGN have. Four kinds of card with the same frame:
//   position  one LP position: pair, PnL, entry/exit price, fee, age
//   total     the whole portfolio: total PnL, win rate, fee, best position
//   daily     one day: the realized PnL of that day, the positions closed
//   month     one month of the PnL calendar as a grid of days
//
// Each card can be drawn in three sizes (opts.size) and seven colour themes
// (opts.theme), see SIZES and THEMES. One layout: header (logo + context),
// title + chip, big number, chart strip (opts.chart: position price / PnL curve / daily
// bars), mascot, stats grid, footer (date + chain) — only the
// coordinates differ per size (geometry()).
//
// Drawn on the server as SVG then rasterised by resvg — not in the browser — so the
// dashboard and the Telegram bot send exactly the same image from one design source.
// The fonts are bundled (public/fonts/*.ttf: Urbanist for the card, Pixelify Sans for the
// pixel theme — four static weights made from the Google Fonts variable files with
// fontTools) because the VPS has no system fonts; text widths for chips and titles
// are computed from the glyph advance table (src/*-advances.json, made from the same font) —
// resvg has no text-measuring API, and SVG has no flowing layout.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg, renderAsync: renderAsyncRaw } = require('@resvg/resvg-js');
// The card's base font and its glyph width table (made from the same font file,
// see the note above measure()). A theme may override via font/adv (pixel).
const BASE_FONT = { family: 'Urbanist', adv: require('./urbanist-advances.json') };
const ADV_PIXEL = require('./pixelify-advances.json');
const { tr, localeContext } = require('./telegram-i18n');

const PAD = 56, SCALE = 2;
// Card sizes. wide = X/Telegram link card; square = Instagram/Threads feed;
// story = Instagram Story / WhatsApp status (content kept away from the top/bottom edges that are
// covered by the app UI).
const SIZES = {
  wide: { W: 1200, H: 630, label: 'Lebar' },
  square: { W: 1080, H: 1080, label: 'Persegi' },
  story: { W: 1080, H: 1920, label: 'Story' },
};
// Colour themes. bg = background gradient (top-left → bottom-right); up/down/flat = PnL colours;
// accent = background decoration colour (deco: grid/dots/circles/diagonal lines/checkerboard);
// logo = wordmark colour (a light theme needs a dark logo); font/adv = another font along with
// its width table (pixel); sq = square corners & thick lines in 8-bit UI style.
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
  // Dark horror: blood moon, rock crags with flames, embers — and its
  // own mascot (a little demon instead of the fox). Up is flame yellow so it does not
  // vanish into the red.
  hell: {
    label: 'Neraka', bg: ['#2A0707', '#120303', '#060101'], text: '#FBEFE6', muted: '#D2A79C', faint: '#9A7067',
    line: 'rgba(255,90,70,0.2)', panel: 'rgba(200,30,30,0.08)', chip: 'rgba(200,30,30,0.18)',
    up: '#FFD23F', down: '#FF5A4E', flat: '#EBD6CC', amber: '#FFB23F', accent: '#B3121B', deco: 'hell', glow: 0.26,
    mascot: 'devil',
  },
};
const HIDDEN = '••••';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
// Every .ttf in public/fonts is loaded; resvg picks the family & weight from the name inside the file.
const FONTS = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONT_DIR, f));
const MARK = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-white.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
// Chain icon & name in the card footer (each chain's official logo in public/). Set per render
// via opts.chain.
const CHAIN_BADGE = {
  robinhood: { label: 'Robinhood Chain', href: `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'robinhood-chain.jpg')).toString('base64')}` },
  bsc: { label: 'BNB Smart Chain', href: `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'bnb-chain.png')).toString('base64')}` },
};
for (const [key, label] of [['ethereum', 'Ethereum'], ['base', 'Base'], ['arbitrum', 'Arbitrum One'], ['optimism', 'Optimism'], ['polygon', 'Polygon'], ['avalanche', 'Avalanche C-Chain']]) {
  CHAIN_BADGE[key] = { label, href: `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', `${key}-chain.png`)).toString('base64')}` };
}
let chainNow = CHAIN_BADGE.robinhood;
const chainName = () => chainNow.label;
// Mascots, the expression follows the PnL (transparent PNG, 900 px tall): the fox in
// public/mascots/*.png, other sets in a subfolder picked by a theme's `mascot` key
// (devil = public/mascots/devil/). Loaded once per process.
const loadMascot = (dir) => Object.fromEntries(['flex', 'profit', 'loss', 'neutral'].map((m) => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'mascots', dir, `${m}.png`));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  return [m, { href: `data:image/png;base64,${png.toString('base64')}`, w, h }];
}));
const MASCOTS = { fox: loadMascot(''), devil: loadMascot('devil') };
const mascotOf = (key) => (MASCOTS[T.mascot] || MASCOTS.fox)[key];
// flex: a big profit (≥ FLEX_PCT% of capital); profit/loss: PnL direction; neutral: zero / no data yet.
const FLEX_PCT = 20;
const mood = (pnl, pnlPct) => (pnl > 0.005 ? (pnlPct >= FLEX_PCT ? 'flex' : 'profit') : pnl < -0.005 ? 'loss' : 'neutral');
const QUOTE = new Set(['USDG', 'WETH', 'ETH', 'USDC', 'USDT']);

// State of one render: theme, geometry, time zone. Set by svgOf(), restored afterwards.
let T = THEMES.dark;
let G = null;
let tz = null;
const TZ = () => tz || undefined;
// PnL colours per theme.
const sign = (v) => (v > 0.005 ? T.up : v < -0.005 ? T.down : T.flat);
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// Coordinates per size. k = text scale; hero.right = right bound of the big number text
// (the mascot column starts there); mascot.right / mascot.cx = right-aligned or centred;
// stats.perRow = number of stat tiles per row; footY = footer line (date + chain);
// chart = chart strip under the big number (from PAD to chart.x1, default hero.right).
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

// ---- number formats, exactly the same as web/src/fmt.js ----------------------------
const loc = () => (localeContext.getStore() === 'en' ? 'en-US' : 'id-ID');
// Amounts are dollars unless the card is drawn in the Settings currency (opts.fx, set per
// render in fxNow): then the same value times the rate, e.g. "Rp1.307.300" or "Rp22,4 jt".
let fxNow = null;
// abs: a non-negative amount already in fxNow's currency. compact (calendar cells): shorten
// from a thousand up, no spaces, decimals only below 10 of the unit ("Rp224rb", "Rp7,2jt");
// otherwise shorten only from a million up ("Rp1.307.300", "Rp22,4 jt").
function fxAmount(abs, compact = false) {
  const o = { style: 'currency', currency: fxNow.currency, minimumFractionDigits: 0, maximumFractionDigits: abs < 100 ? 2 : 0 };
  if (abs >= (compact ? 1e3 : 1e6)) {
    o.notation = 'compact';
    o.maximumFractionDigits = compact ? (Number(new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 }).format(abs).replace(/\D/g, '')) < 10 ? 1 : 0) : 1;
  }
  // Intl puts a no-break space between the symbol and the digits in some locales ("Rp 22,4 jt").
  const out = new Intl.NumberFormat(loc(), o).format(abs).replace(/^([^\d\s]+)\s+/, '$1');
  return compact ? out.replace(/\s+/g, '') : out.replace(/\u00A0/g, ' ');
}
const usd = (v, d = 2) => (v == null || Number.isNaN(v) ? '—'
  : fxNow ? (v < 0 ? '−' : '') + fxAmount(Math.abs(v * fxNow.rate))
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
// Price from sqrtPriceX96 / tick — a copy of fmt.js.
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

// ---- SVG primitives ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Text width from the theme font's advance table (weights 500 & 600 are available; other weights use 600).
function measure(s, size, weight = 500) {
  const adv = T.adv || BASE_FONT.adv;
  const tab = adv[String(weight)] || adv['600'];
  let w = 0;
  for (const ch of String(s)) w += tab[ch] ?? 0.6;
  return w * size;
}
// `base` 'middle' imitates the canvas textBaseline: the baseline is lowered ~0.36 em.
function txt(s, x, y, { size = 16, weight = 400, color = T.text, anchor = 'start', base = 'alphabetic', spans = '' } = {}) {
  const yy = base === 'middle' ? y + size * 0.36 : y;
  return `<text x="${x}" y="${yy}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}${spans}</text>`;
}
// Rounded corners — zero in the pixel theme.
const rx = (n) => (T.sq ? 0 : n);
function chip(s, x, y, { color = T.muted, fill = T.chip } = {}) {
  const size = 17 * G.k, w = measure(s, size, 500) + 24 * G.k, h = 32 * G.k;
  return { w, svg: `<rect x="${x}" y="${y - h / 2}" width="${w.toFixed(1)}" height="${h}" rx="${rx(8 * G.k)}" fill="${fill}"/>` + txt(s, x + 12 * G.k, y, { size, weight: 500, color, base: 'middle' }) };
}
// Coloured status chip: text colour from the theme, background the same colour but transparent.
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

// Background decoration per theme: a thin pattern over the whole card, or circles behind the mascot.
function deco(cx, cy, r, behindArt = false) {
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
    // A subtle checkerboard + random blocks (deterministic) like an 8-bit star.
    let blocks = '';
    for (let i = 0; i < 40; i++) {
      const s = (i * 7919) % 1000, x = ((s * 37) % (G.W / 16)) * 16, y = ((s * 53) % (G.H / 16)) * 16;
      blocks += `<rect x="${x}" y="${y}" width="16" height="16" fill="${a}" fill-opacity="${i % 3 ? 0.06 : 0.12}"/>`;
    }
    return `<defs><pattern id="deco" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="${a}" fill-opacity="0.035"/><rect x="16" y="16" width="16" height="16" fill="${a}" fill-opacity="0.035"/></pattern></defs>`
      + `<rect width="${G.W}" height="${G.H}" fill="url(#deco)"/>` + blocks;
  }
  if (T.deco === 'hell') return hellDeco(cx, cy, r, behindArt);
  return '';
}
// Deterministic pseudo-random in [0, 1) so every render of a card is identical.
const rand = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// Jagged rock ridge along the bottom of a W×H card: peaks between `lift` and `lift + tall`
// above the bottom edge, as one closed path.
function crags(W, H, lift, tall, seed) {
  let d = `M0 ${H}`, x = 0, i = seed;
  while (x < W) {
    d += `L${x.toFixed(1)} ${(H - lift - tall * (0.15 + rand(i++) * 0.85)).toFixed(1)}`;
    x += 18 + rand(i++) * 56;
  }
  return `${d}L${W} ${(H - lift - tall * 0.4).toFixed(1)}L${W} ${H}Z`;
}
// A row of flame tongues rising from the bottom edge, up to `tall` high.
function flames(W, H, tall, seed) {
  let d = `M0 ${H}`, x = 0, i = seed;
  while (x < W) {
    const w = 30 + rand(i++) * 50, h = tall * (0.35 + rand(i++) * 0.65), lean = (rand(i++) - 0.5) * w * 0.8;
    d += `Q${(x + w * 0.1).toFixed(1)} ${(H - h * 0.6).toFixed(1)} ${(x + w / 2 + lean).toFixed(1)} ${(H - h).toFixed(1)}`
      + `Q${(x + w * 0.9).toFixed(1)} ${(H - h * 0.5).toFixed(1)} ${(x + w).toFixed(1)} ${H}`;
    x += w * 0.7;
  }
  return `${d}Z`;
}
// Hell theme backdrop: a blood moon behind the mascot (cx, cy, r = its centre and half
// height), rock crags and flames along the bottom, and rising embers. Behind the month calendar (`behindArt`) the
// moon moves to the top-right corner and dims so the day figures stay readable.
function hellDeco(cx, cy, r, behindArt = false) {
  const { W, H } = G, a = T.accent;
  const mr = behindArt ? Math.min(W, H) * 0.2 : r * 0.78;
  const mx = behindArt ? W - mr * 0.55 : cx + r * 0.3, my = behindArt ? mr * 0.45 : cy - r * 0.5;
  let out = `<defs><radialGradient id="moon" cx="${mx - mr * 0.25}" cy="${my - mr * 0.3}" r="${mr * 1.2}" gradientUnits="userSpaceOnUse"><stop stop-color="#E0262E"/><stop offset="1" stop-color="${a}"/></radialGradient>`
    + `<radialGradient id="moonHalo" cx="${mx}" cy="${my}" r="${mr * 1.9}" gradientUnits="userSpaceOnUse"><stop offset="0.45" stop-color="${a}" stop-opacity="0.35"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>`
    + '</defs>'
    + `<circle cx="${mx}" cy="${my}" r="${mr * 1.9}" fill="url(#moonHalo)"/><circle cx="${mx}" cy="${my}" r="${mr}" fill="url(#moon)" fill-opacity="${behindArt ? 0.4 : 0.85}"/>`;
  // Jagged crags (two rows) with a band of flame tongues between them.
  out += `<defs><linearGradient id="flame" x1="0" y1="1" x2="0" y2="0"><stop stop-color="#FF7A1A" stop-opacity="0.85"/><stop offset="0.55" stop-color="#E0262E" stop-opacity="0.45"/><stop offset="1" stop-color="#E0262E" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${crags(W, H, H * 0.12, H * 0.3, 11)}" fill="#2E0507" fill-opacity="0.75"/>`
    + `<path d="${flames(W, H, H * 0.2, 41)}" fill="url(#flame)"/>`
    + `<path d="${crags(W, H, H * 0.08, H * 0.12, 97)}" fill="#000" fill-opacity="0.85"/>`;
  // Embers drifting up.
  for (let i = 0; i < 46; i++) {
    const ex = rand(i + 500) * W, ey = H * (0.25 + rand(i + 900) * 0.75), er = 1 + rand(i + 1300) * 2.4;
    out += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${er.toFixed(1)}" fill="${i % 3 ? '#FF7A3D' : T.up}" fill-opacity="${(0.25 + rand(i + 1700) * 0.5).toFixed(2)}"/>`;
  }
  // No film grain on the card: as an SVG filter it tripled the render time, and as a noise
  // tile it doubled the PNG size — for an effect barely visible once compressed by X/Telegram.
  return out;
}
// Tilted stamp above the mascot ("BIG WIN" when flex).
function stamp(s, cx, cy, color) {
  const size = 24 * G.k, w = measure(s, size, 600) + 48 * G.k, h = 52 * G.k;
  return `<g transform="translate(${cx} ${cy}) rotate(-12)" opacity="0.94">`
    + `<rect x="${-w / 2}" y="${-h / 2}" width="${w.toFixed(1)}" height="${h}" rx="${rx(10 * G.k)}" fill="${rgba(color, 0.1)}" stroke="${color}" stroke-width="${4 * G.k}"/>`
    + `<rect x="${-w / 2 + 7 * G.k}" y="${-h / 2 + 7 * G.k}" width="${(w - 14 * G.k).toFixed(1)}" height="${h - 14 * G.k}" rx="${rx(5 * G.k)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.6"/>`
    + txt(s, 0, 0, { size, weight: 700, color, anchor: 'middle', base: 'middle' }) + '</g>';
}

// Chart strip under the big number: price line / PnL curve (kind 'line') or bars of the
// daily PnL of a month (kind 'bars').
//   line: pts [[t, v]], band [lo, hi] (LP range), marks [{t, v}] (entry/exit), zero (zero line)
//   bars: bars [{ v, on }] — `on` = the day being shared
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
  // At most ~160 points: the portfolio history every 5 minutes can be thousands.
  if (pts.length > 160) { const step = Math.ceil(pts.length / 160); pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1); }
  const marks = (c.marks || []).filter((m) => Number.isFinite(m.t) && Number.isFinite(m.v));
  const vals = [...pts.map(([, v]) => v), ...marks.map((m) => m.v)];
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (c.zero) { vMin = Math.min(vMin, 0); vMax = Math.max(vMax, 0); }
  // The LP range is included if not too far from the price; if far, it is cut at the edge.
  const span0 = Math.max(vMax - vMin, Math.abs(vMax) * 1e-6, 1e-12);
  if (c.band) {
    vMin = Math.min(vMin, Math.max(c.band[0], vMin - span0 * 0.6));
    vMax = Math.max(vMax, Math.min(c.band[1], vMax + span0 * 0.6));
  }
  const span = (vMax - vMin) || 1;
  vMin -= span * 0.08; vMax += span * 0.08;
  const t0 = Math.min(pts[0][0], ...marks.map((m) => m.t)), t1 = Math.max(pts[pts.length - 1][0], ...marks.map((m) => m.t));
  const xOf = (t) => x0 + ((t - t0) / Math.max(t1 - t0, 1)) * w, yOf = (v) => y1 - ((v - vMin) / (vMax - vMin)) * h;
  // Pixel theme: stepped line (steps), not diagonal.
  let d = '';
  pts.forEach(([t, v], i) => {
    const x = xOf(t).toFixed(1), y = yOf(v).toFixed(1);
    d += i === 0 ? `M${x} ${y}` : px ? ` H${x} V${y}` : ` L${x} ${y}`;
  });
  const xl = xOf(pts[pts.length - 1][0]).toFixed(1), xf = xOf(pts[0][0]).toFixed(1);
  let out = `<defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${tint}" stop-opacity="0.32"/><stop offset="1" stop-color="${tint}" stop-opacity="0.02"/></linearGradient></defs>`;
  if (c.band) {
    const [lo, hi] = c.band, yLo = Math.min(y1, yOf(lo)), yHi = Math.max(y0, yOf(hi));
    // The band fill only if the range does not fill almost the whole band (if it does, the line alone suffices).
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
  const m = mascotOf(mascotKey), mh = G.mascot.h, mw = Math.round((m.w / m.h) * mh);
  const mx = G.mascot.cx != null ? Math.round(G.mascot.cx - mw / 2) : G.mascot.right - mw, my = G.mascot.y;
  const gcx = mx + mw / 2, gcy = my + mh / 2;
  const stops = T.bg.map((c, i) => `<stop offset="${(i / (T.bg.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('');
  // Chain badge at the bottom right: round icon + name, right-aligned.
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

// Title + chip; stops before `right` (the mascot column in wide/square sizes).
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
// The big number then a second number beside it (dollar ↔ percent), both stopping before
// the mascot column; the size shrinks if the number is long.
// Widest the hero figure may get, as a share of its row: long figures (e.g. "+IDR169,121")
// otherwise grow edge to edge and swamp the card.
const BIG_SHARE = 0.72;
function hero({ label, big, bigColor, side, sub, subColor = T.muted }) {
  const { labelY, bigY, subY, right, maxBig } = G.hero, k = G.k;
  const room = right - PAD;
  const sideSize = side ? Math.min(40 * k, (room * 0.4) / Math.max(measure(side, 1, 600), 1)) : 0;
  const sideW = side ? measure(side, sideSize, 600) + 22 : 0;
  const size = Math.min(maxBig, (room * BIG_SHARE - sideW) / Math.max(measure(big, 1, 700), 1));
  let out = txt(label, PAD, labelY, { size: 18 * k, weight: 500, color: T.muted });
  out += txt(big, PAD - 3, bigY, { size, weight: 700, color: bigColor });
  if (side) out += txt(side, PAD - 3 + measure(big, size, 700) + 22, bigY, { size: sideSize, weight: 600, color: bigColor });
  if (sub) out += fitted(sub, PAD, subY, room, { size: 19 * k, color: subColor });
  return out;
}
// Grid of stat tiles (perRow per row) then footer text at the bottom left.
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
  return out + footerLine(footer);
}
function footerLine(footer) {
  const { W, k } = G;
  return footer ? fitted(footer, PAD, G.footY, W - PAD * 2 - measure(chainName(), 17 * k, 500) - 60 * k, { size: 15 * k, color: T.faint }) : '';
}
// Top gainers / top losers with the coin logo (opts.movers, built by the server from the closed
// positions of the window): two columns side by side, or stacked when the region is narrow.
// Rows adapt to the room: up to three each, at least one.
function moversBlock(m, { x, y, w, h, stacked = false }, hideAmounts, idp = 'mv') {
  const k = G.k, headH = 26 * k, gap = 28 * k;
  const secH = stacked ? (h - gap / 2) / 2 : h, colW = stacked ? w : (w - gap) / 2;
  const rows = Math.max(1, Math.min(3, Math.floor((secH - headH) / (30 * k))));
  const rowH = Math.min(46 * k, (secH - headH) / rows), r = Math.min(rowH * 0.38, 20 * k);
  let out = '';
  [[tr('Top untung'), m.up, T.up], [tr('Top rugi'), m.down, T.down]].forEach(([label, list, color], i) => {
    const sx = stacked ? x : x + i * (colW + gap), sy = stacked ? y + i * (secH + gap / 2) : y;
    out += `<rect x="${sx}" y="${sy + 2}" width="${3 * k}" height="${headH - 6 * k}" rx="${rx(1.5 * k)}" fill="${color}" fill-opacity="0.8"/>`
      + caps(label, sx + 12 * k, sy + 15 * k, { size: 13 * k, ls: 0.12 }).svg;
    if (!list.length) out += txt('—', sx + 12 * k, sy + headH + rowH / 2, { size: 20 * k, color: T.faint, base: 'middle' });
    list.slice(0, rows).forEach((c, j) => {
      const cy = sy + headH + j * rowH + rowH / 2;
      const val = hideAmounts ? (c.pct == null ? HIDDEN : pct(c.pct, 1)) : usd(c.pnl);
      const size = Math.min(24 * k, rowH * 0.5), vw = measure(val, size, 600);
      out += token(c.icon, { address: c.address, symbol: c.symbol }, sx + 12 * k + r, cy, r, `${idp}${i}${j}`)
        + txt(fit(c.symbol, colW - 12 * k - r * 2 - 12 * k - vw - 14 * k, size, 600), sx + 12 * k + r * 2 + 12 * k, cy, { size, weight: 600, base: 'middle' })
        + txt(val, sx + colW, cy, { size, weight: 600, color, anchor: 'end', base: 'middle' });
    });
  });
  return out;
}
// Token icon: a round logo (PNG/JPEG/GIF stored on the server — resvg cannot read
// WebP, see ACCEPT in src/icons.js), or a coloured
// circle with an initial — the hue from the address, the same as TokenIcon on the dashboard.
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
// The stamp is only for a big profit; a loss card need not be laughed at.
const stampFor = (m) => (m === 'flex' ? tr('UNTUNG BESAR') : null);

// ---- position card -----------------------------------------------------------------
// p: row from GET /api/position; icons: { token0, token1 } result of icons.read().
function positionSvg(p, { hideAmounts = false, icons = {}, chart = null } = {}) {
  const closed = p.status === 'closed';
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pNow = closed ? sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide)
    : p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide)
      : p.curTick != null ? tickPrice(p.curTick, p.dec0, p.dec1, p.quoteSide) : null;
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const base = p.quoteSide === 0 ? p.symbol1 : p.symbol0;
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  // Fee actually earned: already claimed + (if still open) the unclaimed.
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
  // The price is stated as the pair (OPAI/USDG), not dollars: that is the pool's unit.
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

// ---- portfolio total card -------------------------------------------------------
// now/stats: the same shape as /api/portfolio; since: when the first position was opened.
// The main figure is the same as the "Net PnL" card on the dashboard: wallet value minus the real
// capital (including gas, zap, swap) if capital is tracked; otherwise, the sum of per-position PnL.
// Timeframe chip of the total card: nothing for the whole history.
const rangeLabel = (r) => (r && r !== 'all' ? String(r).toUpperCase() : null);
const totalPnl = (now) => (now.netPnl != null && now.capitalNet != null
  ? { net: true, pnl: now.netPnl, cap: now.capitalNet }
  : { net: false, pnl: now.pnl, cap: now.capital });
function totalSvg({ now, stats, since, range }, { hideAmounts = false, chart = null, movers = null } = {}) {
  const { net, pnl, cap } = totalPnl(now);
  const pnlPct = cap > 0 ? (pnl / cap) * 100 : null;
  const wr = stats?.winRatePct;
  const footer = since ? tr('sejak {0} · {1}', [fmtDayOnly(since), fmtDate(Date.now())]) : fmtDate(Date.now());
  const tiles = [
    [tr('Total portofolio'), hideAmounts ? HIDDEN : usd(now.value)],
    [tr('Win rate'), wr == null ? '—' : `${num(wr, 0)}%`, { color: wr == null ? T.text : wr >= 50 ? T.up : T.down,
      extra: stats?.closedCount ? [tr('{0} menang · {1} kalah', [stats.wins, stats.losses]), T.muted] : null }],
    [tr('Fee terkumpul'), hideAmounts ? HIDDEN : usd(now.feeUsd), { color: T.up }],
    [tr('Posisi terbaik'), stats?.best == null ? '—' : hideAmounts ? HIDDEN : usd(stats.best), { color: sign(stats?.best) }],
  ];
  const body = title(tr(net ? 'PnL bersih' : 'Total PnL'), [
    [rangeLabel(range), tone(T.amber)],
    [tr('{0} posisi terbuka', [now.openCount || 0])],
    [stats?.closedCount ? tr('{0} ditutup', [stats.closedCount]) : null],
    [movers && wr != null ? tr('win rate {0}%', [num(wr, 0)]) : null],
  ]) + hero({
    label: 'PnL', bigColor: sign(pnl),
    big: hideAmounts ? (pnlPct == null ? HIDDEN : pct(pnlPct, 2)) : usd(pnl),
    side: hideAmounts || pnlPct == null ? null : pct(pnlPct, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan')
      : net ? tr('modal {0} · PnL posisi {1}', [usd(cap), usd(now.pnl)])
        : tr('terealisasi {0} · berjalan {1}', [usd(now.realizedUsd), usd(now.unrealizedUsd)]),
    subColor: hideAmounts ? T.faint : T.muted,
  }) + (movers
    ? moversBlock(movers, { x: PAD, y: G.stats.y, w: G.W - PAD * 2, h: G.footY - 24 * G.k - G.stats.y }, hideAmounts) + footerLine(footer)
    : statsRow(tiles, footer));
  const m = mood(pnl, pnlPct);
  return frame(sign(pnl), tr('Seluruh portofolio') + ` · ${chainName()}`, body, m, stampFor(m), chart);
}

// ---- daily PnL card ---------------------------------------------------------------
// day 'YYYY-MM-DD'; rows: positions closed that day [{symbol0,symbol1,pnl,cost}];
// total/count from the calendar (the closed positions list can be truncated); monthTotal: that month's PnL.
function dailySvg({ day, rows, total: totalIn, count, monthTotal }, { hideAmounts = false, chart = null } = {}) {
  const total = totalIn ?? rows.reduce((a, r) => a + r.pnl, 0);
  const ts = new Date(day + 'T12:00:00').getTime();
  const wins = rows.filter((r) => r.pnl > 0.005).length, losses = rows.filter((r) => r.pnl < -0.005).length;
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const dayPct = cost > 0 ? (total / cost) * 100 : null;
  const best = rows.reduce((a, r) => (a == null || r.pnl > a.pnl ? r : a), null);
  const worst = rows.reduce((a, r) => (a == null || r.pnl < a.pnl ? r : a), null);
  // Just the speculative token: "USDG/OPAI" is too long for a single column.
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

// ---- "spotlight" layout --------------------------------------------------------------
// A poster-style alternative to the classic grid: one huge PnL figure on the left, the
// mascot large on the right with a glow behind it, the chain as a pill at the top right,
// and three small stats marked by a tinted bar instead of boxed tiles. No chart strip.
// The same data and themes as the classic cards; only the composition differs.
//   meta   small spaced caps line above the title (venue · fee tier)
//   big    the hero figure, pill = the second figure (%) in a tinted capsule
//   stats  [[label, value, color?]] — exactly three
function spotGeometry(size) {
  const { W, H } = SIZES[size] || SIZES.wide;
  if (size === 'story') {
    return { W, H, k: 1.3, logoY: 190, metaY: 330, titleY: 410, labelY: 530, bigY: 700, pillY: 778, maxBig: 200, right: W - PAD,
      stats: { y: 880, cols: 3 }, mascot: { h: 760, maxW: 900, cx: W / 2, bottom: 1780 }, footY: 1800 };
  }
  if (size === 'square') {
    return { W, H, k: 1.45, logoY: 56, metaY: 196, titleY: 278, labelY: 396, bigY: 556, pillY: 636, maxBig: 190, right: W - PAD,
      stats: { y: 712, cols: 1, w: 500, rowH: 100 }, mascot: { h: 500, maxW: 440, right: W - 20, bottom: H + 20 }, footY: H - 40 };
  }
  return { W, H, k: 1, logoY: 44, metaY: 150, titleY: 208, labelY: 298, bigY: 402, pillY: 452, maxBig: 116, right: 700,
    stats: { y: 506, cols: 3 }, mascot: { h: 540, maxW: 480, right: W - 36, bottom: H + 28 }, footY: H - 26 };
}
// Upper-case label with letter spacing; measure() knows nothing about the spacing, so it is added here.
function caps(s, x, y, { size, color = T.muted, ls = 0.18, anchor = 'start' }) {
  const up = String(s).toUpperCase();
  return { w: measure(up, size, 600) + up.length * size * ls, svg: `<text x="${x}" y="${y}" font-size="${size}" font-weight="600" fill="${color}" letter-spacing="${(size * ls).toFixed(2)}" text-anchor="${anchor}">${esc(up)}</text>` };
}
// `art`: SVG drawn instead of the mascot (the month calendar), placed by its own geometry.
function spotlight({ meta, icons, title: titleText, chips = [], label, big, tint, pill, sub, stats, footer, mascotKey, art, movers = null }) {
  const S = G, { W, H, k } = S;
  // The wide poses (loss/neutral) are shrunk so they stay clear of the text column.
  const m = art ? null : mascotOf(mascotKey);
  const mh = m ? Math.min(S.mascot.h, Math.round(S.mascot.maxW * (m.h / m.w))) : S.cal.h, mw = m ? Math.round((m.w / m.h) * mh) : S.cal.w;
  const mx = m ? (S.mascot.cx != null ? Math.round(S.mascot.cx - mw / 2) : S.mascot.right - mw) : S.cal.x, my = m ? S.mascot.bottom - mh : S.cal.y;
  const gcx = mx + mw / 2, gcy = my + mh * 0.45;
  const stops = T.bg.map((c, i) => `<stop offset="${(i / (T.bg.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('');
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${T.font || BASE_FONT.family}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>
  <radialGradient id="glow" cx="${gcx}" cy="${gcy}" r="${mh * 0.75}" gradientUnits="userSpaceOnUse"><stop stop-color="${tint}" stop-opacity="${(T.glow * 1.6).toFixed(2)}"/><stop offset="0.55" stop-color="${tint}" stop-opacity="${(T.glow * 0.45).toFixed(2)}"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient>
  <radialGradient id="glow2" cx="${PAD + 160 * k}" cy="${S.bigY - 40 * k}" r="${340 * k}" gradientUnits="userSpaceOnUse"><stop stop-color="${tint}" stop-opacity="${(T.glow * 0.5).toFixed(2)}"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient>
  <radialGradient id="fade" cx="${gcx}" cy="${gcy}" r="${Math.max(W, H) * 0.7}" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
  <pattern id="grid" width="${56 * k}" height="${56 * k}" patternUnits="userSpaceOnUse"><path d="M${56 * k} 0H0V${56 * k}" fill="none" stroke="${T.text}" stroke-opacity="0.05"/></pattern>
  <filter id="soft" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="${18 * k}"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${T.deco && T.deco !== 'rings' ? deco(gcx, gcy, mh / 2, !m) : ''}
<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#glow2)"/>
${m ? `<image x="${mx}" y="${my}" width="${mw}" height="${mh}" href="${m.href}"/>` : art}
<svg x="${PAD}" y="${S.logoY}" width="${154 * k}" height="${28 * k}" viewBox="0 0 264 48">${MARK.replace('fill="#fff"', `fill="${T.logo || T.text}"`)}</svg>`;
  // Chain pill at the top right.
  const pSize = 17 * k, pH = 42 * k, iconR = 12 * k, pW = measure(chainName(), pSize, 500) + (chainNow.href ? iconR * 2 + 10 * k : 0) + 32 * k;
  const pX = W - PAD - pW, pY = S.logoY + 14 * k - pH / 2;
  out += `<rect x="${pX.toFixed(1)}" y="${pY.toFixed(1)}" width="${pW.toFixed(1)}" height="${pH}" rx="${rx(pH / 2)}" fill="${T.chip}" stroke="${T.line}" stroke-width="1.5"/>`;
  if (chainNow.href) {
    out += `<clipPath id="pill-icon"><circle cx="${pX + 16 * k + iconR}" cy="${pY + pH / 2}" r="${iconR}"/></clipPath>`
      + `<image x="${pX + 16 * k}" y="${pY + pH / 2 - iconR}" width="${iconR * 2}" height="${iconR * 2}" clip-path="url(#pill-icon)" href="${chainNow.href}"/>`;
  }
  out += txt(chainName(), W - PAD - 16 * k, pY + pH / 2, { size: pSize, weight: 500, color: T.text, anchor: 'end', base: 'middle' });
  // Meta line + title (token icons, name, chips) — the title shrinks to fit before the mascot.
  out += caps(meta, PAD, S.metaY, { size: 15 * k }).svg;
  let x = PAD;
  const r = 24 * k, ty = S.titleY;
  if (icons) {
    out += token(icons[0].icon, icons[0], PAD + r, ty, r, 's0') + token(icons[1].icon, icons[1], PAD + r + 34 * k, ty, r, 's1');
    x = PAD + 2 * r + 34 * k + 18 * k;
  }
  const active = chips.filter(([c]) => c);
  const chipsW = active.reduce((a, [c]) => a + measure(c, 17 * k, 500) + 34 * k, 0);
  const tSize = Math.min(52 * k, (S.right - x - chipsW - 16 * k) / Math.max(measure(titleText, 1, 700), 1));
  out += txt(titleText, x, ty, { size: Math.max(tSize, 26 * k), weight: 700, base: 'middle' });
  x += measure(titleText, Math.max(tSize, 26 * k), 700) + 16 * k;
  for (const [c, style] of active) { const ch = chip(c, x, ty, style); out += ch.svg; x += ch.w + 10 * k; }
  // The hero figure, with a blurred copy behind it as a glow.
  out += caps(label, PAD, S.labelY, { size: 16 * k }).svg;
  const bSize = Math.min(S.maxBig, ((S.right - PAD) * BIG_SHARE) / Math.max(measure(big, 1, 700), 1));
  out += `<g filter="url(#soft)" opacity="0.45">${txt(big, PAD - 4, S.bigY, { size: bSize, weight: 700, color: tint })}</g>`
    + txt(big, PAD - 4, S.bigY, { size: bSize, weight: 700, color: tint });
  let px = PAD;
  if (pill) {
    const pz = 22 * k, pw = measure(pill, pz, 600) + 28 * k, ph = 40 * k;
    out += `<rect x="${px}" y="${S.pillY - ph / 2}" width="${pw.toFixed(1)}" height="${ph}" rx="${rx(ph / 2)}" fill="${rgba(tint, 0.14)}" stroke="${rgba(tint, 0.35)}"/>`
      + txt(pill, px + 14 * k, S.pillY, { size: pz, weight: 600, color: tint, base: 'middle' });
    px += pw + 14 * k;
  }
  if (sub) out += fitted(sub, px, S.pillY + 7 * k, S.right - px, { size: 19 * k, color: T.muted });
  // Three stats, each marked by a short tinted bar on its left.
  const st = S.stats, colW = st.cols === 1 ? st.w : (st.right ?? S.right) - PAD, rowH = st.rowH || 78 * k;
  if (movers) {
    // Top gainers/losers instead of the stats: stacked in the single-column (square) layout, side by side otherwise;
    // never into the mascot below the text in the story layout.
    const limit = m && S.mascot.cx != null ? my - 14 : S.footY - 22 * k;
    out += moversBlock(movers.m, { x: PAD, y: st.y, w: colW, h: limit - st.y, stacked: st.cols === 1 }, movers.hideAmounts, 'sm');
  }
  else stats.forEach(([l, v, color], i) => {
    const cw = st.cols === 1 ? colW : colW / st.cols;
    const sx = PAD + (st.cols === 1 ? 0 : i * cw), sy = st.y + (st.cols === 1 ? i * rowH : 0);
    out += `<rect x="${sx}" y="${sy}" width="${3 * k}" height="${54 * k}" rx="${rx(1.5 * k)}" fill="${tint}" fill-opacity="0.7"/>`
      + caps(fit(l, cw - 30 * k, 13 * k, 600), sx + 16 * k, sy + 16 * k, { size: 13 * k, ls: 0.12 }).svg
      + fitted(v, sx + 16 * k, sy + 48 * k, cw - 30 * k, { size: (st.valueSize || 28) * k, weight: 600, color: color || T.text });
  });
  if (footer) out += fitted(footer, PAD, S.footY, (!m || S.mascot.cx != null ? W - PAD : mx) - PAD - 12, { size: 15 * k, color: T.faint });
  return out + '\n</svg>';
}

function positionSpot(p, { hideAmounts = false, icons = {} } = {}) {
  const closed = p.status === 'closed';
  const feeUsd = (p.claimedUsd || 0) + (closed ? 0 : (p.feeUsd || 0));
  const m = mood(p.pnlUsd, p.pnlPct);
  return spotlight({
    meta: venueName(p.venue) + (p.fee != null ? ` · ${tr('fee {0}%', [num(p.fee / 10000, 2)])}` : ''),
    icons: [{ icon: icons.token0, address: p.token0, symbol: p.symbol0 }, { icon: icons.token1, address: p.token1, symbol: p.symbol1 }],
    title: `${p.symbol0 || '?'}/${p.symbol1 || '?'}`,
    chips: [[closed ? tr('Ditutup') : null], [!closed && p.inRange != null ? (p.inRange ? 'in-range' : tr('di luar rentang')) : null, p.inRange ? tone(T.up) : tone(T.amber)]],
    label: 'PnL', tint: sign(p.pnlUsd),
    big: hideAmounts || p.pnlUsd == null ? (p.pnlPct == null ? '—' : pct(p.pnlPct, 2)) : (p.pnlUsd > 0.005 ? '+' : '') + usd(p.pnlUsd),
    pill: hideAmounts || p.pnlPct == null ? null : pct(p.pnlPct, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan') : tr('modal {0}', [usd(p.costUsd)]),
    stats: [
      [tr(closed ? 'Ditahan' : 'Umur'), age(p.ageHours)],
      [tr('Fee diperoleh'), hideAmounts ? HIDDEN : usd(feeUsd), T.up],
      [tr('Modal'), hideAmounts ? HIDDEN : usd(p.costUsd)],
    ],
    footer: closed ? `${fmtDate(p.opened_ts)} › ${fmtDate(p.closed_ts)}` : tr('masuk {0}', [fmtDate(p.opened_ts)]),
    mascotKey: m,
  });
}
function totalSpot({ now, stats, since, range }, { hideAmounts = false, movers = null } = {}) {
  const { net, pnl, cap } = totalPnl(now);
  const pnlPct = cap > 0 ? (pnl / cap) * 100 : null;
  const wr = stats?.winRatePct;
  return spotlight({
    meta: tr('Seluruh portofolio'), title: tr(net ? 'PnL bersih' : 'Total PnL'),
    chips: [[rangeLabel(range), tone(T.amber)], [tr('{0} posisi terbuka', [now.openCount || 0])], [movers && wr != null ? tr('win rate {0}%', [num(wr, 0)]) : null]],
    label: 'PnL', tint: sign(pnl),
    big: hideAmounts ? (pnlPct == null ? HIDDEN : pct(pnlPct, 2)) : (pnl > 0.005 ? '+' : '') + usd(pnl),
    pill: hideAmounts || pnlPct == null ? null : pct(pnlPct, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan') : tr('modal {0}', [usd(cap)]),
    stats: [
      [tr('Win rate'), wr == null ? '—' : `${num(wr, 0)}%`, wr == null ? null : wr >= 50 ? T.up : T.down],
      [tr('Fee terkumpul'), hideAmounts ? HIDDEN : usd(now.feeUsd), T.up],
      [tr('Total portofolio'), hideAmounts ? HIDDEN : usd(now.value)],
    ],
    movers: movers ? { m: movers, hideAmounts } : null,
    footer: since ? tr('sejak {0} · {1}', [fmtDayOnly(since), fmtDate(Date.now())]) : fmtDate(Date.now()),
    mascotKey: mood(pnl, pnlPct),
  });
}
function dailySpot({ day, rows, total: totalIn, count, monthTotal }, { hideAmounts = false } = {}) {
  const total = totalIn ?? rows.reduce((a, r) => a + r.pnl, 0);
  const ts = new Date(day + 'T12:00:00').getTime();
  const wins = rows.filter((r) => r.pnl > 0.005).length;
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const dayPct = cost > 0 ? (total / cost) * 100 : null;
  return spotlight({
    meta: tr('PnL harian'), title: fmtDayOnly(ts),
    label: tr('PnL terealisasi'), tint: sign(total),
    big: hideAmounts ? (dayPct == null ? HIDDEN : pct(dayPct, 2)) : (total > 0.005 ? '+' : '') + usd(total),
    pill: hideAmounts || dayPct == null ? null : pct(dayPct, 2),
    sub: hideAmounts || !(cost > 0) ? null : tr('modal diputar {0}', [usd(cost)]),
    stats: [
      [tr('Posisi ditutup'), String(count ?? rows.length)],
      [tr('Win rate'), rows.length ? `${num((wins / rows.length) * 100, 0)}%` : '—', !rows.length ? null : wins / rows.length >= 0.5 ? T.up : T.down],
      [tr('Bulan ini'), hideAmounts ? HIDDEN : usd(monthTotal), sign(monthTotal)],
    ],
    footer: fmtDay(ts),
    mascotKey: mood(total, dayPct),
  });
}

// ---- month calendar card ---------------------------------------------------------------
// The PnL calendar of one month as a poster: the spotlight header and figure, and the
// month grid in place of the mascot — each day tinted by its realized PnL (square root
// of the magnitude, the same scale as the dashboard calendar), the figure inside.
// Hidden amounts: the days keep their colour but lose their figure.
function monthGeometry(size) {
  const { W, H } = SIZES[size] || SIZES.wide;
  if (size === 'story') {
    return { W, H, k: 1.6, logoY: 190, metaY: 340, titleY: 432, labelY: 560, bigY: 740, pillY: 830, maxBig: 210, right: W - PAD,
      stats: { y: 920, cols: 3 }, cal: { x: PAD, y: 1080, w: W - PAD * 2, h: 660 }, footY: 1800 };
  }
  if (size === 'square') {
    return { W, H, k: 1.2, logoY: 52, metaY: 162, titleY: 222, labelY: 306, bigY: 410, pillY: 470, maxBig: 120, right: W - PAD,
      stats: { y: 520, cols: 3 }, cal: { x: PAD, y: 628, w: W - PAD * 2, h: 412 } };
  }
  return { W, H, k: 1, logoY: 44, metaY: 150, titleY: 200, labelY: 282, bigY: 372, pillY: 420, maxBig: 92, right: 470,
    stats: { y: 482, cols: 3, valueSize: 22 }, cal: { x: 512, y: 112, w: W - PAD - 512, h: 470 }, footY: H - 26 };
}
// Compact dollars for a calendar cell: +$45, +$1.2k, −$3.4.
function cellUsd(v) {
  const a = Math.abs(v), s = v > 0.005 ? '+' : v < -0.005 ? '−' : '';
  if (fxNow) return s + fxAmount(a * fxNow.rate, true);
  const f = (x, d) => x.toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e6) return `${s}$${f(a / 1e6, 1)}M`;
  if (a >= 1e3) return `${s}$${f(a / 1e3, a >= 1e4 ? 0 : 1)}k`;
  return `${s}$${f(a, a >= 10 ? 0 : 1)}`;
}
const WEEKDAYS = { id: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
function calendarGrid({ month, daily, counts = {} }, hideAmounts, today) {
  const { x, y, w, h } = G.cal, k = G.k;
  const [yy, mm] = month.split('-').map(Number);
  const first = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay(), days = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const rows = Math.ceil((first + days) / 7), gap = 6 * k, headH = 26 * k;
  const cw = (w - gap * 6) / 7, ch = (h - headH - gap * (rows - 1)) / rows;
  const vals = Object.entries(daily).filter(([d]) => d.startsWith(month)).map(([, v]) => Math.abs(v));
  const maxAbs = Math.max(1e-9, ...vals);
  let out = (WEEKDAYS[localeContext.getStore() === 'en' ? 'en' : 'id']).map((n, i) =>
    caps(n, x + i * (cw + gap) + cw / 2, y + 16 * k, { size: 12 * k, ls: 0.1, color: T.faint, anchor: 'middle' }).svg).join('');
  const dSize = Math.min(15 * k, ch * 0.22), vSize = Math.min(19 * k, ch * 0.3);
  for (let d = 1; d <= days; d++) {
    const i = first + d - 1, cx = x + (i % 7) * (cw + gap), cy = y + headH + Math.floor(i / 7) * (ch + gap);
    const key = `${month}-${String(d).padStart(2, '0')}`, v = daily[key];
    let fill = T.panel, stroke = T.line;
    if (v != null && Math.abs(v) > 0.005) {
      const s = Math.sqrt(Math.min(1, Math.abs(v) / maxAbs)), c = v > 0 ? T.up : T.down;
      fill = rgba(c, (0.1 + 0.32 * s).toFixed(3)); stroke = rgba(c, (0.25 + 0.4 * s).toFixed(3));
    }
    out += `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="${rx(8 * k)}" fill="${fill}" stroke="${key === today ? T.text : stroke}"${key === today ? ' stroke-opacity="0.6" stroke-width="2"' : ''}/>`
      + txt(String(d), cx + 8 * k, cy + 8 * k + dSize * 0.8, { size: dSize, weight: 500, color: v != null ? T.muted : T.faint });
    if (counts[key] > 1 && cw > 80) out += txt(`×${counts[key]}`, cx + cw - 8 * k, cy + 8 * k + dSize * 0.8, { size: dSize * 0.85, weight: 500, color: T.faint, anchor: 'end' });
    if (v != null && !hideAmounts) {
      // Shrink rather than cut: a long amount (e.g. "+Rp224rb") must still be read whole.
      const cell = cellUsd(v), size = Math.min(vSize, vSize * ((cw - 14 * k) / Math.max(1, measure(cell, vSize, 600))));
      out += txt(cell, cx + 8 * k, cy + ch - 9 * k, { size, weight: 600, color: sign(v) });
    }
  }
  return out;
}
// data: { month 'YYYY-MM', daily { day: pnl }, counts { day: n }, cost: capital of the positions closed that month }
function monthSvg(data, { hideAmounts = false } = {}) {
  const { month, daily, cost } = data;
  const inMonth = Object.entries(daily).filter(([d]) => d.startsWith(month));
  const total = inMonth.reduce((a, [, v]) => a + v, 0);
  const green = inMonth.filter(([, v]) => v > 0.005).length, red = inMonth.filter(([, v]) => v < -0.005).length;
  const best = inMonth.reduce((a, e) => (a == null || e[1] > a[1] ? e : a), null);
  const closed = inMonth.reduce((a, [d]) => a + (data.counts?.[d] || 0), 0);
  const pctV = cost > 0 ? (total / cost) * 100 : null;
  const [yy, mm] = month.split('-').map(Number);
  const name = new Date(Date.UTC(yy, mm - 1, 15)).toLocaleDateString(loc(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let today = null;
  try { today = new Date().toLocaleDateString('en-CA', { timeZone: TZ() }); } catch { /* no highlight */ }
  return spotlight({
    meta: tr('Kalender PnL'), title: name,
    label: tr('PnL terealisasi'), tint: sign(total),
    big: hideAmounts ? (pctV == null ? HIDDEN : pct(pctV, 2)) : (total > 0.005 ? '+' : '') + usd(total),
    pill: hideAmounts || pctV == null ? null : pct(pctV, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan') : cost > 0 ? tr('modal diputar {0}', [usd(cost)]) : null,
    stats: [
      [tr('Hari hijau'), `${green}/${green + red}`, green >= red ? T.up : T.down],
      [tr('Hari terbaik'), best ? (hideAmounts ? new Date(`${best[0]}T12:00:00Z`).toLocaleDateString(loc(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : cellUsd(best[1])) : '—', best ? sign(best[1]) : null],
      [tr('Posisi ditutup'), String(closed)],
    ],
    footer: G.footY && G.cal.y + G.cal.h < G.footY - 20 ? tr('PnL terealisasi dari posisi yang ditutup tiap hari') : null,
    art: calendarGrid(data, hideAmounts, today),
  });
}

// Pick the card and draw. lang 'id'|'en'; timeZone an IANA name (e.g. 'Asia/Jakarta');
// size/theme/layout one of the SIZES/THEMES/LAYOUTS keys (unknown ones fall back to the default).
const LAYOUTS = { spotlight: { label: 'Sorot' }, classic: { label: 'Klasik' } };
const sizeKey = (s) => (SIZES[s] ? s : 'wide');
const themeKey = (t) => (THEMES[t] ? t : 'dark');
const layoutKey = (l) => (LAYOUTS[l] ? l : 'spotlight');
function svgOf(kind, data, opts = {}) {
  return localeContext.run(opts.lang === 'en' ? 'en' : 'id', () => {
    tz = opts.timeZone || null;
    fxNow = opts.fx?.rate > 0 && opts.fx.currency ? { currency: opts.fx.currency, rate: opts.fx.rate } : null;
    T = THEMES[themeKey(opts.theme)];
    const spot = layoutKey(opts.layout) === 'spotlight';
    // The month card has one composition only (the calendar is the picture).
    G = kind === 'month' ? monthGeometry(sizeKey(opts.size)) : spot ? spotGeometry(sizeKey(opts.size)) : geometry(sizeKey(opts.size));
    chainNow = CHAIN_BADGE[opts.chain?.key] || { label: opts.chain?.label || CHAIN_BADGE.robinhood.label, href: '' };
    try {
      if (kind === 'position') return (spot ? positionSpot : positionSvg)(data, opts);
      if (kind === 'total') return (spot ? totalSpot : totalSvg)(data, opts);
      if (kind === 'daily') return (spot ? dailySpot : dailySvg)(data, opts);
      if (kind === 'month') return monthSvg(data, opts);
      throw new Error(`jenis kartu tidak dikenal: ${kind}`);
    } finally { tz = null; fxNow = null; T = THEMES.dark; G = null; chainNow = CHAIN_BADGE.robinhood; }
  });
}
// Venue name for the card: v4/v3 = Uniswap, pancakev3 = PancakeSwap, Solana venues by
// their program name.
const VENUE_NAME = { pancakev3: 'PancakeSwap V3', meteora: 'Meteora DLMM', orca: 'Orca Whirlpools', raydium: 'Raydium CLMM' };
const venueName = (v) => VENUE_NAME[v] || `Uniswap ${String(v || '').toUpperCase()}`;
function renderPng(svg, size) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZES[sizeKey(size)].W * SCALE },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: BASE_FONT.family },
  });
  return Buffer.from(r.render().asPng());
}
const render = (kind, data, opts = {}) => renderPng(svgOf(kind, data, opts), opts.size);
// The same, rasterised on libuv's thread pool: a big card takes a second or more, and the
// server must not stall the bot's event loop meanwhile.
async function renderAsync(kind, data, opts = {}) {
  const img = await renderAsyncRaw(svgOf(kind, data, opts), {
    fitTo: { mode: 'width', value: SIZES[sizeKey(opts.size)].W * SCALE },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: BASE_FONT.family },
  });
  return Buffer.from(img.asPng());
}

// Companion text (Telegram caption / Web Share text) — figures follow the language.
function caption(kind, data, lang, fx = null) {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => {
    fxNow = fx?.rate > 0 && fx.currency ? { currency: fx.currency, rate: fx.rate } : null;
    try { return captionText(kind, data); } finally { fxNow = null; }
  });
}
function captionText(kind, data) {
  if (kind === 'position') return `${data.symbol0 || '?'} / ${data.symbol1 || '?'} ${data.pnlPct == null ? '' : pct(data.pnlPct, 2)} · Quiver`;
  if (kind === 'total') { const { net, pnl } = totalPnl(data.now); return `${tr(net ? 'PnL bersih' : 'Total PnL')} ${usd(pnl)} · Quiver`; }
  if (kind === 'month') return `PnL ${data.month}: ${usd(Object.entries(data.daily).filter(([d]) => d.startsWith(data.month)).reduce((a, [, v]) => a + v, 0))} · Quiver`;
  return `PnL ${data.day}: ${usd(data.total ?? data.rows.reduce((a, r) => a + r.pnl, 0))} · Quiver`;
}

module.exports = { svgOf, renderPng, render, renderAsync, caption, venueName, sizeKey, themeKey, layoutKey, SIZES, THEMES, LAYOUTS, W: SIZES.wide.W, H: SIZES.wide.H, SCALE };
