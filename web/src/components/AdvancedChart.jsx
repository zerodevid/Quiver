// Advanced chart with KLineChart, laid out like the GMGN / TradingView terminal: a plain-text
// top bar (timeframe, chart type, indicators, Price / MCap), a borderless drawing rail on the
// left (lines, fibonacci, shapes, notes, measure, magnet / lock / hide), the OHLC legend over
// the candles, volume overlaid at the foot of the price pane, and a bottom bar with range
// presets, a clock and the price-scale mode (auto / lin / log / %).
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
import { init, dispose, registerOverlay, registerYAxis, registerIndicator } from 'klinecharts';
import {
  TrendingUp, Minus, Ruler, Brush, GitCommitHorizontal, Square, Trash2, Magnet, Lock, LockOpen, Eye, EyeOff,
  Maximize2, Minimize2, Camera, ChevronDown, Type, Tag, MoveUpRight, Slash, ArrowRightToLine, SeparatorVertical,
  Equal, Rows3, RotateCcw, Crosshair, Loader2, RefreshCw, CandlestickChart, ChartNoAxesColumn, AreaChart, SquareFunction, CalendarRange, History,
} from 'lucide-react';
import { ask } from './ui';
import { useI18n } from '../i18n';
import { price as fmtPrice, usd as fmtUsd, pct as fmtPct, age as fmtAge, locale as fmtLocale } from '../fmt';
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
      // under the OHLC legend the tag moves to the right end of the line
      const right = c.y < LEGEND_PX + 8;
      figures.push({ type: 'text', ignoreEvent: true, attrs: { x: right ? bounding.width - 4 : 4, y: right ? c.y + 2 : c.y - 2, text: label, align: right ? 'right' : 'left', baseline: right ? 'top' : 'bottom' },
        styles: tagStyle(color) });
    }
    return figures;
  },
});

// A closed LP position from the pool's history: its range over its lifetime, tinted by the
// result, a dashed path from the entry price to the exit price, and a "#id +$12 · +4.5%" tag.
// Points: 1 = (open, hi), 2 = (close, lo), 3 = (open, entry price), 4 = (close, exit price),
// 5 = (close, hi), 6 = (open, lo). On USD candles of a pool quoted in another token the range moves
// with that token's dollar rate, so the edges at the close (2, 5) may differ from those at the open
// (1, 6) and the box becomes a slanted band. Points 3/4 fall back to the band edges when the price
// is unknown (extendData.entry / exit false).
registerOverlay({
  name: 'lpHist', totalStep: 7,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const [c1, c2, ce, cx, c5, c6] = coordinates;
    if (!c1 || !c2 || !c5 || !c6) return [];
    const { color, label, short, entry, exit, clipped } = overlay.extendData || {};
    const x1 = Math.max(0, c1.x), x2 = Math.min(bounding.width, c2.x);
    if (x2 <= x1) return [];
    const y1 = Math.min(c1.y, c6.y, c2.y, c5.y), y2 = Math.max(c1.y, c6.y, c2.y, c5.y);
    // the edges at the clipped x, along the slant
    const at = (a, b, x) => (b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    const corners = [{ x: x1, y: at(c1, c5, x1) }, { x: x2, y: at(c1, c5, x2) }, { x: x2, y: at(c6, c2, x2) }, { x: x1, y: at(c6, c2, x1) }];
    const figures = [
      { type: 'polygon', ignoreEvent: true, attrs: { coordinates: corners }, styles: { style: 'stroke_fill', color: withAlpha(color, PAL.dark ? 0.09 : 0.07), borderColor: withAlpha(color, 0.45), borderSize: 1 } },
    ];
    if (entry && exit && ce && cx) {
      figures.push({ type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: ce.x, y: ce.y }, { x: cx.x, y: cx.y }] }, styles: { style: 'dashed', dashedValue: [3, 3], color: withAlpha(color, 0.7), size: 1 } });
    }
    if (entry && ce && !clipped) figures.push({ type: 'circle', ignoreEvent: true, attrs: { x: ce.x, y: ce.y, r: 3 }, styles: { style: 'fill', color: PAL.accent } });
    if (exit && cx) figures.push({ type: 'circle', ignoreEvent: true, attrs: { x: cx.x, y: cx.y, r: 3 }, styles: { style: 'fill', color } });
    // the full tag on a wide box, the PnL alone on a narrow one, none on a sliver; under the OHLC
    // legend it drops to the box's foot
    const text = x2 - x1 >= 110 ? label : x2 - x1 >= 16 ? short : null;
    if (text) {
      const low = y1 < LEGEND_PX + 8;
      figures.push({ type: 'text', ignoreEvent: true, attrs: { x: x1 + 3, y: low ? Math.max(corners[2].y, corners[3].y) - 2 : Math.min(corners[0].y, corners[1].y) - 2, text, align: 'left', baseline: 'bottom' }, styles: tagStyle(color) });
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
// A market-cap series is set to precision 0, and reads as 875.46K like on GMGN.
const trimZeros = (value, precision) => {
  if (precision === 0 && Math.abs(value) >= 1000) return compact(value);
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
// Narrowest bar of a zoom-out, like GMGN: a young token's few candles shrink to a thin sliver with
// empty pane around them, and a long series still fits whole in the pane.
const MIN_BAR = 0.3;
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
  ['Di atas harga', true, ['VOL', 'MA', 'EMA', 'SMA', 'BOLL', 'SAR', 'BBI', 'AVP']],
  ['Panel bawah', false, ['MACD', 'RSI', 'KDJ', 'CCI', 'WR', 'OBV', 'ROC', 'MTM', 'DMI', 'AO', 'PSY', 'TRIX', 'BIAS']],
];
const INDICATOR_OVERLAY = new Set(INDICATOR_GROUPS[0][2]);
const KNOWN_INDICATORS = new Set(INDICATOR_GROUPS.flatMap(([, , list]) => list));

const AXES = [['auto', 'auto'], ['priceLin', 'lin'], ['logPrice', 'log'], ['percentage', '%']];

// Chart types of the top bar (klinecharts candle.type), remembered per browser.
const CHART_TYPES = [
  ['candle_solid', CandlestickChart, 'Lilin'], ['candle_stroke', CandlestickChart, 'Lilin kosong'],
  ['ohlc', ChartNoAxesColumn, 'Batang OHLC'], ['area', AreaChart, 'Area'],
];
const TYPE_KEY = 'lpcopy-chart-type';
const readType = () => { try { const v = localStorage.getItem(TYPE_KEY); return CHART_TYPES.some(([id]) => id === v) ? v : 'candle_solid'; } catch { return 'candle_solid'; } };

// Range presets of the bottom bar: each one picks the coarsest timeframe that still gives the span
// RANGE_BARS bars (1D → 15m, 7D → 1H, 30D → 4H), the way a terminal's range buttons do.
const RANGES = [['1D', 86400e3], ['7D', 7 * 86400e3], ['30D', 30 * 86400e3]];
const RANGE_BARS = 60;

// Space the legend over the candles takes: the price axis keeps the candles below it, and the
// on-price indicators write their values under it.
const LEGEND_PX = 44;

const p2 = (n) => String(n).padStart(2, '0');

// Time left in the running candle, under the last-price label on the axis.
function countdown(ts, ms) {
  const left = Math.max(0, ts + ms - Date.now());
  const s = Math.floor(left / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h >= 24 ? `${Math.floor(h / 24)}d ` : ''}${p2(h % 24)}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
}

// Candle colours of the GMGN / TradingView terminal, the same in both themes: teal up, coral down.
const UP = '#26a69a', DOWN = '#ef5350';
const chartPalette = () => ({ ...palette(), up: UP, down: DOWN });
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// Volume drawn at the foot of the price pane (like GMGN), not in a pane of its own: translucent
// bars scaled to the loudest visible bar, filling the bottom fifth, which the price axis keeps
// clear of candles (a negative zLevel would hide it behind the pane once another on-price
// indicator is on). It has no figures, so it never stretches the price axis. Picked as 'VOL'.
const VOL_SHARE = 0.2;
registerIndicator({
  // series 'price': klinecharts sizes the price axis by the lowest precision on the pane, and the
  // default 4 decimals turned a flat 0.000245 token into a line on an axis 0.001 wide
  name: 'volOverlay', shortName: 'VOL', series: 'price', figures: [],
  // the volume reads in the OHLC legend: no tooltip line of its own
  createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, chart, bounding, xAxis }) => {
    const list = chart.getDataList();
    const { from, to } = chart.getVisibleRange();
    let max = 0;
    for (let i = Math.max(0, from); i < Math.min(list.length, to); i++) max = Math.max(max, list[i].volume || 0);
    if (!(max > 0)) return true;
    const { gapBar } = chart.getBarSpace();
    const w = Math.max(1, gapBar);
    const h = bounding.height * VOL_SHARE;
    for (let i = Math.max(0, from); i < Math.min(list.length, to); i++) {
      const d = list[i];
      if (!(d.volume > 0)) continue;
      const bh = Math.max(1, (d.volume / max) * h);
      ctx.fillStyle = withAlpha(d.close >= d.open ? UP : DOWN, PAL.dark ? 0.42 : 0.35);
      ctx.fillRect(Math.round(xAxis.convertToPixel(i) - w / 2), bounding.height - bh, w, bh);
    }
    return true;
  },
});

