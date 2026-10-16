// Advanced chart with KLineChart, laid out like a trading terminal: timeframe switcher,
// grouped drawing toolbar (lines, fibonacci, shapes, notes, measure), magnet / lock / hide,
// price-axis mode (linear / log / percent), an indicator menu, screenshot and fullscreen.
// Active drawings & indicators are stored on the server per pool (not localStorage) via
// /api/chart/overlays, so they are still there when the page is opened again from any device.
import { useEffect, useMemo, useRef, useState } from 'react';
import { init, dispose, registerOverlay, registerYAxis } from 'klinecharts';
import {
  TrendingUp, Minus, Ruler, Brush, GitCommitHorizontal, Square, Trash2, Magnet, Lock, LockOpen, Eye, EyeOff,
  Maximize2, Minimize2, Camera, ChevronDown, Type, Tag, MoveUpRight, Slash, ArrowRightToLine, SeparatorVertical,
  Equal, Rows3, RotateCcw, Activity, Crosshair,
} from 'lucide-react';
import { get, post } from '../api';
import { ask } from './ui';
import { useI18n } from '../i18n';
import { palette, withAlpha, cssColor } from './CandleChart';

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
        styles: { color: line, size: 10, family: 'ui-sans-serif, system-ui, sans-serif', paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, backgroundColor: 'transparent' } });
    }
    return figures;
  },
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

// The built-in log axis treats log10(price) < 0 as a negative price, which garbles every token
// priced below 1 (all of ours). This one maps through log10 for positive prices only.
const log10 = (v) => (v > 0 ? Math.log10(v) : 0);
registerYAxis({
  name: 'logPrice',
  minSpan: (precision) => 0.05 * 10 ** -precision,
  valueToRealValue: log10,
  realValueToValue: (r) => 10 ** r,
  realValueToDisplayValue: (r) => 10 ** r,
  displayValueToRealValue: log10,
  createRange: ({ defaultRange: { from, to, range } }) => {
    const realFrom = log10(from), realTo = log10(to);
    return { from, to, range, realFrom, realTo, realRange: realTo - realFrom, displayFrom: from, displayTo: to, displayRange: range };
  },
});

const PERIOD_MS = { minute: 60000, hour: 3600000, day: 86400000 };
const fmtSpan = (ms) => {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
};

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
    const prec = chart.getSymbol()?.pricePrecision ?? 4;
    const period = chart.getPeriod();
    const ms = (PERIOD_MS[period?.type] || 60000) * (period?.span || 1);
    const bars = Math.round(((p2.timestamp ?? 0) - (p1.timestamp ?? 0)) / ms);
    const sign = up ? '+' : '−';
    const text = `${sign}${Math.abs(diff).toFixed(prec)}  (${sign}${Math.abs((diff / p1.value) * 100).toFixed(2)}%)  ·  ${Math.abs(bars)} bar  ·  ${fmtSpan((p2.timestamp ?? 0) - (p1.timestamp ?? 0))}`;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    return [
      { type: 'rect', attrs: { x: x1, y: y1, width: x2 - x1, height: Math.max(1, y2 - y1) }, styles: { style: 'fill', color: withAlpha(color, 0.12) } },
      { type: 'line', attrs: { coordinates: [a, b] }, styles: { style: 'dashed', color, size: 1 } },
      { type: 'text', ignoreEvent: true, attrs: { x: (x1 + x2) / 2, y: up ? y1 - 6 : y2 + 6, text, align: 'center', baseline: up ? 'bottom' : 'top' },
        styles: { style: 'stroke_fill', color: '#ffffff', backgroundColor: color, borderColor: color, size: 11, family: 'ui-sans-serif, system-ui, sans-serif', paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3, borderRadius: 4 } },
    ];
  },
});

export const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1H'], ['4h', '4H'], ['1d', '1D']];

const PERIOD = {
  '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 }, '4h': { type: 'hour', span: 4 }, '1d': { type: 'day', span: 1 },
};

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
const DEFAULT_INDICATORS = ['VOL'];

