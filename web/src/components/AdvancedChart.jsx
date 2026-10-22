// Advanced chart with KLineChart, laid out like a trading terminal: timeframe switcher,
// OHLC legend, grouped drawing toolbar (lines, fibonacci, shapes, notes, measure), magnet /
// lock / hide, price-axis mode (linear / log / percent), an indicator menu, screenshot and
// fullscreen.
//
// Drawings belong to the token, not to this chart (web/src/chartSync.js): whatever is drawn
// here shows up on every other chart of the same token — other timeframes, the Monitor card,
// the position / pool / token pages, other tabs and other devices. The indicator set is one
// preference shared by every chart.
//
// One chart instance lives across timeframe switches: while the new timeframe loads the old
// candles stay under a "loading" veil, then the series is swapped in place (no remount, so the
// drawings, indicators and fullscreen state stay put).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { init, dispose, registerOverlay, registerYAxis } from 'klinecharts';
import {
  TrendingUp, Minus, Ruler, Brush, GitCommitHorizontal, Square, Trash2, Magnet, Lock, LockOpen, Eye, EyeOff,
  Maximize2, Minimize2, Camera, ChevronDown, Type, Tag, MoveUpRight, Slash, ArrowRightToLine, SeparatorVertical,
  Equal, Rows3, RotateCcw, Activity, Crosshair, Loader2, RefreshCw,
} from 'lucide-react';
import { ask } from './ui';
import { useI18n } from '../i18n';
import { price as fmtPrice, locale as fmtLocale } from '../fmt';
import { canonAddr } from '../chain';
import { palette, withAlpha, cssColor } from './CandleChart';
import { subscribeDrawings, writeDrawing, drawingsOf, newDrawingId, chartPrefs, subscribePrefs, setChartPrefs, viewOf, saveView, subscribeView } from '../chartSync';

// LP position range band: point 1 = (entry time, hi), point 2 = (exit time, lo).
// The time axis is clipped to the position's lifetime: starting at the entry candle (or the left edge if
// the entry was before the first candle) and stopping at the exit candle; a position still
// open (extendData.open) extends to the right edge of the pane.
//
// If a pool has several positions, each one becomes its own band: the one
// selected is drawn solid with a full line, the others thin and dashed
// (extendData.dim) so they do not cover each other. extendData.label = the short name of the
// position, written at the band's left edge.
registerOverlay({
  name: 'lpRange', totalStep: 2,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const [c1, c2] = coordinates;
    if (!c1 || !c2) return [];
    const y1 = Math.min(c1.y, c2.y), y2 = Math.max(c1.y, c2.y);
    const { fill, line, open, dim, label } = overlay.extendData || {};
    const x1 = Math.max(0, Math.min(c1.x, c2.x));
    const x2 = open ? bounding.width : Math.min(bounding.width, Math.max(c1.x, c2.x));
    if (x2 <= x1) return [];
    const style = dim ? 'dashed' : 'solid';
    const figures = [
      { type: 'rect', ignoreEvent: true, attrs: { x: x1, y: y1, width: x2 - x1, height: Math.max(1, y2 - y1) }, styles: { style: 'fill', color: fill } },
      { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: x1, y: y1 }, { x: x2, y: y1 }] }, styles: { style, color: line, size: 1 } },
      { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: x1, y: y2 }, { x: x2, y: y2 }] }, styles: { style, color: line, size: 1 } },
    ];
    if (label) {
      figures.push({ type: 'text', ignoreEvent: true, attrs: { x: x1 + 4, y: y1 + 2, text: label, align: 'left', baseline: 'top' },
        styles: tagStyle(line) });
    }
    return figures;
  },
});

// A horizontal reference line (entry / exit / BEP / now) whose label sits on the price axis and as a
// small tag at the left edge. The built-in priceLine writes its price in a solid pill at the line's
// END, which landed on top of the latest candles.
registerOverlay({
  name: 'lpLine', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const c = coordinates[0];
    if (!c) return [];
    const { color, label } = overlay.extendData || {};
    const figures = [{ type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: 0, y: c.y }, { x: bounding.width, y: c.y }] }, styles: { style: 'dashed', color, size: 1 } }];
    if (label) {
      figures.push({ type: 'text', ignoreEvent: true, attrs: { x: 4, y: c.y - 2, text: label, align: 'left', baseline: 'bottom' },
        styles: tagStyle(color) });
    }
    return figures;
  },
});

// Token count behind a DexScreener pair's market cap (marketCap, else FDV, ÷ price), or null when the
// pair is not about `token` or does not say. chart price × usdRate × supply = market cap in USD.
export function supplyOf(pair, token) {
  if (!pair || pair.error || !(pair.priceUsd > 0) || !((pair.marketCap || pair.fdv) > 0)) return null;
  if (token && canonAddr(pair.base?.address || '') !== canonAddr(token)) return null;
  return (pair.marketCap || pair.fdv) / pair.priceUsd;
}

const METRIC_KEY = 'lpcopy-chart-metric';
const readMetric = () => { try { return localStorage.getItem(METRIC_KEY) === 'mc' ? 'mc' : 'price'; } catch { return 'price'; } };

// Small text tag on a pill of the chart background, so a line crossing it does not strike
// through the text (fibonacci levels, range and entry labels sit on top of each other often).
const tagStyle = (color) => ({
  color, size: 10, family: 'ui-sans-serif, system-ui, sans-serif', style: 'fill',
  backgroundColor: withAlpha(PAL.bg, 0.85), borderRadius: 2, paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1,
});

// Theme colours for the custom overlays below. They are drawn by klinecharts outside React, so
// the component keeps this in sync whenever the theme changes.
let PAL = palette();

// Rectangle / zone: two corner points, translucent fill.
registerOverlay({
  name: 'zoneRect', totalStep: 3,
  needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    return [{
      type: 'rect',
      attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) },
      styles: { style: 'stroke_fill', color: withAlpha(PAL.accent, 0.14), borderColor: PAL.accent, borderSize: 1 },
    }];
  },
});

// Price-axis autoscale that ignores a lone wild wick. Memecoin candles often carry one spike
// (a sandwich, a rug, a bad GeckoTerminal tick) that stretches the axis 10x and flattens every
// other candle — which is what zooming into such a stretch looked like. The range is the candle
// bodies plus the 2nd–98th percentile of the wicks of the visible bars; the full range is kept
// when the wicks are ordinary (the robust range already covers most of it).
function robustRange(chart, defaultRange) {
  const list = chart.getDataList();
  const vr = chart.getVisibleRange();
  const from = Math.max(0, vr.from), to = Math.min(list.length, vr.to);
  if (to - from < 8) return null;
  const lows = [], highs = [];
  let bodyLo = Infinity, bodyHi = -Infinity;
  for (let i = from; i < to; i++) {
    const d = list[i];
    lows.push(d.low); highs.push(d.high);
    bodyLo = Math.min(bodyLo, d.open, d.close); bodyHi = Math.max(bodyHi, d.open, d.close);
  }
  lows.sort((a, b) => a - b); highs.sort((a, b) => a - b);
  const q = (s, f) => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * (s.length - 1))))];
  const lo = Math.max(defaultRange.from, Math.min(bodyLo, q(lows, 0.02)));
  const hi = Math.min(defaultRange.to, Math.max(bodyHi, q(highs, 0.98)));
  if (!(hi > lo) || (hi - lo) / (defaultRange.to - defaultRange.from) > 0.7) return null;
  return { from: lo, to: hi };
}

