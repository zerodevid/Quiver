// Token icon.
//
// Quote asset logos (USDG/ETH/WETH) live in web/public/tokens/ — they appear on almost
// every pair, so they load without waiting for anyone. Other tokens' logos are fetched by
// the server from GeckoTerminal and then served from the dashboard's own origin
// (/api/icon?a=0x…, see src/icons.js): the browser never calls a third
// party, so nobody learns which token is being viewed.
//
// While the logo does not exist yet (just fetched, or it has none), what shows is
// an icon generated from the address: its colour is always the same for the same
// address, so it can still be recognised at a glance. The real logo overwrites it once loaded,
// without shifting the layout.
import { useEffect, useState } from 'react';
import { isAddr, isPoolRef, canonAddr } from '../chain';

const ZERO = '0x0000000000000000000000000000000000000000';

export const KNOWN = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': '/tokens/usdg.png',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': '/tokens/weth.png',
  '0x0000000000000000000000000000000000000000': '/tokens/eth.svg',
};

// Colour hue is derived from the address — stable, evenly spread, and never
// produces a colour that clashes with the green/red meaning of profit/loss.
export function hue(addr = '') {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

// Route of the token detail page; null if the address is unknown (not linked).
export const tokenHref = (address) => {
  const a = canonAddr(address);
  return isAddr(a) ? `#token/${a}` : null;
};

// A click on a token inside a clickable row (e.g. a pool picker button) must
// not also trigger that row's action.
const stop = (e) => e.stopPropagation();

// Token icon; `link` turns it into a link to the token detail page.
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
  const a = canonAddr(address);
  const local = KNOWN[a];
  // try → (fail) wait → retry → (fail again) stop. The server may still be fetching.
  const [phase, setPhase] = useState('coba');
  const [loaded, setLoaded] = useState(false);
  const style = { width: size, height: size };
  const h = hue(a);
  const initials = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

  // The first fetch on the server can exceed its wait limit when dozens of logos
  // are requested at once — a single retry a few seconds later catches it.
  useEffect(() => {
    if (phase !== 'tunggu') return;
    const id = setTimeout(() => setPhase('ulang'), 8000);
    return () => clearTimeout(id);
  }, [phase]);

  const src = local || (isAddr(a) && a !== ZERO ? `/api/icon?a=${a}${phase === 'ulang' ? '&r=1' : ''}` : null);
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

// A pair of icons overlapping each other — usual for a pool pair. Each icon
// links to its own token detail page.
export function TokenPair({ token0, token1, symbol0, symbol1, size = 20, link = true }) {
  return (
    <span className="flex shrink-0 items-center" style={{ paddingRight: size * 0.35 }}>
      <TokenIcon link={link} address={token0} symbol={symbol0} size={size} />
      <TokenIcon link={link} address={token1} symbol={symbol1} size={size} className="-ml-2" />
    </span>
  );
}

// Token symbol as a link to the token detail. Without an address: plain text.
export function TokenSym({ address, symbol, className = '' }) {
  const href = tokenHref(address);
  const label = symbol || (address ? address.slice(0, 6) + '…' : '?');
  if (!href) return <span className={className}>{label}</span>;
  return <a href={href} onClick={stop} className={`hover:underline ${className}`}>{label}</a>;
}

// Route of the pool detail page: v4 = poolId (32 bytes), v3 = pool address.
export const poolHref = (ref) => {
  const r = canonAddr(ref);
  return isPoolRef(r) ? `#pool/${r}` : null;
};

// "USDG / OPAI". With `pool`, the pair is a single link to its pool page (like a
// DexScreener pair page); without a pool, each symbol links to its own token.
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