const AXES = [['normal', 'Lin'], ['logPrice', 'Log'], ['percentage', '%']];

function buildStyles(pal) {
  return {
    grid: { horizontal: { color: withAlpha(pal.border, 0.6) }, vertical: { show: false } },
    candle: {
      bar: {
        upColor: pal.up, downColor: pal.down, noChangeColor: pal.muted,
        upBorderColor: pal.up, downBorderColor: pal.down, noChangeBorderColor: pal.muted,
        upWickColor: pal.up, downWickColor: pal.down, noChangeWickColor: pal.muted,
      },
      // The built-in OHLC legend sticks to the top-left corner and collides with the
      // highest price marker if the highest candle is there. It was turned into
      // a box that follows the cursor — it appears while reading, and disappears when not.
      tooltip: {
        showRule: 'follow_cross', showType: 'rect',
        rect: { position: 'pointer', color: withAlpha(pal.dark ? '#000000' : '#ffffff', 0.85), borderColor: pal.border, borderRadius: 6, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8 },
        title: { color: pal.text },
        legend: { color: pal.text },
      },
      priceMark: { high: { color: pal.text }, low: { color: pal.text } },
    },
    xAxis: { axisLine: { color: pal.border }, tickText: { color: pal.text } },
    yAxis: { axisLine: { color: pal.border }, tickText: { color: pal.text } },
    crosshair: {
      horizontal: { line: { color: withAlpha(pal.muted, 0.7) } },
      vertical: { line: { color: withAlpha(pal.muted, 0.7) } },
    },
    overlay: { line: { color: pal.accent }, point: { color: pal.accent, borderColor: pal.accent } },
    separator: { color: pal.border },
  };
}

// Fixed price precision (not a custom per-point format like lightweight-charts):
// tuned from the candle price range so trivial tokens (0.00000032) stay readable.
function precisionFor(data) {
  const prices = data.flatMap((d) => [d.open, d.high, d.low, d.close]).filter((p) => p > 0);
  if (!prices.length) return 4;
  const min = Math.min(...prices);
  if (min >= 1) return 2;
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(min)) - 1);
  return Math.min(12, leadingZeros + 4);
}

// KLineChart v10 DataLoader: once installed, it pulls initial data via getBars then
// subscribes to updates via subscribeBar. We push the latest candle each time polling
// brings new data via push(); the initial history is read from dataRef at that moment.
function makeLoader(dataRef) {
  let sub = null;
  return {
    getBars({ callback }) { callback(dataRef.current, false); },
    subscribeBar({ callback }) { sub = callback; },
    unsubscribeBar() { sub = null; },
    push(bar) { sub?.(bar); },
  };
}

const overlayPayload = (o) => ({ name: o.name, points: o.points, styles: o.styles, mode: o.mode, lock: o.lock, visible: o.visible, extendData: o.extendData });
// LP position context overlays (range band, entry/exit/BEP lines) use a fixed groupId
// 'lp' — distinguished from the user's own drawings so "delete all" and
// saving to the server do not remove/save them (these overlays are derived from
// position props, rebuilt each time props change, not the user's hand drawings).
const LP_GROUP = 'lp';
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
          className={`${BTN} ${active === name ? 'bg-default text-foreground' : ''}`}><Icon className="size-4" /></button>
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

/**
 * candles  : [{ t(ms), o, h, l, c, v }] ascending
 * tf       : '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
 * onTfChange : (tf) => void — shows the timeframe switcher; the parent refetches the candles
 *            and remounts the chart (key includes tf)
 * quote    : quote asset symbol (the ticker in the legend)
 * poolRef  : storage key of drawings/indicators on the server — null = not stored
 * range    : { lo, hi } price range of the LP position, or null
 * ranges   : [{ id, lo, hi, color, label, selected, from(ms), to(ms) }] — many bands
 *            at once (all open positions in the same pool). If given, `range`
 *            is ignored: the `selected` band represents the position being viewed.
 * entry    : { t(ms), p }  exit : { t(ms), p }  now : current price — all optional,
 *            used to draw the position context (not user drawings)
 * title    : short label shown in the fullscreen header (pair name)
 */
