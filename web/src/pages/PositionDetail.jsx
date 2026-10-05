// Detail of one LP position: the pool price chart with the position range and entry point
// marked, market stats (DexScreener), and the position contents (tokens, fee, capital).
//
// The chart is drawn by ourselves from GeckoTerminal candles, not just embedding
// DexScreener: what the position owner wants to see is not only the price, but "where
// is my range, when did I enter, and how far is the price from the edge" — and a
// third-party iframe cannot be drawn on. The GMGN and DexScreener views stay available
// as other choices for the indicators and drawing tools traders are used to.
//
// Below the chart is a running pool trade tape (GeckoTerminal, every 10
// seconds): who is buying/selling, how much, at what price — copied target
// wallets and the bot itself are named.
import { chainInfo } from '../chain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { ArrowLeft, ChevronDown, ExternalLink } from 'lucide-react';
import { breakEven } from '../breakeven';
import { gtTradesUrl, normalizeTrades } from '../../../src/trades.mjs';
import { get } from '../api';
import AdvancedChart from '../components/AdvancedChart';
import { useLivePrice, useLiveCandles, LIVE_MS } from '../liveCandles';
import { usePoll, useResync } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { useClaimFees } from '../useClaimFees';
import AutoCompoundButton from '../components/AutoCompoundButton';
import TakeoverButton from '../components/TakeoverButton';
import TargetSide from '../components/TargetSide';
import ShareButton, { positionCard } from '../components/ShareCard';
import { Panel, Stat, KV, Dot, Empty, Loading, Notice, Segmented, PriceRange, Refresh, ask, TradeLinks, DataLinks } from '../components/ui';
import { TokenPair, TokenSym, PairName } from '../components/TokenIcon';
import { usd, pct, tone, num, age, ago, short, price, tickPrice, sqrtPrice, widthPct, txHref, addrHref, feeApr, aprText, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

export const TFS = [['5m', '5 mnt'], ['15m', '15 mnt'], ['1h', '1 jam'], ['4h', '4 jam'], ['1d', '1 hari']];
export const SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
export const VIEWS = [['chart', 'Grafik'], ['gmgn', 'GMGN'], ['dex', 'DexScreener']];
// UI candle range -> GMGN embed interval parameter (minutes; 1D for daily).
const GMGN_IV = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D' };

// The candle range is chosen so the entry point is still visible: a position 50 minutes
// old is viewed per 5 minutes, a position a week old per 4 hours.
export const tfFor = (ageHours) => {
  const s = (ageHours || 0) * 3600;
  for (const tf of ['5m', '15m', '1h', '4h']) if (s / SECS[tf] <= 400) return tf;
  return '1d';
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const qty = (raw, dec) => (raw == null ? null : Number(raw) / 10 ** (dec ?? 18));
const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(fmtLocale(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));
export const kUsd = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? usd(v / 1e6, 2) + 'M' : Math.abs(v) >= 1e4 ? usd(v / 1e3, 1) + 'k' : usd(v));

// GeckoTerminal is asked to use the speculative token as the price base; if it
// replies inverted (or the pool's base differs), the candles are flipped so they go the same direction
// as the pool's tick price. Checked against a reference price (ref) if available: the direction
// closest to it wins.
export function orientCandles(ohlcv, baseToken, ref) {
  let cs = ohlcv?.candles || [];
  if (!cs.length) return [];
  const inv = (c) => ({ t: c.t, o: 1 / c.o, h: 1 / c.l, l: 1 / c.h, c: 1 / c.c, v: c.v });
  const last = cs[cs.length - 1];
  let flip = ohlcv.base?.address && baseToken && ohlcv.base.address !== baseToken;
  if (ref > 0 && last?.c > 0) {
    const dOk = Math.abs(Math.log(last.c / ref)), dInv = Math.abs(Math.log((1 / last.c) / ref));
    if (Math.min(dOk, dInv) < 2) flip = dInv < dOk;
  }
  if (flip) cs = cs.map(inv);
  return cs.filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0);
}

// Candle chart + position range + entry/exit markers. Also used by the pool page:
// without a position (tick_lower null) only the candles and the current price are drawn.
// Candle source of the Chart tab: GeckoTerminal (price in the pool's quote asset) or GMGN
// OpenAPI (USD price; needs an API key in Settings). The choice is remembered per browser.
export const SOURCES = [['gt', 'GeckoTerminal'], ['gmgn', 'GMGN']];
const SRC_KEY = 'lpcopy-chart-src';
export const readSrc = () => { try { return localStorage.getItem(SRC_KEY) === 'gmgn' ? 'gmgn' : 'gt'; } catch { return 'gt'; } };
export const writeSrc = (v) => { try { localStorage.setItem(SRC_KEY, v); } catch { /* abaikan */ } };

