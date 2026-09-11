// Detail satu token: harga & grafik lilin (dari pool yang dipilih, default yang
// paling likuid), semua pool-nya menurut DexScreener, posisi bot yang memakainya,
// posisi wallet yang pernah diriset, dan gerakan target di token ini.
//
// Dibuka dari lambang atau simbol token di mana pun di dasbor: #token/0x….
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { ArrowLeft, ExternalLink, Copy, Check } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid,
} from 'recharts';
import { usePoll } from '../hooks';
import { Panel, Stat, KV, Dot, Empty, Loading, Segmented, DataTable, PriceRange } from '../components/ui';
import TokenIcon, { TokenPair, PairName } from '../components/TokenIcon';
import { Pair } from './Positions';
import { Candle, CandleTip, MarketPanel, fmtT, kUsd } from './PositionDetail';
import { usd, pct, tone, num, age, ago, short, price, locale as fmtLocale, AKSI, KEPUTUSAN } from '../fmt';
import { useI18n, reason } from '../i18n';

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

function TokenChart({ m, tf }) {
  const data = useMemo(() => (m?.ohlcv?.candles || []).filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0), [m]);
  if (m?.ohlcv?.error) return <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />;
  if (!data.length) return <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />;
  const lo = Math.min(...data.map((c) => c.l)), hi = Math.max(...data.map((c) => c.h));
  const pad = (hi - lo || lo * 0.1) * 0.06;
  return (
    <div className="h-80 sm:h-96">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" type="category" tickLine={false} axisLine={false} minTickGap={56} interval="preserveStartEnd"
            tick={{ fill: 'var(--muted)', fontSize: 11 }} tickFormatter={(v) => fmtT(v, tf)} />
          <YAxis domain={[Math.max(0, lo - pad), hi + pad]} width={68} tickLine={false} axisLine={false} orientation="right"
            tick={{ fill: 'var(--muted)', fontSize: 11 }} tickFormatter={(v) => price(v)} />
          <ReTooltip content={<CandleTip tf={tf} quote="USD" />} cursor={{ stroke: 'var(--border)' }} isAnimationActive={false} />
          <Bar dataKey={(d) => [d.l, d.h]} shape={<Candle />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function CopyAddr({ address }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const id = setTimeout(() => setDone(false), 1500); return () => clearTimeout(id); }, [done]);
  const copy = async () => { try { await navigator.clipboard.writeText(address); setDone(true); } catch { /* izin clipboard ditolak */ } };
  return (
    <button type="button" onClick={copy} title={address} aria-label={t('Salin alamat')}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-muted transition-colors hover:bg-default hover:text-foreground">
      {short(address)}{done ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}

const ext = (href, label, muted) => (
  <a key={href} href={href} target="_blank" rel="noreferrer"
    className={`inline-flex items-center gap-1 hover:underline ${muted ? 'text-muted' : 'text-accent'}`}>{label} <ExternalLink className="size-3" /></a>
);

function goBack(e) {
  e.preventDefault();
  if (history.length > 1) history.back(); else location.hash = 'positions';
}

export default function TokenDetail({ param }) {
  const { t } = useI18n();
  const a = String(param || '').toLowerCase();
  const { data: d } = usePoll(`/api/token?a=${encodeURIComponent(a)}`, 30000);
  const [poolPick, setPool] = useState(null);
  const [tf, setTf] = useState('1h');
  const pairs = d?.market?.pairs || [];
  const sel = pairs.find((p) => p.pool === poolPick) || pairs[0] || null;
  // Dibuka dari baris tabel yang sudah digulir jauh: mulai dari atas.
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const { data: m } = usePoll(sel ? `/api/market?pool=${sel.pool}&tf=${tf}&limit=${LIMIT[tf]}&token=${a}&currency=usd&pair=0` : null, 30000);

  if (!d) return <Loading />;
  if (d.error) return <Empty title="Token tidak ditemukan" sub={d.error} />;

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

  const mine = [...d.open.map((p) => ({ ...p, status: 'open' })), ...d.closed];
  const minePnl = sum(mine, (p) => p.pnlUsd);

  return (
    <>
      <div className="mb-5 border-b border-border pb-4">
        <a href="#" onClick={goBack} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3.5" />{t('Kembali')}</a>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-3">
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {ext(`https://dexscreener.com/robinhood/${tk.address}`, 'DexScreener')}
            {ext(`https://www.geckoterminal.com/robinhood/tokens/${tk.address}`, 'GeckoTerminal')}
            {info?.websites?.map((w) => ext(w, t('Situs'), true))}
            {info?.socials?.map((s) => ext(s.url, s.type || t('Sosial'), true))}
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
          desc={sel ? <span className="inline-flex items-center gap-1.5">{t('pool')} <PairName token0={sel.base.address} token1={sel.quote.address} symbol0={sel.base.symbol} symbol1={sel.quote.symbol} /> <span className="uppercase">{venueOf(sel)}</span></span> : null}
          action={sel && <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />}>
          {d.market?.error ? <Empty title="Data pasar tidak tersedia" sub={d.market.error} />
            : !sel ? <Empty title="Belum ada pool terindeks" sub="DexScreener belum mengenal pool untuk token ini." />
              : !m ? <Loading /> : <TokenChart m={m} tf={tf} />}
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
          {sel && (
            <Panel title="Pool terpilih" desc="DexScreener · diperbarui tiap 30 detik" bodyClass="p-0">
              <MarketPanel pair={sel} pool={sel.pool} />
            </Panel>
          )}
        </div>
      </div>

      {pairs.length > 0 && (
        <Panel title={t('Pool ({n})', { n: pairs.length })} className="mt-4" bodyClass="p-0">
          <DataTable label="Pool" rows={pairs} rowKey={(p) => p.pool} pageSize={10}
            defaultSort={{ column: 'liq', direction: 'descending' }}
            columns={[
              { key: 'pair', label: 'Pool', sort: (p) => `${p.base.symbol}/${p.quote.symbol}`, render: (p) => (
                <div className="flex items-center gap-2.5">
                  <TokenPair token0={p.base.address} token1={p.quote.address} symbol0={p.base.symbol} symbol1={p.quote.symbol} size={20} />
                  <div>
                    <PairName token0={p.base.address} token1={p.quote.address} symbol0={p.base.symbol} symbol1={p.quote.symbol} className="font-medium" />
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

      <Panel title={t('Posisi bot ({n})', { n: mine.length })} className="mt-4" bodyClass="p-0"
        action={mine.length > 0 && <span className="text-xs"><span className="text-muted">PnL</span> <span className={`num font-medium ${tone(minePnl)}`}>{usd(minePnl)}</span></span>}>
        <DataTable label="Posisi bot" rows={mine} rowKey={(p) => p.id} pageSize={10}
          defaultSort={{ column: 'when', direction: 'descending' }}
          empty={<Empty title="Bot belum pernah memegang token ini" />}
          columns={[
            { key: 'pair', label: 'Pasangan', sort: (p) => `${p.symbol0}/${p.symbol1}`, render: (p) => <Pair p={p} /> },
            { key: 'st', label: 'Status', sort: (p) => p.status, render: (p) => (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Dot tone={p.status === 'open' ? 'success' : 'default'} />{t(p.status === 'open' ? 'Terbuka' : 'Ditutup')}</span>) },
            { key: 'cost', label: 'Modal', align: 'end', sort: (p) => p.costUsd, render: (p) => usd(p.costUsd) },
            { key: 'val', label: 'Nilai / hasil', align: 'end', sort: (p) => (p.status === 'open' ? p.valueUsd + (p.feeUsd || 0) : p.outUsd), render: (p) => (
              p.status === 'open'
                ? <div>{usd(p.valueUsd)}{p.feeUsd > 0.005 && <div className="text-xs text-success">+{usd(p.feeUsd)} fee</div>}</div>
                : usd(p.outUsd)) },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnlUsd, render: (p) => (
              <div className={tone(p.pnlUsd)}>{usd(p.pnlUsd)}<div className="text-xs">{p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></div>) },
            { key: 'when', label: 'Waktu', align: 'end', sort: (p) => p.closed_ts || p.opened_ts, render: (p) => (
              <span className="whitespace-nowrap text-muted">{p.status === 'open' ? t('dibuka {w}', { w: ago(p.opened_ts) }) : t('ditutup {w}', { w: ago(p.closed_ts) })}</span>) },
          ]} />
      </Panel>

      {d.wallets.length > 0 && (
        <Panel title={t('Posisi wallet yang diriset ({n})', { n: d.wallets.length })} desc="Dari pemindaian halaman Wallet dan Target" className="mt-4" bodyClass="p-0">
          <DataTable label="Posisi wallet" rows={d.wallets} rowKey={(p) => `${p.wallet}:${p.venue}:${p.token_id}`} searchable pageSize={15}
            defaultSort={{ column: 'when', direction: 'descending' }}
            columns={[
              { key: 'w', label: 'Wallet', sort: (p) => p.walletLabel || p.wallet, search: (p) => `${p.walletLabel || ''} ${p.wallet}`, render: (p) => (
                <a href={(p.isTarget ? '#targets/' : '#wallet/') + p.wallet} className="group block max-w-40" title={p.wallet}>
                  {p.walletLabel && <div className="truncate font-medium group-hover:underline">{p.walletLabel}</div>}
                  <div className="mono text-xs text-muted group-hover:text-foreground">{short(p.wallet)}</div>
                </a>) },
              { key: 'pair', label: 'Posisi / pool', sort: (p) => `${p.symbol0}/${p.symbol1}`, search: (p) => `${p.symbol0}/${p.symbol1} ${p.token_id}`, render: (p) => (
                <div className="flex items-center gap-2.5">
                  <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
                  <div>
                    <PairName token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} className="font-medium" />
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                      <span className="uppercase">{p.venue}</span><span>·</span><span className="mono">#{p.token_id}</span>
                    </div>
                  </div>
                </div>) },
              { key: 'st', label: 'Status', sort: (p) => p.status, render: (p) => (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Dot tone={p.status === 'open' ? 'success' : 'default'} />{t(p.status === 'open' ? 'Terbuka' : 'Ditutup')}</span>) },
              { key: 'inv', label: 'Modal', align: 'end', sort: (p) => p.invested_q, render: (p) => usd(p.invested_q) },
              { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnl_q, render: (p) => (
                <div className={tone(p.pnl_q)}>{usd(p.pnl_q)}<div className="text-xs">{p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></div>) },
              { key: 'rng', label: 'Rentang harga', sortable: false, render: (p) => (
                <PriceRange lo={p.tick_lower} hi={p.tick_upper} dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />) },
              { key: 'when', label: 'Waktu', align: 'end', sort: (p) => p.closed_ts || p.opened_ts, render: (p) => (
                <span className="whitespace-nowrap text-muted">{p.status === 'open' ? t('dibuka {w}', { w: ago(p.opened_ts) }) : t('ditutup {w}', { w: ago(p.closed_ts) })}</span>) },
            ]} />
        </Panel>
      )}

      {d.activity.length > 0 && (
        <Panel title={t('Gerakan target ({n})', { n: d.activity.length })} className="mt-4" bodyClass="p-0">
          <DataTable label="Gerakan target" rows={d.activity} rowKey={(x) => x.id} pageSize={15}
            defaultSort={{ column: 'ts', direction: 'descending' }}
            columns={[
              { key: 'ts', label: 'Waktu', sort: (x) => x.ts, render: (x) => (
                <span className="whitespace-nowrap text-muted" title={new Date(x.ts).toLocaleString(fmtLocale())}>{ago(x.ts)}</span>) },
              { key: 'tgt', label: 'Target', sort: (x) => x.targetLabel || x.target, render: (x) => (
                <a href={'#targets/' + x.target} className="group block max-w-40" title={x.target}>
                  {x.targetLabel && <div className="truncate font-medium group-hover:underline">{x.targetLabel}</div>}
                  <div className="mono text-xs text-muted">{short(x.target)}</div>
                </a>) },
              { key: 'kind', label: 'Aksi', sort: (x) => x.kind, render: (x) => (
                <span className="whitespace-nowrap">{t(AKSI[x.kind]?.[0] || x.kind)} <span className="text-[0.6875rem] text-muted uppercase">{x.venue}</span></span>) },
              { key: 'pair', label: 'Pasangan', sort: (x) => `${x.symbol0}/${x.symbol1}`, render: (x) => (
                <PairName token0={x.token0} token1={x.token1} symbol0={x.symbol0} symbol1={x.symbol1} sep="/" className="font-medium" />) },
              { key: 'val', label: 'Nilai', align: 'end', sort: (x) => x.value_quote, render: (x) => (
                x.value_quote == null ? <span className="text-muted">—</span>
                  : x.quote_symbol === 'ETH' || x.quote_symbol === 'WETH' ? `${x.value_quote.toFixed(4)} Ξ` : usd(x.value_quote)) },
              { key: 'dec', label: 'Keputusan', sort: (x) => x.verdict, render: (x) => {
                const k = KEPUTUSAN[x.verdict];
                return (
                  <div className="max-w-xs">
                    <div className="flex items-center gap-1.5 font-medium">
                      <Dot tone={k?.[1] || 'default'} />
                      {x.position_id
                        ? <a href={'#positions/' + x.position_id} className="hover:underline">{k ? t(k[0]) : (x.verdict || '—')}</a>
                        : <span>{k ? t(k[0]) : (x.verdict || '—')}</span>}
                    </div>
                    {x.reason && <div className="mt-0.5 truncate text-xs text-muted" title={reason(x.reason)}>{reason(x.reason)}</div>}
                  </div>);
              } },
            ]} />
        </Panel>
      )}
    </>
  );
}
