// Detail satu token: harga & grafik lilin (dari pool yang dipilih, default yang
// paling likuid), semua pool-nya menurut DexScreener, posisi bot yang memakainya,
// posisi wallet yang pernah diriset, dan gerakan target di token ini.
//
// Dibuka dari lambang atau simbol token di mana pun di dasbor: #token/0x….
import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import AdvancedChart from '../components/AdvancedChart';
import { usePoll } from '../hooks';
import { Panel, Stat, KV, Empty, Loading, Segmented, DataTable, CopyAddr, BackLink, ExtLink, TradeLinks, DataLinks } from '../components/ui';
import TokenIcon, { TokenPair, PairName } from '../components/TokenIcon';
import { GmgnTokenPanel, GmgnWallets } from '../components/Gmgn';
import { BotPositions, WalletPositions, TargetMoves, wkey } from '../components/LpTables';
import PositionHistory from '../components/PositionHistory';
import WalletPositionHistory from '../components/WalletPositionHistory';
import { MarketPanel, kUsd } from './PositionDetail';
import { usd, pct, tone, num, age, short, price, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const TFS = [['5m', '5 mnt'], ['15m', '15 mnt'], ['1h', '1 jam'], ['4h', '4 jam'], ['1d', '1 hari']];
// Kira-kira satu hari per 5 menit, sepuluh hari per jam, sebulan per 4 jam.
const LIMIT = { '5m': 288, '15m': 288, '1h': 240, '4h': 180, '1d': 180 };

// Harga USD token ini di satu pool. DexScreener memberi harga token DASAR; kalau
// token ini justru sisi kuotasinya (mis. USDG), harganya = harga dasar ÷ harga
// dasar dalam kuotasi.
const priceIn = (p, a) => (!p ? null : p.base.address === a ? p.priceUsd
  : p.priceUsd && p.priceNative ? p.priceUsd / p.priceNative : null);
const venueOf = (p) => (p.labels?.length ? p.labels.join(' ') : p.dexId || '');
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const fmtAmt = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(fmtLocale(), { maximumSignificantDigits: v >= 1000 ? 7 : 5 }));

function TokenChart({ m, tf, poolRef }) {
  if (m?.ohlcv?.error) return <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />;
  if (!m?.ohlcv?.candles?.length) return <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />;
  // key={tf}: ganti rentang lilin memuat ulang grafik dari awal (KLineChart mengulang
  // seluruh riwayat saat periode berganti) — gambar & indikator tetap karena disimpan per pool, bukan per instance.
  return <AdvancedChart key={tf} candles={m.ohlcv.candles} tf={tf} quote="USD" poolRef={poolRef} />;
}

