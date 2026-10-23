import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, toast } from '@heroui/react';
import { Search, Check, TriangleAlert, Anchor, ArrowRight } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import CandleChart, { BAND_COLORS } from '../components/CandleChart';
import { useLadder, LadderStep, LadderPreview, LAYER_CHOICES } from './ManualLadder';
import { useCreatePool, CreatePoolStep } from './ManualCreate';
import { PageHeader, Notice, PriceRange, Empty, KV, Segmented } from '../components/ui';
import { orientCandles, TFS, SECS, LiveBadge } from './PositionDetail';
import { useLivePrice, useLiveCandles } from '../liveCandles';
import TokenIcon, { TokenPair, TokenSym, PairName } from '../components/TokenIcon';
import { usd, kUsd, num, ago, price, tickPrice, locale } from '../fmt';
import { useI18n } from '../i18n';
import { isSolana, isAddr, canonAddr, chainInfo } from '../chain';

// Quick range choices: [lower bound change %, upper bound change %, label],
// signed from the current price. The percentages are in price, so "±50%" is really half
// down and half up; "½× – 2×" is the range that used to be written ±100% (in
// ticks symmetric, in price not).
const PRESET = [[-5, 5, '±5%'], [-10, 10, '±10%'], [-25, 25, '±25%'], [-50, 50, '±50%'], [-50, 100, '½× – 2×'], [-25, 0, '1 sisi · bawah −25%'], [0, 25, '1 sisi · atas +25%']];

// Range text for the summary & confirmation. lo/up = the signed change of each bound.
const fmtPct = (v) => num(Number(v), 2);
const flagged = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtPct(Math.abs(v))}%`;
const rangeLabel = (lo, up, full, t) => (full ? t('seluruh rentang')
  : -lo === up ? `±${fmtPct(up)}%` : `${flagged(lo)} / ${flagged(up)}`);

// One bound box: the sign in front, the percent behind, the resulting price below.
// The sign is a button: −/+ moves the bound to the other side of the current price, so a one-sided
// range does not have to stick to the price (e.g. −30% … −10%). Typing "-" or "+"
// in the box does the same thing.
function Limit({ label, direction, onArah, value, onChange, harga: px, sym, invalid, disabled, aria }) {
  const { t } = useI18n();
  // The label is tied to the input by id: without it the sign button (the first element that
  // can be labelled) gets clicked every time the box is clicked.
  const id = useId();
  return (
    <label htmlFor={id} className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border p-3 transition-colors
      ${invalid ? 'border-danger/60' : 'border-border focus-within:border-accent'} ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-muted">{t(label)}</span>
      <span className="flex items-baseline gap-1">
        <button type="button" disabled={disabled} onClick={() => onArah(-direction)}
          aria-label={t(direction < 0 ? 'Di bawah harga kini — klik untuk memindah ke atas' : 'Di atas harga kini — klik untuk memindah ke bawah')}
          title={t(direction < 0 ? 'Di bawah harga kini — klik untuk memindah ke atas' : 'Di atas harga kini — klik untuk memindah ke bawah')}
          className="num w-6 shrink-0 self-center rounded text-lg font-semibold text-muted hover:bg-default/60 hover:text-foreground">
          {direction < 0 ? '−' : '+'}
        </button>
        <input id={id} value={value} disabled={disabled} inputMode="decimal" aria-label={t(aria)} placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (/[-−–]/.test(v)) onArah(-1); else if (v.includes('+')) onArah(1);
            onChange(v.replace(/[^\d.,]/g, ''));
          }}
          className="num w-full min-w-0 bg-transparent text-lg font-semibold outline-none placeholder:text-muted/60" />
        <span className="text-lg text-muted">%</span>
      </span>
      <span className="num h-4 truncate text-xs text-muted">{px != null ? `≈ ${price(px)}${sym ? ' ' + sym : ''}` : ''}</span>
    </label>
  );
}

// ---- Meteora DLMM: liquidity shape -------------------------------------------------------
const SHAPES = [
  ['spot', 'Spot', [5, 5, 5, 5, 5, 5, 5], 'Spot: nilai sama rata di setiap bin.'],
  ['curve', 'Curve', [2, 3, 4, 6, 4, 3, 2], 'Curve: menumpuk di sekitar harga kini — fee besar selama harga tenang, cepat habis kalau harga bergerak.'],
  ['bidask', 'Bid-Ask', [6, 4, 3, 2, 3, 4, 6], 'Bid-Ask: menumpuk di tepi rentang — membeli saat turun dan menjual saat naik.'],
];

function ShapeIcon({ bars }) {
  return (
    <span aria-hidden="true" className="inline-flex h-3.5 items-end gap-px">
      {bars.map((h, i) => <span key={i} className="w-0.5 rounded-sm bg-current" style={{ height: `${h * 2}px` }} />)}
    </span>
  );
}

// On v3/v4 a position is flat over its range, so Curve and Bid-Ask are built from several
// adjacent positions (bands) — said under the picker, since each band costs its own mint.
const EVM_SHAPE_HINT = {
  spot: 'Spot: satu posisi, likuiditas rata di seluruh rentang.',
  curve: 'Curve: rentang dipecah jadi beberapa posisi berdampingan, yang dekat harga kini dapat dana terbesar.',
  bidask: 'Bid-Ask: rentang dipecah jadi beberapa posisi berdampingan, yang di tepi rentang dapat dana terbesar.',
};

function ShapePicker({ value, onChange, evm = false }) {
  const { t } = useI18n();
  const cur = SHAPES.find((x) => x[0] === value) || SHAPES[0];
  const hint = evm ? EVM_SHAPE_HINT[cur[0]] : cur[3];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{t('Bentuk likuiditas')}</span>
      <div role="radiogroup" aria-label={t('Bentuk likuiditas')} className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-surface p-1">
        {SHAPES.map(([id, label, bars]) => {
          const on = value === id;
          return (
            <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onChange(id)}
              className={`flex h-9 items-center justify-center gap-2 rounded-md text-[0.8125rem] font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
              <ShapeIcon bars={bars} />{t(label)}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">{t(hint)}</p>
    </div>
  );
}

