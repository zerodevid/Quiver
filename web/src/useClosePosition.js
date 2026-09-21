import { useState } from 'react';
import { toast } from '@heroui/react';
import { post } from './api';
import { ask } from './components/ui';
import { muteClose } from './components/TargetAlerts';
import { usd, short } from './fmt';
import { useI18n } from './i18n';

// Alur tutup posisi dari dasbor, dipakai halaman daftar dan detail. Server baru
// membalas setelah transaksinya benar-benar diterima di chain (bisa ~1 menit),
// jadi selama itu tombolnya berputar dan toast "sedang menutup" tetap tampil.
// Hasilnya ada tiga, bukan dua: tertutup, gagal (server menjawab dengan alasan),
// atau belum pasti — koneksi putus / proxy memotong permintaan yang lama sebelum
// server sempat menjawab, padahal transaksinya bisa saja tetap masuk.
export function useClosePosition(reload) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(null);   // id posisi yang sedang ditutup
  // Satu posisi: kirim permintaan, tunggu chain, laporkan lewat toast. Dipakai
  // baik oleh tutup satu maupun tutup semua; konfirmasinya ada di pemanggil.
  const run = async (p) => {
    const pair = `${p.symbol0}/${p.symbol1}`;
    setClosing(p.id);
    muteClose(p.id);   // toast hasilnya dari alur ini; umpan peringatan jangan mengulang
    const wait = toast(t('Menutup posisi {pair}…', { pair }), {
      description: t('Menunggu konfirmasi di chain, bisa sampai 1–2 menit.'), isLoading: true, timeout: 0,
    });
    let r;
    try { r = await post('/api/positions/close', { id: p.id }); }
    catch (e) { r = { error: e.message, lost: true }; }
    toast.close(wait);
    if (r.lost || /^HTTP 5\d\d$/.test(r.error || '')) {
      toast.warning(t('Status penutupan {pair} belum pasti', { pair }), {
        description: t('Koneksi ke server terputus sebelum ada jawaban. Transaksinya mungkin tetap diproses — cek lagi posisinya sebentar lagi.'),
        timeout: 15000,
      });
    } else if (r.error) {
      toast.danger(t('Gagal menutup {pair}', { pair }), { description: r.error, timeout: 12000 });
    } else {
      const parts = [
        r.outUsd != null && t('Diterima {v}', { v: usd(r.outUsd) }),
        r.pnlUsd != null && `PnL ${r.pnlUsd >= 0 ? '+' : ''}${usd(r.pnlUsd)}`,
        r.sold,
        r.tx && `tx ${short(r.tx)}`,
      ].filter(Boolean);
      toast.success(t('Posisi {pair} ditutup', { pair }), { description: parts.join(' · '), timeout: 10000 });
    }
    return r;
  };
  const close = async (p) => {
    if (closing != null) return;
    const pair = `${p.symbol0}/${p.symbol1}`;
    const ok = await ask({
      title: t('Tutup posisi {pair}?', { pair }),
      body: p.feeUsd > 0.005
        ? t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(p.valueUsd), f: usd(p.feeUsd) })
        : t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v}.', { v: usd(p.valueUsd) }),
      confirm: t('Tutup posisi'), danger: true,
    });
    if (!ok) return;
    await run(p);
    setClosing(null);
    reload?.();
  };
  // Semua posisi dalam daftar, satu per satu — bukan paralel, supaya nonce wallet
  // tidak saling salip dan kalau satu gagal yang lain tetap dicoba. Satu konfirmasi
  // untuk semuanya; hasil tiap posisi tetap dilaporkan sendiri-sendiri.
  const closeAll = async (list) => {
    if (closing != null || !list?.length) return;
    const value = list.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const fee = list.reduce((s, p) => s + (p.feeUsd || 0), 0);
    const ok = await ask({
      title: t('Tutup semua {n} posisi terbuka?', { n: list.length }),
      body: fee > 0.005
        ? t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(value), f: usd(fee) })
        : t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v}.', { v: usd(value) }),
      confirm: t('Tutup semua'), danger: true,
    });
    if (!ok) return;
    for (const p of list) {
      await run(p);
      reload?.();   // tabel menyusut selagi sisanya masih berjalan
    }
    setClosing(null);
    reload?.();
  };
  return { close, closeAll, closing };
}
