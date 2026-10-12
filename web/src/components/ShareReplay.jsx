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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Download, Share2, Clapperboard } from 'lucide-react';
import { get } from '../api';
import { useI18n } from '../i18n';
import { usd, pct, price } from '../fmt';
import { canonAddr, isAddr } from '../chain';
import { KNOWN, hue } from './TokenIcon';
import { ARROW, CHEVRON, WORDMARK } from './Logo';

const S = 1080;                 // canvas side (px)
const FPS = 30;
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
const C = {
  bg: '#0A0B0D', text: '#F4F6F5', muted: '#8B9392', faint: '#5C6463', grid: 'rgba(255,255,255,0.06)',
  up: '#4ADE80', down: '#F87171', amber: '#FBBF24', accent: '#7AA2F7',
  band: 'rgba(122,162,247,0.12)', bandLine: 'rgba(122,162,247,0.45)',
};
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';
const CHART = { x0: 60, x1: 900, y0: 250, y1: 770 };   // price chart area (axis labels to the right)

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, u) => a + (b - a) * u;
const ease = (u) => 1 - (1 - clamp(u)) ** 3;
const span = (sec, a, b) => clamp((sec - a) / (b - a));

// ---- model ---------------------------------------------------------------------------

// Concentrated-liquidity value of a position with range [a, b] at price p, in quote units
// per unit of liquidity. Only the ratio v(p) / v(entry) is used.
function clValue(p, a, b) {
  const sa = Math.sqrt(a), sb = Math.sqrt(b);
  if (p <= a) return p * (1 / sa - 1 / sb);
  if (p >= b) return sb - sa;
  return 2 * Math.sqrt(p) - sa - p / sb;
}

