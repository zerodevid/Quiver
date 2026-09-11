// Detail satu posisi LP: grafik harga pool dengan rentang posisi dan titik masuk
// ditandai, statistik pasar (DexScreener), dan isi posisi (token, fee, modal).
//
// Grafiknya digambar sendiri dari lilin GeckoTerminal, bukan cuma menyematkan
// DexScreener: yang ingin dilihat pemilik posisi bukan hanya harga, tetapi "di mana
// rentang saya, kapan saya masuk, dan seberapa jauh harga dari tepi" — dan iframe
// pihak ketiga tidak bisa digambari. Tampilan DexScreener tetap tersedia sebagai
// pilihan kedua untuk melihat transaksi dan indikator lain.
import { useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip as ReTooltip,
  CartesianGrid, ReferenceLine, ReferenceArea,
} from 'recharts';
import { usePoll } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { Panel, Stat, KV, Dot, Empty, Loading, Notice, Segmented, PriceRange, ask } from '../components/ui';
import { TokenPair } from '../components/TokenIcon';
import { usd, pct, tone, num, age, ago, short, price, tickPrice, sqrtPrice, widthPct, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const TFS = [['5m', '5 mnt'], ['15m', '15 mnt'], ['1h', '1 jam'], ['4h', '4 jam'], ['1d', '1 hari']];
const SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const VIEWS = [['chart', 'Grafik'], ['dex', 'DexScreener']];

// Rentang lilin dipilih supaya titik masuk masih terlihat: posisi berumur 50 menit
// dilihat per 5 menit, posisi berumur seminggu per 4 jam.
const tfFor = (ageHours) => {
  const s = (ageHours || 0) * 3600;
  for (const tf of ['5m', '15m', '1h', '4h']) if (s / SECS[tf] <= 400) return tf;
  return '1d';
};
const fmtT = (ts, tf) => (SECS[tf] >= 86400
  ? new Date(ts).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' })
  : new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const qty = (raw, dec) => (raw == null ? null : Number(raw) / 10 ** (dec ?? 18));
const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(fmtLocale(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));
const kUsd = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? usd(v / 1e6, 2) + 'M' : Math.abs(v) >= 1e4 ? usd(v / 1e3, 1) + 'k' : usd(v));

// Satu lilin. Bar-nya membentang low→high (sumbu), badan open→close dihitung dari
// proporsi di dalamnya — tanpa perlu akses ke skala sumbu.
function Candle({ x, y, width, height, payload }) {
  if (!payload || !(payload.h > 0)) return null;
  const { o, c, h, l } = payload;
  const span = h - l;
  const yOf = (v) => (span > 0 ? y + (height * (h - v)) / span : y);
  const yo = yOf(o), yc = yOf(c);
  const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yo - yc));
  const cx = x + width / 2;
  const color = c >= o ? 'var(--success)' : 'var(--danger)';
  const bw = Math.max(1.5, Math.min(9, width * 0.72));
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={cx - bw / 2} y={top} width={bw} height={bh} fill={color} />
    </g>
  );
}

function CandleTip({ active, payload, tf, quote }) {
  const { t } = useI18n();
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const chg = d.o > 0 ? ((d.c / d.o) - 1) * 100 : null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium">{fmtT(d.t, tf)}</div>
      <div className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-muted">O</span><span className="text-end">{price(d.o)}</span>
        <span className="text-muted">H</span><span className="text-end">{price(d.h)}</span>
        <span className="text-muted">L</span><span className="text-end">{price(d.l)}</span>
        <span className="text-muted">C</span><span className={`text-end ${tone(chg)}`}>{price(d.c)}{chg != null && <span className="ml-1">{pct(chg, 1)}</span>}</span>
        <span className="text-muted">{t('Vol')}</span><span className="text-end">{usd(d.v, 0)}</span>
      </div>
      {quote && <div className="mt-1 text-muted">{t('harga dalam {q}', { q: quote })}</div>}
    </div>
  );
}