// Axis labels without trailing zeros: 0.0{3}48 rather than 0.0{3}480000 (the precision is set
// for the smallest price on the chart, so round ticks carry a long tail of zeros).
const trimZeros = (value, precision) => {
  const s = Number(value).toFixed(Math.max(0, precision));
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

registerYAxis({
  name: 'priceLin',
  displayValueToText: trimZeros,
  createRange: ({ chart, defaultRange }) => {
    const r = robustRange(chart, defaultRange);
    if (!r) return defaultRange;
    const range = r.to - r.from;
    return { from: r.from, to: r.to, range, realFrom: r.from, realTo: r.to, realRange: range, displayFrom: r.from, displayTo: r.to, displayRange: range };
  },
});

// The built-in log axis treats log10(price) < 0 as a negative price, which garbles every token
// priced below 1 (all of ours). This one maps through log10 for positive prices only.
const log10 = (v) => (v > 0 ? Math.log10(v) : 0);
registerYAxis({
  name: 'logPrice',
  displayValueToText: trimZeros,
  minSpan: (precision) => 0.05 * 10 ** -precision,
  valueToRealValue: log10,
  realValueToValue: (r) => 10 ** r,
  realValueToDisplayValue: (r) => 10 ** r,
  displayValueToRealValue: log10,
  createRange: ({ chart, defaultRange }) => {
    const r = robustRange(chart, defaultRange) || defaultRange;
    const realFrom = log10(r.from), realTo = log10(r.to);
    return { from: r.from, to: r.to, range: r.to - r.from, realFrom, realTo, realRange: realTo - realFrom, displayFrom: r.from, displayTo: r.to, displayRange: r.to - r.from };
  },
});

const fmtSpan = (ms) => {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
};

export const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1H'], ['4h', '4H'], ['1d', '1D']];

const PERIOD = {
  '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 }, '4h': { type: 'hour', span: 4 }, '1d': { type: 'day', span: 1 },
};
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const periodMs = (period) => ({ minute: 60e3, hour: 3600e3, day: 86400e3 }[period?.type] || 60e3) * (period?.span || 1);

// Measure tool: price change, percent change, bar count and elapsed time between two points,
// like the "price range" ruler of a charting terminal.
registerOverlay({
  name: 'measure', totalStep: 3,
  needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, chart }) => {
    const [a, b] = coordinates;
    const [p1, p2] = overlay.points;
    if (!a || !b || p1?.value == null || p2?.value == null) return [];
    const diff = p2.value - p1.value;
    const up = diff >= 0;
    const color = up ? PAL.up : PAL.down;
    const ms = periodMs(chart.getPeriod());
    const bars = Math.round(((p2.timestamp ?? 0) - (p1.timestamp ?? 0)) / ms);
    const sign = up ? '+' : '−';
    const text = `${sign}${fmtPrice(Math.abs(diff))}  (${sign}${Math.abs((diff / p1.value) * 100).toFixed(2)}%)  ·  ${Math.abs(bars)} bar  ·  ${fmtSpan((p2.timestamp ?? 0) - (p1.timestamp ?? 0))}`;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    return [
      { type: 'rect', attrs: { x: x1, y: y1, width: x2 - x1, height: Math.max(1, y2 - y1) }, styles: { style: 'fill', color: withAlpha(color, 0.12) } },
      { type: 'line', attrs: { coordinates: [a, b] }, styles: { style: 'dashed', color, size: 1 } },
      { type: 'text', ignoreEvent: true, attrs: { x: (x1 + x2) / 2, y: up ? y1 - 6 : y2 + 6, text, align: 'center', baseline: up ? 'bottom' : 'top' },
        styles: { style: 'stroke_fill', color: '#ffffff', backgroundColor: color, borderColor: color, size: 11, family: 'ui-sans-serif, system-ui, sans-serif', paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3, borderRadius: 4 } },
    ];
  },
});

// Fibonacci retracement in the style of a charting terminal: every level has its own colour and
// the band between two levels is filled with the colour of the farther one, so the zones read as a
// rainbow. Point 1 = 1, point 2 = 0; the levels span the two points horizontally. Registered under
// the built-in name so drawings saved before keep working and pick up the new look.
const FIB_LEVELS = [
  [0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'],
  [0.786, '#00bcd4'], [1, '#787b86'], [1.618, '#2962ff'],
];
registerOverlay({
  name: 'fibonacciLine', totalStep: 3,
  needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, yAxis }) => {
    const [a, b] = coordinates;
    const [p1, p2] = overlay.points;
    if (!a || !b || p1?.value == null || p2?.value == null) return [];
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const width = Math.max(1, x2 - x1);
    const diff = p1.value - p2.value;
    // through the axis so a log scale puts every level at its real price
    const yOf = (value, pct) => {
      const y = yAxis?.convertToPixel?.(value);
      return Number.isFinite(y) ? y : b.y + (a.y - b.y) * pct;
    };
    // an extension below zero has no price (and a log axis would put it far off the pane)
    const levels = FIB_LEVELS.map(([pct, color]) => {
      const value = p2.value + diff * pct;
      return { pct, color, value, y: yOf(value, pct) };
    }).filter((l) => l.value > 0);
    const figures = [];
    for (let i = 1; i < levels.length; i++) {
      const lo = levels[i - 1], hi = levels[i];
      figures.push({ type: 'rect', ignoreEvent: true, attrs: { x: x1, y: Math.min(lo.y, hi.y), width, height: Math.max(1, Math.abs(hi.y - lo.y)) },
        styles: { style: 'fill', color: withAlpha(hi.color, 0.08) } });
    }
    // labels left of the levels, or just inside them when the drawing starts at the pane's edge
    const outside = x1 > 110;
    for (const l of levels) {
      figures.push({ type: 'line', attrs: { coordinates: [{ x: x1, y: l.y }, { x: x2, y: l.y }] }, styles: { style: 'solid', color: l.color, size: 1 } });
      figures.push({ type: 'text', ignoreEvent: true,
        attrs: { x: outside ? x1 - 4 : Math.max(0, x1) + 4, y: outside ? l.y : l.y - 2, text: `${l.pct} (${fmtPrice(l.value)})`, align: outside ? 'right' : 'left', baseline: outside ? 'middle' : 'bottom' },
        styles: tagStyle(l.color) });
    }
    figures.push({ type: 'line', ignoreEvent: true, attrs: { coordinates: [a, b] }, styles: { style: 'dashed', color: withAlpha('#787b86', 0.8), size: 1, dashedValue: [4, 4] } });
    return figures;
  },
});

