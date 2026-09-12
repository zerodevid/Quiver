import { useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid, ReferenceLine } from 'recharts';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import { PageHeader, Stat, Panel, Empty, Loading, Notice, KV, Dot, DataTable, PriceRange, Segmented } from '../components/ui';
import PnlCalendar from '../components/PnlCalendar';
import { Pair, SyncState } from './Positions';
import { usd, tone, num, pct, age, ago, short, locale as fmtLocale, TXKIND, TXSTATUS } from '../fmt';
import { useI18n, reason } from '../i18n';

const RANGES = [['24h', '24 jam'], ['7d', '7 hari'], ['30d', '30 hari'], ['all', 'Semua']];
const VIEWS = [['pnl', 'PnL kumulatif'], ['value', 'Nilai']];
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);

// Pertumbuhan portofolio. Dua tampilan, satu sumbu — bukan dua garis berskala beda
// di satu grafik:
//  - PnL kumulatif: laba/rugi sejak awal. Tidak ikut melonjak saat dana disetor atau
//    ditarik, jadi inilah "pertumbuhan" yang sebenarnya.
//  - Nilai: kas + posisi + fee. Hanya titik yang saldo kasnya terbaca; titik lama
//    (sebelum kas ikut dicatat) cuma berisi nilai posisi dan akan menipu.
function GrowthChart({ p, view }) {
  const { t } = useI18n();
  const pts = view === 'pnl'
    ? p.series.filter((e) => e.pnl != null).map((e) => ({ t: e.ts, v: e.pnl }))
    : p.series.filter((e) => e.cash != null).map((e) => ({ t: e.ts, v: e.total, cash: e.cash, pos: (e.pos || 0) + (e.fee || 0) }));
  if (pts.length < 2) {
    return view === 'value'
      ? <Empty title="Nilai portofolio belum tercatat" sub="Kas + posisi dicatat tiap 5 menit sejak pembaruan ini (butuh wallet yang terbaca). Sementara itu lihat tampilan PnL kumulatif." />
      : <Empty title="Belum ada riwayat" sub="Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit." />;
  }

  const first = pts[0].v, last = pts[pts.length - 1].v;
  // Rentang "Semua" dihitung dari nol: PnL kumulatif memang dimulai dari nol.
  const delta = view === 'pnl'
    ? last - (p.range === 'all' ? 0 : (p.baseline?.pnl ?? first))
    : last - first;
  const cap = p.now.capital;
  const vals = pts.map((x) => x.v);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  // drawdown terdalam: jarak terbesar dari puncak sebelumnya ke titik sesudahnya
  let peak = -Infinity, dd = 0;
  for (const v of vals) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }

  const spanMs = pts[pts.length - 1].t - pts[0].t;
  const tickFmt = (v) => (spanMs <= 36 * 3600e3
    ? new Date(v).toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' })
    : new Date(v).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' }));
  const small = Math.max(Math.abs(hi), Math.abs(lo)) < 20;
  const lbl = { '24h': 'dalam 24 jam', '7d': 'dalam 7 hari', '30d': 'dalam 30 hari', all: 'sejak awal' }[p.range];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className={`num text-2xl leading-tight font-semibold tracking-tight ${tone(delta)}`}>
            {delta > 0 ? '+' : ''}{usd(delta)}
            {view === 'pnl' && cap > 0 && <span className="ml-2 text-sm font-medium">{pct((delta / cap) * 100, 2)}</span>}
          </div>
          <div className="text-xs text-muted">
            {t(lbl)}{view === 'value' && <span> · {t('termasuk setoran & penarikan')}</span>}
          </div>
        </div>
        <div className="flex gap-5 text-xs">
          <span><span className="text-muted">{t('Tertinggi')}</span> <span className="num font-medium">{usd(hi)}</span></span>
          {view === 'pnl'
            ? <span title={t('Penurunan terdalam dari puncak sebelumnya dalam rentang ini')}><span className="text-muted">{t('Drawdown maks')}</span> <span className={`num font-medium ${dd > 0.005 ? 'text-danger' : ''}`}>{dd > 0.005 ? '−' : ''}{usd(dd)}</span></span>
            : <span><span className="text-muted">{t('Terendah')}</span> <span className="num font-medium">{usd(lo)}</span></span>}
        </div>
      </div>
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pts} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false}
              minTickGap={48} tick={{ fill: 'var(--muted)', fontSize: 11 }} tickFormatter={tickFmt} />
            <YAxis width={56} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }}
              domain={view === 'pnl' ? ['auto', 'auto'] : [0, 'auto']}
              tickFormatter={(v) => usd(v, small ? 2 : 0)} />
            {/* garis nol selalu terlihat (extendDomain) tanpa merusak tick yang bulat */}
            {view === 'pnl' && <ReferenceLine y={0} stroke="var(--muted)" strokeOpacity={0.5} ifOverflow="extendDomain" />}
            <ReTooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(v) => new Date(v).toLocaleString(fmtLocale())}
              formatter={(v, _n, it) => (view === 'pnl'
                ? [usd(v), t('PnL kumulatif')]
                : [`${usd(v)}  (${t('kas {c} · posisi {p}', { c: usd(it.payload.cash), p: usd(it.payload.pos) })})`, t('Nilai')])} />
            <Area type="linear" dataKey="v" stroke="var(--accent)" strokeWidth={2} fill="url(#eq)" dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Ke mana uangnya: satu batang per pos, satu warna. Yang dibandingkan besarnya,
