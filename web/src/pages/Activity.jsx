import { useState } from 'react';
import { Plus, Minus, ArrowLeftRight, CircleDollarSign } from 'lucide-react';
import { usePoll } from '../hooks';
import { PageHeader, Panel, DataTable, Empty, Loading, PriceRange, Segmented, Dot } from '../components/ui';
import { usd, ago, short, locale as fmtLocale, AKSI, KEPUTUSAN } from '../fmt';
import { useI18n, reason } from '../i18n';

// Ikon per jenis aksi: arah gerakan terbaca tanpa membaca labelnya.
const IKON = { increase: Plus, mint: Plus, decrease: Minus, collect: CircleDollarSign };
const WARNA = { increase: 'text-accent', mint: 'text-accent', decrease: 'text-warning', collect: 'text-success' };

export default function Activity() {
  const { t } = useI18n();
  const { data: d } = usePoll('/api/activity?limit=200', 8000);
  const [filter, setFilter] = useState('all');
  if (!d) return <Loading />;
  const all = d.activity;
  const n = (v) => all.filter((a) => a.verdict === v).length;
  const rows = all.filter((a) => filter === 'all' || a.verdict === filter);
  const opts = [['all', 'Semua', all.length], ['copy', 'Disalin', n('copy')], ['dry', 'Simulasi', n('dry')],
    ['skip', 'Dilewati', n('skip')], ['error', 'Gagal', n('error')]].filter(([id, , c]) => id === 'all' || c > 0 || id === filter);
  return (
    <>
      <PageHeader group="Pemantauan" title="Aktivitas" desc="Setiap gerakan LP wallet target dan keputusan bot atasnya." />
      <div className="mb-3"><Segmented aria="Saring keputusan" value={filter} onChange={setFilter} options={opts} /></div>
      <Panel bodyClass="p-0">
        <DataTable label="Aktivitas" rows={rows} rowKey={(a) => a.id} searchable pageSize={25}
          defaultSort={{ column: 'ts', direction: 'descending' }}
          empty={<Empty title="Belum ada aktivitas" sub="Gerakan LP wallet target akan muncul di sini begitu terdeteksi." />}
          columns={[
            { key: 'ts', label: 'Waktu', sort: (a) => a.ts, render: (a) => (
              <span className="whitespace-nowrap text-muted" title={new Date(a.ts).toLocaleString(fmtLocale())}>{ago(a.ts)}</span>) },
            { key: 'tgt', label: 'Target', sort: (a) => a.targetLabel || a.target, search: (a) => `${a.targetLabel || ''} ${a.target}`, render: (a) => (
              <a href={'#target/' + a.target} className="group block max-w-40" title={a.target}>
                {a.targetLabel && <div className="truncate font-medium group-hover:underline">{a.targetLabel}</div>}
                <div className="mono text-xs text-muted">{short(a.target)}</div>
              </a>) },
            { key: 'kind', label: 'Aksi', sort: (a) => a.kind, render: (a) => {
              const I = IKON[a.kind] || ArrowLeftRight;
              return (
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className={`flex size-5 items-center justify-center rounded bg-default ${WARNA[a.kind] || 'text-muted'}`}><I className="size-3" strokeWidth={2.5} /></span>
                  <span>{t(AKSI[a.kind]?.[0] || a.kind)}</span>
                  <span className="text-[0.6875rem] text-muted uppercase">{a.venue}</span>
                </div>);
            } },
            { key: 'pair', label: 'Pasangan', sort: (a) => (a.symbol0 ? `${a.symbol0}/${a.symbol1}` : null), render: (a) => (a.symbol0
              ? <span className="font-medium whitespace-nowrap">{a.symbol0}/{a.symbol1}</span> : <span className="text-muted">—</span>) },
            { key: 'range', label: 'Rentang harga', sortable: false, render: (a) => (a.tick_lower != null
              ? <PriceRange lo={a.tick_lower} hi={a.tick_upper} dec0={a.dec0} dec1={a.dec1}
                  quoteSide={a.quoteSide} symbol0={a.symbol0} symbol1={a.symbol1} />
              : <span className="text-muted">—</span>) },
            { key: 'val', label: 'Nilai', align: 'end', sort: (a) => a.value_quote, render: (a) => (a.value_quote == null ? <span className="text-muted">—</span>
              : a.quote_symbol === 'ETH' ? `${a.value_quote.toFixed(4)} Ξ` : usd(a.value_quote)) },
            { key: 'dec', label: 'Keputusan', sort: (a) => a.verdict, search: (a) => `${a.verdict || ''} ${a.reason || ''}`, render: (a) => {
              const k = KEPUTUSAN[a.verdict];
              return (
                <div className="max-w-xs">
                  <div className="flex items-center gap-1.5 font-medium">
                    <Dot tone={k?.[1] || 'default'} />
                    <span className={k?.[1] === 'danger' ? 'text-danger' : k?.[1] === 'success' ? 'text-success' : ''}>{k ? t(k[0]) : (a.verdict || '—')}</span>
                  </div>
                  {a.reason && <div className="mt-0.5 truncate text-xs text-muted" title={reason(a.reason)}>{reason(a.reason)}</div>}
                </div>);
            } },
          ]} />
      </Panel>
    </>
  );
}
