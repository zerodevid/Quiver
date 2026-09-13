import { lazy, Suspense, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { usePoll, useResync } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { useClaimFees } from '../useClaimFees';
import { PageHeader, Panel, DataTable, Empty, Loading, Notice, PriceRange, Dot, Refresh } from '../components/ui';
import { TokenPair, PairName } from '../components/TokenIcon';
// Halaman detail membawa pustaka grafik — dimuat hanya saat dibuka.
const PositionDetail = lazy(() => import('./PositionDetail'));
import PositionHistory from '../components/PositionHistory';
import AutoCompoundButton from '../components/AutoCompoundButton';
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
// detail posisi (grafik harga, titik masuk, data pasar); di halaman Posisi (link=false)
// seluruh barisnya sudah membuka laci riwayat, jadi tiap simbol menaut ke halaman
// tokennya sendiri — klik baris = laci, klik token = halaman token.
export function Pair({ p, link = true }) {
  const { t } = useI18n();
  const name = `${p.symbol0 || '?'}/${p.symbol1 || '?'}`;
  return (
    <div className="flex items-center gap-2.5">
      <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
      <div className="min-w-0">
        {link ? <a href={'#positions/' + p.id} className="font-medium whitespace-nowrap hover:underline">{name}</a>
          : <PairName token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} sep="/" className="font-medium" />}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
          <span className="uppercase">{p.venue}</span><span>·</span><span className="num">{num(p.fee / 10000, 2)}%</span>
          {p.syncing ? <><span>·</span><Spinner size="sm" color="current" className="size-3" />
            <span title={t('Posisi baru tercatat; nilai, fee, dan PnL menyusul setelah sinkron dengan chain.')}>{t('menyinkronkan…')}</span></>
            : p.inRange != null && <><span>·</span><Dot tone={p.inRange ? 'success' : 'warning'} />
              <span className={p.inRange ? 'text-success' : 'text-warning'}>{t(p.inRange ? 'in-range' : 'di luar')}</span></>}
        </div>
      </div>
    </div>
  );
}

// Penanda di kepala panel: kosong saat semuanya segar, supaya tidak jadi perabot
// yang selalu ada. Tabel tidak pernah dikosongkan selama memuat ulang — data lama
// tetap tampil sampai yang baru tiba. Dipakai juga panel "Posisi aktif" di Ringkasan.
// "Sedang mengambil data" tidak ada di sini: itu tugas tombol Perbarui di sebelahnya,
// yang menyalakan spinner-nya sendiri.
export function SyncState({ syncedAt, pending }) {
  const { t } = useI18n();
  const text = !syncedAt ? 'Sinkron pertama dengan chain…'
    : pending > 0 ? '{n} posisi baru menunggu sinkron' : null;
  if (!text) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted" role="status">
      <Spinner size="sm" color="current" className="size-3" />{t(text, { n: pending })}
    </span>
  );
}

// Dari mana posisi ini datang: wallet target yang disalin, nomor NFT posisi aslinya,
// dan bagaimana posisi asli itu berakhir — semuanya dalam satu kolom, supaya salinan
// kita dan aslinya terbaca dalam satu tatapan tanpa menambah lebar tabel.
//
// PnL target dinilai terhadap modal target sendiri, yang jarang sebesar modal kita;
// itu sebabnya persennya ikut ditampilkan — dolarnya hanya bercerita soal ukuran
// taruhan mereka. Angkanya dari pemindaian wallet: wallet yang belum pernah diriset
// tidak punya angka sama sekali, dan posisi target yang masih terbuka bernilai
// sebesar pemindaian terakhir, bukan harga sekarang — keduanya dikatakan apa adanya
// daripada disajikan sebagai kabar pasti.
function Source({ p }) {
  const { t } = useI18n();
  if (!p.target) {
    return (
      <span className="text-xs text-muted" title={t('Posisi ini tidak menyalin target mana pun: dibuka manual, atau sudah ada di wallet sebelum bot memantaunya.')}>
        {t('Manual / di luar bot')}
      </span>
    );
  }
  const m = p.mirror;
  return (
    <div className="max-w-48">
      <a href={'#targets/' + p.target} className="group block" title={p.target}>
        {p.targetLabel && <div className="truncate font-medium group-hover:underline">{p.targetLabel}</div>}
        <div className="mono text-xs whitespace-nowrap text-muted group-hover:text-foreground">
          {short(p.target)}{p.mirror_of ? ` · #${p.mirror_of}` : ''}
        </div>
      </a>
      {!m ? (
        <div className="text-xs text-muted" title={t('Wallet target ini belum diriset, jadi hasil posisi aslinya belum diketahui. Buka halaman target dan pindai wallet-nya.')}>
          {t('belum dipindai')}
        </div>
      ) : (
        <div className="mt-0.5 text-xs" title={t('modal target {v}', { v: usd(m.costUsd) })}>
          <span className="text-muted">{t('PnL target')}</span>{' '}
          <span className={`num ${tone(m.pnlUsd)}`}>{usd(m.pnlUsd)}{m.pnlPct == null ? '' : ` ${pct(m.pnlPct, 2)}`}</span>
          {/* baris sendiri, bukan disambung dengan titik: kalimatnya sudah sepanjang
              kolom, dan pemisah yang menggantung di ujung baris lebih berisik
              daripada satu baris tambahan */}
          {m.stale && <div className="text-muted">{t('masih terbuka')}</div>}
        </div>
      )}
    </div>
  );
}