// Drawing tools, grouped like a terminal's left toolbar: the group button draws the last tool
// used in it, the caret opens the rest. `note` is special (asks for its text first).
const TOOL_GROUPS = [
  { id: 'lines', tools: [
    ['segment', TrendingUp, 'Garis tren'], ['rayLine', MoveUpRight, 'Sinar'], ['straightLine', Slash, 'Garis lurus'],
    ['horizontalStraightLine', Minus, 'Garis horizontal'], ['horizontalRayLine', ArrowRightToLine, 'Sinar horizontal'],
    ['verticalStraightLine', SeparatorVertical, 'Garis vertikal'], ['parallelStraightLine', Equal, 'Garis paralel'],
    ['priceChannelLine', GitCommitHorizontal, 'Kanal harga'], ['priceLine', Minus, 'Garis harga'],
  ] },
  { id: 'fib', tools: [['fibonacciLine', Rows3, 'Fibonacci retracement']] },
  { id: 'shapes', tools: [['zoneRect', Square, 'Kotak'], ['brush', Brush, 'Gambar bebas']] },
  { id: 'notes', tools: [['note', Type, 'Teks'], ['simpleTag', Tag, 'Label harga']] },
  { id: 'measure', tools: [['measure', Ruler, 'Ukur jarak harga']] },
];

const INDICATOR_GROUPS = [
  ['Di atas harga', true, ['MA', 'EMA', 'SMA', 'BOLL', 'SAR', 'BBI', 'AVP']],
  ['Panel bawah', false, ['VOL', 'MACD', 'RSI', 'KDJ', 'CCI', 'WR', 'OBV', 'ROC', 'MTM', 'DMI', 'AO', 'PSY', 'TRIX', 'BIAS']],
];
const INDICATOR_OVERLAY = new Set(INDICATOR_GROUPS[0][2]);
const KNOWN_INDICATORS = new Set(INDICATOR_GROUPS.flatMap(([, , list]) => list));

const AXES = [['priceLin', 'Lin'], ['logPrice', 'Log'], ['percentage', '%']];

// Time left in the running candle, under the last-price label on the axis.
function countdown(ts, ms) {
  const left = Math.max(0, ts + ms - Date.now());
  const s = Math.floor(left / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h ? `${h >= 24 ? `${Math.floor(h / 24)}d ` : ''}${p2(h % 24)}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
}

function buildStyles(pal) {
  return {
    grid: { horizontal: { color: withAlpha(pal.border, 0.6) }, vertical: { show: false } },
    candle: {
      bar: {
        upColor: pal.up, downColor: pal.down, noChangeColor: pal.muted,
        upBorderColor: pal.up, downBorderColor: pal.down, noChangeBorderColor: pal.muted,
        upWickColor: pal.up, downWickColor: pal.down, noChangeWickColor: pal.muted,
      },
      // OHLC is read from the legend strip above the canvas (it never covers a candle).
      tooltip: { showRule: 'none' },
      priceMark: {
        high: { color: pal.text }, low: { color: pal.text },
        last: {
          text: { family: 'ui-sans-serif, system-ui, sans-serif', size: 11 },
          extendTexts: [{ show: true, position: 'below_price', updateInterval: 1000, size: 10, weight: 'normal', family: 'ui-monospace, SFMono-Regular, monospace', color: '#ffffff', paddingLeft: 4, paddingRight: 4, paddingTop: 0, paddingBottom: 2 }],
        },
      },
    },
    xAxis: { axisLine: { color: pal.border }, tickText: { color: pal.text } },
    yAxis: { axisLine: { color: pal.border }, tickText: { color: pal.text } },
    crosshair: {
      horizontal: { line: { color: withAlpha(pal.muted, 0.7) }, text: { backgroundColor: pal.label } },
      vertical: { line: { color: withAlpha(pal.muted, 0.7) }, text: { backgroundColor: pal.label } },
    },
    overlay: { line: { color: pal.accent }, point: { color: pal.accent, borderColor: pal.accent } },
    separator: { color: pal.border },
  };
}

// Fixed price precision (not a custom per-point format like lightweight-charts):
// tuned from the candle price range so trivial tokens (0.00000032) stay readable.
function precisionFor(data) {
  let min = Infinity;
  for (const d of data) if (d.low > 0) min = Math.min(min, d.low);
  if (!Number.isFinite(min)) return 4;
  if (min >= 1) return min >= 1000 ? 2 : 4;
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(min)) - 1);
  return Math.min(14, leadingZeros + 4);
}

// Candles -> one bar per period: timestamps snapped to the period, duplicates merged, and the
// gaps (no trade in that period — GeckoTerminal simply leaves the candle out) filled with flat
// bars at the previous close. Without the fill the time axis jumps unevenly, zooming into a
// quiet stretch looks broken, and a drawing anchored at a timestamp inside a gap lands on a
// different bar on every timeframe.
const MAX_BARS = 4000;
function normalize(candles, tf) {
  const ms = TF_MS[tf] || 3600e3;
  const byT = new Map();
  for (const c of candles || []) {
    if (!(c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0) || !Number.isFinite(c.t)) continue;
    const t = Math.floor(c.t / ms) * ms;
    const b = byT.get(t);
    if (!b) byT.set(t, { timestamp: t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0, _t: c.t });
    else {
      b.high = Math.max(b.high, c.h); b.low = Math.min(b.low, c.l); b.volume += c.v || 0;
      if (c.t >= b._t) { b.close = c.c; b._t = c.t; }
    }
  }
  const sorted = [...byT.values()].sort((a, b) => a.timestamp - b.timestamp);
  const out = [];
  for (const b of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = Math.round((b.timestamp - prev.timestamp) / ms) - 1;
      // a candle stream with a very long hole: keep only the most recent bars
      if (gap > MAX_BARS) out.length = 0;
      else for (let i = 1; i <= gap; i++) out.push({ timestamp: prev.timestamp + i * ms, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
    }
    delete b._t;
    out.push(b);
  }
  return out.length > MAX_BARS ? out.slice(-MAX_BARS) : out;
}

const sameBar = (a, b) => a && b && a.timestamp === b.timestamp && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

// LP position context overlays (range band, entry/exit/BEP lines) use a fixed groupId
// 'lp' — distinguished from the user's own drawings so "delete all" and
// syncing do not touch them (they are derived from position props, rebuilt each time props
// change, not the user's hand drawings).
const LP_GROUP = 'lp';
const DRAW_GROUP = 'draw';
const userOverlays = (chart) => chart.getOverlays().filter((o) => o.groupId !== LP_GROUP);

// A sub-pane indicator gets a short pane so the candles keep most of the height.
function slimPane(chart, id, name) {
  if (INDICATOR_OVERLAY.has(name)) return;
  const ind = chart.getIndicators({ id })[0];
  if (ind?.paneId) chart.setPaneOptions({ id: ind.paneId, height: name === 'VOL' ? 70 : 90 });
}

// Closes a popover when the pointer goes down anywhere outside `ref`.
function useDismiss(open, ref, close) {
  useEffect(() => {
    if (!open) return undefined;
    const f = (e) => { if (!ref.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', f);
    return () => document.removeEventListener('pointerdown', f);
  }, [open, ref, close]);
}

const BTN = 'flex size-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-default hover:text-foreground';

// One toolbar group: the main button draws the last tool used, the caret opens a flyout.
function ToolGroup({ group, onDraw, t, active }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(0);
  const ref = useRef(null);
  useDismiss(open, ref, () => setOpen(false));
  const [name, Icon, label] = group.tools[last];
  const multi = group.tools.length > 1;
  return (
    <div ref={ref} className="relative">
      <div className="flex">
        <button type="button" title={t(label)} aria-label={t(label)} onClick={() => onDraw(name)}
          className={`${BTN} ${active === name ? 'bg-accent/15 text-accent' : ''}`}><Icon className="size-4" /></button>
        {multi && <button type="button" aria-label={t('Alat lain')} aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className="-ml-1 flex h-7 w-3 items-center justify-center rounded text-muted/70 hover:bg-default hover:text-foreground"><ChevronDown className="size-3 -rotate-90" /></button>}
      </div>
      {open && (
        <div className="absolute top-0 left-full z-30 ml-1 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {group.tools.map(([n, I, l], i) => (
            <button key={n} type="button" onClick={() => { setLast(i); setOpen(false); onDraw(n); }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-xs text-muted transition-colors hover:bg-default hover:text-foreground">
              <I className="size-4" />{t(l)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const compact = (v) => (v == null ? '—' : Number(v).toLocaleString(fmtLocale(), { notation: 'compact', maximumFractionDigits: 2 }));

// OHLC strip above the canvas: the bar under the crosshair, or the latest bar.
function Legend({ bar, prev, quote, mc, t }) {
  if (!bar) return <div className="h-4" />;
  const chg = prev?.close > 0 ? (bar.close / prev.close - 1) * 100 : null;
  const up = bar.close >= bar.open;
  const fp = mc ? (v) => `$${compact(v)}` : fmtPrice;
  const tone = up ? 'text-success' : 'text-danger';
  const when = new Date(bar.timestamp).toLocaleString(fmtLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const cell = (k, v) => <span className="whitespace-nowrap"><span className="text-muted">{k}</span> <span className={`num ${tone}`}>{v}</span></span>;
  return (
    <div className="flex min-h-4 min-w-0 flex-wrap items-center gap-x-2.5 text-[0.6875rem] leading-4">
      <span className="num shrink-0 text-muted">{when}</span>
      {cell('O', fp(bar.open))}{cell('H', fp(bar.high))}{cell('L', fp(bar.low))}{cell('C', fp(bar.close))}
      {chg != null && <span className={`num whitespace-nowrap ${tone}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>}
      <span className="hidden whitespace-nowrap sm:inline"><span className="text-muted">{t('Vol')}</span> <span className="num">{compact(bar.volume)}</span></span>
      {(mc || quote) && <span className="hidden text-muted/80 md:inline">· {mc ? 'MCap USD' : quote}</span>}
    </div>
  );
}