export default function TokenDetail({ param }) {
  const { t } = useI18n();
  const a = String(param || '').toLowerCase();
  const { data: d, loading, reload } = usePoll(`/api/token?a=${encodeURIComponent(a)}`, 30000);
  const [poolPick, setPool] = useState(null);
  const [tf, setTf] = useState('1h');
  // Klik baris tabel posisi bot -> laci riwayat, sama seperti halaman Posisi.
  const [hist, setHist] = useState(null);
  // Klik baris posisi wallet yang diriset -> laci kejadian on-chain-nya. Yang disimpan
  // kuncinya, supaya angka di laci ikut segar saat tabelnya dipoll ulang.
  const [whistKey, setWhist] = useState(null);
  // Tombol "Posisi asli" di tabel bot: baris tabel riset yang diminta ditunjukkan.
  const [jump, setJump] = useState(null);
  const jumpToSource = (w) => setJump((j) => ({ key: wkey(w), n: (j?.n || 0) + 1 }));
  const pairs = d?.market?.pairs || [];
  const sel = pairs.find((p) => p.pool === poolPick) || pairs[0] || null;
  // Dibuka dari baris tabel yang sudah digulir jauh: mulai dari atas.
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const { data: m } = usePoll(sel ? `/api/market?pool=${sel.pool}&tf=${tf}&limit=${LIMIT[tf]}&token=${a}&currency=usd&pair=0` : null, 30000);

  if (!d) return <Loading page />;
  if (d.error) return <Empty title="Token tidak ditemukan" sub={d.error} />;
  const whist = whistKey ? d.wallets.find((p) => wkey(p) === whistKey) || null : null;

  const tk = d.token;
  const main = pairs.find((p) => p.base.address === a) || null;   // pool terlikuid tempat token ini jadi dasar
  const px = priceIn(main || pairs[0], a);
  const ch24 = main?.priceChange?.h24;
  const liq = sum(pairs, (p) => p.liquidityUsd);
  const vol = sum(pairs, (p) => p.volume?.h24);
  const buys = sum(pairs, (p) => p.txns?.h24?.buys), sells = sum(pairs, (p) => p.txns?.h24?.sells);
  const info = pairs.find((p) => p.base.address === a && (p.websites?.length || p.socials?.length));
  const bal = d.balance;
  const born = pairs.reduce((m, p) => (p.pairCreatedAt && (!m || p.pairCreatedAt < m) ? p.pairCreatedAt : m), null);


  return (
    <>
      <div className="mb-5 border-b border-border pb-4">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="detail-heading flex min-w-0 max-w-full items-center gap-3">
            <TokenIcon address={tk.address} symbol={tk.symbol} size={36} />
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-baseline gap-x-2 text-xl font-semibold tracking-tight">
                {tk.symbol || '?'}
                {tk.name && tk.name !== tk.symbol && <span className="truncate text-sm font-normal text-muted">{tk.name}</span>}
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                <CopyAddr address={tk.address} />
                {tk.decimals != null && <><span>·</span><span>{t('{n} desimal', { n: tk.decimals })}</span></>}
                {tk.isQuote && <><span>·</span><span>{t('aset kuotasi')}</span></>}
                {born && <><span>·</span><span>{t('pool pertama {w}', { w: age((Date.now() - born) / 3600000) + ' ' + t('lalu') })}</span></>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <DataLinks token={tk.address} />
            <TradeLinks token={tk.address} />
            {info?.websites?.map((w) => <ExtLink key={w} href={w} muted>{t('Situs')}</ExtLink>)}
            {info?.socials?.map((x) => <ExtLink key={x.url} href={x.url} muted>{x.type || t('Sosial')}</ExtLink>)}
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Harga" value={px == null ? '—' : usd(px, px < 0.01 ? 6 : 4)}
          sub={ch24 != null ? <span><span className={tone(ch24)}>{pct(ch24, 1)}</span> {t('24 jam')}</span> : null} />
        <Stat label="Likuiditas" value={pairs.length ? kUsd(liq) : '—'} sub={t('{n} pool', { n: pairs.length })} />
        <Stat label="Volume 24 jam" value={pairs.length ? kUsd(vol) : '—'}
          sub={pairs.length ? <span><span className="text-success">{num(buys)}</span> {t('beli')} · <span className="text-danger">{num(sells)}</span> {t('jual')}</span> : null} />
        <Stat label="FDV" value={main?.fdv != null ? kUsd(main.fdv) : '—'} sub={main?.marketCap != null ? t('kapitalisasi {v}', { v: kUsd(main.marketCap) }) : null} />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <Panel className="lg:col-span-2"
          title={t('Harga {s} dalam USD', { s: tk.symbol || '?' })}
          desc={sel ? <span className="inline-flex items-center gap-1.5">{t('pool')} <PairName token0={sel.base.address} token1={sel.quote.address} symbol0={sel.base.symbol} symbol1={sel.quote.symbol} pool={sel.pool} /> <span className="uppercase">{venueOf(sel)}</span></span> : null}
          action={sel && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}>
          {d.market?.error ? <Empty title="Data pasar tidak tersedia" sub={d.market.error} />
            : !sel ? <Empty title="Belum ada pool terindeks" sub="DexScreener belum mengenal pool untuk token ini." />
              : !m ? <Loading /> : <TokenChart m={m} tf={tf} poolRef={sel.pool} />}
          {sel && <div className="mt-2 text-end text-xs text-muted">{t('lilin {tf} · GeckoTerminal', { tf })}</div>}
        </Panel>

        <div className="grid gap-3">
          <Panel title="Token" bodyClass="px-4 py-1">
            <div className="divide-y divide-border">
              <KV label="Simbol">{tk.symbol || '—'}</KV>
              {tk.name && <KV label="Nama"><span className="block truncate">{tk.name}</span></KV>}
              <KV label="Alamat"><CopyAddr address={tk.address} /></KV>
              {bal && <KV label="Di wallet bot">
                {fmtAmt(bal.amount)} <span className="font-normal text-muted">{tk.symbol}</span>
                {px != null && bal.amount > 0 && <div className="text-xs font-normal text-muted">{usd(bal.amount * px)}</div>}
              </KV>}
              <KV label="Posisi bot">{t('{o} terbuka · {c} ditutup', { o: d.open.length, c: d.closed.length })}</KV>
            </div>
          </Panel>
          <GmgnTokenPanel address={a} />
          {sel && (
            <Panel title="Pool terpilih" desc="DexScreener · diperbarui tiap 30 detik" bodyClass="p-0">
              <MarketPanel pair={sel} pool={sel.pool} />
            </Panel>
          )}
        </div>
      </div>

      <GmgnWallets address={a} kind="holders" symbol={tk.symbol} className="mt-4" />

      {pairs.length > 0 && (
        <Panel title={t('Pool ({n})', { n: pairs.length })} className="mt-4" bodyClass="p-0">
          <DataTable label="Pool" rows={pairs} rowKey={(p) => p.pool} pageSize={10}
            defaultSort={{ column: 'liq', direction: 'descending' }}
            columns={[
              { key: 'pair', label: 'Pool', sort: (p) => `${p.base.symbol}/${p.quote.symbol}`, render: (p) => (
                <div className="flex items-center gap-2.5">
                  <TokenPair token0={p.base.address} token1={p.quote.address} symbol0={p.base.symbol} symbol1={p.quote.symbol} size={20} />
                  <div>
                    <PairName token0={p.base.address} token1={p.quote.address} symbol0={p.base.symbol} symbol1={p.quote.symbol} pool={p.pool} className="block font-medium" />
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                      <span className="uppercase">{venueOf(p)}</span><span>·</span><span className="mono">{short(p.pool)}</span>
                    </div>
                  </div>
                </div>) },
              { key: 'px', label: 'Harga', align: 'end', sort: (p) => priceIn(p, a), render: (p) => {
                const v = priceIn(p, a);
                return v == null ? '—' : usd(v, v < 0.01 ? 6 : 4);
              } },
              { key: 'ch', label: '24 jam', align: 'end', sort: (p) => (p.base.address === a ? p.priceChange?.h24 : null), render: (p) => (
                p.base.address === a && p.priceChange?.h24 != null ? <span className={tone(p.priceChange.h24)}>{pct(p.priceChange.h24, 1)}</span> : <span className="text-muted">—</span>) },
              { key: 'liq', label: 'Likuiditas', align: 'end', sort: (p) => p.liquidityUsd ?? 0, render: (p) => kUsd(p.liquidityUsd) },
              { key: 'vol', label: 'Volume 24 jam', align: 'end', sort: (p) => p.volume?.h24, render: (p) => kUsd(p.volume?.h24) },
              { key: 'tx', label: 'Transaksi 24 jam', align: 'end', sort: (p) => (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0), render: (p) => (
                p.txns?.h24 ? <span className="whitespace-nowrap"><span className="text-success">{num(p.txns.h24.buys)}</span> / <span className="text-danger">{num(p.txns.h24.sells)}</span></span> : '—') },
              { key: 'act', label: '', sortable: false, className: 'text-end', render: (p) => (
                p.pool === sel?.pool
                  ? <span className="text-xs text-muted">{t('di grafik')}</span>
                  : <Button size="sm" variant="outline" onPress={() => { setPool(p.pool); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t('Grafik')}</Button>) },
            ]} />
        </Panel>
      )}

      <BotPositions open={d.open} closed={d.closed} onHist={setHist} reload={reload}
        wallets={d.wallets} onSource={jumpToSource} loading={loading} className="mt-4" />
      <PositionHistory id={hist} onClose={() => setHist(null)} />
      <WalletPositions rows={d.wallets} onHist={(p) => setWhist(wkey(p))} jumpTo={jump} loading={loading} className="mt-4" />
      <WalletPositionHistory p={whist} address={whist?.wallet} onClose={() => setWhist(null)} />
      <TargetMoves rows={d.activity} className="mt-4" />
    </>
  );
}
