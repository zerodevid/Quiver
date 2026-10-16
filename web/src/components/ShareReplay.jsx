// Position replay — the "Video" tab of the share dialog. A ~22 second square clip that
// replays one LP position: the price line is drawn up to the entry, the range box opens,
// fee coins fly out while the price sits inside the range, time/fee/PnL tick up, the
// position closes, then a summary card and an outro.
//
// Everything is drawn in the browser on a <canvas> and recorded with MediaRecorder: the
// VPS only hands over the figures and price candles (GET /api/share/replay — the same
// candles as the position share card), it never encodes video.
//
// Each frame is a pure function of the clip time (drawFrame), so the looping preview and
// the recording show exactly the same thing.
//
// The intermediate fee and PnL figures are a model, not history (the bot does not store
// them per minute): fees accrue only while the price is inside the range, and the position
// value follows the concentrated-liquidity formula for the range. Whatever the model misses
// is spread evenly over the position's life, so the last frame always lands exactly on
// the real fee and PnL.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Download, Share2, Clapperboard } from 'lucide-react';
import { get } from '../api';
import { useI18n, getLocale } from '../i18n';
import { usd, pct, price } from '../fmt';
import { isHidden } from '../privacy';
import { canonAddr, isAddr } from '../chain';
import { withTicket } from '../telegram';
import { KNOWN, hue } from './TokenIcon';
import { ARROW, CHEVRON, WORDMARK } from './Logo';
import devilFlex from '../../../public/mascots/devil/flex.png';
import devilProfit from '../../../public/mascots/devil/profit.png';
import devilLoss from '../../../public/mascots/devil/loss.png';
import devilNeutral from '../../../public/mascots/devil/neutral.png';

export const S = 1080;                 // canvas side (px)
export const FPS = 30;
// Timeline (seconds of clip time).
const TL = {
  intro: 0.6,                   // header fades in, then the price line starts
  open: 3.0,                    // line reaches the entry; range box opens
  life: 3.7,                    // the position's life plays from here…
  close: 13.7,                  // …to here
  after: 14.7,                  // a few candles after exit
  summary: 15.9,                // summary card fades in
  outro: 20.0,                  // logo outro
  end: 22.5,
};
export const C = {
  bg: '#0A0B0D', text: '#F4F6F5', muted: '#8B9392', faint: '#5C6463', grid: 'rgba(255,255,255,0.06)',
  up: '#4ADE80', down: '#F87171', amber: '#FBBF24', accent: '#7AA2F7',
  band: 'rgba(122,162,247,0.12)', bandLine: 'rgba(122,162,247,0.45)',
};
// Video themes: the same keys as the share card themes in src/share-card.js. Only 'hell'
// has its own look so far; every other key plays the standard palette. paint() swaps the
// palette in C before each frame, so every scene keeps reading C.
const PALETTES = {
  dark: { ...C },
  hell: {
    bg: '#0E0303', text: '#FBEFE6', muted: '#C9A49A', faint: '#8A625A', grid: 'rgba(255,90,70,0.08)',
    up: '#FFD23F', down: '#FF5A4E', amber: '#FFB23F', accent: '#FF6A3D',
    band: 'rgba(255,90,60,0.12)', bandLine: 'rgba(255,106,61,0.5)',
  },
};
export const videoTheme = (theme) => (theme === 'hell' ? 'hell' : 'dark');
// Amounts: dollars, or the Settings currency when the dialog passes its rate ({ currency, rate }).
let fxNow = null;
export const paint = (theme, fx = null) => { Object.assign(C, PALETTES[videoTheme(theme)]); fxNow = fx?.rate > 0 && fx.currency ? fx : null; };
// A dollar amount in the active currency. Same rules as the share card (src/share-card.js):
// shortened from a million up ("Rp22,4 jt"); compact (calendar cells) from a thousand up,
// without spaces ("Rp224rb"). Privacy redaction keeps the dollar mask.
export function money(v, d = 2, compact = false) {
  if (!fxNow || v == null || Number.isNaN(v) || isHidden()) return usd(v, d);
  const abs = Math.abs(v * fxNow.rate), loc = getLocale() === 'en' ? 'en-US' : 'id-ID';
  const o = { style: 'currency', currency: fxNow.currency, minimumFractionDigits: 0, maximumFractionDigits: abs < 100 ? 2 : 0 };
  if (abs >= (compact ? 1e3 : 1e6)) {
    o.notation = 'compact';
    o.maximumFractionDigits = compact ? (Number(new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 }).format(abs).replace(/\D/g, '')) < 10 ? 1 : 0) : 1;
  }
  let out;
  try { out = new Intl.NumberFormat(loc, o).format(abs).replace(/^([^\d\s]+)\s+/, '$1'); } catch { return usd(v, d); }
  return (v < 0 ? '−' : '') + (compact ? out.replace(/\s+/g, '') : out.replace(/\u00A0/g, ' '));
}
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';
const CHART = { x0: 60, x1: 900, y0: 250, y1: 770 };   // price chart area (axis labels to the right)

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, u) => a + (b - a) * u;
export const ease = (u) => 1 - (1 - clamp(u)) ** 3;
export const span = (sec, a, b) => clamp((sec - a) / (b - a));

// ---- model ---------------------------------------------------------------------------

// Concentrated-liquidity value of a position with range [a, b] at price p, in quote units
// per unit of liquidity. Only the ratio v(p) / v(entry) is used.
function clValue(p, a, b) {
  const sa = Math.sqrt(a), sb = Math.sqrt(b);
  if (p <= a) return p * (1 / sa - 1 / sb);
  if (p >= b) return sb - sa;
  return 2 * Math.sqrt(p) - sa - p / sb;
}