// Grafik lilin + rentang posisi + penanda masuk/keluar.
function PriceChart({ p, m, tf }) {
  const { t } = useI18n();
  const at = (tick) => tickPrice(tick, p.dec0, p.dec1, p.quoteSide);
  const a = at(p.tick_lower), b = at(p.tick_upper);
  const [pLo, pHi] = a <= b ? [a, b] : [b, a];
  const full = p.tick_lower <= -880000 && p.tick_upper >= 880000;
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pExit = sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide);
  const pNow = p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : (p.curTick != null ? at(p.curTick) : null);

  const data = useMemo(() => {
    let cs = m?.ohlcv?.candles || [];
    if (!cs.length) return [];
    // GeckoTerminal diminta memakai token spekulatif sebagai dasar harga; kalau ia
    // membalasnya terbalik (atau dasar pool berbeda), lilin dibalik supaya searah
    // dengan rentang posisi. Dicek terhadap harga kini: arah yang paling dekat menang.
    const ref = pNow ?? pEntry;
    const inv = (c) => ({ t: c.t, o: 1 / c.o, h: 1 / c.l, l: 1 / c.h, c: 1 / c.c, v: c.v });
    const last = cs[cs.length - 1];
    let flip = m.ohlcv.base?.address && p.baseToken && m.ohlcv.base.address !== p.baseToken;
    if (ref > 0 && last?.c > 0) {
      const dOk = Math.abs(Math.log(last.c / ref)), dInv = Math.abs(Math.log((1 / last.c) / ref));
      if (Math.min(dOk, dInv) < 2) flip = dInv < dOk;
    }
    if (flip) cs = cs.map(inv);
    return cs.filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0);
  }, [m, p.baseToken, pNow, pEntry]);

  if (m?.ohlcv?.error) return <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />;
  if (!data.length) return <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />;

  // Penanda waktu dipasang pada lilin yang memuatnya (sumbu kategori).
  const snap = (ts) => {
    if (!ts) return null;
    const secs = SECS[tf] * 1000;
    let best = null;
    for (const c of data) { if (c.t <= ts && c.t + secs > ts) return c.t; if (c.t <= ts) best = c.t; }
    return best ?? data[0].t;
  };
  const tEntry = snap(p.opened_ts), tExit = p.status === 'closed' ? snap(p.closed_ts) : null;
  const before = p.opened_ts && data[0].t > p.opened_ts;   // masuk sebelum lilin pertama

  // Batas sumbu Y: lilin + harga masuk; rentang posisi ikut kalau tidak terlalu
  // lebar (rentang 10× akan meremas lilin jadi garis datar). Kalau tidak ikut, pita
  // rentang dipotong di tepi grafik — seluruh latar berarti "di dalam rentang".
  const vals = data.flatMap((c) => [c.l, c.h]);
  if (pEntry) vals.push(pEntry);
  if (pNow) vals.push(pNow);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const bandOk = !full && pHi / pLo < 3.5;
  if (bandOk) { lo = Math.min(lo, pLo); hi = Math.max(hi, pHi); }
  const pad = (hi - lo || lo * 0.1) * 0.06;
  const dom = [Math.max(0, lo - pad), hi + pad];
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const lblStyle = { fill: 'var(--muted)', fontSize: 10 };

  return (
    <div>
      <div className="h-80 sm:h-96">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" type="category" tickLine={false} axisLine={false} minTickGap={56} interval="preserveStartEnd"
              tick={{ fill: 'var(--muted)', fontSize: 11 }} tickFormatter={(v) => fmtT(v, tf)} />
            <YAxis domain={dom} width={68} tickLine={false} axisLine={false} orientation="right"
              tick={{ fill: 'var(--muted)', fontSize: 11 }} tickFormatter={(v) => price(v)} />
            <ReTooltip content={<CandleTip tf={tf} quote={quote} />} cursor={{ stroke: 'var(--border)' }} isAnimationActive={false} />
            {/* rentang posisi */}
            {!full && (
              <ReferenceArea y1={pLo} y2={pHi} ifOverflow="hidden" fill="var(--accent)" fillOpacity={0.1} stroke="var(--accent)" strokeOpacity={0.35} strokeDasharray="3 3"
                label={{ value: t('rentang'), position: 'insideTopLeft', ...lblStyle }} />
            )}
            {/* harga masuk (mendatar) & saat masuk (tegak) */}
            {pEntry != null && <ReferenceLine y={pEntry} ifOverflow="hidden" stroke="var(--muted)" strokeDasharray="2 3"
              label={{ value: t('masuk {p}', { p: price(pEntry) }), position: 'insideBottomLeft', ...lblStyle }} />}
            {tEntry != null && <ReferenceLine x={tEntry} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="5 3"
              label={{ value: before ? t('masuk (sebelum grafik)') : t('masuk'), position: before ? 'insideTopLeft' : 'insideTopRight', fill: 'var(--accent)', fontSize: 10, fontWeight: 500 }} />}
            {tExit != null && <ReferenceLine x={tExit} stroke="var(--warning)" strokeDasharray="4 3"
              label={{ value: t('keluar'), position: 'insideTopRight', fill: 'var(--warning)', fontSize: 10 }} />}
            {pExit != null && <ReferenceLine y={pExit} ifOverflow="hidden" stroke="var(--warning)" strokeDasharray="2 3" />}
            {/* harga kini */}
            {pNow != null && p.status !== 'closed' && <ReferenceLine y={pNow} ifOverflow="hidden" stroke="var(--foreground)" strokeOpacity={0.5} />}
            <Bar dataKey={(d) => [d.l, d.h]} shape={<Candle />} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {!full && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('rentang posisi')}</span>}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-px border-l-2 border-dashed border-accent" />{t('saat masuk')}</span>
        {pEntry != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-px w-4 border-t border-dashed border-muted" />{t('harga masuk')}</span>}
        {!bandOk && !full && <span>{t('rentang lebih lebar dari grafik — pita dipotong di tepi')}</span>}
        <span className="ml-auto">{t('lilin {tf} · GeckoTerminal', { tf })}</span>
      </div>
    </div>
  );
}

