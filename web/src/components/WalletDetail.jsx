// Detail riset satu wallet: PnL, kalender profit, posisi berjalan, dan riwayat posisi.
// Dipakai halaman Wallet (cari alamat apa pun) dan halaman detail Target — satu
// implementasi supaya keduanya tidak pernah menampilkan angka yang berbeda.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ProgressBar, Spinner, toast } from '@heroui/react';
import { RefreshCw, Plus, Check } from 'lucide-react';
import { get, post } from '../api';
import { Panel, DataTable, Empty, Loading, PriceRange, Pick, Notice, Stat, KV } from './ui';
import { TokenPair } from './TokenIcon';
import PnlCalendar from './PnlCalendar';
import { usd, kUsd, pct, tone, ago, dur, num, age } from '../fmt';
import { useI18n, translate as tt } from '../i18n';

export const WINDOWS = [['250000', '~7 jam'], ['900000', '~1 hari'], ['2600000', '~3 hari'], ['6000000', '~7 hari'], ['100000000', 'Semua riwayat']];
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

function phaseText(j) {
  if (!j) return tt('Menyiapkan pemindaian…');
  if (j.mode === 'refresh') {
    if (j.phase === 'posisi') return tt('menghitung ulang posisi {done} / {total}', { done: j.done || 0, total: j.total || '?' });
    return tt('mencari posisi baru sejak pindai terakhir');
  }
  if (j.phase === 'transfer') return tt('Tahap 1 dari 2 — mencari posisi di chain ({p}%)', { p: j.progress || 0 });
  if (j.phase === 'posisi') return tt('Tahap 2 dari 2 — menghitung posisi {done} / {total}', { done: j.done || 0, total: j.total || '?' });
  return tt('Menyiapkan pemindaian…');
}
// progres gabungan: tahap 1 = 0–30%, tahap 2 = 30–100%
const overall = (j) => (!j ? 2 : j.phase === 'transfer' ? Math.round((j.progress || 0) * 0.3)
  : j.phase === 'posisi' ? 30 + Math.round((j.progress || 0) * 0.7) : 2);

function ScanProgress({ job, compact }) {
  const { t } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const el = job?.startedAt ? dur(Date.now() - job.startedAt) : '';
  const bar = (
    <ProgressBar value={Math.max(3, overall(job))} size="sm" aria-label={t('Progres')} className="w-full">
      <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
    </ProgressBar>
  );
  if (compact) {
    return (
      <Card variant="secondary" className="mb-4"><Card.Content className="flex-row items-center gap-3">
        <Spinner size="sm" color="current" />
        <div className="flex-1"><div className="mb-2 text-sm">{t('Memperbarui dari chain — {phase}', { phase: phaseText(job) })} <span className="text-muted">· {el}</span></div>{bar}</div>
      </Card.Content></Card>
    );
  }
  return (
    <Card><Card.Content className="gap-4 py-8">
      <div className="flex items-center gap-4">
        <Spinner />
        <div className="flex-1">
          <div className="font-medium">{t('Mengambil riwayat wallet dari chain')}</div>
          <div className="mb-3 text-sm text-muted">{phaseText(job)}{el ? ` · ${el}` : ''}</div>
          {bar}
        </div>
      </div>
      <p className="text-sm text-muted">{t('Wallet yang aktif bisa butuh beberapa menit (tiap posisi dibaca state-nya di blok kejadian). Halaman ini boleh ditinggal — hasilnya disimpan dan tinggal dibuka lagi.')}</p>
    </Card.Content></Card>
  );
}

function Details({ s }) {
  const rows = [
    ['Rata-rata modal', usd(s.avgInvestedUsd || 0)],
    ['Laba per posisi', <span className={tone(s.expectedValueUsd)}>{usd(s.expectedValueUsd || 0)}</span>],
    ['Posisi terbaik', <span className="text-success">{usd(s.bestUsd || 0)}</span>],
    ['Posisi terburuk', <span className="text-danger">{usd(s.worstUsd || 0)}</span>],
    ['Nilai posisi terbuka', usd(s.openValueUsd || 0)],
    ['Belum terealisasi', <span className={tone(s.unrealizedUsd)}>{usd(s.unrealizedUsd || 0)}</span>],
  ];
  return <div className="divide-y divide-border">{rows.map(([k, v]) => <KV key={k} label={k}>{v}</KV>)}</div>;
}

