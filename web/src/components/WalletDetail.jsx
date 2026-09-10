// Detail riset satu wallet: PnL, kalender profit, posisi berjalan, dan riwayat posisi.
// Dipakai halaman Wallet (cari alamat apa pun) dan halaman detail Target — satu
// implementasi supaya keduanya tidak pernah menampilkan angka yang berbeda.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ProgressBar, Spinner, toast } from '@heroui/react';
import { RefreshCw, Plus, Check } from 'lucide-react';
import { get, post } from '../api';
import { Panel, DataTable, Empty, Loading, PriceRange, Pick, Notice } from './ui';
import { TokenPair } from './TokenIcon';
import { usd, kUsd, pct, tone, ago, dur } from '../fmt';
import { Chip } from '@heroui/react';

export const WINDOWS = [['250000', '~7 jam'], ['900000', '~1 hari'], ['2600000', '~3 hari'], ['6000000', '~7 hari'], ['100000000', 'Semua riwayat']];
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

function phaseText(j) {
  if (!j) return 'Menyiapkan…';
  if (j.phase === 'transfer') return `Tahap 1 dari 2 — mencari posisi di chain (${j.progress || 0}%)`;
  if (j.phase === 'posisi') return `Tahap 2 dari 2 — menghitung posisi ${j.done || 0} / ${j.total || '?'}`;
  return 'Menyiapkan pemindaian…';
}
// progres gabungan: tahap 1 = 0–30%, tahap 2 = 30–100%
const overall = (j) => (!j ? 2 : j.phase === 'transfer' ? Math.round((j.progress || 0) * 0.3)
  : j.phase === 'posisi' ? 30 + Math.round((j.progress || 0) * 0.7) : 2);

function ScanProgress({ job, compact }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const el = job?.startedAt ? dur(Date.now() - job.startedAt) : '';
  const bar = (
    <ProgressBar value={Math.max(3, overall(job))} size="sm" aria-label="Progres pindai" className="w-full">
      <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
    </ProgressBar>
  );
  if (compact) {
    return (
      <Card variant="secondary" className="mb-6"><Card.Content className="flex-row items-center gap-3">
        <Spinner size="sm" color="current" />
        <div className="flex-1"><div className="mb-2 text-sm">Memperbarui dari chain — {phaseText(job)} <span className="text-muted">· {el}</span></div>{bar}</div>
      </Card.Content></Card>
    );
  }
  return (
    <Card><Card.Content className="gap-4 py-8">
      <div className="flex items-center gap-4">
        <Spinner />
        <div className="flex-1">
          <div className="font-medium">Mengambil riwayat wallet dari chain</div>
          <div className="mb-3 text-sm text-muted">{phaseText(job)}{el ? ` · ${el}` : ''}</div>
          {bar}
        </div>
      </div>
      <p className="text-sm text-muted">Wallet yang aktif bisa butuh beberapa menit (tiap posisi dibaca state-nya di blok kejadian).
        Halaman ini boleh ditinggal — hasilnya disimpan dan tinggal dibuka lagi.</p>
    </Card.Content></Card>
  );
}

function Calendar({ daily }) {
  const days = Object.keys(daily).sort();
  // Hook harus dipanggil sebelum return bersyarat (aturan hooks React).
  const [ym, setYm] = useState(() => {
    const last = days.length ? new Date(days[days.length - 1] + 'T00:00:00') : new Date();
    return [last.getFullYear(), last.getMonth()];
  });
  if (!days.length) return <Empty title="Belum ada posisi tertutup di jendela ini" />;
  const [y, mo] = ym;
  const first = new Date(y, mo, 1), lastDay = new Date(y, mo + 1, 0).getDate();
  const prefix = `${y}-${String(mo + 1).padStart(2, '0')}`;
  const total = Object.entries(daily).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
  const shift = (n) => { const d = new Date(y, mo + n, 1); setYm([d.getFullYear(), d.getMonth()]); };
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(<div key={'e' + i} />);
  for (let d = 1; d <= lastDay; d++) {
    const v = daily[`${prefix}-${String(d).padStart(2, '0')}`];
    cells.push(
      <div key={d} className={`flex min-h-16 flex-col justify-between rounded-md border p-2 ${v != null ? 'border-border bg-surface-secondary' : 'border-border/60'}`}>
        <span className="text-xs text-muted">{d}</span>
        {v != null && <span className={`num text-xs font-semibold ${tone(v)}`}>{usd(v)}</span>}
      </div>,
    );
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label="Bulan sebelumnya" onPress={() => shift(-1)}>‹</Button>
          <span className="w-36 text-center text-sm font-medium">{first.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}</span>
          <Button size="sm" variant="ghost" isIconOnly aria-label="Bulan berikutnya" onPress={() => shift(1)}>›</Button>
        </div>
        <span className="text-sm text-muted">Total bulan ini <span className={`num font-medium ${tone(total)}`}>{usd(total)}</span></span>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'].map((n) => <div key={n} className="pb-1 text-center text-xs text-muted">{n}</div>)}
        {cells}
      </div>
    </div>
  );
}