// bukan identitasnya — jadi tidak perlu palet kategori dan legenda.
function Composition({ now, ethUsd }) {
  const { t } = useI18n();
  const c = now.cash;
  const ethVal = c ? (c.usd - c.usdg) : 0;            // nilai ETH+WETH saat kas dibaca
  const perEth = c && c.eth + c.weth > 0 ? ethVal / (c.eth + c.weth) : ethUsd;
  const rows = [
    ['Di posisi LP', now.positionsUsd, t('{n} posisi · {r} in-range', { n: now.openCount, r: now.inRange })],
    ['Fee belum diklaim', now.feeUsd, null],
    ['Token sisa belum dijual', now.leftoverUsd || 0, null],
    ...(c ? [
      ['USDG', c.usdg, null],
      ['ETH', c.eth * perEth, `${num(c.eth, 5)} ETH`],
      ['WETH', c.weth * perEth, `${num(c.weth, 5)} WETH`],
    ] : []),
  ].filter(([k, v], i) => i === 0 || v > 0.005);
  const total = Math.max(1e-9, sum(rows, (r) => r[1]));
  return (
    <div>
      <div className="divide-y divide-border">
        {rows.map(([k, v, sub]) => (
          <div key={k} className="py-2">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{t(k)}{sub && <span className="ml-2 text-xs text-muted">{sub}</span>}</span>
              <span className="num shrink-0 font-medium">{usd(v)} <span className="ml-1 text-xs font-normal text-muted">{num((v / total) * 100, 1)}%</span></span>
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-default">
              <div className="h-1 rounded-full bg-accent" style={{ width: `${Math.max(v > 0 ? 1 : 0, (v / total) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      {!c && <p className="mt-3 text-xs text-muted">{t('Saldo kas tidak terbaca (belum ada wallet) — total hanya berisi posisi.')}</p>}
      <div className="mt-2 divide-y divide-border border-t border-border">
        {now.capital != null && (
          <KV label="Modal bersih"><span title={t('Nilai sekarang dikurangi seluruh PnL — kira-kira dana yang disetor ke wallet bot')}>{usd(now.capital)}</span></KV>
        )}
        <KV label="Modal di posisi">{usd(now.costUsd)}</KV>
      </div>
    </div>
  );
}

// Kinerja per sumber: target mana yang benar-benar menghasilkan setelah disalin.
function BySource({ rows }) {
  const { t } = useI18n();
  if (!rows.length) return <div className="p-4"><Empty title="Belum ada posisi" /></div>;
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.realized + r.upnl)));
  return (
    <div className="divide-y divide-border">
      {rows.map((r) => {
        const tot = r.realized + r.upnl;
        const wr = r.closed ? (r.wins / r.closed) * 100 : null;
        return (
          <div key={r.target || 'manual'} className="relative flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <div className={`absolute inset-y-0 left-0 ${tot >= 0 ? 'bg-success/8' : 'bg-danger/8'}`} style={{ width: `${(Math.abs(tot) / max) * 100}%` }} />
            <div className="relative min-w-0">
              {r.target
                ? <a href={'#targets/' + r.target} className="font-medium hover:underline">{r.label || <span className="mono">{short(r.target)}</span>}</a>
                : <span className="font-medium">{t('Manual / di luar bot')}</span>}
              <div className="mt-0.5 truncate text-xs text-muted">
                {t('{o} terbuka · {c} ditutup', { o: r.open, c: r.closed })}
                {wr != null && <> · {t('menang {p}%', { p: num(wr, 0) })}</>}
              </div>
            </div>
            <div className="relative shrink-0 text-end">
              <div className={`num font-medium ${tone(tot)}`}>{usd(tot)}</div>
              <div className="num text-xs text-muted">{t('terealisasi {v}', { v: usd(r.realized) })}</div>
            </div>
          </div>
        );
      })}
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

// PnL per hari dikelompokkan di browser supaya "hari" mengikuti zona waktu pengguna,
// bukan zona waktu server.
function dailyOf(closed) {
  const daily = {}, counts = {};
  const pad = (n) => String(n).padStart(2, '0');
  for (const [ts, v] of closed) {
    const d = new Date(ts);
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    daily[k] = (daily[k] || 0) + v;
    counts[k] = (counts[k] || 0) + 1;
  }
  return { daily, counts };
}

export default function Overview() {
  const { t } = useI18n();
  const { status: d } = useStatus();
  const [range, setRange] = useState('7d');
  const [view, setView] = useState('pnl');
  const { data: p } = usePoll('/api/portfolio?range=' + range, 30000);
  // Sama dengan halaman Posisi: endpoint murah, jadi posisi baru muncul dalam ~5 detik.
  const { data: pos, loading: posLoading } = usePoll('/api/positions', 5000);
  const { data: tx } = usePoll('/api/txs', 10000);
  if (!d) return <Loading />;
  const s = d.summary, T = d.totals || {};
  // Kursor bisa sedikit MENDAHULUI kepala rantai yang terakhir dibaca; itu sinkron,
  // bukan "tertinggal −19 blok".
  const lag = Math.max(0, d.chain.lag);
  const maxSkip = Math.max(1, ...(d.skipReasons || []).map((r) => r.n));
  const now = p?.now, st = p?.stats;
  const open = (pos?.positions || []).filter((x) => !x.empty);
  // Posisi yang belum ikut sinkron chain: nilai masih taksiran modal, fee & PnL belum ada.
  const pendingSync = open.filter((x) => x.syncing).length;
  const dash = (x, node) => (x.syncing ? <span className="text-muted">—</span> : node);
  const cal = p ? dailyOf(p.closed) : null;

  return (
    <>
      <PageHeader group="Pemantauan" title="Ringkasan" />
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Total portofolio" value={now ? usd(now.value) : '—'}
          sub={!now ? null : now.cash
            ? t('kas {c} · di posisi {p}', { c: usd(now.cash.usd), p: usd(now.positionsUsd + now.feeUsd) })
              + ((now.leftoverUsd || 0) > 0.005 ? t(' · sisa token {v}', { v: usd(now.leftoverUsd) }) : '')
            : t('hanya posisi — saldo kas tidak terbaca')} />
        <Stat label="Total PnL" value={now ? usd(now.pnl) : '—'} valueClass={now ? tone(now.pnl) : ''}
          sub={!now ? null : t('terealisasi {r} · berjalan {u}', { r: usd(now.realizedUsd), u: usd(now.unrealizedUsd) })
            + (now.capital > 0 ? ` · ${pct((now.pnl / now.capital) * 100, 2)}` : '')} />
        <Stat label="Fee terkumpul" value={usd(s.feeUsd)}
          sub={s.costUsd > 0 ? t('{p}% dari modal · belum diklaim', { p: num((s.feeUsd / s.costUsd) * 100, 2) }) : t('belum diklaim')} />
        <Stat label="Win rate" value={st?.winRatePct != null ? `${num(st.winRatePct, 0)}%` : '—'}
          valueClass={st?.winRatePct == null ? '' : st.winRatePct >= 50 ? 'text-success' : 'text-danger'}
          sub={!st ? null : st.closedCount
            ? t('{w} menang · {l} kalah · rata-rata {v}', { w: st.wins, l: st.losses, v: usd(st.avgPnl) })
            : t('belum ada posisi ditutup')} />
      </div>

      <div className="mb-4 grid items-start gap-3 lg:grid-cols-3">
        <Panel title="Pertumbuhan portofolio" className="lg:col-span-2"
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={VIEWS} />
            <Segmented size="sm" aria="Rentang waktu" value={range} onChange={setRange} options={RANGES} />
          </div>}>
          {p ? <GrowthChart p={p} view={view} /> : <Loading />}
        </Panel>
        <Panel title="Komposisi portofolio" bodyClass="px-4 pt-1 pb-2">
          {now ? <Composition now={now} ethUsd={d.chain.ethUsd} /> : <Loading />}
        </Panel>
      </div>

      <Panel title={t('Posisi aktif ({n})', { n: open.length })} className="mb-4" bodyClass="p-0"
        action={<div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
          <SyncState loading={posLoading} syncedAt={pos?.syncedAt} pending={pendingSync} />
          {open.length > 0 && <>
            <span className="whitespace-nowrap"><span className="text-muted">{t('Nilai')}</span> <span className="num font-medium">{usd(sum(open, (x) => x.valueUsd))}</span></span>
            <span className="whitespace-nowrap"><span className="text-muted">{t('uPnL')}</span> <span className={`num font-medium ${tone(sum(open, (x) => x.pnlUsd))}`}>{usd(sum(open, (x) => x.pnlUsd))}</span></span>
          </>}
          <a href="#positions" className="font-medium text-accent hover:underline">{t('Semua posisi →')}</a>
        </div>}>
        {!pos?.positions ? <Loading text="Memuat posisi…" /> : (
          <DataTable label="Posisi aktif" rows={open} rowKey={(x) => x.id} dense
            defaultSort={{ column: 'val', direction: 'descending' }}
            empty={<Empty title="Tidak ada posisi aktif" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
            columns={[
              { key: 'pair', label: 'Pasangan', sort: (x) => `${x.symbol0}/${x.symbol1}`, render: (x) => <Pair p={x} /> },
              { key: 'range', label: 'Rentang harga', sortable: false, render: (x) => (
                <PriceRange lo={x.tick_lower} hi={x.tick_upper} cur={x.curTick}
                  dec0={x.dec0} dec1={x.dec1} quoteSide={x.quoteSide} symbol0={x.symbol0} symbol1={x.symbol1}
                  entrySqrt={x.entrySqrt} exitSqrt={x.exitSqrt} showPrices={false} />) },
              { key: 'val', label: 'Nilai', align: 'end', sort: (x) => x.valueUsd, render: (x) => (
                <div className="whitespace-nowrap">{usd(x.valueUsd)}<div className="text-xs text-muted">{t('modal {v}', { v: usd(x.costUsd) })}</div></div>) },
              { key: 'fee', label: 'Fee', align: 'end', sort: (x) => x.feeUsd, render: (x) => dash(x, <span className={x.feeUsd > 0.005 ? 'text-success' : 'text-muted'}>{usd(x.feeUsd)}</span>) },
              { key: 'pnl', label: 'PnL', align: 'end', sort: (x) => x.pnlUsd, render: (x) => dash(x, (
                <div className={`whitespace-nowrap ${tone(x.pnlUsd)}`}>{usd(x.pnlUsd)}<div className="text-xs">{pct(x.pnlPct)}</div></div>)) },
              { key: 'age', label: 'Umur', align: 'end', sort: (x) => x.ageHours, render: (x) => <span className="whitespace-nowrap text-muted">{age(x.ageHours)}</span> },
            ]} />
        )}
      </Panel>

      <div className="mb-4 grid items-start gap-3 lg:grid-cols-5">
        <Panel title="Kalender PnL" desc="PnL terealisasi per hari posisi ditutup" className="lg:col-span-3">
          {cal ? <PnlCalendar daily={cal.daily} counts={cal.counts} empty="Belum ada posisi ditutup" /> : <Loading />}
        </Panel>
        <div className="grid gap-3 lg:col-span-2">
          <Panel title="Kinerja per sumber" bodyClass="p-0">
            {p ? <BySource rows={p.byTarget} /> : <Loading />}
          </Panel>
          {st?.closedCount > 0 && (
            <Panel title="Posisi ditutup" bodyClass="px-4 py-1">
              <div className="divide-y divide-border">
                <KV label="Posisi terbaik"><span className={tone(st.best)}>{usd(st.best)}</span></KV>
                <KV label="Posisi terburuk"><span className={tone(st.worst)}>{usd(st.worst)}</span></KV>
                <KV label="Rata-rata ditahan">{age(st.avgHoldHours)}</KV>
              </div>
            </Panel>
          )}
        </div>
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
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
          {d.stats.lastError && <div className="p-4 pt-3"><Notice status="warning" title="Error terakhir">{reason(d.stats.lastError)}</Notice></div>}
        </Panel>
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