// Fee total = yang sudah ditarik + yang masih menempel di posisi.
const feeTotal = (p) => (p.status === 'open' ? (p.fees_q || 0) + (p.live_fee_q || 0) : (p.fees_q || 0));

const posCols = (open) => [
  { key: 'pair', label: 'Posisi / pool', sort: (p) => `${p.symbol0}/${p.symbol1}`,
    search: (p) => `${p.symbol0}/${p.symbol1} ${p.token_id}`, render: (p) => (
    <div className="flex items-center gap-2.5">
      <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={22} />
      <div>
        <div className="font-medium whitespace-nowrap">{p.symbol0} / {p.symbol1}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <span className="uppercase">{String(p.venue || 'v4')}</span><span>·</span>
          <span className="mono">#{p.token_id}</span>
          {p.incomplete ? <span className="text-xs text-warning" title={tt('Sebagian riwayat di luar jendela pindai')}>{tt('parsial')}</span> : null}
        </div>
      </div>
    </div>) },
  { key: 'age', label: 'Umur', align: 'end', sort: (p) => p.ageHours, render: (p) => <span className="whitespace-nowrap text-muted">{age(p.ageHours)}</span> },
  { key: 'inv', label: 'Modal', align: 'end', sort: (p) => p.invested_q, render: (p) => usd(p.invested_q) },
  ...(open ? [{ key: 'val', label: 'Nilai', align: 'end', sort: (p) => p.live_value_q, render: (p) => usd(p.live_value_q) }] : []),
  { key: 'fee', label: 'Fee total', align: 'end', sort: feeTotal, render: (p) => {
    const f = feeTotal(p);
    const claimed = p.fees_q || 0, unclaimed = p.status === 'open' ? (p.live_fee_q || 0) : 0;
    return (
      <div className="text-success" title={open ? tt('sudah ditarik {c} · belum diklaim {u}', { c: usd(claimed), u: usd(unclaimed) }) : undefined}>
        {usd(f)}
        <div className="text-xs text-muted">{p.invested_q > 0 ? pct((f / p.invested_q) * 100, 2).replace('+', '') : ''}</div>
      </div>);
  } },
  { key: 'pnl', label: open ? 'uPnL' : 'PnL', align: 'end', sort: (p) => p.pnl_q, render: (p) => (<div className={tone(p.pnl_q)}>{usd(p.pnl_q)}<div className="text-xs">{p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></div>) },
  { key: 'dpr', label: 'DPR', align: 'end', sort: (p) => p.dprPct, render: (p) => <span className={tone(p.dprPct)}>{p.dprPct == null ? '—' : Math.abs(p.dprPct) >= 1000 ? pct(p.dprPct / 1000, 2).replace('%', 'k%') : pct(p.dprPct, 2)}</span> },
  { key: 'rng', label: 'Rentang harga', sortable: false, render: (p) => (
    <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={open ? p.curTick : null}
      dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
      entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
  { key: 'when', label: open ? 'Dibuka' : 'Ditutup', sort: (p) => (open ? p.opened_ts : p.closed_ts), render: (p) => (
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
  const { t } = useI18n();
  if (!rows.length) return null;
  const value = sum(rows, (r) => r.live_value_q);
  const invested = sum(rows, (r) => r.invested_q);
  const upnl = sum(rows, (r) => r.pnl_q);
  const claimed = sum(rows, (r) => r.fees_q);
  const unclaimed = sum(rows, (r) => r.live_fee_q);
  const item = (k, v, cls = '') => (
    <span className="whitespace-nowrap"><span className="text-muted">{t(k)}</span> <span className={`num font-medium ${cls}`}>{v}</span></span>
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
  const { t } = useI18n();
  if (!rows.length) return null;
  const invested = sum(rows, (r) => r.invested_q);
  const fee = sum(rows, feeTotal);
  const pnl = sum(rows, (r) => r.pnl_q);
  const value = open ? sum(rows, (r) => r.live_value_q) : null;
  const cell = (k, v, cls = '') => (
    <span className="whitespace-nowrap"><span className="text-muted">{t(k)}</span> <span className={`num font-medium ${cls}`}>{v}</span></span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <span className="font-medium">{t('Total {n} posisi', { n: rows.length })}</span>
      {cell('modal', usd(invested))}
      {value != null && cell('nilai', usd(value))}
      {cell('fee', usd(fee), 'text-success')}
      {cell(open ? 'uPnL' : 'PnL', `${usd(pnl)}${invested > 0 ? ` (${pct((pnl / invested) * 100, 2)})` : ''}`, tone(pnl))}
    </div>
  );
}

// Pilihan jendela yang paling mendekati rentang blok yang sudah benar-benar
// terpindai — supaya dropdown tidak berkata "~7 hari" saat datanya cuma 1 hari.
const windowFor = (span) => {
  const ids = WINDOWS.map(([id]) => Number(id));
  const hit = ids.find((n) => n >= span * 0.9) ?? ids[ids.length - 1];
  return String(hit);
};

export default function WalletDetail({ address, autoScan = true, showTargetButton = true, onChanged }) {
  const { t } = useI18n();
  const [blocks, setBlocks] = useState('900000');
  const touched = useRef(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef(null);
  const alive = useRef(true);

  const stopPoll = () => { clearInterval(timer.current); timer.current = null; };

  const fetchWallet = useCallback(async () => {
    const d = await get('/api/wallet?address=' + address);
    if (!alive.current) return d;
    setData(d);
    // Dropdown mengikuti jendela yang tersimpan, selama pengguna belum menyentuhnya.
    if (!touched.current && d.found && d.scannedFrom && d.scannedTo) setBlocks(windowFor(d.scannedTo - d.scannedFrom));
    const running = d.job?.status === 'jalan';
    if (running && !timer.current) timer.current = setInterval(() => fetchWallet(), 2000);
    if (!running && timer.current) { stopPoll(); onChanged?.(); }
    return d;
  }, [address, onChanged]);

  const startScan = useCallback(async (win = blocks, mode = 'full') => {
    const r = await post('/api/wallet/scan', { address, blocks: Number(win), mode });
    if (r.error) { toast.danger(r.error); return false; }
    stopPoll();
    await fetchWallet();
    return true;
  }, [address, blocks, fetchWallet]);

  // Server bisa memulai pembaruan sendiri (target baru beraksi, atau data basi).
  // Poll pelan ini yang membuat halaman yang dibiarkan terbuka ikut terbarui;
  // begitu ada pekerjaan berjalan, fetchWallet pindah ke poll cepat 2 detik.
  useEffect(() => {
    const slow = setInterval(() => { if (!document.hidden && !timer.current) fetchWallet(); }, 30000);
    return () => clearInterval(slow);
  }, [fetchWallet]);

  // muat saat alamat berganti; pindai otomatis kalau belum pernah
  useEffect(() => {
    alive.current = true; touched.current = false;
    setData(null); setLoading(true); stopPoll();
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
  // Kegagalan pembaruan latar (RPC sedang 429, dll.) cukup dicatat kecil — data
  // tersimpan tetap tampil dan server akan mencoba lagi. Hanya pindai yang diminta
  // pengguna yang layak kotak merah.
  const bgFailed = job?.status === 'gagal' && job.reason && job.reason !== 'manual';
  const s = data?.stats || {};

  // Memilih jendela yang lebih lebar dari yang sudah terpindai = ingin melihat
  // hari-hari sebelumnya; "Perbarui" tak pernah mundur, jadi langsung pindai penuh.
  const pickWindow = (win) => {
    touched.current = true;
    setBlocks(win);
    const scanned = (data?.scannedTo || 0) - (data?.scannedFrom || 0);
    if (data?.found && !running && Number(win) > scanned * 1.1) startScan(win, 'full');
  };

  const makeTarget = async () => {
    await post('/api/targets', { address, label: 'dari riset wallet' });
    toast.success(t('Ditambahkan sebagai target')); fetchWallet(); onChanged?.();
  };

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted">
        {data?.found
          ? t('Diperbarui {when} · blok {from}–{to}', { when: ago(data.lastScanTs), from: num(data.scannedFrom || 0), to: num(data.scannedTo || 0) })
          : t('Sekali dipindai, data disimpan — membuka lagi tidak memanggil chain.')}
        {data?.found && <span className="block">{t('Diperbarui otomatis saat wallet ini beraksi, dan saat dibuka bila lebih dari 5 menit.')}</span>}
        {bgFailed && <span className="block text-xs text-warning">{t('Pembaruan otomatis gagal: {e} — dicoba lagi sebentar lagi.', { e: job.error })}</span>}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {data?.found && (
          <Button size="sm" isPending={running && job?.mode === 'refresh'} isDisabled={running} onPress={() => startScan(blocks, 'refresh')}>
            <RefreshCw className="size-4" />{t('Perbarui')}</Button>
        )}
        <Pick className="w-36" aria="Jendela pindai" value={blocks} onChange={pickWindow} options={WINDOWS} />
        <Button size="sm" variant="outline" isPending={running && job?.mode !== 'refresh'} isDisabled={running} onPress={() => startScan()}>
          {t('Pindai ulang')}</Button>
      </div>
    </div>
  );

  if (loading && !data) return <Loading text="Memuat data wallet…" />;
  return (
    <>
      {toolbar}
      {job?.status === 'gagal' && !bgFailed && <div className="mb-4"><Notice status="danger" title="Pindai gagal">{t('{e} — coba pindai ulang.', { e: job.error })}</Notice></div>}
      {running && !data?.found ? <ScanProgress job={job} />
        : !data?.found ? (
          <Card><Card.Content className="flex-row items-center justify-between gap-4">
            <span className="text-sm text-muted">{t('Wallet ini belum ada di database.')}</span>
            <Button size="sm" onPress={() => startScan()}>{t('Pindai sekarang')}</Button>
          </Card.Content></Card>
        ) : (
          <>
            {running && <ScanProgress job={job} compact />}
            <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat label="Total profit (tertutup)" value={kUsd(s.totalProfitUsd || 0)} valueClass={tone(s.totalProfitUsd)}
                sub={t('{n} posisi ditutup', { n: s.closedCount ?? 0 })} />
              <Stat label="Win rate" value={`${(s.winRatePct || 0).toFixed(1)}%`} valueClass={(s.winRatePct || 0) >= 50 ? 'text-success' : 'text-danger'}
                sub={t('laba per posisi {v}', { v: usd(s.expectedValueUsd || 0) })} />
              <Stat label="Fee didapat" value={kUsd(s.feeEarnedUsd || 0)}
                sub={s.avgInvestedUsd ? t('modal rata-rata {v}', { v: usd(s.avgInvestedUsd, 0) }) : null} />
              <Stat label="Belum terealisasi" value={usd(s.unrealizedUsd || 0)} valueClass={tone(s.unrealizedUsd)}
                sub={t('{n} posisi berjalan', { n: data.open.length })} />
            </div>
            {s.incompleteCount > 0 && <div className="mb-3"><Notice status="warning">{t('{n} posisi riwayatnya terpotong jendela pindai — tidak ikut dihitung. Perluas jendela untuk melengkapinya.', { n: s.incompleteCount })}</Notice></div>}
            <div className="mb-4 grid items-start gap-3 lg:grid-cols-5">
              <Panel title="Rincian" className="lg:col-span-2" bodyClass="px-4 py-1"
                action={showTargetButton && (data.isTarget
                  ? <span className="flex items-center gap-1 text-xs font-medium text-success"><Check className="size-3.5" />{t('Sudah jadi target')}</span>
                  : <Button size="sm" variant="outline" onPress={makeTarget}><Plus className="size-3.5" />{t('Jadikan target')}</Button>)}>
                <Details s={s} />
              </Panel>
              <Panel title="Riwayat profit harian" className="lg:col-span-3"><PnlCalendar daily={data.daily} /></Panel>
            </div>

            <Panel title={t('Posisi berjalan ({n})', { n: data.open.length })} className="mb-4" bodyClass="p-0"
              action={<Totals rows={data.open} />}>
              <DataTable label="Posisi berjalan" rows={data.open} rowKey={(p) => p.token_id} columns={posCols(true)}
                searchable defaultSort={{ column: 'val', direction: 'descending' }}
                empty={<Empty title="Tidak ada posisi berjalan" />}
                footer={<TotalRow rows={data.open} open />} />
            </Panel>
            <Panel title={t('Riwayat posisi ({n})', { n: data.closed.length })} bodyClass="p-0">
              {/* Pembagian halaman menggantikan tombol "tampilkan semua": 145 baris
                  sekaligus membuat halaman panjang dan sulit dibaca. */}
              <DataTable label="Riwayat posisi" rows={data.closed} rowKey={(p) => p.token_id} columns={posCols(false)}
                searchable pageSize={20} defaultSort={{ column: 'when', direction: 'descending' }}
                empty={<Empty title="Belum ada posisi tertutup" />}
                footer={<TotalRow rows={data.closed} />} />
            </Panel>
            <p className="mt-4 text-xs text-muted">{t('Pokok & fee dibaca dari state pool dan posisi tepat di blok tiap kejadian (node arsip). Posisi yang dibuka-tutup tanpa ada swap di rentangnya tercatat impas, bukan kalah.')}</p>
          </>
        )}
    </>
  );
}
