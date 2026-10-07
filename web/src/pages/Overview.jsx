import { useCallback, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { useStatus } from '../App';
import { usePoll, useResync } from '../hooks';
import { PageHeader, Stat, Hero, HeroFigure, Panel, Empty, Loading, Notice, KV, Dot, DataTable, PriceRange, Segmented, Refresh, Fx, WalletLinks, baseTokenOf } from '../components/ui';
import PnlCalendar from '../components/PnlCalendar';
import GrowthChart from '../components/GrowthChart';
import ShareButton, { ShareDialog, totalCard, dailyCard } from '../components/ShareCard';
import { tokenColumn } from '../components/TokenCell';
import { Pair, SyncState, FeeCell } from './Positions';
import { GmgnProvider } from '../components/GmgnDot';
import PositionHistory from '../components/PositionHistory';
import { usd, kUsd, tone, num, pct, age, ago, short, txHref, aprOf, aprText, locale as fmtLocale, TXKIND, TXSTATUS } from '../fmt';
import { isHidden, MASK } from '../privacy';
import { useI18n, reason } from '../i18n';
import { useClosePosition } from '../useClosePosition';
import { canonAddr } from '../chain';

const RANGES = [['24h', '24 jam'], ['7d', '7 hari'], ['30d', '30 hari'], ['all', 'Semua']];
const VIEWS = [['pnl', 'PnL kumulatif'], ['value', 'Nilai']];
// Net PnL only exists if the wallet capital is tracked (deposits/withdrawals from RPC).
const VIEWS_NET = [['net', 'PnL bersih'], ...VIEWS];
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);

