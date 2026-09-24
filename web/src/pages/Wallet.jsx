import { useCallback, useEffect, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { Search, ChevronRight } from 'lucide-react';
import { get } from '../api';
import { PageHeader, Panel, Text, DataTable, WalletLinks } from '../components/ui';
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
        desc="PnL, fee, gaya ber-LP, dan seluruh riwayat posisi wallet mana pun — dihitung langsung dari chain. Klik baris posisi untuk melihat tiap kejadian on-chain-nya." />
      {/* Selebar alamat yang diketik, bukan selebar halaman: kotak isian sepanjang kartu
          di bawahnya terbaca seperti ruang kosong. */}
      <form className="mb-4 flex max-w-2xl items-start gap-2" onSubmit={(e) => { e.preventDefault(); open(); }}>
        <Text className="min-w-0 flex-1" aria="Alamat wallet" mono placeholder="0x… alamat wallet" value={addr} onChange={setAddr}
          isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
        <Button type="submit" isDisabled={!valid}><Search className="size-4" />{t('Buka')}</Button>
      </form>
      {/* Wallet yang sedang dibuka: alamat penuh + tombol ke situs luar, supaya riset
          di sini bisa langsung diadu dengan DeBank/LPAgent/penjelajah blok. */}
      {current && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="mono break-all text-sm text-muted">{current}</span>
          <WalletLinks address={current} />
        </div>
      )}
      {current
        ? <WalletDetail key={current} address={current} onChanged={loadRecent} />
        : recent.length > 0 && (
          <Panel title="Pernah dipindai" bodyClass="p-0">
            <DataTable label="Pernah dipindai" rows={recent} rowKey={(w) => w.address} searchable
              defaultSort={{ column: 'pnl', direction: 'descending' }}
              columns={[
                // Nama + alamat jadi satu tombol; penanda target dan logo situs luar berdiri
                // di sampingnya dengan jarak sendiri — dulu tumpukan logo mengalir inline di
                // belakang tombol sehingga menempel ke chip dan melebarkan kolom.
                { key: 'a', label: 'Wallet', sort: (w) => w.label || w.address, search: (w) => `${w.label || ''} ${w.address}`, render: (w) => (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <button type="button" onClick={() => open(w.address)} className="group min-w-0 max-w-56 text-start sm:w-56 sm:shrink-0" title={w.address}>
                      {w.label && <div className="truncate font-medium group-hover:underline">{w.label}</div>}
                      <div className={`mono ${w.label ? 'text-xs text-muted group-hover:text-foreground' : 'group-hover:underline'}`}>{short(w.address)}</div>
                    </button>
                    {w.isTarget && <Chip size="sm" variant="soft" color="accent" className="shrink-0 whitespace-nowrap">{t('target tersimpan')}</Chip>}
                    <WalletLinks address={w.address} compact className="shrink-0" />
                  </div>) },
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
