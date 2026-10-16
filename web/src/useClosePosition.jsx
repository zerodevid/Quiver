import { useState } from 'react';
import { toast } from '@heroui/react';
import { get, post, withChain } from './api';
import { ask } from './components/ui';
import { muteClose } from './components/TargetAlerts';
import { usd, short } from './fmt';
import { useI18n } from './i18n';

// The close-position flow from the dashboard, used by the list and detail pages. The server only
// replies after the transaction is actually accepted on chain (can be ~1 minute),
// so during that time the button spins and the "closing" toast stays visible.
// There are three outcomes, not two: closed, failed (the server answers with a reason),
// or uncertain — the connection dropped / a proxy cut the long request before the
// server could answer, although the transaction may still have landed.
export function useClosePosition(reload) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(null);   // ids of the positions being closed
  // One position: send the request, wait for the chain, report via toast. Used
  // by both close-one and close-all; the confirmation is with the caller.
  const run = async (p, { force = false } = {}) => {
    const pair = `${p.symbol0}/${p.symbol1}`;
    setClosing(p.id);
    muteClose(p.id);   // the toast for the result comes from this flow; the alert feed must not repeat it
    const wait = toast(t('Menutup posisi {pair}…', { pair }), {
      description: t('Menunggu konfirmasi di chain, bisa sampai 1–2 menit.'), isLoading: true, timeout: 0,
    });
    let r;
    try { r = await post(withChain('/api/positions/close', p.chain), force ? { id: p.id, force: true } : { id: p.id }); }
    catch (e) { r = { error: e.message, lost: true }; }
    toast.close(wait);
    if (r.lost || /^HTTP 5\d\d$/.test(r.error || '')) {
      toast.warning(t('Status penutupan {pair} belum pasti', { pair }), {
        description: t('Koneksi ke server terputus sebelum ada jawaban. Transaksinya mungkin tetap diproses — cek lagi posisinya sebentar lagi.'),
        timeout: 15000,
      });
    } else if (r.error) {
      toast.danger(t('Gagal menutup {pair}', { pair }), { description: r.error, timeout: 12000 });
    } else {
      const parts = [
        r.outUsd != null && t('Diterima {v}', { v: usd(r.outUsd) }),
        r.pnlUsd != null && `PnL ${r.pnlUsd >= 0 ? '+' : ''}${usd(r.pnlUsd)}`,
        r.sold,
        r.tx && `tx ${short(r.tx)}`,
      ].filter(Boolean);
      toast.success(t('Posisi {pair} ditutup', { pair }), { description: parts.join(' · '), timeout: 10000 });
    }
    return r;
  };
  const close = async (p) => {
    if (closing != null) return;
    const pair = `${p.symbol0}/${p.symbol1}`;
    // Quote the exit first (read-only, ~1–3 s): the real PnL after selling the memecoin side and gas.
    const wait = toast(t('Menghitung estimasi hasil tutup…'), { isLoading: true, timeout: 0 });
    let q = null;
    try { q = await get(withChain(`/api/position/exit-quote?id=${p.id}`, p.chain)); } catch { /* the plain dialog still works */ }
    toast.close(wait);
    if (q?.error) q = null;
    const sign = (v) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
    const row = (label, v, cls = '') => (
      <div className="flex justify-between gap-4"><span>{label}</span><span className={`num ${cls}`}>{v}</span></div>
    );
    const base = p.feeUsd > 0.005
      ? t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(p.valueUsd), f: usd(p.feeUsd) })
      : t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v}.', { v: usd(p.valueUsd) });
    const ok = await ask({
      title: t('Tutup posisi {pair}?', { pair }),
      body: q ? (
        <div className="space-y-2">
          <div>{base}</div>
          <div className="space-y-1 rounded-lg border border-border p-2.5 text-[0.8125rem]">
            <div className="font-medium text-foreground">{t('Estimasi jika ditutup sekarang')}</div>
            {row(t('Diterima di wallet'), usd(q.receiveUsd))}
            {q.sellCostUsd > 0.005 && row(t('Kerugian jual memecoin (Kyber)'), `−${usd(q.sellCostUsd)}`, 'text-danger')}
            {row(t('Gas'), `−${usd(q.gasUsd)}`)}
            {q.claimedUsd > 0.005 && row(t('Fee yang sudah diklaim'), `+${usd(q.claimedUsd)}`)}
            {row(t('PnL riil'), `${sign(q.pnlUsd)} (${q.pnlPct >= 0 ? '+' : ''}${q.pnlPct.toFixed(1)}%)`, q.pnlUsd >= 0 ? 'text-success font-medium' : 'text-danger font-medium')}
            <div className="text-xs text-muted">{t('Harga tengah pool menunjukkan {v}', { v: sign(q.pnlMidUsd) })}</div>
            {!q.quoted && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
          </div>
        </div>
      ) : base,
      confirm: t('Tutup posisi'), danger: true,
    });
    if (!ok) return;
    await run(p);
    setClosing(null);
    reload?.();
  };
  // All positions in the list, one by one — not in parallel, so the wallet nonces
  // do not overtake each other and if one fails the others are still tried. One confirmation
  // for all; each position's result is still reported individually.
  // `pair` (optional): the pool name if the list is only one pool's positions (Monitor),
  // so the confirmation does not read like closing the entire portfolio.
  const closeAll = async (list, { pair = null } = {}) => {
    if (closing != null || !list?.length) return;
    const value = list.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const fee = list.reduce((s, p) => s + (p.feeUsd || 0), 0);
    const ok = await ask({
      title: pair ? t('Tutup semua {n} posisi {pair}?', { n: list.length, pair }) : t('Tutup semua {n} posisi terbuka?', { n: list.length }),
      body: fee > 0.005
        ? t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(value), f: usd(fee) })
        : t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v}.', { v: usd(value) }),
      confirm: t('Tutup semua'), danger: true,
    });
    if (!ok) return;
    for (const p of list) {
      await run(p);
      reload?.();   // the table shrinks while the rest is still running
    }
    setClosing(null);
    reload?.();
  };
  // Force-close all open positions (the emergency button on the Positions page). The difference from
  // closeAll: the server bypasses the compound/claim guards that are still waiting, burns
  // liquidity according to the chain (not the records), and positions that are already empty on chain
  // are booked immediately. A failed position is skipped, the rest are still tried; at the end
  // it reports how many closed and how many failed.
  const forceCloseAll = async (list) => {
    if (closing != null || !list?.length) return;
    const value = list.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const ok = await ask({
      title: t('Tutup paksa semua {n} posisi terbuka?', { n: list.length }),
      body: t('Semua posisi ditutup satu per satu tanpa menunggu compound/claim yang tertunda, dan likuiditas dibakar sesuai chain. Nilai sekarang {v}. Tidak bisa dibatalkan setelah berjalan.', { v: usd(value) }),
      confirm: t('Tutup paksa semua'), danger: true,
    });
    if (!ok) return;
    let done = 0, failed = 0;
    for (const p of list) {
      const r = await run(p, { force: true });
      if (r?.ok) done++; else failed++;
      reload?.();
    }
    setClosing(null);
    reload?.();
    if (failed) toast.warning(t('Tutup paksa selesai: {d} tertutup, {f} gagal', { d: done, f: failed }), { timeout: 12000 });
    else toast.success(t('Tutup paksa selesai: {d} posisi tertutup', { d: done }), { timeout: 10000 });
  };
  return { close, closeAll, forceCloseAll, closing };
}
