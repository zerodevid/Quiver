// Lambang token.
//
// Logo asli hanya tersedia untuk aset kuotasi (USDG/ETH/WETH) — dan justru itulah
// yang muncul di hampir setiap pasangan. Berkasnya disajikan dari server sendiri,
// bukan dari CDN pihak ketiga: server produksi diblokir Cloudflare saat mengambil
// metadata token, dan memuat gambar dari luar akan membocorkan token apa yang sedang
// dilihat.
//
// Token lain (memecoin) memang tidak punya logo di mana pun, jadi dipakai lambang
// yang dibangkitkan dari alamatnya: warnanya selalu sama untuk alamat yang sama,
// sehingga tetap bisa dikenali sekilas.
import { useState } from 'react';

const KNOWN = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': '/tokens/usdg.png',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': '/tokens/weth.png',
  '0x0000000000000000000000000000000000000000': '/tokens/eth.svg',
};

// Rona warna diturunkan dari alamat — stabil, tersebar rata, dan tidak pernah
// menghasilkan warna yang bentrok dengan makna hijau/merah untung-rugi.
function hue(addr = '') {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

export default function TokenIcon({ address, symbol, size = 20, className = '' }) {
  const [failed, setFailed] = useState(false);
  const a = (address || '').toLowerCase();
  const src = KNOWN[a];
  const style = { width: size, height: size };

  if (src && !failed) {
    return (
      <img src={src} alt={symbol || ''} title={symbol || ''} style={style} loading="lazy"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-surface ring-1 ring-border ${className}`} />
    );
  }
  const h = hue(a);
  const initials = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return (
    <span
      style={{ ...style, background: `oklch(0.62 0.11 ${h})`, fontSize: Math.round(size * 0.4) }}
      title={symbol || ''}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white ring-1 ring-border ${className}`}>
      {initials}
    </span>
  );
}

// Sepasang lambang yang saling menindih — lazim untuk pasangan pool.
export function TokenPair({ token0, token1, symbol0, symbol1, size = 20 }) {
  return (
    <span className="flex shrink-0 items-center" style={{ paddingRight: size * 0.35 }}>
      <TokenIcon address={token0} symbol={symbol0} size={size} />
      <TokenIcon address={token1} symbol={symbol1} size={size} className="-ml-2" />
    </span>
  );
}
