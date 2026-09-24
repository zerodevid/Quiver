// Detail satu pool (pasangan) — padanan halaman pair DexScreener, dibuka dari nama
// pasangan di mana pun di dasbor: #pool/<poolId v4 | alamat pool v3>.
//
// Memakai ulang grafik dan panel pasar dari halaman detail posisi. Kalau bot pernah
// membuka posisi di pool ini, posisi itu digambar di grafik (rentang + titik masuk)
// dan tabelnya menunjukkan PnL tiap posisi serta totalnya.
import LiquidityRisk from '../components/LiquidityRisk';
import PoolHealth from '../components/PoolHealth';
import PositionHistory from '../components/PositionHistory';
import WalletPositionHistory from '../components/WalletPositionHistory';
import { useEffect, useState } from 'react';
import { usePoll } from '../hooks';
import { Panel, Stat, KV, Empty, Loading, Segmented, CopyAddr, BackLink, TradeLinks, DataLinks } from '../components/ui';
import { TokenPair, TokenSym } from '../components/TokenIcon';
import { BotPositions, WalletPositions, TargetMoves, wkey } from '../components/LpTables';
import { PriceChart, DexEmbed, GmgnEmbed, TradesTape, MarketPanel, TFS, VIEWS, SOURCES, SECS, tfFor, kUsd, readSrc, writeSrc } from './PositionDetail';
import { GmgnWallets } from '../components/Gmgn';
import { BAND_COLORS } from '../components/CandleChart';
import { usd, pct, tone, num, price, sqrtPrice, tickPrice } from '../fmt';
import { useI18n } from '../i18n';

const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const DYNAMIC_FEE = 0x800000;   // penanda fee dinamis v4 (diatur hook)