function DexEmbed({ pool }) {
  const dark = document.documentElement.classList.contains('dark');
  const q = new URLSearchParams({
    embed: '1', loadChartSettings: '0', trades: '0', tabs: '0', info: '0', chartLeftToolbar: '0',
    chartDefaultOnMobile: '1', chartTheme: dark ? 'dark' : 'light', theme: dark ? 'dark' : 'light',
    chartStyle: '1', chartType: 'usd', interval: '15',
  });
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <iframe title="DexScreener" src={`https://dexscreener.com/robinhood/${pool}?${q}`}
        className="block h-[520px] w-full bg-surface" allow="clipboard-write" loading="lazy" />
    </div>
  );
}

// Perubahan harga per jendela waktu dari DexScreener — satu baris chip kecil.
function Changes({ pc }) {
  const { t } = useI18n();
  const items = [['m5', '5 mnt'], ['h1', '1 jam'], ['h6', '6 jam'], ['h24', '24 jam']].filter(([k]) => pc?.[k] != null);
  if (!items.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-0.5">
      {items.map(([k, l]) => <span key={k} className="whitespace-nowrap"><span className="font-normal text-muted">{t(l)}</span> <span className={tone(pc[k])}>{pct(pc[k], 1)}</span></span>)}
    </span>
  );
}