function buildStyles(pal) {
  const grid = withAlpha(pal.border, pal.dark ? 0.45 : 0.6);
  const cross = { style: 'dashed', dashedValue: [4, 3], size: 1, color: withAlpha(pal.muted, 0.75) };
  const crossText = { backgroundColor: pal.label, borderColor: pal.label, color: '#ffffff', size: 11, family: FONT, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 };
  return {
    grid: { horizontal: { color: grid, style: 'solid', size: 1 }, vertical: { show: true, color: grid, style: 'solid', size: 1 } },
    candle: {
      bar: {
        upColor: pal.up, downColor: pal.down, noChangeColor: pal.muted,
        upBorderColor: pal.up, downBorderColor: pal.down, noChangeBorderColor: pal.muted,
        upWickColor: pal.up, downWickColor: pal.down, noChangeWickColor: pal.muted,
      },
      area: {
        lineColor: pal.up, lineSize: 2,
        backgroundColor: [{ offset: 0, color: withAlpha(pal.up, 0.01) }, { offset: 1, color: withAlpha(pal.up, 0.22) }],
        point: { color: pal.up, rippleColor: withAlpha(pal.up, 0.3) },
      },
      // OHLC is read from the legend over the candles (an HTML strip, never a box over a candle);
      // the on-price indicators write their values under it, from this offset.
      tooltip: { showRule: 'none', offsetTop: LEGEND_PX },
      priceMark: {
        high: { color: pal.text, textFamily: FONT }, low: { color: pal.text, textFamily: FONT },
        last: {
          upColor: pal.up, downColor: pal.down, noChangeColor: pal.muted,
          line: { style: 'dashed', dashedValue: [1, 2], size: 1 },
          text: { family: FONT, size: 11, weight: '500', borderRadius: 2, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 2 },
          extendTexts: [{ show: true, position: 'below_price', updateInterval: 1000, size: 10, weight: 'normal', family: 'ui-monospace, SFMono-Regular, monospace', color: '#ffffff', paddingLeft: 5, paddingRight: 5, paddingTop: 0, paddingBottom: 3 }],
        },
      },
    },
    indicator: {
      tooltip: { title: { family: FONT, size: 11 }, legend: { family: FONT, size: 11 } },
      lastValueMark: { text: { family: FONT } },
    },
    xAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: { color: pal.text, size: 11, family: FONT, marginStart: 6 } },
    yAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: { color: pal.text, size: 11, family: FONT, marginStart: 8, marginEnd: 8 } },
    crosshair: {
      horizontal: { line: cross, text: crossText },
      vertical: { line: cross, text: crossText },
    },
    overlay: { line: { color: pal.accent }, point: { color: pal.accent, borderColor: pal.accent } },
    separator: { color: pal.border, activeBackgroundColor: withAlpha(pal.accent, 0.12) },
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