/**
 * candles  : [{ t(ms), o, h, l, c, v }] ascending — of timeframe `tf`
 * tf       : '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
 * onTfChange : (tf) => void — shows the timeframe switcher; the parent refetches the candles
 * loading  : the candles on hand belong to another timeframe/source than asked for — they are
 *            kept on screen under a veil instead of being drawn as `tf`
 * error    : candle fetch error (shown over the chart, the toolbar stays usable); onRetry: button
 * series   : identity of the price series besides tf (source/currency) — a change resets it
 * quote    : quote asset symbol (the ticker in the legend)
 * drawKey  : shared drawing list key ('tok:<address>' or 'pool:<ref>') — null = no drawings
 * poolRef  : the old per-pool drawing list, adopted when the token has none yet
 * usdRate  : chart price × usdRate = USD price; null when unknown (drawings then stay in `quote`)
 * supply   : token count (market cap ÷ price) — with usdRate it enables the Price / MCap switch
 * range    : { lo, hi } price range of the LP position, or null
 * ranges   : [{ id, lo, hi, color, label, selected, from(ms), to(ms) }] — many bands
 *            at once (all open positions in the same pool). If given, `range`
 *            is ignored: the `selected` band represents the position being viewed.
 * entry    : { t(ms), p }  exit : { t(ms), p }  now : current price — all optional,
 *            used to draw the position context (not user drawings)
 * title    : short label shown in the fullscreen header (pair name)
 */
