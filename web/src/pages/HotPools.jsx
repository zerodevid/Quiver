// Hot pools: the chain's busiest pools right now, from GeckoTerminal — trending over a window,
// top 24h volume, or the newest. Each pool of a venue the bot trades is resolved on chain by the
// server (fee tier, hook, quote side, empty), so a row says whether it can be entered and opens
// straight in the manual LP page.
import { useMemo, useState } from 'react';
import { usePoll } from '../hooks';
import { PageHeader, Panel, DataTable, Empty, Loading, Notice, Segmented } from '../components/ui';
import { TokenPair, PairName } from '../components/TokenIcon';
import { kUsd, pct, num, price, tone, age } from '../fmt';
import { useI18n, translate as tt } from '../i18n';

const SORTS = [['trending', 'Trending'], ['volume', 'Volume 24j'], ['new', 'Baru']];
// Window of the trending ranking and of the change/volume/tx columns.
const WINDOWS = [['5m', '5 mnt'], ['1h', '1 jam'], ['6h', '6 jam'], ['24h', '24 jam']];
const KEY = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' };

// Fee earned by the whole pool in 24 h over its TVL — the daily yield of liquidity in range,
// before price impact. Unknown without an on-chain fee tier.
const feeYield = (x) => (x.lp?.feePct != null && !x.lp.dynamicFee && x.tvlUsd > 0 && x.volume.h24 != null
  ? (x.volume.h24 * (x.lp.feePct / 100)) / x.tvlUsd * 100 : null);

// Why a pool cannot be entered (or what to watch for), most decisive first.
function lpState(x) {
  if (!x.lp) return { ok: false, label: 'DEX lain', title: 'Bukan pool Uniswap v3/v4 yang bisa dimasuki bot.' };
  if (x.lp.dynamicFee) return { ok: false, label: 'fee dinamis', title: 'Fee diatur hook — bot tidak masuk pool berfee dinamis.' };
  if (x.lp.empty) return { ok: false, label: 'kosong', title: 'Likuiditas pool nol.' };
  if (x.lp.feePct === 0) return { ok: true, warn: 'fee 0%', title: 'Pool ini tidak membayar fee ke LP.' };
  // No quote asset: enterable (both tokens are bought from cash), flagged because its dollar value
  // comes from DexScreener's price.
  if (x.lp.quoteSymbol == null) return { ok: true, warn: 'tanpa USDG/ETH', title: 'Pasangannya bukan aset kuotasi yang dikenal (USDG/ETH).' };
  if (x.lp.hook?.risky?.length) return { ok: true, warn: 'hook', title: tt('Hook bisa menahan atau memotong penarikan: {f}', { f: x.lp.hook.risky.join(', ') }) };
  return { ok: true };
}

