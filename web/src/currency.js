// Mata uang kedua: nilai yang sama dengan angka dolar di sebelahnya, ditulis kecil.
//
// Dolar tetap angka utamanya — itu satuan mesin, harga pool, dan semua perhitungan
// PnL, dan menukar keduanya akan membuat dua halaman yang sama terbaca berbeda hanya
// karena kurs bergerak. Yang ditambahkan cuma rasa besaran buat yang tidak berpikir
// dalam dolar: "$1.234,56  ≈ Rp22 jt".
//
// Kurs datang dari server lewat /api/overview (lihat src/fx.js) setiap poll, sama
// seperti identitas chain — tidak ada permintaan jaringan dari peramban di sini.
import { useEffect, useState } from 'react';
import { getLocale } from './i18n';

let current = null;          // { currency, rate, at, stale } atau null = dolar saja
const listeners = new Set();

export function setFx(next) {
  const v = next && next.rate > 0 ? { currency: next.currency, rate: next.rate, at: next.at || null, stale: !!next.stale } : null;
  // Poll tiap 5 detik: hanya kabari komponen kalau angkanya benar-benar berubah.
  if (current?.currency === v?.currency && current?.rate === v?.rate) return;
  current = v;
  listeners.forEach((f) => f(current));
}
export const fxInfo = () => current;

// Komponen ikut tergambar ulang saat kurs atau mata uang berganti.
export function useFx() {
  const [v, setV] = useState(current);
  useEffect(() => {
    const f = (x) => setV(x);
    listeners.add(f);
    f(current);
    return () => listeners.delete(f);
  }, []);
  return v;
}

// Nilai dolar -> teks mata uang kedua, atau null kalau tidak ada yang perlu ditulis.
// Di bawah setengah sen tidak ada isinya ("Rp0" cuma menambah coretan), dan nominal
// jutaan dipersingkat ("Rp22,4 jt") karena ini keterangan, bukan kuitansi.
export function fxFormat(v, fx = current) {
  if (!fx || !(fx.rate > 0) || v == null || !Number.isFinite(v)) return null;
  if (Math.abs(v) < 0.005) return null;
  const n = v * fx.rate;
  const abs = Math.abs(n);
  const loc = getLocale() === 'en' ? 'en-US' : 'id-ID';
  // minimumFractionDigits wajib ikut diisi: bawaan gaya "currency" adalah 2, dan
  // Intl melempar RangeError kalau minimum lebih besar daripada maksimum.
  const o = { style: 'currency', currency: fx.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 };
  if (abs >= 1e6) { o.notation = 'compact'; o.maximumFractionDigits = 1; }
  else if (abs < 100) { o.maximumFractionDigits = 2; }   // mata uang "besar" (EUR, GBP): $1,20 -> €1,03
  let s;
  try { s = new Intl.NumberFormat(loc, o).format(abs); }
  catch { return null; }   // kode mata uang yang tidak dikenal peramban lama
  return (n < 0 ? '−' : '') + s;
}
// Memakai mata uang yang sedang aktif di dasbor.
export const fxText = (v) => fxFormat(v, current);
