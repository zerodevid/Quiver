// Month replay — the "Video" tab of the PnL calendar month card. A ~19 second square clip:
// the empty month grid appears, the days light up one by one in calendar order (each day's
// realized PnL pops in its cell while the month total runs up at the top; the sweep runs from
// the first to the last day with PnL), the best day is singled out, then a summary card and
// the logo outro.
//
// Drawn in the browser and recorded by ReplayPlayer (ShareReplay.jsx), like the position
// replay; the server only hands over the month's figures (GET /api/share/month — the same
// data as the month share card). Every frame is a pure function of the clip time.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get } from '../api';
import { useI18n } from '../i18n';
import { usd, pct } from '../fmt';
import { ReplayPlayer, S, C, clamp, lerp, ease, span, text, pill, logo } from './ShareReplay';

// Timeline (seconds of clip time).
const TL = {
  grid: 0.5,          // header is in; the empty grid fades in cell by cell
  days: 1.8,          // the first day lights up…
  daysEnd: 10.8,      // …the last one by here
  best: 11.1,         // the best day is singled out
  summary: 12.9,      // summary card
  outro: 17.2,        // logo outro
  end: 19.5,
};
const POP = 0.35;     // seconds a day takes to pop in
const GRID = { x: 60, y: 300, w: S - 120, h: 720, head: 34, gap: 10 };
const WEEKDAYS = { id: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };

