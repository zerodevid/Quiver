// Small components used repeatedly. All assembled from HeroUI components;
// no new visual style outside the HeroUI theme tokens.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Chip, EmptyState, Label, Description, FieldError, TextField, Input, Select, ListBox,
  Switch, Table, Spinner, Alert, Pagination, AlertDialog, Button,
} from '@heroui/react';
import { Inbox, Search, ArrowLeft, ArrowUpRight, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import { price, tickPrice, sqrtPrice, widthPct, pct, short, txHref, addrHref, debankHref, lpagentHref, etherscanHref, ago } from '../fmt';
import { breakEven } from '../breakeven';
import { useTick } from '../hooks';
import { translate as t } from '../i18n';
import { useFx, fxText } from '../currency';
import { chainInfo, CHAIN_ICON, EXPLORER_NAME } from '../chain';

export function PageHeader({ group, title, desc, children }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border pb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{t(title)}</h1>
        {desc && <p className="mt-1 max-w-prose text-sm text-muted">{t(desc)}</p>}
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// The main figure. A small label on top, a large value, a note below — without
// ALL CAPS, which on four cards side by side turns into shouting.
// `badge` = a small marker beside the label (e.g. APR, in-range status):
// a property of the figure, not a second figure competing with the main one.
export function Stat({ label, value, sub, fx = null, valueClass = '', badge = null, className = '' }) {
  return (
    <Card className={`min-w-0 gap-1.5! p-3.5! ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-medium text-muted">{t(label)}</div>
        {badge}
      </div>
      <div className={`num break-words text-lg sm:text-[1.375rem] leading-tight font-semibold tracking-tight ${valueClass}`}>{value}<Fx v={fx} /></div>
      {/* On mobile the tile is half the screen wide: a caption cut to one line
          ("$851,40 out of range — ti…") drops exactly the part that explains it.
          Two lines; the card height stays even because everything shares one grid row. */}
      {sub && <div className="line-clamp-2 text-xs text-muted">{typeof sub === 'string' ? t(sub) : sub}</div>}
    </Card>
  );
}

// A small figure inside a panel: label, value, note — three tight rows, without its
// own card. Used in pairs inside the position drawer, where our figure and the
// target's figure stand side by side; a `Stat` tile there would compete with
// the main figure at the drawer's head.
export function Fig({ label, value, sub, cls = '' }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted">{t(label)}</div>
      <div className={`num truncate text-sm font-semibold ${cls}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

// The main figure strip. Four equal-sized tiles make "portfolio total" and
// "win rate" look equally important; yet the first two figures are what the eye looks for
// every time the page opens. Both are raised to a page-wide card with a
// clearly larger font size, the rest drop to tiles below.
export function Hero({ children, className = '' }) {
  return (
    <Card className={`min-w-0 gap-0! p-0! ${className}`}>
      <div className="flex h-full flex-col justify-center gap-4 p-4 sm:gap-5 sm:p-5">{children}</div>
    </Card>
  );
}
export function HeroFigure({ label, value, sub, fx = null, valueClass = '', aside = null, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-muted">{t(label)}</span>
        {aside}
      </div>
      <div className={`num mt-1.5 break-words text-[1.75rem] leading-[1.1] font-semibold tracking-tight sm:text-[2.125rem] ${valueClass}`}>{value}<Fx v={fx} className="text-sm" /></div>
      {sub && <div className="mt-1.5 text-xs text-muted">{typeof sub === 'string' ? t(sub) : sub}</div>}
    </div>
  );
}

// Label/value row — used in all summary panels.
export function KV({ label, children, fx = null, className = '' }) {
  return (
    <div className={`kv-row flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm ${className}`}>
      <span className="min-w-0 text-muted">{t(label)}</span>
      <span className="num min-w-0 max-w-full break-words text-end font-medium">{children}<Fx v={fx} /></span>
    </div>
  );
}

// The same value in the secondary currency (Settings -> Display), attached to the right of
// its dollar figure. Deliberately small and grey: what is read is still the dollars, this is only
// a sense of scale. Without a secondary currency — or for a value that rounds to zero —
// nothing is drawn, so the layout is exactly the same as before.
export function Fx({ v, className = '' }) {
  const fx = useFx();
  const s = fx ? fxText(v) : null;
  if (!s) return null;
  return (
    <span className={`ml-1.5 align-baseline text-xs font-medium whitespace-nowrap text-muted ${className}`}
      title={t('Kurs {r} per USD, diambil otomatis', { r: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(fx.rate) })}>
      ≈ {s}
    </span>
  );
}

// Status dot: calmer than a coloured chip repeated on every row.
export function Dot({ tone = 'default', title }) {
  const c = { success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning', accent: 'bg-accent', default: 'bg-muted' }[tone] || 'bg-muted';
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${c}`} title={title ? t(title) : undefined} />;
}

// Card box with a title — the most frequently used pattern.
export function Panel({ title, desc, action, children, className = '', bodyClass = '' }) {
  return (
    // min-w-0: a grid item defaults to min-width:auto, so long text inside it
    // forces the card wider than a phone screen.
    <Card className={`min-w-0 gap-0! p-0! ${className}`}>
      {(title || action) && (
        <div className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
          <div className="min-w-0 max-w-full">
            {title && <h2 className="text-sm font-semibold tracking-tight">{t(title)}</h2>}
            {desc && <p className="mt-0.5 text-xs text-muted">{t(desc)}</p>}
          </div>
          {/* max-w-full: on mobile the action content (e.g. two Segmented) may wrap instead of breaking out of the card */}
          {action && <div className="max-w-full shrink-0">{action}</div>}
        </div>
      )}
      <div className={bodyClass.includes('p-0') ? bodyClass : `p-4 ${bodyClass}`}>{children}</div>
    </Card>
  );
}

export function Tag({ map, k, fallback }) {
  const v = map?.[k];
  return <Chip size="sm" variant="soft" color={v ? v[1] : 'default'} className="whitespace-nowrap">{v ? t(v[0]) : (fallback ?? k ?? '—')}</Chip>;
}

export function Empty({ title, sub }) {
  return (
    <EmptyState className="flex w-full flex-col items-center justify-center gap-2 py-10 text-center">
      <Inbox className="size-6 text-muted" strokeWidth={1.5} />
      <div className="text-sm font-medium">{t(title)}</div>
      {sub && <div className="max-w-sm text-sm text-muted">{t(sub)}</div>}
    </EmptyState>
  );
}

// Loading skeleton: the shape of the page/panel to come, not a spinning wheel in empty
// space — the eye already knows where to look once the data arrives, and the layout
// does not jump. Appears after 150 ms (the loading-in class) so a fast load
// does not flicker. `page` = the skeleton of a whole page (title, figure tiles, two panels);
// without it = a few rows for panel contents. Text only shows if given
// (e.g. "Reading wallet contents from the chain…" for a process that really is slow); otherwise it
// is only for screen readers.
const Bone = ({ w = '100%', h = '0.75rem', className = '' }) => (
  <div className={`skel ${className}`} style={{ width: w, height: h }} aria-hidden="true" />
);
const ROW_W = ['72%', '88%', '58%', '80%', '66%', '76%'];
const Rows = ({ n = 3 }) => (
  <div className="space-y-3" aria-hidden="true">
    {ROW_W.slice(0, n).map((w, i) => (
      <div key={i} className="flex items-center gap-3">
        <Bone w="1.25rem" h="1.25rem" className="shrink-0 rounded-full!" />
        <Bone w={w} />
        <Bone w="3.5rem" className="ms-auto shrink-0" />
      </div>
    ))}
  </div>
);
export function Loading({ text = null, page = false }) {
  const label = t(text || 'Memuat…');
  if (page) {
    return (
      <div className="loading-in" role="status" aria-live="polite" aria-label={label}>
        <div className="mb-5 border-b border-border pb-4">
          <Bone w="11rem" h="1.25rem" />
          <Bone w="24rem" className="mt-3 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="min-w-0 gap-2! p-3.5!">
              <Bone w="45%" h="0.625rem" />
              <Bone w="70%" h="1.375rem" />
              <Bone w="55%" h="0.625rem" />
            </Card>
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="min-w-0 gap-0! p-0! lg:col-span-2">
            <div className="border-b border-border px-4 py-3.5"><Bone w="9rem" h="0.875rem" /></div>
            <div className="p-4"><Rows n={6} /></div>
          </Card>
          <Card className="min-w-0 gap-0! p-0!">
            <div className="border-b border-border px-4 py-3.5"><Bone w="7rem" h="0.875rem" /></div>
            <div className="p-4"><Rows n={4} /></div>
          </Card>
        </div>
        <span className="sr-only">{label}</span>
      </div>
    );
  }
  return (
    <div className="loading-in px-4 py-5" role="status" aria-live="polite" aria-label={label}>
      <Rows n={3} />
      {text
        ? <div className="mt-4 flex items-center gap-2 text-xs text-muted"><Spinner size="sm" color="current" />{label}</div>
        : <span className="sr-only">{label}</span>}
    </div>
  );
}

// "Fetching new data" marker for the panel head. The table is NEVER
// emptied while reloading — old data stays readable until the new arrives,
// and this marker tells that the figures are about to change. Empty
// when not loading, so it does not become furniture that is always there.
export function Refreshing({ loading, text = 'Memperbarui…' }) {
  if (!loading) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted" role="status">
      <Spinner size="sm" color="current" className="size-3" />{t(text)}
    </span>
  );
}

// Refresh button + "last read" clock. One package on purpose: a button without a
// clock cannot be trusted — pressed, the figures are the same, and there is no way to know whether
// they really had not changed or the request was lost; a clock without a button only gives
// stale news with no way out.
//
// `at` is the time the server read the chain, NOT the time the page fetched the data:
// reloading the page every second does not make the figures newer. Past 90 seconds
// the clock turns yellow — by then the age of the data is enough to change decisions
// (the price moved, fees grew, the position left the range).
//
// `at` not passed at all = the table has no such clock (its contents come from the
// database, not from a chain sync): the button only, without a clock pretending to be there.
export function Refresh({ at, busy, onPress, label = 'Perbarui', stale = 90_000 }) {
  useTick(1000);
  const old = at ? Date.now() - at > stale : false;
  return (
    <span className="flex max-w-full flex-wrap items-center gap-2">
      {at !== undefined && (
        <span className={`text-xs whitespace-nowrap ${old ? 'text-warning' : 'text-muted'}`}
          title={at ? new Date(at).toLocaleString() : undefined}>
          {at ? t('diperbarui {n}', { n: ago(at) }) : t('belum terbaca')}
        </span>
      )}
      <Button size="sm" variant="tertiary" isPending={busy} isDisabled={busy} onPress={onPress}>
        <RefreshCw className="size-4" />{t(label)}
      </Button>
    </span>
  );
}

export function Notice({ status = 'default', title, children }) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        {title && <Alert.Title>{t(title)}</Alert.Title>}
        {children && <Alert.Description>{children}</Alert.Description>}
      </Alert.Content>
    </Alert>
  );
}

// Price range of an LP position.
//
// Shows the actual PRICE, not the width in percent: "width 530%" does not
// tell at which price this position works, whether the current price is still inside
// it, and how close it is to the edge. The axis is drawn logarithmically because
// Uniswap ticks are linear in log price — the same distance on screen means the
// same percent price change.
export function PriceRange({
  lo, hi, cur, entrySqrt, exitSqrt, dec0, dec1, quoteSide, symbol0, symbol1, showPrices = true, position = null,
}) {
  if (lo == null || hi == null) return <span className="text-muted">—</span>;
  // Full range (tick ±887272, rounded to tick spacing): the price is 3e-39 … 3e+38,
  // a correct figure but meaningless. A position like this is always in-range.
  if (lo <= -880000 && hi >= 880000) {
    const pE = sqrtPrice(entrySqrt, dec0, dec1, quoteSide), pX = sqrtPrice(exitSqrt, dec0, dec1, quoteSide);
    const mv = pE != null && pX != null ? (pX / pE - 1) * 100 : null;
    return (
      <div className="w-44 min-w-40 text-xs">
        <div className="font-medium">{t('Seluruh rentang')}</div>
        {/* no edge: the band fades on both sides instead of stopping at one price */}
        <div className="relative mt-0.5 h-3.5">
          <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-linear-to-r from-transparent via-accent/40 to-transparent" />
        </div>
        {pE != null && <div className="num mt-1 whitespace-nowrap text-muted">
          {t('masuk {p}', { p: price(pE) })}
          {mv != null && <><span className="mx-1">·</span><span className={mv > 0.05 ? 'text-success' : mv < -0.05 ? 'text-danger' : ''}>{t('keluar ')}{pct(mv, 1)}</span></>}
        </div>}
      </div>
    );
  }
  const at = (t) => tickPrice(t, dec0, dec1, quoteSide);
  const a = at(lo), b = at(hi);
  const [pLo, pHi] = a <= b ? [a, b] : [b, a];
  if (!Number.isFinite(pLo) || !Number.isFinite(pHi) || pLo <= 0) return <span className="text-muted">—</span>;
  const quote = quoteSide === 0 ? symbol0 : quoteSide === 1 ? symbol1 : null;
  const base = quoteSide === 0 ? symbol1 : quoteSide === 1 ? symbol0 : null;

  const pEntry = sqrtPrice(entrySqrt, dec0, dec1, quoteSide);
  const pExit = sqrtPrice(exitSqrt, dec0, dec1, quoteSide);
  const pNow = pExit ?? (cur != null ? at(cur) : null);   // closed position: the price at exit
  const closed = pExit != null;
  const bep = position ? breakEven(position) : null;
  const bepPrice = bep?.price > 0 && Number.isFinite(bep.price) ? bep.price : null;

  // Logarithmic axis: range + padding, widened if the entry/current price is outside the
  // range so the marker stays visible, not stuck to the edge.
  const L = Math.log;
  const pts = [pLo, pHi, pEntry, pNow, bepPrice].filter((x) => x != null && x > 0);
  const dataLo = Math.min(...pts), dataHi = Math.max(...pts);
  const pad = (L(pHi) - L(pLo) || 1) * 0.5;
  const min = Math.min(L(pLo) - pad, L(dataLo) - pad * 0.4);
  const max = Math.max(L(pHi) + pad, L(dataHi) + pad * 0.4);
  const at100 = (p) => Math.max(0, Math.min(100, ((L(p) - min) / (max - min)) * 100));

  const inRange = pNow != null && pNow >= pLo && pNow <= pHi;
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  // Closed position or without a current price: the in/out status does not apply, neutral band.
  const band = closed || pNow == null ? 'bg-accent/25 border-accent'
    : inRange ? 'bg-success/25 border-success' : 'bg-warning/20 border-warning';

  // Distance to the nearest edge = how many percent the price must move before the position
  // stops earning fees.
  let edge = null;
  const cap = (x) => (x >= 1000 ? '999+' : x.toFixed(0));
  if (!closed && pNow != null) {
    if (inRange) {
      const toLo = (pNow / pLo - 1) * 100, toHi = (pHi / pNow - 1) * 100;
      edge = <span className="text-success">{t(toLo < toHi ? 'di dalam · {n}% ke tepi bawah' : 'di dalam · {n}% ke tepi atas', { n: cap(Math.min(toLo, toHi)) })}</span>;
    } else {
      const off = pNow < pLo ? (pLo / pNow - 1) * 100 : (pNow / pHi - 1) * 100;
      edge = <span className="text-warning">{t(pNow < pLo ? 'di luar · {n}% di bawah' : 'di luar · {n}% di atas', { n: cap(off) })}</span>;
    }
  }

  const title = [
    t('Rentang {lo} – {hi}{q} per {b}', { lo: price(pLo), hi: price(pHi), q: quote ? ' ' + quote : '', b: base || '—' }),
    pEntry != null ? t('Harga masuk {p}', { p: price(pEntry) }) : null,
    pNow != null ? t(closed ? 'Harga keluar {p}{m}' : 'Harga kini {p}{m}', { p: price(pNow), m: move != null ? ` (${pct(move, 1)})` : '' }) : null,
    bep ? `${t('Harga BEP')}: ${bepPrice ? `${price(bepPrice)} ${quote || ''}` : t(bep.reason)}` : null,
    t('Lebar {w}% ({x}×) · tick {lo} … {hi}', { w: widthPct(lo, hi).toFixed(0), x: (pHi / pLo).toFixed(2), lo, hi }),
  ].filter(Boolean).join('\n');

  return (
    <div className="w-44 min-w-40" title={title}>
      {showPrices && (
        <div className="num mb-0.5 text-xs whitespace-nowrap">
          {price(pLo)} <span className="text-muted">–</span> {price(pHi)}
          {quote && <span className="ml-1 text-muted">{quote}</span>}
        </div>
      )}
      {/* Thin track = the whole axis; thick edged band = the position range, coloured by
          its status so in/out reads before the text. The marker is centred on its price
          (-translate-x-1/2), not attached by its left edge. */}
      <div className="relative h-3.5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-default" />
        <div className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[1px] border-x-2 ${band}`}
          style={{ left: `${at100(pLo)}%`, width: `${Math.max(2, at100(pHi) - at100(pLo))}%` }} />
        {bepPrice && <div className="absolute inset-y-0 z-10 w-0 -translate-x-1/2 border-l-2 border-dashed border-warning" style={{ left: `${at100(bepPrice)}%` }} title={`${t('Harga BEP')}: ${price(bepPrice)} ${quote || ''}`} />}
        {/* masuk: garis tipis & redup; kini/keluar: titik tegas berbingkai warna kartu */}
        {pEntry != null && <div className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-muted" style={{ left: `${at100(pEntry)}%` }} title={t('harga masuk')} />}
        {pNow != null && <div className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-surface" style={{ left: `${at100(pNow)}%` }} title={t(closed ? 'harga keluar' : 'harga kini')} />}
      </div>
      {pEntry != null && (
        <div className="num mt-0.5 text-xs whitespace-nowrap text-muted">
          {t('masuk {p}', { p: price(pEntry) })}
          {move != null && <>
            <span className="mx-1 text-muted">·</span>
            {/* a swept-empty pool can put the price at the max tick — +1e19% says nothing
                beyond "far"; capped like the distance to the edge */}
            <span className={move > 0.05 ? 'text-success' : move < -0.05 ? 'text-danger' : ''}>
              {closed ? t('keluar ') : ''}{move >= 1000 ? '+999+%' : pct(move, 1)}</span>
          </>}
        </div>
      )}
      {edge && <div className="mt-0.5 text-xs">{edge}</div>}
      {bep && <div className="num mt-0.5 text-xs text-warning">
        {bepPrice ? <><span aria-hidden className="mr-1 inline-block h-2 border-l-2 border-dashed border-warning" />BEP {price(bepPrice)}{quote && <> {quote}</>}{pNow > 0 && <span className="block">{pct((bepPrice / pNow - 1) * 100, 1)} {t('dari harga sekarang')}</span>}</> : <>BEP: {t(bep.reason)}</>}
      </div>}
    </div>
  );
}

// Data table: sorts, searches, and paginates by itself.
//
// Columns: { key, label, align, className, render, sort, search, sortable:false }
//  - sort   : (row) => comparison value (number/text). Default: uses row[key].
//  - search : (row) => text that is searched. Default: the sort result if it is text.
// All tables use this component, so behaviour is uniform across the dashboard.
const cmp = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;              // empty always at the bottom, in both directions
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
const valOf = (c, r) => (c.sort ? c.sort(r) : r[c.key]);

export function DataTable({
  label, columns, rows, rowKey, empty, dense, footer,
  searchable, pageSize = 0, defaultSort, onRow, pinTop, jumpTo,
}) {
  const [sort, setSort] = useState(defaultSort || null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // The number of rows per page can be changed by the reader; the choice is remembered per table
  // (key = label) in the browser. The caller's pageSize is only the initial value.
  const sizes = useMemo(() => (pageSize > 0 ? [...new Set([4, 10, 25, 50, 100, pageSize])].sort((a, b) => a - b) : []), [pageSize]);
  const [size, setSizeRaw] = useState(() => {
    if (!pageSize) return 0;
    try { const v = Number(localStorage.getItem(`lpcopy.rows.${label}`)); if (v > 0) return v; } catch { /* penyimpanan diblokir */ }
    return pageSize;
  });
  const setSize = (v) => { setSizeRaw(v); setPage(1); try { localStorage.setItem(`lpcopy.rows.${label}`, String(v)); } catch { /* abaikan */ } };

  const searchCols = columns.filter((c) => c.search || (c.sortable !== false && typeof valOf(c, rows[0] || {}) === 'string'));
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => searchCols.some((c) => {
      const v = c.search ? c.search(r) : valOf(c, r);
      return v != null && String(v).toLowerCase().includes(needle);
    }));
  }, [rows, q]);

  const sorted = useMemo(() => {
    const col = sort?.column ? columns.find((c) => c.key === sort.column) : null;
    if (!col && !pinTop) return filtered;
    const dir = sort?.direction === 'descending' ? -1 : 1;
    const byCol = col ? (a, b) => cmp(valOf(col, a), valOf(col, b)) * dir : () => 0;
    // pinTop: rows that pass the predicate are always on top (e.g. still-open positions), whatever the sort column/direction.
    const order = pinTop ? (a, b) => (pinTop(b) ? 1 : 0) - (pinTop(a) ? 1 : 0) || byCol(a, b) : byCol;
    return [...filtered].sort(order);
  }, [filtered, sort, columns, pinTop]);

  const pages = size ? Math.max(1, Math.ceil(sorted.length / size)) : 1;
  const cur = Math.min(page, pages);
  const view = size ? sorted.slice((cur - 1) * size, cur * size) : sorted;

  // Filtering or sorting changes the page contents — go back to the first page.
  useEffect(() => { setPage(1); }, [q, sort?.column, sort?.direction, rows.length]);

  // jumpTo {key, n}: the caller asks for one row to be pointed out (e.g. the original position
  // copied by the bot). Filters are cleared, the page containing that row is opened, then
  // the row is scrolled to the middle of the screen and briefly highlighted. n rises on every request
  // so pressing the same button twice still scrolls again.
  const root = useRef(null);
  const [pending, setPending] = useState(null);
  const [flash, setFlash] = useState(null);
  useEffect(() => { if (jumpTo?.key) setPending(jumpTo); }, [jumpTo?.key, jumpTo?.n]);
  useEffect(() => {
    if (!pending) return;
    const key = String(pending.key);
    const idx = sorted.findIndex((r, i) => String(rowKey ? rowKey(r, i) : i) === key);
    if (idx < 0) { if (q) setQ(''); else setPending(null); return; }
    setPage(size ? Math.floor(idx / size) + 1 : 1);
    setFlash(key);
    setPending(null);
  }, [pending, sorted]);
  useEffect(() => {
    if (!flash) return;
    root.current?.querySelector('tr.row-flash')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setFlash(null), 3200);
    return () => clearTimeout(timer);
  }, [flash]);

  // A search box above a table of 2 rows is just empty furniture; it appears once
  // the list is long enough to really need filtering.
  const canSearch = searchable && rows.length >= 8;
  const head = rows.length > 0 && (canSearch || (size > 0 && rows.length > size));
  // The first column (pair/wallet name) sticks when the table is scrolled horizontally — on a
  // phone, a wide table shows only one or two columns; without this the scrolled figures
  // lose their row. The shadow at the column edge only when it has shifted.
  useEffect(() => {
    const sc = root.current?.querySelector('.table__scroll-container');
    if (!sc) return;
    const on = () => root.current?.classList.toggle('is-scrolled', sc.scrollLeft > 2);
    on(); sc.addEventListener('scroll', on, { passive: true });
    return () => sc.removeEventListener('scroll', on);
  }, [rows.length]);
  return (
    <div ref={root} className="table-sticky">
      {head && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          {canSearch ? (
            <div className="relative w-full max-w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input variant="secondary" className="pl-8" value={q} aria-label={t('Cari')}
                placeholder={t('Cari…')} onChange={(e) => setQ(e.target.value)} />
            </div>
          ) : <span />}
          <span className="text-sm text-muted">
            {q ? t('{n} dari {total} baris', { n: sorted.length, total: rows.length }) : t('{n} baris', { n: rows.length })}
          </span>
        </div>
      )}
      <Table variant="secondary">
        <Table.ScrollContainer className="max-w-full">
          {/* onRow: the whole row is clickable (e.g. opens the history drawer). Buttons and
              links inside a cell still work on their own — react-aria stops nested
              presses before they reach the row. */}
          <Table.Content aria-label={t(label)} className="min-w-[640px]"
            sortDescriptor={sort || undefined} onSortChange={setSort}
            onRowAction={onRow ? (key) => { const r = rows.find((x, i) => String(rowKey ? rowKey(x, i) : i) === String(key)); if (r) onRow(r); } : undefined}>
            <Table.Header>
              {columns.map((c, i) => {
                const canSort = c.sortable !== false && !!c.key;
                // HeroUI's built-in sortable column header is flex space-between, so
                // text-end on the <th> has no effect; right alignment is set on its span.
                return (
                  <Table.Column key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting={canSort}
                    className={c.align === 'end' ? 'text-end' : ''}>
                    {canSort
                      ? ({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}
                          className={`gap-1 ${c.align === 'end' ? 'justify-end' : 'justify-start'}`}>
                          {t(c.label)}
                        </Table.SortableColumnHeader>)
                      : t(c.label)}
                  </Table.Column>
                );
              })}
            </Table.Header>
            <Table.Body renderEmptyState={() => (q ? <Empty title="Tidak ada yang cocok" sub="Coba kata kunci lain." /> : empty || <Empty title="Belum ada data" />)}>
              {view.map((r, i) => (
                <Table.Row key={rowKey ? rowKey(r, i) : i} id={rowKey ? rowKey(r, i) : i}
                  className={`${onRow ? 'cursor-pointer' : ''} ${flash != null && String(rowKey ? rowKey(r, i) : i) === flash ? 'row-flash' : ''}`}>
                  {columns.map((c) => (
                    <Table.Cell key={c.key} className={`${c.align === 'end' ? 'text-end num' : ''} ${dense ? 'py-2' : ''} ${c.className || ''}`}>
                      {c.render ? c.render(r) : r[c.key]}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {footer && rows.length > 0 && (
        <div className="border-t border-border px-4 py-2.5 text-sm">{footer}</div>
      )}
      {/* The table footer shows as soon as the list is longer than the smallest option, so
          the row count can still be reduced even when everything fits on one page. */}
      {size > 0 && sorted.length > sizes[0] && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border px-4 py-3">
          <span className="flex items-center gap-2 text-xs text-muted">
            {t('Baris per halaman')}
            <Pick aria="Baris per halaman" className="w-20" value={String(size)} onChange={(v) => setSize(Number(v))}
              options={sizes.map((n) => [String(n), String(n)])} />
          </span>
          {pages > 1
            ? <Pager page={cur} pages={pages} total={sorted.length} pageSize={size} onChange={setPage} />
            : <span className="text-sm text-muted">{t('{n} baris', { n: sorted.length })}</span>}
        </div>
      )}
    </div>
  );
}

function Pager({ page, pages, total, pageSize, onChange }) {
  const nums = [];
  if (pages <= 7) for (let i = 1; i <= pages; i++) nums.push(i);
  else {
    nums.push(1);
    if (page > 3) nums.push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) nums.push(i);
    if (page < pages - 2) nums.push('…');
    nums.push(pages);
  }
  return (
    <Pagination className="ml-auto w-auto">
      <Pagination.Summary>
        {t('Baris {a}–{b} dari {n}', { a: (page - 1) * pageSize + 1, b: Math.min(page * pageSize, total), n: total })}
      </Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous isDisabled={page === 1} onPress={() => onChange(page - 1)}>
            <Pagination.PreviousIcon /><span className="hidden sm:inline">{t('Sebelumnya')}</span>
          </Pagination.Previous>
        </Pagination.Item>
        {nums.map((p, i) => (
          <Pagination.Item key={p === '…' ? `e${i}` : p}>
            {p === '…' ? <Pagination.Ellipsis />
              : <Pagination.Link isActive={p === page} onPress={() => onChange(p)}>{p}</Pagination.Link>}
          </Pagination.Item>
        ))}
        <Pagination.Item>
          <Pagination.Next isDisabled={page === pages} onPress={() => onChange(page + 1)}>
            <span className="hidden sm:inline">{t('Berikutnya')}</span><Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  );
}

// ---- form fields ----
export function Text({ label, value, onChange, placeholder, hint, type = 'text', mono, isInvalid, isDisabled, error, autoComplete, className = '', aria, step }) {
  return (
    <TextField value={value ?? ''} onChange={onChange} type={type} isInvalid={isInvalid} isDisabled={isDisabled} aria-label={aria ? t(aria) : undefined} className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{t(label)}</Label>}
      {/* variant="secondary": the HeroUI variant for fields inside a Card/Surface. The default
          (primary) is exactly the card's colour and has no border — invisible. */}
      <Input step={type === 'number' ? (step ?? 'any') : undefined} variant="secondary" placeholder={placeholder && t(placeholder)} autoComplete={autoComplete} className={mono ? 'mono' : type === 'number' ? 'num' : ''} />
      {/* HeroUI hides every Description while the field is invalid; FieldError is the slot that stays visible. */}
      {isInvalid && error ? <FieldError>{t(error)}</FieldError> : hint && <Description>{t(hint)}</Description>}
    </TextField>
  );
}

// `aria` is used when a field deliberately has no visible label (e.g. the token picker in the
// swap card, whose label is already carried by the box title) — screen readers
// still need a name.
export function Pick({ label, value, onChange, options, hint, className = '', aria, isDisabled }) {
  return (
    <Select variant="secondary" isDisabled={isDisabled} value={value} onChange={(v) => onChange(v)} aria-label={aria ? t(aria) : undefined}
      className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{t(label)}</Label>}
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      {hint && <Description>{t(hint)}</Description>}
      <Select.Popover>
        <ListBox>
          {options.map(([id, text]) => (
            <ListBox.Item key={id} id={id} textValue={t(text)}>{t(text)}<ListBox.ItemIndicator /></ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function Toggle({ label, desc, value, onChange, isDisabled }) {
  return (
    // Switch.Content is the element that can be clicked (it carries the <input>); Switch
    // itself is only a wrapper. If Switch.Control is placed outside Content, the switch
    // looks normal but is dead. Description must be a sibling of Content, not its content.
    <Switch isSelected={!!value} onChange={onChange} isDisabled={isDisabled}>
      <Switch.Content>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <Label>{t(label)}</Label>
      </Switch.Content>
      {desc && <Description>{t(desc)}</Description>}
    </Switch>
  );
}

// ---- confirmation ----
// A replacement for window.confirm(): the browser's built-in dialog cannot be styled, carries
// the domain name in its title, and in Safari halts the whole page. Usage
// stays one line: `if (!(await ask({ title, body, confirm, danger }))) return;`
// The text is already translated by the caller.
let pushAsk = null;
export function ask(opts) {
  return new Promise((resolve) => {
    if (!pushAsk) return resolve(window.confirm(opts.title));
    pushAsk({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [q, setQ] = useState(null);
  const last = useRef(null);        // the content stays shown during the close animation
  useEffect(() => { pushAsk = setQ; return () => { pushAsk = null; }; }, []);
  if (q) last.current = q;
  const v = q || last.current || {};
  const done = (ok) => { q?.resolve(ok); setQ(null); };
  return (
    <AlertDialog isOpen={!!q} onOpenChange={(o) => { if (!o) done(false); }}>
      <AlertDialog.Backdrop isDismissable isKeyboardDismissDisabled={false}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status={v.danger ? 'danger' : 'warning'} />
              <AlertDialog.Heading>{v.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            {v.body && <AlertDialog.Body><div className="text-sm text-muted">{v.body}</div></AlertDialog.Body>}
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => done(false)}>{t('Batal')}</Button>
              <Button variant={v.danger ? 'danger' : 'primary'} onPress={() => done(true)} autoFocus>{v.confirm || t('Ya, lanjutkan')}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

// A few mutually exclusive choices (2–6): all visible at once, one
// click, and can carry a count per choice — faster to read than a dropdown.
// options: [[id, label, count?], ...]
export function Segmented({ value, onChange, options, aria, size = 'md' }) {
  const h = size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[0.8125rem]';
  return (
    <div role="radiogroup" aria-label={aria ? t(aria) : undefined}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-surface p-0.5">
      {options.map(([id, label, count]) => {
        const on = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onChange(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap transition-colors ${h}
              ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
            {t(label)}
            {count != null && <span className={`num text-[0.6875rem] ${on ? 'text-muted' : 'text-muted/80'}`}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// A short address that can be clicked to copy in full.
export function CopyAddr({ address }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const id = setTimeout(() => setDone(false), 1500); return () => clearTimeout(id); }, [done]);
  const copy = async () => { try { await navigator.clipboard.writeText(address); setDone(true); } catch { /* izin clipboard ditolak */ } };
  return (
    <button type="button" onClick={copy} title={address} aria-label={t('Salin alamat')}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-muted transition-colors hover:bg-default hover:text-foreground">
      {short(address)}{done ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}

// Transaction hash: a link to the block explorer + a copy button. Used by the bot
// position history drawer and the researched wallet position history drawer alike.
export function TxHash({ hash }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const id = setTimeout(() => setDone(false), 1500); return () => clearTimeout(id); }, [done]);
  if (!hash) return <span className="text-muted">—</span>;
  const copy = async () => { try { await navigator.clipboard.writeText(hash); setDone(true); } catch { /* izin clipboard ditolak */ } };
  return (
    <span className="inline-flex items-center gap-1">
      <a href={txHref(hash)} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-accent hover:underline">
        {short(hash)}<ExternalLink className="size-3" />
      </a>
      <button type="button" onClick={copy} className="text-muted hover:text-foreground" aria-label={t('Salin hash')}>
        {done ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

// "← Back" to the previous page; opened directly from a link: to `fallback`.
export function BackLink({ fallback = 'positions' }) {
  const back = (e) => {
    e.preventDefault();
    if (history.length > 1) history.back(); else location.hash = fallback;
  };
  return (
    <a href={'#' + fallback} onClick={back} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
      <ArrowLeft className="size-3.5" />{t('Kembali')}
    </a>
  );
}

// Link to an external site (DexScreener, GeckoTerminal, token site), new tab.
export function ExtLink({ href, muted, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className={`inline-flex items-center gap-1 hover:underline ${muted ? 'text-muted' : 'text-accent'}`}>{children} <ExternalLink className="size-3" /></a>
  );
}

// Jump buttons to a trading terminal for one token: GMGN, fomo, Uniswap (web) and
// Based Bot (Telegram). Placed wherever the token shows — pool/token header, market
// panel, position row, token in a wallet, stuck leftover — so that from wherever
// it is seen, the token is one click from buying/selling. The logo becomes the marker, not
// text, because all three are already familiar to users. Based Bot reads the chain from
// the address; GMGN, fomo, and Uniswap need the chain slug (chain.js).
// `kinds`: the chain kinds an app applies to (default: EVM only). Solana: GMGN +
// Jupiter; Based Bot, fomo and Uniswap do not serve Solana.
export const TRADE_APPS = [
  { key: 'jupiter', label: 'Jupiter', icon: '/jupiter.svg', brand: '#c7f284', kinds: ['solana'], href: (a) => `https://jup.ag/swap/SOL-${a}` },
  { key: 'gmgn', kinds: ['evm', 'solana'], label: 'GMGN', icon: '/gmgn.png', brand: '#5ec26a', href: (a) => `https://gmgn.ai/${chainInfo().gmgn || chainInfo().key}/token/${a}` },
  { key: 'basedbot', label: 'Based', icon: '/basedbot.jpg', brand: '#3b82f6', href: (a) => `https://t.me/based_eth_bot?start=b_${a}` },
  { key: 'fomo', label: 'fomo', icon: '/fomo.png', brand: '#8b7cf6', href: (a) => `https://fomo.family/tokens/${chainInfo().gmgn || chainInfo().key}/${a}` },
  // Uniswap: the pool's own page if the pool is known (chart, liquidity, swap
  // & add LP buttons there); if only the token, the swap screen with that token.
  { key: 'uniswap', label: 'Uniswap', icon: '/uniswap.png', brand: '#ff007a',
    href: (a) => `https://app.uniswap.org/swap?chain=${chainInfo().uniswap || chainInfo().key}&outputCurrency=${a}`,
    poolHref: (pool) => `https://app.uniswap.org/explore/pools/${chainInfo().uniswap || chainInfo().key}/${pool}` },
];
// The speculative token of a position/pool row: the one that is not a quote asset. A row that
// does not carry quoteSide (e.g. position history) is guessed from the chain's quote symbols.
const isQuoteSym = (sym) => { const c = chainInfo(); return sym === c.usdgSymbol || sym === c.wethSymbol || sym === c.nativeSymbol; };
export const baseTokenOf = (p) => {
  if (!p) return null;
  if (p.baseToken) return p.baseToken;
  if (p.quoteSide === 0) return p.token1;
  if (p.quoteSide === 1) return p.token0;
  if (isQuoteSym(p.symbol0) && !isQuoteSym(p.symbol1)) return p.token1;
  if (isQuoteSym(p.symbol1) && !isQuoteSym(p.symbol0)) return p.token0;
  return null;
};
// Logo link bar (style in index.css: .trade-bar / .trade-stack). links:
// [{ key, label, icon, brand, href }]. compact: a logo stack for table rows;
// the click does not propagate to the clickable row.
function LinkBar({ tag, links, compact = false, className = '' }) {
  return (
    <span className={`${compact ? 'trade-stack' : 'trade-bar'} ${className}`} onClick={(e) => e.stopPropagation()}>
      {!compact && tag && <span className="trade-bar__tag">{t(tag)}</span>}
      {links.map((app) => (
        <a key={app.key} href={app.href} target="_blank" rel="noreferrer" className="trade-link"
          style={{ '--brand': app.brand }} title={t('Buka {app}', { app: app.label })} aria-label={t('Buka {app}', { app: app.label })}>
          <img src={app.icon} alt="" />{!compact && <span>{app.label}</span>}<ArrowUpRight />
        </a>
      ))}
    </span>
  );
}
// Jump-out buttons for one WALLET — placed wherever a 0x… address shows
// (target list, target detail, wallet research page, the bot's own wallet). Three
// questions this dashboard cannot answer alone: what is in its wallet on
// other chains (DeBank), how its LP positions look per a third party (LPAgent), and
// each of its transactions (Etherscan + chain explorer). The logo becomes the marker, not text,
// like the token trading bar above.
export const WALLET_APPS = [
  { key: 'debank', label: 'DeBank', icon: '/debank.png', brand: '#ff6238', href: debankHref },
  { key: 'lpagent', label: 'LPAgent', icon: '/lpagent.png', brand: '#e3f35b', href: lpagentHref },
  { key: 'etherscan', label: 'Etherscan', icon: '/etherscan.png', brand: '#3b6fd4', href: etherscanHref },
];
// explorer: the full bar also carries the block explorer; the compact stack in table rows
// only needs the three external sites so the logos do not cover the neighbouring column.
export function WalletLinks({ address, compact = false, explorer = !compact, className = '' }) {
  if (!address) return null;
  const c = chainInfo();
  const links = WALLET_APPS.map((app) => ({ ...app, href: app.href(address) }));
  // The block explorer of the chain being shown, with the chain's logo. On BSC the explorer is
  // BscScan — etherscanHref is empty there, so the site does not appear twice.
  if (explorer) {
    links.push({ key: 'explorer', label: EXPLORER_NAME[c.key] || t('Penjelajah'), icon: CHAIN_ICON[c.key] || '/favicon.svg',
      brand: 'var(--accent)', href: addrHref(address) });
  }
  return <LinkBar tag="Wallet" links={links.filter((x) => x.href)} compact={compact} className={className} />;
}
export function TradeLinks({ token, pool = null, compact = false, className = '' }) {
  if (!token) return null;
  const kind = chainInfo().kind || 'evm';
  const links = TRADE_APPS.filter((app) => (app.kinds || ['evm']).includes(kind))
    .map((app) => ({ ...app, href: pool && app.poolHref ? app.poolHref(pool) : app.href(token) }));
  return <LinkBar tag="Trade" links={links} compact={compact} className={className} />;
}
// Identifier of one position in a table/drawer. A Meteora position is an anonymous account
// address, useless to read: show a button to the pool on Meteora instead. Other venues keep
// the "#id" they always had.
export function PositionRef({ p, id = p.token_id }) {
  if (p.venue === 'meteora' && p.pool_ref) {
    return (
      <span className="trade-bar" onClick={(e) => e.stopPropagation()}>
        <a href={`https://app.meteora.ag/dlmm/${p.pool_ref}`} target="_blank" rel="noreferrer" className="trade-link"
          style={{ '--brand': '#f06f2c' }} title={t('Buka {app}', { app: 'Meteora' })} aria-label={t('Buka {app}', { app: 'Meteora' })}>
          <img src="/meteora.png" alt="" /><ArrowUpRight />
        </a>
      </span>
    );
  }
  return <span className="mono">#{id}</span>;
}
// Third-party market data (DexScreener, GeckoTerminal) — the pool page if the pool
// is known, the token page if only the token. dexUrl: the DexScreener URL already
// provided by the pair API, more precise than guessing from the address.
export function DataLinks({ pool = null, token = null, dexUrl = null, compact = false, className = '' }) {
  const ref = pool || token;
  if (!ref) return null;
  const c = chainInfo();
  const links = [
    { key: 'dexscreener', label: 'DexScreener', icon: '/dexscreener.png', brand: '#9aa4b2',
      href: dexUrl || `https://dexscreener.com/${c.dexscreener || c.key}/${ref}` },
    { key: 'geckoterminal', label: 'GeckoTerminal', icon: '/geckoterminal.jpg', brand: '#8b5cf6',
      href: `https://www.geckoterminal.com/${c.geckoterminal || c.key}/${pool ? 'pools' : 'tokens'}/${ref}` },
  ];
  return <LinkBar tag="Chart" links={links} compact={compact} className={className} />;
}