export default function AdvancedChart({ candles, tf, onTfChange = null, quote, poolRef, title = null, height = 420, range = null, ranges = null, entry = null, exit = null, now = null, bep = null }) {
  const { t } = useI18n();
  const wrap = useRef(null);
  const box = useRef(null);
  const chartRef = useRef(null);
  const dataRef = useRef([]);
  const lastTsRef = useRef(null);
  const saveTimerRef = useRef(null);
  const pendingRef = useRef(null);       // overlay id being drawn right now (Esc cancels it)
  const selectedRef = useRef(null);      // overlay id last clicked (Delete removes it)
  const magnetRef = useRef(false);
  const fittedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [pal, setPal] = useState(palette);
  const [activeInds, setActiveInds] = useState(new Set());
  const [axis, setAxis] = useState('auto');
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [full, setFull] = useState(false);
  const [indOpen, setIndOpen] = useState(false);
  const [drawing, setDrawing] = useState(null);
  const [note, setNote] = useState(null);       // null = closed, string = text being typed
  const indRef = useRef(null);
  useDismiss(indOpen, indRef, () => setIndOpen(false));

  const data = useMemo(() => (candles || [])
    .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
    .map((c) => ({ timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0 })),
  [candles]);
  dataRef.current = data;
  // Wide price swings (memecoins) are unreadable on a linear axis, so default to log past 4x.
  const autoLog = useMemo(() => {
    if (!data.length) return false;
    let lo = Infinity, hi = 0;
    for (const d of data) { lo = Math.min(lo, d.low); hi = Math.max(hi, d.high); }
    return hi / lo > 4;
  }, [data]);
  const axisName = axis === 'auto' ? (autoLog ? 'logPrice' : 'normal') : axis;

  useEffect(() => {
    const mo = new MutationObserver(() => { const p = palette(); PAL = p; setPal(p); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const scheduleSave = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const r = chartRef.current;
      if (!r || !poolRef) return;
      const overlays = userOverlays(r.chart).map(overlayPayload);
      post('/api/chart/overlays', { pool: poolRef, data: { overlays, indicators: Object.keys(r.indicatorIds) } });
    }, 700);
  };
  const withHooks = (o) => ({
    ...o,
    onDrawEnd: () => { pendingRef.current = null; setDrawing(null); scheduleSave(); },
    onPressedMoveEnd: scheduleSave,
    onRemoved: scheduleSave,
    onSelected: ({ overlay }) => { selectedRef.current = overlay.id; },
    onDeselected: () => { selectedRef.current = null; },
    // right click on a drawing removes it
    onRightClick: ({ overlay }) => { chartRef.current?.chart.removeOverlay({ id: overlay.id }); return true; },
  });

  // Create the chart once per mount (the parent remounts via `key={tf}` when the candle range changes).
  useEffect(() => {
    const el = box.current;
    PAL = pal;
    const chart = init(el, { styles: buildStyles(pal) });
    if (!chart) return;
    const loader = makeLoader(dataRef);
    chartRef.current = { chart, loader, indicatorIds: {} };
    chart.setSymbol({ ticker: quote || 'PRICE', pricePrecision: precisionFor(dataRef.current), volumePrecision: 2 });
    chart.setPeriod(PERIOD[tf] || PERIOD['1h']);
    chart.setDataLoader(loader);
    setReady(true);
    return () => { dispose(el); chartRef.current = null; setReady(false); clearTimeout(saveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { PAL = pal; chartRef.current?.chart.setStyles(buildStyles(pal)); }, [pal]);

  // Price-axis mode.
  useEffect(() => {
    if (!ready) return;
    chartRef.current?.chart.overrideYAxis({ paneId: 'candle_pane', name: axisName });
  }, [ready, axisName]);

  // Load stored drawings & indicators once the chart is ready.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const res = poolRef ? await get(`/api/chart/overlays?pool=${encodeURIComponent(poolRef)}`) : null;
      if (cancelled) return;
      const r = chartRef.current;
      if (!r) return;
      const saved = res?.data;
      if (saved?.overlays?.length) r.chart.createOverlay(saved.overlays.map((o) => withHooks(o)));
      const inds = saved?.indicators?.length ? saved.indicators : DEFAULT_INDICATORS;
      for (const name of inds) {
        if (!INDICATOR_GROUPS.some(([, , list]) => list.includes(name))) continue;
        const id = r.chart.createIndicator(INDICATOR_OVERLAY.has(name) ? { name, paneId: 'candle_pane' } : name, false);
        if (id) { r.indicatorIds[name] = id; slimPane(r.chart, id, name); }
      }
      setActiveInds(new Set(Object.keys(r.indicatorIds)));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, poolRef]);

  // New candles from polling: push through the DataLoader subscription, not reset the data
  // (a reset would replay the user's zoom/pan).
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || !data.length) return;
    const last = data[data.length - 1];
    if (lastTsRef.current == null) { lastTsRef.current = last.timestamp; return; }
    if (last.timestamp >= lastTsRef.current) { r.loader.push(last); lastTsRef.current = last.timestamp; }
  }, [data, ready]);

  // Initial zoom: show the position's whole life (entry candle with some margin) instead of the
  // library default of a few dozen wide bars, so the entry and the range band are in view.
  const fitView = () => {
    const r = chartRef.current;
    const w = r?.chart.getSize('candle_pane', 'main')?.width;
    const n = dataRef.current.length;
    if (!r || !w || !n) return;
    const startIdx = entry?.t ? dataRef.current.findIndex((d) => d.timestamp >= entry.t) : -1;
    const bars = startIdx >= 0 ? n - startIdx : 0;
    const visible = Math.min(n, Math.max(60, Math.round(bars * 1.2) + 8));
    r.chart.setBarSpace(Math.max(2, Math.min(24, w / (visible + 4))));
    r.chart.scrollToRealTime();
  };
  useEffect(() => {
    if (!ready || !data.length || fittedRef.current) return undefined;
    const id = setTimeout(() => { fitView(); fittedRef.current = true; }, 80);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, data.length]);

  // Range bands: filtered to those with sensible prices, then summarised into a single key
  // so the effect below is only rebuilt when the bands really change.
  const bandList = useMemo(() => (ranges || []).filter((b) => b.lo > 0 && b.hi > 0), [ranges]);
  const bandKey = useMemo(() => bandList.map((b) => `${b.id}:${b.lo}:${b.hi}:${b.from || 0}:${b.to || 0}:${b.color}:${b.selected ? 1 : 0}`).join('|'), [bandList]);

  // LP position context: range band + entry/exit/BEP/now lines. Rebuilt
  // (not moved) every time props change — cheap enough and avoids tracking an id per line.
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || !data.length) return;
    for (const o of r.chart.getOverlays({ groupId: LP_GROUP })) r.chart.removeOverlay({ id: o.id });
    const anchor = data[data.length - 1].timestamp;
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
      const from = b.from > 0 ? Math.max(b.from, data[0].timestamp) : data[0].timestamp;
      const to = b.to > 0 ? b.to : anchor;
      const color = b.color || pal.accent;
      const strong = b.selected || !anySel || bands.length === 1;
      specs.push({
        name: 'lpRange', groupId: LP_GROUP, lock: true,
        points: [{ timestamp: from, value: b.hi }, { timestamp: to, value: b.lo }],
        extendData: {
          fill: withAlpha(color, strong ? (pal.dark ? 0.13 : 0.1) : (pal.dark ? 0.06 : 0.05)),
          line: withAlpha(color, strong ? 0.6 : 0.3),
          open: !(b.to > 0), dim: !strong, label: bands.length > 1 ? b.label || null : null,
        },
      });
    }
    const priceLine = (p, color, ts) => specs.push({
      name: 'priceLine', groupId: LP_GROUP, lock: true,
      points: [{ timestamp: ts ?? anchor, value: p }], styles: { line: { color, style: 'dashed', size: 1 } },
    });
    if (entry?.p > 0) priceLine(entry.p, pal.muted);
    if (entry?.t >= data[0].timestamp) specs.push({ name: 'verticalStraightLine', groupId: LP_GROUP, lock: true, points: [{ timestamp: entry.t, value: entry.p || 0 }], styles: { line: { color: pal.accent, style: 'dashed', size: 1 } } });
    if (exit?.p > 0) priceLine(exit.p, pal.warning);
    if (bep > 0) priceLine(bep, pal.warning);
    if (now > 0) priceLine(now, withAlpha(pal.fg, 0.55));
    if (specs.length) r.chart.createOverlay(specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, data.length, bandKey, range?.lo, range?.hi, entry?.p, entry?.t, exit?.p, exit?.t, now, bep, pal]);

  // Applies one property (lock / visible / mode) to every drawing of the user.
  const setAll = (patch) => {
    const r = chartRef.current; if (!r) return;
    for (const o of userOverlays(r.chart)) r.chart.overrideOverlay({ id: o.id, ...patch });
  };
  const draw = (name, extra = {}) => {
    const r = chartRef.current; if (!r) return;
    // a new drawing on a locked / hidden chart would be invisible or immovable: unlock first
    if (locked) { setLocked(false); setAll({ lock: false }); }
    if (hidden) { setHidden(false); setAll({ visible: true }); }
    if (name === 'note') { setNote(''); return; }
    const id = r.chart.createOverlay(withHooks({ name, mode: magnetRef.current ? 'weak_magnet' : 'normal', ...extra }));
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
    if (pendingRef.current && r) r.chart.removeOverlay({ id: pendingRef.current });
    pendingRef.current = null; setDrawing(null);
  };
  const removeSelected = () => {
    const r = chartRef.current;
    if (selectedRef.current && r) { r.chart.removeOverlay({ id: selectedRef.current }); selectedRef.current = null; }
  };
  const clearAll = async () => {
    const ok = await ask({ title: t('Hapus semua gambar di grafik ini?'), confirm: t('Hapus'), danger: true });
    if (!ok) return;
    const r = chartRef.current; if (!r) return;
    for (const o of userOverlays(r.chart)) r.chart.removeOverlay({ id: o.id });
    scheduleSave();
  };
  const toggleMagnet = () => { const v = !magnet; magnetRef.current = v; setMagnet(v); setAll({ mode: v ? 'weak_magnet' : 'normal' }); };
  const toggleLock = () => { const v = !locked; setLocked(v); setAll({ lock: v }); };
  const toggleHidden = () => { const v = !hidden; setHidden(v); setAll({ visible: !v }); };
  const toggleIndicator = (name, on) => {
    const r = chartRef.current; if (!r) return;
    if (on) {
      const id = r.chart.createIndicator(INDICATOR_OVERLAY.has(name) ? { name, paneId: 'candle_pane' } : name, false);
      if (id) { r.indicatorIds[name] = id; slimPane(r.chart, id, name); }
    } else {
      const id = r.indicatorIds[name];
      if (id) r.chart.removeIndicator({ id });
      delete r.indicatorIds[name];
    }
    setActiveInds(new Set(Object.keys(r.indicatorIds)));
    scheduleSave();
  };
  const screenshot = () => {
    const r = chartRef.current; if (!r) return;
    const url = r.chart.getConvertPictureUrl(true, 'png', cssColor('--surface'));
    const a = document.createElement('a');
    a.href = url; a.download = `${title || quote || 'chart'}-${tf}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
    a.click();
  };
  const reset = () => { fitView(); };

  // Keyboard: Esc cancels the drawing in progress (or leaves fullscreen), Delete removes the
  // drawing that was clicked last.
  const onKeyDown = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') { if (pendingRef.current) cancelDraw(); else if (full) setFull(false); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedRef.current) { e.preventDefault(); removeSelected(); } }
  };

  // Fullscreen: the chart needs a resize once the container changed size.
  useEffect(() => {
    if (!ready) return undefined;
    const id = setTimeout(() => chartRef.current?.chart.resize(), 30);
    return () => clearTimeout(id);
  }, [full, ready]);
  useEffect(() => {
    if (!full) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [full]);

  const seg = (on) => `rounded px-1.5 py-1 text-[0.6875rem] font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`;

  return (
    <div ref={wrap} tabIndex={-1} onKeyDown={onKeyDown}
      className={`outline-none ${full ? 'fixed inset-0 z-[60] flex flex-col bg-surface p-3' : ''}`}>
      {/* top bar: timeframe, price axis, indicators, utilities */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {full && title && <span className="mr-1 text-sm font-semibold">{title}</span>}
        {onTfChange && (
          <div className="flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5" role="radiogroup" aria-label={t('Rentang lilin')}>
            {TIMEFRAMES.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={tf === id} onClick={() => tf !== id && onTfChange(id)} className={seg(tf === id)}>{label}</button>
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
              {INDICATOR_GROUPS.map(([label, , list]) => (
                <div key={label} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[0.625rem] font-semibold tracking-wide text-muted uppercase">{t(label)}</div>
                  <div className="flex flex-wrap gap-1">
                    {list.map((name) => {
                      const on = activeInds.has(name);
                      return <button key={name} type="button" aria-pressed={on} onClick={() => toggleIndicator(name, !on)}
                        className={`rounded border px-1.5 py-0.5 text-[0.6875rem] font-medium transition-colors ${on ? 'border-accent/60 bg-accent/10 text-foreground' : 'border-border text-muted hover:text-foreground'}`}>{name}</button>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5">
          <button type="button" title={t('Kembali ke harga terbaru')} aria-label={t('Kembali ke harga terbaru')} onClick={reset} className={BTN}><RotateCcw className="size-3.5" /></button>
          <button type="button" title={t('Simpan gambar grafik')} aria-label={t('Simpan gambar grafik')} onClick={screenshot} className={BTN}><Camera className="size-3.5" /></button>
          <button type="button" title={full ? t('Keluar layar penuh') : t('Layar penuh')} aria-label={full ? t('Keluar layar penuh') : t('Layar penuh')} onClick={() => setFull((v) => !v)} className={BTN}>
            {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </span>
      </div>

      <div className={`flex gap-1.5 ${full ? 'min-h-0 flex-1' : ''}`}>
        {/* left toolbar: drawing groups, then magnet / lock / hide / clear */}
        <div className="flex shrink-0 flex-col items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5" role="toolbar" aria-orientation="vertical" aria-label={t('Alat gambar')}>
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
        <div className="relative min-w-0 flex-1">
          <div ref={box} style={full ? { height: '100%' } : { height }} className="w-full" />
          {/* hint while a drawing is in progress / text prompt for the note tool */}
          {drawing && (
            <div className="pointer-events-none absolute bottom-8 left-2 z-10 flex items-center gap-1.5 rounded bg-surface/90 px-2 py-1 text-[0.6875rem] text-muted shadow">
              <Crosshair className="size-3.5 text-accent" />{t('Klik di grafik untuk menggambar · Esc untuk batal')}
            </div>
          )}
          {note != null && (
            <form onSubmit={submitNote} className="absolute top-2 left-2 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder={t('Teks catatan…')} aria-label={t('Teks catatan…')}
                onKeyDown={(e) => e.key === 'Escape' && setNote(null)}
                className="h-7 w-44 rounded border border-border bg-transparent px-2 text-xs outline-none focus:border-accent" />
              <button type="submit" className="h-7 rounded bg-accent px-2.5 text-xs font-medium text-accent-foreground">{t('Pasang')}</button>
            </form>
          )}
        </div>
      </div>
      <p className="mt-1 hidden text-[0.625rem] text-muted/80 sm:block">{t('Klik kanan pada gambar untuk menghapusnya · Delete menghapus gambar terpilih.')}</p>
    </div>
  );
}