// Per-bin value of the planned position: token0 above the pool price, token1 below,
// the active bin half of each. Left = lower price in the pair's display orientation.
const MAX_BARS = 120;
function BinDistribution({ p }) {
  const { t } = useI18n();
  const d = p.distribution;
  if (!d?.bins?.length) return null;
  const tpb = Math.log(1 + d.binStep / 10_000) / Math.log(1.0001);
  const priceOf = (b) => tickPrice(b * tpb, p.dec0, p.dec1, p.quoteSide);
  const ordered = p.quoteSide === 0 ? [...d.bins].reverse() : d.bins;
  // Wide ranges: neighbouring bins merged into one bar (mean weight).
  const size = Math.ceil(ordered.length / MAX_BARS);
  const bars = [];
  for (let i = 0; i < ordered.length; i += size) {
    const g = ordered.slice(i, i + size);
    const ids = g.map((x) => x[0]);
    bars.push({ w: g.reduce((a, x) => a + x[1], 0) / g.length, lo: Math.min(...ids), hi: Math.max(...ids), first: g[0][0], last: g[g.length - 1][0] });
  }
  const col0 = 'var(--bin-0)', col1 = 'var(--bin-1)';
  const fill = (b) => (b.lo > d.active ? col0 : b.hi < d.active ? col1 : `linear-gradient(to right, ${p.quoteSide === 0 ? col0 : col1} 50%, ${p.quoteSide === 0 ? col1 : col0} 50%)`);
  const activeIdx = bars.findIndex((b) => b.lo <= d.active && d.active <= b.hi);
  const labels = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (bars.length - 1)));
  const sym = (s) => <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s === 0 ? col0 : col1 }} />{s === 0 ? p.symbol0 : p.symbol1}</span>;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="font-medium text-foreground">{t('Sebaran per bin')}</span>
        <span className="flex gap-3">{sym(0)}{sym(1)}</span>
      </div>
      <div className="relative">
        {activeIdx >= 0 && (
          <div className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-foreground/70"
            style={{ left: `${((activeIdx + 0.5) / bars.length) * 100}%` }}>
            <span className="num absolute -top-0.5 left-1 whitespace-nowrap rounded bg-default px-1 text-[0.6875rem] text-foreground">
              {t('Harga pool')} {price(priceOf(d.active))}
            </span>
          </div>
        )}
        <div className="flex h-28 items-end gap-px pt-5" role="img"
          aria-label={t('Sebaran likuiditas di {n} bin', { n: d.bins.length })}>
          {bars.map((b, i) => (
            <div key={i} className="min-w-0 flex-1 rounded-t-[1px]" style={{ height: `${Math.max(4, b.w * 100)}%`, background: fill(b) }} />
          ))}
        </div>
      </div>
      <div className="num mt-1.5 flex justify-between text-[0.6875rem] text-muted">
        {labels.map((i, k) => <span key={k}>{price(priceOf(k < 2 ? bars[i].first : bars[i].last))}</span>)}
      </div>
      {activeIdx < 0 && <p className="mt-1.5 text-xs text-muted">{t('Harga pool di luar rentang ini — posisi satu sisi.')}</p>}
    </div>
  );
}

