import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { get } from '../api';
import { PageHeader, Panel, Text } from '../components/ui';
import WalletDetail from '../components/WalletDetail';
import { usd, tone, short } from '../fmt';
import { useI18n } from '../i18n';

const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

// Halaman riset: cari wallet mana pun. #wallet/0x… langsung membuka alamat itu.
export default function WalletPage({ param }) {
  const { t } = useI18n();
  const initial = param && isAddr(param.toLowerCase()) ? param.toLowerCase() : null;
  const [addr, setAddr] = useState(initial || '');
  const [current, setCurrent] = useState(initial);
  const [recent, setRecent] = useState([]);
  const valid = isAddr(addr.trim().toLowerCase());

  const loadRecent = useCallback(() => get('/api/wallets').then((d) => setRecent(d.wallets || [])), []);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  const open = (a = addr.trim().toLowerCase()) => {
    if (!isAddr(a)) return;
    setAddr(a); setCurrent(a);
    history.replaceState(null, '', '#wallet/' + a);   // bisa di-bookmark / dibagikan
  };

  return (
    <>
      <PageHeader group="Riset" title="Wallet"
        desc="PnL, fee, dan seluruh riwayat posisi LP wallet mana pun — dihitung langsung dari chain." />
      <Panel className="mb-6">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
          <Text label="Alamat wallet" mono placeholder="0x…" value={addr} onChange={setAddr}
            isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
          <Button onPress={() => open()} isDisabled={!valid}>{t('Buka')}</Button>
        </div>
        {recent.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{t('Pernah dipindai:')}</span>
            {recent.map((w) => (
              <Button key={w.address} size="sm" variant={w.address === current ? 'secondary' : 'outline'} onPress={() => open(w.address)}>
                <span className="mono">{short(w.address)}</span>
                <span className="text-muted">· {t('{n} posisi', { n: w.positions_n })} ·</span>
                <span className={`num ${tone(w.stats.totalProfitUsd)}`}>{usd(w.stats.totalProfitUsd || 0)}</span>
              </Button>
            ))}
          </div>
        )}
      </Panel>
      {current && <WalletDetail key={current} address={current} onChanged={loadRecent} />}
    </>
  );
}