// Bridge cumulative PnL → net PnL. Two "PnL" figures that differ by $20-ish without
// explanation read as a bug. The difference is costs paid from the wallet outside
// positions: gas (computed from the txs table) and the rest — swap slippage, movement of
// the ETH price being held — which cannot be separated one by one.
function PnlGap({ p }) {
  const { t } = useI18n();
  const n = p.now, c = p.capital;
  if (n.netPnl == null) return null;
  const gas = n.gasUsd || 0;
  const slip = -(n.slipUsd || 0);                 // measured from swap quotes; a cost, so negative
  const other = n.netPnl - (n.pnl - gas) - slip;  // what is left once gas and slippage are explained
  const signed = (v) => `${v > 0.005 ? '+' : ''}${usd(v)}`;
  const Row = ({ label, sub, v, strong }) => (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? 'font-medium' : ''}`}>
      <span className="min-w-0">{t(label)}{sub && <span className="ml-2 text-xs text-muted">{sub}</span>}</span>
      <span className={`num shrink-0 ${tone(v)}`}>{signed(v)}</span>
    </div>
  );
  return (
    <details className="group mt-4 border-t border-border pt-3 text-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 [&::-webkit-details-marker]:hidden">
        <span className="font-medium">
          <span className="mr-1.5 inline-block text-muted transition-transform group-open:rotate-90">›</span>
          {t('Kenapa PnL kumulatif dan PnL bersih berbeda?')}
        </span>
        <span className="num text-xs text-muted">
          {t('{a} − gas {g} − slippage {s} {o} = {b}', { a: usd(n.pnl), g: usd(gas), s: usd(-slip), o: `${other < 0 ? '−' : '+'} ${usd(Math.abs(other))}`, b: usd(n.netPnl) })}
        </span>
      </summary>
      <div className="mt-2 max-w-2xl pl-4">
        <p className="text-xs text-muted">
          {t('PnL kumulatif menjumlahkan hasil tiap posisi: hasil keluar dikurangi modal posisi itu. PnL bersih membandingkan nilai wallet sekarang dengan modal, jadi semua yang dibayar dari wallet di luar posisi ikut terhitung. PnL bersih adalah untung yang benar-benar bertambah.')}
        </p>
        <div className="mt-2 divide-y divide-border">
          <Row label="PnL kumulatif (hasil posisi)" v={n.pnl} />
          <Row label="Gas" sub={t('{n} transaksi, termasuk yang gagal', { n: num(n.gasTxCount || 0) })} v={-gas} />
          <Row label="Slippage swap" sub={t('terukur dari kuotasi swap')} v={slip} />
          <Row label="Pergerakan harga ETH & lainnya" sub={t('sisa selisih')} v={other} />
          <Row label="PnL bersih" v={n.netPnl} strong />
        </div>
        {c && (
          <p className="mt-2 text-xs text-muted">
            {t('Modal {m} = isi wallet saat bot mulai mencatat ({d}) {b} + dana masuk {i}', {
              m: usd(n.capitalNet), d: new Date(c.baselineTs).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
              b: usd(c.baselineUsd), i: usd(c.depositsUsd),
            })}
            {c.withdrawalsUsd > 0.005 && t(' − penarikan {w}', { w: usd(c.withdrawalsUsd) })}
            {'. '}
            {t('Transfer masuk setelah bot mulai mencatat — termasuk pengisian dana awal — dihitung sebagai modal, bukan untung.')}
          </p>
        )}
      </div>
    </details>
  );
}

// Where the money is. The main question for an LP bot: what share of funds is really
// working in positions, what share is idle as cash. A single stacked bar (parts of the
// whole) with two colour families — blue = working, grey = cash — and the list
// grouped the same. Each slice's identity is not from colour alone: every row
// has its colour box, and highlighting a row/slice lights up the other.
function Composition({ now, ethUsd }) {
  const { t } = useI18n();
  const [hot, setHot] = useState(null);
  const c = now.cash;
  const ethVal = c ? (c.usd - c.usdg) : 0;            // ETH+WETH value when the cash was read
  const perEth = c && c.eth + c.weth > 0 ? ethVal / (c.eth + c.weth) : ethUsd;
  const tint = (base, pct) => `color-mix(in oklab, ${base} ${pct}%, var(--surface))`;
  const working = [
    { k: 'Posisi LP', v: now.positionsUsd, sub: t('{n} posisi · {r} in-range', { n: now.openCount, r: now.inRange }), color: tint('var(--accent)', 100) },
    { k: 'Fee belum diklaim', v: now.feeUsd, color: tint('var(--accent)', 62) },
    { k: 'Token sisa belum dijual', v: now.leftoverUsd || 0, color: tint('var(--accent)', 38) },
  ].filter((r, i) => i === 0 || r.v > 0.005);
  const idle = c ? [
    { k: 'USDG', v: c.usdg },
    { k: 'WETH', v: c.weth * perEth, sub: `${isHidden() ? MASK : num(c.weth, 5)} WETH` },
    { k: 'ETH', v: c.eth * perEth, sub: `${isHidden() ? MASK : num(c.eth, 5)} ETH` },
  ].filter((r) => r.v > 0.005).sort((x, y) => y.v - x.v).map((r, i) => ({ ...r, color: tint('var(--foreground)', [36, 24, 15][i] ?? 15) })) : [];
  const all = [...working, ...idle];
  const total = Math.max(1e-9, sum(all, (r) => r.v));
  const workUsd = sum(working, (r) => r.v), idleUsd = sum(idle, (r) => r.v);
  const share = (v) => (v / total) * 100;
  const fmtPct = (v) => `${num(share(v), share(v) < 10 ? 1 : 0)}%`;
  const dimmed = (k) => hot != null && hot !== k;

  // an ordinary render function, not a component: a component recreated on every render would
  // be remounted when the highlight changes and its hover would flicker
  const item = (r) => (
    <div key={r.k} className={`flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm transition-colors ${hot === r.k ? 'bg-default/60' : ''}`}
      onMouseEnter={() => setHot(r.k)} onMouseLeave={() => setHot(null)}>
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: r.color }} />
      <span className="min-w-0 flex-1 truncate">{t(r.k)}{r.sub && <span className="ml-1.5 text-xs text-muted">{r.sub}</span>}</span>
      {/* The rupiah goes under the dollar, not beside it: this column is only a third of
          the screen, and putting both side by side eats the label space until
          "Posisi LP" shrinks to "P.". */}
      <span className="flex shrink-0 flex-col items-end leading-tight">
        <span className="num font-medium">{usd(r.v)}</span>
        <Fx v={r.v} className="text-[0.6875rem]" />
      </span>
      <span className="num w-11 shrink-0 text-end text-xs text-muted">{fmtPct(r.v)}</span>
    </div>
  );
  const group = (label, v, rows) => (
    <div className="pt-2.5">
      <div className="flex items-baseline gap-2.5 px-1.5 pb-0.5 text-xs">
        <span className="flex-1 font-medium text-muted">{t(label)}</span>
        <span className="flex flex-col items-end leading-tight">
          <span className="num font-medium text-muted">{usd(v)}</span>
          <Fx v={v} className="text-[0.6875rem]" />
        </span>
        <span className="num w-11 text-end text-muted">{fmtPct(v)}</span>
      </div>
      {rows.map(item)}
    </div>
  );

  return (
    <div>
      {c && (
        <div className="flex items-end justify-between gap-3 pt-2">
          <div>
            <div className="text-2xl leading-tight font-semibold tracking-tight">{fmtPct(workUsd)}</div>
            <div className="text-xs text-muted">{t('dana bekerja di posisi')}</div>
          </div>
          <div className="text-end text-xs text-muted">
            {t('menganggur di kas')}
            <div className="num text-sm font-medium text-foreground">{usd(idleUsd)}</div>
            <Fx v={idleUsd} className="ml-0 block" />
          </div>
        </div>
      )}
      {/* batang bagian-dari-keseluruhan: celah 2px warna kartu memisahkan potongan */}
      <div className="mt-3 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img"
        aria-label={all.map((r) => `${t(r.k)} ${fmtPct(r.v)}`).join(', ')}>
        {all.filter((r) => r.v > 0).map((r) => (
          <div key={r.k} title={`${t(r.k)} · ${usd(r.v)} · ${fmtPct(r.v)}`}
            onMouseEnter={() => setHot(r.k)} onMouseLeave={() => setHot(null)}
            className="h-full transition-opacity first:rounded-l-full last:rounded-r-full"
            style={{ flexGrow: r.v, flexBasis: 0, minWidth: 3, background: r.color, opacity: dimmed(r.k) ? 0.35 : 1 }} />
        ))}
      </div>
      <div className="-mx-1.5 mt-1">
        {group('Di posisi', workUsd, working)}
        {c ? group('Kas', idleUsd, idle)
          : <p className="mt-3 px-1.5 text-xs text-muted">{t('Saldo kas tidak terbaca (belum ada wallet) — total hanya berisi posisi.')}</p>}
      </div>
      <div className="mt-2 divide-y divide-border border-t border-border">
        {now.capitalNet != null
          // real capital: baseline + deposits − withdrawals (capital.js) — the same as the net PnL card
          ? <KV label="Modal bersih" fx={now.capitalNet}><span title={t('Nilai wallet saat bot mulai mencatat + setoran − penarikan')}>{usd(now.capitalNet)}</span></KV>
          : now.capital != null && (
          <KV label="Modal bersih" fx={now.capital}><span title={t('Nilai sekarang dikurangi seluruh PnL — kira-kira dana yang disetor ke wallet bot')}>{usd(now.capital)}</span></KV>
        )}
        <KV label="Modal di posisi" fx={now.costUsd}>{usd(now.costUsd)}</KV>
      </div>
    </div>
  );
}

// Performance per source: which targets really earn after being copied.
// Diverging bars from a single zero line — profit to the right (green), loss to the left
// (red) — so a losing source reads as a loss, not as a short bar.
function BySource({ rows }) {
  const { t } = useI18n();
  if (!rows.length) return <div className="p-4"><Empty title="Belum ada posisi" /></div>;
  const tots = rows.map((r) => r.net ?? r.realized + r.upnl);   // net of gas and slippage
  const maxPos = Math.max(0, ...tots), maxNeg = Math.max(0, ...tots.map((v) => -v));
  const span = Math.max(1e-9, maxPos + maxNeg);
  const zero = (maxNeg / span) * 100;   // position of the zero line in percent of the width
  return (
    <div className="divide-y divide-border">
      {rows.map((r, i) => {
        const tot = tots[i];
        const wr = r.closed ? (r.wins / r.closed) * 100 : null;
        const w = (Math.abs(tot) / span) * 100;
        const running = Math.abs(r.upnl) > 0.005;
        return (
          <div key={r.target || 'manual'} className="px-4 py-2 text-sm">
            <div className="flex items-baseline gap-3">
              <div className="min-w-0 flex-1 truncate">
                {r.target
                  ? <a href={'#targets/' + r.target} className="font-medium hover:underline">{r.label || <span className="mono">{short(r.target)}</span>}</a>
                  : <span className="font-medium">{t('Manual / di luar bot')}</span>}
                <span className="ml-2 text-xs text-muted">
                  {t('{c} ditutup', { c: r.closed })}{r.open > 0 && <> · {t('{o} terbuka', { o: r.open })}</>}
                  {wr != null && <> · {t('menang {p}%', { p: num(wr, 0) })}</>}
                </span>
              </div>
              {running && <span className="num shrink-0 text-xs text-muted" title={t('PnL posisi yang masih terbuka')}>{t('berjalan {v}', { v: `${r.upnl > 0 ? '+' : ''}${usd(r.upnl)}` })}</span>}
              <div className={`num shrink-0 font-semibold ${tone(tot)}`}>{tot > 0.005 ? '+' : ''}{usd(tot)}</div>
            </div>
            <div className="relative mt-1.5 h-1 rounded-full bg-default">
              {maxNeg > 0 && <div className="absolute inset-y-[-3px] w-px bg-muted/60" style={{ left: `${zero}%` }} />}
              <div className={`absolute inset-y-0 rounded-full ${tot >= 0 ? 'bg-success' : 'bg-danger'}`}
                style={tot >= 0 ? { left: `${zero}%`, width: `${Math.max(w, tot > 0.005 ? 1 : 0)}%` } : { right: `${100 - zero}%`, width: `${Math.max(w, 1)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Closed positions summary: four figures in a grid, not a long list of labels.
function ClosedStats({ st }) {
  const { t } = useI18n();
  const cells = [
    ['Posisi terbaik', <span className={tone(st.best)}>{st.best > 0.005 ? '+' : ''}{usd(st.best)}</span>],
    ['Posisi terburuk', <span className={tone(st.worst)}>{usd(st.worst)}</span>],
    ['Rata-rata per posisi', <span className={tone(st.avgPnl)}>{st.avgPnl > 0.005 ? '+' : ''}{usd(st.avgPnl)}</span>],
    ['Rata-rata ditahan', age(st.avgHoldHours)],
  ];
  return (
    <div className="grid grid-cols-2 gap-px bg-border">
      {cells.map(([k, v]) => (
        <div key={k} className="bg-surface px-4 py-3">
          <div className="text-xs text-muted">{t(k)}</div>
          <div className="num mt-0.5 text-base font-semibold tracking-tight">{v}</div>
        </div>
      ))}
    </div>
  );
}

// Eight millisecond figures side by side cannot be read at a glance. What the eye looks for:
// "is the RPC healthy?" — so show the median, and the rest in a tooltip.
// Remaining copy quota: the room still left under each general rule ceiling. A full bar =
// ceiling used up — the next position will be skipped for that reason.
function CopyRoom({ room, dryRun }) {
  const { t } = useI18n();
  const bar = ({ label, used, limit, left, fmt = usd, sub }) => {
    const p = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const full = limit > 0 && left <= 0;
    return (
      <div key={label} className="py-2.5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="min-w-0 text-muted">{t(label)}</span>
          <span className={`num shrink-0 font-medium ${full ? 'text-danger' : ''}`}>{full ? t('habis') : t('sisa {v}', { v: fmt(left) })}</span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-default/60" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${full ? 'bg-danger' : p >= 80 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${p}%` }} />
        </div>
        <div className="mt-1 text-xs text-muted">{sub || t('{u} dari {l}', { u: fmt(used), l: fmt(limit) })}</div>
      </div>
    );
  };
  return (
    <div className="divide-y divide-border px-4">
      {bar({ label: 'Anggaran harian', ...room.daily, sub: t('{u} dari {l} · dibuka 24 jam terakhir', { u: usd(room.daily.used), l: usd(room.daily.limit) }) })}
      {bar({ label: 'Eksposur total', ...room.exposure })}
      {bar({ label: 'Slot posisi', ...room.slots, fmt: (v) => num(v) })}
      <KV label="Batas per posisi">{usd(room.perPositionUsd)}</KV>
      <KV label="Kas siap pakai">
        {room.cashUsd != null
          ? <span title={t('Kas di atas cadangan gas — posisi baru diukur dari sini')}>{usd(room.cashUsd)}</span>
          : <span className="text-muted">{dryRun ? t('tidak dibatasi (simulasi)') : '—'}</span>}
      </KV>
    </div>
  );
}

function Latency({ rpc }) {
  const { t } = useI18n();
  const ms = rpc.map((r) => r.lastMs).filter((x) => x != null).sort((a, b) => a - b);
  if (!ms.length) return <span className="text-muted">—</span>;
  const med = ms[Math.floor(ms.length / 2)];
  const cooling = rpc.filter((r) => r.cooling).length;
  const heading = rpc.map((r) => `${r.host} · ${r.lastMs} ms${r.cooling ? ' · istirahat' : ''}${r.errors ? ` · ${r.errors} error` : ''}`).join('\n');
  return (
    <span title={heading}>
      {t('{n} ms', { n: med })}
      <span className="ml-1.5 font-normal text-muted">{t('median · {n} RPC', { n: rpc.length })}</span>
      {cooling > 0 && <span className="ml-1.5 font-normal text-warning">{t('{n} istirahat', { n: cooling })}</span>}
    </span>
  );
}

// PnL per day is grouped in the browser so the "day" follows the user's time zone,
// not the server's time zone.
function dailyOf(closed) {
  const daily = {}, counts = {};
  const pad = (n) => String(n).padStart(2, '0');
  for (const [ts, v] of closed) {
    const d = new Date(ts);
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    daily[k] = (daily[k] || 0) + v;
    counts[k] = (counts[k] || 0) + 1;
  }
  return { daily, counts };
}

// The pool's swap volume (DexScreener) — this is where fees come from. Without this figure
// the Fee $0.00 column cannot be read: a quiet pool, or a position out of range?
// 24 hours for the pool's size, 1 hour because a position opened 20 minutes ago
// did not enjoy yesterday's volume.
function VolCell({ pair }) {
  const { t } = useI18n();
  const v = pair?.volume;
  if (!pair) return <span className="text-muted">—</span>;
  if (v?.h24 == null) return <span className="text-muted" title={t('Pool ini belum terindeks di DexScreener.')}>—</span>;
  return (
    <div className="whitespace-nowrap" title={t('Volume swap pool ini menurut DexScreener, bukan volume token di seluruh pool.')}>
      {kUsd(v.h24)}
      {v.h1 != null && <div className="text-xs text-muted">{t('1 jam {v}', { v: kUsd(v.h1) })}</div>}
    </div>
  );
}

// How big the pool is, and how big we are in it. Two $120 LPs that
// look the same are not the same at all: one holds 0.1% of a $4 million deep pool,
// the other 12% of a $1,000 pool — the second moves its own price when it exits.
function LiqCell({ pair, p }) {
  const { t } = useI18n();
  const liq = pair?.liquidityUsd;
  if (!pair) return <span className="text-muted">—</span>;
  if (liq == null) return <span className="text-muted" title={t('Pool ini belum terindeks di DexScreener.')}>—</span>;
  // Our share = the position value against the pool's whole liquidity. Rough: DexScreener
  // counts everything in the pool, not just the liquidity active in the current
  // price range — so our real share of the fees can be larger than this figure.
  const share = liq > 0 && p.valueUsd > 0 ? (p.valueUsd / liq) * 100 : null;
  return (
    <div className="whitespace-nowrap" title={t('Seluruh isi pool menurut DexScreener. Bagian kita dihitung dari nilai posisi terhadap angka itu — bukan terhadap likuiditas yang aktif di rentang harga sekarang.')}>
      {kUsd(liq)}
      {share != null && <div className={`text-xs ${share >= 5 ? 'text-warning' : 'text-muted'}`}>{t('bagian kita {v}', { v: pct(share, share < 1 ? 2 : 1).replace('+', '') })}</div>}
    </div>
  );
}

export default function Overview() {
  const { t } = useI18n();
  const { status: d } = useStatus();
  // Initial range: the whole history. The first question people bring to this page
  // is "how much profit since the beginning", not the last week.
  const [range, setRange] = useState('all');
  // Initial view: net PnL if capital is tracked; otherwise cumulative PnL.
  const [viewPick, setView] = useState('net');
  const [shareDay, setShareDay] = useState(null);   // the 'YYYY-MM-DD' clicked in the calendar
  const { data: p, reload: reloadPortfolio } = usePoll('/api/portfolio?range=' + range, 30000);
  // The same as the Positions page: a cheap endpoint, so a new position appears within ~5 seconds.
  const { data: pos, reload: reloadPos } = usePoll('/api/positions', 5000);
  // Click an active position row -> the same history drawer as the Positions page (PnL,
  // token composition, transactions); the token name still links to its token page.
  const [hist, setHist] = useState(null);
  const { data: tx } = usePoll('/api/txs', 10000);
  // Pool volume for the Volume column in the active positions table. The same endpoint as
  // the Monitor card (DexScreener, already memoised per pool on the server), so once
  // a minute is enough — this is market context, not a position figure that must tick.
  const pools = useMemo(() => [...new Set((pos?.positions || [])
    .filter((x) => !x.empty)
    .map((x) => canonAddr(x.pool_ref || ''))
    .filter(Boolean))].sort(), [pos]);
  const { data: mk } = usePoll(pools.length ? `/api/monitor/market?pools=${pools.join(',')}` : null, 60000);
  // One chain sync refreshes the WHOLE page, not just the table: the portfolio total
  // card and PnL are computed from the same sync result, and two figures for
  // the same thing with different ages on one screen is a visible bug.
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadPos(), reloadPortfolio()]);
  }, [reloadPos, reloadPortfolio]);
  const [resync, syncing] = useResync(reloadAll);
  // The emergency "force close all" button — the same as on the Positions page, used
  // from the summary so there is no need to switch pages first when the market moves fast.
  const { forceCloseAll, closing } = useClosePosition(reloadAll);
  if (!d) return <Loading page />;
  const s = d.summary, T = d.totals || {};
  // The cursor can slightly LEAD the chain head last read; that is sync,
  // not "lagging −19 blocks".
  const lag = Math.max(0, d.chain.lag);
  // Two minutes without a single successful scan is far outside the normal rhythm
  // (one cycle every 1.5 seconds) — that is no longer a slow RPC, it is stuck.
  const scanStale = !d.chain.lastScan || Date.now() - d.chain.lastScan > 120_000;
  const maxSkip = Math.max(1, ...(d.skipReasons || []).map((r) => r.n));
  const now = p?.now, st = p?.stats;
  const view = viewPick === 'net' && now?.netPnl == null ? 'pnl' : viewPick;
  const open = (pos?.positions || []).filter((x) => !x.empty);
  // A position not yet synced with the chain: the value is still the capital estimate, fee & PnL do not exist yet.
  const pendingSync = open.filter((x) => x.syncing).length;
  const dash = (x, node) => (x.syncing ? <span className="text-muted">—</span> : node);
  const pairOf = (x) => mk?.pairs?.[canonAddr(x.pool_ref || '')] || null;
  const cal = p ? dailyOf(p.closed) : null;
  // LP health is computed from the same position list as the table below, not
  // from the engine summary: two figures for the same thing with different ages on one
  // screen is a visible bug.
  const inRangeN = open.filter((x) => x.inRange).length;
  const outUsd = sum(open.filter((x) => x.inRange === false), (x) => x.valueUsd);
  const feeOpen = sum(open, (x) => (x.feeUsd || 0) + (x.claimedUsd || 0));
  const ilRows = open.filter((x) => x.ilUsd != null);
  const ilOpen = ilRows.length ? sum(ilRows, (x) => x.ilUsd) : null;
  const portApr = aprOf(open);


  return (
    <>
      <PageHeader group="Pemantauan" title="Ringkasan">
        <ShareButton label="Bagikan total PnL" isDisabled={!now} card={now ? totalCard({ pnl: now.netPnl ?? now.pnl, net: now.netPnl != null }) : null} />
      </PageHeader>
      {/* Daily PnL card: the day clicked in the calendar. The server assembles its data itself. */}
      <ShareDialog card={shareDay && cal ? dailyCard({ day: shareDay, pnl: cal.daily[shareDay] }) : null} onClose={() => setShareDay(null)} />
      <PositionHistory id={hist} onClose={() => setHist(null)} />
      {/* Simulation with a virtual balance (paper.js): where the virtual book stands. */}
      {d.mode.sim && (
        <div className="mb-4">
          <Notice title="Simulasi dengan saldo virtual">
            {t('saldo awal {s} · kas {c} · ekuitas {e} · profit {p} ({pp}) · {o} terbuka, {n} selesai', {
              s: usd(d.mode.sim.startUsd), c: usd(d.mode.sim.cashUsd), e: usd(d.mode.sim.equityUsd),
              p: usd(d.mode.sim.pnlUsd), pp: pct(d.mode.sim.pnlPct, 2), o: d.mode.sim.openCount, n: d.mode.sim.closedCount })}
          </Notice>
        </div>
      )}
      {/* One summary block, two tiers: the two numbers looked for every time the page is
          opened (what it is worth, how much profit) stand alone in a big card on the
          left; four LP health measures become tiles beside it. Four equally sized cards
          make "total portfolio" and "win rate" look equally important. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Hero className="col-span-2 lg:row-span-2">
          <HeroFigure label="Total portofolio" value={now ? usd(now.value) : '—'} fx={now?.value}
            sub={!now ? null : now.cash
              ? t('kas {c} · di posisi {p}', { c: usd(now.cash.usd), p: usd(now.positionsUsd + now.feeUsd) })
                + ((now.leftoverUsd || 0) > 0.005 ? t(' · sisa token {v}', { v: usd(now.leftoverUsd) }) : '')
              : t('hanya posisi — saldo kas tidak terbaca')} />
          {now?.netPnl != null
            // Wallet capital tracked: the main one is net PnL against the real capital; per-position
            // PnL (without zap/gas/swap costs) becomes the note.
            ? <HeroFigure className="border-t border-border pt-4 sm:pt-5" label="PnL bersih" value={usd(now.netPnl)} fx={now.netPnl} valueClass={tone(now.netPnl)}
              aside={now.capitalNet > 0 ? <span className={`num text-sm font-semibold ${tone(now.netPnl)}`}>{pct((now.netPnl / now.capitalNet) * 100, 2)}</span> : null}
              sub={t('modal {m} · PnL posisi {v}', { m: usd(now.capitalNet), v: usd(now.pnl) })} />
            : <HeroFigure className="border-t border-border pt-4 sm:pt-5" label="Total PnL" value={now ? usd(now.pnl) : '—'} fx={now?.pnl} valueClass={now ? tone(now.pnl) : ''}
              aside={now?.capital > 0 ? <span className={`num text-sm font-semibold ${tone(now.pnl)}`}>{pct((now.pnl / now.capital) * 100, 2)}</span> : null}
              sub={!now ? null : t('terealisasi {r} · berjalan {u}', { r: usd(now.realizedUsd), u: usd(now.unrealizedUsd) })} />}
        </Hero>
        {/* Fee without APR only gives the amount, not whether the capital is working. */}
        <Stat label="Fee terkumpul" value={usd(s.feeUsd)} fx={s.feeUsd}
          badge={portApr == null ? null : (
            <span className="num shrink-0 rounded bg-success/12 px-1.5 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap text-success"
              title={t('Fee seluruh posisi terbuka (termasuk yang sudah dipanen) disetahunkan terhadap modalnya')}>
              {t('APR {v}', { v: aprText(portApr) })}
            </span>)}
          sub={s.costUsd > 0 ? t('{p}% dari modal · belum diklaim', { p: num((s.feeUsd / s.costUsd) * 100, 2) }) : t('belum diklaim')} />
        {/* The core LP question: whether the fees earned cover the impermanent loss. */}
        <Stat label="Fee vs IL" value={ilOpen == null ? '—' : usd(feeOpen + ilOpen)} fx={ilOpen == null ? null : feeOpen + ilOpen}
          valueClass={ilOpen == null ? '' : tone(feeOpen + ilOpen)}
          sub={<span title={t('Fee posisi terbuka ditambah impermanent loss-nya: selisih terhadap sekadar memegang token yang sama tanpa ber-LP.')}>
            {ilOpen == null ? t('IL belum terhitung') : t('fee {f} · IL {i}', { f: usd(feeOpen), i: usd(ilOpen) })}
          </span>} />
        {/* Out-of-range positions stop earning fees — the number that decides
            whether something has to be done right now. */}
        <Stat label="Posisi in-range" value={open.length ? `${inRangeN}/${open.length}` : '—'}
          valueClass={!open.length ? '' : inRangeN === open.length ? 'text-success' : 'text-warning'}
          sub={!open.length ? t('belum ada posisi terbuka')
            : outUsd > 0.005 ? t('{v} di luar rentang — tidak menghasilkan fee', { v: usd(outUsd) })
              : t('semua posisi menghasilkan fee')} />
        <Stat label="Win rate" value={st?.winRatePct != null ? `${num(st.winRatePct, 0)}%` : '—'}
          valueClass={st?.winRatePct == null ? '' : st.winRatePct >= 50 ? 'text-success' : 'text-danger'}
          sub={!st ? null : st.closedCount
            ? t(st.flat ? '{w} menang · {l} kalah · {f} impas · rata-rata {v}' : '{w} menang · {l} kalah · rata-rata {v}', { w: st.wins, l: st.losses, f: st.flat, v: usd(st.avgPnl) })
            : t('belum ada posisi ditutup')} />
      </div>

      <div className="mb-4 grid items-start gap-3 lg:grid-cols-3">
        <Panel title="Pertumbuhan portofolio" className="lg:col-span-2"
          action={<div className="flex flex-wrap gap-2">
            <Segmented size="sm" aria="Tampilan grafik" value={view} onChange={setView} options={now?.netPnl != null ? VIEWS_NET : VIEWS} />
            <Segmented size="sm" aria="Rentang waktu" value={range} onChange={setRange} options={RANGES} />
          </div>}>
          {p ? <GrowthChart p={p} view={view} dim={p.range !== range} /> : <Loading />}
          {p && view !== 'value' && <PnlGap p={p} />}
        </Panel>
        <Panel title="Komposisi portofolio" bodyClass="px-4 pt-1 pb-2">
          {now ? <Composition now={now} ethUsd={d.chain.ethUsd} /> : <Loading />}
        </Panel>
      </div>

      <Panel title={t('Posisi aktif ({n})', { n: open.length })} className="mb-4" bodyClass="p-0"
        action={<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:justify-end">
          <Refresh at={pos?.syncedAt} busy={syncing} onPress={resync} />
          <SyncState syncedAt={pos?.syncedAt} pending={pendingSync} />
          {open.length > 0 && <>
            <span className="whitespace-nowrap"><span className="text-muted">{t('Nilai')}</span> <span className="num font-medium">{usd(sum(open, (x) => x.valueUsd))}</span></span>
            <span className="whitespace-nowrap"><span className="text-muted">{t('uPnL')}</span> <span className={`num font-medium ${tone(sum(open, (x) => x.pnlUsd))}`}>{usd(sum(open, (x) => x.pnlUsd))}</span></span>
          </>}
          <a href="#positions" className="font-medium text-accent hover:underline">{t('Semua posisi →')}</a>
          {open.length > 0 && (
            <Button size="sm" variant="outline" className="text-danger" isPending={closing != null} isDisabled={closing != null} onPress={() => forceCloseAll(open)}>
              {t('Tutup paksa semua ({n})', { n: open.length })}
            </Button>)}
        </div>}>
        {!pos?.positions ? <Loading text="Memuat posisi…" /> : (
          <GmgnProvider tokens={open.map((x) => baseTokenOf(x))}>
          <DataTable label="Posisi aktif" rows={open} rowKey={(x) => x.id} dense onRow={(x) => setHist(x.id)}
            defaultSort={{ column: 'val', direction: 'descending' }}
            empty={<Empty title="Tidak ada posisi aktif" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
            columns={[
              { key: 'pair', label: 'Pasangan', sort: (x) => `${x.symbol0}/${x.symbol1}`, render: (x) => <Pair p={x} link={false} /> },
              // A compact version of the Source column on the Positions page: just who was copied
              // (the target PnL breakdown is there), so the summary panel stays compact.
              { key: 'tgt', label: 'Sumber', sort: (x) => x.targetLabel || x.target || '', render: (x) => (
                x.target ? (
                  <div className="max-w-40">
                    <a href={'#targets/' + x.target} className="group block" title={x.target}>
                      {x.targetLabel && <div className="truncate font-medium group-hover:underline">{x.targetLabel}</div>}
                      <div className="mono text-xs whitespace-nowrap text-muted group-hover:text-foreground">{short(x.target)}</div>
                    </a>
                    <WalletLinks address={x.target} compact className="mt-0.5" />
                  </div>
                ) : <span className="text-xs text-muted">{t('Manual / di luar bot')}</span>) },
              { key: 'range', label: 'Rentang harga', sortable: false, render: (x) => (
                <PriceRange position={x} lo={x.tick_lower} hi={x.tick_upper} cur={x.curTick}
                  dec0={x.dec0} dec1={x.dec1} quoteSide={x.quoteSide} symbol0={x.symbol0} symbol1={x.symbol1}
                  entrySqrt={x.entrySqrt} exitSqrt={x.exitSqrt} showPrices={false} />) },
              tokenColumn(pairOf),
              { key: 'vol', label: 'Volume 24 jam', align: 'end', sort: (x) => pairOf(x)?.volume?.h24 ?? -1, render: (x) => <VolCell pair={pairOf(x)} /> },
              { key: 'liq', label: 'Likuiditas pool', align: 'end', sort: (x) => pairOf(x)?.liquidityUsd ?? -1, render: (x) => <LiqCell pair={pairOf(x)} p={x} /> },
              { key: 'val', label: 'Nilai', align: 'end', sort: (x) => x.valueUsd, render: (x) => (
                <div className="whitespace-nowrap">{usd(x.valueUsd)}<div className="text-xs text-muted">{t('modal {v}', { v: usd(x.costUsd) })}</div></div>) },
              { key: 'fee', label: 'Fee', align: 'end', sort: (x) => x.feeUsd, render: (x) => dash(x, <FeeCell p={x} />) },
              { key: 'pnl', label: 'PnL', align: 'end', sort: (x) => x.pnlUsd, render: (x) => dash(x, (
                <div className={`whitespace-nowrap ${tone(x.pnlUsd)}`}>{usd(x.pnlUsd)}<div className="text-xs">{pct(x.pnlPct)}</div></div>)) },
              { key: 'age', label: 'Umur', align: 'end', sort: (x) => x.ageHours, render: (x) => <span className="whitespace-nowrap text-muted">{age(x.ageHours)}</span> },
            ]} />
          </GmgnProvider>
        )}
      </Panel>

      {/* Equal height: the right column stretches to the calendar's height, leaving no gap */}
      <div className="mb-4 grid gap-3 lg:grid-cols-5">
        <Panel title="Kalender PnL" desc="PnL terealisasi per hari posisi ditutup · klik hari untuk membuat kartu bagikan" className="lg:col-span-3" bodyClass="flex-1">
          {cal ? <PnlCalendar daily={cal.daily} counts={cal.counts} empty="Belum ada posisi ditutup" onShare={(k) => setShareDay(k)} /> : <Loading />}
        </Panel>
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <Panel title="Kinerja per sumber" desc="PnL posisi yang disalin dari tiap target" bodyClass="p-0" className="flex-1">
            {p ? <BySource rows={p.byTarget} /> : <Loading />}
          </Panel>
          {st?.closedCount > 0 && (
            <Panel title="Posisi ditutup" desc={t('{n} posisi', { n: st.closedCount })} bodyClass="p-0">
              <ClosedStats st={st} />
            </Panel>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Jatah salin" desc="Sisa ruang di plafon aturan umum" bodyClass="p-0" className="h-full">
          {d.room ? <CopyRoom room={d.room} dryRun={d.mode.dry_run} /> : <Loading />}
        </Panel>
        <Panel title="Kesehatan mesin" bodyClass="p-0" className="h-full">
          <div className="divide-y divide-border px-4">
            <KV label="Blok terkini">{num(d.chain.head)}</KV>
            <KV label="Tertinggal">
              <Dot tone={lag < 60 ? 'success' : 'warning'} />
              <span className="ml-1.5">{lag === 0 ? t('sinkron') : t('{n} blok', { n: num(lag) })}</span>
            </KV>
            {/* "Lagging" can mislead: the latest block is only read inside a scan cycle,
                so a stuck cycle freezes both at once and lag stays 0 although the bot has been
                blind for a long time. The age of the last successful scan cannot be fooled
                that way. */}
            <KV label="Pemindaian terakhir">
              <Dot tone={scanStale ? 'warning' : 'success'} />
              <span className="ml-1.5">{ago(d.chain.lastScan)}</span>
            </KV>
            <KV label="Aksi terdeteksi">{num(T.actions)}</KV>
            <KV label="Disalin / dilewati">{num(T.would)} / {num(T.skipped)}</KV>
            <KV label="Harga ETH">{usd(d.chain.ethUsd)}</KV>
            <KV label="Latensi RPC"><Latency rpc={d.rpc || []} /></KV>
          </div>
          {d.stats.lastError && <div className="p-4 pt-3"><Notice status="warning" title="Error terakhir">{reason(d.stats.lastError)}</Notice></div>}
        </Panel>
        <Panel title="Alasan terbanyak dilewati" desc={T.skipped ? t('dari {n} aksi yang dilewati', { n: num(T.skipped) }) : null} bodyClass="p-0" className="h-full">
          {d.skipReasons.length ? (
            <div className="divide-y divide-border">
              {d.skipReasons.map((r) => {
                const text = String(reason(r.reason) || '');
                const share = T.skipped ? (r.n / T.skipped) * 100 : null;
                return (
                  <div key={r.reason} className="px-4 py-2 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="min-w-0 truncate" title={text}>{text.charAt(0).toUpperCase() + text.slice(1)}</span>
                      <span className="num shrink-0 font-medium">{num(r.n)}{share != null && <span className="ml-1.5 inline-block w-9 text-end text-xs font-normal text-muted">{num(share, 0)}%</span>}</span>
                    </div>
                    {/* thin bar: the comparison between reasons reads without reading the numbers */}
                    <div className="mt-1.5 h-1 rounded-full bg-default">
                      <div className="h-1 rounded-full bg-muted/70" style={{ width: `${(r.n / maxSkip) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <div className="p-4"><Empty title="Belum ada yang dilewati" /></div>}
        </Panel>
        <Panel title="Transaksi terakhir" bodyClass="p-0" className="h-full"
          action={<a href="#activity" className="text-xs text-accent hover:underline">{t('Semua aktivitas')} →</a>}>
          {tx?.txs?.length ? (
            <div className="divide-y divide-border">
              {tx.txs.slice(0, 8).map((x) => {
                const failed = x.status === 'gagal';
                return (
                  <div key={x.hash} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <Dot tone={TXSTATUS[x.status]?.[1] || 'default'} title={TXSTATUS[x.status]?.[0] || x.status} />
                    <span className="min-w-0 flex-1 truncate">{t(TXKIND[x.kind] || x.kind)}</span>
                    {/* status is not only the dot colour — and is not truncated together with the name */}
                    {x.status !== 'sukses' && <span className={`shrink-0 text-xs font-medium ${failed ? 'text-danger' : 'text-warning'}`}>{t(TXSTATUS[x.status]?.[0] || x.status)}</span>}
                    <a href={txHref(x.hash)} target="_blank" rel="noreferrer" className="mono shrink-0 text-muted hover:text-accent hover:underline">{short(x.hash)}</a>
                    <span className="shrink-0 text-end whitespace-nowrap tabular-nums text-xs text-muted">{ago(x.ts)}</span>
                  </div>
                );
              })}
            </div>
          ) : <div className="p-4"><Empty title="Belum ada transaksi" sub="Mode simulasi tidak mengirim transaksi." /></div>}
        </Panel>
      </div>
    </>
  );
}
