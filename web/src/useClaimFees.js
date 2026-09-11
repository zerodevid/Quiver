import { useRef, useState } from 'react';
import { toast } from '@heroui/react';
import { post } from './api';
import { ask } from './components/ui';
import { useI18n } from './i18n';
import { usd, short } from './fmt';

export function useClaimFees(reload) {
  const { t } = useI18n();
  const lock = useRef(false);
  const [claiming, setClaiming] = useState(null);
  const claim = async (p) => {
    if (lock.current) return;
    lock.current = true;
    try {
      if (!await ask({ title: t('Claim fee'),
        body: t('Perkiraan fee {v}. Fee masuk ke wallet dalam token pool. Likuiditas tetap terbuka; gas tetap dibayar.', { v: usd(p.feeUsd) }),
        confirm: t('Claim fee') })) return;
      setClaiming(p.id);
      const r = await post('/api/positions/claim', { id: p.id });
      if (r.error) toast.danger(t('Claim fee gagal'), { description: r.error });
      else if (r.pending) toast.warning(t('Claim fee masih diproses'), { description: `Tx: ${r.tx}` });
      else toast.success(t('Fee sudah diklaim'), { description: r.accountingPending
        ? t('Pencatatan nominal menunggu sinkronisasi.') : `Tx: ${short(r.tx)}` });
    } catch {
      toast.warning(t('Status claim belum pasti'), { description: t('Koneksi terputus. Cek lagi sebelum mencoba ulang.') });
    } finally {
      lock.current = false;
      setClaiming(null);
      reload?.();
    }
  };
  return { claim, claiming };
}
