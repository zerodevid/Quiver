import { lazy, Suspense } from 'react';
import { Button } from '@heroui/react';
import { usePoll } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { PageHeader, Panel, DataTable, Empty, Loading, PriceRange, Dot, ask } from '../components/ui';
import { TokenPair } from '../components/TokenIcon';
// Halaman detail membawa pustaka grafik — dimuat hanya saat dibuka.
const PositionDetail = lazy(() => import('./PositionDetail'));
import { usd, pct, tone, age, ago, short, num } from '../fmt';
import { useI18n } from '../i18n';

const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);

// Angka yang dicari sebelum membaca baris satu per satu, di kepala panel.
function Totals({ items }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
      {items.map(([k, v, cls]) => (
        <span key={k} className="whitespace-nowrap"><span className="text-muted">{t(k)}</span> <span className={`num font-medium ${cls || ''}`}>{v}</span></span>
      ))}
    </div>
  );
}

// Dipakai juga panel "Posisi aktif" di Ringkasan. Nama pasangan menaut ke halaman
// detail posisi (grafik harga, titik masuk, data pasar).
export function Pair({ p }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5">
      <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
      <div className="min-w-0">
        <a href={'#positions/' + p.id} className="font-medium whitespace-nowrap hover:underline">{p.symbol0 || '?'}/{p.symbol1 || '?'}</a>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
          <span className="uppercase">{p.venue}</span><span>·</span><span className="num">{num(p.fee / 10000, 2)}%</span>
          {p.inRange != null && <><span>·</span><Dot tone={p.inRange ? 'success' : 'warning'} />
            <span className={p.inRange ? 'text-success' : 'text-warning'}>{t(p.inRange ? 'in-range' : 'di luar')}</span></>}
        </div>
      </div>
    </div>
  );
}

