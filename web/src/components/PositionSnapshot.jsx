import { Button, Chip } from '@heroui/react';
import { RefreshCw } from 'lucide-react';
import { usePoll } from '../hooks';
import { useClaimFees } from '../useClaimFees';
import { useClosePosition } from '../useClosePosition';
import AutoCompoundButton from './AutoCompoundButton';
import TokenIcon from './TokenIcon';
import { KV, Loading, Notice, PriceRange } from './ui';
import { useI18n } from '../i18n';
import { usd, price, sqrtPrice, tickPrice, ago, locale } from '../fmt';

const amount = (raw, decimals) => raw == null ? '—' : (Number(raw) / 10 ** (decimals ?? 18)).toLocaleString(locale(), { maximumSignificantDigits: 7 });

export default function PositionSnapshot({ id, onUpdate }) {
  const { t } = useI18n();
  const { data, error, reload, loading } = usePoll(`/api/position?id=${encodeURIComponent(id)}`, 10000);
  const refresh = () => { reload(); onUpdate?.(); };
  const { claim, claiming } = useClaimFees(refresh);
  const { close, closing } = useClosePosition(refresh);
  const p = data?.position;
  if (!p) return error ? <Notice status="warning" title="Detail posisi tidak terbaca">{error}<Button size="sm" variant="tertiary" onPress={reload}>{t('Coba lagi')}</Button></Notice> : <Loading />;
  const closed = p.status === 'closed';
  const synced = p.amount0 != null && p.amount1 != null;
  const busy = claiming != null || closing != null;
  const current = closed ? sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide) : p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide) : p.curTick != null ? tickPrice(p.curTick, p.dec0, p.dec1, p.quoteSide) : null;
  const quote = p.quoteSide === 0 ? p.symbol0 : p.symbol1;
  const base = p.quoteSide === 0 ? p.symbol1 : p.symbol0;
  return <section className="mb-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t('Posisi ini')}</h3>
      <div className="flex items-center gap-2">
        <Chip size="sm" variant="soft" color={closed ? 'default' : p.empty || p.inRange === false ? 'warning' : p.inRange === true ? 'success' : 'default'}>{t(closed ? 'Ditutup' : p.empty ? 'Likuiditas kosong' : p.inRange == null ? 'belum tersinkron' : p.inRange ? 'in-range' : 'di luar rentang')}</Chip>
        <Button size="sm" variant="tertiary" isPending={loading} isDisabled={loading} aria-label={t('Perbarui detail')} onPress={refresh}><RefreshCw className="size-4" /></Button>
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-warning">{error}</p>}
    <div className="rounded-lg border border-border px-3 divide-y divide-border">
      <KV label={closed ? 'Hasil' : 'Nilai likuiditas'}>{usd(synced ? (closed ? p.outUsd : p.valueUsd) : null)}</KV>
      <KV label="Rentang posisi"><PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={closed ? null : p.curTick} dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} /></KV>
      <KV label={closed ? 'Harga keluar' : 'Harga sekarang'}>{price(current)} <span className="text-xs text-muted">{quote} / {base}</span></KV>
      <KV label="Harga masuk">{price(sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide))} <span className="text-xs text-muted">{quote} / {base}</span></KV>
      <KV label="Fee pool">{p.fee != null ? `${p.fee / 10000}%` : '—'}</KV>
    </div>
    {!closed && p.inRange === false && <p className="text-xs text-warning">{t('Harga berada di luar rentang. Posisi tidak menghasilkan fee swap sampai harga kembali ke rentang.')}</p>}
    <div>
      <h3 className="mb-2 text-sm font-semibold">{t(closed ? 'Diterima saat keluar' : 'Komposisi token')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((side) => <div key={side} className="min-w-0 rounded-lg border border-border p-3">
          <div className="mb-3 flex items-center gap-2"><TokenIcon address={p[`token${side}`]} symbol={p[`symbol${side}`]} size={24} /><span className="font-medium">{p[`symbol${side}`]}</span></div>
          <div className="num break-words text-lg font-semibold">{amount(p[`amount${side}`], p[`dec${side}`])}</div>
          <div className="mt-3 space-y-1 text-xs">
            <div className="flex justify-between gap-2"><span className="text-muted">{t('Modal disetor')}</span><span className="num">{amount(p[`cost${side}`], p[`dec${side}`])}</span></div>
            {!closed && <div className="flex justify-between gap-2"><span className="text-muted">{t('Fee belum diklaim')}</span><span className="num text-success">{amount(p[`fee${side}`], p[`dec${side}`])}</span></div>}
          </div>
        </div>)}
      </div>
    </div>
    <div className="rounded-lg border border-border p-3">
      <h3 className="mb-2 text-sm font-semibold">{t('Fee & pengelolaan')}</h3>
      <KV label="Fee belum diklaim"><span className="text-success">{usd(!closed && p.fee0 != null && p.fee1 != null ? p.feeUsd : null)}</span></KV>
      <KV label="Fee diklaim sebelumnya">{usd(p.claimedUsd)}</KV>
      {p.compound && <KV label="Total ditambahkan (perkiraan)">{usd(p.compound.compoundedUsd)}</KV>}
      {!closed && <>
        <p className="my-3 text-xs text-muted">{t('Claim mengirim fee ke wallet. Auto-compound menambahkan fee kembali ke likuiditas; keduanya memerlukan gas.')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" isPending={claiming != null} isDisabled={busy || !synced || !(p.feeUsd > 0)} onPress={() => claim(p)}>{t('Claim fee')}</Button>
          <AutoCompoundButton p={p} reload={refresh} disabled={busy || !synced} />
          <Button size="sm" variant="danger-soft" isPending={closing != null} isDisabled={busy || !synced || p.empty} onPress={() => close(p)}>{t('Tutup posisi')}</Button>
        </div>
        {p.venue !== 'v4' && <p className="mt-2 text-xs text-muted">{t('Auto-compound tersedia untuk posisi Uniswap v4.')}</p>}
        {p.compound?.enabled && <p className="mt-3 text-xs text-muted">{t('Minimum {v} · diperiksa setiap {n} menit', { v: usd(p.compound.minUsd), n: p.compound.intervalMinutes })}</p>}
      </>}
    </div>
    <p className="text-xs text-muted">{synced && data.syncedAt ? t('Sinkronisasi terakhir {w}', { w: ago(data.syncedAt) }) : t('Jumlah token menunggu sinkronisasi.')}</p>
  </section>;
}
