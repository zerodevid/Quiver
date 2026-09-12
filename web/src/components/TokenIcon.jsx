// Lambang token.
//
// Logo aset kuotasi (USDG/ETH/WETH) ada di web/public/tokens/ — muncul di hampir
// setiap pasangan, jadi dimuat tanpa menunggu siapa pun. Logo token lain diambil
// server dari GeckoTerminal lalu disajikan dari origin dasbor sendiri
// (/api/icon?a=0x…, lihat src/icons.js): browser tidak pernah memanggil pihak
// ketiga, jadi tidak ada yang tahu token apa yang sedang dilihat.
//
// Selama logonya belum ada (baru diambil, atau memang tidak punya), yang tampil
// lambang yang dibangkitkan dari alamat: warnanya selalu sama untuk alamat yang
// sama, sehingga tetap bisa dikenali sekilas. Logo asli menimpanya begitu termuat,
// tanpa menggeser tata letak.
import { useEffect, useState } from 'react';

const ZERO = '0x0000000000000000000000000000000000000000';

export const KNOWN = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': '/tokens/usdg.png',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': '/tokens/weth.png',
  '0x0000000000000000000000000000000000000000': '/tokens/eth.svg',
};

// Rona warna diturunkan dari alamat — stabil, tersebar rata, dan tidak pernah
// menghasilkan warna yang bentrok dengan makna hijau/merah untung-rugi.
export function hue(addr = '') {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
// Rute halaman detail token; null kalau alamatnya tidak dikenal (tidak ditautkan).
export const tokenHref = (address) => {
  const a = (address || '').toLowerCase();
  return isAddr(a) ? `#token/${a}` : null;
};

// Klik pada token di dalam baris yang bisa diklik (mis. tombol pilih pool) tidak
// boleh ikut memicu aksi baris itu.
const stop = (e) => e.stopPropagation();

// Lambang token; `link` menjadikannya tautan ke halaman detail token.
export default function TokenIcon({ link = false, ...props }) {
  const href = link ? tokenHref(props.address) : null;
  if (!href) return <Icon {...props} />;
  return (
    <a href={href} onClick={stop} aria-label={props.symbol || props.address} className={`inline-flex shrink-0 rounded-full transition-opacity hover:opacity-80 ${props.className || ''}`}>
      <Icon {...props} className="" />
    </a>
  );
}

function Icon({ address, symbol, size = 20, className = '' }) {
  const a = (address || '').toLowerCase();
  const local = KNOWN[a];
  // coba → (gagal) tunggu → ulang → (gagal lagi) henti. Server mungkin masih mengambil.
  const [phase, setPhase] = useState('coba');
  const [loaded, setLoaded] = useState(false);
  const style = { width: size, height: size };
  const h = hue(a);
  const initials = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

  // Pengambilan pertama di server bisa melewati batas tunggunya saat puluhan logo
  // diminta sekaligus — satu kali coba ulang beberapa detik kemudian menangkapnya.
  useEffect(() => {
    if (phase !== 'tunggu') return;
    const id = setTimeout(() => setPhase('ulang'), 8000);
    return () => clearTimeout(id);
  }, [phase]);

  const src = local || (/^0x[0-9a-f]{40}$/.test(a) && a !== ZERO ? `/api/icon?a=${a}${phase === 'ulang' ? '&r=1' : ''}` : null);
  const showImg = src && (phase === 'coba' || phase === 'ulang');

  return (
    <span style={{ ...style, background: loaded ? 'var(--surface)' : `oklch(0.62 0.11 ${h})`, fontSize: Math.round(size * 0.4) }}
      title={symbol || ''}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold leading-none text-white ring-1 ring-border ${className}`}>
      {!loaded && initials}
      {showImg && (
        <img src={src} alt="" loading="lazy" decoding="async" style={style}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setPhase((f) => (f === 'coba' && !local ? 'tunggu' : 'henti')); }}
          className={`absolute inset-0 rounded-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`} />
      )}
    </span>
  );
}

// Sepasang lambang yang saling menindih — lazim untuk pasangan pool. Tiap lambang
// menaut ke halaman detail tokennya sendiri.
export function TokenPair({ token0, token1, symbol0, symbol1, size = 20, link = true }) {
  return (
    <span className="flex shrink-0 items-center" style={{ paddingRight: size * 0.35 }}>
      <TokenIcon link={link} address={token0} symbol={symbol0} size={size} />
      <TokenIcon link={link} address={token1} symbol={symbol1} size={size} className="-ml-2" />
    </span>
  );
}

// Simbol token sebagai tautan ke detail token. Tanpa alamat: teks biasa.
export function TokenSym({ address, symbol, className = '' }) {
  const href = tokenHref(address);
  const label = symbol || (address ? address.slice(0, 6) + '…' : '?');
  if (!href) return <span className={className}>{label}</span>;
  return <a href={href} onClick={stop} className={`hover:underline ${className}`}>{label}</a>;
}

// Rute halaman detail pool: v4 = poolId (32 byte), v3 = alamat pool.
export const poolHref = (ref) => {
  const r = (ref || '').toLowerCase();
  return /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(r) ? `#pool/${r}` : null;
};

// "USDG / OPAI". Dengan `pool`, pasangan itu satu tautan ke halaman pool-nya (seperti
// halaman pair DexScreener); tanpa pool, tiap simbol menaut ke tokennya sendiri.
export function PairName({ token0, token1, symbol0, symbol1, pool, sep = ' / ', className = '' }) {
  const href = poolHref(pool);
  if (href) {
    return (
      <a href={href} onClick={stop} className={`whitespace-nowrap hover:underline ${className}`}>
        {symbol0 || '?'}{sep}{symbol1 || '?'}
      </a>
    );
  }
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <TokenSym address={token0} symbol={symbol0} />{sep}<TokenSym address={token1} symbol={symbol1} />
    </span>
  );
}