export default function PoolDetail({ param }) {
  const { t } = useI18n();
  const ref = String(param || '').toLowerCase();
  const { data: d, loading, reload } = usePoll(`/api/pool?ref=${encodeURIComponent(ref)}`, 15000);
  // undefined = pilihan otomatis (posisi terbuka terbaru), null = tanpa posisi di grafik.
  const [focusPick, setFocus] = useState(undefined);
  const [tfPick, setTf] = useState(null);
  const [view, setView] = useState('chart');
  const [src, setSrcState] = useState(readSrc);
  const setSrc = (v) => { setSrcState(v); writeSrc(v); };
  // Klik baris tabel posisi -> laci riwayat, sama seperti halaman Posisi.
  const [hist, setHist] = useState(null);
  // Klik baris posisi wallet yang diriset -> laci kejadian on-chain-nya. Yang disimpan
  // kuncinya, supaya angka di laci ikut segar saat tabelnya dipoll ulang.
  const [whistKey, setWhist] = useState(null);
  // Tombol "Posisi asli" di tabel bot: baris tabel riset yang diminta ditunjukkan.
  const [jump, setJump] = useState(null);
  const jumpToSource = (w) => setJump((j) => ({ key: wkey(w), n: (j?.n || 0) + 1 }));
  // Dibuka dari baris tabel yang sudah digulir jauh: mulai dari atas.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const pool = d?.pool;
  const all = d ? [...d.open, ...d.closed] : [];
  const focus = focusPick === undefined ? (d?.open[0] || null) : all.find((p) => p.id === focusPick) || null;
  const tf = tfPick || (focus?.status === 'open' ? tfFor(focus.ageHours) : '1h');
  // Cukup lilin supaya titik masuk semua posisi yang digambar masih terlihat — bukan
  // hanya yang sedang disorot: pita posisi tertua pun mulai di lilin masuknya.
  const firstOpen = Math.min(...(d?.open || []).map((p) => p.opened_ts || Date.now()), focus?.opened_ts || Date.now());
  const sinceOpen = (Date.now() - firstOpen) / 1000;
  const limit = focus || d?.open.length ? Math.min(1000, Math.max(120, Math.ceil(sinceOpen / SECS[tf]) + 40)) : 240;
  const { data: m } = usePoll(pool ? `/api/market?pool=${ref}&tf=${tf}&limit=${limit}&token=${pool.baseToken || ''}${src === 'gmgn' ? '&src=gmgn' : ''}` : null, 30000);

  if (!d) return <Loading page />;
  if (d.error) return <Empty title="Pool tidak ditemukan" sub={d.error} />;
  const whist = whistKey ? d.wallets.find((p) => wkey(p) === whistKey) || null : null;

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

  // Grafik: semua rentang posisi terbuka bot di pool ini digambar sekaligus (seperti
  // kartu pool di halaman Monitor), warnanya urut menurut id supaya tidak berganti saat
  // daftar berubah. Posisi yang sedang disorot jadi pita pekat; yang lain tipis. Posisi
  // yang sudah ditutup hanya digambar kalau dia yang sedang disorot.
  const at = (tick) => tickPrice(tick, pool.dec0, pool.dec1, pool.quoteSide);
  const hasRange = (p) => p.tick_lower != null && p.tick_upper != null && !(p.tick_lower <= -880000 && p.tick_upper >= 880000);
  const band = (p, color) => {
    const a = at(p.tick_lower), b = at(p.tick_upper);
    return { id: p.id, lo: Math.min(a, b), hi: Math.max(a, b), color,
      label: p.token_id ? `#${p.token_id}` : `#${p.id}`, selected: focus?.id === p.id,
      from: p.opened_ts || null, to: p.status === 'closed' ? p.closed_ts || null : null };
  };
  // "sembunyikan" (focusPick === null) tetap berarti grafik bersih tanpa posisi.
  const openBands = focusPick === null ? [] : [...d.open].sort((a, b) => a.id - b.id).filter(hasRange);
  const ranges = openBands.map((p, i) => band(p, BAND_COLORS[i % BAND_COLORS.length]));
  if (focus && focus.status === 'closed' && hasRange(focus)) ranges.push(band(focus, BAND_COLORS[openBands.length % BAND_COLORS.length]));

  // Grafik: harga pool + (kalau ada) rentang dan titik masuk posisi yang dipilih.
  const chartP = {
    ...(focus || {}),
    pool_ref: ref,
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
          <div className="flex flex-wrap items-center gap-2">
            <DataLinks pool={ref} dexUrl={pair?.url} />
            <TradeLinks token={pool.baseToken} pool={ref} />
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label={t('Harga {b}', { b: base })} value={<>{price(pNow)}{quote && <span className="ml-1 text-sm font-medium text-muted">{quote}</span>}</>}
          sub={ch24 != null ? <span><span className={tone(ch24)}>{pct(ch24, 1)}</span> {t('24 jam')}</span> : pair?.priceUsd ? usd(pair.priceUsd, pair.priceUsd < 0.01 ? 6 : 4) : null} />
        <Stat label="Likuiditas pool" value={kUsd(pair?.liquidityUsd)} sub={pair ? t('volume 24 jam {v}', { v: kUsd(pair.volume?.h24) }) : null} />
        <Stat label="PnL bot di pool ini" value={all.length ? usd(upnl + realized) : '—'} fx={all.length ? upnl + realized : null} valueClass={all.length ? tone(upnl + realized) : ''}
          sub={t('{o} terbuka · {c} ditutup', { o: d.open.length, c: d.closed.length })} />
        <Stat label="Nilai posisi terbuka" value={d.open.length ? usd(openVal + openFee) : '—'} fx={d.open.length ? openVal + openFee : null} sub={d.open.length ? t('modal {v}', { v: usd(openCost) }) : null} />
      </div>

      <PoolHealth pool={{ ...pool, pool_ref: ref }} pair={pair} open={d.open} />

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel title={t('Harga {b} / {q}', { b: base, q: quote || '?' })} className="lg:col-span-2"
          desc={focus
            ? <span>{ranges.length > 1
                ? t('{n} rentang posisi bot · disorot #{id}', { n: ranges.length, id: focus.token_id || focus.id })
                : t('menampilkan posisi bot #{id}', { id: focus.token_id || focus.id })} · <button type="button" className="text-accent hover:underline" onClick={() => setFocus(null)}>{t('sembunyikan')}</button></span>
            : ranges.length ? <span>{t('{n} rentang posisi bot', { n: ranges.length })}</span> : null}
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={VIEWS} />
            {view === 'chart' && (m?.gmgn || src === 'gmgn') && <Segmented size="sm" aria="Sumber lilin" value={src} onChange={setSrc} options={SOURCES} />}
            {view !== 'dex' && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}
          </div>}>
          {view === 'dex' ? <DexEmbed pool={ref} /> : view === 'gmgn' ? <GmgnEmbed token={pool.baseToken} tf={tf} p={chartP} pair={m?.pair} /> : !m ? <Loading /> : <PriceChart p={chartP} m={m} tf={tf} ranges={ranges} onRangeClick={setFocus} />}
          <TradesTape pool={ref} token={pool.baseToken} base={base} quote={quote} />
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

      <div className="mt-4"><LiquidityRisk key={ref} pool={{ ...pool, pool_ref: ref }} focus={focus} /></div>
      <GmgnWallets address={pool.baseToken} kind="traders" symbol={base} className="mt-4" />

      <BotPositions open={d.open} closed={d.closed} onFocus={setFocus} focusId={focus?.id} onHist={setHist}
        reload={reload} wallets={d.wallets} onSource={jumpToSource} loading={loading} className="mt-4" />
      <PositionHistory id={hist} onClose={() => setHist(null)} />
      <WalletPositions rows={d.wallets} onHist={(p) => setWhist(wkey(p))} jumpTo={jump} loading={loading} className="mt-4" />
      <WalletPositionHistory p={whist} address={whist?.wallet} onClose={() => setWhist(null)} />
      <TargetMoves rows={d.activity} className="mt-4" />
    </>
  );
}
