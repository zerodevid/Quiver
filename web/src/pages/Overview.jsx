import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from 'recharts';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import { PageHeader, Stat, Panel, Empty, Loading, Tag, Notice } from '../components/ui';
import { usd, tone, num, ago, short, locale as fmtLocale, TXKIND, TXSTATUS } from '../fmt';
import { useI18n, reason } from '../i18n';

function EquityChart({ points }) {
  const { t } = useI18n();
  const data = points.map((e) => ({ t: e.ts, v: e.total_quote }));
  if (data.length < 2 || data.every((d) => !d.v)) {
    return <Empty title="Belum ada riwayat nilai" sub="Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit." />;
  }
  return (
    <div className="h-60">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickFormatter={(v) => new Date(v).toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' })} />
          <YAxis width={56} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickFormatter={(v) => '$' + Math.round(v)} />
          <ReTooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
            labelFormatter={(v) => new Date(v).toLocaleString(fmtLocale())} formatter={(v) => [usd(v), t('Nilai')]} />
          <Line type="linear" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Row({ label, children }) {
  const { t } = useI18n();
  return <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
    <span className="text-muted">{t(label)}</span><span className="num font-medium">{children}</span></div>;
}

export default function Overview() {
  const { t } = useI18n();
  const { status: d } = useStatus();
  const { data: tx } = usePoll('/api/txs', 10000);
  if (!d) return <Loading />;
  const s = d.summary, T = d.totals || {};
  const lagOk = d.chain.lag < 60;

  return (
    <>
      <PageHeader group="Pemantauan" title="Ringkasan" />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Eksposur terbuka" value={usd(s.exposureUsd)} sub={t('{n} posisi · {r} in-range', { n: s.openCount, r: s.inRange })} />
        <Stat label="Fee terkumpul" value={usd(s.feeUsd)} valueClass={s.feeUsd > 0 ? 'text-success' : ''}
          sub={s.costUsd > 0 ? t('{p}% dari modal', { p: ((s.feeUsd / s.costUsd) * 100).toFixed(2) }) : t('belum diklaim')} />
        <Stat label="PnL belum terealisasi" value={usd(s.unrealizedUsd)} valueClass={tone(s.unrealizedUsd)} sub="nilai + fee − modal" />
        <Stat label="PnL terealisasi" value={usd(s.realizedUsd)} valueClass={tone(s.realizedUsd)} sub="dari posisi tertutup" />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Panel title="Nilai portofolio" className="lg:col-span-2"><EquityChart points={d.equity || []} /></Panel>
        <Panel title="Kesehatan mesin" bodyClass="divide-y divide-border">
          <Row label="Blok terkini">{num(d.chain.head)}</Row>
          <Row label="Tertinggal">
            <span className={`mr-1.5 inline-block size-2 rounded-full ${lagOk ? 'bg-success' : 'bg-warning'}`} />{t('{n} blok', { n: num(d.chain.lag) })}
          </Row>
          <Row label="Aksi terdeteksi">{num(T.actions)}</Row>
          <Row label="Disalin / dilewati">{num(T.would)} / {num(T.skipped)}</Row>
          <Row label="Harga ETH">{usd(d.chain.ethUsd)}</Row>
          <Row label="Latensi RPC">{d.rpc.map((r) => `${r.lastMs}`).join(' · ')} ms</Row>
          {d.stats.lastError && <div className="pt-3"><Notice status="warning" title="Error terakhir">{d.stats.lastError}</Notice></div>}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Alasan terbanyak dilewati" bodyClass="divide-y divide-border">
          {d.skipReasons.length ? d.skipReasons.map((r) => (
            <div key={r.reason} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <span className="truncate">{reason(r.reason)}</span><span className="num text-muted">{r.n}</span></div>
          )) : <Empty title="Belum ada yang dilewati" />}
        </Panel>
        <Panel title="Transaksi terakhir" bodyClass="divide-y divide-border">
          {tx?.txs?.length ? tx.txs.slice(0, 8).map((x) => (
            <div key={x.hash} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="flex items-center gap-2"><Tag map={TXSTATUS} k={x.status} />{t(TXKIND[x.kind] || x.kind)}</div>
              <div className="flex items-center gap-3"><span className="mono text-muted">{short(x.hash)}</span>
                <span className="text-muted">{ago(x.ts)}</span></div>
            </div>
          )) : <Empty title="Belum ada transaksi" sub="Mode simulasi tidak mengirim transaksi." />}
        </Panel>
      </div>
    </>
  );
}