export function buildModel({ position: p, chart }) {
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
  return { p, pts, closed, t0, tOpen, tClose, tLast, a, b, inBand, priceAt, entry, exit: priceAt(tClose), inRangePct, fee, cost, pnl, pnlPct: p.pnlPct, feeAt, pnlAt, lo, hi, duration };
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

const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
function text(ctx, s, x, y, { size = 28, weight = 400, color = C.text, align = 'left', base = 'alphabetic', alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.font = font(size, weight); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  ctx.fillText(s, x, y); ctx.restore();
}
function pill(ctx, s, x, y, { size = 22, color = C.text, fill = 'rgba(255,255,255,0.08)', align = 'left', dot = null, alpha = 1 } = {}) {
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
function logo(ctx, x, y, h, { word = true, color = C.text, alpha = 1 } = {}) {
  if (!LOGO) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.scale(h / 48, h / 48); ctx.fillStyle = color;
  ctx.fill(LOGO.mark); if (word) ctx.fill(LOGO.word, 'evenodd');
  ctx.restore();
}

// "1j 38m" — compact elapsed time for the counters.
function since(ms, t) {
  const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return t('{d}h {h}j', { d, h: h % 24 });
  if (h > 0) return t('{h}j {m}m', { h, m: String(m % 60).padStart(2, '0') });
  return t('{m}m', { m });
}
const signed = (v) => (v > 0 ? '+' : '') + usd(v);
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
  text(ctx, t('Waktu'), 60, 880, { size: 24, color: C.muted });
  text(ctx, since(m.duration * u, t), 60, 950, { size: 64, weight: 600 });
  text(ctx, 'Fee', 290, 880, { size: 24, color: C.muted });
  ctx.save(); ctx.translate(290, 950); ctx.scale(1 + pulse * 0.05, 1 + pulse * 0.05);
  text(ctx, hide ? pct(m.cost > 0 ? (fee / m.cost) * 100 : 0, 1) : usd(fee), 0, 0, { size: 64, weight: 600, color: u > 0 ? C.up : C.faint });
  ctx.restore();
  text(ctx, 'PnL', S - 60, 880, { size: 24, color: C.muted, align: 'right' });
  const pnlText = hide ? pct(m.cost > 0 ? (pnl / m.cost) * 100 : u * (m.pnlPct || 0), 1) : signed(pnl);
  text(ctx, pnlText, S - 60, 950, { size: 64, weight: 600, align: 'right', color: u > 0 ? toneOf(pnl) : C.faint });
  ctx.restore();
}

function dashed(ctx, x, ya, yb, label, side, alpha) {
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
  ctx.restore();
  text(ctx, label, side === 'left' ? x + 12 : x - 12, ya + 6, { size: 20, color: C.muted, align: side === 'left' ? 'left' : 'right', alpha });
}

function summaryScene(ctx, m, sec, t, hide) {
  const { p } = m;
  const a = ease(span(sec, TL.summary, TL.summary + 0.6));
  ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 24);
  logo(ctx, 60, 60, 36);
  pill(ctx, p.venue, S - 60, 80, { size: 22, color: C.muted, align: 'right', dot: m.closed ? C.muted : C.up });
  text(ctx, `${p.symbol0 || '?'} / ${p.symbol1 || '?'}`, 60, 200, { size: 36, weight: 600 });
  const k = ease(span(sec, TL.summary + 0.2, TL.summary + 1.4));
  text(ctx, 'Fee', 60, 270, { size: 28, color: C.muted });
  text(ctx, hide ? pct(m.cost > 0 ? (m.fee / m.cost) * 100 * k : 0, 1) : usd(m.fee * k), 60, 390, { size: 120, weight: 700, color: C.up });
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(520, 260, 2, 140); ctx.restore();
  text(ctx, 'PnL', 570, 270, { size: 28, color: C.muted });
  text(ctx, hide ? pct((m.pnlPct || 0) * k, 1) : signed(m.pnl * k), 570, 390, { size: 120, weight: 700, color: toneOf(m.pnl) });
  const sub = [since(m.duration, t), hide ? null : t('posisi {v}', { v: usd(m.cost, 0) }), m.closed ? null : 'Live'].filter(Boolean).join('  ·  ');
  text(ctx, sub, 60, 460, { size: 30, color: C.muted });

  // Mini chart of the position's life only, fully drawn.
  const box = { x0: 60, x1: S - 60, y0: 600, y1: 960 };
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
  pill(ctx, t('In range {v}', { v: `${Math.round(m.inRangePct)}%` }), (box.x0 + box.x1) / 2, box.y0 - 30, { size: 22, color: '#0A0B0D', fill: C.accent, align: 'center' });
  ctx.restore();
}

function outroScene(ctx, m, sec, t) {
  const a = ease(span(sec, TL.outro, TL.outro + 0.7));
  ctx.save(); ctx.globalAlpha = a;
  const h = 96, w = (264 / 48) * h;
  logo(ctx, (S - w) / 2, 400 - (1 - a) * 20, h);
  text(ctx, t('Bot copy LP otomatis'), S / 2, 600, { size: 34, color: C.muted, align: 'center' });
  text(ctx, `${m.p.venue} · ${m.p.chain}`, S / 2, 660, { size: 26, color: C.faint, align: 'center' });
  ctx.restore();
}

export function drawFrame(ctx, m, img, sec, t, hide, coins) {
  ctx.save();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, S, S);
  // Scene crossfades: chart → summary → outro.
  const out1 = 1 - ease(span(sec, TL.summary - 0.4, TL.summary));
  if (out1 > 0) { ctx.save(); ctx.globalAlpha = out1; chartScene(ctx, m, img, sec, t, hide, coins); ctx.restore(); }
  const out2 = 1 - ease(span(sec, TL.outro - 0.4, TL.outro));
  if (sec >= TL.summary && out2 > 0) { ctx.save(); ctx.globalAlpha = out2; summaryScene(ctx, m, sec, t, hide); ctx.restore(); }
  if (sec >= TL.outro) outroScene(ctx, m, sec, t);
  ctx.restore();
}

// ---- recording ---------------------------------------------------------------------

// MP4 where the browser can (Safari, recent Chrome) — X and Telegram take it as is;
// otherwise WebM.
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((x) => MediaRecorder.isTypeSupported(x)) || null;
}

function iconSrc(addr) {
  const a = canonAddr(addr);
  return KNOWN[a] || (isAddr(a) && !/^0x0+$/.test(a) ? `/api/icon?a=${a}` : null);
}