export default function Positions({ param }) {
  const { t } = useI18n();
  // #positions/123 -> detail satu posisi. Poll daftar dimatikan selama detail terbuka.
  const { data: d, reload } = usePoll(param ? null : '/api/positions', 10000);
  const { close, closing } = useClosePosition(reload);
  if (param) return <Suspense fallback={<Loading />}><PositionDetail id={param} /></Suspense>;
  if (!d) return <Loading />;
  const open = d.positions, closed = d.closed;
  const openPnl = sum(open, (p) => p.pnlUsd);
  const closedPnl = sum(closed, (c) => (c.out_quote || 0) - (c.cost_quote || 0));

  return (
    <>
      <PageHeader group="Pemantauan" title="Posisi" desc="Posisi LP milik bot — nilai, fee, dan PnL diperbarui dari chain tiap 30 detik." />
      <Panel title={t('Posisi terbuka ({n})', { n: open.length })} className="mb-4" bodyClass="p-0"
        action={open.length > 0 && <Totals items={[
          ['Nilai', usd(sum(open, (p) => p.valueUsd))],
          ['Fee', usd(sum(open, (p) => p.feeUsd))],
          ['PnL', usd(openPnl), tone(openPnl)],
        ]} />}>
        <DataTable label="Posisi terbuka" rows={open} rowKey={(p) => p.id} searchable
          defaultSort={{ column: 'val', direction: 'descending' }}
          empty={<Empty title="Belum ada posisi terbuka" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
          columns={[
            { key: 'pair', label: 'Pasangan', sort: (p) => `${p.symbol0}/${p.symbol1}`, render: (p) => <Pair p={p} /> },
            { key: 'range', label: 'Rentang harga', sortable: false, render: (p) => (
              <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick}
                dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
                entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
            { key: 'val', label: 'Nilai', align: 'end', sort: (p) => p.valueUsd, render: (p) => (
              <div className="whitespace-nowrap">{usd(p.valueUsd)}<div className="text-xs text-muted">{t('modal {v}', { v: usd(p.costUsd) })}</div></div>) },
            { key: 'fee', label: 'Fee', align: 'end', sort: (p) => p.feeUsd, render: (p) => <span className={p.feeUsd > 0.005 ? 'text-success' : 'text-muted'}>{usd(p.feeUsd)}</span> },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnlUsd, render: (p) => (
              <div className={`whitespace-nowrap ${tone(p.pnlUsd)}`}>{usd(p.pnlUsd)}<div className="text-xs">{pct(p.pnlPct)}</div></div>) },
            { key: 'il', label: 'IL', align: 'end', sort: (p) => p.ilUsd, render: (p) => <span className={tone(p.ilUsd)}>{p.ilUsd == null ? '—' : usd(p.ilUsd)}</span> },
            { key: 'age', label: 'Umur', align: 'end', sort: (p) => p.ageHours, render: (p) => <span className="whitespace-nowrap text-muted">{age(p.ageHours)}</span> },
            { key: 'tgt', label: 'Sumber', sort: (p) => p.target, render: (p) => p.target
              ? <a href={'#targets/' + p.target} className="mono text-muted hover:text-foreground hover:underline">{short(p.target)}</a>
              // diadopsi dari wallet: dibuka manual atau oleh program lain, bukan salinan
              : <span className="text-xs text-muted" title={t('Posisi ini sudah ada di wallet, tidak menyalin target mana pun. Bot hanya memantaunya; tutup manual kalau perlu.')}>{t('di luar bot')}</span> },
            { key: 'act', label: '', sortable: false, className: 'text-end', render: (p) => (
              <Button size="sm" variant="danger-soft" isPending={closing === p.id} isDisabled={closing != null} onPress={() => close(p)}>{t('Tutup')}</Button>) },
          ]} />
      </Panel>
      <Panel title={t('Posisi tertutup ({n})', { n: closed.length })} bodyClass="p-0"
        action={closed.length > 0 && <Totals items={[['PnL', usd(closedPnl), tone(closedPnl)]]} />}>
        <DataTable label="Posisi tertutup" rows={closed} rowKey={(c) => c.id} searchable pageSize={20}
          defaultSort={{ column: 'at', direction: 'descending' }}
          empty={<Empty title="Belum ada posisi tertutup" />}
          columns={[
            { key: 'pair', label: 'Pasangan', sort: (c) => `${c.symbol0}/${c.symbol1}`, search: (c) => `${c.symbol0}/${c.symbol1} ${c.token_id}`, render: (c) => (
              <div className="flex items-center gap-2.5">
                <TokenPair token0={c.token0} token1={c.token1} symbol0={c.symbol0} symbol1={c.symbol1} size={20} />
                <div><a href={'#positions/' + c.id} className="font-medium whitespace-nowrap hover:underline">{c.symbol0 || '?'}/{c.symbol1 || '?'}</a>
                  <div className="mono mt-0.5 text-xs text-muted">{String(c.venue || '').toUpperCase()} · #{c.token_id}</div></div>
              </div>) },
            { key: 'cost', label: 'Modal', align: 'end', sort: (c) => c.cost_quote, render: (c) => usd(c.cost_quote) },
            { key: 'out', label: 'Hasil', align: 'end', sort: (c) => c.out_quote, render: (c) => usd(c.out_quote) },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (c) => (c.out_quote || 0) - (c.cost_quote || 0), render: (c) => {
              const v = (c.out_quote || 0) - (c.cost_quote || 0);
              return <div className={tone(v)}>{usd(v)}<div className="text-xs">{c.cost_quote > 0 ? pct((v / c.cost_quote) * 100, 2) : ''}</div></div>;
            } },
            { key: 'dur', label: 'Durasi', align: 'end', sort: (c) => (c.closed_ts || 0) - (c.opened_ts || 0), render: (c) => (
              <span className="whitespace-nowrap text-muted">{c.opened_ts && c.closed_ts ? age((c.closed_ts - c.opened_ts) / 3600000) : '—'}</span>) },
            { key: 'at', label: 'Ditutup', align: 'end', sort: (c) => c.closed_ts, render: (c) => <span className="whitespace-nowrap text-muted">{ago(c.closed_ts)}</span> },
          ]} />
      </Panel>
    </>
  );
}
