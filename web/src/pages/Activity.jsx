import { useState } from 'react';
import { usePoll } from '../hooks';
import { PageHeader, Panel, DataTable, Empty, Loading, PriceRange, Tag, Pick } from '../components/ui';
import { usd, ago, short, AKSI, KEPUTUSAN } from '../fmt';
import { useI18n, reason } from '../i18n';

export default function Activity() {
  const { t } = useI18n();
  const { data: d } = usePoll('/api/activity?limit=200', 8000);
  const [filter, setFilter] = useState('all');
  if (!d) return <Loading />;
  const rows = d.activity.filter((a) => filter === 'all' || a.verdict === filter);
  return (
    <>
      <PageHeader group="Pemantauan" title="Aktivitas" desc="Setiap gerakan LP wallet target dan keputusan bot atasnya.">
        <Pick className="w-48" value={filter} onChange={setFilter}
          options={[['all', 'Semua keputusan'], ['copy', 'Disalin'], ['dry', 'Simulasi'], ['skip', 'Dilewati'], ['error', 'Gagal']]} />
      </PageHeader>
      <Panel bodyClass="p-0">
        <DataTable label="Aktivitas" rows={rows} rowKey={(a) => a.id}
          empty={<Empty title="Belum ada aktivitas" sub="Gerakan LP wallet target akan muncul di sini begitu terdeteksi." />}
          columns={[
            { key: 'ts', label: 'Waktu', render: (a) => <span className="whitespace-nowrap text-muted">{ago(a.ts)}</span> },
            { key: 'tgt', label: 'Target', render: (a) => (
              <a href={'#target/' + a.target} className="block max-w-40 hover:underline" title={a.target}>
                {a.targetLabel && <div className="truncate font-medium">{a.targetLabel}</div>}
                <div className="mono text-muted">{short(a.target)}</div>
              </a>) },
            { key: 'kind', label: 'Aksi', render: (a) => <div className="flex items-center gap-1.5"><Tag map={AKSI} k={a.kind} /><span className="text-xs text-muted">{a.venue}</span></div> },
            { key: 'pair', label: 'Pasangan', render: (a) => (a.symbol0 ? `${a.symbol0}/${a.symbol1}` : <span className="text-muted">—</span>) },
            { key: 'range', label: 'Rentang harga', render: (a) => (a.tick_lower != null
              ? <PriceRange lo={a.tick_lower} hi={a.tick_upper} dec0={a.dec0} dec1={a.dec1}
                  quoteSide={a.quoteSide} symbol0={a.symbol0} symbol1={a.symbol1} />
              : <span className="text-muted">—</span>) },
            { key: 'val', label: 'Nilai', align: 'end', render: (a) => (a.value_quote == null ? '—' : a.quote_symbol === 'ETH' ? `${a.value_quote.toFixed(4)} Ξ` : usd(a.value_quote)) },
            { key: 'dec', label: 'Keputusan', render: (a) => (
              <div className="max-w-sm"><Tag map={KEPUTUSAN} k={a.verdict} />
                {a.reason && <div className="mt-1 truncate text-xs text-muted" title={reason(a.reason)}>{reason(a.reason)}</div>}</div>) },
          ]} />
      </Panel>
    </>
  );
}
