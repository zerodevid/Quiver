// Grafik lilin dengan TradingView Lightweight Charts: zoom/pan, crosshair, skala
// log, dan lapisan posisi LP (pita rentang, garis masuk/keluar, harga masuk/kini)
// yang digambar sebagai *primitive* di kanvas yang sama.
//
// Sumbu harga TIDAK memakai autoscale bawaan: satu wick liar (memecoin sering
// punya) akan menarik sumbu 10× dan menggepengkan semua lilin lain. Batasnya
// dihitung dari persentil wick + badan lilin; wick ekstrem dipotong di tepi.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, HistogramSeries, LineStyle, PriceScaleMode, CrosshairMode, createSeriesMarkers,
} from 'lightweight-charts';
import { price as fmtPrice, usd, pct, tone, locale as fmtLocale } from '../fmt';
import { translate as t } from '../i18n';

// Warna tema (oklch di CSS) -> hex. Lightweight Charts mengolah alpha sendiri dan
// hanya paham format sRGB, jadi warnanya dicat ke satu piksel kanvas lalu dibaca
// kembali — cara yang jalan untuk format apa pun yang dikenal browser.
const hexCache = new Map();
function cssColor(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
  if (hexCache.has(raw)) return hexCache.get(raw);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = raw; ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  hexCache.set(raw, hex);
  return hex;
}
const withAlpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
function palette() {
  const dark = document.documentElement.classList.contains('dark');
  return {
    dark,
    up: cssColor('--success'), down: cssColor('--danger'), accent: cssColor('--accent'), warning: cssColor('--warning'),
    muted: cssColor('--muted'), border: cssColor('--border'), fg: cssColor('--foreground'),
    text: dark ? '#9a9aa3' : '#6b6b76',
    // label crosshair di sumbu: kontras tinggi terhadap kanvas, bukan abu tipis
    label: dark ? '#3a3a42' : '#4a4a55',
  };
}

// Lapisan posisi LP di atas lilin. Dibaca ulang tiap kali grafik digambar, jadi
// cukup mengganti `this.o` lalu minta gambar ulang.
class LpOverlay {
  constructor(o) { this.o = o; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = null; this.series = null; }
  set(o) { this.o = o; this.requestUpdate?.(); }
  paneViews() { return [this.view ||= { zOrder: () => 'bottom', renderer: () => ({ draw: (tg) => this.draw(tg) }) }]; }
  draw(target) {
    const { chart, series, o } = this;
    if (!chart || !series || !o) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: { width, height } }) => {
      const y = (p) => (p == null ? null : series.priceToCoordinate(p));
      const x = (ts) => (ts == null ? null : chart.timeScale().timeToCoordinate(ts));
      const font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.font = font;
      // pita rentang: sampai tepi kalau memanjang di luar grafik
      if (o.range) {
        let y1 = y(o.range.hi), y2 = y(o.range.lo);
        if (y1 != null && y2 != null) {
          y1 = Math.max(-1, Math.min(height + 1, y1)); y2 = Math.max(-1, Math.min(height + 1, y2));
          ctx.fillStyle = withAlpha(o.c.accent, o.dark ? 0.13 : 0.1);
          ctx.fillRect(0, y1, width, y2 - y1);
          ctx.strokeStyle = withAlpha(o.c.accent, 0.45); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(width, y1); ctx.moveTo(0, y2); ctx.lineTo(width, y2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = o.c.text; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
          ctx.fillText(t('rentang'), 4, Math.max(22, y1 + 3));
        }
      }
      // garis tegak: saat masuk (aksen) & saat keluar (kuning). Labelnya ada di
      // marker panah pada lilinnya; di sini hanya untuk masuk yang jatuh sebelum
      // lilin pertama (tidak ada lilin yang bisa dipasangi marker).
      const vline = (ts, label, color) => {
        const xx = x(ts);
        if (xx == null) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, height); ctx.stroke(); ctx.setLineDash([]);
        if (label) { ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText(label, xx + 4, 22); }
      };
      if (o.entryT != null) vline(o.entryT, o.entryBefore ? t('masuk (sebelum grafik)') : null, o.c.accent);
      if (o.exitT != null) vline(o.exitT, null, o.c.warning);
    });
  }
}

// Batas sumbu harga: persentil wick (memotong lonjakan sesaat), seluruh badan
// lilin, harga masuk/kini, dan pita rentang kalau tidak terlalu lebar.
function domainOf(cs, o) {
  if (!cs.length) return null;
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; };
  let lo = Math.min(q(cs.map((c) => c.l), 0.03), ...cs.map((c) => Math.min(c.o, c.c)));
  let hi = Math.max(q(cs.map((c) => c.h), 0.97), ...cs.map((c) => Math.max(c.o, c.c)));
  for (const p of [o.entryP, o.exitP, o.nowP, o.bep]) if (p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  if (o.range && (o.pickRange || o.range.hi / o.range.lo < 3.5)) { lo = Math.min(lo, o.range.lo); hi = Math.max(hi, o.range.hi); }
  // Saat memilih rentang, batasnya tidak boleh menempel di tepi: label sumbunya
  // tertutup legenda OHLC dan tombol skala di pojok atas.
  if (o.pickRange) { const f = Math.max(1.03, (hi / lo) ** 0.12); lo /= f; hi *= f; }
  return { lo, hi };
}