function MarketPanel({ pair, pool }) {
  const { t } = useI18n();
  if (!pair) return <Loading />;
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
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-xs">
        <a href={pair.url || `https://dexscreener.com/robinhood/${pool}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">DexScreener <ExternalLink className="size-3" /></a>
        <a href={`https://www.geckoterminal.com/robinhood/pools/${pool}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">GeckoTerminal <ExternalLink className="size-3" /></a>
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
  const { close, closing } = useClosePosition(reload);
  const tf = tfPick || (p ? tfFor(p.ageHours) : '1h');
  // Cukup lilin supaya titik masuk terlihat, plus sedikit sebelum masuk sebagai konteks.
  // Posisi yang sudah ditutup dibingkai di sekitar masa hidupnya: sedikit setelah
  // keluar, bukan sampai sekarang.
  const span = p ? p.ageHours * 3600 : 0;
  const tail = p?.status === 'closed' ? Math.max(20, Math.ceil((span * 0.2) / SECS[tf])) : 0;
  const limit = p ? Math.min(1000, Math.max(120, Math.ceil(span / SECS[tf]) + 40 + tail)) : 200;
  const before = p?.status === 'closed' && p.closed_ts ? p.closed_ts + tail * SECS[tf] * 1000 : null;
  const { data: m } = usePoll(p ? `/api/market?pool=${p.pool_ref}&tf=${tf}&limit=${limit}&token=${p.baseToken || ''}${before ? `&before=${before}` : ''}` : null, 30000);

  if (!d) return <Loading />;
  if (d.error) return <Empty title="Posisi tidak ditemukan" sub={d.error} />;

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
  const pair = `${p.symbol0}/${p.symbol1}`;

  // Jarak ke tepi terdekat, dalam persen pergerakan harga.
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
          <div className="flex min-w-0 items-center gap-3">
            <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={30} />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{pair}</h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                <span>Uniswap {String(p.venue).toUpperCase()}</span><span>·</span>
                <span className="num">{t('fee {f}%', { f: num(p.fee / 10000, 2) })}</span>
                {p.token_id && <><span>·</span><span className="mono">#{p.token_id}</span></>}
                <span>·</span>
                {closed
                  ? <span>{t('ditutup {w}', { w: ago(p.closed_ts) })}</span>
                  : p.inRange != null
                    ? <><Dot tone={p.inRange ? 'success' : 'warning'} /><span className={p.inRange ? 'text-success' : 'text-warning'}>{t(p.inRange ? 'in-range' : 'di luar rentang')}</span></>
                    : <span>{t('belum tersinkron')}</span>}
                {p.target
                  ? <><span>·</span><a href={'#targets/' + p.target} className="hover:underline">{t('menyalin')} {p.targetLabel || <span className="mono">{short(p.target)}</span>}</a></>
                  : <><span>·</span><span>{t('di luar bot')}</span></>}
              </div>
            </div>
          </div>
          {!closed && !p.empty && <Button variant="danger-soft" isPending={closing != null} onPress={() => close(p)}>{t('Tutup posisi')}</Button>}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label={closed ? 'Hasil' : 'Nilai'} value={usd(closed ? p.outUsd : p.valueUsd)} sub={t('modal {v}', { v: usd(p.costUsd) })} />
        <Stat label={closed ? 'Fee (sudah diklaim)' : 'Fee belum diklaim'} value={closed ? '—' : usd(p.feeUsd)} valueClass={!closed && p.feeUsd > 0.005 ? 'text-success' : ''}
          sub={!closed && p.costUsd > 0 ? t('{p}% dari modal', { p: num((p.feeUsd / p.costUsd) * 100, 2) }) : null} />
        <Stat label="PnL" value={usd(p.pnlUsd)} valueClass={tone(p.pnlUsd)}
          sub={<span>{pct(p.pnlPct, 2)}{p.ilUsd != null && <> · IL <span className={tone(p.ilUsd)}>{usd(p.ilUsd)}</span></>}</span>} />
        <Stat label={closed ? 'Ditahan' : 'Umur'} value={age(p.ageHours)} sub={t('masuk {d}', { d: fmtDate(p.opened_ts) })} />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel title={t('Harga {b} / {q}', { b: base, q: quote || '?' })} className="lg:col-span-2"
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={VIEWS} />
            {view === 'chart' && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}
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
          {view === 'dex' ? <DexEmbed pool={p.pool_ref} /> : !m ? <Loading /> : <PriceChart p={p} m={m} tf={tf} />}
        </Panel>

        <div className="grid gap-3">
          <Panel title="Posisi ini" bodyClass="px-4 py-1">
            <div className="divide-y divide-border">
              <KV label="Rentang">
                <div className="flex flex-col items-end gap-1">
                  <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide}
                    symbol0={p.symbol0} symbol1={p.symbol1} entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />
                </div>
              </KV>
              {!full && <KV label="Lebar rentang">{t('{w}% ({x}×)', { w: num(widthPct(p.tick_lower, p.tick_upper), 0), x: (pHi / pLo).toFixed(2) })}</KV>}
              <KV label="Tick"><span className="mono">{p.tick_lower} … {p.tick_upper}{p.curTick != null && !closed && <span className="text-muted"> · {t('kini')} {p.curTick}</span>}</span></KV>
              <KV label={closed ? 'Diterima saat keluar' : 'Isi sekarang'}>
                <div className="flex flex-col items-end">
                  <span>{fmtQty(amt0)} <span className="font-normal text-muted">{p.symbol0}</span></span>
                  <span>{fmtQty(amt1)} <span className="font-normal text-muted">{p.symbol1}</span></span>
                </div>
              </KV>
              {!closed && (
                <KV label="Fee belum diklaim">
                  <div className="flex flex-col items-end">
                    <span className={fee0 > 0 ? 'text-success' : ''}>{fmtQty(fee0)} <span className="font-normal text-muted">{p.symbol0}</span></span>
                    <span className={fee1 > 0 ? 'text-success' : ''}>{fmtQty(fee1)} <span className="font-normal text-muted">{p.symbol1}</span></span>
                  </div>
                </KV>
              )}
              <KV label="Modal disetor">
                <div className="flex flex-col items-end">
                  <span>{fmtQty(cost0)} <span className="font-normal text-muted">{p.symbol0}</span></span>
                  <span>{fmtQty(cost1)} <span className="font-normal text-muted">{p.symbol1}</span></span>
                </div>
              </KV>
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
