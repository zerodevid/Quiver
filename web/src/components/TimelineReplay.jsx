// PnL timeline replay — the "Video" tab of the whole-portfolio card. A ~19 second 16:9 clip
// of the timeline share card coming to life: the stepped cumulative-PnL line draws from left
// to right one close at a time, each coin logo pops onto its step, the big wins and losses
// pop their callouts as the line reaches them, the window total and the footer figures run
// up alongside, the final total lands, then the logo outro.
//
// Drawn in the browser and recorded by ReplayPlayer (ShareReplay.jsx), like the position and
// month replays; the server only hands over the figures (GET /api/share/timeline — the same
// data as the timeline share card). Every frame is a pure function of the clip time.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../api';
import { useI18n } from '../i18n';
import { pct } from '../fmt';
import { ReplayPlayer, C, clamp, lerp, ease, span, text, logo, paint, money, font, tokenDisc, iconSrc, videoTheme } from './ShareReplay';

const W = 1920, H = 1080, PAD = 90;
// Timeline (seconds of clip time).
const TL = {
  draw: 0.8,          // the line starts…
  drawEnd: 11.5,      // …and reaches the last close here
  final: 11.6,        // the final total lands
  outro: 16.2,        // logo outro
  end: 18.6,
};
const POP = 0.35;     // seconds a marker or callout takes to pop in
const CHART = { y0: 232, y1: 862, rowH: 54, up: 3, down: 2 };
const PILL = { h: 44, r: 16, size: 26 };
const STATS_Y = 892;

const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const toneOf = (v) => (v > 0.005 ? C.up : v < -0.005 ? C.down : C.text);
const signed = (v) => (v > 0.005 ? '+' : '') + money(v);
// Back-out easing for the pops: overshoots a little, then settles at 1.
const back = (u) => { const x = clamp(u) - 1; return 1 + 2.2 * x ** 3 + 1.2 * x ** 2; };
// Compact unsigned amount for the footer ("$36k"), the same as the share card.
function short(v, locale) {
  const a = Math.abs(v), fx = money(a, 2, true);
  if (!fx.startsWith('$')) return fx;
  const f = (x, d) => x.toLocaleString(locale === 'en' ? 'en-US' : 'id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e6) return `$${f(a / 1e6, 1)}M`;
  if (a >= 1e3) return `$${f(a / 1e3, a >= 1e4 ? 0 : 1)}k`;
  return `$${f(a, a >= 10 ? 0 : 1)}`;
}
function hold(h, t) {
  if (h == null) return '—';
  if (h < 1) return t('{n}m', { n: Math.round(h * 60) });
  if (h < 24) return t('{n}j', { n: h.toFixed(1) });
  return t('{n}h', { n: (h / 24).toFixed(1) });
}
const PERIOD = { '24h': 'PnL 24 jam terakhir', '7d': 'PnL 7 hari terakhir', '30d': 'PnL 30 hari terakhir' };

// Placement, computed once per clip: the same rules as the timeline share card
// (src/share-card.js timelineLayout) at video scale.
export function buildTimeline(data, hide) {
  const measure = (() => { const c = document.createElement('canvas').getContext('2d'); return (s, size, w = 700) => { c.font = font(size, w); return c.measureText(s).width; }; })();
  const x0 = PAD + 10, x1 = W - PAD - 10;
  const top = CHART.y0 + CHART.up * CHART.rowH + 20, bottom = CHART.y1 - CHART.down * CHART.rowH - 20;
  const n = data.points.length;
  let run = 0;
  const cum = data.points.map((p) => (run += p.v));
  const lo = Math.min(0, ...cum), hi = Math.max(0, ...cum), spanV = hi - lo || 1;
  const yOf = (v) => bottom - ((v - lo) / spanV) * (bottom - top);
  const steps = data.points.map((p, i) => ({ ...p, i, x: x0 + ((i + 1) / n) * (x1 - x0), y: yOf(cum[i]), cum: cum[i],
    // When the line reaches this close.
    at: lerp(TL.draw, TL.drawEnd, (i + 1) / n) }));
  const label = (p) => (hide ? (p.pct == null ? '••••' : pct(p.pct, 1)) : signed(p.v));
  const pillW = (s) => measure(s, PILL.size) + PILL.r * 2 + 40;
  const finalS = hide ? (data.stats.pct == null ? '••••' : pct(data.stats.pct, 1)) : signed(data.total);
  const finalW = measure(finalS, PILL.size * 1.15, 800) + 44;
  const final = { s: finalS, w: finalW, left: x1 + 10 - finalW, cy: CHART.y0 + (PILL.h * 1.15) / 2 };
  const place = (list, rows, up, reserved = null) => {
    const taken = Array.from({ length: rows }, (_, i) => (i === 0 && reserved ? [reserved] : [])), out = [];
    for (const p of list) {
      const s = label(p), w = pillW(s);
      const left = Math.min(Math.max(p.x - w / 2, x0 - 10), x1 + 10 - w);
      const row = taken.findIndex((r) => r.every(([a, b]) => left + w + 12 < a || left > b + 12));
      if (row < 0) continue;
      taken[row].push([left, left + w]);
      out.push({ p, s, w, left, up, cy: up ? CHART.y0 + row * CHART.rowH + PILL.h / 2 : CHART.y1 - row * CHART.rowH - PILL.h / 2 });
    }
    return out;
  };
  const ups = place(steps.filter((p) => p.v > 0.01).sort((a, b) => b.v - a.v).slice(0, 16), CHART.up, true, [final.left, final.left + final.w]);
  const downs = place(steps.filter((p) => p.v < -0.01).sort((a, b) => a.v - b.v).slice(0, 12), CHART.down, false);
  const last = steps[n - 1], r = 16, markers = [];
  for (const p of [last, ...ups.map((c) => c.p), ...downs.map((c) => c.p), ...[...steps].sort((a, b) => Math.abs(b.v) - Math.abs(a.v))]) {
    if (markers.length >= 70 || markers.includes(p)) continue;
    if (markers.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r * 2 + 4)) continue;
    markers.push(p);
  }
  // Running footer figures after each close.
  let vol = 0, fee = 0, wins = 0, losses = 0, best = -Infinity, hs = 0, hn = 0;
  const running = steps.map((p) => {
    vol += p.cost || 0; fee += p.fee || 0; best = Math.max(best, p.v);
    if (p.v > 0.01) wins++; else if (p.v < -0.01) losses++;
    if (p.holdHours != null) { hs += p.holdHours; hn++; }
    return { vol, fee, best, count: p.i + 1, wr: wins + losses ? (wins / (wins + losses)) * 100 : null, hold: hn ? hs / hn : null };
  });
  return { ...data, x0, x1, top, bottom, zeroY: yOf(0), steps, ups, downs, final, markers, running, last, total: data.total };
}

