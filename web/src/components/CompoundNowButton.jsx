import { useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Layers } from 'lucide-react';
import { get, post, withChain } from '../api';
import { ask } from './ui';
import { useI18n, reason } from '../i18n';
import { usd } from '../fmt';

// One-off compound: the position's unclaimed fees go back in as liquidity right now. Unlike the
// "Panen fee" schedule this ignores the enabled switch and the minimum. The preview prices it
// first (nothing is sent), then the owner confirms a real transaction.
export default function CompoundNowButton({ p, reload, disabled = false, size = 'sm' }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!p || p.empty || p.status === 'closed') return null;
  if (!(p.compound?.supported ?? p.venue === 'v4')) return null;
  const pair = `${p.symbol0}/${p.symbol1}`;

  const run = async () => {
    setBusy(true);
    const info = await get(withChain(`/api/positions/compound-now?id=${p.id}`, p.chain)).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (info.error) return toast.danger(t('Compound tidak bisa dijalankan'), { description: reason(info.error) });
    if (info.dryRun) return toast.warning(t('Mode simulasi aktif — compound tidak mengirim transaksi'));
    if (info.paused) return toast.warning(t('Bot sedang dijeda — lanjutkan dulu'));
    if (info.error || info.skip) return toast.warning(t('Belum bisa di-compound'), { description: reason(info.skip) });
    const ok = await ask({
      title: t('Compound fee {pair} sekarang?', { pair }),
      body: (
        <div className="flex flex-col gap-2">
          <p>{t('Fee yang belum diklaim ({fee}) ditambahkan kembali sebagai likuiditas di posisi ini: sekitar {add}.', { fee: usd(info.feeUsd), add: usd(info.addUsd) })}</p>
          <ul className="list-disc space-y-1 ps-5">
            <li>{t('Tanpa swap: sisa token yang tidak cocok dengan rasio LP masuk ke wallet.')}</li>
            <li>{t('Mengirim transaksi on-chain dan butuh gas; tidak bisa dibatalkan.')}</li>
            <li>{t('Hasil akhir mengikuti harga saat transaksi masuk (slippage dari Aturan). Batas nilai posisi dan eksposur tetap berlaku.')}</li>
            <li>{t('Tidak mengubah jadwal Panen fee otomatis.')}</li>
          </ul>
        </div>
      ),
      confirm: t('Compound sekarang'),
    });
    if (!ok) return;
    setBusy(true);
    const r = await post(withChain('/api/positions/compound-now', p.chain), { id: p.id }).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (r.error) return toast.danger(t('Compound gagal'), { description: reason(r.error), timeout: 12000 });
    if (r.pending) toast.success(t('Compound terkirim — menunggu konfirmasi'), { description: t('Hasilnya muncul di sinkron berikutnya.') });
    else toast.success(t('Compound {pair} berhasil', { pair }), { description: t('Ditambahkan sekitar {add}.', { add: usd(r.valueUsd) }) });
    reload?.();
  };

  return <Button size={size} variant="outline" isPending={busy} isDisabled={disabled || busy} onPress={run}>
    <Layers className="size-3.5" />{t('Compound')}</Button>;
}
