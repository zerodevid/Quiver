// Tanda Quiver: monogram Q geometris — satu ring, satu ekor pendek yang menembus ring,
// satu bobot garis. Emas di lencana hijau hutan, dua warna solid. Ekornya sengaja pendek
// supaya tidak terbaca sebagai kaca pembesar. Gambar yang sama dengan public/favicon.svg —
// kalau salah satu diubah, ubah keduanya. Warna tetap (bukan currentColor) supaya
// konsisten di kedua tema.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#14382A" />
      <g fill="none" stroke="#D9AE45" strokeWidth="7" strokeLinecap="round">
        <circle cx="31" cy="30" r="16" />
        <path d="M40.5 39.5 L51 50" />
      </g>
    </svg>
  );
}
