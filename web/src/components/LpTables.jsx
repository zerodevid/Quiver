// Tabel yang dipakai bersama halaman detail token dan detail pool: posisi bot,
// posisi wallet hasil riset, dan gerakan target. Datanya dari lpRows di server.
import { chainInfo, isEthLike } from '../chain';
import { Button } from '@heroui/react';
import { Panel, Dot, Empty, DataTable, PriceRange, Refreshing, TradeLinks, baseTokenOf } from './ui';
import { TokenPair, PairName } from './TokenIcon';
import { Pair } from '../pages/Positions';
import { usd, pct, tone, ago, short, locale as fmtLocale, AKSI, KEPUTUSAN } from '../fmt';
import { useI18n, reason } from '../i18n';
import { useClosePosition } from '../useClosePosition';

const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);

// Posisi yang masih terbuka selalu ditampilkan di atas yang sudah ditutup.
const isOpen = (p) => p.status === 'open';
// Kunci baris posisi wallet — dipakai tabel riset dan tombol lompat dari tabel bot.
export const wkey = (p) => `${p.wallet}:${p.venue}:${p.token_id}`;

function Status({ open }) {
  const { t } = useI18n();
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Dot tone={open ? 'success' : 'default'} />{t(open ? 'Terbuka' : 'Ditutup')}</span>;
}

function When({ p }) {
  const { t } = useI18n();
  return (
    <span className="whitespace-nowrap text-muted">
      {p.status === 'open' ? t('dibuka {w}', { w: ago(p.opened_ts) }) : t('ditutup {w}', { w: ago(p.closed_ts) })}
    </span>
  );
}

// Dari wallet mana posisi bot ini disalin. Versi ringkas kolom Sumber di halaman
// Posisi: hanya label dan alamat target (plus nomor NFT aslinya), tanpa nasib
// posisi aslinya — lpRows tidak menghitung itu, dan di halaman token/pool yang
// ditanya pembaca adalah "ini ikut siapa", bukan "target untung berapa".
function CopiedFrom({ p }) {
  const { t } = useI18n();
  if (!p.target) {
    return (
      <span className="text-xs text-muted" title={t('Posisi ini tidak menyalin target mana pun: dibuka manual, atau sudah ada di wallet sebelum bot memantaunya.')}>
        {t('Manual / di luar bot')}
      </span>
    );
  }
  return (
    <a href={'#targets/' + p.target} className="group block max-w-40" title={p.target}>
      {p.targetLabel && <div className="truncate font-medium group-hover:underline">{p.targetLabel}</div>}
      <div className="mono text-xs whitespace-nowrap text-muted group-hover:text-foreground">
        {short(p.target)}{p.mirror_of ? ` · #${p.mirror_of}` : ''}
      </div>
    </a>
  );
}

