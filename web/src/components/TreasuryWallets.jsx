// Settings → Fee wallet (superadmin): the per-chain treasury that the platform fee is sent to,
// its live on-chain balance, and a chart of the fee income that reached it. The balance comes
// from the chain (so withdrawals show); the income series comes from every account's fee ledger.
import { useMemo, useState } from 'react';
import { Button, Card, toast } from '@heroui/react';
import { ExternalLink } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { post } from '../api';
import { usePoll } from '../hooks';
import { Stat, Empty, Loading, Notice, Segmented, CopyBtn, ChainMark } from './ui';
import { usd, addrHref, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const DAY = 864e5;
const amt = (v, d = 6) => (v == null ? '—' : Number(v).toLocaleString(fmtLocale(), { maximumFractionDigits: d }));
const dayFmt = (v) => new Date(v).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' });

// Daily buckets with the empty days filled in, so the cumulative line steps at the right place
// and the bars keep a steady width.
function series(daily, chain) {
  const rows = daily.filter((r) => chain === 'all' || r.chain === chain);
  if (!rows.length) return [];
  const byDay = new Map();
  for (const r of rows) {
    const b = byDay.get(r.day) || { usd: 0, n: 0 };
    b.usd += r.usd; b.n += r.n;
    byDay.set(r.day, b);
  }
  const first = Math.min(...byDay.keys());
  const last = Math.max(Math.max(...byDay.keys()), Math.floor(Date.now() / DAY) * DAY);
  const out = [];
  let cum = 0;
  for (let d = first; d <= last; d += DAY) {
    const b = byDay.get(d) || { usd: 0, n: 0 };
    cum += b.usd;
    out.push({ t: d, usd: b.usd, n: b.n, cum });
  }
  return out;
}

function Tip({ active, payload, view, t }) {
  const d = active && payload?.[0]?.payload;
  if (!d) return null;
  return (
    <div className="min-w-40 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg shadow-black/10">
      <div className="text-muted">{new Date(d.t).toLocaleDateString(fmtLocale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <span className="text-muted">{t(view === 'cum' ? 'Total terkumpul' : 'Fee masuk')}</span>
        <span className="num text-sm font-semibold">{usd(view === 'cum' ? d.cum : d.usd)}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-4">
        <span className="text-muted">{t('Transaksi hari itu')}</span>
        <span className="num">{d.n}</span>
      </div>
    </div>
  );
}

function IncomeChart({ pts, view }) {
  const { t } = useI18n();
  if (pts.length < 1) return <Empty title="Belum ada fee masuk" sub="Grafik terisi setelah akun pengguna membayar fee pertama ke wallet ini." />;
  const axis = { tickLine: false, axisLine: false, tick: { fill: 'var(--muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums' } };
  const common = (
    <>
      <CartesianGrid stroke="var(--border)" strokeOpacity={0.6} vertical={false} />
      <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={dayFmt} minTickGap={24} tickMargin={8}
        padding={{ left: 8, right: 8 }} {...axis} />
      <YAxis width={58} tickMargin={6} tickFormatter={(v) => usd(v, v < 10 ? 2 : 0)} allowDecimals {...axis} />
      <Tooltip content={<Tip view={view} t={t} />} cursor={view === 'cum' ? { stroke: 'var(--muted)', strokeOpacity: 0.6 } : { fill: 'var(--default)', fillOpacity: 0.5 }} />
    </>
  );
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        {view === 'cum' ? (
          <AreaChart data={pts} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="treasury-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--success)" stopOpacity={0.2} />
                <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {common}
            <Area type="stepAfter" dataKey="cum" stroke="var(--success)" strokeWidth={2} fill="url(#treasury-fill)" isAnimationActive={false} />
          </AreaChart>
        ) : (
          <BarChart data={pts} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            {common}
            <Bar dataKey="usd" fill="var(--success)" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export default function TreasuryWallets() {
  const { t } = useI18n();
  const tr = usePoll('/api/admin/treasury', 60000);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState('all');
  const [view, setView] = useState('cum');
  const data = tr.data && !tr.data.error ? tr.data : null;
  // Solana has no treasury transfer yet (the fee engine and the address check are EVM-only).
  const chains = useMemo(() => (data?.chains || []).filter((c) => c.kind !== 'solana'), [data]);
  const pts = useMemo(() => series(data?.daily || [], chain), [data, chain]);

  if (tr.data?.error) return <Notice status="warning">{t(tr.data.error)}</Notice>;
  if (!data) return <Loading />;

  const d = draft || Object.fromEntries(chains.map((c) => [c.key, { address: c.address, referral: c.referral }]));
  const setAddr = (k, field, v) => setDraft({ ...d, [k]: { ...d[k], [field]: v } });
  const save = async () => {
    setBusy(true);
    const r = await post('/api/admin/fees', { treasury: d });
    setBusy(false);
    if (r.error) return toast.danger(t(r.error));
    toast.success(t('Wallet fee disimpan')); setDraft(null); tr.reload();
  };

  const balUsd = chains.reduce((s, c) => s + (c.balance != null && c.nativeUsd ? c.balance * c.nativeUsd : 0), 0);
  const inScope = (data.daily || []).filter((r) => chain === 'all' || r.chain === chain);
  const totalUsd = inScope.reduce((s, r) => s + r.usd, 0);
  const totalN = inScope.reduce((s, r) => s + r.n, 0);
  const since30 = Date.now() - 30 * DAY;
  const last30 = inScope.filter((r) => r.day >= since30).reduce((s, r) => s + r.usd, 0);
  const withIncome = [...new Set((data.daily || []).map((r) => r.chain))];
  const field = 'w-full min-w-0 rounded-md border border-[var(--field-border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs';

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Saldo wallet fee" value={usd(balUsd)} sub="Saldo native di semua chain, dibaca langsung dari jaringan" />
        <Stat label="Total fee masuk" value={usd(totalUsd)} sub={t('{n} transaksi fee', { n: totalN })} />
        <Stat label="30 hari terakhir" value={usd(last30)} />
      </div>

      <Card className="p-4!">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('Fee masuk')}</h3>
          <div className="flex flex-wrap gap-2">
            {withIncome.length > 1 && (
              <Segmented size="sm" aria="Chain" value={chain} onChange={setChain}
                options={[['all', 'Semua'], ...withIncome.map((k) => [k, chains.find((c) => c.key === k)?.label || k])]} />
            )}
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={[['cum', 'Kumulatif'], ['daily', 'Harian']]} />
          </div>
        </div>
        <IncomeChart pts={pts} view={view} />
      </Card>

      <div className="flex flex-col gap-3">
        {chains.map((c) => {
          const saved = c.address;
          return (
            <Card key={c.key} className="gap-3! p-4!">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium"><ChainMark chain={c.key} />{c.label}</div>
                {saved ? (
                  <div className="text-right">
                    <div className="num text-base font-semibold">{amt(c.balance)} {c.nativeSymbol}</div>
                    <div className="num text-xs text-muted">{c.balance != null && c.nativeUsd ? usd(c.balance * c.nativeUsd) : c.error ? t('Saldo gagal dibaca') : '—'}</div>
                  </div>
                ) : <span className="text-xs text-muted">{t('Belum diatur — fee di chain ini gratis')}</span>}
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t('Alamat wallet fee')}
                <div className="flex items-center gap-1.5">
                  <input className={field} placeholder="0x…" value={d[c.key]?.address || ''} onChange={(e) => setAddr(c.key, 'address', e.target.value)} />
                  {saved && <CopyBtn value={saved} />}
                  {saved && <a href={addrHref(saved, c.key)} target="_blank" rel="noreferrer" className="text-muted hover:text-foreground" aria-label={t('Buka di penjelajah')}><ExternalLink className="size-3.5" /></a>}
                </div>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t('Wallet referral (opsional)')}
                <input className={field} placeholder="0x…" value={d[c.key]?.referral || ''} onChange={(e) => setAddr(c.key, 'referral', e.target.value)} />
                {c.referral && c.refBalance != null && <span className="num">{t('Saldo')}: {amt(c.refBalance)} {c.nativeSymbol}</span>}
              </label>
            </Card>
          );
        })}
        {!chains.length && <Empty title="Tidak ada chain EVM yang aktif" />}
      </div>
      <div className="flex gap-2">
        <Button isPending={busy} isDisabled={!draft} onPress={save}>{t('Simpan')}</Button>
        {draft && <Button variant="ghost" onPress={() => setDraft(null)}>{t('Batal')}</Button>}
      </div>
    </div>
  );
}