// Quick choice button. Used for the amount and the range width — both are almost
// always filled from a few recurring values, so typing is wasted work.
function Chips({ options, value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" onClick={() => onPick(v)} aria-pressed={value === v}
          className={`num h-8 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors ${value === v
            ? 'border-accent bg-accent/10 text-accent' : 'border-border text-foreground hover:bg-default/60'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Step({ n, title, done, children, action }) {
  const { t } = useI18n();
  return (
    <Card className="gap-0! p-0!">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${done ? 'bg-success text-success-foreground' : 'border border-border text-muted'}`}>
            {done ? <Check className="size-3" strokeWidth={3} /> : n}
          </span>
          <h2 className="text-sm font-semibold">{t(title)}</h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

const fee = (p) => (p.dynamicFee ? 'dinamis' : `${num(p.feePct, 2)}%`);

// Venue groups for the pool list filter. A v4 pool with a hook is its own group: a hook can
// change fees or block trades, so it is worth picking out (or leaving out) on purpose.
const VENUE_LABEL = { v3: 'V3', v4: 'V4', v4hook: 'V4 + hook', pancakev3: 'Pancake V3', meteora: 'DLMM', dammv2: 'DAMM v2', orca: 'Orca', raydium: 'Raydium CLMM' };
const venueKey = (p) => (p.venue === 'v4' && p.hasHooks ? 'v4hook' : p.venue);
const SORTS = [['aktif', 'Terbaru aktif'], ['tvl', 'Likuiditas'], ['vol', 'Volume 24 jam'], ['apr', 'APR']];
const sortVal = { tvl: (p) => p.stats?.tvlUsd, vol: (p) => p.stats?.volume24hUsd, apr: (p) => p.stats?.aprPct };

// Token amount: a memecoin can be millions, ETH can be 0.0000x — fixed decimals suit
// neither, so below 1 it uses significant digits.
const qty = (v) => (v == null ? '—' : v === 0 ? '0' : Math.abs(v) >= 1 ? num(v, Math.abs(v) >= 1000 ? 0 : 4)
  : Number(v).toLocaleString(locale(), { maximumSignificantDigits: 4 }));

// Relevant wallet balances: cash (ETH/USDG/WETH) and the pool's pair token. The
// "After opening" column appears as soon as the preview for this pool is computed.
function Balance({ saldo: balance, pool }) {
  const { t } = useI18n();
  if (!balance) return null;
  if (balance.wallet === false) return <p className="text-xs text-muted">{t('Belum ada wallet — saldo tidak bisa dibaca.')}</p>;
  const inPool = (a) => pool && (a === canonAddr(pool.token0 || '') || a === canonAddr(pool.token1 || ''));
  const rows = balance.tokens.filter((x) => x.amount > 0 || x.native || inPool(x.token) || x.after > 0);
  const after = rows.some((x) => x.after != null);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Saldo wallet')}</span>
        <span>{t('Kas')} <span className="num font-semibold text-foreground">{usd(balance.walletCashUsd)}</span></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {after && (
            <thead>
              <tr className="text-[0.6875rem] text-muted">
                <th className="px-3 pt-2 text-start font-normal">{t('Token')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Sekarang')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Setelah dibuka')}</th>
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((x) => (
              <tr key={x.token}>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-2">
                    <TokenIcon link address={x.token} symbol={x.symbol} size={18} />
                    <TokenSym address={x.token} symbol={x.symbol} className="font-medium" />
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-end">
                  {qty(x.amount)}
                  <span className="ms-1.5 text-xs text-muted">{x.usd != null ? usd(x.usd) : ''}</span>
                </td>
                {after && (
                  <td className="num px-3 py-1.5 text-end text-muted">
                    ≈ {qty(x.after)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        {t('{e} {s} ditahan untuk biaya transaksi dan tidak ikut dipakai.', { e: num(balance.gasReserveEth, 4), s: balance.nativeSymbol || chainInfo().nativeSymbol })}
      </p>
    </div>
  );
}

const swapQty = (n, t) => (!n ? t('tidak perlu') : n === 1 ? t('1 transaksi') : t('{n} transaksi', { n }));

const KIND = {
  zap: 'Beli {s}',
  bridge: 'Jembatan kas',
  wrap: 'Bungkus ETH',
  buka_bungkus: 'Buka bungkus WETH',
};

// Breakdown of the swap the bot will run before the mint, from the simulation on the server
// (manual.simulateSwap) — the order and amounts are the same as executeEntry.
function AutoSwap({ p }) {
  const { t } = useI18n();
  const sw = p.swaps || [];
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Auto-swap sebelum mint')}</span>
        <span>{swapQty(sw.length, t)}</span>
      </div>
      {!sw.length ? (
        <p className="px-3 py-2.5 text-sm text-muted">
          {t('Tidak ada yang ditukar — saldo {a} dan {b} sudah cukup untuk posisi ini.', { a: p.symbol0, b: p.symbol1 })}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {sw.map((s, i) => (
            <li key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="flex size-4 items-center justify-center rounded-full border border-border text-[0.625rem]">{i + 1}</span>
                <span className="font-medium text-foreground">{t(KIND[s.jenis] || s.jenis, { s: s.ke.symbol })}</span>
                {s.jenis === 'zap' || s.jenis === 'jembatan' ? <span>· {s.router || t('Agregator swap')}</span> : <span>· {t('1:1, tanpa slippage')}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5">
                  <TokenIcon link address={s.dari.token} symbol={s.dari.symbol} size={16} />
                  <span className="num font-medium">{s.estimate ? '≈ ' : ''}{qty(s.dari.amount)} <TokenSym address={s.dari.token} symbol={s.dari.symbol} /></span>
                </span>
                <ArrowRight className="size-3.5 text-muted" />
                <span className="flex items-center gap-1.5">
                  <TokenIcon link address={s.ke.token} symbol={s.ke.symbol} size={16} />
                  <span className="num font-medium">{qty(s.ke.amount)} <TokenSym address={s.ke.token} symbol={s.ke.symbol} /></span>
                </span>
                {s.dari.usd != null && <span className="num text-xs text-muted">{usd(s.dari.usd)}</span>}
              </div>
              {s.maxLossBps != null && (
                <div className="text-xs text-muted">
                  {t('dibatalkan kalau rugi rute lebih dari {r}%', { r: num(s.maxLossBps / 100, 2) })}
                  {s.estimate ? ' · ' + (s.router ? t('jumlah pasti dari kutipan {r} saat eksekusi', { r: s.router }) : t('jumlah pasti dari kutipan agregator saat eksekusi')) : ''}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!!sw.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          {p.swapOn
            ? t('Jumlah yang dijual sudah termasuk ruang slippage {s}%; kelebihannya tetap di wallet.', { s: num(p.slippageBps / 100, 2) })
            : <span className="text-danger">{t('Auto-swap dimatikan di Aturan — pembukaan akan berhenti di langkah pertama.')}</span>}
        </p>
      )}
    </div>
  );
}

// Pool price chart with the range band being chosen, so it is visible
// before opening a position where the range falls relative to the price movement.
// The band follows typing (from percent × current price); once the preview for
// the same input arrives, the bounds are replaced by the rounded tick prices.
// Without a preview (amount not yet filled), the current price is taken from the last candle.
function ChartRange({ pool, lo, up, full, rangeOk, preview, currentPrice, onDrag, bands = null }) {
  const { t } = useI18n();
  const [tf, setTf] = useState('1h');
  const baseToken = pool.quoteSide === 0 ? pool.token1 : pool.token0;
  const { data: m } = usePoll(`/api/market?pool=${pool.poolRef}&tf=${tf}&limit=240&pair=0&token=${baseToken || ''}`, 30000);
  const live = useLivePrice(pool.poolRef, pool);
  const acuan = live?.price ?? currentPrice;
  const oriented = useMemo(() => orientCandles(m?.ohlcv, baseToken, acuan), [m, baseToken, acuan]);
  const candles = useLiveCandles(oriented, SECS[tf], live, `${pool.poolRef}:${tf}`);
  const nowPrice = acuan ?? candles[candles.length - 1]?.c ?? null;
  // No quote asset: token0 priced in token1, as everywhere else in the dashboard.
  const quote = pool.quoteSide === 0 ? pool.symbol0 : pool.symbol1;

  const range = useMemo(() => {
    if (full || !rangeOk) return null;
    if (preview) {
      const a = tickPrice(preview.tickLower, preview.dec0, preview.dec1, preview.quoteSide);
      const b = tickPrice(preview.tickUpper, preview.dec0, preview.dec1, preview.quoteSide);
      if (a > 0 && b > 0) return { lo: Math.min(a, b), hi: Math.max(a, b) };
    }
    return nowPrice > 0 ? { lo: nowPrice * (1 + lo / 100), hi: nowPrice * (1 + up / 100) } : null;
  }, [full, rangeOk, preview, nowPrice, lo, up]);

  // Ladder layers: price ratios to the current price -> bands drawn on the chart.
  const ranges = useMemo(() => (bands && nowPrice > 0
    ? bands.map((b, i) => ({ id: i, lo: nowPrice * b.lo, hi: nowPrice * b.hi, color: BAND_COLORS[i % 2], label: b.usd != null ? `L${i + 1} · ${usd(b.usd)}` : `L${i + 1}`, selected: true }))
    : null), [bands, nowPrice]);

  // Dragged bounds (prices) -> percent change from the price the band is drawn against.
  const drag = (a, b) => {
    if (!(nowPrice > 0)) return;
    const r2 = (p) => Math.round((p / nowPrice - 1) * 10000) / 100;
    onDrag(r2(a), r2(b));
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {range ? <>{t('Rentang')} <span className="num text-foreground">{price(range.lo)} – {price(range.hi)}</span>{quote ? ` ${quote}` : ''}</>
            : full ? t('Seluruh rentang') : t('Harga pool')}
        </span>
        <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />
      </div>
      {!m ? (
        <div className="flex h-[300px] items-center justify-center"><Spinner /></div>
      ) : m.ohlcv?.error ? (
        <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />
      ) : !candles.length ? (
        <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />
      ) : (
        <>
          <CandleChart key={pool.poolRef} candles={candles} tf={tf} quote={quote} range={range} ranges={ranges} now={nowPrice} pickRange onRangeDrag={drag} height={300} />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {range && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('rentang yang akan di-LP')} · {t('geser garis atau pita untuk mengubahnya')}</span>}
            {full && <span>{t('Seluruh rentang — tidak ada batas untuk digambar.')}</span>}
            <span className="ml-auto inline-flex items-center gap-3">
              {live && <LiveBadge />}
              {t('lilin {tf} · GeckoTerminal', { tf })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// What a v4 hook may do, decoded from the permission bits in its address. The LP-touching
// ones (remove-liquidity callbacks, returned deltas) are what the bot refuses unless the hook
// is trusted in the rules — swap-only hooks (taxes, anti-snipe, dynamic fees) are shown but fine.
function HookInfo({ hook, rules }) {
  const { t } = useI18n();
  if (!hook) return null;
  const f = rules?.filters || {};
  const trusted = (f.hook_whitelist || []).some((a) => String(a).toLowerCase() === hook.address);
  const risky = hook.risky.length > 0;
  const tone = !risky ? 'text-success' : trusted || f.allow_hooks ? 'text-warning' : 'text-danger';
  return (
    <div className="mt-3 rounded-md border border-border px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium"><Anchor className="size-3.5 text-warning" />{t('Hook')}</span>
        <a className="num text-muted underline underline-offset-2" target="_blank" rel="noreferrer"
          href={`${chainInfo().explorer}/address/${hook.address}`}>{hook.address.slice(0, 10)}…{hook.address.slice(-6)}</a>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {hook.permissions.map((x) => (
          <span key={x} className={`rounded border px-1.5 py-0.5 ${hook.risky.includes(x) ? 'border-danger/50 text-danger' : 'border-border text-muted'}`}>{x}</span>
        ))}
      </div>
      <p className={`mt-2 ${tone}`}>
        {!risky ? t('Hook ini tidak bisa menyentuh penarikan likuiditas — hanya swap (pajak, anti-bot, fee dinamis).')
          : trusted ? t('Hook ini bisa menahan atau memotong penarikan, tapi ada di daftar hook dipercaya.')
          : f.allow_hooks ? t('Hook ini bisa menahan atau memotong penarikan — diizinkan karena "Izinkan semua hook" menyala.')
          : t('Hook ini bisa menahan atau memotong penarikan — pembukaan ditolak. Kalau sudah dicek, tambahkan alamatnya ke "Hook dipercaya" di Aturan.')}
      </p>
    </div>
  );
}

function PoolPicker({ pools, onPick }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [scan, setScan] = useState(null);     // scan result from the token address
  const [every, setAll] = useState(false);
  const [venue, setVenue] = useState('all');
  const [sort, setSort] = useState('aktif');
  const timer = useRef(null);
  const token = canonAddr(q);
  // A v4 pool id (32 bytes) is looked up like an address; a v3 pool address is told apart server-side.
  const isAddress = isAddr(token) || (!isSolana() && /^0x[0-9a-f]{64}$/.test(token));
  useEffect(() => () => clearInterval(timer.current), []);

  const take = async (tok, all) => {
    const d = await get(`/api/manual/pools/scan?token=${tok}${all ? '&all=1' : ''}`);
    setScan({ token: tok, ...d });
    return d;
  };
  // `chain`: skip the DexScreener fast path and sweep the chain (a pool too new to be listed).
  const scanning = async (chain = false) => {
    setScan({ token, status: 'jalan', progress: 0 });
    const r = await post('/api/manual/pools/scan', chain ? { token, chain: true } : { token });
    if (r.error) return setScan({ token, status: 'gagal', error: r.error });
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const d = await take(token, every);
      if (d.status !== 'jalan') clearInterval(timer.current);
    }, 1500);
  };
  const changeAll = (v) => { setAll(v); if (scan?.token) take(scan.token, v); };
  // A pasted token address is searched at once — the pair filter can never match an address.
  useEffect(() => {
    if (!isAddress || scan?.token === token) return undefined;
    const tm = setTimeout(() => scanning(), 250);
    return () => clearTimeout(tm);
  }, [token, isAddress]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A scan result replaces the list only while the search box still contains that address.
  const useScan = isAddress && scan?.token === token && scan.status === 'selesai';
  const found = useMemo(() => {
    if (useScan) return scan.pools || [];
    const n = q.trim().toLowerCase();
    return n ? pools.filter((p) => p.pair.toLowerCase().includes(n)) : pools;
  }, [pools, q, useScan, scan]);
  const venues = useMemo(() => [...new Set(found.map(venueKey))], [found]);
  const hasStats = found.some((p) => p.stats);
  const result = useMemo(() => {
    const list = venue === 'all' ? found : found.filter((p) => venueKey(p) === venue);
    const by = sortVal[sort];
    // Rows without the stat sink to the bottom; the original (activity) order breaks ties.
    return by ? [...list].sort((a, b) => (by(b) ?? -1) - (by(a) ?? -1)) : list;
  }, [found, venue, sort]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cari pasangan, atau tempel alamat token / pool')}
          className="h-9 w-full rounded-md border border-field-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent" />
      </div>

      {scan?.token === token && scan.status === 'jalan' && (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{scan.progress > 0 ? t('Mencari pool di chain… {p}%', { p: scan.progress }) : t('Mencari pool…')}</div>
      )}
      {scan?.token === token && scan.status === 'gagal' && (
        <Notice status="danger" title={t('Pemindaian gagal')}>{scan.error}</Notice>
      )}
      {useScan && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <span>
            {t('{n} pool bisa dimasuki dari {total} yang ada', { n: (scan.pools || []).length, total: scan.total })}
            {scan.source === 'dexscreener' && <>
              {' · '}{t('dari DexScreener')}{' · '}
              <button type="button" className="underline underline-offset-2" title={t('Pool yang baru dibuat mungkin belum terdaftar di DexScreener.')}
                onClick={() => scanning(true)}>{t('Pindai chain')}</button>
            </>}
          </span>
          {!!scan.hidden && (
            <button type="button" className="underline underline-offset-2" onClick={() => changeAll(!every)}>
              {every ? t('Sembunyikan yang kosong') : t('Tampilkan semua')}
            </button>
          )}
        </div>
      )}
      {useScan && !!scan.hidden && !every && (
        <p className="text-xs text-muted">
          {t(isSolana() ? 'Yang disembunyikan: pool tanpa likuiditas, pool nonaktif, atau tidak dipasangkan USDC/USDT/SOL.' : 'Yang disembunyikan: pool tanpa likuiditas, berfee dinamis, atau tidak dipasangkan USDG/ETH — masuk ke sana sama saja membuang gas.')}
        </p>
      )}

      {(venues.length > 1 || hasStats) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {venues.length > 1 ? (
            <Chips value={venue} onPick={setVenue}
              options={[['all', t('Semua')], ...venues.map((v) => [v, t(VENUE_LABEL[v] || v.toUpperCase())])]} />
          ) : <span />}
          {hasStats && (
            <label className="flex items-center gap-2 text-xs text-muted">
              {t('Urutkan')}
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="h-8 rounded-md border border-field-border bg-surface px-2 text-[0.8125rem] text-foreground">
                {SORTS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      <div className={`max-h-80 overflow-y-auto rounded-md border border-border ${isAddress && !useScan ? 'hidden' : ''}`}>
        {hasStats && result.length > 0 && (
          <div className="sticky top-0 z-10 flex justify-end gap-4 border-b border-border bg-surface px-3 py-1.5 text-[0.6875rem] text-muted">
            <span className="hidden w-16 text-end md:inline">{t('TVL')}</span>
            <span className="hidden w-16 text-end md:inline">{t('Vol 24j')}</span>
            <span className="hidden w-14 text-end md:inline">{t('Fee/TVL')}</span>
            <span className="hidden w-16 text-end lg:inline">{t('APR')}</span>
            <span className="w-12 text-end">{t('Tier fee')}</span>
            <span className="hidden w-20 text-end sm:inline">{t('Aktivitas')}</span>
          </div>
        )}
        {!result.length ? (
          <div>
            <Empty title={isAddress ? (isSolana() ? 'Tidak ada pool Meteora DLMM / DAMM v2 / Orca / Raydium CLMM yang bisa dimasuki' : 'Tidak ada pool Uniswap v3/v4 yang bisa dimasuki') : 'Tidak ada pool yang cocok'}
              sub={isAddress ? (isSolana() ? 'Token ini belum punya pool dengan likuiditas yang dipasangkan USDC, USDT, atau SOL.' : 'Token ini belum punya pool dengan likuiditas yang dipasangkan USDG atau ETH.') : 'Tempel alamat token atau pool untuk mencari poolnya langsung dari chain.'} />
            {useScan && scan.others?.length > 0 && (
              <div className="border-t border-border px-3 py-3 text-sm">
                <div className="mb-1.5 font-medium">{t('Diperdagangkan di tempat lain')}</div>
                {scan.others.map((x) => (
                  <div key={x.address || x.name} className="flex justify-between gap-3 py-0.5 text-muted">
                    <span className="truncate"><span className="text-foreground">{x.dex}</span> · {x.name}</span>
                    <span className="num shrink-0">{usd(x.reserveUsd, 0)}</span>
                  </div>
                ))}
                <p className="mt-2 text-xs text-muted">{t(isSolana() ? 'Di Solana bot membuka LP di Meteora DLMM & DAMM v2, Orca Whirlpools, dan Raydium CLMM. AMM lain belum didukung — atau buat pool DAMM v2 / DLMM sendiri lewat "Buat baru".' : 'Bot hanya bisa membuka LP di Uniswap v3/v4 (likuiditas terkonsentrasi dengan rentang harga). Pool gaya v2 tidak punya rentang maupun NFT posisi.')}</p>
              </div>
            )}
          </div>
        ) : result.map((p) => (
          <button key={p.poolRef} type="button" onClick={() => onPick(p)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-0 hover:bg-default/50">
            <span className="flex min-w-0 items-center gap-2.5">
              <TokenPair link={false} token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
              <span className="truncate font-medium">{p.pair}</span>
              <span className="text-[0.6875rem] text-muted uppercase">{p.venue}</span>
              {p.hasHooks && <Anchor className="size-3.5 shrink-0 text-warning" aria-label={t('pool memakai hook')} />}
            </span>
            <span className="flex shrink-0 items-center gap-4 text-xs text-muted">
              {p.stats && (
                <>
                  <span className="num hidden w-16 text-end md:inline" title={t('Likuiditas')}>{p.stats.tvlUsd != null ? kUsd(p.stats.tvlUsd) : '—'}</span>
                  <span className="num hidden w-16 text-end md:inline" title={t('Volume 24 jam')}>{p.stats.volume24hUsd != null ? kUsd(p.stats.volume24hUsd) : '—'}</span>
                  <span className="num hidden w-14 text-end md:inline" title={t('Fee 24 jam / likuiditas')}>{p.stats.feeTvl24Pct != null ? `${num(p.stats.feeTvl24Pct, 2)}%` : '—'}</span>
                  <span className="num hidden w-16 text-end lg:inline" title={t('APR pool')}>{p.stats.aprPct != null ? `${num(p.stats.aprPct, 0)}%` : '—'}</span>
                </>
              )}
              <span className="num w-12 text-end">{fee(p)}</span>
              <span className="hidden w-20 text-end sm:inline">{p.kosong === true ? t('kosong') : p.lastTs ? ago(p.lastTs) : '—'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ManualLp({ param }) {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [pools, setPools] = useState(null);
  const [rules, setRules] = useState(null);
  const [pool, setPool] = useState(null);
  const [swapPool, setSwapPool] = useState(false);
  const [notional, setNotional] = useState('');
  // Each bound = percent magnitude + direction from the current price (−1 below, +1 above).
  const [lower, setLower] = useState('25');
  const [upper, setUpper] = useState('25');
  const [dirDown, setDirDown] = useState(-1);
  const [dirUp, setDirUp] = useState(1);
  const [full, setFull] = useState(false);
  const [shape, setShape] = useState('spot');   // Meteora DLMM: spot | curve | bidask
  const [plan, setPlan] = useState(null);      // { preview, warnings } | { error }
  const [compute, setCompute] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sendOrig, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [balance, setBalance] = useState(null);
  const seq = useRef(0);
  const [mode, setMode] = useState('single');   // 'single' range | 'ladder' of layers
  const [creating, setCreating] = useState(false);   // a new pool instead of an existing one
  const C = useCreatePool(creating);

  useEffect(() => {
    get('/api/manual/pools?limit=200&stats=1').then((d) => setPools(d.pools || []));
    get('/api/rules').then(setRules);
  }, []);

  // Opened from the wallet position drawer: "#manual-lp/<poolRef>?lo=…&up=…" carries the pool
  // and the target position's range, only the amount is left to fill in. The pool is looked up via
  // the same list as its picker (q also matches pool_ref), so the data shape is exactly the same as
  // one picked by hand — including pools outside the top 200.
  useEffect(() => {
    const [ref, qs] = String(param || '').split('?');
    if (!ref) return undefined;
    const sp = new URLSearchParams(qs || '');
    const lo = Number(sp.get('lo')), up = Number(sp.get('up'));
    if (Number.isFinite(lo) && Number.isFinite(up) && lo > -100 && up > -100 && up <= 100000 && up > lo) {
      setFull(false);
      setLower(String(Math.abs(lo))); setDirDown(lo > 0 ? 1 : -1);
      setUpper(String(Math.abs(up))); setDirUp(up < 0 ? -1 : 1);
    }
    let alive = true;
    get(`/api/manual/pools?q=${encodeURIComponent(ref)}&limit=1`).then((d) => {
      const x = (d.pools || [])[0];
      if (alive && x) setPool(x);
    });
    return () => { alive = false; };
  }, [param]);

  // Balances are read separately, not waiting for the preview: the user needs to know their cash
  // BEFORE choosing an amount. Re-read when the pool changes (its pair token
  // is shown too) and after a position is opened.
  const loadBalance = useCallback(async (ref) => {
    const d = await get(`/api/manual/saldo${ref ? `?poolRef=${ref}` : ''}`);
    if (!d.error) setBalance({ ...d, _ref: ref || null });
  }, []);
  useEffect(() => { loadBalance(pool?.poolRef); }, [pool?.poolRef, loadBalance]);

  const usdNum = Number(String(notional).replace(',', '.'));
  // lo/up = the signed change of each bound from the current price. The API uses lowerPct =
  // how far the lower bound is BELOW the price, so the sign is flipped when sent.
  const pctFrom = (s) => Number(String(s).replace(',', '.') || 0);
  const lo = dirDown * pctFrom(lower), up = dirUp * pctFrom(upper);
  const loBad = !full && !(lo > -100);
  const upBad = !full && !(up > -100 && up <= 100000);
  const empty = !full && lo === 0 && up === 0;
  const inverted = !full && !loBad && !upBad && !empty && up <= lo;
  const dlmm = creating ? C.dlmm : pool?.venue === 'meteora';
  // DAMM v2: every position covers the pool's own range — there is no range to pick.
  const damm = creating ? C.damm : pool?.venue === 'dammv2';
  const rangeOk = damm || full || (!loBad && !upBad && !empty && !inverted);
  // EVM Curve / Bid-Ask: the range is opened as several shaped bands through the ladder job.
  const evmShape = !creating && mode === 'single' && !!pool && !dlmm && !isSolana() && !full && shape !== 'spot';
  const ready = (mode === 'single' || damm) && !evmShape && (creating ? C.ok : !!pool) && Number.isFinite(usdNum) && usdNum > 0 && rangeOk;
  const onOpened = useCallback(() => { reloadStatus(); loadBalance(pool?.poolRef); }, [reloadStatus, loadBalance, pool?.poolRef]);
  const ladder = useLadder({ pool, usdNum: Number.isFinite(usdNum) ? usdNum : 0, enabled: !creating && !damm && mode === 'ladder', onOpened });
  const shaped = useLadder({ pool, usdNum: Number.isFinite(usdNum) ? usdNum : 0, enabled: evmShape && rangeOk, onOpened,
    shapeSpec: evmShape && rangeOk ? { shape, lowerPct: -lo, upperPct: up } : null });
  const L = creating || damm ? null : mode === 'ladder' ? ladder : evmShape ? shaped : null;
  const stepsDone = L ? L.ready : ready;
  const range = full || damm ? { full: true } : { lowerPct: -lo, upperPct: up };
  const body = creating
    ? { ...C.spec, usd: usdNum, ...range, ...(dlmm ? { strategy: shape } : {}) }
    : { poolRef: pool?.poolRef, usd: usdNum, ...range, ...(dlmm ? { strategy: shape } : {}) };
  // Previews are tagged with what they were made for, so a late reply for another pool is not shown.
  const planRef = creating ? `create:${C.key}` : pool?.poolRef;

  // The preview is recomputed by itself every time a choice changes — there is no "compute"
  // button. Replies that arrive late are discarded via a sequence number.
  useEffect(() => {
    setConfirm(false);
    if (!ready) { setPlan(null); return; }
    const mine = ++seq.current;
    setCompute(true);
    const id = setTimeout(async () => {
      const r = await post(creating ? '/api/manual/create/plan' : '/api/manual/lp/plan', body);
      if (mine !== seq.current) return;
      setPlan({ ...r, _ref: planRef }); setCompute(false);
    }, 350);
    return () => { clearTimeout(id); };
  }, [pool?.poolRef, usdNum, lo, up, full, ready, dlmm, damm, shape, creating, C.key]);

  const cash = plan?.preview?.walletCashUsd ?? balance?.walletCashUsd ?? null;
  // The largest amount that still passes every limit — so the "Max" button does not
  // lead to a rejection.
  const maxVal = useMemo(() => {
    const s = rules?.rules?.sizing;
    if (!s) return null;
    const leftoverTotal = s.max_total_exposure_usd - (status?.summary?.exposureUsd || 0);
    const limit = [s.max_quote_per_position_usd, leftoverTotal, cash ?? Infinity].filter((x) => Number.isFinite(x));
    const v = Math.floor(Math.min(...limit) * 100) / 100;
    return v > 0 ? v : 0;
  }, [rules, status, cash]);

  const open = async () => {
    setSending(true);
    const r = await post(creating ? '/api/manual/create/open' : '/api/manual/lp/open', body);
    setSending(false); setConfirm(false);
    if (r.error) return toast.danger(r.error);
    setResult(r);
    toast.success(t(creating ? 'Pool dibuat dan posisi dibuka' : 'Posisi dibuka'));
    reloadStatus();
    loadBalance(pool?.poolRef);
  };

  const p = plan?.preview;
  // Current price (in the quote asset) from the last preview FOR THIS POOL — used to
  // show each bound's price while the user types, before a new preview arrives.
  const pNow = p && plan._ref === planRef ? p : null;
  const currentPrice = pNow ? tickPrice(pNow.curTick, pNow.dec0, pNow.dec1, pNow.quoteSide) : null;
  const symQ = pNow ? (pNow.quoteSide === 0 ? pNow.symbol0 : pNow.symbol1) : null;
  // A range entirely on one side of the price is only filled with one token: below =
  // the quote asset, above = its pair token.
  const oneSide = !full && !damm && rangeOk ? (up <= 0 ? 'bawah' : lo >= 0 ? 'atas' : null) : null;
  const sidePool = creating ? pNow : pool;
  const symSetor = oneSide && sidePool
    ? (((sidePool.quoteSide ?? 1) === 0) === (oneSide === 'bawah') ? sidePool.symbol0 : sidePool.symbol1) : null;
  // The preview carries the "after opening" balance; while it does not exist, use
  // our own reading — only if for the same pool, so the pair token is not wrong.
  const pReady = pNow && ready && !plan?.error ? pNow : null;
  const shownBalance = pReady?.saldo || (balance && balance._ref === ((creating ? null : pool?.poolRef) || null) ? balance : null);
  const dry = status?.mode?.dry_run !== false;

  if (result) {
    return (
      <>
        <PageHeader group="Aksi" title="LP manual" />
        <Card>
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t(creating ? 'Pool dibuat dan posisi dibuka' : 'Posisi dibuka')}</div>
              <div className="mt-1 text-muted">{result.note}</div>
              <div className="mono mt-2 text-sm text-muted">{result.tx}</div>
            </div>
            <div className="flex gap-2">
              <Button onPress={() => { location.hash = 'positions'; }}>{t('Lihat posisi')}</Button>
              <Button variant="outline" onPress={() => { setResult(null); setNotional(''); }}>{t('Buka satu lagi')}</Button>
            </div>
          </Card.Content>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader group="Aksi" title="LP manual"
        desc="Membuka posisi sendiri, di luar penyalinan target. Jalur eksekusinya sama: kas dijembatani, token ditukar seperlunya, lalu mint." />

      {dry && (
        <Notice status="warning" title={t('Mode simulasi')}>
          {t('Pratinjau tetap dihitung, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau membuka posisi.')}
        </Notice>
      )}

      <div className="mt-4 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <Step n={1} title={creating ? 'Buat pool baru' : 'Pilih pool'} done={creating ? C.ok : !!pool}
            action={(
              <div className="flex items-center gap-2">
                {!creating && pool && !swapPool && <Button size="sm" variant="outline" onPress={() => setSwapPool(true)}>{t('Ganti')}</Button>}
                <Segmented size="sm" aria="Sumber pool" value={creating ? 'create' : 'pick'}
                  onChange={(v) => { setCreating(v === 'create'); if (v === 'create') { setMode('single'); setShape('spot'); } }}
                  options={[['pick', 'Pool yang ada'], ['create', 'Buat baru']]} />
              </div>
            )}>
            {creating ? <CreatePoolStep C={C} /> : pools === null ? <Spinner /> : pool && !swapPool ? (
              <div className="flex items-center gap-3">
                <TokenPair token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} size={30} />
                <div className="min-w-0">
                  <div className="text-base font-semibold"><PairName token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} pool={pool.poolRef} sep="/" /></div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <span>{t(VENUE_LABEL[venueKey(pool)] || pool.venue.toUpperCase())}</span><span>·</span>
                    <span>{pool.dynamicFee ? t('fee dinamis') : t('fee {p}%', { p: num(pool.feePct, 2) })}</span><span>·</span>
                    {pool.hasHooks && <><span className="text-warning">{t('pakai hook')}</span><span>·</span></>}
                    <span>{pool.lastTs ? t('aksi terakhir {a}', { a: ago(pool.lastTs) }) : t('belum ada aksi terpantau')}</span>
                  </div>
                </div>
              </div>
            ) : null}
            {!creating && pool && !swapPool && <HookInfo hook={pool.hook} rules={rules} />}
            {creating || pools === null || (pool && !swapPool) ? null : (
              <PoolPicker pools={pools} onPick={(x) => { setPool(x); setSwapPool(false); }} />
            )}
          </Step>

          <Step n={2} title="Nominal" done={stepsDone}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xl text-muted">$</span>
                <input value={notional} onChange={(e) => setNotional(e.target.value.replace(/[^\d.,]/g, ''))}
                  inputMode="decimal" placeholder="0" aria-label={t('Nominal posisi')}
                  className="num h-11 w-44 rounded-md border border-field-border bg-surface px-3 text-xl font-semibold outline-none focus:border-accent" />
              </div>
              {/* "Max" is computed from the limit that actually applies, so pressing it never
                  leads to a rejection. A value that happens to equal one of the quick choices
                  is dropped so it is not duplicated. */}
              <Chips value={usdNum} onPick={(v) => setNotional(String(v))}
                options={[25, 50, 100, 200].filter((v) => !maxVal || v < maxVal).map((v) => [v, `$${v}`])
                  .concat(maxVal > 0 ? [[maxVal, t('Maks {v}', { v: usd(maxVal, 0) })]] : [])} />
              <p className="text-xs text-muted">
                {t('Nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.')}
              </p>
              <Balance saldo={shownBalance} pool={creating ? pNow : pool} />
              {(mode === 'single' || damm) && pReady?.swaps && <AutoSwap p={pReady} />}
            </div>
          </Step>

          <Step n={3} title="Rentang harga" done={stepsDone}
            action={creating || damm ? null : <Segmented size="sm" aria="Mode rentang" value={mode} onChange={setMode}
              options={[['single', 'Satu rentang'], ['ladder', 'Berlayer']]} />}>
            {damm ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">{t('DAMM v2 tidak memakai rentang per posisi: setiap posisi memakai rentang pool itu sendiri, jadi likuiditas & fee dibagi rata dengan LP lain di rentang yang sama.')}</p>
                {p?.compounding && <p className="text-xs text-muted">{t('Pool ini model compounding: fee langsung menambah cadangan pool, bukan diklaim terpisah.')}</p>}
                {p && (
                  <div className="rounded-md border border-border p-3">
                    <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1}
                      quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />
                  </div>
                )}
              </div>
            ) : mode === 'ladder' ? (
              <LadderStep L={ladder} chart={pool && (
                <ChartRange pool={pool} lo={-ladder.botN} up={-ladder.topN} full={false} rangeOk={ladder.rangeOk} currentPrice={null}
                  preview={null} bands={ladder.bands}
                  onDrag={(a, b) => { ladder.setBottom(String(Math.min(99.9, Math.max(0, -a)))); ladder.setTop(String(Math.max(0, -b))); }} />
              )} />
            ) : (
            <div className="flex flex-col gap-3">
              {(dlmm || (!creating && pool && !isSolana() && !full)) && <ShapePicker value={shape} onChange={setShape} evm={!dlmm} />}
              {evmShape && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{t('Jumlah posisi')}</span>
                  <Segmented size="sm" aria="Jumlah posisi" value={shaped.layers} onChange={shaped.setLayers} options={LAYER_CHOICES.map((n) => [n, String(n)])} />
                </div>
              )}
              {dlmm && p && !plan?.error && <BinDistribution p={p} />}
              {!creating && pool && (
                <ChartRange pool={pool} lo={lo} up={up} full={full} rangeOk={rangeOk} currentPrice={currentPrice}
                  preview={pReady && !compute ? pReady : null} bands={evmShape ? shaped.bands : null}
                  onDrag={(a, b) => {
                    setFull(false);
                    setLower(String(Math.abs(a))); setDirDown(a > 0 ? 1 : -1);
                    setUpper(String(Math.abs(b))); setDirUp(b < 0 ? -1 : 1);
                  }} />
              )}
              <Chips value={full ? 'full' : PRESET.find(([a, b]) => a === lo && b === up)?.[2]}
                onPick={(v) => {
                  if (v === 'full') return setFull(true);
                  const [a, b] = PRESET.find((x) => x[2] === v);
                  setFull(false);
                  setLower(String(Math.abs(a))); setDirDown(a > 0 ? 1 : -1);
                  setUpper(String(Math.abs(b))); setDirUp(b < 0 ? -1 : 1);
                }}
                options={[...PRESET.map(([, , l]) => [l, t(l)]), ['full', t('Seluruh rentang')]]} />
              <p className="text-xs text-muted">{t('Klik tanda −/+ untuk memindah batas ke sisi lain harga kini. Rentang yang seluruhnya di bawah harga (misal −30% sampai −10%) hanya diisi aset kuotasi seperti USDG; yang seluruhnya di atas hanya diisi tokennya.')}</p>
              {/* Free bounds: typing in either box automatically leaves "whole range". */}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Limit label="Batas bawah" aria="Batas bawah dari harga kini (persen)" direction={dirDown} value={full ? '' : lower} disabled={false}
                  onArah={(a) => { setFull(false); setDirDown(a); }}
                  onChange={(v) => { setFull(false); setLower(v); }} invalid={loBad || inverted}
                  harga={currentPrice != null && !full && !loBad ? currentPrice * (1 + lo / 100) : null} sym={symQ} />
                <Limit label="Batas atas" aria="Batas atas dari harga kini (persen)" direction={dirUp} value={full ? '' : upper} disabled={false}
                  onArah={(a) => { setFull(false); setDirUp(a); }}
                  onChange={(v) => { setFull(false); setUpper(v); }} invalid={upBad || inverted}
                  harga={currentPrice != null && !full && !upBad ? currentPrice * (1 + up / 100) : null} sym={symQ} />
              </div>
              {(loBad || upBad || empty || inverted) && (
                <p className="text-xs text-danger">{t(loBad ? 'Batas bawah harus di atas −100% — turun 100% berarti harga nol.'
                  : upBad ? 'Batas atas harus di atas −100% dan maksimal +100.000%.'
                    : inverted ? 'Batas atas harus lebih tinggi dari batas bawah.' : 'Isi batas bawah atau batas atas.')}</p>
              )}
              {oneSide && (
                <p className="text-xs text-muted">
                  {t(oneSide === 'bawah'
                    ? 'Satu sisi di bawah harga kini: hanya {s} yang disetor. Fee mulai saat harga turun masuk rentang.'
                    : 'Satu sisi di atas harga kini: hanya {s} yang disetor. Fee mulai saat harga naik masuk rentang.',
                  { s: symSetor || t('satu token') })}
                </p>
              )}
              {!full && p && !plan?.error && (Math.abs(-p.lowerPct - lo) >= 0.05 || Math.abs(p.upperPct - up) >= 0.05) && (
                <p className="text-xs text-muted">{t(p.nativeUnit === 'bin' ? 'Dibulatkan ke bin pool: {a} / {b}.' : 'Dibulatkan ke tick pool: {a} / {b}.', { a: flagged(-p.lowerPct), b: flagged(p.upperPct) })}</p>
              )}
              <p className="text-xs text-muted">
                {t('Fee hanya mengalir selama harga ada di dalam rentang. Sempit = fee lebih besar tapi lebih cepat keluar; lebar = lebih aman tapi encer.')}
              </p>
              {p && (
                <div className="rounded-md border border-border p-3">
                  <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1}
                    quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />
                </div>
              )}
            </div>
            )}
          </Step>
        </div>

        {/* pratinjau */}
        <Card className="gap-0! p-0! lg:sticky lg:top-4">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{t('Pratinjau')}</h2>
            {(L ? L.compute : compute) && <Spinner size="sm" />}
          </div>
          <div className="flex flex-col gap-4 p-4">
            {L ? <LadderPreview L={L} dry={dry} /> : !ready ? (
              <p className="text-sm text-muted">{t(creating ? 'Isi pengaturan pool, harga awal, dan nominalnya — pratinjau muncul sendiri.' : 'Pilih pool dan isi nominalnya — pratinjau muncul sendiri.')}</p>
            ) : plan?.error ? (
              <Notice status="danger" title={t('Belum bisa dibuka')}>{plan.error}</Notice>
            ) : !p ? <Spinner /> : (
              <>
                <div>
                  <div className="text-xs text-muted">{t('Nilai posisi')}</div>
                  <div className="num text-[1.5rem] leading-tight font-semibold tracking-tight">{usd(p.valueUsd)}</div>
                </div>
                <div className="divide-y divide-border border-y border-border">
                  <KV label={p.symbol0}>{num(Number(p.amount0) / 10 ** p.dec0, 6)}</KV>
                  <KV label={p.symbol1}>{num(Number(p.amount1) / 10 ** p.dec1, 6)}</KV>
                  {p.swaps && <KV label="Auto-swap">{swapQty(p.swaps.length, t)}</KV>}
                  <KV label="Kas setelah dibuka">{usd(Math.max(0, p.walletCashUsd - p.valueUsd))}</KV>
                  {p.init && <KV label="Harga awal pool">{price(p.init.price)} {symQ}</KV>}
                </div>

                {(plan.warnings || []).map((w) => (
                  <div key={w} className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-sm text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{w}</span>
                  </div>
                ))}

                <p className="text-xs text-muted">
                  {t('Posisi ini tidak mencermin siapa pun — ia tidak akan ikut ditutup saat target keluar.')}
                </p>

                {/* In simulation mode the button is NOT just disabled: a dead button with no way
                    out only makes the user guess. It turns into a shortcut to the place that can
                    change the situation. */}
                {dry ? (
                  <Button variant="outline" className="w-full" onPress={() => { location.hash = 'settings'; }}>
                    {t('Nyalakan LIVE dulu')}
                  </Button>
                ) : !confirm ? (
                  <Button className="w-full" onPress={() => setConfirm(true)}>
                    {t(creating ? 'Buat pool & buka {v}' : 'Buka posisi {v}', { v: usd(p.valueUsd) })}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
                    <div className="text-sm text-muted">{t('{v} ke {pair}, rentang {r}.', { v: usd(p.valueUsd), pair: p.pair, r: damm ? t('rentang pool') : rangeLabel(lo, up, full, t) })}</div>
                    {p.init && <div className="text-sm text-muted">{t('Pool baru {venue}, harga awal {px} {q}.', { venue: t(VENUE_LABEL[p.create?.venue] || String(p.create?.venue || '').toUpperCase()), px: price(p.init.price), q: symQ || '' })}</div>}
                    <div className="flex gap-2">
                      <Button className="flex-1" onPress={open} isPending={sendOrig}>{t('Ya, buka sekarang')}</Button>
                      <Button variant="outline" onPress={() => setConfirm(false)}>{t('Batal')}</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