/**
 * candles : [{ t(ms), o, h, l, c, v }] urut naik
 * tf      : '5m' | '1h' | … (untuk format label)
 * quote   : simbol aset kuotasi (legenda)
 * range   : { lo, hi } harga rentang posisi, atau null
 * entry   : { t(ms), p }  exit : { t(ms), p }  now : harga kini — semuanya opsional
 * pickRange : rentang sedang dipilih (LP manual) — kedua batasnya selalu masuk
 *             sumbu, selebar apa pun, dan diberi label harga di sumbu
 * height  : tinggi px
 */
export default function CandleChart({ candles, tf, quote, range = null, entry = null, exit = null, now = null, bep = null, pickRange = false, height = 384 }) {
  const box = useRef(null);
  const ref = useRef(null);            // { chart, series, vol, overlay, markers }
  const [hover, setHover] = useState(null);
  const [scale, setScale] = useState(null);   // null = otomatis
  const [pal, setPal] = useState(palette);

  // Ganti tema (kelas .dark di <html>) -> warna dibaca ulang.
  useEffect(() => {
    const mo = new MutationObserver(() => setPal(palette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // GeckoTerminal sesekali mengirim dua lilin dengan waktu yang sama; Lightweight
  // Charts menuntut waktu naik ketat, jadi yang kembar dibuang (yang terakhir menang).
  const data = useMemo(() => {
    const out = [];
    for (const c of candles || []) {
      if (!(c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)) continue;
      const row = { time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c, value: c.v || 0 };
      const last = out[out.length - 1];
      if (last && row.time <= last.time) { if (row.time === last.time) out[out.length - 1] = row; continue; }
      out.push(row);
    }
    return out;
  }, [candles]);
  const secs = data.length > 1 ? data[1].time - data[0].time : 60;
  // Penanda waktu dipasang pada lilin yang memuatnya.
  const snap = (ms) => {
    if (!ms || !data.length) return null;
    const s = ms / 1000;
    let best = data[0].time;
    for (const c of data) { if (c.time <= s) best = c.time; else break; }
    return best;
  };
  const entryT = snap(entry?.t), exitT = snap(exit?.t);
  const entryBefore = !!(entry?.t && data.length && data[0].time * 1000 > entry.t);
  const dom = useMemo(() => domainOf(data.map((d) => ({ o: d.open, h: d.high, l: d.low, c: d.close })), { entryP: entry?.p, exitP: exit?.p, nowP: now, bep, range, pickRange }), [data, entry?.p, exit?.p, now, bep, range, pickRange]);
  // Log kalau rentang harga yang tampil lebih dari 4× — pergerakan persen jadi sebanding.
  const log = scale ? scale === 'log' : !!(dom && dom.hi / dom.lo > 4);

  // Buat grafik sekali.
  useEffect(() => {
    const el = box.current;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: pal.text, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: 11, attributionLogo: false },
      // garis bantu: rambut utuh & redup — titik-titik terbaca sebagai ambang, bukan grid
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(pal.border, 0.6), style: LineStyle.Solid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 2, shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (ts, type) => {
          const d = new Date(ts * 1000);
          return type <= 2 ? d.toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' })
            : d.toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' });
        } },
      localization: { locale: fmtLocale(), priceFormatter: (p) => fmtPrice(p),
        timeFormatter: (ts) => new Date(ts * 1000).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
      crosshair: { mode: CrosshairMode.Normal,
        vertLine: { color: withAlpha(pal.muted, 0.7), style: LineStyle.Dashed, width: 1, labelBackgroundColor: pal.label },
        horzLine: { color: withAlpha(pal.muted, 0.7), style: LineStyle.Dashed, width: 1, labelBackgroundColor: pal.label } },
      handleScale: { axisPressedMouseMove: true }, handleScroll: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: pal.up, downColor: pal.down, wickUpColor: pal.up, wickDownColor: pal.down, borderVisible: false,
      priceFormat: { type: 'custom', formatter: (p) => fmtPrice(p), minMove: 1e-12 },
      lastValueVisible: true, priceLineVisible: false,
      autoscaleInfoProvider: () => (ref.current?.dom ? { priceRange: { minValue: ref.current.dom.lo, maxValue: ref.current.dom.hi } } : null),
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const overlay = new LpOverlay(null);
    series.attachPrimitive(overlay);
    const markers = createSeriesMarkers(series, []);
    const onMove = (e) => {
      const d = e.seriesData?.get(series);
      setHover(d && e.time != null ? { ...d, v: e.seriesData.get(vol)?.value ?? 0 } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    ref.current = { chart, series, vol, overlay, markers, lines: [], dom: null };
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.remove(); ref.current = null; };
  }, []);

  // Warna mengikuti tema.
  useEffect(() => {
    const r = ref.current; if (!r) return;
    r.chart.applyOptions({ layout: { textColor: pal.text }, grid: { horzLines: { color: withAlpha(pal.border, 0.6) } },
      crosshair: { vertLine: { color: withAlpha(pal.muted, 0.7), labelBackgroundColor: pal.label }, horzLine: { color: withAlpha(pal.muted, 0.7), labelBackgroundColor: pal.label } } });
    r.series.applyOptions({ upColor: pal.up, downColor: pal.down, wickUpColor: pal.up, wickDownColor: pal.down });
  }, [pal]);

  // Apply the scale mode only when it changes: reapplying it on each poll
  // resets manual price-axis scaling in Lightweight Charts.
  useEffect(() => {
    ref.current?.chart.priceScale('right').applyOptions({ mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [log]);

  // Data and overlays can refresh without fitting the user's viewport again.
  // Fit once for each candle interval, after that interval has data.
  const fittedTf = useRef(null);

  // Data, skala, dan lapisan posisi.
  useEffect(() => {
    const r = ref.current; if (!r) return;
    r.dom = dom;
    r.series.setData(data);
    r.vol.setData(data.map((d) => ({ time: d.time, value: d.value, color: withAlpha(d.close >= d.open ? pal.up : pal.down, 0.28) })));
    for (const l of r.lines) r.series.removePriceLine(l);
    r.lines = [];
    const line = (p, color, title, style = LineStyle.Dashed) => { if (p > 0) r.lines.push(r.series.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
    line(entry?.p, pal.muted, t('masuk'));
    line(exit?.p, pal.warning, t('keluar'));
    line(bep, pal.warning, 'BEP');
    if (pickRange && range) {
      line(range.hi, pal.accent, t('batas atas'));
      line(range.lo, pal.accent, t('batas bawah'));
    }
    // Harga pool kini hanya digaris kalau berbeda dari penutupan lilin terakhir —
    // kalau sama, label nilai terakhir seri sudah menunjukkannya; dua label kembar
    // di sumbu (merah 0,0106 dan putih 0,0106) cuma berisik.
    const lastClose = data[data.length - 1]?.close;
    if (now > 0 && !exit && !(lastClose > 0 && Math.abs(now / lastClose - 1) < 0.003)) line(now, withAlpha(pal.fg, 0.55), t('kini'), LineStyle.Dotted);
    r.overlay.set({ range, entryT, exitT, entryBefore, c: pal, dark: pal.dark });
    r.markers.setMarkers([
      ...(entryT != null && !entryBefore ? [{ time: entryT, position: 'belowBar', color: pal.accent, shape: 'arrowUp', text: t('masuk') }] : []),
      ...(exitT != null ? [{ time: exitT, position: 'aboveBar', color: pal.warning, shape: 'arrowDown', text: t('keluar') }] : []),
    ]);
    if (data.length && fittedTf.current !== tf) {
      r.chart.timeScale().fitContent();
      r.chart.timeScale().applyOptions({ rightOffset: 3 });
      fittedTf.current = tf;
    }
  }, [data, tf, dom, entry?.p, exit?.p, entryT, exitT, entryBefore, now, bep, range, pickRange, pal]);

  const last = data[data.length - 1];
  const h = hover || (last && { ...last, v: last.value });
  const chg = h && h.open > 0 ? (h.close / h.open - 1) * 100 : null;

  return (
    <div className="relative">
      {/* legenda OHLC lilin yang disorot (atau lilin terakhir) */}
      {h && (
        <div className="num pointer-events-none absolute top-1 left-1 z-10 flex flex-wrap gap-x-2.5 rounded bg-surface/80 px-1.5 py-0.5 text-[0.6875rem] text-muted backdrop-blur-sm">
          <span>{new Date(h.time * 1000).toLocaleString(fmtLocale(), secs >= 86400 ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span>O <span className="text-foreground">{fmtPrice(h.open)}</span></span>
          <span>H <span className="text-foreground">{fmtPrice(h.high)}</span></span>
          <span>L <span className="text-foreground">{fmtPrice(h.low)}</span></span>
          <span>C <span className={tone(chg) || 'text-foreground'}>{fmtPrice(h.close)}</span>{chg != null && <span className={`ml-1 ${tone(chg)}`}>{pct(chg, 1)}</span>}</span>
          <span>{t('Vol')} <span className="text-foreground">{usd(h.v, 0)}</span></span>
          {quote && <span>{t('dalam {q}', { q: quote })}</span>}
        </div>
      )}
      {/* skala: otomatis (log kalau rentangnya lebar) / paksa log / linear */}
      <div className="absolute top-1 right-1 z-10 flex rounded border border-border bg-surface/80 p-0.5 text-[0.6875rem] backdrop-blur-sm" role="group" aria-label={t('Skala harga')}>
        {[['log', 'Log'], ['lin', 'Lin']].map(([id, label]) => {
          const on = (id === 'log') === log;
          return <button key={id} type="button" aria-pressed={on} onClick={() => setScale(id)}
            className={`rounded px-1.5 font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>{label}</button>;
        })}
      </div>
      <div ref={box} style={{ height }} className="w-full" />
    </div>
  );
}
