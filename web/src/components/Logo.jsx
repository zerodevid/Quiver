// Tanda Quiver: tabung anak panah hijau Sherwood berisi tiga anak panah emas.
// Sumber gambar yang sama dengan public/favicon.svg — kalau salah satu diubah,
// ubah keduanya. Warna dibuat tetap (bukan currentColor) supaya tanda ini
// konsisten di tema terang maupun gelap.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <g transform="rotate(-12 16 16)">
        <g stroke="#E9B949" strokeWidth="2.2" strokeLinecap="round">
          <line x1="12" y1="15" x2="12" y2="7.5" />
          <line x1="16" y1="15" x2="16" y2="4.5" />
          <line x1="20" y1="15" x2="20" y2="8.5" />
        </g>
        <g fill="#E9B949">
          <path d="M12 3.5 L14.6 8 H9.4 Z" />
          <path d="M16 0.5 L18.6 5 H13.4 Z" />
          <path d="M20 4.5 L22.6 9 H17.4 Z" />
        </g>
        <rect x="9.5" y="12.5" width="13" height="19" rx="3" fill="#1E6B47" />
        <rect x="9.5" y="16" width="13" height="2.2" fill="#14503A" />
        <rect x="9.5" y="27" width="13" height="2.2" fill="#14503A" />
      </g>
    </svg>
  );
}