// The video tab: looping preview + record/download/share.
export default function ShareReplay({ id, hide, name }) {
  const { t } = useI18n();
  const canvas = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [rec, setRec] = useState(null);         // null | progress 0..1 while recording
  const [video, setVideo] = useState(null);     // { blob, url, ext } of the last recording
  const img = useRef([null, null]);
  const clock = useRef({ start: performance.now(), recording: null });

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
    // Canvas text only uses Inter once the font is loaded.
    document.fonts?.load?.(font(64, 700)).catch(() => {});
  }, [data]);

  // A recording made with other settings is no longer what the preview shows.
  useEffect(() => { setVideo(null); }, [id, hide]);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video.url); }, [video]);

  // One animation loop for both the preview and the recording.
  useEffect(() => {
    if (!m || m.error || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    let raf;
    const loop = (now) => {
      const r = clock.current.recording;
      const sec = ((now - (r ? r.start : clock.current.start)) / 1000);
      if (r) {
        drawFrame(ctx, m, img.current, Math.min(sec, TL.end), t, hide, coins);
        setRec(Math.min(1, sec / TL.end));
        if (sec >= TL.end) { clock.current.recording = null; r.stop(); clock.current.start = now; }
      } else drawFrame(ctx, m, img.current, sec % TL.end, t, hide, coins);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [m, coins, t, hide]);

  const mime = pickMime();
  const record = () => new Promise((resolve, reject) => {
    const stream = canvas.current.captureStream(FPS);
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onerror = (e) => reject(e.error || new Error('MediaRecorder'));
    mr.onstop = () => { stream.getTracks().forEach((x) => x.stop()); resolve(new Blob(chunks, { type: mime.split(';')[0] })); };
    mr.start(500);
    clock.current.recording = { start: performance.now(), stop: () => mr.stop() };
  });

  const make = async () => {
    setRec(0);
    try {
      const blob = await record();
      setVideo({ blob, ext: blob.type.includes('mp4') ? 'mp4' : 'webm', url: URL.createObjectURL(blob) });
    } catch (e) {
      toast.danger(t('Video gagal direkam'), { description: String(e?.message || e) });
    } finally { setRec(null); }
  };
  // Download and share come only after the recording: the share sheet needs a fresh
  // click, and 22 seconds of recording use that click up.
  const file = video ? new File([video.blob], `quiver-${name}-replay.${video.ext}`.replace(/[^A-Za-z0-9.+-]+/g, '-').replace(/-+/g, '-'), { type: video.blob.type }) : null;
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

  const err = error || m?.error;
  const busy = rec != null;
  return (
    <div>
      <div className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-[#0A0B0D]" style={{ aspectRatio: 1, maxHeight: '60vh', maxWidth: '60vh' }}>
        <canvas ref={canvas} width={S} height={S} className={`block h-full w-full ${m && !m.error ? '' : 'hidden'}`} />
        {!m && !err && <div className="flex h-full items-center justify-center text-xs text-muted">{t('Menyiapkan replay…')}</div>}
        {err && <div className="flex h-full items-center justify-center p-6 text-center text-xs text-warning">{t('Replay tidak bisa dibuat')}: {t(err)}</div>}
        {busy && <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40"><div className="h-full bg-accent transition-[width]" style={{ width: `${rec * 100}%` }} /></div>}
      </div>
      <p className="mt-2 text-xs text-muted">{t('Fee dan PnL di tengah video adalah perkiraan dari harga; angka akhirnya angka asli.')}</p>
      {!mime && <p className="mt-1 text-xs text-warning">{t('Browser ini tidak bisa merekam video. Coba Chrome atau Safari terbaru.')}</p>}
      {busy && <p className="mt-1 text-xs text-muted">{t('Merekam {n} dtk — biarkan tab ini tetap terbuka.', { n: Math.ceil(TL.end * (1 - rec)) })}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant={video ? 'tertiary' : 'primary'} className="grow sm:grow-0" isDisabled={!m || !!m.error || !mime || busy} isPending={busy} onPress={make}>
          <Clapperboard className="size-4" />{t(video ? 'Rekam ulang' : 'Rekam video')}
        </Button>
        {video && <Button variant={canShare ? 'outline' : 'primary'} className="grow sm:grow-0" onPress={download}><Download className="size-4" />{t('Unduh video')}</Button>}
        {canShare && <Button variant="primary" className="grow sm:grow-0" onPress={share}><Share2 className="size-4" />{t('Bagikan video')}</Button>}
      </div>
    </div>
  );
}
