import { useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { Play } from 'lucide-react';
import { post } from '../api';
import { Segmented, Notice } from './ui';
import { usd, ago } from '../fmt';
import { useI18n } from '../i18n';

// Replays the target's recent entries under the rules currently in the form (saved or not),
// so the effect of an edit shows before saving. `address` empty = every target (default rules).
export default function RulesSimulation({ rules, address = null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('all');
  const run = async () => {
    setBusy(true); setError('');
    try {
      const r = await post('/api/rules/simulate', { rules, address, limit: 100 });
      if (r.error) throw new Error(r.error);
      setRes(r); setView('all');
    } catch (e) { setError(e.message || t('Gagal')); }
    finally { setBusy(false); }
  };
  const items = (res?.items || []).filter((x) => view === 'all' || x.verdict === view);
  const s = res?.summary;
  return (
    <section className="mt-6 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{t('Simulasi aturan')}</h3>
          <p className="mt-1 text-sm text-muted">{t('Uji aturan di atas pada 100 entri terakhir target. Hasilnya belum disimpan dan tidak membuka posisi.')}</p>
        </div>
        <Button variant="outline" onPress={run} isPending={busy}><Play className="size-4" aria-hidden="true" />{t('Jalankan simulasi')}</Button>
      </div>
      {error && <div role="alert" className="mt-3"><Notice status="danger">{error}</Notice></div>}
      {s && !s.total && <p className="mt-4 text-sm text-muted">{t('Belum ada entri target untuk disimulasikan.')}</p>}
      {s?.total > 0 && <>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <Chip size="sm" variant="soft" color="success">{t('{n} diterima', { n: s.copy })}</Chip>
          <Chip size="sm" variant="soft" color="danger">{t('{n} ditolak', { n: s.skip })}</Chip>
          <span className="num text-muted">{t('modal masuk ≈ {v}', { v: usd(s.usd, 0) })}</span>
          <span className="ml-auto"><Segmented size="sm" aria="Saring hasil" value={view} onChange={setView}
            options={[['all', 'Semua', s.total], ['copy', 'Diterima', s.copy], ['skip', 'Ditolak', s.skip]]} /></span>
        </div>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {items.map((x) => {
            const flip = x.actual && x.actual.verdict !== x.verdict && (x.actual.verdict === 'copy' || x.actual.verdict === 'skip');
            return <li key={x.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3 text-sm">
              <Chip size="sm" variant="soft" color={x.verdict === 'copy' ? 'success' : 'danger'}>{t(x.verdict === 'copy' ? 'Diterima' : 'Ditolak')}</Chip>
              <span className="font-medium">{x.pair}</span>
              <span className="text-muted">{x.venue} · {x.kind}</span>
              <span className="num text-muted">{t('target {v}', { v: usd(x.targetUsd, 0) })}{x.usd != null && ` → ${usd(x.usd, 0)}`}</span>
              <span className="ml-auto text-xs text-muted">{ago(x.ts)}</span>
              <p className="basis-full text-xs text-muted">{x.reason}</p>
              {flip && <p className="basis-full text-xs text-warning">{t('Bot dulu: {v}', { v: t(x.actual.verdict === 'copy' ? 'Diterima' : 'Ditolak') })}{x.actual.reason ? ` — ${x.actual.reason}` : ''}</p>}
            </li>;
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">{t('Tidak dihitung: saldo kas, eksposur terbuka, anggaran harian, jumlah posisi, jeda pool, dan harga pool saat itu. Umur, likuiditas, dan volume pool memakai data DexScreener saat ini.')}</p>
      </>}
    </section>
  );
}
