// Titik keamanan GMGN di daftar posisi: satu lingkaran kecil di sebelah nama
// pasangan, tanpa teks. Kolom penuh untuk ini akan melebarkan tabel demi angka
// yang jarang berubah; tapi "token ini honeypot" bukan hal yang boleh baru
// terlihat setelah membuka halaman detail. Warnanya menjawab satu pertanyaan —
// aman atau tidak — dan seluruh alasannya muncul saat kursor menyentuhnya.
//
// Ambangnya bukan milik berkas ini: gmgnSignals() di poolHealth.mjs yang sama
// dipakai panel Kesehatan pool, supaya titik hijau di daftar tidak pernah
// berdampingan dengan peringatan merah di halaman detail token yang sama.
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, ShieldAlert, ShieldQuestion, ShieldX } from 'lucide-react';
import { usePoll } from '../hooks';
import { useI18n } from '../i18n';
import { num, price } from '../fmt';
import { gmgnSignals } from '../poolHealth.mjs';

const Ctx = createContext(null);

// Satu panggilan untuk seluruh daftar, bukan satu per baris. Jarang: profil
// keamanan GMGN disimpan 5 menit di server, dan jatah OpenAPI-nya dibagi bertiga
// dengan instance lain di IP yang sama.
export function GmgnProvider({ tokens, children }) {
  const list = useMemo(() => [...new Set((tokens || [])
    .filter(Boolean).map((a) => String(a).toLowerCase()))].sort().slice(0, 25), [tokens]);
  const { data } = usePoll(list.length ? `/api/gmgn/tokens?addresses=${list.join(',')}` : null, 180000);
  // Tanpa API key GMGN seluruh fitur ini tidak ada — bukan titik abu-abu di setiap
  // baris yang tidak pernah berubah warna.
  const value = data?.enabled ? (data.tokens || {}) : null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Perisai, bukan titik: baris ini sudah memuat titik in-range/di-luar, dan dua
// lingkaran kecil berwarna dalam satu baris yang artinya berbeda adalah salah baca
// yang menunggu terjadi. Bentuknya sendiri yang berkata "ini soal keamanan".
const TONE = {
  risk: [ShieldX, 'text-danger', 'Bahaya menurut GMGN'],
  warn: [ShieldAlert, 'text-warning', 'Perlu waspada menurut GMGN'],
  ok: [ShieldCheck, 'text-success', 'Tidak ada tanda bahaya pada yang diperiksa GMGN'],
  unknown: [ShieldQuestion, 'text-muted/70', 'GMGN belum punya cukup data untuk token ini'],
};

// Profil GMGN satu token dari konteks yang sama — untuk panel yang punya ruang
// menampilkan angkanya, bukan cuma perisainya.
export function useGmgn(token) {
  const map = useContext(Ctx);
  if (!map || !token) return null;
  const g = map[String(token).toLowerCase()];
  return g && !g.error ? g : null;
}

export function GmgnDot({ token, className = '' }) {
  const map = useContext(Ctx);
  const { t } = useI18n();
  if (!map) return null;
  const g = token ? map[String(token).toLowerCase()] : null;
  if (!g) return null;
  const { level, signals } = g.error ? { level: 'unknown', signals: [] } : gmgnSignals(g);
  const [Icon, warna, judul] = TONE[level];
  // Isi tooltip: kalimat yang sama dengan panel Kesehatan pool, satu per baris.
  // Angka disisipkan seperti di sana (persen dibulatkan, nilai USD diberi $).
  const isi = signals.map((s) => t(s.key, Object.fromEntries(Object.entries(s.values)
    .map(([k, v]) => [k, k === 'usd' ? '$' + price(Number(v)) : Number.isFinite(Number(v)) ? num(Number(v), 2) : v]))));
  const sec = g.security || {};
  // Titik hijau tanpa keterangan cuma memindahkan pertanyaannya: yang diperiksa apa?
  const diperiksa = level === 'ok' ? [
    sec.honeypot === false ? t('honeypot: tidak') : null,
    Number.isFinite(sec.buyTaxPct) || Number.isFinite(sec.sellTaxPct)
      ? t('pajak beli/jual {b}/{s}%', { b: num(sec.buyTaxPct || 0, 1), s: num(sec.sellTaxPct || 0, 1) }) : null,
    sec.openSource === true ? t('kontrak terverifikasi') : null,
    sec.ownerRenounced === true ? t('owner sudah dilepas') : null,
  ].filter(Boolean) : [];
  const kepala = `GMGN — ${t(judul)}${g.symbol ? ` · ${g.symbol}` : ''}`;
  const kaki = level === 'unknown'
    ? t('Kolom keamanan yang dipakai penilaian belum terisi di GMGN. Belum dinilai bukan berarti aman.')
    : t('Penilaian dari data GMGN, bukan audit kontrak.');
  const butir = [...isi, ...diperiksa];
  // Keterangan untuk pembaca layar & peramban tanpa JS overlay: satu teks datar.
  const datar = [kepala, ...butir.map((x) => `• ${x}`), kaki].join('\n');
  return (
    <Hover className={`${warna} ${className}`} label={datar} isi={
      <>
        <p className="font-medium">{kepala}</p>
        {butir.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {butir.map((x, i) => <li key={i} className="flex gap-1.5"><span aria-hidden>•</span><span>{x}</span></li>)}
          </ul>
        )}
        <p className="mt-1.5 text-muted">{kaki}</p>
      </>
    }>
      <Icon size={13} role="img" aria-label={datar} />
    </Hover>
  );
}

// Tooltip sendiri, bukan `title` bawaan peramban. Alasannya waktu: peramban menahan
// title ~1–1,5 detik, dan seluruh isi indikator ini ADA di dalam tooltip-nya —
// perisainya sendiri cuma warna. Menunggu satu setengah detik untuk tahu kenapa
// sebuah token ditandai merah terasa seperti halaman yang macet.
//
// Digambar lewat portal ke <body> dengan position:fixed: perisainya duduk di dalam
// tabel yang bisa digulir mendatar, dan kotak yang digambar di dalam kotak bergulir
// akan terpotong di tepinya.
function Hover({ children, isi, label, className = '' }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  const buka = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setBox({ x: r.left + r.width / 2, atas: r.top, bawah: r.bottom });
  };
  return (
    <span ref={ref} className={`inline-flex shrink-0 cursor-help items-center ${className}`}
      tabIndex={0} aria-label={label}
      onMouseEnter={buka} onMouseLeave={() => setBox(null)}
      onFocus={buka} onBlur={() => setBox(null)}>
      {children}
      {box && createPortal(
        // Di atas perisai kalau muat, di bawahnya kalau mepet tepi layar; ujung kiri
        // dan kanan dijaga tetap di dalam viewport supaya tidak ada yang terpotong.
        <div role="tooltip" style={{
          position: 'fixed', zIndex: 9999, left: Math.min(Math.max(box.x, 170), window.innerWidth - 170),
          ...(box.atas > 190 ? { top: box.atas - 8, transform: 'translate(-50%, -100%)' } : { top: box.bawah + 8, transform: 'translateX(-50%)' }),
        }} className="pointer-events-none max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-foreground shadow-lg">
          {isi}
        </div>, document.body)}
    </span>
  );
}
