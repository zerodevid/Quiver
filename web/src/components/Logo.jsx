// Tanda Quiver: monogram Q emas di lencana hijau hutan, dua warna solid. Lingkarannya
// mulut quiver dilihat dari atas; ekor Q-nya ujung berbulu (fletching) anak panah di
// dalamnya. Gambar yang sama dengan public/favicon.svg — kalau salah satu diubah, ubah
// keduanya. Warna tetap (bukan currentColor) supaya konsisten di kedua tema.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#14382A" />
      <g fill="none" stroke="#D9AE45" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="30" cy="30" r="15" />
        <path d="M36 36 L51.5 51.5" />
        <path d="M45.5 45.5 L46.5 52.5 M45.5 45.5 L52.5 46.5" />
      </g>
    </svg>
  );
}