export function buildModel({ position: p, chart, events = [] }) {
  const marks = chart.marks || [];
  const pts = chart.pts.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v > 0).map(([t, v]) => [t, v]);
  const closed = p.status === 'closed';
  const tOpen = p.opened_ts ?? marks[0]?.t ?? pts[0][0];
  // The candles end at the exit (plus a few after) or now; the line passes exactly
  // through the entry and exit prices.
  if (marks[0]) pts.push([marks[0].t, marks[0].v]);
  if (closed && marks[1]) pts.push([marks[1].t, marks[1].v]);
  pts.sort((x, y) => x[0] - y[0]);
  const t0 = Math.min(pts[0][0], tOpen);
  const tLast = Math.max(pts[pts.length - 1][0], tOpen + 1);
  const tClose = closed ? clamp(p.closed_ts ?? tLast, tOpen + 1, tLast) : tLast;
  const priceAt = (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) { const [ta, va] = pts[i - 1], [tb, vb] = pts[i]; return tb === ta ? vb : lerp(va, vb, (t - ta) / (tb - ta)); }
    }
    return pts[pts.length - 1][1];
  };
  const [a, b] = [Math.min(...chart.band), Math.max(...chart.band)];
  const inBand = (v) => v >= a && v <= b;
  const entry = marks[0]?.v ?? priceAt(tOpen);

  // In-range share over the life, sampled evenly: drives fee accrual and the summary.
  const N = 400;
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + (inBand(priceAt(lerp(tOpen, tClose, (i - 0.5) / N))) ? 1 : 0));
  const inRangePct = (cum[N] / N) * 100;
  const fee = p.feeUsd || 0, cost = p.costUsd || 0, pnl = p.pnlUsd || 0;
  const share = (u) => { const k = clamp(u) * N, i = Math.floor(k); return i >= N ? cum[N] : lerp(cum[i], cum[i + 1], k - i); };
  const feeAt = (u) => (cum[N] > 0 ? fee * (share(u) / cum[N]) : fee * clamp(u));
  const v0 = a > 0 && b > a ? clValue(entry, a, b) : 0;
  const rawPnl = (u) => (v0 > 0 ? cost * (clValue(priceAt(lerp(tOpen, tClose, u)), a, b) / v0 - 1) : 0) + feeAt(u);
  const miss = pnl - rawPnl(1);
  const pnlAt = (u) => (cost > 0 && v0 > 0 ? rawPnl(u) + miss * clamp(u) : pnl * clamp(u));

  // Visible price range: every candle plus the range box — but a very wide range (full
  // range, or a deep one-sided range) must not squash the price line into a flat strip.
  let lo = Math.min(...pts.map((x) => x[1])), hi = Math.max(...pts.map((x) => x[1]));
  const sp = hi - lo || hi * 0.1;
  lo = Math.max(Math.min(lo, a), lo - sp * 0.6);
  hi = Math.min(Math.max(hi, b), hi + sp * 0.6);
  const pad = (hi - lo) * 0.1;
  lo = Math.max(lo - pad, 0); hi += pad;

  const duration = (closed ? p.closed_ts || Date.now() : Date.now()) - (p.opened_ts || tOpen);
  const acts = actsOf(events, tOpen, tClose, t0, tLast);
  return { p, pts, closed, t0, tOpen, tClose, tLast, a, b, inBand, priceAt, entry, exit: priceAt(tClose), inRangePct, fee, cost, pnl, pnlPct: p.pnlPct, feeAt, pnlAt, lo, hi, duration, acts };
}

// Liquidity added, fees claimed or compounded, partial withdrawals during the life (from
// /api/share/replay, one row per transaction) → chart markers. Rows closer than ~5% of the
// chart width merge into one marker (three quick adds would otherwise stack their labels),
// each with the clip time at which the playhead reaches it.
const ACT_KINDS = ['add', 'claim', 'compound', 'remove'];
function actsOf(events, tOpen, tClose, t0, tLast) {
  const out = [];
  for (const e of events) {
    if (!(e.ts > tOpen && e.ts < tClose)) continue;
    const last = out[out.length - 1];
    const c = last && (e.ts - last.ts) / (tLast - t0 || 1) < 0.05 ? last
      : (out.push({ ts: e.ts, n: {}, usd: {} }), out[out.length - 1]);
    for (const k of e.kinds || []) {
      if (!ACT_KINDS.includes(k)) continue;
      c.n[k] = (c.n[k] || 0) + 1;
      const v = e[`${k}Usd`];
      if (v != null) c.usd[k] = (c.usd[k] || 0) + v;
    }
  }
  for (const c of out) c.s = lerp(TL.life, TL.close, (c.ts - tOpen) / (tClose - tOpen || 1));
  return out.filter((c) => Object.keys(c.n).length);
}
// Totals over the life, for the summary line.
function actTotals(acts) {
  const n = {}, usd = {};
  for (const c of acts) for (const k of Object.keys(c.n)) { n[k] = (n[k] || 0) + c.n[k]; if (c.usd[k] != null) usd[k] = (usd[k] || 0) + c.usd[k]; }
  return { n, usd };
}

// Clip time → (data time of the line's head, position life progress 0..1).
function playhead(m, sec) {
  if (sec < TL.intro) return { t: m.t0, u: 0 };
  if (sec < TL.open) return { t: lerp(m.t0, m.tOpen, span(sec, TL.intro, TL.open)), u: 0 };
  if (sec < TL.life) return { t: m.tOpen, u: 0 };
  if (sec < TL.close) { const u = span(sec, TL.life, TL.close); return { t: lerp(m.tOpen, m.tClose, u), u }; }
  return { t: lerp(m.tClose, m.tLast, span(sec, TL.close, TL.after)), u: 1 };
}

// Coin bursts: one every 0.2 s of life while the price is in range. Precomputed, so the
// frame stays a pure function of time.
export function coinsOf(m) {
  const out = [];
  for (let s = TL.life + 0.1, k = 0; s < TL.close; s += 0.2, k++) {
    const t = lerp(m.tOpen, m.tClose, span(s, TL.life, TL.close));
    if (m.inBand(m.priceAt(t))) out.push({ s, t, k, jx: ((k * 37) % 11) - 5, lift: 120 + ((k * 53) % 70) });
  }
  return out;
}

// ---- drawing helpers ---------------------------------------------------------------