// Semua posisi bot (terbuka + tertutup) dengan modal, nilai/hasil, dan PnL.
// onFocus: tombol "Grafik" per baris untuk menggambar posisi itu di grafik halaman.
// onHist: klik baris -> laci riwayat posisi, sama seperti tabel di halaman Posisi.
// reload: dipanggil setelah posisi ditutup dari tabel ini; tanpa itu tombol tutup
// tidak ditampilkan (halaman yang datanya tidak bisa dimuat ulang).
// wallets + onSource: tombol "Posisi asli" per baris yang disalin dari target —
// melompat ke baris posisi targetnya di tabel riset (WalletPositions) di halaman
// yang sama, supaya jelas posisi mana yang ditiru bot. Hanya tampil kalau posisi
// aslinya memang ada di tabel itu.
export function BotPositions({ open, closed, onFocus, focusId, onHist, reload, wallets, onSource, loading = false, className = '' }) {
  const { t } = useI18n();
  const { close, closeAll, closing } = useClosePosition(reload);
  const rows = [...open.map((p) => ({ ...p, status: 'open' })), ...closed];
  const pnl = sum(rows, (p) => p.pnlUsd);
  const canClose = !!reload;
  const sourceOf = (p) => (onSource && p.target && p.mirror_of
    ? wallets?.find((w) => w.wallet?.toLowerCase() === p.target.toLowerCase() && w.venue === p.venue && String(w.token_id) === String(p.mirror_of))
    : null);
  const canSource = !!onSource && rows.some(sourceOf);
  return (
    <Panel title={t('Posisi bot ({n})', { n: rows.length })} className={className} bodyClass="p-0"
      desc={onHist && rows.length > 0 ? 'Klik baris untuk riwayat transaksi dan catatan bot.' : undefined}
      action={<div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
        <Refreshing loading={loading} />
        {rows.length > 0 && <span className="text-xs"><span className="text-muted">PnL</span> <span className={`num font-medium ${tone(pnl)}`}>{usd(pnl)}</span></span>}
        {canClose && open.length > 1 && (
          <Button size="sm" variant="danger-soft" isPending={closing != null} isDisabled={closing != null} onPress={() => closeAll(open)}>
            {t('Tutup semua ({n})', { n: open.length })}
          </Button>)}
      </div>}>
      <DataTable label="Posisi bot" rows={rows} rowKey={(p) => p.id} pageSize={10}
        onRow={onHist ? (p) => onHist(p.id) : undefined}
        defaultSort={{ column: 'when', direction: 'descending' }} pinTop={isOpen}
        empty={<Empty title="Bot belum pernah membuka posisi di sini" />}
        columns={[
          { key: 'pair', label: 'Pasangan', sort: (p) => `${p.symbol0}/${p.symbol1}`, render: (p) => <Pair p={p} /> },
          { key: 'tgt', label: 'Sumber', sort: (p) => p.targetLabel || p.target || '', render: (p) => <CopiedFrom p={p} /> },
          { key: 'st', label: 'Status', sort: (p) => p.status, render: (p) => <Status open={p.status === 'open'} /> },
          { key: 'range', label: 'Rentang harga', sortable: false, render: (p) => (
            <PriceRange position={p} lo={p.tick_lower} hi={p.tick_upper} cur={p.status === 'open' ? p.curTick : null}
              dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
              entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />) },
          { key: 'cost', label: 'Modal', align: 'end', sort: (p) => p.costUsd, render: (p) => usd(p.costUsd) },
          { key: 'val', label: 'Nilai / hasil', align: 'end', sort: (p) => (p.status === 'open' ? p.valueUsd + (p.feeUsd || 0) : p.outUsd), render: (p) => (
            p.status === 'open'
              ? <div>{usd(p.valueUsd)}{p.feeUsd > 0.005 && <div className="text-xs text-success">+{usd(p.feeUsd)} fee</div>}</div>
              : usd(p.outUsd)) },
          { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnlUsd, render: (p) => (
            <div className={tone(p.pnlUsd)}>{usd(p.pnlUsd)}<div className="text-xs">{p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></div>) },
          { key: 'when', label: 'Waktu', align: 'end', sort: (p) => p.closed_ts || p.opened_ts, render: (p) => <When p={p} /> },
          ...(onFocus || canClose || canSource ? [{ key: 'act', label: '', sortable: false, className: 'text-end', render: (p) => (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {sourceOf(p) && (
                <Button size="sm" variant="outline" onPress={() => onSource(sourceOf(p))}
                  aria-label={t('Ke posisi asli #{id} di tabel wallet yang diriset', { id: p.mirror_of })}>
                  {t('Posisi asli')}
                </Button>)}
              {onFocus && (p.id === focusId
                ? <span className="text-xs text-muted">{t('di grafik')}</span>
                : <Button size="sm" variant="outline" onPress={() => onFocus(p.id)}>{t('Grafik')}</Button>)}
              {canClose && p.status === 'open' && (
                <Button size="sm" variant="danger-soft" isPending={closing === p.id} isDisabled={closing != null} onPress={() => close(p)}>{t('Tutup')}</Button>)}
            </div>) }] : []),
        ]} />
    </Panel>
  );
}

// Posisi wallet yang pernah dipindai (halaman Wallet / Target).
// onHist(baris): klik baris -> laci kejadian on-chain posisi itu (WalletPositionHistory).
// jumpTo: {key, n} — baris yang diminta ditunjukkan (dari tombol "Posisi asli" di
// tabel posisi bot); kuncinya sama dengan rowKey di bawah.
export function WalletPositions({ rows, onHist, jumpTo, loading = false, className = '' }) {
  const { t } = useI18n();
  if (!rows.length) return null;
  return (
    <Panel title={t('Posisi wallet yang diriset ({n})', { n: rows.length })}
      desc={onHist
        ? 'Modal dan hasil dari pemindaian wallet; posisi yang masih terbuka dinilai ulang di harga sekarang. Klik baris untuk kejadian on-chain-nya.'
        : 'Modal dan hasil dari pemindaian wallet; posisi yang masih terbuka dinilai ulang di harga sekarang.'}
      className={className} bodyClass="p-0" action={<Refreshing loading={loading} />}>
      <DataTable label="Posisi wallet" rows={rows} rowKey={wkey} searchable pageSize={15} jumpTo={jumpTo}
        onRow={onHist} defaultSort={{ column: 'when', direction: 'descending' }} pinTop={isOpen}
        columns={[
          { key: 'w', label: 'Wallet', sort: (p) => p.walletLabel || p.wallet, search: (p) => `${p.walletLabel || ''} ${p.wallet}`, render: (p) => (
            <a href={(p.isTarget ? '#targets/' : '#wallet/') + p.wallet} className="group block max-w-40" title={p.wallet}>
              {p.walletLabel && <div className="truncate font-medium group-hover:underline">{p.walletLabel}</div>}
              <div className="mono text-xs text-muted group-hover:text-foreground">{short(p.wallet)}</div>
            </a>) },
          { key: 'pair', label: 'Posisi / pool', sort: (p) => `${p.symbol0}/${p.symbol1}`, search: (p) => `${p.symbol0}/${p.symbol1} ${p.token_id}`, render: (p) => (
            <div className="flex items-center gap-2.5">
              <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
              <div>
                <PairName token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} pool={p.pool_ref} className="block font-medium" />
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <span className="uppercase">{p.venue}</span><span>·</span><span className="mono">#{p.token_id}</span>
                  <TradeLinks token={baseTokenOf(p)} pool={p.pool_ref} compact className="ml-1" />
                </div>
              </div>
            </div>) },
          { key: 'st', label: 'Status', sort: (p) => p.status, render: (p) => <Status open={p.status === 'open'} /> },
          { key: 'inv', label: 'Modal', align: 'end', sort: (p) => p.invested_q, render: (p) => usd(p.invested_q) },
          { key: 'pnl', label: 'PnL', align: 'end', sort: (p) => p.pnl_q, render: (p) => {
            // Posisi terbuka yang harga kininya gagal dibaca tetap ditampilkan, tapi
            // angkanya dari pemindaian terakhir — katakan begitu, jangan sodorkan
            // sebagai nilai sekarang.
            const stored = p.status === 'open' && !p.liveTs;
            return (
              <div className={tone(p.pnl_q)}
                title={stored ? t('Harga kini tidak terbaca — angka ini dari pemindaian terakhir wallet tersebut.') : undefined}>
                {usd(p.pnl_q)}
                <div className="text-xs">
                  {p.pnlPct == null ? '' : pct(p.pnlPct, 2)}
                  {stored && <span className="text-muted"> · {t('tersimpan')}</span>}
                </div>
              </div>);
          } },
          { key: 'rng', label: 'Rentang harga', sortable: false, render: (p) => (
            <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={p.curTick ?? null} dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />) },
          { key: 'when', label: 'Waktu', align: 'end', sort: (p) => p.closed_ts || p.opened_ts, render: (p) => <When p={p} /> },
        ]} />
    </Panel>
  );
}

