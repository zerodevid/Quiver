// Tanda Quiver: wadah panah miring dengan tiga anak panah, dan satu panah tren naik dari
// belakangnya — siluet emas satu warna di lencana arang. Bentuk padat (bukan garis) supaya
// tetap terbaca kecil; garis tipis di badan = bibir wadah (ruang negatif), dan pinggiran
// warna latar memisahkan badan dari batang panah tren. Gambar yang sama dengan
// public/favicon.svg — kalau salah satu diubah, ubah keduanya. Warna tetap (bukan
// currentColor) supaya konsisten di kedua tema.
export function QuiverMark({ className = 'size-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#1F2329" />
      <g transform="translate(32 32) rotate(45) scale(0.76) translate(-29.375 -25.5)">
        <path d="M37.25 64 L37.25 5.5" stroke="#D9AE45" strokeWidth="7.5" strokeLinecap="round" fill="none" />
        <path d="M25.75 7.5 L37.25 -7 L48.75 7.5 Z" fill="#D9AE45" />
        <g fill="#1F2329" stroke="#1F2329" strokeWidth="5.2" strokeLinejoin="round">
          <rect x="10" y="30" width="24" height="28" rx="5.5" />
        </g>
        <g fill="#D9AE45">
          <rect x="10" y="30" width="24" height="28" rx="5.5" />
          <path d="M15 15 L10.8 20.5 L15 25 L19.2 20.5 Z" />
          <path d="M22.0 6 L17.8 11.5 L22.0 16 L26.2 11.5 Z" />
          <path d="M29 10 L24.8 15.5 L29 20 L33.2 15.5 Z" />
        </g>
        <g stroke="#D9AE45" fill="none">
          <path d="M15 33 L15 22" strokeWidth="3.4" strokeLinecap="round" />
          <path d="M22.0 33 L22.0 13" strokeWidth="3.4" strokeLinecap="round" />
          <path d="M29 33 L29 17" strokeWidth="3.4" strokeLinecap="round" />
        </g>
        <rect x="10" y="36.5" width="24" height="2.6" fill="#1F2329" />
      </g>
    </svg>
  );
}
