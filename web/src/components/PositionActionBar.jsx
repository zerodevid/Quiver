import { useCallback } from 'react';
import { Button } from '@heroui/react';
import { Coins, DoorOpen } from 'lucide-react';
import { usePoll } from '../hooks';
import { useClaimFees } from '../useClaimFees';
import { useClosePosition } from '../useClosePosition';
import AutoCompoundButton from './AutoCompoundButton';
import TpSlButton from './TpSlButton';
import TakeoverButton from './TakeoverButton';
import { useI18n } from '../i18n';

// The same icon row as the Aksi column of the Positions table, for the drawer header: harvest
// settings, TP/SL, take over, claim fee, close. Loads the full position itself because the
// history payload the drawer holds lacks what the buttons need (compound state, takeover, TP/SL).
export default function PositionActionBar({ id, onUpdate }) {
  const { t } = useI18n();
  const { data, reload } = usePoll(`/api/position?id=${encodeURIComponent(id)}`, 10000);
  const refresh = useCallback(async () => { await reload(); onUpdate?.(); }, [reload, onUpdate]);
  const { claim, claiming } = useClaimFees(refresh);
  const { close, closing } = useClosePosition(refresh);
  const p = data?.position;
  if (!p || p.status === 'closed' || p.empty) return null;
  const busy = claiming != null || closing != null;
  return <div className="flex items-center gap-1" role="toolbar" aria-label={t('Aksi posisi')}>
    <AutoCompoundButton p={p} reload={refresh} disabled={busy} compact />
    <TpSlButton p={p} reload={refresh} disabled={busy} compact />
    <TakeoverButton p={p} reload={refresh} disabled={busy} compact />
    <Button size="sm" variant="tertiary" isIconOnly aria-label={t('Claim fee')} title={t('Claim fee')}
      isPending={claiming === p.id} isDisabled={busy || !(p.feeUsd > 0)} onPress={() => claim(p)}>
      <Coins className="size-4" />
    </Button>
    <Button size="sm" variant="tertiary" className="text-danger" isIconOnly aria-label={t('Tutup posisi')} title={t('Tutup posisi')}
      isPending={closing === p.id} isDisabled={busy} onPress={() => close(p)}>
      <DoorOpen className="size-4" />
    </Button>
  </div>;
}