// `ranges` (optional): all open positions in this pool, so the pool detail chart
// shows every active range as on the Monitor page. The `selected` one is the
// position being highlighted (the entry/exit/BEP lines remain only for that one).
export function PriceChart({ p, m, tf, ranges = null, onRangeClick = null }) {
  const { t } = useI18n();
  const at = (tick) => tickPrice(tick, p.dec0, p.dec1, p.quoteSide);
  const hasRange = p.tick_lower != null && p.tick_upper != null;
  const full = hasRange && p.tick_lower <= -880000 && p.tick_upper >= 880000;
  const a = hasRange ? at(p.tick_lower) : null, b = hasRange ? at(p.tick_upper) : null;
  const range = hasRange && !full ? { lo: Math.min(a, b), hi: Math.max(a, b) } : null;
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pExit = sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide);
  // A closed position is viewed as history: without a live price.
  const live = useLivePrice(p.pool_ref, p, p.status !== 'closed');
  const pNow = live?.price ?? (p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : (p.curTick != null ? at(p.curTick) : null));

  // GMGN candles are priced in USD, while the position's range/entry/BEP are in the pool's quote
  // asset: everything is multiplied by the quote->USD rate (DexScreener's priceUsd / current price;
  // USDG is assumed $1 if DexScreener is not available yet). Without a rate, the candles still show
  // but the position markers are not drawn — better empty than off.
  const gmgn = m?.ohlcv?.source === 'gmgn';
  const quoteSym = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const k = !gmgn ? 1
    : m?.pair?.priceUsd > 0 && pNow > 0 ? m.pair.priceUsd / pNow
    : quoteSym === chainInfo().usdgSymbol ? 1 : null;
  const oriented = useMemo(() => (gmgn ? (m?.ohlcv?.candles || []) : orientCandles(m?.ohlcv, p.baseToken, pNow ?? pEntry)), [m, gmgn, p.baseToken, pNow, pEntry]);
  const liveK = useMemo(() => (live && k ? { ...live, price: live.price * k } : k ? live : null), [live, k]);
  const candles = useLiveCandles(oriented, SECS[tf], liveK, `${p.pool_ref}:${tf}:${gmgn ? 'gmgn' : 'gt'}`);

  if (m?.ohlcv?.error) return <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />;
  if (!candles.length) return <Empty title="Belum ada lilin harga" sub={gmgn ? 'GMGN belum punya riwayat harga untuk token ini.' : 'GeckoTerminal belum punya riwayat harga untuk pool ini.'} />;

  const bep = breakEven(p);
  const closed = p.status === 'closed';
  const quote = gmgn ? 'USD' : quoteSym;
  const cv = (v) => (v != null && k ? v * k : null);
  // GMGN candles are priced in USD: the bands are also multiplied by the quote->USD rate. Without a rate, the bands
  // are not drawn (the same as a single position range).
  const bands = k ? (ranges || []).filter((b) => b.lo > 0 && b.hi > 0).map((b) => ({ ...b, lo: b.lo * k, hi: b.hi * k })) : [];
  return (
    <div>
      {gmgn && m.ohlcv.fallback && <p className="mb-2 text-xs text-warning">{t('GMGN gagal, memakai GeckoTerminal')}: {t(m.ohlcv.fallback)}</p>}
      {gmgn && !k && <p className="mb-2 text-xs text-warning">{t('Kurs {q} → USD belum diketahui; rentang posisi tidak digambar di lilin GMGN.', { q: quoteSym || '?' })}</p>}
      {bep && <p className="mb-2 text-xs text-warning">
        {t('Harga BEP')}: {bep.price > 0 ? <>{price(bep.price)} {quoteSym}{pNow > 0 && <> · {pct((bep.price / pNow - 1) * 100, 2)} {t('dari harga sekarang')}</>}</> : t(bep.reason)}
      </p>}
      <AdvancedChart key={`${p.pool_ref || p.baseToken || "pool"}:${p.id || "none"}:${tf}:${gmgn ? 'gmgn' : 'gt'}`}
        candles={candles} tf={tf} quote={quote} poolRef={p.pool_ref || p.baseToken || null} range={range && k ? { lo: range.lo * k, hi: range.hi * k } : null}
        ranges={bands.length ? bands : null}
        entry={p.opened_ts || pEntry != null ? { t: p.opened_ts, p: cv(pEntry) } : null}
        exit={closed ? { t: p.closed_ts, p: cv(pExit) } : null}
        now={closed ? null : cv(pNow)} bep={cv(bep?.price)} />
      {bands.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label={t('Rentang posisi di pool ini')}>
          {bands.map((b) => {
            const on = !!b.selected;
            return (
              <button key={b.id} type="button" role="tab" aria-selected={on} disabled={!onRangeClick}
                onClick={onRangeClick ? () => onRangeClick(b.id) : undefined}
                title={`${price(b.lo)} – ${price(b.hi)}`}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.6875rem] transition-colors ${on ? 'border-transparent bg-default text-foreground' : 'border-border text-muted hover:text-foreground'}`}
                style={on ? { boxShadow: `inset 0 0 0 1px ${b.color}` } : undefined}>
                <span className="inline-block size-2 rounded-sm" style={{ background: b.color }} />
                <span className="mono font-medium">{b.label}</span>
                <span className="num text-muted">{price(b.lo)} – {price(b.hi)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {bands.length > 1
          ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('{n} rentang aktif', { n: bands.length })}</span>
          : range && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('rentang posisi')}</span>}
        {p.opened_ts && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-px border-l-2 border-dashed border-accent" />{t('saat masuk')}</span>}
        {pEntry != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-px w-4 border-t border-dashed border-muted" />{t('harga masuk')}</span>}
        {bep?.price > 0 && <span className="inline-flex items-center gap-1.5 text-warning"><span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-warning" />BEP {price(bep.price)} {quoteSym}</span>}
        {full && <span>{t('Seluruh rentang')}</span>}
        <span className="ml-auto inline-flex items-center gap-3">
          {live && <LiveBadge />}
          {gmgn ? t('lilin {tf} · GMGN', { tf }) : t('lilin {tf} · GeckoTerminal', { tf })}
        </span>
      </div>
    </div>
  );
}

// Marker that the last candle is moved by the chain price, rather than waiting for GeckoTerminal.
export function LiveBadge() {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5 text-success" title={t('Harga dibaca langsung dari pool tiap {s} detik', { s: LIVE_MS / 1000 })}>
      <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-success" /></span>
      {t('live')}
    </span>
  );
}

export function DexEmbed({ pool }) {
  const dark = document.documentElement.classList.contains('dark');
  const q = new URLSearchParams({
    embed: '1', loadChartSettings: '0', trades: '0', tabs: '0', info: '0', chartLeftToolbar: '0',
    chartDefaultOnMobile: '1', chartTheme: dark ? 'dark' : 'light', theme: dark ? 'dark' : 'light',
    chartStyle: '1', chartType: 'usd', interval: '15',
  });
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <iframe title="DexScreener" src={`https://dexscreener.com/${chainInfo().dexscreener}/${pool}?${q}`}
        className="block h-[520px] w-full bg-surface" allow="clipboard-write" loading="lazy" />
    </div>
  );
}

// GMGN chart (gmgn.cc/kline) for the position's speculative token: the TradingView
// indicators and drawing tools commonly used in the GMGN terminal, following the dashboard theme.
//
// A cross-origin iframe cannot be drawn on (its axis scale belongs to GMGN, and its
// default is market cap, not price), so the position range cannot be overlaid
// on it as in the Chart tab. Instead: a strip of numbers below the chart — range
// bounds, entry price, BEP, and current price — in USD AND market cap, so they can be
// read directly against whichever GMGN axis is in use.
export function GmgnEmbed({ token, tf, p = null, pair = null }) {
  const { t } = useI18n();
  const dark = document.documentElement.classList.contains('dark');
  if (!token) return <Empty title="Grafik GMGN tidak tersedia" sub="Token spekulatif pool ini belum dikenali." />;
  const q = new URLSearchParams({ theme: dark ? 'dark' : 'light', interval: GMGN_IV[tf] || '15' });
  return (
    <div>
      <div className="overflow-hidden rounded-md border border-border">
        <iframe title="GMGN" src={`https://www.gmgn.cc/kline/${chainInfo().gmgn || chainInfo().key}/${token}?${q}`}
          className="block h-[520px] w-full bg-surface" allow="clipboard-write" loading="lazy" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {p && <GmgnRangeStrip p={p} pair={pair} />}
        <span className="ml-auto">{t('lilin {tf} · GMGN', { tf })}</span>
      </div>
    </div>
  );
}

// Position reference figures to read against the GMGN axis. USD price = price in the
// quote asset × quote rate (DexScreener's priceUsd / current price); market cap = USD
// price × supply (DexScreener's marketCap / priceUsd). Without market data, only the
// price in the quote asset is shown.
function GmgnRangeStrip({ p, pair }) {
  const { t } = useI18n();
  const at = (tick) => tickPrice(tick, p.dec0, p.dec1, p.quoteSide);
  const hasRange = p.tick_lower != null && p.tick_upper != null;
  const full = hasRange && p.tick_lower <= -880000 && p.tick_upper >= 880000;
  const a = hasRange ? at(p.tick_lower) : null, b = hasRange ? at(p.tick_upper) : null;
  const lo = hasRange && !full ? Math.min(a, b) : null, hi = hasRange && !full ? Math.max(a, b) : null;
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const live = useLivePrice(p.pool_ref, p, p.status !== 'closed');
  const pNow = live?.price ?? (p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : (p.curTick != null ? at(p.curTick) : null));
  const bep = breakEven(p);
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  // Quote -> USD rate and token supply, if the market is known.
  const k = pair?.priceUsd > 0 && pNow > 0 ? pair.priceUsd / pNow : null;
  const supply = k && (pair.marketCap || pair.fdv) > 0 ? (pair.marketCap || pair.fdv) / pair.priceUsd : null;
  const fmt = (v) => (v == null || !(v > 0) ? '—' : k ? usd(v * k, v * k < 0.01 ? 6 : 4) : `${price(v)} ${quote || ''}`);
  const mc = (v) => (supply && v > 0 ? kUsd(v * k * supply) : null);
  const Item = ({ label, v, cls = '' }) => (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <span>{label}</span>
      <span className="num font-medium text-foreground">{fmt(v)}</span>
      {mc(v) && <span className="num">· MCap {mc(v)}</span>}
    </span>
  );
  const inRange = pNow > 0 && lo != null ? pNow >= lo && pNow <= hi : null;
  return (
    <>
      {full ? <span>{t('Seluruh rentang')}</span>
        : lo != null && <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />
          <span>{t('rentang posisi')}</span>
          <span className="num font-medium text-foreground">{fmt(lo)} – {fmt(hi)}</span>
          {mc(lo) && <span className="num">· MCap {mc(lo)} – {mc(hi)}</span>}
        </span>}
      {pEntry != null && <Item label={t('masuk')} v={pEntry} />}
      {bep?.price > 0 && <Item label="BEP" v={bep.price} cls="text-warning" />}
      {pNow > 0 && <Item label={t('kini')} v={pNow} cls={inRange == null ? '' : inRange ? 'text-success' : 'text-danger'} />}
    </>
  );
}

// Running pool trade tape: the latest swaps from GeckoTerminal, newest on
// top. Rows that arrive after the page was opened are briefly highlighted so market
// movement is felt without re-reading the list. Buy/sell direction relative to the
// speculative token (base), price in the pool's quote asset — aligned with the chart.
//
// Fetched by the BROWSER directly from GeckoTerminal (CORS open): the ~30
// calls/minute quota is counted per IP, and the VPS IP is already used by three bot instances
// for price candles — through the server this tape often hits 429. The server (/api/trades,
// with a stale fallback) is only used if the browser call fails. Wallet names
// (target/bot) come from a separate server call, polled rarely.
// Polling stops when the tab is not visible; the old answer is kept on failure.
function useTrades(pool, token, ms) {
  const [state, setState] = useState({ trades: null, error: null, via: null });
  useEffect(() => {
    if (!pool) return undefined;
    let alive = true, timer = null;
    setState({ trades: null, error: null, via: null });
    const tick = async () => {
      if (document.hidden) return;
      let next = null;
      try {
        const r = await fetch(gtTradesUrl(chainInfo().geckoterminal || chainInfo().key, pool), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
        if (r.status === 404) next = { trades: [], error: 'pool ini belum terindeks di GeckoTerminal', via: 'browser' };
        else if (!r.ok) throw new Error(`HTTP ${r.status}`);
        else next = { trades: normalizeTrades(await r.json(), { token, limit: 60 }), error: null, via: 'browser' };
      } catch {
        try {
          const d = await get(`/api/trades?pool=${pool}&token=${token || ''}&limit=60`);
          next = d?.trades ? { trades: d.trades, error: null, via: d.stale ? 'stale' : 'server' } : { trades: null, error: d?.error || 'gagal', via: 'server' };
        } catch (e) { next = { trades: null, error: e.message, via: 'server' }; }
      }
      if (!alive) return;
      // Total failure: keep the list already shown, just flag it.
      setState((prev) => (next.trades == null && prev.trades ? { ...prev, error: next.error, via: 'stale' } : next));
    };
    tick();
    timer = setInterval(tick, ms);
    return () => { alive = false; clearInterval(timer); };
  }, [pool, token, ms]);
  return state;
}

const tradeKey = (x) => `${x.tx}:${x.ts}:${x.base}`;
export function TradesTape({ pool, token, base, quote, live = true }) {
  const { t } = useI18n();
  const data = useTrades(pool, token, live ? 10000 : 30000);
  const { data: names } = usePoll(pool ? '/api/trade-labels' : null, 60000);
  const [open, setOpen] = useState(true);
  // A "new" row = not present in the first reply; recorded per key so a row
  // that was already highlighted is not highlighted again on each poll.
  const seen = useRef(null);
  const fresh = useMemo(() => {
    const list = data?.trades || [];
    if (!list.length) return new Set();
    if (!seen.current) { seen.current = new Set(list.map(tradeKey)); return new Set(); }
    const n = new Set();
    for (const x of list) { const k = tradeKey(x); if (!seen.current.has(k)) { n.add(k); seen.current.add(k); } }
    return n;
  }, [data]);
  // Pool changes (the pool page picked another position): start from zero.
  useEffect(() => { seen.current = null; }, [pool]);

  const list = useMemo(() => (data.trades || []).map((x) => ({
    ...x, mine: !!names?.me && x.wallet === names.me,
    target: !!names?.targets && x.wallet in names.targets, label: names?.targets?.[x.wallet] || null,
  })), [data, names]);
  const buys = list.filter((x) => x.side === 'buy').length;
  return (
    <div className="mt-3 rounded-md border border-border">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <span className="font-semibold text-foreground">{t('Transaksi terakhir')}</span>
        {list.length > 0 && <span className="text-muted">
          <span className="text-success">{buys} {t('beli')}</span> · <span className="text-danger">{list.length - buys} {t('jual')}</span>
        </span>}
        <span className="ml-auto inline-flex items-center gap-3 text-muted">
          {data.via === 'stale' ? <span className="text-warning" title={t(data.error || 'GeckoTerminal sedang membatasi panggilan; menampilkan data terakhir')}>{t('tertunda')}</span> : live && data.trades && <LiveBadge />}
          <span className="hidden sm:inline">GeckoTerminal</span>
          <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        </span>
      </button>
      {open && (
        data.trades == null && !data.error ? <div className="px-3 pb-3"><Loading /></div>
        : data.trades == null || (data.error && !list.length) ? <p className="px-3 pb-3 text-xs text-muted">{t(data.error)}</p>
        : !list.length ? <p className="px-3 pb-3 text-xs text-muted">{t('Belum ada transaksi')}</p>
        : (
          <div className="max-h-72 overflow-y-auto border-t border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-[0.6875rem] text-muted">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">{t('Waktu')}</th>
                  <th className="py-1.5 text-left font-medium">{t('Aksi')}</th>
                  <th className="py-1.5 text-right font-medium">{t('Jumlah')}</th>
                  <th className="py-1.5 text-right font-medium">{t('Nilai')}</th>
                  <th className="hidden py-1.5 text-right font-medium sm:table-cell">{t('Harga')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('Wallet')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.map((x) => {
                  const buy = x.side === 'buy';
                  return (
                    <tr key={tradeKey(x)} className={`${fresh.has(tradeKey(x)) ? (buy ? 'trade-new-buy' : 'trade-new-sell') : ''}`}>
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted">
                        <a href={txHref(x.tx)} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline" title={x.tx}>{ago(x.ts)}</a>
                      </td>
                      <td className={`py-1.5 font-medium ${buy ? 'text-success' : 'text-danger'}`}>{buy ? t('Beli') : t('Jual')}</td>
                      <td className="num py-1.5 text-right whitespace-nowrap">{fmtQty(x.base)} <span className="text-muted">{base}</span></td>
                      <td className={`num py-1.5 text-right whitespace-nowrap ${x.usd >= 500 ? 'font-semibold' : ''}`}>{usd(x.usd)}</td>
                      <td className="num hidden py-1.5 text-right whitespace-nowrap text-muted sm:table-cell" title={x.priceUsd ? usd(x.priceUsd, x.priceUsd < 0.01 ? 6 : 4) : undefined}>
                        {price(x.priceQuote)} {quote}
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        {x.mine ? <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-accent">{t('bot')}</span>
                          : x.target ? <a href={addrHref(x.wallet)} target="_blank" rel="noreferrer" title={x.wallet}
                              className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning hover:underline">{x.label || short(x.wallet)}</a>
                          : <a href={addrHref(x.wallet)} target="_blank" rel="noreferrer" className="mono text-muted hover:text-foreground hover:underline">{short(x.wallet)}</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// Price change per time window from DexScreener — a row of small chips.
export function Changes({ pc }) {
  const { t } = useI18n();
  const items = [['m5', '5 mnt'], ['h1', '1 jam'], ['h6', '6 jam'], ['h24', '24 jam']].filter(([k]) => pc?.[k] != null);
  if (!items.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-0.5">
      {items.map(([k, l]) => <span key={k} className="whitespace-nowrap"><span className="font-normal text-muted">{t(l)}</span> <span className={tone(pc[k])}>{pct(pc[k], 1)}</span></span>)}
    </span>
  );
}

export function MarketPanel({ pair, pool }) {
  const { t } = useI18n();
  if (!pair) return <Loading page />;
  if (pair.error) return <div className="p-4"><Empty title="Data pasar tidak tersedia" sub={pair.error} /></div>;
  const tx = pair.txns?.h24;
  return (
    <>
      <div className="divide-y divide-border px-4">
        <KV label="Harga">{usd(pair.priceUsd, pair.priceUsd < 0.01 ? 6 : 4)}</KV>
        <KV label="Perubahan"><Changes pc={pair.priceChange} /></KV>
        <KV label="Volume 24 jam">{kUsd(pair.volume?.h24)}</KV>
        <KV label="Transaksi 24 jam">{tx ? <><span className="text-success">{num(tx.buys)}</span> <span className="font-normal text-muted">{t('beli')}</span> · <span className="text-danger">{num(tx.sells)}</span> <span className="font-normal text-muted">{t('jual')}</span></> : '—'}</KV>
        <KV label="Likuiditas pool">{kUsd(pair.liquidityUsd)}</KV>
        <KV label="FDV">{kUsd(pair.fdv)}</KV>
        <KV label="Pool dibuat">{pair.pairCreatedAt ? age((Date.now() - pair.pairCreatedAt) / 3600000) + ' ' + t('lalu') : '—'}</KV>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2.5 text-xs">
        <DataLinks pool={pool} dexUrl={pair.url} />
        <TradeLinks token={pair.base?.address} pool={pool} />
        {pair.websites?.map((w) => <a key={w} href={w} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:underline">{t('Situs')} <ExternalLink className="size-3" /></a>)}
      </div>
    </>
  );
}

export default function PositionDetail({ id }) {
  const { t } = useI18n();
  const { data: d, reload } = usePoll(`/api/position?id=${encodeURIComponent(id)}`, 10000);
  const p = d?.position;
  const [tfPick, setTf] = useState(null);
  const [view, setView] = useState('chart');
  const [src, setSrcState] = useState(readSrc);
  const setSrc = (v) => { setSrcState(v); writeSrc(v); };
  const { close, closing } = useClosePosition(reload);
  const { claim, claiming } = useClaimFees(reload);
  const tf = tfPick || (p ? tfFor(p.ageHours) : '1h');
  // Enough candles that the entry point is visible, plus a few before entry as context.
  // A closed position is framed around its lifetime: a little after
  // the exit, not up to now.
  const span = p ? p.ageHours * 3600 : 0;
  const tail = p?.status === 'closed' ? Math.max(20, Math.ceil((span * 0.2) / SECS[tf])) : 0;
  const limit = p ? Math.min(1000, Math.max(120, Math.ceil(span / SECS[tf]) + 40 + tail)) : 200;
  const before = p?.status === 'closed' && p.closed_ts ? p.closed_ts + tail * SECS[tf] * 1000 : null;
  const { data: m, reload: reloadMarket } = usePoll(p ? `/api/market?pool=${p.pool_ref}&tf=${tf}&limit=${limit}&token=${p.baseToken || ''}${before ? `&before=${before}` : ''}${src === 'gmgn' ? '&src=gmgn' : ''}` : null, 30000);
  // "Refresh detail" forces a chain sync first — the value/fee/PnL figures on this page
  // come from the last sync, so merely reloading returns the same figures.
  const reloadAll = useCallback(async () => { await Promise.all([reload(), reloadMarket()]); }, [reload, reloadMarket]);
  const [resync, syncing] = useResync(reloadAll);

  if (!d) return <Loading page />;
  if (d.error) return <Empty title="Posisi tidak ditemukan" sub={d.error} />;

  const bep = breakEven(p);
  const closed = p.status === 'closed';
  const at = (tick) => tickPrice(tick, p.dec0, p.dec1, p.quoteSide);
  const a = at(p.tick_lower), b = at(p.tick_upper);
  const [pLo, pHi] = a <= b ? [a, b] : [b, a];
  const full = p.tick_lower <= -880000 && p.tick_upper >= 880000;
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pExit = sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide);
  const pNow = closed ? pExit : (p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : (p.curTick != null ? at(p.curTick) : null));
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const base = p.quoteSide === 0 ? p.symbol1 : p.quoteSide === 1 ? p.symbol0 : p.symbol0;

  // Distance to the nearest edge, in percent of price movement.
  let edge = null;
  if (!closed && pNow != null && !full) {
    if (pNow >= pLo && pNow <= pHi) {
      const toLo = (pNow / pLo - 1) * 100, toHi = (pHi / pNow - 1) * 100;
      edge = { ok: true, text: t(toLo < toHi ? '{n}% ke tepi bawah' : '{n}% ke tepi atas', { n: num(Math.min(toLo, toHi), 1) }) };
    } else {
      const off = pNow < pLo ? (pLo / pNow - 1) * 100 : (pNow / pHi - 1) * 100;
      edge = { ok: false, text: t(pNow < pLo ? '{n}% di bawah rentang' : '{n}% di atas rentang', { n: num(off, 1) }) };
    }
  }

  const amt0 = qty(p.amount0, p.dec0), amt1 = qty(p.amount1, p.dec1);
  const fee0 = qty(p.fee0, p.dec0), fee1 = qty(p.fee1, p.dec1);
  const cost0 = qty(p.cost0, p.dec0), cost1 = qty(p.cost1, p.dec1);

  return (
    <>
      <div className="mb-5 border-b border-border pb-4">
        <a href="#positions" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3.5" />{t('Semua posisi')}</a>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="detail-heading flex min-w-0 max-w-full items-center gap-3">
            <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={30} />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight"><PairName token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} pool={p.pool_ref} sep="/" /></h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                <span>Uniswap {String(p.venue).toUpperCase()}</span><span>·</span>
                <span className="num">{t('fee {f}%', { f: num(p.fee / 10000, 2) })}</span>
                {p.token_id && <><span>·</span><span className="mono">#{p.token_id}</span></>}
                <span>·</span>
                {closed
                  ? <span>{t('ditutup {w}', { w: ago(p.closed_ts) })}</span>
                  : p.inRange != null
                    ? <><Dot tone={p.inRange ? 'success' : 'warning'} /><span className={p.inRange ? 'text-success' : 'text-warning'}>{t(p.inRange ? 'in-range' : 'di luar rentang')}</span></>
                    : <span className="flex items-center gap-1.5" title={t('Posisi baru tercatat; nilai, fee, dan PnL menyusul setelah sinkron dengan chain.')}>
                      <Spinner size="sm" color="current" className="size-3" />{t(p.syncing ? 'menyinkronkan…' : 'belum tersinkron')}
                    </span>}
                {p.target
                  ? <><span>·</span><a href={'#targets/' + p.target} className="hover:underline">{t('menyalin')} {p.targetLabel || <span className="mono">{short(p.target)}</span>}</a>
                    {p.takeover_ts != null && !closed && <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning" title={t('Diambil alih {w} — bot tidak mengikuti target dan tidak menutup otomatis.', { w: ago(p.takeover_ts) })}>{t('Kendali manual')}</span>}</>
                  : <><span>·</span><span>{t('di luar bot')}</span></>}
              </div>
            </div>
          </div>
          {/* closed position: the numbers are final, so there is no freshness clock — the button
              only refreshes the market chart. */}
          {/* One action cluster, tight on the right, uniform height: freshness clock + refresh
              (passive) are separated by a thin line from the actions that send a transaction.
              Ordered from the safest to the most destructive, and only "Close position"
              is coloured — so the eye knows at once which one cannot be undone. */}
          <div className="flex flex-wrap items-center gap-2">
            <Refresh at={closed ? undefined : d.syncedAt} busy={syncing} onPress={resync} label="Perbarui detail" />
            <ShareButton card={positionCard(p)} />
            {!closed && !p.empty && <>
              <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />
              <AutoCompoundButton p={p} reload={reload} disabled={claiming != null || closing != null} />
              <TakeoverButton p={p} reload={reload} disabled={claiming != null || closing != null} />
              <Button size="sm" variant="outline" isPending={claiming != null} isDisabled={closing != null || claiming != null} onPress={() => claim(p)}>{t('Claim fee')}</Button>
              <Button size="sm" variant="danger-soft" isPending={closing != null} isDisabled={claiming != null || closing != null} onPress={() => close(p)}>{t('Tutup posisi')}</Button>
            </>}
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat label={closed ? 'Hasil' : 'Nilai'} value={usd(closed ? p.outUsd : p.valueUsd)} fx={closed ? p.outUsd : p.valueUsd} sub={t('modal {v}', { v: usd(p.costUsd) })} />
        {/* The APR beside the label: what decides whether this position is worth keeping
            is not the nominal fee but how fast the capital earns. */}
        <Stat label={closed ? 'Fee (sudah diklaim)' : 'Fee belum diklaim'} value={closed ? '—' : usd(p.feeUsd)} fx={closed ? null : p.feeUsd} valueClass={!closed && p.feeUsd > 0.005 ? 'text-success' : ''}
          badge={closed || feeApr(p) == null ? null : (
            <span className="num shrink-0 rounded bg-success/12 px-1.5 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap text-success"
              title={t('Fee {f} dalam {age} atas modal {c}, disetahunkan', { f: usd((p.feeUsd || 0) + (p.claimedUsd || 0)), age: age(p.ageHours), c: usd(p.costUsd) })}>
              {t('APR {v}', { v: aprText(feeApr(p)) })}
            </span>)}
          sub={!closed && p.costUsd > 0 ? t('{p}% dari modal', { p: num((p.feeUsd / p.costUsd) * 100, 2) }) : null} />
        <Stat label="PnL" value={usd(p.pnlUsd)} fx={p.pnlUsd} valueClass={tone(p.pnlUsd)}
          sub={<span>{pct(p.pnlPct, 2)}{p.ilUsd != null && <> · IL <span className={tone(p.ilUsd)}>{usd(p.ilUsd)}</span></>}</span>} />
        <Stat label={closed ? 'Ditahan' : 'Umur'} value={age(p.ageHours)} sub={t('masuk {d}', { d: fmtDate(p.opened_ts) })} />
        {/* Running cost: gas + swap spread. Not counted in PnL, although
            it is the price paid to enter and exit this position. */}
        <Stat label="Ongkos jalan" value={p.cost?.txN ? usd(p.cost.totalUsd) : '—'} valueClass={p.cost?.totalUsd > 0.005 ? 'text-warning' : ''}
          sub={p.cost?.txN
            ? t('gas {g} · slippage {s}', { g: usd(p.cost.gasUsd, p.cost.gasUsd < 0.1 ? 3 : 2), s: usd(p.cost.slipUsd) })
            : t('belum ada transaksi')} />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel title={t('Harga {b} / {q}', { b: base, q: quote || '?' })} className="lg:col-span-2"
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={VIEWS} />
            {view === 'chart' && (m?.gmgn || src === 'gmgn') && <Segmented size="sm" aria="Sumber lilin" value={src} onChange={setSrc} options={SOURCES} />}
            {view !== 'dex' && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}
          </div>}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <div className="num text-2xl leading-tight font-semibold tracking-tight">
                {price(pNow)}{quote && <span className="ml-1.5 text-sm font-medium text-muted">{quote}</span>}
                {move != null && <span className={`ml-2 text-sm font-medium ${tone(move)}`}>{pct(move, 1)}</span>}
              </div>
              <div className="text-xs text-muted">
                {pEntry != null ? t('masuk di {p} · {d}', { p: price(pEntry), d: fmtDate(p.opened_ts) }) : t('masuk {d}', { d: fmtDate(p.opened_ts) })}
                {closed && <> · {t('keluar {d}', { d: fmtDate(p.closed_ts) })}</>}
              </div>
            </div>
            <div className="text-end text-xs">
              <div className="text-muted">{t('Rentang posisi')}</div>
              <div className="num font-medium">{full ? t('Seluruh rentang') : <>{price(pLo)} <span className="text-muted">–</span> {price(pHi)}</>}</div>
              {edge && <div className={edge.ok ? 'text-success' : 'text-warning'}>{edge.text}</div>}
            </div>
          </div>
          {bep && <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
            <div className="font-medium">{t('Harga BEP')}: {bep.price > 0 ? <span className="num">{price(bep.price)} {quote}{pNow > 0 && <span className="ml-2 text-xs">({pct((bep.price / pNow - 1) * 100, 2)} {t('dari harga sekarang')})</span>}</span> : t(bep.reason)}</div>
            <p className="mt-1 text-xs text-muted">{t('Estimasi termasuk fee saat ini dan hasil penarikan; tanpa fee mendatang, gas, dan slippage.')}</p>
          </div>}
          {view === 'dex' ? <DexEmbed pool={p.pool_ref} /> : view === 'gmgn' ? <GmgnEmbed token={p.baseToken} tf={tf} p={p} pair={m?.pair} /> : !m ? <Loading /> : <PriceChart p={p} m={m} tf={tf} />}
          <TradesTape pool={p.pool_ref} token={p.baseToken} base={base} quote={quote} live={!closed} />
        </Panel>

        <div className="grid gap-3">
          {/* The copied wallet's numbers, above this position's numbers — the same question
              is answered in the same place as in the history drawer. */}
          <TargetSide p={p} className="" onRefresh={reload} />
          <Panel title="Posisi ini" bodyClass="px-4 py-1">
            <div className="divide-y divide-border">
              <KV label="Rentang">
                <div className="flex flex-col items-end gap-1">
                  <PriceRange position={p} lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide}
                    symbol0={p.symbol0} symbol1={p.symbol1} entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />
                </div>
              </KV>
              {!full && <KV label="Lebar rentang">{t('{w}% ({x}×)', { w: num(widthPct(p.tick_lower, p.tick_upper), 0), x: (pHi / pLo).toFixed(2) })}</KV>}
              <KV label="Fee diklaim sebelumnya">{usd(p.claimedUsd || 0)}</KV>
              <KV label="Tick"><span className="mono">{p.tick_lower} … {p.tick_upper}{p.curTick != null && !closed && <span className="text-muted"> · {t('kini')} {p.curTick}</span>}</span></KV>
              <KV label={closed ? 'Diterima saat keluar' : 'Isi sekarang'}>
                <div className="flex flex-col items-end">
                  <span>{fmtQty(amt0)} <TokenSym address={p.token0} symbol={p.symbol0} className="font-normal text-muted" /></span>
                  <span>{fmtQty(amt1)} <TokenSym address={p.token1} symbol={p.symbol1} className="font-normal text-muted" /></span>
                </div>
              </KV>
              {!closed && (
                <KV label="Fee belum diklaim">
                  <div className="flex flex-col items-end">
                    <span className={fee0 > 0 ? 'text-success' : ''}>{fmtQty(fee0)} <TokenSym address={p.token0} symbol={p.symbol0} className="font-normal text-muted" /></span>
                    <span className={fee1 > 0 ? 'text-success' : ''}>{fmtQty(fee1)} <TokenSym address={p.token1} symbol={p.symbol1} className="font-normal text-muted" /></span>
                  </div>
                </KV>
              )}
              <KV label="Modal disetor">
                <div className="flex flex-col items-end">
                  <span>{fmtQty(cost0)} <TokenSym address={p.token0} symbol={p.symbol0} className="font-normal text-muted" /></span>
                  <span>{fmtQty(cost1)} <TokenSym address={p.token1} symbol={p.symbol1} className="font-normal text-muted" /></span>
                </div>
              </KV>
              {p.cost?.txN > 0 && (
                <KV label="Ongkos buka / tutup">
                  <div className="flex flex-col items-end text-xs">
                    <span>{t('buka')} <span className="num">{usd(p.cost.open.gasUsd + p.cost.open.slipUsd)}</span>
                      <span className="ml-1 font-normal text-muted">({t('{n} tx', { n: p.cost.open.txN })})</span></span>
                    <span>{t('tutup')} <span className="num">{usd(p.cost.close.gasUsd + p.cost.close.slipUsd)}</span>
                      <span className="ml-1 font-normal text-muted">({t('{n} tx', { n: p.cost.close.txN })})</span></span>
                    {p.cost.pctOfCost != null && <span className="font-normal text-muted">{pct(p.cost.pctOfCost, 2).replace('+', '')} {t('dari modal')}</span>}
                  </div>
                </KV>
              )}
              <KV label="Dibuka">{fmtDate(p.opened_ts)}<span className="ml-1 font-normal text-muted">({ago(p.opened_ts)})</span></KV>
              {closed && <KV label="Ditutup">{fmtDate(p.closed_ts)}</KV>}
              {p.tx_open && <KV label="Tx buka"><span className="mono" title={p.tx_open}>{short(p.tx_open)}</span></KV>}
              {p.tx_close && <KV label="Tx tutup"><span className="mono" title={p.tx_close}>{short(p.tx_close)}</span></KV>}
              {p.hooks && !/^0x0{40}$/.test(p.hooks) && <KV label="Hook"><span className="mono">{short(p.hooks)}</span></KV>}
            </div>
          </Panel>
          <Panel title="Pasar" desc="DexScreener · diperbarui tiap 30 detik" bodyClass="p-0">
            <MarketPanel pair={m?.pair} pool={p.pool_ref} />
          </Panel>
          {!closed && p.empty && <Notice status="warning" title="Likuiditas sudah nol di chain">{t('Posisi ini akan ditandai tertutup pada sinkronisasi berikutnya.')}</Notice>}
        </div>
      </div>
    </>
  );
}