function StatGrid({ s }) {
  const items = [
    ['Posisi ditutup', s.closedCount ?? 0],
    ['Win rate', <span className={(s.winRatePct || 0) >= 50 ? 'text-success' : 'text-danger'}>{(s.winRatePct || 0).toFixed(2)}%</span>],
    ['Rata-rata modal', usd(s.avgInvestedUsd || 0)],
    ['Fee didapat', <span className="text-success">{kUsd(s.feeEarnedUsd || 0)}</span>],
    ['Laba per posisi', <span className={tone(s.expectedValueUsd)}>{usd(s.expectedValueUsd || 0)}</span>],
    ['Nilai posisi terbuka', usd(s.openValueUsd || 0)],
    ['Terbaik / terburuk', <span><span className="text-success">{usd(s.bestUsd || 0)}</span> / <span className="text-danger">{usd(s.worstUsd || 0)}</span></span>],
    ['Belum terealisasi', <span className={tone(s.unrealizedUsd)}>{usd(s.unrealizedUsd || 0)}</span>],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
      {items.map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="num mt-0.5 font-medium">{v}</dd></div>)}
    </dl>
  );
}

// Fee total = yang sudah ditarik + yang masih menempel di posisi.
const feeTotal = (p) => (p.status === 'open' ? (p.fees_q || 0) + (p.live_fee_q || 0) : (p.fees_q || 0));

