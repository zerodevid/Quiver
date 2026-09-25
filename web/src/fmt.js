import { chainInfo, ETHERSCAN } from './chain';
import { getLocale, translate as t } from './i18n';

// Semua format angka & waktu mengikuti bahasa yang sedang dipakai:
// Indonesia memakai koma desimal (0,00201), Inggris memakai titik (0.00201).
const loc = () => (getLocale() === 'en' ? 'en-US' : 'id-ID');
export const locale = loc;   // dipakai halaman lain untuk memformat tanggal

export const usd = (v, d = 2) => (v == null || Number.isNaN(v)) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d });
// Angka besar yang cuma perlu dibaca sekilas (volume, likuiditas, MCap). Di atas
// sejuta, satuan 'k' berhenti membantu — "$3200.00k" harus dihitung dulu sebelum
// terbaca sebagai tiga juta.
export const kUsd = (v) => {
  const a = Math.abs(v);
  if (!(a >= 1000)) return usd(v);
  const [d, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
  return (v < 0 ? '−$' : '$') + (a / d).toFixed(2) + unit;
};
export const pct = (v, d = 1) => (v == null ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
export const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(loc(), { maximumFractionDigits: d }));
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
// Penjelajah blok chain yang sedang ditampilkan (Blockscout / BscScan memakai jalur
// /tx dan /address yang sama) — tautan transaksi di riwayat posisi dan aktivitas.
export const txHref = (hash) => (hash ? `${chainInfo().explorer}/tx/${hash}` : null);
export const addrHref = (a) => (a ? `${chainInfo().explorer}/address/${a}` : null);
// Portofolio LP wallet di LPAgent — pembanding luar untuk angka riset kita.
export const lpagentHref = (a) => (a ? `https://app.lpagent.io/portfolio?address=${a}&chain=${chainInfo().key === 'bsc' ? 'BSC' : 'ROBINHOOD'}` : null);
// Isi dompet lintas chain di DeBank: token, posisi DeFi, dan nilainya di semua chain
// sekaligus — yang tidak bisa dilihat dari dasbor ini (satu chain pada satu waktu).
export const debankHref = (a) => (a ? `https://debank.com/profile/${a}` : null);
// Etherscan chain ini (robin.etherscan.io di Robinhood) — indeks tx/token/NFT-nya
// berbeda dari Blockscout, jadi wallet yang di sana kosong sering terbaca di sini.
export const etherscanHref = (a) => (a && ETHERSCAN[chainInfo().key] ? `${ETHERSCAN[chainInfo().key]}/address/${a}` : null);
export const tone = (v) => (v > 0.005 ? 'text-success' : v < -0.005 ? 'text-danger' : '');
export const widthPct = (lo, hi) => (1.0001 ** (hi - lo) - 1) * 100;

// --- imbal hasil fee -------------------------------------------------------
// Pertanyaan yang tidak bisa dijawab kolom "Fee" sendirian: posisi $2.000 yang
// sudah 5 hari menghasilkan $12, dan posisi $300 yang baru 6 jam menghasilkan
// $1,40 — mana yang lebih baik? Fee disetahunkan terhadap modal menyamakan
// keduanya, dan itulah angka yang dipakai LP untuk membandingkan posisi, pool,
// dan lebar rentang.
//
// Umur muda membuat angkanya meledak ($0,10 dalam 2 menit = puluhan ribu persen),
// jadi di bawah dua jam tidak ada APR sama sekali — lebih baik diam daripada memberi
// angka yang akan dibaca sebagai janji. Di atas 999% pun angkanya dipotong (aprText):
// yang diberitahukan bukan "4.812%", melainkan "posisi ini masih terlalu muda".
export function apr(feeUsd, costUsd, ageHours) {
  if (!(costUsd > 0) || !(ageHours >= 2) || !(feeUsd > 0.005)) return null;
  return (feeUsd / costUsd) * (8760 / ageHours) * 100;
}
// Fee posisi = yang belum diklaim + yang sudah ditarik ke wallet. Hanya memakai
// yang belum diklaim akan membuat posisi yang rajin panen tampak tidak produktif.
export const feeApr = (p) => (!p || p.syncing ? null : apr((p.feeUsd || 0) + (p.claimedUsd || 0), p.costUsd, p.ageHours));
// APR gabungan beberapa posisi: tertimbang modal DAN umur (satu posisi besar yang
// baru dibuka tidak boleh menarik turun rata-rata seolah ia sudah lama menganggur).
export function aprOf(rows) {
  let fee = 0, base = 0;
  for (const p of rows || []) {
    if (p.syncing || !(p.costUsd > 0) || !(p.ageHours >= 2)) continue;
    fee += (p.feeUsd || 0) + (p.claimedUsd || 0);
    base += p.costUsd * (p.ageHours / 8760);
  }
  return base > 0 ? (fee / base) * 100 : null;
}
// Tanpa tanda "+": APR bukan perubahan, jadi tidak perlu arah. Dibatasi seperti
// jarak ke tepi rentang — "+4.812%" cuma berarti "posisi ini masih sangat muda".
export const aprText = (v) => (v == null ? '—' : v >= 1000 ? '999+%' : `${num(v, Math.abs(v) < 10 ? 1 : 0)}%`);

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

// Jumlah token: dari satuan terkecil di chain ke satuan tampilan, lalu diformat
// dengan angka penting — token bisa 6 desimal (USDG) atau 18 (kebanyakan sisanya).
export const qty = (raw, dec) => (raw == null ? null : Number(BigInt(String(raw))) / 10 ** (dec ?? 18));
export const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—'
  : v >= 1e6 ? v.toLocaleString(loc(), { maximumFractionDigits: 0 })
    : v.toLocaleString(loc(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));

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
  increase: ['Tambah likuiditas', 'accent'], decrease: ['Kurangi likuiditas', 'warning'], claim_fees: ['Klaim fee', 'success'], compound: ['Auto-compound', 'success'],
  custody_out: ['Titip ke otomasi', 'default'], custody_in: ['Kembali dari otomasi', 'default'],
  transfer_in: ['Terima posisi', 'default'], transfer_out: ['Kirim posisi', 'warning'],
  mint: ['Buka posisi', 'accent'], collect: ['Klaim fee', 'success'], claim: ['Target panen fee', 'default'],
  reentry: ['Buka lagi (harga mendekat)', 'accent'],
};
export const KEPUTUSAN = {
  copy: ['Disalin', 'success'], dry: ['Simulasi', 'accent'], skip: ['Dilewati', 'default'], error: ['Gagal', 'danger'],
};
export const TXKIND = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi', burn: 'Tutup posisi', claim_fees: 'Klaim fee', compound: 'Auto-compound',
  approve_erc20: 'Izin token', approve_permit2: 'Izin Permit2', zap_swap: 'Tukar (zap)',
  bridge_swap: 'Tukar kas', wrap_eth: 'Bungkus ETH', unwrap_weth: 'Buka WETH',
  approve_kyber: 'Izin Kyber', sell_leftover: 'Jual token sisa', swap_manual: 'Swap manual',
};
export const TXSTATUS = { sukses: ['Sukses', 'success'], pending: ['Menunggu', 'warning'], gagal: ['Gagal', 'danger'] };
