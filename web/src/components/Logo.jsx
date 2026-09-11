import { useId } from 'react';

// Tanda Quiver: monogram Q emas di lencana hijau hutan. Lingkarannya mulut quiver
// dilihat dari atas; ekor Q-nya ujung berbulu (fletching) anak panah di dalamnya.
// Gambar yang sama dengan public/favicon.svg — kalau salah satu diubah, ubah
// keduanya. Warna tetap (bukan currentColor) supaya konsisten di kedua tema.
// Id gradien dibuat unik per instans karena Brand dirender dua kali (sidebar +
// kepala HP) di satu halaman.
export function QuiverMark({ className = 'size-7' }) {
  // useId bisa mengandung «» / ':' — tidak aman di dalam url(#…), jadi disaring.
  const id = 'qv' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const bg = `${id}bg`, au = `${id}au`;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#173D2C" /><stop offset="1" stopColor="#0B1F16" /></linearGradient>
        <linearGradient id={au} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F3DC96" /><stop offset="1" stopColor="#C39A2C" /></linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${bg})`} />
      <rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke="#F1D78E" strokeOpacity=".2" />
      <g fill="none" stroke={`url(#${au})`} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="30" cy="30" r="15" />
        <path d="M36 36 L51.5 51.5" />
        <path d="M45.5 45.5 L46.5 52.5 M45.5 45.5 L52.5 46.5" />
      </g>
    </svg>
  );
}
