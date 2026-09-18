// Detail satu posisi LP: grafik harga pool dengan rentang posisi dan titik masuk
// ditandai, statistik pasar (DexScreener), dan isi posisi (token, fee, modal).
//
// Grafiknya digambar sendiri dari lilin GeckoTerminal, bukan cuma menyematkan
// DexScreener: yang ingin dilihat pemilik posisi bukan hanya harga, tetapi "di mana
// rentang saya, kapan saya masuk, dan seberapa jauh harga dari tepi" — dan iframe
// pihak ketiga tidak bisa digambari. Tampilan DexScreener tetap tersedia sebagai
// pilihan kedua untuk melihat transaksi dan indikator lain.
import { useCallback, useMemo, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { breakEven } from '../breakeven';
import AdvancedChart from '../components/AdvancedChart';
import { useLivePrice, useLiveCandles, LIVE_MS } from '../liveCandles';
import { usePoll, useResync } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { useClaimFees } from '../useClaimFees';
import AutoCompoundButton from '../components/AutoCompoundButton';
import TakeoverButton from '../components/TakeoverButton';
import ShareButton, { positionCard } from '../components/ShareCard';
import { Panel, Stat, KV, Dot, Empty, Loading, Notice, Segmented, PriceRange, Refresh, ask } from '../components/ui';
import { TokenPair, TokenSym, PairName } from '../components/TokenIcon';
import { usd, pct, tone, num, age, ago, short, price, tickPrice, sqrtPrice, widthPct, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

export const TFS = [['5m', '5 mnt'], ['15m', '15 mnt'], ['1h', '1 jam'], ['4h', '4 jam'], ['1d', '1 hari']];
export const SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
export const VIEWS = [['chart', 'Grafik'], ['dex', 'DexScreener']];

// Rentang lilin dipilih supaya titik masuk masih terlihat: posisi berumur 50 menit
// dilihat per 5 menit, posisi berumur seminggu per 4 jam.
export const tfFor = (ageHours) => {
  const s = (ageHours || 0) * 3600;
  for (const tf of ['5m', '15m', '1h', '4h']) if (s / SECS[tf] <= 400) return tf;
  return '1d';
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const qty = (raw, dec) => (raw == null ? null : Number(raw) / 10 ** (dec ?? 18));
const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(fmtLocale(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));
export const kUsd = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? usd(v / 1e6, 2) + 'M' : Math.abs(v) >= 1e4 ? usd(v / 1e3, 1) + 'k' : usd(v));

// GeckoTerminal diminta memakai token spekulatif sebagai dasar harga; kalau ia
// membalasnya terbalik (atau dasar pool berbeda), lilin dibalik supaya searah
// dengan harga tick pool. Dicek terhadap harga acuan (ref) kalau ada: arah yang
// paling dekat menang.
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

// Grafik lilin + rentang posisi + penanda masuk/keluar. Dipakai juga halaman pool:
// tanpa posisi (tick_lower null) yang tergambar hanya lilin dan harga kini.
export function PriceChart({ p, m, tf }) {
  const { t } = useI18n();
  const at = (tick) => tickPrice(tick, p.dec0, p.dec1, p.quoteSide);
  const hasRange = p.tick_lower != null && p.tick_upper != null;
  const full = hasRange && p.tick_lower <= -880000 && p.tick_upper >= 880000;
  const a = hasRange ? at(p.tick_lower) : null, b = hasRange ? at(p.tick_upper) : null;
  const range = hasRange && !full ? { lo: Math.min(a, b), hi: Math.max(a, b) } : null;
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pExit = sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide);
  // Posisi yang sudah ditutup dilihat sebagai riwayat: tanpa harga live.
  const live = useLivePrice(p.pool_ref, p, p.status !== 'closed');
  const pNow = live?.price ?? (p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : (p.curTick != null ? at(p.curTick) : null));

  const oriented = useMemo(() => orientCandles(m?.ohlcv, p.baseToken, pNow ?? pEntry), [m, p.baseToken, pNow, pEntry]);
  const candles = useLiveCandles(oriented, SECS[tf], live, `${p.pool_ref}:${tf}`);

  if (m?.ohlcv?.error) return <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />;
  if (!candles.length) return <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />;

  const bep = breakEven(p);
  const closed = p.status === 'closed';
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  return (
    <div>
      {bep && <p className="mb-2 text-xs text-warning">
        {t('Harga BEP')}: {bep.price > 0 ? <>{price(bep.price)} {quote}{pNow > 0 && <> · {pct((bep.price / pNow - 1) * 100, 2)} {t('dari harga sekarang')}</>}</> : t(bep.reason)}
      </p>}
      <AdvancedChart key={`${p.pool_ref || p.baseToken || "pool"}:${p.id || "none"}:${tf}`}
        candles={candles} tf={tf} quote={quote} poolRef={p.pool_ref || p.baseToken || null} range={range}
        entry={p.opened_ts || pEntry != null ? { t: p.opened_ts, p: pEntry } : null}
        exit={closed ? { t: p.closed_ts, p: pExit } : null}
        now={closed ? null : pNow} bep={bep?.price} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {range && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('rentang posisi')}</span>}
        {p.opened_ts && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-px border-l-2 border-dashed border-accent" />{t('saat masuk')}</span>}
        {pEntry != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-px w-4 border-t border-dashed border-muted" />{t('harga masuk')}</span>}
        {bep?.price > 0 && <span className="inline-flex items-center gap-1.5 text-warning"><span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-warning" />BEP {price(bep.price)} {quote}</span>}
        {full && <span>{t('Seluruh rentang')}</span>}
        <span className="ml-auto inline-flex items-center gap-3">
          {live && <LiveBadge />}
          {t('lilin {tf} · GeckoTerminal', { tf })}
        </span>
      </div>
    </div>
  );
}

// Penanda bahwa lilin terakhir digerakkan harga chain, bukan menunggu GeckoTerminal.
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
      <iframe title="DexScreener" src={`https://dexscreener.com/robinhood/${pool}?${q}`}
        className="block h-[520px] w-full bg-surface" allow="clipboard-write" loading="lazy" />
    </div>
  );
}

// Perubahan harga per jendela waktu dari DexScreener — satu baris chip kecil.
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
  const { claim, claiming } = useClaimFees(reload);
  const tf = tfPick || (p ? tfFor(p.ageHours) : '1h');
  // Cukup lilin supaya titik masuk terlihat, plus sedikit sebelum masuk sebagai konteks.
  // Posisi yang sudah ditutup dibingkai di sekitar masa hidupnya: sedikit setelah
  // keluar, bukan sampai sekarang.
  const span = p ? p.ageHours * 3600 : 0;
  const tail = p?.status === 'closed' ? Math.max(20, Math.ceil((span * 0.2) / SECS[tf])) : 0;
  const limit = p ? Math.min(1000, Math.max(120, Math.ceil(span / SECS[tf]) + 40 + tail)) : 200;
  const before = p?.status === 'closed' && p.closed_ts ? p.closed_ts + tail * SECS[tf] * 1000 : null;
  const { data: m, reload: reloadMarket } = usePoll(p ? `/api/market?pool=${p.pool_ref}&tf=${tf}&limit=${limit}&token=${p.baseToken || ''}${before ? `&before=${before}` : ''}` : null, 30000);
  // "Perbarui detail" memaksa sinkron chain dulu — angka nilai/fee/PnL di halaman ini
  // berasal dari sinkron terakhir, jadi memuat ulang saja mengembalikan angka yang sama.
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
          {/* posisi tertutup: angkanya sudah final, jadi tidak ada jam kesegaran — tombolnya
              cuma menyegarkan grafik pasar. */}
          {/* Satu klaster aksi, rapat di kanan, tinggi seragam: jam kesegaran + perbarui
              (pasif) dipisah garis tipis dari aksi yang mengirim transaksi. Urutannya
              dari yang paling aman ke yang paling merusak, dan hanya "Tutup posisi"
              yang berwarna — supaya mata langsung tahu mana yang tidak bisa dibatalkan. */}
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
        <Stat label={closed ? 'Hasil' : 'Nilai'} value={usd(closed ? p.outUsd : p.valueUsd)} sub={t('modal {v}', { v: usd(p.costUsd) })} />
        <Stat label={closed ? 'Fee (sudah diklaim)' : 'Fee belum diklaim'} value={closed ? '—' : usd(p.feeUsd)} valueClass={!closed && p.feeUsd > 0.005 ? 'text-success' : ''}
          sub={!closed && p.costUsd > 0 ? t('{p}% dari modal', { p: num((p.feeUsd / p.costUsd) * 100, 2) }) : null} />
        <Stat label="PnL" value={usd(p.pnlUsd)} valueClass={tone(p.pnlUsd)}
          sub={<span>{pct(p.pnlPct, 2)}{p.ilUsd != null && <> · IL <span className={tone(p.ilUsd)}>{usd(p.ilUsd)}</span></>}</span>} />
        <Stat label={closed ? 'Ditahan' : 'Umur'} value={age(p.ageHours)} sub={t('masuk {d}', { d: fmtDate(p.opened_ts) })} />
        {/* Ongkos jalan: gas + selisih swap. Tidak ikut dihitung di PnL, padahal
            inilah harga yang dibayar untuk masuk dan keluar posisi ini. */}
        <Stat label="Ongkos jalan" value={p.cost?.txN ? usd(p.cost.totalUsd) : '—'} valueClass={p.cost?.totalUsd > 0.005 ? 'text-warning' : ''}
          sub={p.cost?.txN
            ? t('gas {g} · slippage {s}', { g: usd(p.cost.gasUsd, p.cost.gasUsd < 0.1 ? 3 : 2), s: usd(p.cost.slipUsd) })
            : t('belum ada transaksi')} />
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
          {bep && <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
            <div className="font-medium">{t('Harga BEP')}: {bep.price > 0 ? <span className="num">{price(bep.price)} {quote}{pNow > 0 && <span className="ml-2 text-xs">({pct((bep.price / pNow - 1) * 100, 2)} {t('dari harga sekarang')})</span>}</span> : t(bep.reason)}</div>
            <p className="mt-1 text-xs text-muted">{t('Estimasi termasuk fee saat ini dan hasil penarikan; tanpa fee mendatang, gas, dan slippage.')}</p>
          </div>}
          {view === 'dex' ? <DexEmbed pool={p.pool_ref} /> : !m ? <Loading /> : <PriceChart p={p} m={m} tf={tf} />}
        </Panel>

        <div className="grid gap-3">
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