// Local wall clock with its UTC offset, ticking on its own so the chart does not re-render.
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const off = -now.getTimezoneOffset();
  const tz = off ? `UTC${off > 0 ? '+' : '−'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${p2(Math.abs(off) % 60)}` : ''}` : 'UTC';
  return <span className="num text-muted">{p2(now.getHours())}:{p2(now.getMinutes())}:{p2(now.getSeconds())} {tz}</span>;
}

// Details of the LP history box under the pointer, pinned to the top-right corner of the price pane.
function HistCard({ h, chart, clickable, t }) {
  const main = chart?.getSize('candle_pane', 'main');
  const tone = h.pnl > 0 ? 'text-[#26a69a]' : h.pnl < 0 ? 'text-[#ef5350]' : 'text-muted';
  const when = (ms) => new Date(ms).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const row = (k, v) => v != null && <div className="flex justify-between gap-4"><span className="text-muted">{k}</span><span className="num text-right">{v}</span></div>;
  return (
    <div className="pointer-events-none absolute z-20 w-56 rounded-md border border-border bg-surface/95 p-2 text-[0.6875rem] shadow-lg"
      style={{ top: (main?.top || 0) + LEGEND_PX + 4, left: main ? main.left + main.width - 8 : undefined, right: main ? undefined : 64, transform: main ? 'translateX(-100%)' : undefined }}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="mono font-semibold text-foreground">{h.label}</span>
        {h.pnl != null && <span className={`num font-semibold ${tone}`}>{fmtUsd(h.pnl)}{h.pnlPct != null && <> · {fmtPct(h.pnlPct, 2)}</>}</span>}
      </div>
      <div className="space-y-0.5">
        {row(t('Fee'), h.fee != null ? fmtUsd(h.fee) : null)}
        {row(t('Modal'), h.cost != null ? fmtUsd(h.cost) : null)}
        {row(t('Lama'), h.from > 0 ? fmtAge((h.to - h.from) / 3600e3) : null)}
        {row(t('Rentang'), `${fmtPrice(h.lo)} – ${fmtPrice(h.hi)}`)}
        {row(t('Masuk → keluar'), h.entry > 0 || h.exit > 0 ? `${h.entry > 0 ? fmtPrice(h.entry) : '—'} → ${h.exit > 0 ? fmtPrice(h.exit) : '—'}` : null)}
        {row(t('Dibuka'), h.from > 0 ? when(h.from) : null)}
        {row(t('Ditutup'), when(h.to))}
      </div>
      {clickable && <div className="mt-1 text-muted">{t('Klik untuk menyorot posisi ini')}</div>}
    </div>
  );
}

const sameBar = (a, b) => a && b && a.timestamp === b.timestamp && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

// LP position context overlays (range band, entry/exit/BEP lines) use a fixed groupId
// 'lp' — distinguished from the user's own drawings so "delete all" and
// syncing do not touch them (they are derived from position props, rebuilt each time props
// change, not the user's hand drawings).
const LP_GROUP = 'lp';
const HIST_GROUP = 'lpHist';     // closed positions of the pool (the "LP history" toggle)
const DRAW_GROUP = 'draw';

// Time span a history box is drawn over: clipped to the loaded candles, null when it closed before them.
const histSpan = (h, first, anchor) => (h.to < first ? null : { from: Math.max(h.from || first, first), to: Math.min(h.to, anchor) });
// The history position under a point of the price pane (pane pixels); the smallest box wins where they overlap.
function histAt(chart, hs, x, y) {
  if (!hs || x == null || y == null) return null;
  let best = null, area = Infinity;
  for (const h of hs.list) {
    const span = histSpan(h, hs.first, hs.anchor);
    if (!span) continue;
    const [a, b, c, d] = chart.convertToPixel([
      { timestamp: span.from, value: h.hi * hs.sc }, { timestamp: span.to, value: (h.loEnd ?? h.lo) * hs.sc },
      { timestamp: span.to, value: (h.hiEnd ?? h.hi) * hs.sc }, { timestamp: span.from, value: h.lo * hs.sc },
    ], { paneId: 'candle_pane' });
    if (!a || !b || !c || !d) continue;
    const y1 = Math.min(a.y, b.y, c.y, d.y), y2 = Math.max(a.y, b.y, c.y, d.y);
    if (x < a.x || x > b.x || y < y1 || y > y2) continue;
    const s = (b.x - a.x) * (y2 - y1);
    if (s < area) { area = s; best = h.id; }
  }
  return best;
}
const userOverlays = (chart) => chart.getOverlays().filter((o) => o.groupId !== LP_GROUP && o.groupId !== HIST_GROUP);

// Price-axis autoscale and vertical moves. klinecharts has no public call for them: these reach the
// axis of the candle pane through the chart instance (klinecharts 10.0.x). Its own vertical pan
// and axis stretch work in raw price, which on a log axis runs away from the pointer, so they are
// switched off (scrollZoomEnabled: false) and done here in axis units instead.
const candleYAxes = (chart) => chart.getDrawPaneById?.('candle_pane')?.getYAxisComponents?.() || [];
const isAutoScale = (chart) => candleYAxes(chart).every((a) => a.getAutoCalcTickFlag());
const relayout = (chart) => chart.layout?.({ measureWidth: true, update: true, buildYAxisTick: true });
function setAutoScale(chart, on) {
  for (const a of candleYAxes(chart)) a.setAutoCalcTickFlag(on);
  if (on) relayout(chart);
}
// Sets an axis to the real (axis-unit: log10 on a log axis) range realFrom..realTo.
function setRealRange(axis, base, realFrom, realTo) {
  const opt = { range: base };
  const from = axis.realValueToValue(realFrom, opt), to = axis.realValueToValue(realTo, opt);
  const displayFrom = axis.realValueToDisplayValue(realFrom, opt), displayTo = axis.realValueToDisplayValue(realTo, opt);
  axis.setRange({ from, to, range: to - from, realFrom, realTo, realRange: realTo - realFrom, displayFrom, displayTo, displayRange: displayTo - displayFrom });
}

// A sub-pane indicator gets a short pane so the candles keep most of the height.
function slimPane(chart, id, name) {
  if (INDICATOR_OVERLAY.has(name)) return;
  const ind = chart.getIndicators({ id })[0];
  if (ind?.paneId) chart.setPaneOptions({ id: ind.paneId, height: 90 });
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
// the left rail of a wide chart: bigger, borderless, like GMGN's
const RAIL_BTN = 'flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-default hover:text-foreground';
const ICON = 'size-[18px]';
const TOP_BTN = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[0.8125rem] font-medium text-muted transition-colors hover:bg-default hover:text-foreground';

// One toolbar group: the main button draws the last tool used, the caret opens a flyout.
function ToolGroup({ group, onDraw, t, active, wide }) {
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
          className={`${wide ? RAIL_BTN : BTN} ${active === name ? 'bg-accent/15 text-accent' : ''}`}><Icon className={wide ? ICON : 'size-4'} /></button>
        {multi && <button type="button" aria-label={t('Alat lain')} aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className={`-ml-1 flex w-3 items-center justify-center rounded text-muted/50 hover:bg-default hover:text-foreground ${wide ? 'h-8' : 'h-7'}`}><ChevronDown className="size-3 -rotate-90" /></button>}
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

// OHLC legend over the top-left of the candles, GMGN style: name · timeframe, O H L C and the
// change from the previous close, then the volume. The bar under the crosshair, or the latest.
function Legend({ bar, prev, label, tfLabel, mc, t, wide }) {
  if (!bar) return null;
  const diff = prev?.close > 0 ? bar.close - prev.close : null;
  const up = diff != null ? diff >= 0 : bar.close >= bar.open;
  const fp = mc ? (v) => compact(v) : fmtPrice;
  const tone = up ? 'text-[#26a69a]' : 'text-[#ef5350]';
  const cell = (k, v) => <span className="whitespace-nowrap"><span className="text-muted">{k}</span><span className={`num ${tone}`}>{v}</span></span>;
  return (
    <div className="pointer-events-none absolute top-1 left-2 z-[5] flex max-w-[calc(100%-5rem)] flex-col gap-0.5 text-[0.75rem] leading-4 [text-shadow:0_0_3px_var(--surface)]">
      <div className={`flex min-w-0 items-center gap-x-2 ${wide ? 'flex-wrap' : 'overflow-hidden'}`}>
        {label && <span className="whitespace-nowrap font-medium text-foreground">{label}<span className="text-muted"> · {tfLabel}</span></span>}
        {wide && <>{cell('O', fp(bar.open))}{cell('H', fp(bar.high))}{cell('L', fp(bar.low))}</>}{cell('C', fp(bar.close))}
        {diff != null && <span className={`num whitespace-nowrap ${tone}`}>{wide && <>{diff >= 0 ? '+' : '−'}{fp(Math.abs(diff))} </>}({diff >= 0 ? '+' : '−'}{Math.abs((diff / prev.close) * 100).toFixed(2)}%)</span>}
      </div>
      <div className="whitespace-nowrap"><span className="text-muted">{t('Volume')}</span> <span className={`num ${tone}`}>{compact(bar.volume)}</span></div>
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
 * history  : closed positions of this pool [{ id, lo, hi, from, to, entry, exit, pnl, pnlPct, label }]
 *            (prices in the chart's unit, from/to in ms), drawn while `showHistory` is on;
 *            `onShowHistory(bool)` gets the top-bar toggle (no handler = no toggle); hovering a box
 *            shows its details, clicking it calls `onHistoryClick(id)`. Optional per item: fee, cost (USD),
 *            loEnd / hiEnd (the range at the close, when the chart's unit drifts from the pool's)
 */
export default function AdvancedChart({
  candles, tf, onTfChange = null, loading = false, error = null, onRetry = null, series = '',
  quote, drawKey = null, poolRef = null, usdRate = null, supply = null, title = null, height = 420,
  range = null, ranges = null, entry = null, exit = null, now = null, bep = null,
  history = null, showHistory = false, onShowHistory = null, onHistoryClick = null,
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
  const [pal, setPal] = useState(chartPalette);
  const [chartType, setChartType] = useState(readType);
  const [width, setWidth] = useState(0);
  const spanRef = useRef(null);
  const [autoScale, setAutoScaleState] = useState(true);          // span (ms) a range preset asked for, applied by the next fit
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
  const [menu, setMenu] = useState(null);     // open top-bar menu: 'tf' | 'type' | null
  const [drawing, setDrawing] = useState(null);
  const [note, setNote] = useState(null);       // null = closed, string = text being typed
  const [hover, setHover] = useState(null);     // data index under the crosshair, null = latest
  const [histHover, setHistHover] = useState(null); // id of the LP history box under the pointer
  const histRef = useRef(null);                 // { list, first, anchor, sc } of the boxes drawn, null = none
  const histClickRef = useRef(onHistoryClick);
  histClickRef.current = onHistoryClick;
  const [tick, setTick] = useState(0);          // bumps when the series in the chart changes
  const indRef = useRef(null);
  const closeInd = useCallback(() => setIndOpen(false), []);
  useDismiss(indOpen, indRef, closeInd);
  const menuRef = useRef(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(!!menu, menuRef, closeMenu);

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
    const mo = new MutationObserver(() => { const p = chartPalette(); PAL = p; setPal(p); });
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
    const chart = init(el, { styles: buildStyles(pal), layout: { barSpaceLimit: { min: MIN_BAR, max: 50 } } });
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
      setHistHover(c.paneId === 'candle_pane' ? histAt(chart, histRef.current, c.x, c.y) : null);
    };
    chart.subscribeAction('onCrosshairChange', onCross);
    setReady(true);
    return () => {
      chart.unsubscribeAction('onCrosshairChange', onCross);
      dispose(el); chartRef.current = null; setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { PAL = pal; chartRef.current?.chart.setStyles(buildStyles(pal)); }, [pal]);
  useEffect(() => {
    if (!ready) return;
    chartRef.current?.chart.setStyles({ candle: { type: chartType } });
    try { localStorage.setItem(TYPE_KEY, chartType); } catch { /* ignore */ }
  }, [ready, chartType]);

  // Price-axis mode. The gaps keep the candles clear of the legend at the top and of the
  // volume bars at the foot.
  // klinecharts adds a gap as a share of the price range, so the legend's pixels are turned into
  // the share that leaves them free on this pane's height.
  const volOn = activeInds.has('VOL');
  const paneH = full ? 0 : height;
  useEffect(() => {
    const chart = chartRef.current?.chart;
    if (!ready || !chart) return;
    const h = chart.getSize('candle_pane', 'main')?.height || paneH || 400;
    const bottom = volOn ? 0.3 : 0.08;
    const f = Math.min(0.4, (LEGEND_PX + 22) / h);
    chart.overrideYAxis({ paneId: 'candle_pane', name: axisName, scrollZoomEnabled: false, gap: { top: (f * (1 + bottom)) / (1 - f), bottom } });
    // the price axis still stretches (handled above): keep its resize cursor
    const pane = chart.getDrawPaneById?.('candle_pane');
    for (const a of candleYAxes(chart)) pane?.setAxisCursor?.(true, a.id);
    setAutoScale(chart, true); setAutoScaleState(true);
  }, [ready, axisName, volOn, paneH, width, activeInds]);

  // Initial / reset zoom: show the position's whole life (entry candle with some margin) or the
  // last ~90 bars, with the last candle a few bars in from the price axis.
  const fitView = useCallback(() => {
    const r = chartRef.current;
    const w = r?.chart.getSize('candle_pane', 'main')?.width;
    const list = r?.chart.getDataList() || [];
    const n = list.length;
    if (!r || !w || !n) return;
    const span = spanRef.current;
    spanRef.current = null;
    const startIdx = entry?.t ? list.findIndex((d) => d.timestamp >= entry.t) : -1;
    const bars = startIdx >= 0 ? n - startIdx : 0;
    const visible = span ? Math.min(n, Math.ceil(span / (TF_MS[tfRef.current] || 3600e3)))
      : Math.min(n, Math.max(90, Math.round(bars * 1.15) + 10));
    const space = Math.max(MIN_BAR, Math.min(1.5, (w * 0.92) / n), Math.min(18, (w - 60) / (visible + 1)));
    r.chart.setBarSpace(space);
    r.chart.setOffsetRightDistance(Math.max(40, space * 4));
    r.chart.scrollToRealTime();
    setAutoScale(r.chart, true); setAutoScaleState(true);
  }, [entry?.t]);

  // Vertical moves like TradingView / GMGN: dragging the price pane moves the candles up and down
  // (sideways is still klinecharts' own scroll), dragging the price axis stretches or squeezes
  // them, and a double click on the price axis (or the "manual scale" button) puts autoscale back.
  // A drag turns autoscale off once it has moved a few pixels vertically. Mouse and pen only: a
  // finger keeps scrolling the page.
  useEffect(() => {
    const el = box.current;
    if (!ready || !el) return undefined;
    const sync = () => { const c = chartRef.current?.chart; if (c) setAutoScaleState(isAutoScale(c)); };
    const inside = (b, x, y) => b && x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;
    const onDown = (e) => {
      const chart = chartRef.current?.chart;
      if (!chart || e.button !== 0 || e.pointerType === 'touch' || pendingRef.current) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const main = chart.getSize('candle_pane', 'main');
      const mode = inside(main, x, y) ? 'pan' : inside(chart.getSize('candle_pane', 'yAxis'), x, y) ? 'scale' : null;
      if (!mode) return;
      const y0 = e.clientY;
      let bases = null;
      const onMove = (m) => {
        const dy = m.clientY - y0;
        // an overlay being dragged moves itself, not the axis
        if (draggingRef.current) return;
        if (!bases) {
          if (Math.abs(dy) < 4) return;
          setAutoScale(chart, false);
          bases = candleYAxes(chart).map((a) => [a, { ...a.getRange() }]);
          setAutoScaleState(false);
        }
        const h = main.height || 1;
        for (const [a, r] of bases) {
          if (mode === 'pan') {
            const shift = (dy / h) * r.realRange;
            setRealRange(a, r, r.realFrom + shift, r.realTo + shift);
          } else {
            // down squeezes the candles (wider range), up stretches them, around the middle
            const span = r.realRange * Math.exp(dy / 180), mid = (r.realFrom + r.realTo) / 2;
            setRealRange(a, r, mid - span / 2, mid + span / 2);
          }
        }
        relayout(chart);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        sync();
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    };
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('dblclick', sync);
    return () => { el.removeEventListener('pointerdown', onDown, true); el.removeEventListener('dblclick', sync); };
  }, [ready]);
  const resetScale = () => { const c = chartRef.current?.chart; if (c) { setAutoScale(c, true); setAutoScaleState(true); } };

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
      setHistHover(null);
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
      const spec = name === 'VOL' ? { name: 'volOverlay', paneId: 'candle_pane' }
        : INDICATOR_OVERLAY.has(name) ? { name, paneId: 'candle_pane' } : name;
      // isStack: the price pane holds VOL, MA, EMA… together (without it each one replaces the last)
      const id = r.chart.createIndicator(spec, typeof spec === 'object');
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

  // LP history: one box per closed position, rebuilt when the list, the toggle or the series changes.
  const histList = useMemo(() => (history || []).filter((h) => h.lo > 0 && h.hi > 0 && h.to > 0), [history]);
  const histKey = useMemo(() => histList.map((h) => `${h.id}:${h.lo}:${h.hi}:${h.loEnd}:${h.hiEnd}:${h.from}:${h.to}:${h.entry}:${h.exit}:${h.pnl}`).join('|'), [histList]);
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || first == null) return;
    for (const o of r.chart.getOverlays({ groupId: HIST_GROUP })) r.chart.removeOverlay({ id: o.id });
    if (!showHistory || loading) return;
    const specs = [];
    for (const h of histList) {
      const span = histSpan(h, first, anchor);
      if (!span) continue;                         // closed before the first candle loaded
      const { from, to } = span;
      const color = h.pnl > 0 ? UP : h.pnl < 0 ? DOWN : pal.muted;
      const pnl = h.pnl == null ? null : fmtUsd(h.pnl);
      const life = h.from > 0 ? ` · ${fmtAge((h.to - h.from) / 3600e3)}` : '';
      const tag = pnl == null ? `${h.label}${life}` : `${h.label} ${pnl}${h.pnlPct != null ? ` · ${fmtPct(h.pnlPct, 1)}` : ''}${life}`;
      specs.push({
        name: 'lpHist', groupId: HIST_GROUP, lock: true,
        points: [
          { timestamp: from, value: h.hi * sc }, { timestamp: to, value: (h.loEnd ?? h.lo) * sc },
          { timestamp: from, value: (h.entry > 0 ? h.entry : h.hi) * sc }, { timestamp: to, value: (h.exit > 0 ? h.exit : h.lo) * sc },
          { timestamp: to, value: (h.hiEnd ?? h.hi) * sc }, { timestamp: from, value: h.lo * sc },
        ],
        extendData: { color, label: tag, short: pnl, entry: h.entry > 0, exit: h.exit > 0, clipped: !(h.from >= first) },
      });
    }
    if (specs.length) r.chart.createOverlay(specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, tick, first, anchor, histKey, showHistory, pal, sc]);
  histRef.current = showHistory && !loading && first != null ? { list: histList, first, anchor, sc } : null;
  // a click (not a drag) on a history box picks that position
  useEffect(() => {
    const el = box.current;
    if (!ready || !el) return undefined;
    let down = null;
    const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
    const onClick = (e) => {
      const chart = chartRef.current?.chart;
      if (!chart || !histClickRef.current || pendingRef.current || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const rect = el.getBoundingClientRect(), main = chart.getSize('candle_pane', 'main');
      if (!main) return;
      const id = histAt(chart, histRef.current, e.clientX - rect.left - main.left, e.clientY - rect.top - main.top);
      if (id != null) histClickRef.current(id);
    };
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('click', onClick);
    return () => { el.removeEventListener('pointerdown', onDown, true); el.removeEventListener('click', onClick); };
  }, [ready]);
  const histItem = histHover != null && histRef.current ? histList.find((h) => h.id === histHover) || null : null;
  const histSum = useMemo(() => {
    const done = histList.filter((h) => h.pnl != null);
    return { n: histList.length, wins: done.filter((h) => h.pnl > 0).length, pnl: done.reduce((a, h) => a + h.pnl, 0) };
  }, [histList]);

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

  // Range preset: the coarsest timeframe with RANGE_BARS bars over the span (when this chart can
  // switch timeframe), zoomed to the span once its candles are in.
  const showRange = (ms) => {
    spanRef.current = ms;
    const ids = TIMEFRAMES.map(([id]) => id);
    const want = [...ids].reverse().find((id) => ms / TF_MS[id] >= RANGE_BARS) || ids[0];
    if (onTfChange && want !== tf) pickTf(want); else fitView();
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
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { chartRef.current?.chart.resize(); setWidth(wrap.current?.clientWidth || 0); });
    });
    ro.observe(box.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [ready]);
  useEffect(() => {
    if (!full) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [full]);

  const list = chartRef.current?.chart.getDataList() || [];
  const legendIdx = hover != null && hover >= 0 && hover < list.length ? hover : list.length - 1;
  void tick;   // the legend reads the chart's list, which `tick` / data changes refresh
  // a Monitor card or a phone: smaller rail, timeframes in a menu, no clock
  const wide = width === 0 || width >= 640;
  const tfLabel = (TIMEFRAMES.find(([id]) => id === tf) || [tf, tf])[1];
  const typeNow = CHART_TYPES.find(([id]) => id === chartType) || CHART_TYPES[0];
  const TypeIcon = typeNow[1];
  const sep = <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
  const railBtn = wide ? RAIL_BTN : BTN;
  const icon = wide ? ICON : 'size-4';
  const on = 'bg-accent/15 text-accent';
  const menuItem = (active) => `flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-xs transition-colors hover:bg-default hover:text-foreground ${active ? 'bg-accent/10 text-accent' : 'text-muted'}`;

  return (
    <div ref={wrap} tabIndex={-1} onKeyDown={onKeyDown}
      className={`outline-none ${full ? 'fixed inset-0 z-[60] flex flex-col bg-surface p-3' : ''}`}>
      {/* top bar: timeframe, chart type, indicators, Price / MCap — utilities on the right */}
      <div ref={menuRef} className="mb-1 flex min-h-8 flex-wrap items-center gap-0.5 border-b border-border pb-1">
        {full && title && <span className="mr-2 text-sm font-semibold">{title}</span>}
        {onTfChange && (wide ? (
          <div className="flex items-center" role="radiogroup" aria-label={t('Rentang lilin')}>
            {TIMEFRAMES.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={tf === id} onClick={() => tf !== id && pickTf(id)}
                className={`${TOP_BTN} ${tf === id ? '!bg-accent/15 !text-accent' : ''}`}>{label}</button>
            ))}
          </div>
        ) : (
          <div className="relative">
            <button type="button" aria-haspopup="menu" aria-expanded={menu === 'tf'} aria-label={t('Rentang lilin')} onClick={() => setMenu((m) => (m === 'tf' ? null : 'tf'))}
              className={`${TOP_BTN} text-foreground`}>{tfLabel}<ChevronDown className="size-3 text-muted" /></button>
            {menu === 'tf' && (
              <div role="menu" className="absolute top-full left-0 z-30 mt-1 w-24 rounded-lg border border-border bg-surface p-1 shadow-lg">
                {TIMEFRAMES.map(([id, label]) => (
                  <button key={id} type="button" role="menuitemradio" aria-checked={tf === id} onClick={() => { setMenu(null); if (tf !== id) pickTf(id); }}
                    className={menuItem(tf === id)}>{label}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        {onTfChange && sep}
        <div className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={menu === 'type'} title={t(typeNow[2])} aria-label={t('Jenis grafik')}
            onClick={() => setMenu((m) => (m === 'type' ? null : 'type'))} className={TOP_BTN}><TypeIcon className="size-[17px]" /></button>
          {menu === 'type' && (
            <div role="menu" className="absolute top-full left-0 z-30 mt-1 w-44 rounded-lg border border-border bg-surface p-1 shadow-lg">
              {CHART_TYPES.map(([id, I, label]) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={chartType === id} onClick={() => { setChartType(id); setMenu(null); }}
                  className={menuItem(chartType === id)}><I className={`size-4 ${id === 'candle_stroke' ? 'opacity-60' : ''}`} />{t(label)}</button>
              ))}
            </div>
          )}
        </div>
        {sep}
        <div ref={indRef} className="relative">
          <button type="button" aria-expanded={indOpen} onClick={() => setIndOpen((v) => !v)} className={`${TOP_BTN} ${indOpen ? 'text-foreground' : ''}`}>
            <SquareFunction className="size-[17px]" /><span className={wide ? '' : 'sr-only'}>{t('Indikator')}</span>
            {activeInds.size > 0 && <span className="num rounded bg-accent/15 px-1 text-[0.6875rem] text-accent">{activeInds.size}</span>}
          </button>
          {indOpen && (
            <div className="absolute top-full left-0 z-30 mt-1 w-72 max-w-[85vw] rounded-lg border border-border bg-surface p-2.5 shadow-lg">
              {INDICATOR_GROUPS.map(([label, , names]) => (
                <div key={label} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[0.625rem] font-semibold tracking-wide text-muted uppercase">{t(label)}</div>
                  <div className="flex flex-wrap gap-1">
                    {names.map((name) => {
                      const sel = activeInds.has(name);
                      return <button key={name} type="button" aria-pressed={sel} onClick={() => toggleIndicator(name, !sel)}
                        className={`rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium transition-colors ${sel ? 'border-accent/60 bg-accent/10 text-foreground' : 'border-border text-muted hover:text-foreground'}`}>{name}</button>;
                    })}
                  </div>
                </div>
              ))}
              <p className="mt-2 text-[0.625rem] text-muted">{t('Berlaku untuk semua grafik.')}</p>
            </div>
          )}
        </div>
        {onShowHistory && histSum.n > 0 && <>
          {sep}
          <button type="button" aria-pressed={showHistory} onClick={() => onShowHistory(!showHistory)}
            title={t('Riwayat LP: {n} posisi ditutup · {w} untung · PnL {v}', { n: histSum.n, w: histSum.wins, v: fmtUsd(histSum.pnl) })}
            className={`${TOP_BTN} ${showHistory ? '!bg-accent/15 !text-accent' : ''}`}>
            <History className="size-[17px]" /><span className={wide ? '' : 'sr-only'}>{t('Riwayat LP')}</span>
            {showHistory && <span className={`num text-[0.6875rem] ${histSum.pnl >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{fmtUsd(histSum.pnl)}</span>}
          </button>
        </>}
        {mcMul > 0 && <>
          {sep}
          <div className="flex items-center text-[0.8125rem] font-medium" role="radiogroup" aria-label={t('Tampilan grafik')}>
            <button type="button" role="radio" aria-checked={!mc} onClick={() => setMetric('price')} className={`rounded px-1 py-1 transition-colors ${!mc ? 'text-foreground' : 'text-muted hover:text-foreground'}`}>{t('Harga')}</button>
            <span className="text-muted/60">/</span>
            <button type="button" role="radio" aria-checked={mc} onClick={() => setMetric('mc')} className={`rounded px-1 py-1 transition-colors ${mc ? 'text-foreground' : 'text-muted hover:text-foreground'}`}>MCap</button>
          </div>
        </>}
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" title={`${t('Kembali ke harga terbaru')} (Alt+R)`} aria-label={t('Kembali ke harga terbaru')} onClick={fitView} className={BTN}><RotateCcw className="size-4" /></button>
          <button type="button" title={t('Simpan gambar grafik')} aria-label={t('Simpan gambar grafik')} onClick={screenshot} className={BTN}><Camera className="size-4" /></button>
          <button type="button" title={full ? t('Keluar layar penuh') : t('Layar penuh')} aria-label={full ? t('Keluar layar penuh') : t('Layar penuh')} onClick={() => setFull((v) => !v)} className={BTN}>
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </span>
      </div>

      <div className={`flex gap-1 ${full ? 'min-h-0 flex-1' : ''}`}>
        {/* left rail: crosshair, drawing groups, then magnet / lock / hide / clear */}
        <div className={`flex shrink-0 flex-col items-center self-start border-r border-border pr-1 ${wide ? 'gap-1' : 'gap-0.5'}`} role="toolbar" aria-orientation="vertical" aria-label={t('Alat gambar')}
          title={t('Gambar tersimpan per token dan muncul di semua grafik & timeframe · Klik kanan pada gambar untuk menghapusnya · Delete menghapus gambar terpilih.')}>
          <button type="button" title={t('Kursor')} aria-label={t('Kursor')} aria-pressed={!drawing} onClick={cancelDraw}
            className={`${railBtn} ${!drawing ? on : ''}`}><Crosshair className={icon} /></button>
          {TOOL_GROUPS.map((g) => <ToolGroup key={g.id} group={g} onDraw={draw} t={t} active={drawing} wide={wide} />)}
          <span className="my-0.5 h-px w-5 bg-border" />
          <button type="button" title={t('Magnet ke harga OHLC')} aria-label={t('Magnet ke harga OHLC')} aria-pressed={magnet} onClick={toggleMagnet}
            className={`${railBtn} ${magnet ? on : ''}`}><Magnet className={icon} /></button>
          <button type="button" title={locked ? t('Buka kunci gambar') : t('Kunci gambar')} aria-label={locked ? t('Buka kunci gambar') : t('Kunci gambar')} aria-pressed={locked} onClick={toggleLock}
            className={`${railBtn} ${locked ? on : ''}`}>{locked ? <Lock className={icon} /> : <LockOpen className={icon} />}</button>
          <button type="button" title={hidden ? t('Tampilkan gambar') : t('Sembunyikan gambar')} aria-label={hidden ? t('Tampilkan gambar') : t('Sembunyikan gambar')} aria-pressed={hidden} onClick={toggleHidden}
            className={`${railBtn} ${hidden ? on : ''}`}>{hidden ? <EyeOff className={icon} /> : <Eye className={icon} />}</button>
          <button type="button" title={t('Hapus semua gambar')} aria-label={t('Hapus semua gambar')} onClick={clearAll}
            className={`${railBtn} hover:!bg-danger/10 hover:!text-danger`}><Trash2 className={icon} /></button>
        </div>
        <div className={`relative flex min-w-0 flex-1 flex-col ${full ? 'min-h-0' : ''}`}>
          <div ref={box} onPointerLeave={() => setHover(null)} style={full ? undefined : { height }} className={`w-full ${full ? 'min-h-0 flex-1' : ''}`} />
          {/* brand watermark behind the legend, like GMGN's */}
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center pr-16 font-black tracking-tight text-foreground/[0.045] select-none"
            style={{ fontSize: Math.max(28, Math.min(110, (width || 600) * 0.11)) }}>QUIVER</div>
          {!loading && <Legend bar={list[legendIdx]} prev={list[legendIdx - 1]} label={title || quote} tfLabel={tfLabel} mc={mc} t={t} wide={wide} />}
          {histItem && <HistCard h={histItem} chart={chartRef.current?.chart} clickable={!!onHistoryClick} t={t} />}
          {/* veil while another timeframe loads, or the fetch failed */}
          {(loading || error) && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/60 backdrop-blur-[1px]">
              {error && !loading ? (
                <div className="flex max-w-xs flex-col items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-center text-xs shadow">
                  <span className="font-medium">{t('Grafik belum tersedia')}</span>
                  <span className="text-muted">{t(error)}</span>
                  {onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 font-medium hover:bg-default"><RefreshCw className="size-3.5" />{t('Coba lagi')}</button>}
                </div>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow">
                  <Loader2 className="size-3.5 animate-spin" />{t('Memuat lilin {tf}…', { tf: tfLabel })}
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
            <form onSubmit={submitNote} className="absolute top-12 left-2 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder={t('Teks catatan…')} aria-label={t('Teks catatan…')}
                onKeyDown={(e) => e.key === 'Escape' && setNote(null)}
                className="h-7 w-44 rounded border border-border bg-transparent px-2 text-xs outline-none focus:border-accent" />
              <button type="submit" className="h-7 rounded bg-accent px-2.5 text-xs font-medium text-accent-foreground">{t('Pasang')}</button>
            </form>
          )}
          {/* bottom bar: range presets · clock · price scale */}
          <div className="mt-0.5 flex min-h-7 items-center gap-0.5 border-t border-border pt-0.5 text-[0.8125rem]">
            {RANGES.map(([label, ms]) => (
              <button key={label} type="button" onClick={() => showRange(ms)} className={`${TOP_BTN} ${wide ? '' : '!px-1 text-xs'}`}>{label}</button>
            ))}
            <button type="button" title={t('Semua lilin')} aria-label={t('Semua lilin')} onClick={() => { spanRef.current = Infinity; fitView(); }} className={`${TOP_BTN} ${wide ? '' : '!px-1'}`}>
              <CalendarRange className="size-4" />
            </button>
            <span className="ml-auto flex items-center gap-1">
              {wide && <><Clock />{sep}</>}
              {!autoScale && (
                <button type="button" onClick={resetScale} title={t('Skala harga digeser manual — klik untuk kembali otomatis (atau klik dua kali kolom harga)')}
                  className="rounded-md bg-warning/15 px-1.5 py-1 text-[0.75rem] font-medium text-warning transition-colors hover:bg-warning/25">{t('Skala manual')}</button>
              )}
              <span className="flex items-center" role="radiogroup" aria-label={t('Skala harga')}>
                {AXES.map(([id, label]) => {
                  // 'auto' lit, and the scale it resolved to in plain foreground
                  const sel = axis === id;
                  return <button key={id} type="button" role="radio" aria-checked={sel} onClick={() => setAxis(id)}
                    className={`rounded-md px-1.5 py-1 font-medium transition-colors ${sel ? 'bg-accent/15 text-accent' : axis === 'auto' && id === axisName ? 'text-foreground' : 'text-muted hover:text-foreground'}`}>{label}</button>;
                })}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
