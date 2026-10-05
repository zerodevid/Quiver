import { useMemo } from 'react';
import { usePoll } from '../hooks';
import { usd, kUsd } from '../fmt';
import { useI18n } from '../i18n';
import { baseTokenOf } from './ui';
import { canonAddr } from '../chain';

// The copied token's USD price and market cap, so a "-79% from current price" BEP reads
// against how big the token is. DexScreener's priceUsd / marketCap describe the pair's base
// token; when our token is the pair's quote side the price is inverted and the cap is unknown.
export function TokenCell({ pair, p }) {
  const { t } = useI18n();
  if (!pair || pair.error) return <span className="text-muted">—</span>;
  const { px, mc } = tokenFigures(pair, p);
  if (!(px > 0)) return <span className="text-muted">—</span>;
  return (
    <div className="whitespace-nowrap" title={t('Harga dan kapitalisasi pasar token menurut DexScreener.')}>
      {usd(px, px < 0.01 ? 6 : 4)}
      {mc > 0 && <div className="text-xs text-muted">{t('MC {v}', { v: kUsd(mc) })}</div>}
    </div>
  );
}

function tokenFigures(pair, p) {
  const addr = canonAddr(baseTokenOf(p) || '');
  const isBase = pair.base?.address === addr;
  const px = isBase ? pair.priceUsd : pair.priceUsd > 0 && pair.priceNative > 0 ? pair.priceUsd / pair.priceNative : null;
  return { px, mc: isBase ? (pair.marketCap || pair.fdv) : null };
}

// DexScreener stats for the pools of the given positions (one call, memoised per pool on
// the server). Only open positions are fetched: a closed one has no use for today's market.
export function usePairs(rows) {
  const pools = useMemo(() => [...new Set((rows || [])
    .filter((x) => x && !x.empty && (x.status == null || x.status === 'open'))
    .map((x) => canonAddr(x.pool_ref || ''))
    .filter(Boolean))].sort().slice(0, 40), [rows]);
  const { data } = usePoll(pools.length ? `/api/monitor/market?pools=${pools.join(',')}` : null, 60000);
  return (x) => data?.pairs?.[canonAddr(x.pool_ref || '')] || null;
}

// A ready-made DataTable column: price on top, market cap below, sortable by market cap.
export function tokenColumn(pairOf) {
  return {
    key: 'tok', label: 'Harga & MC', align: 'end',
    sort: (x) => { const c = pairOf(x); return c && !c.error ? (tokenFigures(c, x).mc || -1) : -1; },
    render: (x) => <TokenCell pair={pairOf(x)} p={x} />,
  };
}
