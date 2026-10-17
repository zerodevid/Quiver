import { useEffect, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { Play } from 'lucide-react';
import { get, post } from '../api';
import { Segmented, Notice, Text, Pick } from './ui';
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
  const [source, setSource] = useState('history');
  const [quotes, setQuotes] = useState([]);
  const [sc, setSc] = useState({ token: '', quote: '', valueUsd: '500', venue: 'v3', fee: '3000', hooks: '' });
  useEffect(() => { get('/api/rules').then((d) => { const q = [...new Set(d.quotes || [])]; setQuotes(q); setSc((x) => (x.quote || !q.length ? x : { ...x, quote: q[0] })); }).catch(() => {}); }, []);
  const setField = (k) => (v) => setSc((x) => ({ ...x, [k]: v }));
  const run = async () => {
    setBusy(true); setError('');
    try {
      const r = await post('/api/rules/simulate', { rules, address, limit: 100, ...(source === 'scenario' ? { scenario: sc } : {}) });
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
          <p className="mt-1 text-sm text-muted">{t(source === 'history' ? 'Uji aturan di atas pada 100 entri terakhir target. Hasilnya belum disimpan dan tidak membuka posisi.' : 'Isi posisi target hipotetis, lalu lihat apakah aturan di atas menerimanya. Tidak membuka posisi.')}</p>
        </div>
        <Button variant="outline" onPress={run} isPending={busy}><Play className="size-4" aria-hidden="true" />{t('Jalankan simulasi')}</Button>
      </div>
      <div className="mt-3"><Segmented size="sm" aria="Sumber simulasi" value={source} onChange={(v) => { setSource(v); setRes(null); setError(''); }}
        options={[['history', 'Riwayat target'], ['scenario', 'Posisi hipotetis']]} /></div>
      {source === 'scenario' && <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Text label="Alamat token (memecoin)" mono value={sc.token} onChange={setField('token')} placeholder="0x…" className="md:col-span-3" />
        <Pick label="Aset kuotasi" value={sc.quote} onChange={setField('quote')} options={[...quotes.map((q) => [q, q]), ['', 'Tanpa kuotasi (dua memecoin)']]} />
        <Text label="Nilai posisi target (USD)" type="number" value={sc.valueUsd} onChange={setField('valueUsd')} />
        <Pick label="Venue" value={sc.venue} onChange={setField('venue')} options={(rules?.filters?.venues?.length ? rules.filters.venues : ['v3', 'v4']).map((v) => [v, v])} />
        <Text label="Fee tier (satuan Uniswap, mis. 3000)" type="number" value={sc.fee} onChange={setField('fee')} />
        <Text label="Alamat hook (opsional, v4)" mono value={sc.hooks} onChange={setField('hooks')} placeholder="0x…" className="md:col-span-2" />
      </div>}
      {error && <div role="alert" className="mt-3"><Notice status="danger">{error}</Notice></div>}
      {s && !s.total && <p className="mt-4 text-sm text-muted">{t('Belum ada entri target untuk disimulasikan.')}</p>}
      {s?.total > 0 && <>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <Chip size="sm" variant="soft" color="success">{t('{n} diterima', { n: s.copy })}</Chip>
          <Chip size="sm" variant="soft" color="danger">{t('{n} ditolak', { n: s.skip })}</Chip>
          <span className="num text-muted">{t('modal masuk ≈ {v}', { v: usd(s.usd, 0) })}</span>
          <span className="ml-auto"><Segmented size="sm" aria="Saring hasil" value={view} onChange={setView}
            options={[['all', 'Semua', s.total], ['copy', 'Lolos', s.copy], ['skip', 'Ditolak', s.skip]]} /></span>
        </div>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {items.map((x) => {
            const flip = x.actual && x.actual.verdict !== x.verdict && (x.actual.verdict === 'copy' || x.actual.verdict === 'skip');
            return <li key={x.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3 text-sm">
              <Chip size="sm" variant="soft" color={x.verdict === 'copy' ? 'success' : 'danger'}>{t(x.verdict === 'copy' ? 'Lolos' : 'Ditolak')}</Chip>
              <span className="font-medium">{x.pair}</span>
              <span className="text-muted">{x.venue}{x.kind !== 'scenario' && ` · ${x.kind}`}</span>
              <span className="num text-muted">{t('target {v}', { v: usd(x.targetUsd, 0) })}{x.usd != null && ` → ${usd(x.usd, 0)}`}</span>
              {x.kind !== 'scenario' && <span className="ml-auto text-xs text-muted">{ago(x.ts)}</span>}
              <p className="basis-full text-xs text-muted">{x.reason}</p>
              {flip && <p className="basis-full text-xs text-warning">{t('Bot dulu: {v}', { v: t(x.actual.verdict === 'copy' ? 'Lolos' : 'Ditolak') })}{x.actual.reason ? ` — ${x.actual.reason}` : ''}</p>}
            </li>;
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">{t('Tidak dihitung: saldo kas, eksposur terbuka, anggaran harian, jumlah posisi, jeda pool, dan harga pool saat itu. Umur, likuiditas, dan volume pool memakai data DexScreener saat ini.')}</p>
      </>}
    </section>
  );
}
