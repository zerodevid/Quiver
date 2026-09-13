// Isi wallet (portofolio) satu alamat: token yang dipegang, jumlah, harga, dan
// nilainya. Dipakai halaman detail target — melengkapi riset LP dengan gambaran
// apa yang sedang dia pegang di luar posisi.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { RefreshCw } from 'lucide-react';
import { get } from '../api';
import { Panel, DataTable, Empty, Loading, Notice } from './ui';
import TokenIcon, { TokenSym } from './TokenIcon';
import { usd, kUsd, price, ago } from '../fmt';
import { useI18n, translate as tt } from '../i18n';

// Jumlah token bisa 0,000012 sampai 4 miliar — angka penting, bukan desimal tetap.
const amount = (v) => (v == null || !Number.isFinite(v) ? '—'
  : v >= 1e6 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : v >= 1 ? v.toLocaleString(undefined, { maximumSignificantDigits: 6 })
      : v.toLocaleString(undefined, { maximumSignificantDigits: 4 }));

const cols = [
  { key: 'tok', label: 'Token', sort: (x) => x.symbol, search: (x) => `${x.symbol} ${x.name || ''} ${x.address}`, render: (x) => (
    <div className="flex items-center gap-2.5">
      <TokenIcon address={x.address} symbol={x.symbol} size={22} link />
      <div className="min-w-0">
        <TokenSym address={x.address} symbol={x.symbol} className="block font-medium" />
        <div className="mono truncate text-xs text-muted">{x.native ? tt('ETH native') : x.name || `${x.address.slice(0, 6)}…${x.address.slice(-4)}`}</div>
      </div>
    </div>) },
  { key: 'amt', label: 'Jumlah', align: 'end', sort: (x) => x.amount, render: (x) => <span className="num whitespace-nowrap">{amount(x.amount)}</span> },
  { key: 'px', label: 'Harga', align: 'end', sort: (x) => x.priceUsd ?? -1, render: (x) => (
    <span className="num whitespace-nowrap text-muted">{x.priceUsd != null ? `$${price(x.priceUsd)}` : '—'}</span>) },
  { key: 'usd', label: 'Nilai', align: 'end', sort: (x) => x.usd ?? -1, render: (x) => (
    <span className="num whitespace-nowrap font-medium" title={x.usd == null ? tt('Harga tidak ditemukan di DexScreener') : undefined}>{usd(x.usd)}</span>) },
  { key: 'share', label: 'Porsi', align: 'end', sort: (x) => x.sharePct ?? -1, render: (x) => (
    x.sharePct == null ? <span className="text-muted">—</span> : (
      <div className="flex items-center justify-end gap-2">
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ background: 'var(--accent)', width: `${Math.max(2, Math.min(100, x.sharePct))}%` }} /></div>
        <span className="num w-12 text-end text-xs text-muted">{x.sharePct.toFixed(1)}%</span>
      </div>)) },
];

export default function WalletHoldings({ address }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async (refresh = false) => {
    setBusy(true); setErr(null);
    try {
      const d = await get(`/api/wallet/holdings?address=${address}${refresh ? '&refresh=1' : ''}`);
      if (!alive.current) return;
      if (d.error) setErr(d.error); else setData(d);
    } catch (e) { if (alive.current) setErr(e.message); } finally { if (alive.current) setBusy(false); }
  }, [address]);

  useEffect(() => {
    alive.current = true; setData(null); load();
    // Nilai portofolio ikut harga — segarkan pelan selama halaman terbuka.
    const tm = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => { alive.current = false; clearInterval(tm); };
  }, [load]);

  const rows = (data?.tokens || []).filter((x) => x.amount > 0);
  const action = data && (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="whitespace-nowrap"><span className="text-muted">{t('Total nilai')}</span> <span className="num font-semibold">{kUsd(data.totalUsd || 0)}</span></span>
      <span className="whitespace-nowrap text-xs text-muted">{t('{n} token', { n: rows.length })} · {ago(data.ts)}</span>
      <Button size="sm" variant="ghost" isIconOnly aria-label={t('Segarkan')} isPending={busy} onPress={() => load(true)}><RefreshCw className="size-4" /></Button>
    </div>
  );

  return (
    <Panel title="Isi wallet" className="mb-4" bodyClass="p-0" action={action}>
      {err && <div className="p-4"><Notice status="danger" title="Portofolio tidak terbaca">{err}</Notice></div>}
      {!data && !err ? <Loading text="Membaca isi wallet dari chain…" /> : data && (
        <>
          <DataTable label="Isi wallet" rows={rows} rowKey={(x) => x.address} columns={cols}
            searchable pageSize={5} defaultSort={{ column: 'usd', direction: 'descending' }}
            empty={<Empty title="Wallet ini kosong" sub="Tidak ada ETH maupun token ERC-20 yang terdeteksi." />} />
          <p className="px-4 py-3 text-xs text-muted">
            {t('Saldo dibaca langsung dari chain; harga dari DexScreener (pool paling likuid).')}
            {data.unpricedN > 0 && ` ${t('{n} token tidak ditemukan harganya dan tidak ikut dihitung dalam total.', { n: data.unpricedN })}`}
            {' '}{t('Token yang masuk lewat kontrak lain baru terdeteksi setelah pindai transfer (~1 hari terakhir) selesai.')}
          </p>
        </>
      )}
    </Panel>
  );
}
