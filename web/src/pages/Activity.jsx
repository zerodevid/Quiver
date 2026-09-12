import { useState } from 'react';
import { Plus, Minus, ArrowLeftRight, CircleDollarSign } from 'lucide-react';
import { usePoll } from '../hooks';
import { PageHeader, Panel, DataTable, Empty, Loading, PriceRange, Segmented, Dot } from '../components/ui';
import { TokenPair, PairName } from '../components/TokenIcon';
import { usd, ago, short, locale as fmtLocale, AKSI, KEPUTUSAN } from '../fmt';
import { useI18n, reason } from '../i18n';

// Ikon per jenis aksi: arah gerakan terbaca tanpa membaca labelnya.
const IKON = { increase: Plus, mint: Plus, decrease: Minus, collect: CircleDollarSign };
const WARNA = { increase: 'text-accent', mint: 'text-accent', decrease: 'text-warning', collect: 'text-success' };

// Ukuran posisi kita dalam USD dari rencana keputusan (hanya rencana masuk yang punya).
function ukuranKita(a) {
  if (!a.plan) return null;
  try { const v = JSON.parse(a.plan).valueUsd; return Number.isFinite(v) ? v : null; } catch { return null; }
}

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
      <Panel bodyClass="activity-table p-0">
        <DataTable label="Aktivitas" rows={rows} rowKey={(a) => a.id} searchable pageSize={25}
          defaultSort={{ column: 'ts', direction: 'descending' }}
          empty={<Empty title="Belum ada aktivitas" sub="Gerakan LP wallet target akan muncul di sini begitu terdeteksi." />}
          columns={[
            { key: 'ts', label: 'Waktu', sort: (a) => a.ts, render: (a) => (
              <span className="whitespace-nowrap text-xs text-muted" title={new Date(a.ts).toLocaleString(fmtLocale())}>{ago(a.ts)}</span>) },
            { key: 'tgt', label: 'Target', sort: (a) => a.targetLabel || a.target, search: (a) => `${a.targetLabel || ''} ${a.target}`, render: (a) => (
              <a href={'#targets/' + a.target} className="group block w-44" title={a.target}>
                {a.targetLabel && <div className="truncate font-medium group-hover:underline">{a.targetLabel}</div>}
                <div className="mono mt-1 text-xs text-muted">{short(a.target)}</div>
              </a>) },
            { key: 'kind', label: 'Aksi', sort: (a) => a.kind, render: (a) => {
              const I = IKON[a.kind] || ArrowLeftRight;
              return (
                <div className="flex items-center gap-2.5 whitespace-nowrap">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg bg-default ${WARNA[a.kind] || 'text-muted'}`}><I className="size-3.5" strokeWidth={2.5} /></span>
                  <div>
                    <div className="font-medium">{t(AKSI[a.kind]?.[0] || a.kind)}</div>
                    <span className="mt-1 inline-flex rounded border border-border px-1.5 py-0.5 text-[0.625rem] leading-none text-muted uppercase">{a.venue}</span>
                  </div>
                </div>);
            } },
            { key: 'pair', label: 'Pasangan', search: (a) => `${a.symbol0 || ''}/${a.symbol1 || ''} ${a.token0 || ''} ${a.token1 || ''}`, sort: (a) => (a.symbol0 ? `${a.symbol0}/${a.symbol1}` : null), render: (a) => (a.symbol0
              ? <div className="flex items-center gap-2 whitespace-nowrap">
                  <TokenPair token0={a.token0} token1={a.token1} symbol0={a.symbol0} symbol1={a.symbol1} size={24} />
                  <PairName token0={a.token0} token1={a.token1} symbol0={a.symbol0} symbol1={a.symbol1} pool={a.pool_ref} sep=" / " className="font-medium" />
                </div> : <span className="text-muted">—</span>) },
            { key: 'range', label: 'Rentang harga', className: 'min-w-44', sortable: false, render: (a) => (a.tick_lower != null
              ? <PriceRange lo={a.tick_lower} hi={a.tick_upper} dec0={a.dec0} dec1={a.dec1}
                  quoteSide={a.quoteSide} symbol0={a.symbol0} symbol1={a.symbol1} />
              : <span className="text-muted">—</span>) },
            { key: 'val', label: 'Nilai', align: 'end', sort: (a) => a.value_quote, render: (a) => {
              // Nilai = posisi TARGET. Ukuran kita (setelah batas) di bawahnya — tanpa itu
              // "$1.000 · Gagal: kas kurang" terbaca seolah bot mencoba masuk $1.000.
              const kita = ukuranKita(a);
              return (
                <div className="min-w-20 whitespace-nowrap font-medium tabular-nums">
                  {a.value_quote == null ? <span className="text-muted">—</span>
                    : (a.quote_symbol === 'ETH' || a.quote_symbol === 'WETH') ? `${a.value_quote.toFixed(4)} Ξ` : usd(a.value_quote)}
                  {kita != null && <div className="mt-1 text-xs font-normal text-muted">{t('kita {v}', { v: usd(kita) })}</div>}
                </div>);
            } },
            { key: 'dec', label: 'Keputusan', sort: (a) => a.verdict, search: (a) => `${a.verdict || ''} ${a.reason || ''}`, render: (a) => {
              const k = KEPUTUSAN[a.verdict];
              return (
                <div className="min-w-40 max-w-56">
                  <div className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${k?.[1] === 'danger' ? 'bg-danger/10' : k?.[1] === 'success' ? 'bg-success/10' : 'bg-default'}`}>
                    <Dot tone={k?.[1] || 'default'} />
                    <span className={k?.[1] === 'danger' ? 'text-danger' : k?.[1] === 'success' ? 'text-success' : ''}>{k ? t(k[0]) : (a.verdict || '—')}</span>
                  </div>
                  {a.reason && <div className="mt-1.5 whitespace-normal break-words text-xs leading-relaxed text-muted" title={reason(a.reason)}>{reason(a.reason)}</div>}
                </div>);
            } },
          ]} />
      </Panel>
    </>
  );
}