const toneOf = (v) => (v > 0.005 ? C.up : v < -0.005 ? C.down : C.text);
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const signed = (v) => (v > 0.005 ? '+' : '') + usd(v);
// Compact dollars for a cell: +$45, +$1.2k, −$3.4 (the same as the month share card).
function cellUsd(v, locale) {
  const a = Math.abs(v), s = v > 0.005 ? '+' : v < -0.005 ? '−' : '';
  const f = (x, d) => x.toLocaleString(locale === 'en' ? 'en-US' : 'id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e6) return `${s}$${f(a / 1e6, 1)}M`;
  if (a >= 1e3) return `${s}$${f(a / 1e3, a >= 1e4 ? 0 : 1)}k`;
  return `${s}$${f(a, a >= 10 ? 0 : 1)}`;
}
// Back-out easing for the pop: overshoots a little, then settles at 1.
const back = (u) => { const x = clamp(u) - 1; return 1 + 2.2 * x ** 3 + 1.2 * x ** 2; };

export function buildMonth({ month, daily, counts = {}, cost = 0, chain }, locale) {
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(), n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const rows = Math.ceil((first + n) / 7);
  const cw = (GRID.w - GRID.gap * 6) / 7, ch = (GRID.h - GRID.head - GRID.gap * (rows - 1)) / rows;
  // The sweep runs from the first to the last day with PnL: the empty days before and after
  // (e.g. the rest of a month still running) are never reached, and the sweep's time is spread
  // over the days in between.
  const keyOf = (d) => `${month}-${String(d).padStart(2, '0')}`;
  let start = 1, last = n;
  while (last > 1 && daily[keyOf(last)] == null) last--;
  while (start < last && daily[keyOf(start)] == null) start++;
  const days = [];
  for (let d = 1; d <= n; d++) {
    const key = keyOf(d), i = first + d - 1;
    days.push({ d, key, v: daily[key] ?? null, n: counts[key] || 0,
      at: d < start || d > last ? Infinity : lerp(TL.days, TL.daysEnd, (d - start) / Math.max(1, last - start)),
      x: GRID.x + (i % 7) * (cw + GRID.gap), y: GRID.y + GRID.head + Math.floor(i / 7) * (ch + GRID.gap) });
  }
  const active = days.filter((x) => x.v != null);
  const maxAbs = Math.max(1e-9, ...active.map((x) => Math.abs(x.v)));
  const total = active.reduce((a, x) => a + x.v, 0);
  const best = active.reduce((a, x) => (a == null || x.v > a.v ? x : a), null);
  const name = new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString(locale === 'en' ? 'en-US' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return {
    month, name, chain, days, active, cw, ch, maxAbs, total, best, cost,
    pctV: cost > 0 ? (total / cost) * 100 : null,
    green: active.filter((x) => x.v > 0.005).length, red: active.filter((x) => x.v < -0.005).length,
    closed: active.reduce((a, x) => a + x.n, 0),
  };
}

// Month total as the days have popped in so far (each day eases in over POP).
const runningAt = (m, sec) => m.active.reduce((a, x) => a + x.v * ease(span(sec, x.at, x.at + POP)), 0);

function header(ctx, m, sec, t, hide) {
  const a = ease(span(sec, 0, 0.6));
  ctx.save(); ctx.globalAlpha *= a;
  logo(ctx, 60, 56, 40);
  pill(ctx, m.chain, S - 60, 76, { size: 22, color: C.muted, align: 'right' });
  text(ctx, t('Kalender PnL').toUpperCase(), 60, 178, { size: 22, weight: 600, color: C.muted });
  text(ctx, m.name, 60, 250, { size: 60, weight: 700 });
  // Running month total, top right.
  const run = runningAt(m, sec);
  const big = hide ? (m.cost > 0 ? pct((run / m.cost) * 100, 2) : '••••') : signed(run);
  text(ctx, t('PnL terealisasi').toUpperCase(), S - 60, 178, { size: 22, weight: 600, color: C.muted, align: 'right' });
  text(ctx, big, S - 60, 250, { size: 60, weight: 700, color: toneOf(run), align: 'right' });
  ctx.restore();
}

function gridScene(ctx, m, sec, t, hide, locale) {
  const { cw, ch } = m;
  const names = WEEKDAYS[locale === 'en' ? 'en' : 'id'];
  const bestOn = ease(span(sec, TL.best, TL.best + 0.5));
  ctx.save();
  names.forEach((nm, i) => text(ctx, nm.toUpperCase(), GRID.x + i * (cw + GRID.gap) + cw / 2, GRID.y + 20,
    { size: 18, weight: 600, color: C.faint, align: 'center', alpha: ease(span(sec, TL.grid, TL.grid + 0.5)) }));
  for (const x of m.days) {
    // Empty cell fades in, staggered along the grid.
    const appear = ease(span(sec, TL.grid + x.d * 0.025, TL.grid + x.d * 0.025 + 0.4));
    if (appear <= 0) continue;
    const u = span(sec, x.at, x.at + POP), lit = x.v != null && u > 0;
    const dim = x === m.best ? 1 : 1 - bestOn * 0.45;
    ctx.save(); ctx.globalAlpha *= appear * dim;
    // Pop: the cell scales from its centre with a small overshoot.
    const sc = lit ? lerp(0.7, 1, back(u)) : 1;
    ctx.translate(x.x + cw / 2, x.y + ch / 2); ctx.scale(sc, sc); ctx.translate(-cw / 2, -ch / 2);
    let fill = 'rgba(255,255,255,0.03)', stroke = 'rgba(255,255,255,0.08)';
    if (lit && Math.abs(x.v) > 0.005) {
      const k = Math.sqrt(Math.min(1, Math.abs(x.v) / m.maxAbs)), c = x.v > 0 ? C.up : C.down, f = ease(u);
      fill = rgba(c, ((0.1 + 0.32 * k) * f).toFixed(3)); stroke = rgba(c, ((0.25 + 0.4 * k) * f + 0.08 * (1 - f)).toFixed(3));
    }
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(0, 0, cw, ch, 12); ctx.fill(); ctx.stroke();
    // The day being reached gets a brief white outline (also on days without PnL).
    const cursor = 1 - span(sec, x.at, x.at + 0.5);
    if (sec >= x.at && cursor > 0) {
      ctx.save(); ctx.globalAlpha *= cursor * 0.7; ctx.strokeStyle = C.text; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(0, 0, cw, ch, 12); ctx.stroke(); ctx.restore();
    }
    text(ctx, String(x.d), 12, 30, { size: 22, weight: 500, color: x.v != null ? C.muted : C.faint });
    if (x.n > 1 && lit) text(ctx, `×${x.n}`, cw - 12, 30, { size: 18, color: C.faint, align: 'right' });
    if (lit && !hide) {
      ctx.save(); ctx.font = `600 26px Inter, ui-sans-serif, system-ui, sans-serif`;
      const s = cellUsd(x.v, locale);
      const size = Math.min(26, 26 * ((cw - 20) / Math.max(1, ctx.measureText(s).width)));
      ctx.restore();
      text(ctx, s, 12, ch - 16, { size, weight: 600, color: toneOf(x.v), alpha: ease(u) });
    }
    ctx.restore();
    // Floating figure that rises out of a cell when it pops.
    if (lit && !hide && u < 1) {
      const f = span(sec, x.at, x.at + 1.0);
      if (f < 1) text(ctx, cellUsd(x.v, locale), x.x + cw / 2, x.y - 6 - f * 46, { size: 26, weight: 700, color: toneOf(x.v), align: 'center', alpha: (1 - f) * 0.9 });
    }
  }
  // Best day: a pulsing ring and a label above the cell.
  if (m.best && bestOn > 0) {
    const b = m.best, pulse = 0.5 + 0.5 * Math.sin((sec - TL.best) * 6);
    ctx.save(); ctx.globalAlpha *= bestOn;
    ctx.strokeStyle = toneOf(b.v); ctx.lineWidth = 4 + pulse * 2; ctx.shadowColor = toneOf(b.v); ctx.shadowBlur = 24 + pulse * 16;
    ctx.beginPath(); ctx.roundRect(b.x - 4, b.y - 4, cw + 8, ch + 8, 15); ctx.stroke();
    ctx.restore();
    const lx = clamp(b.x + cw / 2, 150, S - 150);
    pill(ctx, t('Hari terbaik') + (hide ? '' : ` · ${cellUsd(b.v, locale)}`), lx, b.y - 30 - (1 - bestOn) * 12,
      { size: 22, color: '#0A0B0D', fill: toneOf(b.v), align: 'center', alpha: bestOn });
  }
  ctx.restore();
}

function summaryScene(ctx, m, sec, t, hide, locale) {
  const a = ease(span(sec, TL.summary, TL.summary + 0.6));
  ctx.save(); ctx.globalAlpha *= a;
  const dy = (1 - a) * 24;
  logo(ctx, 60, 56, 40);
  text(ctx, t('Kalender PnL').toUpperCase(), S / 2, 300 + dy, { size: 26, weight: 600, color: C.muted, align: 'center' });
  text(ctx, m.name, S / 2, 360 + dy, { size: 44, weight: 600, align: 'center' });
  const big = hide ? (m.pctV == null ? '••••' : pct(m.pctV, 2)) : signed(m.total);
  // Count up during the first second of the scene.
  const k = ease(span(sec, TL.summary, TL.summary + 1.2));
  const shown = hide ? big : signed(m.total * k);
  ctx.save(); ctx.shadowColor = toneOf(m.total); ctx.shadowBlur = 40;
  text(ctx, shown, S / 2, 520 + dy, { size: 128, weight: 800, color: toneOf(m.total), align: 'center' });
  ctx.restore();
  if (!hide && m.pctV != null) pill(ctx, pct(m.pctV, 2), S / 2, 590 + dy, { size: 30, color: toneOf(m.total), fill: rgba(toneOf(m.total), 0.15), align: 'center' });
  const stats = [
    [t('Hari hijau'), `${m.green}/${m.green + m.red}`, m.green >= m.red ? C.up : C.down],
    [t('Hari terbaik'), m.best ? (hide ? new Date(`${m.best.key}T12:00:00Z`).toLocaleDateString(locale === 'en' ? 'en-US' : 'id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : cellUsd(m.best.v, locale)) : '—', m.best ? toneOf(m.best.v) : C.text],
    [t('Posisi ditutup'), String(m.closed), C.text],
  ];
  stats.forEach(([l, v, c], i) => {
    const x = 110 + i * 310, y = 730 + dy, s = ease(span(sec, TL.summary + 0.5 + i * 0.15, TL.summary + 1.0 + i * 0.15));
    ctx.save(); ctx.globalAlpha *= s;
    ctx.fillStyle = c; ctx.globalAlpha *= 0.8; ctx.fillRect(x, y - 30, 4, 84); ctx.globalAlpha /= 0.8;
    text(ctx, l.toUpperCase(), x + 22, y, { size: 20, weight: 600, color: C.muted });
    text(ctx, v, x + 22, y + 48, { size: 40, weight: 700, color: c });
    ctx.restore();
  });
  text(ctx, t('PnL terealisasi dari posisi yang ditutup tiap hari'), S / 2, 960, { size: 22, color: C.faint, align: 'center' });
  ctx.restore();
}

function outroScene(ctx, m, sec, t) {
  const a = ease(span(sec, TL.outro, TL.outro + 0.7));
  ctx.save(); ctx.globalAlpha = a;
  const h = 96, w = (264 / 48) * h;
  logo(ctx, (S - w) / 2, 400 - (1 - a) * 20, h);
  text(ctx, t('Bot copy LP otomatis'), S / 2, 600, { size: 34, color: C.muted, align: 'center' });
  text(ctx, m.chain, S / 2, 660, { size: 26, color: C.faint, align: 'center' });
  ctx.restore();
}

export function drawMonth(ctx, m, sec, t, hide, locale) {
  ctx.save();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, S, S);
  // A soft glow in the colour of the running total, behind the grid.
  const run = runningAt(m, sec), g = ctx.createRadialGradient(S / 2, 640, 0, S / 2, 640, 620);
  g.addColorStop(0, rgba(toneOf(run), 0.12)); g.addColorStop(1, rgba(toneOf(run), 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const out1 = 1 - ease(span(sec, TL.summary - 0.4, TL.summary));
  if (out1 > 0) { ctx.save(); ctx.globalAlpha = out1; header(ctx, m, sec, t, hide); gridScene(ctx, m, sec, t, hide, locale); ctx.restore(); }
  const out2 = 1 - ease(span(sec, TL.outro - 0.4, TL.outro));
  if (sec >= TL.summary && out2 > 0) { ctx.save(); ctx.globalAlpha = out2; summaryScene(ctx, m, sec, t, hide, locale); ctx.restore(); }
  if (sec >= TL.outro) outroScene(ctx, m, sec, t);
  ctx.restore();
}

// ---- sound -------------------------------------------------------------------------

const SR = 44100;
const note = (semi) => 220 * 2 ** (semi / 12);
// A quiet pad under the clip, a pluck per day with PnL (profit climbs a pentatonic scale,
// louder for a bigger day; a loss is a soft low note), a chime on the best day, a rising or
// falling arpeggio on the summary, and the outro chord.
async function monthSound(m) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new Offline(2, Math.ceil(SR * TL.end), SR);
  const master = oc.createGain(); master.gain.value = 0.8; master.connect(oc.destination);
  const tone = (at, freq, { dur = 0.5, gain = 0.1, type = 'sine', attack = 0.01, to = null } = {}) => {
    const o = oc.createOscillator(), g = oc.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur);
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(gain, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master); o.start(at); o.stop(at + dur + 0.05);
  };
  const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const pad = oc.createGain();
  pad.gain.setValueAtTime(0.0001, 0); pad.gain.linearRampToValueAtTime(0.05, 2); pad.gain.setValueAtTime(0.05, TL.outro); pad.gain.linearRampToValueAtTime(0.0001, TL.end);
  lp.connect(pad); pad.connect(master);
  [-12, -5, 0, 3, 7].forEach((semi, i) => [-3, 3].forEach((det) => {
    const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = note(semi); o.detune.value = det + i;
    o.connect(lp); o.start(0); o.stop(TL.end);
  }));
  const scale = [12, 14, 16, 19, 21, 24, 26, 28];
  let step = 0;
  for (const x of m.active) {
    const k = Math.sqrt(Math.min(1, Math.abs(x.v) / m.maxAbs));
    if (x.v > 0.005) {
      const f = note(scale[step++ % scale.length] + 12);
      tone(x.at, f, { dur: 0.3, gain: 0.04 + 0.05 * k, attack: 0.003 });
      tone(x.at, f * 2.76, { dur: 0.12, gain: 0.015 + 0.02 * k, attack: 0.002 });
    } else if (x.v < -0.005) tone(x.at, note(-5), { dur: 0.35, gain: 0.05 + 0.04 * k, type: 'triangle', to: note(-9) });
  }
  if (m.best) { tone(TL.best, note(24), { dur: 1.2, gain: 0.07 }); tone(TL.best + 0.1, note(31), { dur: 1.2, gain: 0.05 }); }
  const win = m.total >= 0;
  (win ? [0, 4, 7, 12, 16] : [7, 3, -2]).forEach((semi, i) => tone(TL.summary + 0.35 + i * 0.14, note(semi + 12), { dur: win ? 1.1 : 1.3, gain: 0.08, attack: 0.02 }));
  tone(TL.outro, note(0), { dur: 2.2, gain: 0.1, attack: 0.08 });
  tone(TL.outro, note(7), { dur: 2.2, gain: 0.06, attack: 0.08 });
  return oc.startRendering();
}

// The month video tab.
export default function MonthReplay({ month, hide }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* server default */ }
    get(`/api/share/month?month=${encodeURIComponent(month)}&tz=${encodeURIComponent(tz)}`)
      .then((r) => { if (!alive) return; if (r?.error) setError(r.error); else setData(r); })
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [month]);
  const m = useMemo(() => (data ? buildMonth(data, locale) : null), [data, locale]);
  const draw = useCallback((ctx, sec) => drawMonth(ctx, m, sec, t, hide, locale), [m, t, hide, locale]);
  const sound = useCallback(() => monthSound(m), [m]);
  return (
    <ReplayPlayer draw={draw} end={TL.end} sound={sound} ready={!!m} error={error} loading="Menyiapkan replay…"
      fileName={`quiver-pnl-${month}-replay`} resetKey={`${month}:${hide}:${locale}`} />
  );
}
