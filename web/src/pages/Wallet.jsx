import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { Search, ChevronRight } from 'lucide-react';
import { get } from '../api';
import { PageHeader, Panel, Text, DataTable } from '../components/ui';
import WalletDetail from '../components/WalletDetail';
import { kUsd, tone, short, num, ago } from '../fmt';
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
      <form className="mb-4 flex items-start gap-2" onSubmit={(e) => { e.preventDefault(); open(); }}>
        <Text className="min-w-0 flex-1" aria="Alamat wallet" mono placeholder="0x… alamat wallet" value={addr} onChange={setAddr}
          isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
        <Button type="submit" isDisabled={!valid}><Search className="size-4" />{t('Buka')}</Button>
      </form>
      {current
        ? <WalletDetail key={current} address={current} onChanged={loadRecent} />
        : recent.length > 0 && (
          <Panel title="Pernah dipindai" bodyClass="p-0">
            <DataTable label="Pernah dipindai" rows={recent} rowKey={(w) => w.address} searchable
              defaultSort={{ column: 'pnl', direction: 'descending' }}
              columns={[
                { key: 'a', label: 'Wallet', sort: (w) => w.label || w.address, search: (w) => `${w.label || ''} ${w.address}`, render: (w) => (
                  <button type="button" onClick={() => open(w.address)} className="text-start hover:underline">
                    {w.label && <div className="font-medium">{w.label}</div>}
                    <div className="mono">{short(w.address)}</div>
                  </button>) },
                { key: 'n', label: 'Posisi', align: 'end', sort: (w) => w.positions_n, render: (w) => num(w.positions_n) },
                { key: 'win', label: 'Win rate', align: 'end', sort: (w) => w.stats?.winRatePct, render: (w) => (w.stats?.winRatePct == null ? '—' : `${w.stats.winRatePct.toFixed(0)}%`) },
                { key: 'fee', label: 'Fee', align: 'end', sort: (w) => w.stats?.feeEarnedUsd, render: (w) => kUsd(w.stats?.feeEarnedUsd || 0) },
                { key: 'pnl', label: 'PnL', align: 'end', sort: (w) => w.stats?.totalProfitUsd, render: (w) => (
                  <span className={`font-medium ${tone(w.stats?.totalProfitUsd)}`}>{kUsd(w.stats?.totalProfitUsd || 0)}</span>) },
                { key: 'ts', label: 'Dipindai', align: 'end', sort: (w) => w.last_scan_ts, render: (w) => <span className="whitespace-nowrap text-muted">{ago(w.last_scan_ts)}</span> },
                { key: 'go', label: '', sortable: false, className: 'w-10', render: (w) => (
                  <Button size="sm" variant="ghost" isIconOnly aria-label={t('Buka')} onPress={() => open(w.address)}><ChevronRight className="size-4" /></Button>) },
              ]} />
          </Panel>
        )}
    </>
  );
}
