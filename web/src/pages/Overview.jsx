import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from 'recharts';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import { PageHeader, Stat, Panel, Empty, Loading, Notice, KV, Dot } from '../components/ui';
import { usd, tone, num, ago, short, locale as fmtLocale, TXKIND, TXSTATUS } from '../fmt';
import { useI18n, reason } from '../i18n';

function EquityChart({ points }) {
  const { t } = useI18n();
  const data = points.map((e) => ({ t: e.ts, v: e.total_quote }));
  if (data.length < 2 || data.every((d) => !d.v)) {
    return <Empty title="Belum ada riwayat nilai" sub="Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit." />;
  }
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false}
            minTickGap={48} tick={{ fill: 'var(--muted)', fontSize: 11 }}
            tickFormatter={(v) => new Date(v).toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' })} />
          <YAxis width={52} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }}
            tickFormatter={(v) => '$' + Math.round(v)} />
          <ReTooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
            labelFormatter={(v) => new Date(v).toLocaleString(fmtLocale())} formatter={(v) => [usd(v), t('Nilai')]} />
          <Area type="linear" dataKey="v" stroke="var(--accent)" strokeWidth={1.75} fill="url(#eq)" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Delapan angka milidetik berjajar tidak bisa dibaca sekilas. Yang dicari mata:
// "apakah RPC-nya sehat?" — jadi tampilkan median, dan sisanya di tooltip.
function Latency({ rpc }) {
  const { t } = useI18n();
  const ms = rpc.map((r) => r.lastMs).filter((x) => x != null).sort((a, b) => a - b);
  if (!ms.length) return <span className="text-muted">—</span>;
  const med = ms[Math.floor(ms.length / 2)];
  const cooling = rpc.filter((r) => r.cooling).length;
  const judul = rpc.map((r) => `${r.host} · ${r.lastMs} ms${r.cooling ? ' · istirahat' : ''}${r.errors ? ` · ${r.errors} error` : ''}`).join('\n');
  return (
    <span title={judul}>
      {t('{n} ms', { n: med })}
      <span className="ml-1.5 font-normal text-muted">{t('median · {n} RPC', { n: rpc.length })}</span>
      {cooling > 0 && <span className="ml-1.5 font-normal text-warning">{t('{n} istirahat', { n: cooling })}</span>}
    </span>
  );
}

export default function Overview() {
  const { t } = useI18n();
  const { status: d } = useStatus();
  const { data: tx } = usePoll('/api/txs', 10000);
  if (!d) return <Loading />;
  const s = d.summary, T = d.totals || {};
  // Kursor bisa sedikit MENDAHULUI kepala rantai yang terakhir dibaca; itu sinkron,
  // bukan "tertinggal −19 blok".
  const lag = Math.max(0, d.chain.lag);
  const maxSkip = Math.max(1, ...(d.skipReasons || []).map((r) => r.n));

  return (
    <>
      <PageHeader group="Pemantauan" title="Ringkasan" />
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Eksposur terbuka" value={usd(s.exposureUsd)} sub={t('{n} posisi · {r} in-range', { n: s.openCount, r: s.inRange })} />
        <Stat label="Fee terkumpul" value={usd(s.feeUsd)}
          sub={s.costUsd > 0 ? t('{p}% dari modal', { p: num((s.feeUsd / s.costUsd) * 100, 2) }) : t('belum diklaim')} />
        <Stat label="PnL belum terealisasi" value={usd(s.unrealizedUsd)} valueClass={tone(s.unrealizedUsd)} sub="nilai + fee − modal" />
        <Stat label="PnL terealisasi" value={usd(s.realizedUsd)} valueClass={tone(s.realizedUsd)} sub="dari posisi tertutup" />
      </div>

      <div className="mb-4 grid items-start gap-3 lg:grid-cols-3">
        <Panel title="Nilai portofolio" className="lg:col-span-2"><EquityChart points={d.equity || []} /></Panel>
        <Panel title="Kesehatan mesin" bodyClass="p-0">
          <div className="divide-y divide-border px-4">
            <KV label="Blok terkini">{num(d.chain.head)}</KV>
            <KV label="Tertinggal">
              <Dot tone={lag < 60 ? 'success' : 'warning'} />
              <span className="ml-1.5">{lag === 0 ? t('sinkron') : t('{n} blok', { n: num(lag) })}</span>
            </KV>
            <KV label="Aksi terdeteksi">{num(T.actions)}</KV>
            <KV label="Disalin / dilewati">{num(T.would)} / {num(T.skipped)}</KV>
            <KV label="Harga ETH">{usd(d.chain.ethUsd)}</KV>
            <KV label="Latensi RPC"><Latency rpc={d.rpc || []} /></KV>
          </div>
          {d.stats.lastError && <div className="p-4 pt-3"><Notice status="warning" title="Error terakhir">{d.stats.lastError}</Notice></div>}
        </Panel>
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Panel title="Alasan terbanyak dilewati" bodyClass="p-0">
          {d.skipReasons.length ? (
            <div className="divide-y divide-border">
              {d.skipReasons.map((r) => (
                // Batang tipis di latar: perbandingan antaralasan terbaca tanpa membaca angkanya.
                <div key={r.reason} className="relative flex items-center justify-between gap-4 px-4 py-2 text-sm">
                  <div className="absolute inset-y-0 left-0 bg-default/70" style={{ width: `${(r.n / maxSkip) * 100}%` }} />
                  <span className="relative truncate">{reason(r.reason)}</span>
                  <span className="num relative shrink-0 font-medium text-muted">{r.n}</span>
                </div>
              ))}
            </div>
          ) : <div className="p-4"><Empty title="Belum ada yang dilewati" /></div>}
        </Panel>
        <Panel title="Transaksi terakhir" bodyClass="p-0">
          {tx?.txs?.length ? (
            <div className="divide-y divide-border">
              {tx.txs.slice(0, 8).map((x) => (
                <div key={x.hash} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <Dot tone={TXSTATUS[x.status]?.[1] || 'default'} title={TXSTATUS[x.status]?.[0] || x.status} />
                  <span className="min-w-0 flex-1 truncate">{t(TXKIND[x.kind] || x.kind)}</span>
                  <span className="mono shrink-0 text-muted">{short(x.hash)}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted">{ago(x.ts)}</span>
                </div>
              ))}
            </div>
          ) : <div className="p-4"><Empty title="Belum ada transaksi" sub="Mode simulasi tidak mengirim transaksi." /></div>}
        </Panel>
      </div>
    </>
  );
}