const posCols = (open) => [
  { key: 'pair', label: 'Posisi / pool', render: (p) => (
    <div className="flex items-center gap-2.5">
      <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={22} />
      <div>
        <div className="font-medium whitespace-nowrap">{p.symbol0} / {p.symbol1}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <Chip size="sm" variant="soft">Uniswap {String(p.venue || 'v4').toUpperCase()}</Chip>
          <span className="mono text-xs text-muted">#{p.token_id}</span>
          {p.incomplete ? <span className="text-xs text-warning" title="Sebagian riwayat di luar jendela pindai">parsial</span> : null}
        </div>
      </div>
    </div>) },
  { key: 'age', label: 'Umur', render: (p) => <span className="whitespace-nowrap text-muted">{p.ageHours == null ? '—' : p.ageHours < 24 ? `${p.ageHours.toFixed(2)} j` : `${(p.ageHours / 24).toFixed(1)} hr`}</span> },
  { key: 'inv', label: 'Modal', align: 'end', render: (p) => usd(p.invested_q) },
  ...(open ? [{ key: 'val', label: 'Nilai', align: 'end', render: (p) => usd(p.live_value_q) }] : []),
  { key: 'fee', label: 'Fee total', align: 'end', render: (p) => {
    const f = feeTotal(p);
    const claimed = p.fees_q || 0, unclaimed = p.status === 'open' ? (p.live_fee_q || 0) : 0;
    return (
      <div className="text-success" title={open ? `sudah ditarik ${usd(claimed)} · belum diklaim ${usd(unclaimed)}` : undefined}>
        {usd(f)}
        <div className="text-xs text-muted">{p.invested_q > 0 ? ((f / p.invested_q) * 100).toFixed(2) + '%' : ''}</div>
      </div>);
  } },
  { key: 'pnl', label: open ? 'uPnL' : 'PnL', align: 'end', render: (p) => (<div className={tone(p.pnl_q)}>{usd(p.pnl_q)}<div className="text-xs">{p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></div>) },
  { key: 'dpr', label: 'DPR', align: 'end', render: (p) => <span className={tone(p.dprPct)}>{p.dprPct == null ? '—' : Math.abs(p.dprPct) >= 1000 ? (p.dprPct / 1000).toFixed(2) + 'k%' : p.dprPct.toFixed(2) + '%'}</span> },
  { key: 'rng', label: 'Rentang harga', render: (p) => (
    <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={open ? p.curTick : null}
      dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
      entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
  { key: 'when', label: open ? 'Dibuka' : 'Ditutup', render: (p) => (
    <span className="whitespace-nowrap text-muted">{ago(open ? p.opened_ts : p.closed_ts)}</span>) },
];


/**
 * address     : wallet yang ditampilkan
 * autoScan    : kalau belum pernah dipindai, langsung pindai (default ya)
 * showTargetButton : tampilkan tombol "Jadikan target"
 * onChanged   : dipanggil setelah pindai selesai / jadi target (mis. untuk menyegarkan daftar)
 */
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);

// Ringkasan di kepala panel — angka yang paling sering dicari sebelum melihat baris.
function Totals({ rows }) {
  if (!rows.length) return null;
  const value = sum(rows, (r) => r.live_value_q);
  const invested = sum(rows, (r) => r.invested_q);
  const upnl = sum(rows, (r) => r.pnl_q);
  const claimed = sum(rows, (r) => r.fees_q);
  const unclaimed = sum(rows, (r) => r.live_fee_q);
  const item = (k, v, cls = '') => (
    <span className="whitespace-nowrap"><span className="text-muted">{k}</span> <span className={`num font-medium ${cls}`}>{v}</span></span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      {item('Total nilai', usd(value))}
      {item('uPnL', `${usd(upnl)}${invested > 0 ? ` (${pct((upnl / invested) * 100, 2)})` : ''}`, tone(upnl))}
      {item('Fee ditarik', usd(claimed), claimed > 0 ? 'text-success' : '')}
      {item('Fee belum diklaim', usd(unclaimed), unclaimed > 0 ? 'text-success' : '')}
    </div>
  );
}

// Baris total di kaki tabel.
function TotalRow({ rows, open }) {
  if (!rows.length) return null;
  const invested = sum(rows, (r) => r.invested_q);
  const fee = sum(rows, feeTotal);
  const pnl = sum(rows, (r) => r.pnl_q);
  const value = open ? sum(rows, (r) => r.live_value_q) : null;
  const cell = (k, v, cls = '') => (
    <span className="whitespace-nowrap"><span className="text-muted">{k}</span> <span className={`num font-medium ${cls}`}>{v}</span></span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <span className="font-medium">Total {rows.length} posisi</span>
      {cell('modal', usd(invested))}
      {value != null && cell('nilai', usd(value))}
      {cell('fee', usd(fee), 'text-success')}
      {cell(open ? 'uPnL' : 'PnL', `${usd(pnl)}${invested > 0 ? ` (${pct((pnl / invested) * 100, 2)})` : ''}`, tone(pnl))}
    </div>
  );
}

export default function WalletDetail({ address, autoScan = true, showTargetButton = true, onChanged }) {
  const [blocks, setBlocks] = useState('900000');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const timer = useRef(null);
  const alive = useRef(true);

  const stopPoll = () => { clearInterval(timer.current); timer.current = null; };

  const fetchWallet = useCallback(async () => {
    const d = await get('/api/wallet?address=' + address);
    if (!alive.current) return d;
    setData(d);
    const running = d.job?.status === 'jalan';
    if (running && !timer.current) timer.current = setInterval(() => fetchWallet(), 2000);
    if (!running && timer.current) { stopPoll(); onChanged?.(); }
    return d;
  }, [address, onChanged]);

  const startScan = useCallback(async (win = blocks) => {
    const r = await post('/api/wallet/scan', { address, blocks: Number(win) });
    if (r.error) { toast.danger(r.error); return false; }
    stopPoll();
    await fetchWallet();
    return true;
  }, [address, blocks, fetchWallet]);

  // muat saat alamat berganti; pindai otomatis kalau belum pernah
  useEffect(() => {
    alive.current = true;
    setData(null); setLoading(true); setShowAll(false); stopPoll();
    (async () => {
      try {
        const d = await fetchWallet();
        if (autoScan && !d.found && d.job?.status !== 'jalan') await startScan();
      } finally { if (alive.current) setLoading(false); }
    })();
    return () => { alive.current = false; stopPoll(); };
    // sengaja hanya bergantung pada alamat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const job = data?.job;
  const running = job?.status === 'jalan';
  const s = data?.stats || {};

  const makeTarget = async () => {
    await post('/api/targets', { address, label: 'dari riset wallet' });
    toast.success('Ditambahkan sebagai target'); fetchWallet(); onChanged?.();
  };

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <p className="text-sm text-muted">
        {data?.found && !running
          ? `Dipindai ${ago(data.lastScanTs)} · blok ${(data.scannedFrom || 0).toLocaleString('id-ID')}–${(data.scannedTo || 0).toLocaleString('id-ID')}`
          : 'Sekali dipindai, data disimpan — membuka lagi tidak memanggil chain.'}
      </p>
      <div className="flex items-end gap-2">
        <Pick className="w-40" value={blocks} onChange={setBlocks} options={WINDOWS} />
        <Button variant="outline" isPending={running} isDisabled={running} onPress={() => startScan()}>
          <RefreshCw className="size-4" />Pindai ulang</Button>
      </div>
    </div>
  );

  if (loading && !data) return <Loading text="Memuat data wallet…" />;
  return (
    <>
      {toolbar}
      {job?.status === 'gagal' && <div className="mb-6"><Notice status="danger" title="Pindai gagal">{job.error} — coba pindai ulang.</Notice></div>}
      {running && !data?.found ? <ScanProgress job={job} />
        : !data?.found ? (
          <Card><Card.Content className="flex-row items-center justify-between gap-4">
            <span className="text-sm text-muted">Wallet ini belum ada di database.</span>
            <Button size="sm" onPress={() => startScan()}>Pindai sekarang</Button>
          </Card.Content></Card>
        ) : (
          <>
            {running && <ScanProgress job={job} compact />}
            <div className="mb-6 grid gap-4 lg:grid-cols-5">
              <Panel className="lg:col-span-2">
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-muted">Total profit (tertutup)</div>
                    <div className={`num mt-1 text-3xl font-semibold tracking-tight ${tone(s.totalProfitUsd)}`}>{kUsd(s.totalProfitUsd || 0)}</div>
                  </div>
                  {showTargetButton && (data.isTarget
                    ? <span className="flex items-center gap-1 text-sm text-success"><Check className="size-4" />Sudah jadi target</span>
                    : <Button size="sm" variant="outline" onPress={makeTarget}><Plus className="size-3.5" />Jadikan target</Button>)}
                </div>
                <StatGrid s={s} />
                {s.incompleteCount > 0 && <div className="mt-5"><Notice status="warning">{s.incompleteCount} posisi riwayatnya terpotong jendela pindai — tidak ikut dihitung. Perluas jendela untuk melengkapinya.</Notice></div>}
              </Panel>
              <Panel title="Riwayat profit harian" className="lg:col-span-3"><Calendar daily={data.daily} /></Panel>
            </div>

            <Panel title={`Posisi berjalan (${data.open.length})`} className="mb-6" bodyClass="p-0"
              action={<Totals rows={data.open} />}>
              <DataTable label="Posisi berjalan" rows={data.open} rowKey={(p) => p.token_id} columns={posCols(true)}
                empty={<Empty title="Tidak ada posisi berjalan" />}
                footer={<TotalRow rows={data.open} open />} />
            </Panel>
            <Panel title={`Riwayat posisi (${data.closed.length})`} bodyClass="p-0">
              <DataTable label="Riwayat posisi" rows={showAll ? data.closed : data.closed.slice(0, 20)} rowKey={(p) => p.token_id} columns={posCols(false)}
                empty={<Empty title="Belum ada posisi tertutup" />}
                footer={<TotalRow rows={data.closed} />} />
              {data.closed.length > 20 && (
                <div className="flex justify-center border-t border-border p-3">
                  <Button size="sm" variant="ghost" onPress={() => setShowAll(!showAll)}>
                    {showAll ? 'Tampilkan 20 terbaru saja' : `Tampilkan semua (${data.closed.length})`}</Button>
                </div>
              )}
            </Panel>
            <p className="mt-4 text-xs text-muted">Pokok &amp; fee dibaca dari state pool dan posisi tepat di blok tiap kejadian (node arsip).
              Posisi yang dibuka-tutup tanpa ada swap di rentangnya tercatat impas, bukan kalah.</p>
          </>
        )}
    </>
  );
}
