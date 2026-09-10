import { Button } from '@heroui/react';
import { usePoll } from '../hooks';
import { post } from '../api';
import { PageHeader, Panel, DataTable, Empty, Loading, PriceRange, Tag } from '../components/ui';
import { usd, pct, tone, age, ago, short } from '../fmt';

export default function Positions() {
  const { data: d, reload } = usePoll('/api/positions', 10000);
  if (!d) return <Loading />;
  const close = async (id) => {
    if (!confirm('Tutup posisi ini sekarang?')) return;
    const r = await post('/api/positions/close', { id });
    alert(r.error ? 'Gagal: ' + r.error : 'Terkirim: ' + r.tx);
    reload();
  };
  return (
    <>
      <PageHeader group="Pemantauan" title="Posisi" desc="Posisi LP milik bot — nilai, fee, dan PnL diperbarui dari chain tiap 30 detik." />
      <Panel title={`Posisi terbuka (${d.positions.length})`} className="mb-6" bodyClass="p-0">
        <DataTable label="Posisi terbuka" rows={d.positions} rowKey={(p) => p.id}
          empty={<Empty title="Belum ada posisi terbuka" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
          columns={[
            { key: 'pair', label: 'Pasangan', render: (p) => (
              <div><div className="font-medium">{p.symbol0}/{p.symbol1}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">{p.venue} · fee {(p.fee / 10000).toFixed(2)}%
                  <Tag map={{ in: ['in-range', 'success'], out: ['di luar', 'warning'] }} k={p.inRange ? 'in' : 'out'} /></div></div>) },
            { key: 'range', label: 'Rentang harga', render: (p) => (
              <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick}
                dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
      entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
            { key: 'val', label: 'Nilai', align: 'end', render: (p) => (<div>{usd(p.valueUsd)}<div className="text-xs text-muted">modal {usd(p.costUsd)}</div></div>) },
            { key: 'fee', label: 'Fee', align: 'end', render: (p) => <span className="text-success">{usd(p.feeUsd)}</span> },
            { key: 'pnl', label: 'PnL', align: 'end', render: (p) => (<div className={tone(p.pnlUsd)}>{usd(p.pnlUsd)}<div className="text-xs">{pct(p.pnlPct)}</div></div>) },
            { key: 'il', label: 'IL', align: 'end', render: (p) => <span className={tone(p.ilUsd)}>{p.ilUsd == null ? '—' : usd(p.ilUsd)}</span> },
            { key: 'age', label: 'Umur', render: (p) => <span className="text-muted">{age(p.ageHours)}</span> },
            { key: 'tgt', label: 'Target', render: (p) => <span className="mono text-muted">{short(p.target)}</span> },
            { key: 'act', label: '', render: (p) => <Button size="sm" variant="danger" onPress={() => close(p.id)}>Tutup</Button> },
          ]} />
      </Panel>
      <Panel title="Posisi tertutup" bodyClass="p-0">
        <DataTable label="Posisi tertutup" rows={d.closed} rowKey={(c) => c.id}
          empty={<Empty title="Belum ada posisi tertutup" />}
          columns={[
            { key: 'id', label: 'Posisi', render: (c) => <span className="mono">#{c.token_id}</span> },
            { key: 'cost', label: 'Modal', align: 'end', render: (c) => usd(c.cost_quote) },
            { key: 'out', label: 'Hasil', align: 'end', render: (c) => usd(c.out_quote) },
            { key: 'pnl', label: 'PnL', align: 'end', render: (c) => { const v = (c.out_quote || 0) - (c.cost_quote || 0); return <span className={tone(v)}>{usd(v)}</span>; } },
            { key: 'at', label: 'Ditutup', render: (c) => <span className="text-muted">{ago(c.closed_ts)}</span> },
          ]} />
      </Panel>
    </>
  );
}