export default function AdvancedChart({
  candles, tf, onTfChange = null, loading = false, error = null, onRetry = null, series = '',
  quote, drawKey = null, poolRef = null, usdRate = null, supply = null, title = null, height = 420,
  range = null, ranges = null, entry = null, exit = null, now = null, bep = null,
}) {
  const { t } = useI18n();
  const wrap = useRef(null);
  const box = useRef(null);
  const chartRef = useRef(null);
  const dataRef = useRef([]);
  const loadedRef = useRef(null);       // `${tf}|${series}` of the series in the chart
  const pendingRef = useRef(null);       // overlay id being drawn right now (Esc cancels it)
  const selectedRef = useRef(null);      // overlay id last clicked (Delete removes it)
  const draggingRef = useRef(null);      // overlay id being dragged (a sync must not snap it back)
  const silentRef = useRef(false);       // removals done by a sync are not written back
  const syncRef = useRef(null);          // { origin, unsubscribe } of the drawing subscription
  const renderedRef = useRef(new Map()); // id -> `updated` of the copy drawn
  const rateRef = useRef(null);          // usdRate the drawings were converted with
  const magnetRef = useRef(false);
  const lockedRef = useRef(false);
  const hiddenRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [pal, setPal] = useState(palette);
  const [activeInds, setActiveInds] = useState(() => new Set(chartPrefs().indicators));
  // What was last picked for this token (timeframe, Price/MCap, scale) comes back, on every page it is charted.
  const [axis, setAxisState] = useState(() => viewOf(drawKey).axis || 'auto');
  const [metric, setMetricState] = useState(() => viewOf(drawKey).metric || readMetric());
  const viewOrigin = useRef(Symbol('view'));
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const tfChangeRef = useRef(onTfChange);
  tfChangeRef.current = onTfChange;
  const setAxis = (v) => { setAxisState(v); saveView(drawKey, { axis: v }, viewOrigin.current); };
  const pickTf = (v) => { onTfChange?.(v); saveView(drawKey, { tf: v }, viewOrigin.current); };
  useEffect(() => subscribeView(drawKey, (v) => {
    if (v.metric) setMetricState(v.metric);
    if (v.axis) setAxisState(v.axis);
    if (v.tf && v.tf !== tfRef.current) tfChangeRef.current?.(v.tf);
  }, viewOrigin.current), [drawKey]);
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [full, setFull] = useState(false);
  const [indOpen, setIndOpen] = useState(false);
  const [drawing, setDrawing] = useState(null);
  const [note, setNote] = useState(null);       // null = closed, string = text being typed
  const [hover, setHover] = useState(null);     // data index under the crosshair, null = latest
  const [tick, setTick] = useState(0);          // bumps when the series in the chart changes
  const indRef = useRef(null);
  const closeInd = useCallback(() => setIndOpen(false), []);
  useDismiss(indOpen, indRef, closeInd);

  // Market-cap view: every price on the chart (candles, bands, lines, drawings) is multiplied by
  // `sc` = usdRate × supply; volume is left alone.
  const mcMul = usdRate > 0 && supply > 0 ? usdRate * supply : null;
  const mc = metric === 'mc' && mcMul > 0;
  const sc = mc ? mcMul : 1;
  const setMetric = (v) => { setMetricState(v); saveView(drawKey, { metric: v }, viewOrigin.current); try { localStorage.setItem(METRIC_KEY, v); } catch { /* ignore */ } };
  const data = useMemo(() => {
    const rows = normalize(candles, tf);
    return sc === 1 ? rows : rows.map((d) => ({ ...d, open: d.open * sc, high: d.high * sc, low: d.low * sc, close: d.close * sc }));
  }, [candles, tf, sc]);
  if (!loading) dataRef.current = data;
  const key = `${tf}|${series}|${mc ? 'mc' : 'px'}`;
  // Wide price swings (memecoins) are unreadable on a linear axis, so default to log past 4x —
  // measured on the candle bodies, so one wild wick does not flip the axis.
  const autoLog = useMemo(() => {
    if (!data.length) return false;
    let lo = Infinity, hi = 0;
    for (const d of data) { lo = Math.min(lo, d.open, d.close); hi = Math.max(hi, d.open, d.close); }
    return hi / lo > 4;
  }, [data]);
  const axisName = axis === 'auto' ? (autoLog ? 'logPrice' : 'priceLin') : axis;

  // The unit drawings are stored in: USD when this chart knows its rate, else its own quote.
  const unit = usdRate > 0 ? 'usd' : `q:${quote || '?'}`;
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const usdRef = useRef(usdRate);
  usdRef.current = usdRate > 0 ? usdRate / sc : null;

  useEffect(() => {
    const mo = new MutationObserver(() => { const p = palette(); PAL = p; setPal(p); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // ---- drawings: chart <-> shared store ----

  const canShow = (it) => (it.unit === 'usd' ? !!rateRef.current : it.unit == null || it.unit === unitRef.current);
  const fromStore = (v, it) => (it.unit === 'usd' ? v / rateRef.current : v);
  const toStoreValue = (v) => (unitRef.current === 'usd' && usdRef.current ? v * usdRef.current : v);

  const toStore = (o) => ({
    name: o.name,
    points: (o.points || []).map((p) => ({ timestamp: p.timestamp, value: p.value == null ? null : toStoreValue(p.value) })),
    styles: o.styles || null, extendData: o.extendData ?? null, lock: !!o.lock, unit: unitRef.current,
  });
  // the copy on the chart is now the stored one: a later sync must not redraw it
  const save = (o) => {
    if (!drawKey || !o) return;
    const it = writeDrawing(drawKey, o.id, toStore(o), syncRef.current?.origin);
    renderedRef.current.set(o.id, it.updated);
  };

  const hooks = {
    onDrawEnd: ({ overlay }) => { pendingRef.current = null; setDrawing(null); save(overlay); },
    onPressedMoveStart: ({ overlay }) => { draggingRef.current = overlay.id; },
    onPressedMoveEnd: ({ overlay }) => { draggingRef.current = null; save(overlay); },
    onRemoved: ({ overlay }) => {
      renderedRef.current.delete(overlay.id);
      if (!silentRef.current && drawKey && overlay.id !== pendingRef.current) writeDrawing(drawKey, overlay.id, null, syncRef.current?.origin);
    },
    onSelected: ({ overlay }) => { selectedRef.current = overlay.id; },
    onDeselected: () => { selectedRef.current = null; },
    // right click on a drawing removes it
    onRightClick: ({ overlay }) => { chartRef.current?.chart.removeOverlay({ id: overlay.id }); return true; },
  };
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  // klinecharts keeps the callbacks it was given: route them to the latest render's closures.
  const stableHooks = useMemo(() => Object.fromEntries(Object.keys(hooks).map((k) => [k, (e) => hooksRef.current[k](e)])), []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the chart's drawings in line with the shared list. `force` redraws all of them
  // (after a series swap, or when the USD rate moved).
  const reconcile = (force = false) => {
    const r = chartRef.current;
    if (!r || !dataRef.current.length || !drawKey) return;
    const chart = r.chart;
    // read from the store, not a copy: this chart's own edits are in it too
    const items = drawingsOf(drawKey);
    const keep = new Set();
    const claim = [];
    silentRef.current = true;
    try {
      for (const it of items.values()) {
        if (!it?.id || !it.name || !canShow(it)) continue;
        keep.add(it.id);
        if (it.id === pendingRef.current || it.id === draggingRef.current) continue;
        const has = chart.getOverlays({ id: it.id }).length > 0;
        if (has && !force && renderedRef.current.get(it.id) === (it.updated || 0)) continue;
        if (has) chart.removeOverlay({ id: it.id });
        chart.createOverlay({
          id: it.id, groupId: DRAW_GROUP, name: it.name,
          points: (it.points || []).map((p) => ({ timestamp: p.timestamp, value: p.value == null ? undefined : fromStore(p.value, it) })),
          styles: it.styles || undefined, extendData: it.extendData ?? undefined,
          lock: lockedRef.current || !!it.lock, visible: !hiddenRef.current, mode: magnetRef.current ? 'weak_magnet' : 'normal',
          ...stableHooks,
        });
        renderedRef.current.set(it.id, it.updated || 0);
        if (it.unit == null) claim.push(it.id);
      }
      for (const o of userOverlays(chart)) {
        if (o.id !== pendingRef.current && !keep.has(o.id)) chart.removeOverlay({ id: o.id });
      }
    } finally { silentRef.current = false; }
    // drawings from the old per-pool storage: rewritten in this chart's unit (and so saved)
    for (const id of claim) save(chart.getOverlays({ id })[0]);
  };
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  // ---- chart lifecycle ----

  // KLineChart v10 DataLoader: getBars hands over the whole series at once (no paging), and
  // subscribeBar is the channel for live updates of the tail.
  useEffect(() => {
    const el = box.current;
    PAL = pal;
    const chart = init(el, { styles: buildStyles(pal) });
    if (!chart) return undefined;
    let sub = null;
    const loader = {
      // a copy: klinecharts pushes live bars into the array it is given
      getBars: ({ callback }) => callback(dataRef.current.slice(), false),
      subscribeBar: ({ callback }) => { sub = callback; },
      unsubscribeBar: () => { sub = null; },
      push: (bar) => sub?.(bar),
    };
    chartRef.current = { chart, loader, indicatorIds: {} };
    chart.setFormatter({
      formatExtendText: ({ data: bar }) => {
        const ms = periodMs(chart.getPeriod());
        const list = chart.getDataList();
        // only the running candle has a countdown — not a closed position's last bar
        return list[list.length - 1]?.timestamp === bar?.timestamp && bar.timestamp + ms > Date.now() ? countdown(bar.timestamp, ms) : '';
      },
    });
    chart.setSymbol({ ticker: quote || 'PRICE', pricePrecision: precisionFor(dataRef.current), volumePrecision: 2 });
    chart.setPeriod(PERIOD[tf] || PERIOD['1h']);
    chart.setDataLoader(loader);
    // the series effect below loads the candles (and fits the view) on its first run
    loadedRef.current = null;
    const onCross = (c) => {
      if (c?.x == null) return;
      const [pt] = chart.convertFromPixel([{ x: c.x, y: c.y ?? 0 }], { paneId: 'candle_pane' });
      setHover(pt?.dataIndex ?? null);
    };
    chart.subscribeAction('onCrosshairChange', onCross);
    // Zooming out stops once every candle fits: past that point the library keeps shrinking
    // the bars into a sliver at the right with an empty pane to its left.
    const clampZoom = () => {
      const w = chart.getSize('candle_pane', 'main')?.width;
      const n = chart.getDataList().length;
      if (!w || n < 2) return;
      const min = Math.max(1, (w * 0.92) / n);
      if (chart.getBarSpace().bar < min) { chart.setBarSpace(min); chart.scrollToRealTime(); }
    };
    chart.subscribeAction('onZoom', clampZoom);
    setReady(true);
    return () => {
      chart.unsubscribeAction('onCrosshairChange', onCross);
      chart.unsubscribeAction('onZoom', clampZoom);
      dispose(el); chartRef.current = null; setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { PAL = pal; chartRef.current?.chart.setStyles(buildStyles(pal)); }, [pal]);

  // Price-axis mode.
  useEffect(() => {
    if (!ready) return;
    chartRef.current?.chart.overrideYAxis({ paneId: 'candle_pane', name: axisName });
  }, [ready, axisName]);

  // Initial / reset zoom: show the position's whole life (entry candle with some margin) or the
  // last ~90 bars, with the last candle a few bars in from the price axis.
  const fitView = useCallback(() => {
    const r = chartRef.current;
    const w = r?.chart.getSize('candle_pane', 'main')?.width;
    const list = r?.chart.getDataList() || [];
    const n = list.length;
    if (!r || !w || !n) return;
    const startIdx = entry?.t ? list.findIndex((d) => d.timestamp >= entry.t) : -1;
    const bars = startIdx >= 0 ? n - startIdx : 0;
    const visible = Math.min(n, Math.max(90, Math.round(bars * 1.15) + 10));
    const space = Math.max(1.5, Math.min(18, (w - 60) / (visible + 1)));
    r.chart.setBarSpace(space);
    r.chart.setOffsetRightDistance(Math.max(40, space * 4));
    r.chart.scrollToRealTime();
  }, [entry?.t]);

  // Series updates. Three cases:
  //  - another timeframe/source: swap the whole series (after `loading` clears) and refit;
  //  - the tail moved (live price, new candles): pushed bar by bar, so zoom & scroll stay;
  //  - history rewritten (GeckoTerminal corrected older candles, more history): reload the
  //    series in place, keeping the bar width and the scroll position.
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || loading || !data.length) return;
    const chart = r.chart;
    if (loadedRef.current !== key) {
      const first = loadedRef.current == null;
      chart.setSymbol({ ticker: quote || 'PRICE', pricePrecision: mc ? 0 : precisionFor(data), volumePrecision: 2 });
      chart.setPeriod(PERIOD[tf] || PERIOD['1h']);   // resets the data through getBars
      loadedRef.current = key;
      setHover(null);
      setTick((n) => n + 1);
      setTimeout(() => { fitView(); reconcileRef.current(true); }, first ? 60 : 0);
      return;
    }
    const held = chart.getDataList();
    const last = held[held.length - 1];
    let j = data.length - 1;
    while (j >= 0 && data[j].timestamp > (last?.timestamp ?? Infinity)) j--;
    const tailOnly = last && j >= 0 && data[j].timestamp === last.timestamp && data[0].timestamp >= held[0].timestamp
      && (j === 0 || sameBar(data[j - 1], held[held.length - 2]) || data[j - 1].timestamp !== held[held.length - 2]?.timestamp);
    if (tailOnly) {
      for (let i = j; i < data.length; i++) if (i > j || !sameBar(data[i], last)) r.loader.push({ ...data[i] });
      return;
    }
    // reload in place
    const space = chart.getBarSpace().bar;
    const vr = chart.getVisibleRange();
    const atEnd = vr.realTo >= held.length - 1;
    const rightTs = held[Math.min(held.length - 1, Math.max(0, vr.to - 1))]?.timestamp;
    chart.resetData();
    chart.setBarSpace(space);
    if (atEnd || rightTs == null) chart.scrollToRealTime(); else chart.scrollToTimestamp(rightTs);
    reconcileRef.current(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ready, loading, key]);

  // Shared drawings: subscribe once per key.
  useEffect(() => {
    if (!ready || !drawKey) return undefined;
    const s = subscribeDrawings(drawKey, () => reconcileRef.current(), { legacy: poolRef });
    syncRef.current = s;
    return () => { s.unsubscribe(); syncRef.current = null; };
  }, [ready, drawKey, poolRef]);

  // The USD rate drifts with the quote asset: redraw the USD-stored drawings when it has moved
  // by more than half a percent (not on every tick of the live price).
  useEffect(() => {
    const v = usdRate > 0 ? usdRate / sc : null;
    const prev = rateRef.current;
    if (prev === v || (prev && v && Math.abs(v / prev - 1) < 0.005)) return;
    rateRef.current = v;
    if (ready) reconcileRef.current(true);
  }, [usdRate, sc, ready]);

  // Indicators: one set for every chart.
  const applyIndicators = useCallback((names) => {
    const r = chartRef.current; if (!r) return;
    const want = new Set(names.filter((n) => KNOWN_INDICATORS.has(n)));
    for (const [name, id] of Object.entries(r.indicatorIds)) {
      if (!want.has(name)) { r.chart.removeIndicator({ id }); delete r.indicatorIds[name]; }
    }
    for (const name of want) {
      if (r.indicatorIds[name]) continue;
      // VOL without its three moving averages: bars only, and a one-line legend that does not
      // pile up over the bars in a narrow card
      const spec = INDICATOR_OVERLAY.has(name) ? { name, paneId: 'candle_pane' } : name === 'VOL' ? { name, calcParams: [] } : name;
      const id = r.chart.createIndicator(spec, false);
      if (id) { r.indicatorIds[name] = id; slimPane(r.chart, id, name); }
    }
    setActiveInds(new Set(Object.keys(r.indicatorIds)));
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    applyIndicators(chartPrefs().indicators);
    return subscribePrefs((p) => applyIndicators(p.indicators || []));
  }, [ready, applyIndicators]);

  // Range bands: filtered to those with sensible prices, then summarised into a single key
  // so the effect below is only rebuilt when the bands really change.
  const bandList = useMemo(() => (ranges || []).filter((b) => b.lo > 0 && b.hi > 0), [ranges]);
  const bandKey = useMemo(() => bandList.map((b) => `${b.id}:${b.lo}:${b.hi}:${b.from || 0}:${b.to || 0}:${b.color}:${b.selected ? 1 : 0}`).join('|'), [bandList]);

  // LP position context: range band + entry/exit/BEP/now lines. Rebuilt
  // (not moved) every time props change — cheap enough and avoids tracking an id per line.
  const first = data[0]?.timestamp, anchor = data[data.length - 1]?.timestamp;
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || loading || first == null) return;
    for (const o of r.chart.getOverlays({ groupId: LP_GROUP })) r.chart.removeOverlay({ id: o.id });
    const specs = [];
    // Many bands (all open positions in the pool) or a single band. The selected one
    // is drawn last so it sits above the other bands.
    const bands = bandList.length
      ? [...bandList].sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0))
      : range?.lo > 0 && range?.hi > 0
        ? [{ lo: range.lo, hi: range.hi, color: pal.accent, selected: true, from: entry?.t, to: exit?.t }]
        : [];
    // Without a highlighted position, all bands are drawn solid — none "loses".
    const anySel = bands.some((b) => b.selected);
    for (const b of bands) {
      // Without an entry time, the band starts at the first candle; without an exit time, the band
      // is considered still open and extends to the right edge.
      const from = b.from > 0 ? Math.max(b.from, first) : first;
      const to = b.to > 0 ? b.to : anchor;
      const color = b.color || pal.accent;
      const strong = b.selected || !anySel || bands.length === 1;
      specs.push({
        name: 'lpRange', groupId: LP_GROUP, lock: true,
        points: [{ timestamp: from, value: b.hi * sc }, { timestamp: to, value: b.lo * sc }],
        extendData: {
          fill: withAlpha(color, strong ? (pal.dark ? 0.13 : 0.1) : (pal.dark ? 0.06 : 0.05)),
          line: withAlpha(color, strong ? 0.6 : 0.3),
          open: !(b.to > 0), dim: !strong, label: bands.length > 1 ? b.label || null : null,
        },
      });
    }
    const priceLine = (p, color, label) => specs.push({
      name: 'lpLine', groupId: LP_GROUP, lock: true,
      points: [{ timestamp: anchor, value: p * sc }], extendData: { color, label },
    });
    if (entry?.p > 0) priceLine(entry.p, pal.muted, t('Masuk'));
    if (entry?.t >= first) specs.push({ name: 'verticalStraightLine', groupId: LP_GROUP, lock: true, points: [{ timestamp: entry.t, value: (entry.p || 0) * sc }], styles: { line: { color: pal.accent, style: 'dashed', size: 1 } } });
    if (exit?.p > 0) priceLine(exit.p, pal.warning, t('Keluar'));
    if (bep > 0) priceLine(bep, pal.warning, 'BEP');
    // the live price is the last candle's close (its axis label shows it): a line only when
    // the candles lag behind it
    const lastClose = data[data.length - 1]?.close;
    if (now > 0 && !(lastClose > 0 && Math.abs(now * sc / lastClose - 1) < 0.01)) priceLine(now, withAlpha(pal.fg, 0.55), t('Sekarang'));
    if (specs.length) r.chart.createOverlay(specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, tick, first, anchor, bandKey, range?.lo, range?.hi, entry?.p, entry?.t, exit?.p, exit?.t, now, bep, pal, sc]);

  // ---- toolbar actions ----

  // Applies one property (lock / visible / mode) to every drawing of the user.
  const setAll = (patch, persist = false) => {
    const r = chartRef.current; if (!r) return;
    for (const o of userOverlays(r.chart)) {
      r.chart.overrideOverlay({ id: o.id, ...patch });
      if (persist) save(r.chart.getOverlays({ id: o.id })[0]);
    }
  };
  const draw = (name, extra = {}) => {
    const r = chartRef.current; if (!r) return;
    if (pendingRef.current) cancelDraw();
    // a new drawing on a locked / hidden chart would be invisible or immovable: unlock first
    if (lockedRef.current) toggleLock();
    if (hiddenRef.current) toggleHidden();
    if (name === 'note') { setNote(''); return; }
    const id = r.chart.createOverlay({ id: newDrawingId(), groupId: DRAW_GROUP, name, mode: magnetRef.current ? 'weak_magnet' : 'normal', ...extra, ...stableHooks });
    pendingRef.current = id; setDrawing(name);
  };
  const submitNote = (e) => {
    e.preventDefault();
    const text = (note || '').trim();
    setNote(null);
    if (text) draw('simpleAnnotation', { extendData: text });
  };
  const cancelDraw = () => {
    const r = chartRef.current;
    const id = pendingRef.current;
    pendingRef.current = null; setDrawing(null);
    if (id && r) { silentRef.current = true; r.chart.removeOverlay({ id }); silentRef.current = false; }
  };
  const removeSelected = () => {
    const r = chartRef.current;
    if (selectedRef.current && r) { r.chart.removeOverlay({ id: selectedRef.current }); selectedRef.current = null; }
  };
  const clearAll = async () => {
    const ok = await ask({ title: t('Hapus semua gambar di grafik ini?'), body: t('Gambar token ini hilang dari semua grafik dan timeframe.'), confirm: t('Hapus'), danger: true });
    if (!ok) return;
    const r = chartRef.current; if (!r) return;
    for (const o of userOverlays(r.chart)) r.chart.removeOverlay({ id: o.id });
    // drawings stored in a unit this chart cannot show are part of the same token too
    if (drawKey) for (const id of [...drawingsOf(drawKey).keys()]) writeDrawing(drawKey, id, null, syncRef.current?.origin);
  };
  const toggleMagnet = () => { const v = !magnet; magnetRef.current = v; setMagnet(v); setAll({ mode: v ? 'weak_magnet' : 'normal' }); };
  const toggleLock = () => { const v = !lockedRef.current; lockedRef.current = v; setLocked(v); setAll({ lock: v }, true); };
  const toggleHidden = () => { const v = !hiddenRef.current; hiddenRef.current = v; setHidden(v); setAll({ visible: !v }); };
  const toggleIndicator = (name, on) => {
    const cur = new Set(chartPrefs().indicators);
    if (on) cur.add(name); else cur.delete(name);
    setChartPrefs({ indicators: [...cur] });
  };
  const screenshot = () => {
    const r = chartRef.current; if (!r) return;
    const url = r.chart.getConvertPictureUrl(true, 'png', cssColor('--surface'));
    const a = document.createElement('a');
    a.href = url; a.download = `${title || quote || 'chart'}-${tf}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
    a.click();
  };

  // Keyboard: Esc cancels the drawing in progress (or leaves fullscreen), Delete removes the
  // drawing that was clicked last, Alt+R resets the view.
  const onKeyDown = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') { if (pendingRef.current) cancelDraw(); else if (full) setFull(false); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedRef.current) { e.preventDefault(); removeSelected(); } }
    else if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); fitView(); }
  };

  // The chart needs a resize once its container changed size (fullscreen, sidebar, rotation).
  useEffect(() => {
    if (!ready || !box.current) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => chartRef.current?.chart.resize()); });
    ro.observe(box.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [ready]);
  useEffect(() => {
    if (!full) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [full]);

  const seg = (on) => `rounded px-1.5 py-1 text-[0.6875rem] font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`;
  const list = chartRef.current?.chart.getDataList() || [];
  const legendIdx = hover != null && hover >= 0 && hover < list.length ? hover : list.length - 1;
  void tick;   // the legend reads the chart's list, which `tick` / data changes refresh

  return (
    <div ref={wrap} tabIndex={-1} onKeyDown={onKeyDown}
      className={`outline-none ${full ? 'fixed inset-0 z-[60] flex flex-col bg-surface p-3' : ''}`}>
      {/* top bar: timeframe, price axis, indicators, utilities */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {full && title && <span className="mr-1 text-sm font-semibold">{title}</span>}
        {onTfChange && (
          <div className="flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5" role="radiogroup" aria-label={t('Rentang lilin')}>
            {TIMEFRAMES.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={tf === id} onClick={() => tf !== id && pickTf(id)} className={seg(tf === id)}>{label}</button>
            ))}
          </div>
        )}
        {mcMul > 0 && (
          <div className="flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5" role="radiogroup" aria-label={t('Tampilan grafik')}>
            {[['price', t('Harga')], ['mc', 'MCap']].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={(id === 'mc') === mc} onClick={() => setMetric(id)} className={seg((id === 'mc') === mc)}>{label}</button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5" role="radiogroup" aria-label={t('Skala harga')}>
          {AXES.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={axisName === id} onClick={() => setAxis(id)} className={seg(axisName === id)}>{label}</button>
          ))}
        </div>
        <div ref={indRef} className="relative">
          <button type="button" aria-expanded={indOpen} onClick={() => setIndOpen((v) => !v)}
            className="inline-flex h-[30px] items-center gap-1.5 rounded border border-border bg-surface/80 px-2 text-[0.6875rem] font-medium text-muted transition-colors hover:text-foreground">
            <Activity className="size-3.5" />{t('Indikator')}
            {activeInds.size > 0 && <span className="num rounded bg-accent/15 px-1 text-accent">{activeInds.size}</span>}
            <ChevronDown className="size-3" />
          </button>
          {indOpen && (
            <div className="absolute top-full left-0 z-30 mt-1 w-72 max-w-[85vw] rounded-lg border border-border bg-surface p-2.5 shadow-lg">
              {INDICATOR_GROUPS.map(([label, , names]) => (
                <div key={label} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[0.625rem] font-semibold tracking-wide text-muted uppercase">{t(label)}</div>
                  <div className="flex flex-wrap gap-1">
                    {names.map((name) => {
                      const on = activeInds.has(name);
                      return <button key={name} type="button" aria-pressed={on} onClick={() => toggleIndicator(name, !on)}
                        className={`rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium transition-colors ${on ? 'border-accent/60 bg-accent/10 text-foreground' : 'border-border text-muted hover:text-foreground'}`}>{name}</button>;
                    })}
                  </div>
                </div>
              ))}
              <p className="mt-2 text-[0.625rem] text-muted">{t('Berlaku untuk semua grafik.')}</p>
            </div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5">
          <button type="button" title={`${t('Kembali ke harga terbaru')} (Alt+R)`} aria-label={t('Kembali ke harga terbaru')} onClick={fitView} className={BTN}><RotateCcw className="size-3.5" /></button>
          <button type="button" title={t('Simpan gambar grafik')} aria-label={t('Simpan gambar grafik')} onClick={screenshot} className={BTN}><Camera className="size-3.5" /></button>
          <button type="button" title={full ? t('Keluar layar penuh') : t('Layar penuh')} aria-label={full ? t('Keluar layar penuh') : t('Layar penuh')} onClick={() => setFull((v) => !v)} className={BTN}>
            {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </span>
      </div>

      <div className={`flex gap-1.5 ${full ? 'min-h-0 flex-1' : ''}`}>
        {/* left toolbar: drawing groups, then magnet / lock / hide / clear */}
        <div className="flex shrink-0 flex-col items-center gap-0.5 self-start rounded border border-border bg-surface/80 p-0.5" role="toolbar" aria-orientation="vertical" aria-label={t('Alat gambar')}>
          {TOOL_GROUPS.map((g) => <ToolGroup key={g.id} group={g} onDraw={draw} t={t} active={drawing} />)}
          <span className="my-0.5 h-px w-5 bg-border" />
          <button type="button" title={t('Magnet ke harga OHLC')} aria-label={t('Magnet ke harga OHLC')} aria-pressed={magnet} onClick={toggleMagnet}
            className={`${BTN} ${magnet ? 'bg-accent/15 text-accent' : ''}`}><Magnet className="size-4" /></button>
          <button type="button" title={locked ? t('Buka kunci gambar') : t('Kunci gambar')} aria-label={locked ? t('Buka kunci gambar') : t('Kunci gambar')} aria-pressed={locked} onClick={toggleLock}
            className={`${BTN} ${locked ? 'bg-accent/15 text-accent' : ''}`}>{locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}</button>
          <button type="button" title={hidden ? t('Tampilkan gambar') : t('Sembunyikan gambar')} aria-label={hidden ? t('Tampilkan gambar') : t('Sembunyikan gambar')} aria-pressed={hidden} onClick={toggleHidden}
            className={`${BTN} ${hidden ? 'bg-accent/15 text-accent' : ''}`}>{hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
          <button type="button" title={t('Hapus semua gambar')} aria-label={t('Hapus semua gambar')} onClick={clearAll}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-danger/10 hover:text-danger"><Trash2 className="size-4" /></button>
        </div>
        <div className={`relative flex min-w-0 flex-1 flex-col ${full ? 'min-h-0' : ''}`}>
          <Legend bar={loading ? null : list[legendIdx]} prev={list[legendIdx - 1]} quote={quote} mc={mc} t={t} />
          <div ref={box} onPointerLeave={() => setHover(null)} style={full ? undefined : { height }} className={`w-full ${full ? 'min-h-0 flex-1' : ''}`} />
          {/* veil while another timeframe loads, or the fetch failed */}
          {(loading || error) && (
            <div className="absolute inset-x-0 top-4 bottom-0 z-10 flex items-center justify-center bg-surface/60 backdrop-blur-[1px]">
              {error && !loading ? (
                <div className="flex max-w-xs flex-col items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-center text-xs shadow">
                  <span className="font-medium">{t('Grafik belum tersedia')}</span>
                  <span className="text-muted">{t(error)}</span>
                  {onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 font-medium hover:bg-default"><RefreshCw className="size-3.5" />{t('Coba lagi')}</button>}
                </div>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow">
                  <Loader2 className="size-3.5 animate-spin" />{t('Memuat lilin {tf}…', { tf: (TIMEFRAMES.find(([id]) => id === tf) || [tf, tf])[1] })}
                </span>
              )}
            </div>
          )}
          {/* hint while a drawing is in progress / text prompt for the note tool */}
          {drawing && (
            <div className="pointer-events-none absolute bottom-8 left-2 z-10 flex items-center gap-1.5 rounded bg-surface/90 px-2 py-1 text-[0.6875rem] text-muted shadow">
              <Crosshair className="size-3.5 text-accent" />{t('Klik di grafik untuk menggambar · Esc untuk batal')}
            </div>
          )}
          {note != null && (
            <form onSubmit={submitNote} className="absolute top-6 left-2 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder={t('Teks catatan…')} aria-label={t('Teks catatan…')}
                onKeyDown={(e) => e.key === 'Escape' && setNote(null)}
                className="h-7 w-44 rounded border border-border bg-transparent px-2 text-xs outline-none focus:border-accent" />
              <button type="submit" className="h-7 rounded bg-accent px-2.5 text-xs font-medium text-accent-foreground">{t('Pasang')}</button>
            </form>
          )}
        </div>
      </div>
      <p className="mt-1 hidden truncate text-[0.625rem] text-muted/80 sm:block" title={t('Gambar tersimpan per token dan muncul di semua grafik & timeframe · Klik kanan pada gambar untuk menghapusnya · Delete menghapus gambar terpilih.')}>{t('Gambar tersimpan per token dan muncul di semua grafik & timeframe · Klik kanan pada gambar untuk menghapusnya · Delete menghapus gambar terpilih.')}</p>
    </div>
  );
}
