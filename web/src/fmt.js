import { getLocale, translate as t } from './i18n';

// Semua format angka & waktu mengikuti bahasa yang sedang dipakai:
// Indonesia memakai koma desimal (0,00201), Inggris memakai titik (0.00201).
const loc = () => (getLocale() === 'en' ? 'en-US' : 'id-ID');
export const locale = loc;   // dipakai halaman lain untuk memformat tanggal

export const usd = (v, d = 2) => (v == null || Number.isNaN(v)) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d });
export const kUsd = (v) => (Math.abs(v) >= 1000 ? (v < 0 ? '−$' : '$') + (Math.abs(v) / 1000).toFixed(2) + 'k' : usd(v));
export const pct = (v, d = 1) => (v == null ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
export const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(loc(), { maximumFractionDigits: d }));
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
// Penjelajah blok Robinhood Chain — tautan transaksi di riwayat posisi dan aktivitas.
export const txHref = (hash) => (hash ? `https://robinhoodchain.blockscout.com/tx/${hash}` : null);
export const tone = (v) => (v > 0.005 ? 'text-success' : v < -0.005 ? 'text-danger' : '');
export const widthPct = (lo, hi) => (1.0001 ** (hi - lo) - 1) * 100;

// Harga token bisa 0,00000032 sampai 4.200 — jadi pakai angka penting, bukan
// jumlah desimal tetap (0,00 tidak memberi tahu apa pun).
export function price(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  // Di atas satu miliar angka penuhnya (337.815.857.900.711…) cuma merusak lebar
  // kolom tabel; notasi ilmiah lebih jujur untuk harga token sampah semacam itu.
  if (p >= 1e9) return p.toExponential(2).replace('.', loc() === 'id-ID' ? ',' : '.');
  if (p >= 1e6) return p.toLocaleString(loc(), { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(loc(), { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(loc(), { maximumSignificantDigits: 3 });
  return p.toExponential(2).replace('.', loc() === 'id-ID' ? ',' : '.');
}

// Harga dari sqrtPriceX96 (state pool yang tersimpan per kejadian).
export function sqrtPrice(sqrtX96, dec0, dec1, quoteSide) {
  if (!sqrtX96) return null;
  const r = Number(sqrtX96) / 2 ** 96;
  const p1per0 = r * r * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}

// Harga token spekulatif dalam aset kuotasi pool, dari nomor tick.
// quoteSide 0 = token0 yang jadi kuotasi -> harga token1 adalah kebalikan tick.
export function tickPrice(tick, dec0, dec1, quoteSide) {
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}
export function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t('{n} dtk lalu', { n: Math.max(1, Math.round(s)) });
  if (s < 3600) return t('{n} mnt lalu', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} jam lalu', { n: (s / 3600).toFixed(1) });
  return t('{n} hari lalu', { n: (s / 86400).toFixed(1) });
}
export const age = (h) => (h == null ? '—'
  : h < 1 ? t('{n} mnt', { n: Math.round(h * 60) })
    : h < 24 ? t('{n} jam', { n: h.toFixed(1) })
      : t('{n} hari', { n: (h / 24).toFixed(1) }));
export const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? t('{n} dtk', { n: s }) : t('{n} mnt {s} dtk', { n: Math.floor(s / 60), s: s % 60 });
};

// Label yang dipakai berulang di beberapa tabel. Nilai kedua = warna chip.
export const AKSI = {
  increase: ['Tambah likuiditas', 'accent'], decrease: ['Kurangi likuiditas', 'warning'],
  custody_out: ['Titip ke otomasi', 'default'], custody_in: ['Kembali dari otomasi', 'default'],
  transfer_in: ['Terima posisi', 'default'], transfer_out: ['Kirim posisi', 'warning'],
  mint: ['Buka posisi', 'accent'], collect: ['Klaim fee', 'success'],
};
export const KEPUTUSAN = {
  copy: ['Disalin', 'success'], dry: ['Simulasi', 'accent'], skip: ['Dilewati', 'default'], error: ['Gagal', 'danger'],
};
export const TXKIND = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi', burn: 'Tutup posisi',
  approve_erc20: 'Izin token', approve_permit2: 'Izin Permit2', zap_swap: 'Tukar (zap)',
  bridge_swap: 'Tukar kas', wrap_eth: 'Bungkus ETH', unwrap_weth: 'Buka WETH',
  approve_kyber: 'Izin Kyber', sell_leftover: 'Jual token sisa', swap_manual: 'Swap manual',
};
export const TXSTATUS = { sukses: ['Sukses', 'success'], pending: ['Menunggu', 'warning'], gagal: ['Gagal', 'danger'] };
