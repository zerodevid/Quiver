// The target's side of OUR position — used by the position history drawer and the position
// detail page, so the same question is answered in the same place on both screens.
//
// The reverse of the "Our copy" block in the wallet drawer: there the position belongs to someone else
// and what is missing are our numbers; here the position is ours and what is missing
// are the numbers of the one being copied. The question that always follows our own PnL —
// "we lost $41, did the one we copy win or lose?" — used to need two other
// pages: the Origin column in the Positions table, then the position drawer on the wallet page.
//
// Two sources of numbers, deliberately separated because their age and contents differ:
//  - `mirror` (wallet research result): full PnL — fees and sold leftover tokens
//    are counted — but only exists after that wallet has been scanned, and for positions
//    still open the value is as of the last scan, not the current price.
//  - `watch` (actions the watcher really saw): always fresh, but PRINCIPAL
//    only — a 'claim' action carries no value, so the result is a floor, not a certain profit.
// The dollars cannot be compared (our capital is almost never as large as theirs),
// so what is set side by side is the percentage of each one's capital.
import { useEffect, useRef, useState } from 'react';
import { Chip, Button } from '@heroui/react';
import { Crosshair, RefreshCw } from 'lucide-react';
import { get, post } from '../api';
import { Fig, WalletLinks } from './ui';
import { usd, pct, tone, age, ago, short } from '../fmt';
import { useI18n } from '../i18n';

// Re-scan the target's wallet (incremental), wait for the job, then let the parent reload.
async function rescanTarget(address) {
  const r = await post('/api/wallet/scan', { address, mode: 'refresh' });
  if (r.error) throw new Error(r.error);
  const deadline = Date.now() + 120000;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const d = await get('/api/wallet?address=' + address);
    if (d.job?.status === 'gagal') throw new Error(d.job.error || 'scan failed');
    if (d.job?.status !== 'jalan' || Date.now() > deadline) return;
  }
}

