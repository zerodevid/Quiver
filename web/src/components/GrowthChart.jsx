// Portfolio growth. Three views, one axis — not two lines with different scales
// on one chart:
//  - Net PnL: wallet value − capital (baseline + deposits − withdrawals). Includes all
//    costs outside positions (zap, gas, ETH↔USDG swap) — "capital 400 became 520 = profit 120".
//  - Cumulative PnL: sum of position PnL (out − cost). Does not jump when funds
//    are deposited or withdrawn.
//  - Value: cash + positions + fees. Only points whose cash balance was readable; old points
//    (before cash was recorded) contain only position value and would mislead.
//
// The PnL view is coloured by sign against the zero line (green above, red
// below) and filled down to the zero line, not to the chart base: what is read is
// "profit or loss, how much". The peak and the deepest drawdown are marked at the same
// point as the figure in the chart header (the server keeps that point present).
import { useId, useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ReferenceDot, ReferenceArea,
} from 'recharts';
import { Empty } from './ui';
import { usd, tone, pct, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const HOUR = 3600e3, DAY = 864e5;

// "Round" multiples (1-2-2.5-5 × 10ⁿ) so Y-axis labels are easy to read.
function niceStep(span, target) {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// The domain follows the data (+ a little padding), ticks at round multiples inside it —
// the line does not get flattened in the middle just because the next tick happens to be far.
function yScale(lo, hi, { zero, floor0 }) {
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += Math.max(1, Math.abs(hi) * 0.05); lo -= Math.max(1, Math.abs(lo) * 0.05); }
  const pad = (hi - lo) * 0.1;
  const dLo = floor0 && lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
  const dHi = hi + pad;
  const step = niceStep(dHi - dLo, 5);
  const ticks = [];
  for (let v = Math.ceil(dLo / step) * step; v <= dHi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { domain: [dLo, dHi], ticks, step };
}

// Time ticks at local hour/day boundaries: "11 Sep · 12.00 · 12 Sep · 12.00 …" — not
// random points whose label repeats ("12 Sep, 12 Sep").
function timeTicks(t0, t1, target = 8) {
  const span = Math.max(1, t1 - t0);
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const step = steps.find((s) => span / s <= target) || 30 * DAY;
  const d = new Date(t0);
  const out = [];
  if (step < DAY) {
    const h = step / HOUR;
    d.setMinutes(0, 0, 0);
    if (d.getTime() < t0) d.setHours(d.getHours() + 1);
    while (d.getHours() % h) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= t1; d.setHours(d.getHours() + h)) out.push(d.getTime());
  } else {
    const n = step / DAY;
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setDate(d.getDate() + 1);
    for (; d.getTime() <= t1; d.setDate(d.getDate() + n)) out.push(d.getTime());
  }
  return { ticks: out, step };
}

const dayFmt = (v) => new Date(v).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' });
const timeFmt = (v) => new Date(v).toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' });

function Tip({ active, payload, view, t }) {
  const d = active && payload?.[0]?.payload;
  if (!d) return null;
  const isPnl = view !== 'value';
  return (
    <div className="min-w-44 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg shadow-black/10">
      <div className="text-muted">
        {new Date(d.t).toLocaleString(fmtLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        {d.live && <span className="ml-1.5 text-foreground">· {t('sekarang')}</span>}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <span className="text-muted">{t(view === 'net' ? 'PnL bersih' : view === 'pnl' ? 'PnL kumulatif' : 'Nilai')}</span>
        <span className={`num text-sm font-semibold ${isPnl ? tone(d.v) : 'text-foreground'}`}>{isPnl && d.v > 0.005 ? '+' : ''}{usd(d.v)}</span>
      </div>
      {isPnl && d.fromPeak > 0.005 && (
        <div className="mt-0.5 flex items-baseline justify-between gap-4">
          <span className="text-muted">{t('dari puncak')}</span>
          <span className="num text-danger">−{usd(d.fromPeak)}</span>
        </div>
      )}
      {!isPnl && <>
        <div className="mt-0.5 flex items-baseline justify-between gap-4"><span className="text-muted">{t('Kas')}</span><span className="num">{usd(d.cash)}</span></div>
        <div className="mt-0.5 flex items-baseline justify-between gap-4"><span className="text-muted">{t('Posisi + fee')}</span><span className="num">{usd(d.pos)}</span></div>
      </>}
    </div>
  );
}

// The "now" point: framed in the card colour, with a gentle pulse (off for
// prefers-reduced-motion).
function LiveDot({ cx, cy, fill }) {
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={9} fill={fill} opacity={0.22} className="motion-safe:animate-ping" style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
      <circle cx={cx} cy={cy} r={4.5} fill={fill} stroke="var(--surface)" strokeWidth={2} />
    </g>
  );
}

export default function GrowthChart({ p, view, dim = false }) {
  const { t } = useI18n();
  const gid = useId().replace(/:/g, '');
  const isPnl = view === 'pnl' || view === 'net';

  const pts = useMemo(() => {
    const raw = view === 'net'
      ? p.series.filter((e) => e.net != null).map((e) => ({ t: e.ts, v: e.net, live: !!e.live }))
      : view === 'pnl'
        ? p.series.filter((e) => e.pnl != null).map((e) => ({ t: e.ts, v: e.pnl, live: !!e.live }))
        : p.series.filter((e) => e.cash != null).map((e) => ({ t: e.ts, v: e.total, cash: e.cash, pos: (e.pos || 0) + (e.fee || 0), live: !!e.live }));
    let peak = -Infinity;
    for (const x of raw) { peak = Math.max(peak, x.v); x.fromPeak = peak - x.v; }
    return raw;
  }, [p.series, view]);

  if (pts.length < 2) {
    return view === 'value'
      ? <Empty title="Nilai portofolio belum tercatat" sub="Kas + posisi dicatat tiap 5 menit sejak pembaruan ini (butuh wallet yang terbaca). Sementara itu lihat tampilan PnL kumulatif." />
      : <Empty title="Belum ada riwayat" sub="Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit." />;
  }

  const first = pts[0].v, lastPt = pts[pts.length - 1], last = lastPt.v;
  // The "All" range is computed from zero: cumulative PnL does start from zero.
  // PnL is computed from the reference point before the window; if the history starts inside
  // the window (no reference), from zero — not from the first point that already holds a profit.
  const delta = view === 'net'
    ? last - (p.range === 'all' ? 0 : (p.baseline?.net ?? 0))
    : view === 'pnl'
      ? last - (p.range === 'all' ? 0 : (p.baseline?.pnl ?? 0))
      : last - first;
  // Percent against real capital (baseline + deposits − withdrawals) if tracked.
  // "Value − PnL" is only a fallback: that figure is circular — the bigger the PnL, the
  // smaller the divisor (PnL $154.62 reads 40.97% although capital $399.62 → 38.69%).
  const cap = p.now.capitalNet ?? p.now.capital;
  const vals = pts.map((x) => x.v);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  // High/drawdown from the server, computed over all points before thinning.
  const ex = p.extremes?.[view] || {};
  const hi = ex.hi ?? vMax, lo = ex.lo ?? vMin;
  const dd = ex.dd ?? Math.max(...pts.map((x) => x.fromPeak));

  const t0 = pts[0].t, t1 = lastPt.t;
  const X = timeTicks(t0, t1, typeof window !== 'undefined' && window.innerWidth < 640 ? 4 : 8);
  const tickFmt = (v) => {
    if (X.step >= DAY) return dayFmt(v);
    const d = new Date(v);
    return d.getHours() === 0 && d.getMinutes() === 0 ? dayFmt(v) : timeFmt(v);
  };
  const Y = yScale(Math.min(lo, vMin), Math.max(hi, vMax), { zero: isPnl, floor0: !isPnl });
  const yDec = Y.step < 1 ? 2 : 0;
  const lbl = { '24h': 'dalam 24 jam', '7d': 'dalam 7 hari', '30d': 'dalam 30 hari', all: 'sejak awal' }[p.range];

  // Colour by sign. The gradient is computed against each shape's bounding box:
  // the line (vMin…vMax) and the area filled down to zero (min(vMin,0)…max(vMax,0)).
  const C = { up: 'var(--success)', down: 'var(--danger)', flat: 'var(--accent)' };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lineOff = vMax === vMin ? (vMax >= 0 ? 1 : 0) : clamp01(vMax / (vMax - vMin));
  const aTop = Math.max(vMax, 0), aBot = Math.min(vMin, 0);
  const areaOff = aTop === aBot ? 1 : clamp01(aTop / (aTop - aBot));
  const flatLine = vMax === vMin;   // bbox with 0 height: an objectBoundingBox gradient is not drawn
  const lineColor = isPnl ? (flatLine ? (vMax < 0 ? C.down : C.up) : `url(#${gid}-line)`) : C.flat;
  const pointColor = (v) => (isPnl ? (v < 0 ? C.down : C.up) : C.flat);

  // Markers: the peak (if not the last point) and the deepest drawdown band.
  const hasPt = (ts) => ts != null && pts.some((x) => x.t === ts);
  const showPeak = hasPt(ex.hiTs) && ex.hiTs !== t1 && hi - Math.min(first, last) > Y.step * 0.25;
  const showDd = isPnl && dd > 0.005 && hasPt(ex.ddPeakTs) && hasPt(ex.ddTroughTs) && dd > (Y.domain[1] - Y.domain[0]) * 0.08;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className={`text-2xl leading-tight font-semibold tracking-tight ${tone(delta)}`}>
            {delta > 0 ? '+' : ''}{usd(delta)}
            {isPnl && cap > 0 && <span className="ml-2 text-sm font-medium">{pct((delta / cap) * 100, 2)}</span>}
          </div>
          <div className="text-xs text-muted">
            {t(lbl)}{view === 'value' && <span> · {t('termasuk setoran & penarikan')}</span>}
          </div>
        </div>
        <div className="flex gap-5 text-xs">
          <span><span className="text-muted">{t('Tertinggi')}</span> <span className="num font-medium">{usd(hi)}</span></span>
          {isPnl
            ? <span title={t('Penurunan terdalam dari puncak sebelumnya dalam rentang ini')}><span className="text-muted">{t('Drawdown maks')}</span> <span className={`num font-medium ${dd > 0.005 ? 'text-danger' : ''}`}>{dd > 0.005 ? '−' : ''}{usd(dd)}</span></span>
            : <span><span className="text-muted">{t('Terendah')}</span> <span className="num font-medium">{usd(lo)}</span></span>}
        </div>
      </div>
      <div className={`h-64 transition-opacity duration-200 ${dim ? 'opacity-50' : ''}`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pts} margin={{ top: 14, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`${gid}-line`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={lineOff} stopColor={C.up} />
                <stop offset={lineOff} stopColor={C.down} />
              </linearGradient>
              {isPnl ? (
                <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset={0} stopColor={C.up} stopOpacity={0.2} />
                  <stop offset={areaOff} stopColor={C.up} stopOpacity={0.02} />
                  <stop offset={areaOff} stopColor={C.down} stopOpacity={0.02} />
                  <stop offset={1} stopColor={C.down} stopOpacity={0.2} />
                </linearGradient>
              ) : (
                <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.flat} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={C.flat} stopOpacity={0} />
                </linearGradient>
              )}
            </defs>
            {/* guide line: a solid hairline, not dashed — so it is not read as a threshold */}
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.6} vertical={false} syncWithTicks />
            <XAxis dataKey="t" type="number" scale="time" domain={[t0, t1]} ticks={X.ticks} tickFormatter={tickFmt}
              tickLine={false} axisLine={false} minTickGap={16} tickMargin={8} padding={{ left: 4, right: 4 }}
              tick={{ fill: 'var(--muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }} />
            <YAxis width={58} tickLine={false} axisLine={false} domain={Y.domain} ticks={Y.ticks} allowDataOverflow
              tick={{ fill: 'var(--muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }} tickMargin={6}
              tickFormatter={(v) => usd(v, yDec)} />
            {showDd && (
              <ReferenceArea x1={ex.ddPeakTs} x2={ex.ddTroughTs} fill="var(--danger)" fillOpacity={0.07} stroke="none" ifOverflow="hidden"
                label={{ value: t('drawdown −{v}', { v: usd(dd) }), position: 'insideBottom', fill: 'var(--muted)', fontSize: 10, offset: 6 }} />
            )}
            {isPnl && <ReferenceLine y={0} stroke="var(--muted)" strokeOpacity={0.55} />}
            <Tooltip content={<Tip view={view} t={t} />} cursor={{ stroke: 'var(--muted)', strokeOpacity: 0.6, strokeWidth: 1 }}
              isAnimationActive={false} wrapperStyle={{ outline: 'none' }} />
            <Area type="monotone" dataKey="v" baseValue={isPnl ? 0 : 'dataMin'} stroke={lineColor} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" fill={`url(#${gid}-fill)`} dot={false} isAnimationActive={false}
              activeDot={(pr) => <circle key="active" cx={pr.cx} cy={pr.cy} r={4.5} fill={pointColor(pr.payload.v)} stroke="var(--surface)" strokeWidth={2} />} />
            {showPeak && (
              <ReferenceDot x={ex.hiTs} y={hi} r={3.5} fill="var(--surface)" stroke="var(--foreground)" strokeWidth={1.5} ifOverflow="extendDomain"
                label={{ value: t('Tertinggi {v}', { v: usd(hi) }), position: 'top', fill: 'var(--muted)', fontSize: 10, offset: 7 }} />
            )}
            <ReferenceDot x={t1} y={last} ifOverflow="extendDomain" shape={(pr) => <LiveDot {...pr} fill={pointColor(last)} />} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
