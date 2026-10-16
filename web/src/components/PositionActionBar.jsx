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

// The labelled action row for the drawer header (the table uses icons only): harvest
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
  return <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={t('Aksi posisi')}>
    <AutoCompoundButton p={p} reload={refresh} disabled={busy} />
    <TpSlButton p={p} reload={refresh} disabled={busy} />
    <TakeoverButton p={p} reload={refresh} disabled={busy} />
    <Button size="sm" variant="outline" isPending={claiming === p.id} isDisabled={busy || !(p.feeUsd > 0)} onPress={() => claim(p)}>
      <Coins className="size-3.5" />{t('Claim fee')}
    </Button>
    <Button size="sm" variant="danger-soft" isPending={closing === p.id} isDisabled={busy} onPress={() => close(p)}>
      <DoorOpen className="size-3.5" />{t('Tutup posisi')}
    </Button>
  </div>;
}
