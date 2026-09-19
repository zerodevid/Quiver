// Grafik lanjutan dengan KLineChart: alat gambar (garis tren, fibonacci, dst) dan
// indikator (MA/EMA/BOLL/VOL/RSI/MACD) gaya TradingView. Gambar & indikator aktif
// disimpan di server per pool (bukan localStorage) lewat /api/chart/overlays, jadi
// tetap ada saat halaman dibuka lagi dari perangkat mana pun.
import { useEffect, useMemo, useRef, useState } from 'react';
import { init, dispose, registerOverlay } from 'klinecharts';
import { TrendingUp, Minus, Ruler, Brush, GitCommitHorizontal, Square, Trash2 } from 'lucide-react';
import { get, post } from '../api';
import { ask } from './ui';
import { useI18n } from '../i18n';
import { palette, withAlpha } from './CandleChart';

// Pita rentang posisi LP: titik 1 = (saat masuk, hi), titik 2 = (saat keluar, lo).
// Sumbu waktu dipotong ke masa posisi hidup: mulai di lilin masuk (atau tepi kiri kalau
// masuknya sebelum lilin pertama) dan berhenti di lilin keluar; posisi yang masih
// terbuka (extendData.open) memanjang sampai tepi kanan pane.
registerOverlay({
  name: 'lpRange', totalStep: 2,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const [c1, c2] = coordinates;
    if (!c1 || !c2) return [];
    const y1 = Math.min(c1.y, c2.y), y2 = Math.max(c1.y, c2.y);
    const { fill, line, open } = overlay.extendData || {};
    const x1 = Math.max(0, Math.min(c1.x, c2.x));
    const x2 = open ? bounding.width : Math.min(bounding.width, Math.max(c1.x, c2.x));
    if (x2 <= x1) return [];
    return [
      { type: 'rect', ignoreEvent: true, attrs: { x: x1, y: y1, width: x2 - x1, height: Math.max(1, y2 - y1) }, styles: { style: 'fill', color: fill } },
      { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: x1, y: y1 }, { x: x2, y: y1 }] }, styles: { style: 'dashed', color: line, size: 1 } },
      { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: x1, y: y2 }, { x: x2, y: y2 }] }, styles: { style: 'dashed', color: line, size: 1 } },
    ];
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

// Presisi harga tetap (bukan format kustom per titik seperti lightweight-charts):
// disetel dari rentang harga lilin supaya token remeh (0,00000032) tetap kebaca.
function precisionFor(data) {
  const prices = data.flatMap((d) => [d.open, d.high, d.low, d.close]).filter((p) => p > 0);
  if (!prices.length) return 4;
  const min = Math.min(...prices);
  if (min >= 1) return 2;
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(min)) - 1);
  return Math.min(12, leadingZeros + 4);
}

// DataLoader KLineChart v10: sekali dipasang, ia menarik data awal lewat getBars lalu
// berlangganan pembaruan lewat subscribeBar. Kita dorong lilin terbaru tiap kali polling
// membawa data baru lewat push(); riwayat awal dibaca dari dataRef saat itu juga.
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
// Overlay konteks posisi LP (pita rentang, garis masuk/keluar/BEP) memakai groupId
// tetap 'lp' — dibedakan dari gambar milik pengguna supaya "hapus semua" dan
// penyimpanan ke server tidak ikut membuang/menyimpannya (overlay ini diturunkan dari
// props posisi, dibangun ulang tiap props berubah, bukan gambar tangan pengguna).
const LP_GROUP = 'lp';
const userOverlays = (chart) => chart.getOverlays().filter((o) => o.groupId !== LP_GROUP);

/**
 * candles  : [{ t(ms), o, h, l, c, v }] urut naik
 * tf       : '5m' | '15m' | '1h' | '4h' | '1d'
 * quote    : simbol aset kuotasi (ticker di legenda)
 * poolRef  : kunci penyimpanan gambar/indikator di server — null = tidak disimpan
 * range    : { lo, hi } harga rentang posisi LP, atau null
 * entry    : { t(ms), p }  exit : { t(ms), p }  now : harga kini — semuanya opsional,
 *            dipakai untuk menggambar konteks posisi (bukan gambar pengguna)
 */
export default function AdvancedChart({ candles, tf, quote, poolRef, height = 420, range = null, entry = null, exit = null, now = null, bep = null }) {
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

  // Buat grafik sekali per mount (parent me-remount lewat `key={tf}` saat rentang lilin diganti).
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

  // Muat gambar & indikator tersimpan sekali chart siap.
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

  // Lilin baru dari polling: dorong lewat langganan DataLoader, bukan reset data
  // (reset akan mengulang zoom/pan pengguna).
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || !data.length) return;
    const last = data[data.length - 1];
    if (lastTsRef.current == null) { lastTsRef.current = last.timestamp; return; }
    if (last.timestamp >= lastTsRef.current) { r.loader.push(last); lastTsRef.current = last.timestamp; }
  }, [data, ready]);

  // Konteks posisi LP: pita rentang + garis masuk/keluar/BEP/kini. Dibangun ulang
  // (bukan dipindah) tiap props berubah — cukup murah dan menghindari melacak id per garis.
  useEffect(() => {
    const r = chartRef.current;
    if (!r || !ready || !data.length) return;
    for (const o of r.chart.getOverlays({ groupId: LP_GROUP })) r.chart.removeOverlay({ id: o.id });
    const anchor = data[data.length - 1].timestamp;
    const specs = [];
    if (range?.lo > 0 && range?.hi > 0) {
      // Tanpa waktu masuk, pita mulai dari lilin pertama; tanpa waktu keluar, pita
      // dianggap masih terbuka dan memanjang ke tepi kanan.
      const from = entry?.t > 0 ? entry.t : data[0].timestamp;
      const to = exit?.t > 0 ? exit.t : anchor;
      specs.push({
        name: 'lpRange', groupId: LP_GROUP, lock: true,
        points: [{ timestamp: from, value: range.hi }, { timestamp: to, value: range.lo }],
        extendData: { fill: withAlpha(pal.accent, pal.dark ? 0.13 : 0.1), line: withAlpha(pal.accent, 0.45), open: !(exit?.t > 0) },
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
  }, [ready, data.length, range?.lo, range?.hi, entry?.p, entry?.t, exit?.p, exit?.t, now, bep, pal]);

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
