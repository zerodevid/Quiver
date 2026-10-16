// Scan the wallet for active LP positions the bot has not recorded yet (e.g. opened before the
// wallet was imported) and adopt them. Covers the recent days only, to spare the RPC.
import { useState } from 'react';
import { Button, toast } from '@heroui/react';
import { ScanSearch } from 'lucide-react';
import { post } from '../api';
import { useI18n } from '../i18n';

export default function ScanPositionsButton({ onDone, size = 'md' }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    const r = await post('/api/positions/scan', {});
    setBusy(false);
    if (r.error) return toast.danger(t(r.error));
    toast.success(r.adopted
      ? t('{n} posisi baru ditemukan dan sekarang dikelola bot', { n: r.adopted })
      : t('Tidak ada posisi baru — semua posisi LP wallet ini sudah tercatat'));
    if (r.errors?.length) toast.warning(r.errors.join('; '));
    onDone?.(r);
  };
  return (
    <Button size={size} variant="outline" isPending={busy} onPress={scan}>
      {!busy && <ScanSearch className="size-4" />}{t(busy ? 'Memindai…' : 'Scan posisi')}
    </Button>
  );
}