// Gerakan LP target dan keputusan bot atasnya.
export function TargetMoves({ rows, className = '' }) {
  const { t } = useI18n();
  if (!rows.length) return null;
  return (
    <Panel title={t('Gerakan target ({n})', { n: rows.length })} className={className} bodyClass="p-0">
      <DataTable label="Gerakan target" rows={rows} rowKey={(x) => x.id} pageSize={15}
        defaultSort={{ column: 'ts', direction: 'descending' }}
        columns={[
          { key: 'ts', label: 'Waktu', sort: (x) => x.ts, render: (x) => (
            <span className="whitespace-nowrap text-muted" title={new Date(x.ts).toLocaleString(fmtLocale())}>{ago(x.ts)}</span>) },
          { key: 'tgt', label: 'Target', sort: (x) => x.targetLabel || x.target, render: (x) => (
            <a href={'#targets/' + x.target} className="group block max-w-40" title={x.target}>
              {x.targetLabel && <div className="truncate font-medium group-hover:underline">{x.targetLabel}</div>}
              <div className="mono text-xs text-muted">{short(x.target)}</div>
            </a>) },
          { key: 'kind', label: 'Aksi', sort: (x) => x.kind, render: (x) => (
            <span className="whitespace-nowrap">{t(AKSI[x.kind]?.[0] || x.kind)} <span className="text-[0.6875rem] text-muted uppercase">{x.venue}</span></span>) },
          { key: 'pair', label: 'Pasangan', sort: (x) => `${x.symbol0}/${x.symbol1}`, render: (x) => (
            <div>
              <PairName token0={x.token0} token1={x.token1} symbol0={x.symbol0} symbol1={x.symbol1} pool={x.pool_ref} sep="/" className="block font-medium" />
              <TradeLinks token={baseTokenOf(x)} pool={x.pool_ref} compact className="mt-1" />
            </div>) },
          { key: 'val', label: 'Nilai', align: 'end', sort: (x) => x.value_quote, render: (x) => (
            x.value_quote == null ? <span className="text-muted">—</span>
              : isEthLike(x.quote_symbol) ? `${x.value_quote.toFixed(4)} ${chainInfo().nativeSymbol}` : usd(x.value_quote)) },
          { key: 'dec', label: 'Keputusan', sort: (x) => x.verdict, render: (x) => {
            const k = KEPUTUSAN[x.verdict];
            return (
              <div className="max-w-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  <Dot tone={k?.[1] || 'default'} />
                  {x.position_id
                    ? <a href={'#positions/' + x.position_id} className="hover:underline">{k ? t(k[0]) : (x.verdict || '—')}</a>
                    : <span>{k ? t(k[0]) : (x.verdict || '—')}</span>}
                </div>
                {x.reason && <div className="mt-0.5 truncate text-xs text-muted" title={reason(x.reason)}>{reason(x.reason)}</div>}
              </div>);
          } },
        ]} />
    </Panel>
  );
}