export default function Positions({ param }) {
  const { t } = useI18n();
  // #positions/123 -> detail satu posisi. Poll daftar dimatikan selama detail terbuka.
  // Endpoint-nya murah (basis data + hasil sinkron di memori), jadi posisi yang baru
  // dibuka bot muncul dalam ~5 detik.
  const { data: d, error, reload } = usePoll(param ? null : '/api/positions', 5000);
  // Tombolnya memaksa pembacaan chain baru, bukan sekadar mengambil ulang hasil
  // sinkron terakhir — lihat useResync.
  const [resync, syncing] = useResync(reload);
  const { close, closing } = useClosePosition(reload);
  const { claim, claiming } = useClaimFees(reload);
  // Klik baris -> laci riwayat posisi (transaksi & catatan bot).
  const [hist, setHist] = useState(null);
  if (param) return <Suspense fallback={<Loading page />}><PositionDetail id={param} /></Suspense>;
  const header = <PageHeader group="Pemantauan" title="Posisi" desc="Posisi LP milik bot — nilai, fee, dan PnL diperbarui dari chain tiap 30 detik. Klik baris untuk melihat riwayat transaksi dan catatan bot." />;
  // Belum ada balasan sama sekali: tampilkan di tempat tabel akan muncul, bukan
  // halaman kosong — dan kalau servernya tidak terjangkau, katakan begitu.
  if (!d?.positions) {
    return (
      <>
        {header}
        <Panel title="Posisi terbuka" bodyClass="p-0">
          {error ? <div className="p-4"><Notice status="danger" title="Daftar posisi gagal dimuat">{error} — {t('mencoba lagi otomatis.')}</Notice></div>
            : <Loading text="Memuat posisi…" />}
        </Panel>
      </>
    );
  }
  const open = d.positions, closed = d.closed;
  const openPnl = sum(open, (p) => p.pnlUsd);
  const closedPnl = sum(closed, (c) => (c.out_quote || 0) - (c.cost_quote || 0));
  const pending = open.filter((p) => p.syncing).length;
  const dash = (p, node) => (p.syncing ? <span className="text-muted">—</span> : node);

  return (
    <>
      {header}
      <PositionHistory id={hist} onClose={() => setHist(null)} />
      {error && <div className="mb-4"><Notice status="warning" title="Gagal memperbarui daftar posisi">{error} — {t('data di bawah dari pembaruan terakhir.')}</Notice></div>}
      <Panel title={t('Posisi terbuka ({n})', { n: open.length })} className="mb-4" bodyClass="p-0"
        action={<div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
          <Refresh at={d.syncedAt} busy={syncing} onPress={resync} />
          <SyncState syncedAt={d.syncedAt} pending={pending} />
          {open.length > 0 && <Totals items={[
            ['Nilai', usd(sum(open, (p) => p.valueUsd))],
            ['Fee', usd(sum(open, (p) => p.feeUsd))],
            ['PnL', usd(openPnl), tone(openPnl)],
          ]} />}
        </div>}>
        <DataTable label="Posisi terbuka" rows={open} rowKey={(p) => p.id} searchable onRow={(p) => setHist(p.id)}
          defaultSort={{ column: 'val', direction: 'descending' }}
          empty={<Empty title="Belum ada posisi terbuka" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
          columns={[
            { key: 'pair', label: 'Pasangan', sort: (p) => `${p.symbol0}/${p.symbol1}`, render: (p) => <Pair p={p} link={false} /> },
            { key: 'range', label: 'Rentang harga', sortable: false, render: (p) => (
              <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick}
                dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
                entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
            { key: 'val', label: 'Nilai', align: 'end', sort: (p) => p.valueUsd, render: (p) => (
              <div className="whitespace-nowrap">{usd(p.valueUsd)}<div className="text-xs text-muted">{t('modal {v}', { v: usd(p.costUsd) })}</div></div>) },
            { key: 'fee', label: 'Fee', align: 'end', sort: (p) => p.feeUsd, render: (p) => dash(p, <span className={p.feeUsd > 0.005 ? 'text-success' : 'text-muted'}>{usd(p.feeUsd)}</span>) },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnlUsd, render: (p) => dash(p, (
              <div className={`whitespace-nowrap ${tone(p.pnlUsd)}`}>{usd(p.pnlUsd)}<div className="text-xs">{pct(p.pnlPct)}</div></div>)) },
            { key: 'il', label: 'IL', align: 'end', sort: (p) => p.ilUsd, render: (p) => <span className={tone(p.ilUsd)}>{p.ilUsd == null ? '—' : usd(p.ilUsd)}</span> },
            { key: 'age', label: 'Umur', align: 'end', sort: (p) => p.ageHours, render: (p) => <span className="whitespace-nowrap text-muted">{age(p.ageHours)}</span> },
            { key: 'tgt', label: 'Sumber', sort: (p) => p.targetLabel || p.target,
              search: (p) => `${p.targetLabel || ''} ${p.target || ''}`, render: (p) => <Source p={p} /> },
            { key: 'act', label: '', sortable: false, className: 'text-end', render: (p) => (
              <div className="flex flex-wrap gap-2 justify-end">
                <AutoCompoundButton p={p} reload={reload} disabled={claiming != null || closing != null} />
                <Button size="sm" variant="secondary" isPending={claiming === p.id} isDisabled={claiming != null || closing != null || p.empty} onPress={() => claim(p)}>{t('Claim fee')}</Button>
                <Button size="sm" variant="danger-soft" isPending={closing === p.id} isDisabled={closing != null || claiming != null} onPress={() => close(p)}>{t('Tutup')}</Button>
              </div>) },
          ]} />
      </Panel>
      <Panel title={t('Posisi tertutup ({n})', { n: closed.length })} bodyClass="p-0"
        desc="Kolom Sumber memuat wallet yang disalin beserta hasil posisi aslinya. Modal target jarang sebesar modal kita, jadi yang sebanding persennya, bukan dolarnya."
        action={closed.length > 0 && <Totals items={[['PnL', usd(closedPnl), tone(closedPnl)]]} />}>
        <DataTable label="Posisi tertutup" rows={closed} rowKey={(c) => c.id} searchable pageSize={20} onRow={(c) => setHist(c.id)}
          defaultSort={{ column: 'at', direction: 'descending' }}
          empty={<Empty title="Belum ada posisi tertutup" />}
          columns={[
            { key: 'pair', label: 'Pasangan', sort: (c) => `${c.symbol0}/${c.symbol1}`, search: (c) => `${c.symbol0}/${c.symbol1} ${c.token_id}`, render: (c) => (
              <div className="flex items-center gap-2.5">
                <TokenPair token0={c.token0} token1={c.token1} symbol0={c.symbol0} symbol1={c.symbol1} size={20} />
                <div><PairName token0={c.token0} token1={c.token1} symbol0={c.symbol0} symbol1={c.symbol1} sep="/" className="font-medium" />
                  <div className="mono mt-0.5 text-xs text-muted">{String(c.venue || '').toUpperCase()} · #{c.token_id}</div></div>
              </div>) },
            { key: 'tgt', label: 'Sumber', sort: (c) => c.targetLabel || c.target,
              search: (c) => `${c.targetLabel || ''} ${c.target || ''}`, render: (c) => <Source p={c} /> },
            { key: 'cost', label: 'Modal', align: 'end', sort: (c) => c.cost_quote, render: (c) => usd(c.cost_quote) },
            { key: 'out', label: 'Hasil', align: 'end', sort: (c) => c.out_quote, render: (c) => usd(c.out_quote) },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (c) => (c.out_quote || 0) - (c.cost_quote || 0), render: (c) => {
              const v = (c.out_quote || 0) - (c.cost_quote || 0);
              return <div className={`whitespace-nowrap ${tone(v)}`}>{usd(v)}<div className="text-xs">{c.cost_quote > 0 ? pct((v / c.cost_quote) * 100, 2) : ''}</div></div>;
            } },
            { key: 'dur', label: 'Durasi', align: 'end', sort: (c) => (c.closed_ts || 0) - (c.opened_ts || 0), render: (c) => (
              <span className="whitespace-nowrap text-muted">{c.opened_ts && c.closed_ts ? age((c.closed_ts - c.opened_ts) / 3600000) : '—'}</span>) },
            { key: 'at', label: 'Ditutup', align: 'end', sort: (c) => c.closed_ts, render: (c) => <span className="whitespace-nowrap text-muted">{ago(c.closed_ts)}</span> },
          ]} />
      </Panel>
    </>
  );
}