// Index of the last close the line has reached at `sec` (−1 before the first), and the
// fraction of the way to the next one.
function head(m, sec) {
  const n = m.steps.length, f = clamp(span(sec, TL.draw, TL.drawEnd)) * n;
  return { i: Math.min(n - 1, Math.floor(f) - 1), frac: f - Math.floor(f) };
}

function backdropWide(ctx, m, sec, theme) {
  const hell = videoTheme(theme) === 'hell';
  const bg = ctx.createLinearGradient(0, 0, W, H);
  if (hell) { bg.addColorStop(0, '#2A0707'); bg.addColorStop(0.5, '#120303'); bg.addColorStop(1, '#060101'); }
  else { bg.addColorStop(0, '#191726'); bg.addColorStop(1, '#0A0B0D'); }
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // Dot grid and a glow in the PnL colour behind the right side of the chart.
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let x = 24; x < W; x += 44) for (let y = 24; y < H; y += 44) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  const tint = toneOf(m.total), g = ctx.createRadialGradient(W * 0.78, CHART.y0, 0, W * 0.78, CHART.y0, W * 0.6);
  g.addColorStop(0, rgba(tint, 0.14 * ease(span(sec, 0, 1.5)))); g.addColorStop(1, rgba(tint, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function header(ctx, m, sec, t, hide, locale) {
  const a = ease(span(sec, 0, 0.7));
  ctx.save(); ctx.globalAlpha *= a;
  logo(ctx, PAD, 62, 46);
  const day = (ts) => new Date(ts).toLocaleDateString(locale === 'en' ? 'en-US' : 'id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  text(ctx, `${m.chain} · ${day(m.from)} – ${day(m.to)}`, PAD, 170, { size: 26, color: C.faint });
  const label = t(PERIOD[m.range] || 'PnL sepanjang waktu').toUpperCase();
  ctx.save(); ctx.letterSpacing = '5px'; text(ctx, label, W - PAD, 92, { size: 24, weight: 600, color: C.muted, align: 'right' }); ctx.restore();
  // The total runs up as the line draws.
  const { i, frac } = head(m, sec);
  const next = m.steps[i + 1];
  const run = (i < 0 ? 0 : m.steps[i].cum) + (next && sec >= TL.draw ? next.v * ease(frac) : 0);
  const done = sec >= TL.final;
  const val = done ? m.total : run;
  // Hidden amounts: growth of the portfolio the window started with, as on the card.
  const base = m.stats.base;
  const big = hide ? (done ? (m.stats.pct == null ? '••••' : pct(m.stats.pct, 2)) : base > 0 ? pct((run / base) * 100, 2) : '••••') : signed(val);
  ctx.save(); ctx.shadowColor = toneOf(val); ctx.shadowBlur = 40;
  text(ctx, big, W - PAD, 200, { size: 104, weight: 800, color: toneOf(val), align: 'right' });
  ctx.restore();
  ctx.restore();
}

function chartScene(ctx, m, sec, t, hide, icons) {
  const { i, frac } = head(m, sec);
  const tint = toneOf(m.total);
  // Zero line.
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.setLineDash([8, 10]); ctx.lineWidth = 2;
  ctx.globalAlpha *= ease(span(sec, 0.2, 0.9));
  ctx.beginPath(); ctx.moveTo(m.x0, m.zeroY); ctx.lineTo(m.x1, m.zeroY); ctx.stroke(); ctx.restore();
  // The line up to the head, with the next step drawn part of the way.
  const path = new Path2D();
  path.moveTo(m.x0, m.zeroY);
  let px = m.x0, py = m.zeroY;
  for (let k = 0; k <= i; k++) { const s = m.steps[k]; path.lineTo(s.x, py); path.lineTo(s.x, s.y); px = s.x; py = s.y; }
  const nx = m.steps[i + 1];
  if (nx && sec >= TL.draw) { const hx = lerp(px, nx.x, Math.min(1, frac * 1.6)); path.lineTo(hx, py); if (frac > 0.62) path.lineTo(nx.x, lerp(py, nx.y, ease((frac - 0.62) / 0.38))); px = hx; }
  const area = new Path2D(path); area.lineTo(px, m.zeroY); area.closePath();
  const g = ctx.createLinearGradient(0, m.top, 0, m.zeroY);
  g.addColorStop(0, rgba(tint, 0.3)); g.addColorStop(1, rgba(tint, 0.02));
  ctx.fillStyle = g; ctx.fill(area);
  ctx.save(); ctx.strokeStyle = 'rgba(244,246,245,0.9)'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.stroke(path); ctx.restore();
  // Leader lines, then markers, then callouts on top.
  const callouts = [...m.ups, ...m.downs];
  for (const c of callouts) {
    const u = ease(span(sec, c.p.at, c.p.at + POP));
    if (u <= 0) continue;
    const ya = c.up ? c.cy + PILL.h / 2 : c.cy - PILL.h / 2;
    ctx.save(); ctx.globalAlpha *= u * 0.35; ctx.strokeStyle = C.text; ctx.setLineDash([5, 7]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(c.p.x, ya); ctx.lineTo(c.p.x, lerp(ya, c.p.y, u)); ctx.stroke(); ctx.restore();
  }
  for (const s of m.markers) {
    const u = span(sec, s.at, s.at + POP);
    if (u <= 0) continue;
    const sc = back(u);
    ctx.save(); ctx.translate(s.x, s.y); ctx.scale(sc, sc);
    tokenDisc(ctx, icons.get(s.address), s.address, s.symbol, 0, 0, 16);
    ctx.strokeStyle = s.v < -0.01 ? C.down : C.text; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  for (const c of callouts) {
    const u = span(sec, c.p.at, c.p.at + POP);
    if (u <= 0) continue;
    const sc = lerp(0.6, 1, back(u)), x = c.left + c.w / 2;
    ctx.save(); ctx.globalAlpha *= ease(u); ctx.translate(x, c.cy); ctx.scale(sc, sc); ctx.translate(-x, -c.cy);
    const top = c.cy - PILL.h / 2;
    ctx.fillStyle = c.up ? '#F4F6F5' : '#14161B'; ctx.beginPath(); ctx.roundRect(c.left, top, c.w, PILL.h, 12); ctx.fill();
    if (!c.up) { ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.stroke(); }
    tokenDisc(ctx, icons.get(c.p.address), c.p.address, c.p.symbol, c.left + 12 + PILL.r, c.cy, PILL.r);
    text(ctx, c.s, c.left + 26 + PILL.r * 2, c.cy + 1, { size: PILL.size, weight: 700, color: c.up ? '#0A0B0D' : C.text, base: 'middle' });
    ctx.restore();
  }
  // Final total: the dashed drop line, a pulsing ring on the last step and the big pill.
  const fu = span(sec, TL.final, TL.final + 0.5);
  if (fu > 0) {
    const f = m.final, l = m.last, fh = PILL.h * 1.15, pulse = 0.5 + 0.5 * Math.sin((sec - TL.final) * 5);
    ctx.save(); ctx.globalAlpha *= ease(fu);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(l.x, f.cy + fh / 2); ctx.lineTo(l.x, CHART.y1); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = tint; ctx.lineWidth = 3 + pulse * 2; ctx.shadowColor = tint; ctx.shadowBlur = 20 + pulse * 16;
    ctx.beginPath(); ctx.arc(l.x, l.y, 24 + pulse * 3, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
    const sc = lerp(0.5, 1, back(fu)), cx = f.left + f.w / 2;
    ctx.translate(cx, f.cy); ctx.scale(sc, sc); ctx.translate(-cx, -f.cy);
    ctx.fillStyle = tint; ctx.shadowColor = tint; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.roundRect(f.left, f.cy - fh / 2, f.w, fh, 14); ctx.fill(); ctx.shadowBlur = 0;
    text(ctx, f.s, cx, f.cy + 1, { size: PILL.size * 1.15, weight: 800, color: '#0A0B0D', align: 'center', base: 'middle' });
    ctx.restore();
  }
}

function footer(ctx, m, sec, t, hide, locale) {
  const a = ease(span(sec, 0.3, 1.0));
  const { i } = head(m, sec);
  const r = i < 0 ? { vol: 0, fee: 0, best: null, count: 0, wr: null, hold: null } : m.running[i];
  const tiles = [
    [t('Volume'), hide ? '••••' : short(r.vol, locale), C.text],
    [t('Win rate'), r.wr == null ? '—' : `${Math.round(r.wr)}%`, r.wr == null ? C.text : r.wr >= 50 ? C.up : C.down],
    [t('Fee'), hide ? '••••' : short(r.fee, locale), C.up],
    [t('Untung terbaik'), r.best == null ? '—' : hide ? '••••' : signed(r.best), r.best == null ? C.text : toneOf(r.best)],
    [t('Posisi'), String(r.count), C.text],
    [t('Rata-rata tahan'), hold(r.hold, t), C.text],
  ];
  ctx.save(); ctx.globalAlpha *= a;
  ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(PAD, STATS_Y, W - PAD * 2, 2);
  const cw = (W - PAD * 2) / 6;
  tiles.forEach(([l, v, c], k) => {
    const lastCol = k === 5, x = lastCol ? W - PAD : PAD + k * cw, align = lastCol ? 'right' : 'left';
    ctx.save(); ctx.letterSpacing = '4px'; text(ctx, l.toUpperCase(), x, STATS_Y + 56, { size: 20, weight: 600, color: C.faint, align }); ctx.restore();
    text(ctx, v, x, STATS_Y + 112, { size: 44, weight: 700, color: c, align });
  });
  ctx.restore();
}

function outroWide(ctx, sec, t, line) {
  const a = ease(span(sec, TL.outro, TL.outro + 0.7));
  ctx.save(); ctx.globalAlpha = a;
  const h = 110, w = (264 / 48) * h;
  logo(ctx, (W - w) / 2, 380 - (1 - a) * 20, h);
  text(ctx, t('Bot copy LP otomatis'), W / 2, 600, { size: 40, color: C.muted, align: 'center' });
  text(ctx, line, W / 2, 664, { size: 30, color: C.faint, align: 'center' });
  ctx.restore();
}

export function drawTimeline(ctx, m, sec, t, hide, locale, theme, fx, icons) {
  paint(theme, fx);
  ctx.save();
  backdropWide(ctx, m, sec, theme);
  const out = 1 - ease(span(sec, TL.outro - 0.4, TL.outro));
  if (out > 0) {
    ctx.save(); ctx.globalAlpha = out;
    header(ctx, m, sec, t, hide, locale); chartScene(ctx, m, sec, t, hide, icons); footer(ctx, m, sec, t, hide, locale);
    ctx.restore();
  }
  if (sec >= TL.outro) outroWide(ctx, sec, t, m.chain);
  ctx.restore();
}

// ---- sound -------------------------------------------------------------------------

const SR = 44100;
const note = (semi) => 220 * 2 ** (semi / 12);
// A quiet pad, a pluck per logo marker as the line reaches it (a win climbs a pentatonic
// scale, a loss is a soft low note), a brighter chime per callout, the final chord when the
// total lands, and the outro tone.
async function timelineSound(m) {
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
  const called = new Set([...m.ups, ...m.downs].map((c) => c.p));
  let step = 0;
  for (const s of [...m.markers].sort((a, b) => a.at - b.at)) {
    if (s.v > 0.01) {
      const f = note(scale[step++ % scale.length] + 12);
      tone(s.at, f, { dur: 0.25, gain: called.has(s) ? 0.08 : 0.04, attack: 0.003 });
      if (called.has(s)) tone(s.at, f * 2.76, { dur: 0.18, gain: 0.03, attack: 0.002 });
    } else if (s.v < -0.01) tone(s.at, note(-5), { dur: 0.3, gain: called.has(s) ? 0.08 : 0.04, type: 'triangle', to: note(-9) });
  }
  const win = m.total >= 0;
  (win ? [0, 4, 7, 12, 16] : [7, 3, -2]).forEach((semi, i) => tone(TL.final + i * 0.12, note(semi + 12), { dur: win ? 1.2 : 1.4, gain: 0.08, attack: 0.02 }));
  tone(TL.outro, note(0), { dur: 2.2, gain: 0.1, attack: 0.08 });
  tone(TL.outro, note(7), { dur: 2.2, gain: 0.06, attack: 0.08 });
  return oc.startRendering();
}

// The timeline video tab.
export default function TimelineReplay({ range, hide, theme, fx }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const icons = useRef(new Map());
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    get(`/api/share/timeline?range=${encodeURIComponent(range)}`)
      .then((r) => { if (!alive) return; if (r?.error) setError(r.error); else setData(r); })
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [range]);
  const m = useMemo(() => (data ? buildTimeline(data, hide) : null), [data, hide]);
  // Logos of the coins that get a marker or a callout, loaded once.
  useEffect(() => {
    if (!m) return;
    for (const s of [...m.markers, ...m.ups.map((c) => c.p), ...m.downs.map((c) => c.p)]) {
      if (icons.current.has(s.address)) continue;
      const src = iconSrc(s.address);
      if (!src) { icons.current.set(s.address, null); continue; }
      const im = new Image(); im.decoding = 'async'; im.src = src; icons.current.set(s.address, im);
    }
  }, [m]);
  const draw = useCallback((ctx, sec) => drawTimeline(ctx, m, sec, t, hide, locale, theme, fx, icons.current), [m, t, hide, locale, theme, fx]);
  const sound = useCallback(() => timelineSound(m), [m]);
  return (
    <ReplayPlayer draw={draw} end={TL.end} sound={sound} ready={!!m} error={error} loading="Menyiapkan replay…" w={W} h={H}
      fileName={`quiver-pnl-${range}-timeline`} resetKey={`${range}:${hide}:${locale}:${videoTheme(theme)}:${fx?.currency || 'usd'}`} />
  );
}