export const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
export function text(ctx, s, x, y, { size = 28, weight = 400, color = C.text, align = 'left', base = 'alphabetic', alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.font = font(size, weight); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  ctx.fillText(s, x, y); ctx.restore();
}
export function pill(ctx, s, x, y, { size = 22, color = C.text, fill = 'rgba(255,255,255,0.08)', align = 'left', dot = null, alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.font = font(size, 600);
  const padX = size * 0.6, dotW = dot ? size * 0.75 : 0, w = ctx.measureText(s).width + padX * 2 + dotW, h = size * 1.6;
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(left, y - h / 2, w, h, h / 2); ctx.fill();
  if (dot) { ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(left + padX + size * 0.22, y, size * 0.22, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(s, left + padX + dotW, y + 1);
  ctx.restore();
  return w;
}
function tokenDisc(ctx, img, addr, sym, x, y, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = `oklch(0.62 0.11 ${hue(canonAddr(addr))})`; ctx.fill();
  ctx.clip();
  if (img?.complete && img.naturalWidth) ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  else text(ctx, (sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?', x, y + 1, { size: r * 0.8, weight: 700, align: 'center', base: 'middle' });
  ctx.restore();
  ctx.save(); ctx.strokeStyle = C.bg; ctx.lineWidth = Math.max(2, r * 0.1); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}
const LOGO = typeof Path2D === 'undefined' ? null : { mark: new Path2D(ARROW + CHEVRON), word: new Path2D(WORDMARK) };
// Quiver logo; the path is 264×48 (mark only: 73×48). `x, y` = top-left.
export function logo(ctx, x, y, h, { word = true, color = C.text, alpha = 1 } = {}) {
  if (!LOGO) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.scale(h / 48, h / 48); ctx.fillStyle = color;
  ctx.fill(LOGO.mark); if (word) ctx.fill(LOGO.word, 'evenodd');
  ctx.restore();
}

// ---- hell theme backdrop & mascot -------------------------------------------------------

// Deterministic pseudo-random in [0, 1): the backdrop is the same on every frame and recording.
const rand = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// Jagged ridge points along the bottom: peaks between `lift` and `lift + tall` above the edge.
const ridge = (lift, tall, seed) => {
  const pts = []; let x = 0, i = seed;
  while (x < S) { pts.push([x, S - lift - tall * (0.15 + rand(i++) * 0.85)]); x += 18 + rand(i++) * 56; }
  pts.push([S, S - lift - tall * 0.4]);
  return pts;
};
const CRAGS = { back: ridge(S * 0.12, S * 0.3, 11), front: ridge(S * 0.08, S * 0.12, 97) };
const TONGUES = (() => { const out = []; let x = 0, i = 41; while (x < S) { const w = 30 + rand(i++) * 50; out.push({ x, w, h: 0.35 + rand(i++) * 0.65, lean: rand(i++) - 0.5, ph: rand(i++) * 6.28 }); x += w * 0.7; } return out; })();
let grain = null;   // a noise tile, made once
function grainTile() {
  if (grain || typeof document === 'undefined') return grain;
  grain = document.createElement('canvas'); grain.width = grain.height = 256;
  const g = grain.getContext('2d'), d = g.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) { d.data[i + 3] = rand(i) * 90; }
  g.putImageData(d, 0, 0);
  return grain;
}
function fillRidge(ctx, pts, color, alpha) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, S); pts.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(S, S); ctx.closePath(); ctx.fill();
  ctx.restore();
}
// Background of a frame. Standard: flat C.bg. Hell: dark red gradient, blood moon (top right),
// rock crags with flickering flame tongues between them, embers rising and a film grain.
export function backdrop(ctx, sec, theme) {
  if (videoTheme(theme) !== 'hell') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, S, S); return; }
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#2A0707'); bg.addColorStop(0.5, '#120303'); bg.addColorStop(1, '#060101');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S, S);
  const mx = S - 150, my = 170, mr = 190;
  const halo = ctx.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * 1.9);
  halo.addColorStop(0, 'rgba(179,18,27,0.3)'); halo.addColorStop(1, 'rgba(179,18,27,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, S, S);
  const moon = ctx.createRadialGradient(mx - mr * 0.25, my - mr * 0.3, 0, mx, my, mr * 1.2);
  moon.addColorStop(0, '#E0262E'); moon.addColorStop(1, '#B3121B');
  ctx.save(); ctx.globalAlpha *= 0.42; ctx.fillStyle = moon; ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  fillRidge(ctx, CRAGS.back, '#2E0507', 0.75);
  // Flames: each tongue sways and breathes on its own phase.
  const fl = ctx.createLinearGradient(0, S, 0, S - S * 0.2);
  fl.addColorStop(0, 'rgba(255,122,26,0.8)'); fl.addColorStop(0.55, 'rgba(224,38,46,0.4)'); fl.addColorStop(1, 'rgba(224,38,46,0)');
  ctx.fillStyle = fl; ctx.beginPath(); ctx.moveTo(0, S);
  for (const f of TONGUES) {
    const h = S * 0.2 * f.h * (0.82 + 0.18 * Math.sin(sec * 5 + f.ph)), lean = (f.lean + 0.25 * Math.sin(sec * 3 + f.ph)) * f.w * 0.8;
    ctx.lineTo(f.x, S);
    ctx.quadraticCurveTo(f.x + f.w * 0.1, S - h * 0.6, f.x + f.w / 2 + lean, S - h);
    ctx.quadraticCurveTo(f.x + f.w * 0.9, S - h * 0.5, f.x + f.w, S);
  }
  ctx.closePath(); ctx.fill();
  fillRidge(ctx, CRAGS.front, '#000', 0.85);
  // Embers rise and drift, wrapping around.
  for (let i = 0; i < 40; i++) {
    const speed = 30 + rand(i + 100) * 60, y = S - ((sec * speed + rand(i + 200) * S) % (S * 0.85));
    const x = rand(i + 300) * S + Math.sin(sec * 1.5 + i) * 14, r = 1.5 + rand(i + 400) * 2.5;
    ctx.save(); ctx.globalAlpha *= (0.3 + rand(i + 500) * 0.5) * clamp((S - y) / 120);
    ctx.fillStyle = i % 3 ? '#FF7A3D' : '#FFD23F'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  const tile = grainTile();
  if (tile) { ctx.save(); ctx.globalAlpha *= 0.5; ctx.fillStyle = ctx.createPattern(tile, 'repeat'); ctx.fillRect(0, 0, S, S); ctx.restore(); }
}
// The demon mascot, its pose follows the PnL like the share card (flex = ≥ 20% profit).
const MASCOT_SRC = { flex: devilFlex, profit: devilProfit, loss: devilLoss, neutral: devilNeutral };
const mascotImg = {};
export function mascotOf(pnl, pnlPct) {
  const key = pnl > 0.005 ? (pnlPct >= 20 ? 'flex' : 'profit') : pnl < -0.005 ? 'loss' : 'neutral';
  if (!mascotImg[key] && typeof Image !== 'undefined') { const im = new Image(); im.src = MASCOT_SRC[key]; mascotImg[key] = im; }
  return mascotImg[key];
}
// Mascot of height `h` standing on `bottom`, centred on `cx`; rises in with `a` (0..1).
export function drawMascot(ctx, im, cx, bottom, h, a) {
  if (!im?.complete || !im.naturalWidth || a <= 0) return;
  const w = (im.naturalWidth / im.naturalHeight) * h;
  ctx.save(); ctx.globalAlpha *= a; ctx.drawImage(im, cx - w / 2, bottom - h + (1 - a) * 40, w, h); ctx.restore();
}

// "1j 38m" — compact elapsed time for the counters.
function since(ms, t) {
  const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return t('{d}h {h}j', { d, h: h % 24 });
  if (h > 0) return t('{h}j {m}m', { h, m: String(m % 60).padStart(2, '0') });
  return t('{m}m', { m });
}
const signed = (v) => (v > 0 ? '+' : '') + money(v);
// One line per kind of a marker: "Tambah likuiditas $120", "2× klaim fee $8,60".
const ACT_LABEL = { add: 'Tambah likuiditas', claim: 'Klaim fee', compound: 'Compound fee', remove: 'Tarik sebagian' };
function actLines(c, t, hide) {
  return ACT_KINDS.filter((k) => c.n[k]).map((k) => {
    const name = t(ACT_LABEL[k]);
    const head = c.n[k] > 1 ? `${c.n[k]}× ${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
    return { kind: k, s: !hide && c.usd[k] > 0.005 ? `${head} ${money(c.usd[k])}` : head };
  });
}
// A marker ring: a filled disc in the kind's colour with its glyph, outlined so it stands
// out from a price line of the same colour.
function actRing(ctx, c, x, y, r) {
  const col = actColor(c);
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.18); ctx.strokeStyle = C.text; ctx.stroke();
  ctx.restore();
  text(ctx, actGlyph(c), x, y + 1, { size: r * 1.3, weight: 800, color: '#0A0B0D', align: 'center', base: 'middle' });
}
const actGlyph = (c) => (c.n.add ? '+' : c.n.remove ? '−' : c.n.compound ? '↻' : '$');
const KIND_COLOR = { add: 'accent', compound: 'accent', remove: 'amber', claim: 'up' };
const actColor = (c) => C[KIND_COLOR[ACT_KINDS.find((k) => c.n[k])]];
const toneOf = (v) => (v > 0.005 ? C.up : v < -0.005 ? C.down : C.text);

// ---- scenes ------------------------------------------------------------------------

function header(ctx, m, img, sec, t, status) {
  const { p } = m;
  const a = ease(span(sec, 0, TL.intro));
  ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 12);
  tokenDisc(ctx, img[0], p.token0, p.symbol0, 94, 104, 34);
  tokenDisc(ctx, img[1], p.token1, p.symbol1, 140, 104, 34);
  const pair = `${p.symbol0 || '?'} / ${p.symbol1 || '?'}`;
  text(ctx, pair, 196, 118, { size: 54, weight: 700 });
  ctx.font = font(54, 700);
  if (status) pill(ctx, status.label, 196 + ctx.measureText(pair).width + 22, 100, { size: 22, color: status.color, dot: status.color });
  text(ctx, t('Posisi di {v} · {c}', { v: p.venue, c: p.chain }), 196, 160, { size: 26, color: C.muted });
  logo(ctx, S - 60 - 132, 52, 24, { color: C.muted });
  ctx.restore();
}

function chartScene(ctx, m, img, sec, t, hide, coins) {
  const { x0, x1, y0, y1 } = CHART;
  const X = (ts) => lerp(x0, x1, (ts - m.t0) / (m.tLast - m.t0 || 1));
  const Y = (v) => lerp(y1, y0, (v - m.lo) / (m.hi - m.lo || 1));
  const head = playhead(m, sec);
  const ph = m.priceAt(head.t);
  const inRange = m.inBand(ph);

  // Status chip in the header follows the story.
  let status = null;
  if (sec >= TL.open && sec < TL.close) status = inRange ? { label: 'in-range', color: C.up } : { label: t('di luar rentang'), color: C.amber };
  else if (sec >= TL.close) status = m.closed ? { label: hide ? t('Ditutup {v}', { v: pct(m.pnlPct, 1) }) : t('Ditutup {v}', { v: signed(m.pnl) }), color: toneOf(m.pnl) } : { label: 'Live', color: C.up };
  header(ctx, m, img, sec, t, status);

  // Grid + price axis.
  const ga = ease(span(sec, 0.2, TL.intro + 0.4));
  ctx.save(); ctx.globalAlpha = ga;
  for (let i = 0; i <= 4; i++) {
    const v = lerp(m.lo, m.hi, 0.1 + 0.2 * i), y = Y(v);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    text(ctx, price(v), S - 40, y + 7, { size: 20, color: C.faint, align: 'right' });
  }
  ctx.restore();

  const xo = X(m.tOpen), xc = X(m.tClose);
  // Range box: opens from the entry line to the exit (or now).
  if (sec >= TL.open) {
    const w = (xc - xo) * ease(span(sec, TL.open, TL.life));
    const ya = clamp(Y(m.b), y0 - 20, y1 + 20), yb = clamp(Y(m.a), y0 - 20, y1 + 20);
    ctx.save();
    ctx.fillStyle = C.band; ctx.fillRect(xo, ya, w, yb - ya);
    ctx.strokeStyle = C.bandLine; ctx.lineWidth = 2; ctx.strokeRect(xo, ya, w, yb - ya);
    ctx.restore();
    pill(ctx, t('Rentang'), xo + 14, yb - 24, { size: 18, color: '#0A0B0D', fill: C.accent, alpha: ease(span(sec, TL.open + 0.3, TL.life)) });
    dashed(ctx, xo, y0 - 40, y1 + 40, t('Posisi dibuka'), 'left', ease(span(sec, TL.open, TL.open + 0.4)));
  }
  if (m.closed && sec >= TL.close) dashed(ctx, xc, y0 - 40, y1 + 40, t('Posisi selesai'), 'right', ease(span(sec, TL.close, TL.close + 0.4)));

  // Price line up to the head: white before entry, accent during the position.
  if (sec >= TL.intro) {
    const path = new Path2D();
    let first = true;
    for (const [ts, v] of m.pts) {
      if (ts > head.t) break;
      first ? path.moveTo(X(ts), Y(v)) : path.lineTo(X(ts), Y(v)); first = false;
    }
    if (first) path.moveTo(X(head.t), Y(ph)); else path.lineTo(X(head.t), Y(ph));
    ctx.save(); ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, xo, S); ctx.clip(); ctx.strokeStyle = C.text; ctx.stroke(path); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(xo, 0, S - xo, S); ctx.clip(); ctx.strokeStyle = C.accent; ctx.shadowColor = C.accent; ctx.shadowBlur = 12; ctx.stroke(path); ctx.restore();
    ctx.restore();
    // Head dot + price bubble.
    const hx = X(head.t), hy = Y(ph);
    ctx.save(); ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const live = sec >= TL.open && sec < TL.after;
    pill(ctx, price(ph), hx + (hx > x1 - 160 ? -18 : 18), hy - 34, { size: 22, align: hx > x1 - 160 ? 'right' : 'left', color: '#0A0B0D', fill: live ? (inRange ? C.accent : C.amber) : C.text });
  }

  // Markers: a ring on the line where liquidity was added, fees claimed or compounded, or
  // part withdrawn; its label pops above for two seconds once the playhead passes.
  for (const c of m.acts) {
    const age = sec - c.s;
    if (age < 0) break;
    const x = X(c.ts), y = Y(m.priceAt(c.ts)), col = actColor(c);
    const pop = age < 0.25 ? 1 + 0.5 * Math.sin((age / 0.25) * Math.PI) : 1;
    ctx.save(); ctx.globalAlpha *= Math.min(1, age / 0.12);
    ctx.setLineDash([3, 6]); ctx.strokeStyle = col; ctx.globalAlpha *= 0.5; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x, y1 + 10); ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.globalAlpha *= Math.min(1, age / 0.12); actRing(ctx, c, x, y, 17 * pop); ctx.restore();
    const show = age < 1.6 ? 1 : 1 - (age - 1.6) / 0.4;
    if (show > 0) {
      const lines = actLines(c, t, hide);
      ctx.font = font(22, 600);
      const w = Math.max(...lines.map((l) => ctx.measureText(l.s).width)) + 30;
      const lx = clamp(x, x0 + w / 2, x1 - w / 2);
      const top = y - 40 - (lines.length - 1) * 40 > y0 - 20 ? y - 40 : y + 60 + (lines.length - 1) * 40;
      lines.forEach((l, i) => pill(ctx, l.s, lx, top - (lines.length - 1 - i) * 40, {
        size: 22, align: 'center', color: '#0A0B0D', fill: C[KIND_COLOR[l.kind]], alpha: ease(Math.min(1, age / 0.2)) * show,
      }));
    }
  }

  // Fee coins fly from the line to the fee counter.
  const target = [290, 930];
  let pulse = 0;
  for (const c of coins) {
    const age = sec - c.s;
    if (age < 0) break;
    if (age > 1.1) { if (age < 1.3) pulse = Math.max(pulse, 1 - (age - 1.1) / 0.2); continue; }
    const u = ease(age / 1.1);
    const sx = X(c.t), sy = Y(m.priceAt(c.t));
    const cx = sx + c.jx * 6, cy = sy - c.lift;
    const x = (1 - u) ** 2 * sx + 2 * (1 - u) * u * cx + u * u * target[0];
    const y = (1 - u) ** 2 * sy + 2 * (1 - u) * u * cy + u * u * target[1];
    ctx.save(); ctx.globalAlpha = age < 0.15 ? age / 0.15 : 1 - Math.max(0, (u - 0.85) / 0.15);
    tokenDisc(ctx, img[c.k % 2], m.p[`token${c.k % 2}`], m.p[`symbol${c.k % 2}`], x, y, lerp(22, 12, u));
    ctx.restore();
  }

  // Counters.
  const u = head.u;
  const fee = m.feeAt(u), pnl = u > 0 ? m.pnlAt(u) : 0;
  const ca = ease(span(sec, 0.2, TL.intro + 0.4));
  ctx.save(); ctx.globalAlpha = ca;
  // The three figures share one row: long ones ("15j 25m", "Rp660.112", "+Rp599.049")
  // shrink together, sized from the final values so the row does not jitter as they count.
  const feeText = hide ? pct(m.cost > 0 ? (fee / m.cost) * 100 : 0, 1) : money(fee);
  const pnlText = hide ? pct(m.cost > 0 ? (pnl / m.cost) * 100 : u * (m.pnlPct || 0), 1) : signed(pnl);
  ctx.save(); ctx.font = font(64, 600);
  const wid = (s) => ctx.measureText(s).width;
  const wT = wid(since(m.duration, t)), wF = Math.max(wid(feeText), wid(hide ? pct(m.cost > 0 ? (m.fee / m.cost) * 100 : 0, 1) : money(m.fee)));
  const wP = Math.max(wid(pnlText), wid(hide ? pct(m.pnlPct || 0, 1) : signed(m.pnl)));
  ctx.restore();
  const gap = 36, size = 64 * Math.min(1, (S - 120 - 2 * gap) / (wT + wF + wP));
  const xFee = 60 + Math.max(230, (wT * size) / 64 + gap);
  text(ctx, t('Waktu'), 60, 880, { size: 24, color: C.muted });
  text(ctx, since(m.duration * u, t), 60, 950, { size, weight: 600 });
  text(ctx, 'Fee', xFee, 880, { size: 24, color: C.muted });
  ctx.save(); ctx.translate(xFee, 950); ctx.scale(1 + pulse * 0.05, 1 + pulse * 0.05);
  text(ctx, feeText, 0, 0, { size, weight: 600, color: u > 0 ? C.up : C.faint });
  ctx.restore();
  text(ctx, 'PnL', S - 60, 880, { size: 24, color: C.muted, align: 'right' });
  text(ctx, pnlText, S - 60, 950, { size, weight: 600, align: 'right', color: u > 0 ? toneOf(pnl) : C.faint });
  ctx.restore();
}

function dashed(ctx, x, ya, yb, label, side, alpha) {
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
  ctx.restore();
  text(ctx, label, side === 'left' ? x + 12 : x - 12, ya + 6, { size: 20, color: C.muted, align: side === 'left' ? 'left' : 'right', alpha });
}

function summaryScene(ctx, m, sec, t, hide, theme) {
  const hell = videoTheme(theme) === 'hell';
  const { p } = m;
  const a = ease(span(sec, TL.summary, TL.summary + 0.6));
  ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 24);
  logo(ctx, 60, 60, 36);
  pill(ctx, p.venue, S - 60, 80, { size: 22, color: C.muted, align: 'right', dot: m.closed ? C.muted : C.up });
  text(ctx, `${p.symbol0 || '?'} / ${p.symbol1 || '?'}`, 60, 200, { size: 36, weight: 600 });
  const k = ease(span(sec, TL.summary + 0.2, TL.summary + 1.4));
  text(ctx, 'Fee', 60, 270, { size: 28, color: C.muted });
  // Each figure shrinks to its column (a long amount such as "Rp107.430" would run into the next).
  const fit = (s, w) => { ctx.save(); ctx.font = font(120, 700); const x = ctx.measureText(s).width; ctx.restore(); return Math.min(120, 120 * (w / Math.max(1, x))); };
  const feeText = hide ? pct(m.cost > 0 ? (m.fee / m.cost) * 100 * k : 0, 1) : money(m.fee * k);
  text(ctx, feeText, 60, 390, { size: fit(hide ? feeText : money(m.fee), 440), weight: 700, color: C.up });
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(520, 260, 2, 140); ctx.restore();
  text(ctx, 'PnL', 570, 270, { size: 28, color: C.muted });
  text(ctx, hide ? pct((m.pnlPct || 0) * k, 1) : signed(m.pnl * k), 570, 390, { size: fit(hide ? pct(m.pnlPct || 0, 1) : signed(m.pnl), S - 60 - 570), weight: 700, color: toneOf(m.pnl) });
  const sub = [since(m.duration, t), hide ? null : t('posisi {v}', { v: money(m.cost, 0) }), m.closed ? null : 'Live'].filter(Boolean).join('  ·  ');
  text(ctx, sub, 60, 460, { size: 30, color: C.muted });
  if (m.acts.length) {
    const tot = actTotals(m.acts);
    const line = actLines(tot, t, hide).map((l) => l.s).join('  ·  ');
    ctx.save(); ctx.font = font(26, 400); const w = ctx.measureText(line).width; ctx.restore();
    text(ctx, line, 60, 512, { size: Math.min(26, 26 * ((S - 120) / Math.max(1, w))), color: C.muted });
  }

  // Mini chart of the position's life only, fully drawn.
  // Hell: the chart makes room on the right for the mascot.
  const box = { x0: 60, x1: hell ? 700 : S - 60, y0: 600, y1: 960 };
  const life = m.pts.filter(([ts]) => ts >= m.tOpen && ts <= m.tClose);
  const all = [[m.tOpen, m.entry], ...life, [m.tClose, m.exit]];
  const mlo = Math.min(m.a, ...all.map((x) => x[1])), mhi = Math.max(m.b, ...all.map((x) => x[1]));
  const lo = Math.max(mlo, Math.min(...all.map((x) => x[1])) * 0.5), hi = Math.min(mhi, Math.max(...all.map((x) => x[1])) * 1.5);
  const pad = (hi - lo) * 0.08;
  const X = (ts) => lerp(box.x0 + 30, box.x1 - 30, (ts - m.tOpen) / (m.tClose - m.tOpen || 1));
  const Y = (v) => lerp(box.y1, box.y0, (v - lo + pad) / (hi - lo + 2 * pad || 1));
  const ya = clamp(Y(m.b), box.y0 - 10, box.y1), yb = clamp(Y(m.a), box.y0, box.y1 + 10);
  ctx.fillStyle = C.band; ctx.fillRect(X(m.tOpen), ya, X(m.tClose) - X(m.tOpen), yb - ya);
  ctx.strokeStyle = C.bandLine; ctx.lineWidth = 2; ctx.strokeRect(X(m.tOpen), ya, X(m.tClose) - X(m.tOpen), yb - ya);
  const draw = ease(span(sec, TL.summary + 0.3, TL.summary + 1.8));
  const cut = lerp(m.tOpen, m.tClose, draw);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, X(cut) + 2, S); ctx.clip();
  ctx.beginPath(); all.forEach(([ts, v], i) => (i ? ctx.lineTo(X(ts), Y(v)) : ctx.moveTo(X(ts), Y(v))));
  ctx.strokeStyle = C.accent; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.shadowColor = C.accent; ctx.shadowBlur = 10; ctx.stroke();
  ctx.restore();
  const dot = (x, y) => { ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); };
  dot(X(m.tOpen), Y(m.entry));
  text(ctx, t('Masuk {v}', { v: price(m.entry) }), X(m.tOpen) + 14, Y(m.entry) - 14, { size: 22, color: C.muted });
  if (draw >= 1) {
    dot(X(m.tClose), Y(m.exit));
    text(ctx, t(m.closed ? 'Keluar {v}' : 'Sekarang {v}', { v: price(m.exit) }), X(m.tClose) - 14, Y(m.exit) - 14, { size: 22, color: C.muted, align: 'right' });
  }
  for (const c of m.acts) if (c.ts <= cut) actRing(ctx, c, X(c.ts), Y(m.priceAt(c.ts)), 12);
  pill(ctx, t('In range {v}', { v: `${Math.round(m.inRangePct)}%` }), (box.x0 + box.x1) / 2, box.y0 - 30, { size: 22, color: '#0A0B0D', fill: C.accent, align: 'center' });
  if (hell) drawMascot(ctx, mascotOf(m.pnl, m.pnlPct), 880, S + 10, 520, ease(span(sec, TL.summary + 0.4, TL.summary + 1.1)));
  ctx.restore();
}

// Logo outro, shared with the month replay. Hell: the logo moves up and the mascot rises
// in under it.
export function outro(ctx, sec, start, t, line, theme, im) {
  const a = ease(span(sec, start, start + 0.7));
  const hell = videoTheme(theme) === 'hell', y = hell ? 170 : 400;
  ctx.save(); ctx.globalAlpha = a;
  const h = 96, w = (264 / 48) * h;
  logo(ctx, (S - w) / 2, y - (1 - a) * 20, h);
  text(ctx, t('Bot copy LP otomatis'), S / 2, y + 200, { size: 34, color: C.muted, align: 'center' });
  text(ctx, line, S / 2, y + 260, { size: 26, color: C.faint, align: 'center' });
  ctx.restore();
  if (hell) drawMascot(ctx, im, S / 2, S + 10, 600, ease(span(sec, start + 0.3, start + 1.1)));
}

export function drawFrame(ctx, m, img, sec, t, hide, coins, theme, fx) {
  paint(theme, fx);
  ctx.save();
  backdrop(ctx, sec, theme);
  // Scene crossfades: chart → summary → outro.
  const out1 = 1 - ease(span(sec, TL.summary - 0.4, TL.summary));
  if (out1 > 0) { ctx.save(); ctx.globalAlpha = out1; chartScene(ctx, m, img, sec, t, hide, coins); ctx.restore(); }
  const out2 = 1 - ease(span(sec, TL.outro - 0.4, TL.outro));
  if (sec >= TL.summary && out2 > 0) { ctx.save(); ctx.globalAlpha = out2; summaryScene(ctx, m, sec, t, hide, theme); ctx.restore(); }
  if (sec >= TL.outro) outro(ctx, sec, TL.outro, t, `${m.p.venue} · ${m.p.chain}`, theme, mascotOf(m.pnl, m.pnlPct));
  ctx.restore();
}

// ---- sound -------------------------------------------------------------------------

const SR = 44100;
const note = (semi) => 220 * 2 ** (semi / 12);   // A3 and up

// The soundtrack is synthesized once per clip into an AudioBuffer, from the same timeline
// as the picture: a quiet pad, a pop and a clink per fee coin, a thump when the range opens and
// a two-note close. The summary chime rises for a profit and falls for a loss. It is mixed
// into the recording only; the preview stays silent.
async function renderSound(m, coins) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new Offline(2, Math.ceil(SR * TL.end), SR);
  const master = oc.createGain();
  master.gain.value = 0.8;
  master.connect(oc.destination);

  // One enveloped tone: linear attack, exponential decay.
  const tone = (at, freq, { dur = 0.5, gain = 0.1, type = 'sine', attack = 0.01, to = null, out = master } = {}) => {
    const o = oc.createOscillator(); const g = oc.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + dur + 0.05);
  };

  // Pad: a soft Am9 chord under the whole clip, faded in and out.
  const lp = oc.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 900;
  const padGain = oc.createGain();
  padGain.gain.setValueAtTime(0.0001, 0);
  padGain.gain.linearRampToValueAtTime(0.05, 2);
  padGain.gain.setValueAtTime(0.05, TL.outro);
  padGain.gain.linearRampToValueAtTime(0.0001, TL.end);
  lp.connect(padGain); padGain.connect(master);
  [-12, -5, 0, 3, 7].forEach((semi, i) => {
    [-3, 3].forEach((detune) => {
      const o = oc.createOscillator();
      o.type = 'triangle'; o.frequency.value = note(semi); o.detune.value = detune + i;
      o.connect(lp); o.start(0); o.stop(TL.end);
    });
  });

  // Range opens: low thump and a click.
  tone(TL.open, 140, { dur: 0.45, gain: 0.22, to: 55 });
  tone(TL.open, 1500, { dur: 0.06, gain: 0.05, type: 'triangle' });

  // Fee coins: a soft pop when a coin leaves the line, and a bright two-partial clink when
  // it lands in the fee counter (1.1 s later, as in chartScene). The clink climbs a
  // pentatonic scale so the stream of coins sounds like a melody, not a machine gun.
  const scale = [12, 14, 16, 19, 21, 24];
  coins.forEach((c) => {
    tone(c.s, 520, { dur: 0.09, gain: 0.05, to: 300 });
    const f = note(scale[c.k % scale.length] + 12);
    const land = c.s + 1.1;
    tone(land, f, { dur: 0.28, gain: 0.07, attack: 0.003 });
    tone(land, f * 2.76, { dur: 0.12, gain: 0.03, attack: 0.002 });
  });

  // Markers: a soft two-note blip as each one pops.
  m.acts.forEach((c) => {
    tone(c.s, note(c.n.remove ? 7 : 12), { dur: 0.25, gain: 0.07, type: 'triangle', attack: 0.005 });
    tone(c.s + 0.08, note(c.n.remove ? 3 : 19), { dur: 0.35, gain: 0.06, type: 'triangle', attack: 0.005 });
  });

  // Close: two soft notes.
  tone(TL.close, note(7), { dur: 0.7, gain: 0.1 });
  tone(TL.close + 0.12, note(0), { dur: 0.9, gain: 0.1 });

  // Summary: rising arpeggio for a profit, falling pair for a loss.
  const win = (m.pnl ?? 0) >= 0;
  (win ? [0, 4, 7, 12, 16] : [7, 3, -2]).forEach((semi, i) => {
    tone(TL.summary + 0.35 + i * 0.14, note(semi + 12), { dur: win ? 1.1 : 1.3, gain: 0.08, attack: 0.02 });
  });

  // Outro: one long note.
  tone(TL.outro, note(0), { dur: 2.2, gain: 0.1, attack: 0.08 });
  tone(TL.outro, note(7), { dur: 2.2, gain: 0.06, attack: 0.08 });

  return oc.startRendering();
}

// ---- recording ---------------------------------------------------------------------

// MP4 where the browser can (Safari, recent Chrome) — X and Telegram take it as is;
// otherwise WebM. The audio codec goes in the type so the recorder accepts the audio track.
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((x) => MediaRecorder.isTypeSupported(x)) || null;
}

// MediaRecorder writes a fragmented MP4 (or a WebM) with no duration in its headers, which
// phone players show as 00:00 and cannot seek. Remux the same encoded frames, no
// re-encoding, into a regular file with the duration and index at the front. Falls back to
// the raw recording if the remux fails.
async function remux(blob) {
  try {
    const { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, WebMOutputFormat, ALL_FORMATS } = await import('mediabunny');
    const mp4 = blob.type.includes('mp4');
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target: new BufferTarget() });
    const conv = await Conversion.init({ input, output });
    if (conv.discardedTracks.length) return blob;
    await conv.execute();
    return new Blob([output.target.buffer], { type: blob.type });
  } catch { return blob; }
}

function iconSrc(addr) {
  const a = canonAddr(addr);
  return KNOWN[a] || (isAddr(a) && !/^0x0+$/.test(a) ? withTicket(`/api/icon?a=${a}`) : null);
}

// Looping canvas preview + record/download/share, shared by the position replay and the
// month calendar replay. `draw(ctx, sec)` paints the frame at clip time `sec` (a pure
// function of time, so the preview and the recording match); `sound()` synthesizes the
// soundtrack (an AudioBuffer) mixed into the recording only. A new `resetKey` drops the
// last recording, as it no longer matches what the preview shows.
export function ReplayPlayer({ draw, end, sound, ready, error, loading, note, fileName, resetKey }) {
  const { t } = useI18n();
  const canvas = useRef(null);
  const [rec, setRec] = useState(null);         // null | progress 0..1 while recording
  const [video, setVideo] = useState(null);     // { blob, url, ext } of the last recording
  const clock = useRef({ start: performance.now(), recording: null });

  useEffect(() => { setVideo(null); }, [resetKey]);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video.url); }, [video]);
  // Canvas text only uses Inter once the font is loaded.
  useEffect(() => { document.fonts?.load?.(font(64, 700)).catch(() => {}); }, []);

  // One animation loop for both the preview and the recording.
  useEffect(() => {
    if (!ready || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    let raf;
    const loop = (now) => {
      const r = clock.current.recording;
      const sec = ((now - (r ? r.start : clock.current.start)) / 1000);
      if (r) {
        draw(ctx, Math.min(sec, end));
        setRec(Math.min(1, sec / end));
        if (sec >= end) { clock.current.recording = null; r.stop(); clock.current.start = now; }
      } else draw(ctx, sec % end);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, draw, end]);

  const mime = pickMime();
  const record = async () => {
    const stream = canvas.current.captureStream(FPS);
    let actx = null; let source = null;
    try {
      // Synthesized soundtrack as an extra audio track. If audio is not available the
      // clip is recorded silent rather than failing.
      const buffer = await sound();
      actx = new (window.AudioContext || window.webkitAudioContext)();
      await actx.resume();
      const dest = actx.createMediaStreamDestination();
      source = actx.createBufferSource();
      source.buffer = buffer; source.connect(dest);
      dest.stream.getAudioTracks().forEach((x) => stream.addTrack(x));
    } catch { source = null; }
    return new Promise((resolve, reject) => recordStream(stream, source, actx, resolve, reject));
  };
  const recordStream = (stream, source, actx, resolve, reject) => {
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onerror = (e) => reject(e.error || new Error('MediaRecorder'));
    mr.onstop = () => { stream.getTracks().forEach((x) => x.stop()); actx?.close?.(); resolve(new Blob(chunks, { type: mime.split(';')[0] })); };
    mr.start(500);
    source?.start();
    clock.current.recording = { start: performance.now(), stop: () => mr.stop() };
  };

  const make = async () => {
    setRec(0);
    try {
      const raw = await record();
      const blob = await remux(raw);
      setVideo({ blob, ext: blob.type.includes('mp4') ? 'mp4' : 'webm', url: URL.createObjectURL(blob) });
    } catch (e) {
      toast.danger(t('Video gagal direkam'), { description: String(e?.message || e) });
    } finally { setRec(null); }
  };
  // Download and share come only after the recording: the share sheet needs a fresh
  // click, and the recording uses that click up.
  const file = video ? new File([video.blob], `${fileName}.${video.ext}`.replace(/[^A-Za-z0-9.+-]+/g, '-').replace(/-+/g, '-'), { type: video.blob.type }) : null;
  const canShare = !!file && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });
  const download = () => {
    const a = document.createElement('a');
    a.href = video.url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const share = async () => {
    try { await navigator.share({ files: [file], title: 'Quiver' }); }
    catch (e) { if (e?.name !== 'AbortError') toast.danger(t('Gagal membagikan'), { description: String(e?.message || e) }); }
  };

  const busy = rec != null;
  return (
    <div>
      <div className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-[#0A0B0D]" style={{ aspectRatio: 1, maxHeight: '60vh', maxWidth: '60vh' }}>
        <canvas ref={canvas} width={S} height={S} className={`block h-full w-full ${ready ? '' : 'hidden'}`} />
        {!ready && !error && <div className="flex h-full items-center justify-center text-xs text-muted">{t(loading)}</div>}
        {error && <div className="flex h-full items-center justify-center p-6 text-center text-xs text-warning">{t('Replay tidak bisa dibuat')}: {t(error)}</div>}
        {busy && <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40"><div className="h-full bg-accent transition-[width]" style={{ width: `${rec * 100}%` }} /></div>}
      </div>
      {note && <p className="mt-2 text-xs text-muted">{t(note)}</p>}
      {!mime && <p className="mt-1 text-xs text-warning">{t('Browser ini tidak bisa merekam video. Coba Chrome atau Safari terbaru.')}</p>}
      {busy && <p className="mt-1 text-xs text-muted">{t('Merekam {n} dtk — biarkan tab ini tetap terbuka.', { n: Math.ceil(end * (1 - rec)) })}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant={video ? 'tertiary' : 'primary'} className="grow sm:grow-0" isDisabled={!ready || !mime || busy} isPending={busy} onPress={make}>
          <Clapperboard className="size-4" />{t(video ? 'Rekam ulang' : 'Rekam video')}
        </Button>
        {video && <Button variant={canShare ? 'outline' : 'primary'} className="grow sm:grow-0" onPress={download}><Download className="size-4" />{t('Unduh video')}</Button>}
        {canShare && <Button variant="primary" className="grow sm:grow-0" onPress={share}><Share2 className="size-4" />{t('Bagikan video')}</Button>}
      </div>
    </div>
  );
}

// The position video tab.
export default function ShareReplay({ id, hide, name, theme, fx }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const img = useRef([null, null]);

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    get(`/api/share/replay?id=${encodeURIComponent(id)}`)
      .then((r) => { if (!alive) return; if (r?.error) setError(r.error); else setData(r); })
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [id]);

  const m = useMemo(() => { try { return data ? buildModel(data) : null; } catch (e) { return { error: e.message }; } }, [data]);
  const coins = useMemo(() => (m && !m.error ? coinsOf(m) : []), [m]);

  useEffect(() => {
    if (!data) return;
    img.current = [data.position.token0, data.position.token1].map((a) => {
      const src = iconSrc(a);
      if (!src) return null;
      const im = new Image(); im.decoding = 'async'; im.src = src; return im;
    });
  }, [data]);

  // Warm the mascot image before the first frame needs it.
  useEffect(() => { if (m && !m.error && videoTheme(theme) === 'hell') mascotOf(m.pnl, m.pnlPct); }, [m, theme]);
  const draw = useCallback((ctx, sec) => drawFrame(ctx, m, img.current, sec, t, hide, coins, theme, fx), [m, t, hide, coins, theme, fx]);
  const sound = useCallback(() => renderSound(m, coins), [m, coins]);
  return (
    <ReplayPlayer draw={draw} end={TL.end} sound={sound} ready={!!m && !m.error} error={error || m?.error}
      loading="Menyiapkan replay…" note="Fee dan PnL di tengah video adalah perkiraan dari harga; angka akhirnya angka asli."
      fileName={`quiver-${name}-replay`} resetKey={`${id}:${hide}:${videoTheme(theme)}:${fx?.currency || 'usd'}`} />
  );
}
