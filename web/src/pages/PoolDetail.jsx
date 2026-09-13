// Detail satu pool (pasangan) — padanan halaman pair DexScreener, dibuka dari nama
// pasangan di mana pun di dasbor: #pool/<poolId v4 | alamat pool v3>.
//
// Memakai ulang grafik dan panel pasar dari halaman detail posisi. Kalau bot pernah
// membuka posisi di pool ini, posisi itu digambar di grafik (rentang + titik masuk)
// dan tabelnya menunjukkan PnL tiap posisi serta totalnya.
import { useEffect, useState } from 'react';
import { usePoll } from '../hooks';
import { Panel, Stat, KV, Empty, Loading, Segmented, CopyAddr, BackLink, ExtLink } from '../components/ui';
import { TokenPair, TokenSym } from '../components/TokenIcon';
import { BotPositions, WalletPositions, TargetMoves } from '../components/LpTables';
import { PriceChart, DexEmbed, MarketPanel, TFS, VIEWS, SECS, tfFor, kUsd } from './PositionDetail';
import { usd, pct, tone, num, price, sqrtPrice, tickPrice } from '../fmt';
import { useI18n } from '../i18n';

const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const DYNAMIC_FEE = 0x800000;   // penanda fee dinamis v4 (diatur hook)

export default function PoolDetail({ param }) {
  const { t } = useI18n();
  const ref = String(param || '').toLowerCase();
  const { data: d, loading } = usePoll(`/api/pool?ref=${encodeURIComponent(ref)}`, 15000);
  // undefined = pilihan otomatis (posisi terbuka terbaru), null = tanpa posisi di grafik.
  const [focusPick, setFocus] = useState(undefined);
  const [tfPick, setTf] = useState(null);
  const [view, setView] = useState('chart');
  // Dibuka dari baris tabel yang sudah digulir jauh: mulai dari atas.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const pool = d?.pool;
  const all = d ? [...d.open, ...d.closed] : [];
  const focus = focusPick === undefined ? (d?.open[0] || null) : all.find((p) => p.id === focusPick) || null;
  const tf = tfPick || (focus?.status === 'open' ? tfFor(focus.ageHours) : '1h');
  // Cukup lilin supaya titik masuk posisi yang digambar masih terlihat.
  const sinceOpen = focus?.opened_ts ? (Date.now() - focus.opened_ts) / 1000 : 0;
  const limit = focus ? Math.min(1000, Math.max(120, Math.ceil(sinceOpen / SECS[tf]) + 40)) : 240;
  const { data: m } = usePoll(pool ? `/api/market?pool=${ref}&tf=${tf}&limit=${limit}&token=${pool.baseToken || ''}` : null, 30000);

  if (!d) return <Loading page />;
  if (d.error) return <Empty title="Pool tidak ditemukan" sub={d.error} />;

  const quote = pool.quoteSide === 0 ? pool.symbol0 : pool.quoteSide === 1 ? pool.symbol1 : null;
  const base = pool.quoteSide === 0 ? pool.symbol1 : pool.symbol0;
  const pNow = pool.curSqrt ? sqrtPrice(pool.curSqrt, pool.dec0, pool.dec1, pool.quoteSide)
    : pool.curTick != null ? tickPrice(pool.curTick, pool.dec0, pool.dec1, pool.quoteSide) : null;
  const pair = m?.pair && !m.pair.error ? m.pair : null;
  const ch24 = pair?.priceChange?.h24;
  const hasHook = pool.hooks && !/^0x0{40}$/.test(pool.hooks);

  // Ringkasan posisi bot di pool ini.
  const openVal = sum(d.open, (p) => p.valueUsd), openFee = sum(d.open, (p) => p.feeUsd), openCost = sum(d.open, (p) => p.costUsd);
  const upnl = sum(d.open, (p) => p.pnlUsd), realized = sum(d.closed, (p) => p.pnlUsd);
  const wins = d.closed.filter((p) => p.pnlUsd > 0).length;

  // Grafik: harga pool + (kalau ada) rentang dan titik masuk posisi yang dipilih.
  const chartP = {
    ...(focus || {}),
    dec0: pool.dec0, dec1: pool.dec1, quoteSide: pool.quoteSide, symbol0: pool.symbol0, symbol1: pool.symbol1,
    baseToken: pool.baseToken, curSqrt: pool.curSqrt, curTick: pool.curTick,
    tick_lower: focus?.tick_lower ?? null, tick_upper: focus?.tick_upper ?? null,
    status: focus?.status || 'open',
  };

  return (
    <>
      <div className="mb-5 border-b border-border pb-4">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="detail-heading flex min-w-0 max-w-full items-center gap-3">
            <TokenPair token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} size={30} />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">
                <TokenSym address={pool.token0} symbol={pool.symbol0} />/<TokenSym address={pool.token1} symbol={pool.symbol1} />
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                <span>Uniswap {String(pool.venue || '').toUpperCase()}</span>
                {pool.fee != null && <><span>·</span><span className="num">{pool.fee >= DYNAMIC_FEE ? t('fee dinamis') : t('fee {f}%', { f: num(pool.fee / 10000, 2) })}</span></>}
                {hasHook && <><span>·</span><span className="text-warning" title={pool.hooks}>{t('pakai hook')}</span></>}
                <span>·</span><CopyAddr address={ref} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <ExtLink href={pair?.url || `https://dexscreener.com/robinhood/${ref}`}>DexScreener</ExtLink>
            <ExtLink href={`https://www.geckoterminal.com/robinhood/pools/${ref}`}>GeckoTerminal</ExtLink>
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label={t('Harga {b}', { b: base })} value={<>{price(pNow)}{quote && <span className="ml-1 text-sm font-medium text-muted">{quote}</span>}</>}
          sub={ch24 != null ? <span><span className={tone(ch24)}>{pct(ch24, 1)}</span> {t('24 jam')}</span> : pair?.priceUsd ? usd(pair.priceUsd, pair.priceUsd < 0.01 ? 6 : 4) : null} />
        <Stat label="Likuiditas pool" value={kUsd(pair?.liquidityUsd)} sub={pair ? t('volume 24 jam {v}', { v: kUsd(pair.volume?.h24) }) : null} />
        <Stat label="PnL bot di pool ini" value={all.length ? usd(upnl + realized) : '—'} valueClass={all.length ? tone(upnl + realized) : ''}
          sub={t('{o} terbuka · {c} ditutup', { o: d.open.length, c: d.closed.length })} />
        <Stat label="Nilai posisi terbuka" value={d.open.length ? usd(openVal + openFee) : '—'} sub={d.open.length ? t('modal {v}', { v: usd(openCost) }) : null} />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel title={t('Harga {b} / {q}', { b: base, q: quote || '?' })} className="lg:col-span-2"
          desc={focus
            ? <span>{t('menampilkan posisi bot #{id}', { id: focus.token_id || focus.id })} · <button type="button" className="text-accent hover:underline" onClick={() => setFocus(null)}>{t('sembunyikan')}</button></span>
            : null}
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={VIEWS} />
            {view === 'chart' && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}
          </div>}>
          {view === 'dex' ? <DexEmbed pool={ref} /> : !m ? <Loading /> : <PriceChart p={chartP} m={m} tf={tf} />}
        </Panel>

        <div className="grid gap-3">
          <Panel title="Posisi bot di pool ini" bodyClass="px-4 py-1">
            {all.length === 0
              ? <div className="py-3 text-sm text-muted">{t('Bot belum pernah membuka posisi di pool ini.')}</div>
              : (
                <div className="divide-y divide-border">
                  <KV label="Terbuka">{d.open.length}</KV>
                  {d.open.length > 0 && <>
                    <KV label="Modal">{usd(openCost)}</KV>
                    <KV label="Nilai kini">{usd(openVal)}</KV>
                    <KV label="Fee belum diklaim"><span className={openFee > 0.005 ? 'text-success' : ''}>{usd(openFee)}</span></KV>
                    <KV label="uPnL"><span className={tone(upnl)}>{usd(upnl)}{openCost > 0 && <span className="ml-1 text-xs">{pct((upnl / openCost) * 100, 2)}</span>}</span></KV>
                  </>}
                  <KV label="Ditutup">{d.closed.length}{d.closed.length > 0 && <span className="ml-1 font-normal text-muted">({t('{w} untung', { w: wins })})</span>}</KV>
                  {d.closed.length > 0 && <KV label="PnL terealisasi"><span className={tone(realized)}>{usd(realized)}</span></KV>}
                </div>
              )}
          </Panel>
          <Panel title="Pasar" desc="DexScreener · diperbarui tiap 30 detik" bodyClass="p-0">
            <MarketPanel pair={m?.pair} pool={ref} />
          </Panel>
        </div>
      </div>

      <BotPositions open={d.open} closed={d.closed} onFocus={setFocus} focusId={focus?.id} loading={loading} className="mt-4" />
      <WalletPositions rows={d.wallets} loading={loading} className="mt-4" />
      <TargetMoves rows={d.activity} className="mt-4" />
    </>
  );
}
