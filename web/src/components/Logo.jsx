// Tanda Quiver: monogram Q emas di lencana hijau hutan, dua warna solid. Lingkarannya
// mulut quiver dilihat dari atas; tiga ekor berbulu (fletching) anak panah mengipas
// keluar darinya. Gambar yang sama dengan public/favicon.svg — kalau salah satu diubah,
// ubah keduanya. Warna tetap (bukan currentColor) supaya konsisten di kedua tema.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#14382A" />
      <g fill="none" stroke="#D9AE45" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24.5" cy="24.5" r="13.5" />
        <path d="M32.1 27 L51.6 33.3 M51.6 33.3 L57.6 30.9 M51.6 33.3 L55 38.8" />
        <path d="M30.2 30.2 L44.7 44.7 M44.7 44.7 L51.1 45.2 M44.7 44.7 L45.2 51.1" />
        <path d="M27 32.1 L33.3 51.6 M33.3 51.6 L38.8 55 M33.3 51.6 L30.9 57.6" />
      </g>
    </svg>
  );
}
