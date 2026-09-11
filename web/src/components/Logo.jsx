// Tanda Quiver: siluet wadah panah yang miring dengan tiga anak panah mencuat, emas di
// lencana arang, dua warna solid. Garis tipis di badan = bibir wadah (ruang negatif).
// Gambar yang sama dengan public/favicon.svg — kalau salah satu diubah, ubah keduanya.
// Warna tetap (bukan currentColor) supaya konsisten di kedua tema.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#1F2329" />
      <g transform="rotate(-18 32 32)">
        <rect x="19.5" y="30" width="25" height="27" rx="6" fill="#D9AE45" />
        <rect x="19.5" y="36.5" width="25" height="2.8" fill="#1F2329" />
        <g stroke="#D9AE45" strokeWidth="3.6" strokeLinecap="round">
          <path d="M25.5 33 L25.5 16" />
          <path d="M32 33 L32 10.5" />
          <path d="M38.5 33 L38.5 13.5" />
        </g>
        <g fill="#D9AE45">
          <path d="M20.7 17 L25.5 11 L30.3 17 Z" />
          <path d="M27.2 11.5 L32 5.5 L36.8 11.5 Z" />
          <path d="M33.7 14.5 L38.5 8.5 L43.3 14.5 Z" />
        </g>
      </g>
    </svg>
  );
}
