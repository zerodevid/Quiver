// Superadmin: the platform fee wallets — per-chain treasury address, live balance and income chart.
import { PageHeader, Notice } from '../components/ui';
import TreasuryWallets from '../components/TreasuryWallets';
import { useMe, isSuperadmin } from '../me';
import { useI18n } from '../i18n';

export default function Treasury() {
  const { t } = useI18n();
  const me = useMe();
  return (
    <>
      <PageHeader group="Admin" title="Wallet fee"
        desc="Alamat penampung fee platform per chain. Fee tiap aksi akun pengguna dikirim ke sini dalam koin native. Saldo dibaca langsung dari jaringan; grafik menunjukkan fee yang masuk dari semua akun." />
      {me && !isSuperadmin(me) ? <Notice status="warning">{t('Halaman ini khusus superadmin.')}</Notice> : <TreasuryWallets />}
    </>
  );
}