export default function HotPools() {
  const { t } = useI18n();
  const [sort, setSort] = useState('trending');
  const [win, setWin] = useState('1h');
  const [onlyLp, setOnlyLp] = useState(false);
  const { data, error } = usePoll(`/api/hot-pools?sort=${sort}${sort === 'trending' ? `&duration=${win}` : ''}`, 60000);
  const k = KEY[win];

  const rows = useMemo(() => {
    const list = (data?.pools || []).map((x, i) => ({ ...x, rank: i + 1, state: lpState(x), yieldPct: feeYield(x) }));
    return onlyLp ? list.filter((x) => x.state.ok) : list;
  }, [data, onlyLp]);

  const cols = useMemo(() => [
    { key: 'rank', label: '#', align: 'end', sort: (x) => x.rank, render: (x) => <span className="num text-muted">{x.rank}</span> },
    { key: 'pool', label: 'Pool', sort: (x) => x.name, search: (x) => `${x.name} ${x.base.address} ${x.poolRef}`, render: (x) => (
      <div className="flex items-center gap-2.5">
        <TokenPair token0={x.base.address} token1={x.quote.address} symbol0={x.base.symbol} symbol1={x.quote.symbol} size={22} />
        <div className="min-w-0">
          <PairName token0={x.base.address} token1={x.quote.address} symbol0={x.base.symbol} symbol1={x.quote.symbol} pool={x.poolRef} className="font-medium" />
          <div className="truncate text-xs text-muted">
            {x.dex.replace(/-robinhood$|-bsc$/, '')}
            {x.lp?.feePct != null && !x.lp.dynamicFee && ` · ${x.lp.feePct}%`}
            {x.createdAt && ` · ${age((Date.now() - x.createdAt) / 3600000)}`}
          </div>
        </div>
      </div>) },
    { key: 'px', label: 'Harga', align: 'end', sort: (x) => x.change[k] ?? -Infinity, render: (x) => (
      <div className="text-end">
        <div className="num whitespace-nowrap">{x.priceUsd != null ? `$${price(x.priceUsd)}` : '—'}</div>
        <div className={`num text-xs ${tone(x.change[k])}`}>{pct(x.change[k])}</div>
      </div>) },
    { key: 'vol', label: 'Volume', align: 'end', sort: (x) => x.volume[k] ?? -1, render: (x) => <span className="num whitespace-nowrap">{x.volume[k] != null ? kUsd(x.volume[k]) : '—'}</span> },
    { key: 'tvl', label: 'TVL', align: 'end', sort: (x) => x.tvlUsd ?? -1, render: (x) => <span className="num whitespace-nowrap text-muted">{x.tvlUsd != null ? kUsd(x.tvlUsd) : '—'}</span> },
    { key: 'turn', label: 'Vol/TVL 24j', align: 'end', sort: (x) => (x.tvlUsd > 0 ? x.volume.h24 / x.tvlUsd : -1), render: (x) => (
      <span className="num text-muted">{x.tvlUsd > 0 && x.volume.h24 != null ? `${num(x.volume.h24 / x.tvlUsd, 1)}×` : '—'}</span>) },
    { key: 'yield', label: 'Fee/TVL 24j', align: 'end', sort: (x) => x.yieldPct ?? -1, render: (x) => (
      <span className="num font-medium" title={tt('Fee seluruh pool 24 jam dibagi TVL — hasil harian likuiditas yang di dalam rentang.')}>
        {x.yieldPct != null ? `${num(x.yieldPct, 2)}%` : '—'}
      </span>) },
    { key: 'tx', label: 'Transaksi', align: 'end', sort: (x) => (x.txns[k] ? x.txns[k].buys + x.txns[k].sells : -1), render: (x) => {
      const tx = x.txns[k];
      if (!tx) return <span className="text-muted">—</span>;
      return (
        <div className="text-end text-xs">
          <div className="num whitespace-nowrap"><span className="text-success">{num(tx.buys)}</span> / <span className="text-danger">{num(tx.sells)}</span></div>
          <div className="num whitespace-nowrap text-muted">{t('{n} pembeli', { n: num(tx.buyers) })}</div>
        </div>
      );
    } },
    { key: 'lp', label: 'LP', align: 'end', sort: (x) => (x.state.ok ? 1 : 0), render: (x) => (
      x.state.ok ? (
        <span className="flex items-center justify-end gap-1.5">
          {x.state.warn && <span className="rounded bg-warning/15 px-1.5 text-[0.6875rem] font-medium text-warning" title={t(x.state.title)}>{t(x.state.warn)}</span>}
          <a href={`#manual-lp/${x.poolRef}`} onClick={(e) => e.stopPropagation()}
            className="rounded-md border border-accent px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/10">{t('LP')}</a>
        </span>
      ) : <span className="whitespace-nowrap text-xs text-muted" title={t(x.state.title)}>{t(x.state.label)}</span>) },
  ], [k, t]);

  return (
    <div>
      <PageHeader group="Riset" title="Pool ramai"
        desc="Pool yang paling ramai di chain ini sekarang, dari GeckoTerminal: trending, volume 24 jam terbesar, atau yang terbaru. Pool Uniswap v3/v4 dicek langsung di chain — fee, hook, dan pasangannya — jadi tiap baris menunjukkan apakah bisa langsung di-LP." />
      <Panel title="Pool ramai" bodyClass="p-0"
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Segmented size="sm" aria="Urutan" value={sort} onChange={setSort} options={SORTS} />
            <Segmented size="sm" aria="Jendela waktu" value={win} onChange={setWin} options={WINDOWS} />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={onlyLp} onChange={(e) => setOnlyLp(e.target.checked)} />{t('Hanya yang bisa di-LP')}
            </label>
          </div>
        )}>
        {error && !data && <div className="p-4"><Notice status="danger" title="Data pool ramai tidak terbaca">{t(error)}</Notice></div>}
        {!data && !error ? <Loading text="Membaca pool ramai dari GeckoTerminal…" /> : data && (
          <>
            {data.stale && <p className="px-4 pt-3 text-xs text-warning">{t('GeckoTerminal sedang membatasi panggilan — menampilkan data terakhir.')}</p>}
            <DataTable label="Pool ramai" rows={rows} rowKey={(x) => x.poolRef} columns={cols} searchable pageSize={25}
              defaultSort={{ column: 'rank', direction: 'ascending' }}
              onRow={(x) => { location.hash = `pool/${x.poolRef}`; }}
              empty={<Empty title={onlyLp ? 'Tidak ada pool yang bisa di-LP di daftar ini' : 'Belum ada data'} sub="Coba urutan atau jendela waktu lain." />} />
            <p className="px-4 py-3 text-xs text-muted">
              {t('Data dari GeckoTerminal, diperbarui tiap menit. Fee/TVL hanya dihitung untuk pool yang fee-nya terbaca dari chain; pool berfee dinamis atau di DEX lain tidak bisa dimasuki bot.')}
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