export default function TargetSide({ p, className = 'mb-4', onRefresh }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const alive = useRef(true);
  const refresh = async () => {
    setBusy(true); setErr(null);
    try { await rescanTarget(p.target); if (alive.current) await onRefresh?.(); }
    catch (e) { if (alive.current) setErr(e.message); }
    finally { if (alive.current) setBusy(false); }
  };
  // Refresh once when the block opens, unless the target's position is already closed
  // (its numbers can no longer change). Keyed on the target position, not on every poll.
  const settled = p.origin?.mirror?.status === 'closed';
  useEffect(() => {
    alive.current = true;
    if (p.target && !settled) refresh();
    return () => { alive.current = false; };
  }, [p.target, p.mirror_of]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!p.target) {
    return (
      <div className={`rounded-lg border border-border p-3 ${className}`}>
        <div className="text-sm font-medium">{t('Tidak meniru siapa pun')}</div>
        <p className="mt-1 text-xs text-muted">{t('Posisi ini tidak menyalin target mana pun: dibuka manual, atau sudah ada di wallet sebelum bot memantaunya.')}</p>
      </div>
    );
  }
  const o = p.origin || null;
  const m = o?.mirror || null;
  const w = o?.watch || null;
  const research = !!m;
  const nft = p.mirror_of || o?.tokenId || null;
  const label = p.targetLabel || o?.targetLabel || null;
  // One block = one source. Research capital set next to watched withdrawals
  // would mix two bookkeepings that are never exactly the same; the
  // middle figure therefore follows the source in use.
  const capital = research ? m.costUsd : (w && w.inUsd > 0.005 ? w.inUsd : null);
  const result = research
    ? (m.costUsd != null && m.pnlUsd != null ? m.costUsd + m.pnlUsd : null)
    : (w && w.outUsd > 0.005 ? w.outUsd : null);
  const pnl = research ? m.pnlUsd : (w?.pnlUsd ?? null);
  const pnlPct = research ? m.pnlPct : (w?.pnlPct ?? null);
  const opened = research ? m.status === 'open' : !!w?.open;
  const ours = p.costUsd > 0 && p.pnlUsd != null ? (p.pnlUsd / p.costUsd) * 100 : null;
  const number = [capital != null, result != null, pnl != null].filter(Boolean).length;
  return (
    <div className={`rounded-lg border border-border p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Crosshair className="size-4 shrink-0 text-muted" />
          {t('Posisi yang kita tiru')}
          {(research || w) && <Chip size="sm" variant="soft" color={opened ? 'success' : 'default'}>{t(opened ? 'Dia masih di dalam' : 'Dia sudah keluar')}</Chip>}
          {p.takeover_ts != null && p.status !== 'closed' && (
            <span title={t('Diambil alih {w} — bot tidak mengikuti target dan tidak menutup otomatis.', { w: ago(p.takeover_ts) })}>
              <Chip size="sm" variant="soft" color="warning">{t('Kendali manual')}</Chip>
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <a href={'#targets/' + p.target} className="min-w-0 text-xs text-accent hover:underline" title={p.target}>
            {label || short(p.target)}{nft ? ` · #${nft}` : ''}
          </a>
          <WalletLinks address={p.target} compact />
          <Button size="sm" variant="ghost" isIconOnly isDisabled={busy} onPress={refresh}
            aria-label={t('Perbarui posisi target')} title={t('Perbarui posisi target')}>
            <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
          </Button>
        </span>
      </div>
      {number === 0 ? (!w && (
        <div className="text-xs text-muted">
          {t('Hasil posisi aslinya belum diketahui: wallet target ini belum diriset, dan pemantau belum mencatat satu aksi pun di posisi itu.')}
        </div>
      )) : (
        <div className={`grid gap-3 ${number >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {capital != null && <Fig label={research ? 'Modal dia' : 'Dia taruh'} value={usd(capital)} />}
          {result != null && <Fig label={research ? (opened ? 'Nilai dia' : 'Dia dapat') : 'Dia tarik'} value={usd(result)}
            sub={!research && w.claims > 0 ? t('+{n} klaim fee', { n: w.claims }) : null} />}
          {pnl != null && <Fig label={opened ? 'Hasil dia (sementara)' : 'Hasil dia'} value={usd(pnl)} cls={tone(pnl)}
            sub={pnlPct == null ? null : pct(pnlPct, 2)} />}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-danger">{err}</div>}
      {pnlPct != null && ours != null && (
        <div className="mt-2 text-xs text-muted">
          {t('Target {a} atas modalnya · kita {b} atas modal kita', { a: pct(pnlPct, 2), b: pct(ours, 2) })}
        </div>
      )}
      {/* Why these numbers may differ from what we see on the wallet page. */}
      <p className="mt-2 text-xs text-muted">
        {research
          ? (m.stale
            ? t('Dari riset wallet — fee dan token sisa yang dia jual sudah ikut. Posisinya masih terbuka, jadi nilainya sebesar pemindaian wallet terakhir, bukan harga sekarang.')
            : t('Dari riset wallet: pokok, fee, dan token sisa yang dia jual sudah ikut terhitung.'))
          : pnl != null
            ? t('Belum ada riset wallet, jadi ini dari aksi yang terpantau saja: pokok yang dia tarik dikurangi yang dia taruh. Fee yang dia panen terpisah tidak ikut, jadi angka ini lantai — bukan laba pastinya.')
            /* without research AND without withdrawals: the sentence above already says there is
               no figure at all — repeating it here is just noise. */
            : w ? t('Dia belum menarik apa pun dari posisi itu, jadi hasilnya belum bisa dihitung.') : ''}
        {!research && (
          <>{w ? ' ' : ''}<a href={'#wallet/' + p.target} className="text-accent hover:underline">{t('Pindai wallet target')}</a>{' '}
            {t('untuk angka yang lengkap.')}</>
        )}
      </p>
      {(w || m) && (
        <div className="mt-1 text-xs text-muted">
          {w?.heldSec > 0 ? t('dia pegang {d}', { d: age(w.heldSec / 3600) }) : (m?.openedTs ? t('dia buka {w}', { w: ago(m.openedTs) }) : null)}
          {w?.events > 0 ? ` · ${t('{n} aksi terpantau', { n: w.events })}` : ''}
        </div>
      )}
    </div>
  );
}
