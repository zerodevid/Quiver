import { useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Hand, Undo2 } from 'lucide-react';
import { get, post } from '../api';
import { ask } from './ui';
import { useI18n, reason } from '../i18n';

// Kendali manual posisi cermin. "Ambil alih": bot berhenti mengelola posisi ini (tidak
// ikut keluar/tambah target, tanpa SL/TP/umur/luar rentang). "Kembalikan": ikut target
// lagi — hanya selama posisi target itu masih terbuka di chain, diperiksa sebelum konfirmasi.
export default function TakeoverButton({ p, reload, disabled = false, size = 'sm', compact = false }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!p?.target || !p?.mirror_of || p.empty) return null;
  const pair = `${p.symbol0}/${p.symbol1}`;
  const manual = p.takeover_ts != null;

  const takeover = async () => {
    const ok = await ask({
      title: t('Ambil alih posisi {pair}?', { pair }),
      body: (
        <div className="flex flex-col gap-2">
          <p>{t('Bot berhenti mengelola posisi ini:')}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t('tidak ikut menutup atau menarik sebagian saat target keluar dari posisi #{id};', { id: p.mirror_of })}</li>
            <li>{t('tidak ikut menambah saat target menambah;')}</li>
            <li>{t('stop loss, take profit, batas umur, dan di luar rentang tidak berlaku.')}</li>
          </ul>
          <p>{t('Posisi hanya ditutup kalau kamu menutupnya. Bisa dikembalikan ke otomatis selama posisi target masih terbuka.')}</p>
        </div>
      ),
      confirm: t('Ambil alih'),
    });
    if (!ok) return;
    setBusy(true);
    const r = await post('/api/positions/takeover', { id: p.id }).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (r.error) return toast.danger(t('Gagal mengambil alih {pair}', { pair }), { description: reason(r.error) });
    toast.success(t('{pair} dalam kendali manual', { pair }));
    reload?.();
  };

  const handBack = async () => {
    setBusy(true);
    const info = await get(`/api/positions/handback?id=${p.id}`).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (info.error) return toast.danger(reason(info.error));
    if (info.targetOpen === false) {
      return toast.danger(t('Tidak bisa dikembalikan'), {
        description: t('Target sudah menutup posisi #{id} — tidak ada yang bisa diikuti lagi. Posisi ini tetap manual; tutup sendiri kalau sudah waktunya.', { id: info.tokenId }),
        timeout: 12000,
      });
    }
    if (info.targetOpen == null) return toast.warning(t('Status posisi target tidak terbaca dari RPC — coba lagi sebentar'));
    const e = info.exit;
    const rules = [
      e.followTarget && (e.followPartial
        ? t('ikut ditutup saat target menutup posisi #{id}, dan ikut ditarik sebagian;', { id: info.tokenId })
        : t('ikut ditutup saat target menutup posisi #{id};', { id: info.tokenId })),
      t('ikut menambah saat target menambah (sesuai aturan);'),
      e.stopLossPct > 0 && t('stop loss di −{n}%;', { n: e.stopLossPct }),
      e.takeProfitPct > 0 && t('take profit di +{n}%;', { n: e.takeProfitPct }),
      e.maxAgeHours > 0 && t('ditutup setelah berumur {n} jam;', { n: e.maxAgeHours }),
      e.outOfRangeMinutes > 0 && t('ditutup setelah {n} menit di luar rentang;', { n: e.outOfRangeMinutes }),
      e.outOfRangePct > 0 && t('ditutup kalau harga lebih dari {n}% di luar rentang;', { n: e.outOfRangePct }),
      e.outOfRangePct > 0 && e.reenterWithinPct > 0 && t('dibuka lagi kalau harga kembali ≤ {n}% dari rentang dan target masih di dalam;', { n: e.reenterWithinPct }),
    ].filter(Boolean);
    const ok = await ask({
      title: t('Kembalikan {pair} ke otomatis?', { pair }),
      body: (
        <div className="flex flex-col gap-2">
          <p>{t('Posisi target #{id} masih terbuka. Bot kembali mengelola posisi ini:', { id: info.tokenId })}</p>
          <ul className="list-disc space-y-1 pl-5">{rules.map((x) => <li key={x}>{x}</li>)}</ul>
          <p>{t('Aksi target selama kendali manual tidak disusulkan — hanya aksi berikutnya yang diikuti. Stop loss / take profit langsung dinilai di sinkron berikutnya (±30 detik).')}</p>
        </div>
      ),
      confirm: t('Kembalikan'),
    });
    if (!ok) return;
    setBusy(true);
    const r = await post('/api/positions/handback', { id: p.id }).catch((err) => ({ error: err.message }));
    setBusy(false);
    if (r.error) return toast.danger(t('Gagal mengembalikan {pair}', { pair }), { description: reason(r.error), timeout: 12000 });
    toast.success(t('{pair} kembali mengikuti target', { pair }));
    reload?.();
  };

  const label = manual ? t('Kembalikan ke otomatis') : t('Ambil alih posisi');
  const Icon = manual ? Undo2 : Hand;
  const run = manual ? handBack : takeover;
  // Ringkas = lambang saja (lihat AutoCompoundButton); di laci & halaman detail
  // tombolnya tetap berlabel, karena di sana ruangnya ada dan konteksnya perlu.
  return compact
    ? <Button size={size} variant="tertiary" isIconOnly isPending={busy} isDisabled={disabled || busy} onPress={run}
      aria-label={label} title={label}><Icon className="size-4" /></Button>
    : <Button size={size} variant="outline" isPending={busy} isDisabled={disabled || busy} onPress={run}>
      <Icon className="size-3.5" />{manual ? t('Kembalikan') : t('Ambil alih')}</Button>;
}
