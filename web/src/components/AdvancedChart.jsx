// Advanced chart with KLineChart: drawing tools (trend line, fibonacci, etc.) and
// indicators (MA/EMA/BOLL/VOL/RSI/MACD) in TradingView style. Active drawings & indicators are
// stored on the server per pool (not localStorage) via /api/chart/overlays, so they
// are still there when the page is opened again from any device.
import { useEffect, useMemo, useRef, useState } from 'react';
import { init, dispose, registerOverlay } from 'klinecharts';
import { TrendingUp, Minus, Ruler, Brush, GitCommitHorizontal, Square, Trash2 } from 'lucide-react';
import { get, post } from '../api';
import { ask } from './ui';
import { useI18n } from '../i18n';
import { palette, withAlpha } from './CandleChart';

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

const PERIOD = {
  '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 }, '4h': { type: 'hour', span: 4 }, '1d': { type: 'day', span: 1 },
};

const DRAW_TOOLS = [
  ['segment', TrendingUp, 'Garis tren'],
  ['horizontalStraightLine', Minus, 'Garis horizontal'],
  ['priceChannelLine', GitCommitHorizontal, 'Kanal harga'],
  ['fibonacciLine', Ruler, 'Fibonacci retracement'],
  ['rect', Square, 'Kotak'],
  ['brush', Brush, 'Gambar bebas'],
];

const INDICATORS = [
  { name: 'MA', overlay: true }, { name: 'EMA', overlay: true }, { name: 'BOLL', overlay: true },
  { name: 'VOL', overlay: false }, { name: 'RSI', overlay: false }, { name: 'MACD', overlay: false },
];
const DEFAULT_INDICATORS = ['VOL'];

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

/**
 * candles  : [{ t(ms), o, h, l, c, v }] ascending
 * tf       : '5m' | '15m' | '1h' | '4h' | '1d'
 * quote    : quote asset symbol (the ticker in the legend)
 * poolRef  : storage key of drawings/indicators on the server — null = not stored
 * range    : { lo, hi } price range of the LP position, or null
 * ranges   : [{ id, lo, hi, color, label, selected, from(ms), to(ms) }] — many bands
 *            at once (all open positions in the same pool). If given, `range`
 *            is ignored: the `selected` band represents the position being viewed.
 * entry    : { t(ms), p }  exit : { t(ms), p }  now : current price — all optional,
 *            used to draw the position context (not user drawings)
 */
export default function AdvancedChart({ candles, tf, quote, poolRef, height = 420, range = null, ranges = null, entry = null, exit = null, now = null, bep = null }) {
  const { t } = useI18n();
  const box = useRef(null);
  const chartRef = useRef(null);
  const dataRef = useRef([]);
  const lastTsRef = useRef(null);
  const saveTimerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [pal, setPal] = useState(palette);
  const [activeInds, setActiveInds] = useState(new Set());

  const data = useMemo(() => (candles || [])
    .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
    .map((c) => ({ timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0 })),
  [candles]);
  dataRef.current = data;

  useEffect(() => {
    const mo = new MutationObserver(() => setPal(palette()));
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
  const withHooks = (o) => ({ ...o, onDrawEnd: scheduleSave, onPressedMoveEnd: scheduleSave, onRemoved: scheduleSave });

  // Create the chart once per mount (the parent remounts via `key={tf}` when the candle range changes).
  useEffect(() => {
    const el = box.current;
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

  useEffect(() => { chartRef.current?.chart.setStyles(buildStyles(pal)); }, [pal]);

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
        const spec = INDICATORS.find((i) => i.name === name);
        if (!spec) continue;
        const id = r.chart.createIndicator(spec.overlay ? { name, paneId: 'candle_pane' } : name, false);
        if (id) r.indicatorIds[name] = id;
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

  const draw = (name) => chartRef.current?.chart.createOverlay(withHooks({ name }));
  const clearAll = async () => {
    const ok = await ask({ title: t('Hapus semua gambar di grafik ini?'), confirm: t('Hapus'), danger: true });
    if (!ok) return;
    const r = chartRef.current; if (!r) return;
    for (const o of userOverlays(r.chart)) r.chart.removeOverlay({ id: o.id });
    scheduleSave();
  };
  const toggleIndicator = (name, on) => {
    const r = chartRef.current; if (!r) return;
    if (on) {
      const spec = INDICATORS.find((i) => i.name === name);
      const id = r.chart.createIndicator(spec.overlay ? { name, paneId: 'candle_pane' } : name, false);
      if (id) r.indicatorIds[name] = id;
    } else {
      const id = r.indicatorIds[name];
      if (id) r.chart.removeIndicator({ id });
      delete r.indicatorIds[name];
    }
    setActiveInds(new Set(Object.keys(r.indicatorIds)));
    scheduleSave();
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5">
          {DRAW_TOOLS.map(([name, Icon, label]) => (
            <button key={name} type="button" title={t(label)} aria-label={t(label)} onClick={() => draw(name)}
              className="flex size-7 items-center justify-center rounded text-muted transition-colors hover:bg-default hover:text-foreground">
              <Icon className="size-3.5" />
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button type="button" title={t('Hapus semua gambar')} aria-label={t('Hapus semua gambar')} onClick={clearAll}
            className="flex size-7 items-center justify-center rounded text-muted transition-colors hover:bg-danger/10 hover:text-danger">
            <Trash2 className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-0.5 rounded border border-border bg-surface/80 p-0.5">
          {INDICATORS.map(({ name }) => {
            const on = activeInds.has(name);
            return (
              <button key={name} type="button" aria-pressed={on} onClick={() => toggleIndicator(name, !on)}
                className={`rounded px-1.5 py-1 text-[0.6875rem] font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
                {name}
              </button>
            );
          })}
        </div>
      </div>
      <div ref={box} style={{ height }} className="w-full" />
    </div>
  );
}
