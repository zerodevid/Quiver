// Monitor: semua posisi terbuka dalam satu layar, satu kartu per POOL — grafik
// lilin dengan semua rentang posisi di pool itu sebagai pita berwarna (bisa diklik
// untuk memilih posisinya), harga live dari chain, PnL, dan seberapa dekat posisi
// yang dipilih ke tiap aturan keluar otomatis. Pertanyaan yang dijawab halaman ini adalah
// "masih bertahan atau tidak?": halaman Posisi memberi angkanya, halaman detail
// memberi satu grafik; di sini semuanya berdampingan supaya lima posisi bisa
// dipantau tanpa berpindah halaman.
//
// Sumber data dan iramanya:
//   /api/positions  5 dtk  — daftar, nilai, fee, PnL (hasil sinkron mesin)
//   /api/monitor   10 dtk  — aturan keluar yang berlaku per posisi + pencatat di-luar-rentang
//   /api/prices     3 dtk  — harga semua pool dalam SATU batch eth_call
//   /api/market    45 dtk  — lilin GeckoTerminal per pool, dimulai bergiliran supaya
//                            sepuluh kartu tidak menembak GeckoTerminal serentak
//
// Satu pool = satu sumbu harga, jadi lima posisi di pool yang sama muat di satu
// grafik; dua pool berbeda untuk token yang sama (fee lain / kuotasi lain) tetap
// jadi dua kartu karena harganya tidak sebanding.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Activity, ArrowUpRight, LayoutGrid, Rows3 } from 'lucide-react';
import { usePoll, useResync, useTick } from '../hooks';
import { useClosePosition } from '../useClosePosition';
import { useClaimFees } from '../useClaimFees';
import { useLiveCandles } from '../liveCandles';
import { breakEven } from '../breakeven';
import CandleChart, { BAND_COLORS } from '../components/CandleChart';
import AutoCompoundButton from '../components/AutoCompoundButton';
import TakeoverButton from '../components/TakeoverButton';
import { PageHeader, Panel, Empty, Loading, Notice, PriceRange, Refresh, Segmented, Dot, TradeLinks, DataLinks, baseTokenOf } from '../components/ui';
import { TokenPair, PairName } from '../components/TokenIcon';
import { useAlertPrefs, alarm, bumpTitle } from '../components/TargetAlerts';
import { orientCandles, tfFor, SECS, LiveBadge, kUsd } from './PositionDetail';
import { usd, pct, tone, num, age, ago, short, price, tickPrice, sqrtPrice } from '../fmt';
import { useI18n } from '../i18n';

const TFS = [['auto', 'Otomatis'], ['5m', '5 mnt'], ['15m', '15 mnt'], ['1h', '1 jam'], ['4h', '4 jam']];
const SORTS = [['risk', 'Paling berisiko'], ['pnl', 'PnL'], ['value', 'Nilai'], ['age', 'Umur']];
const PREF_KEY = 'lpcopy-monitor';
const readPrefs = () => { try { return { tf: 'auto', dense: false, sort: 'risk', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { tf: 'auto', dense: false, sort: 'risk' }; } };
const writePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* abaikan */ } };

// Jarak harga ke rentang dalam persen, di ruang tick — rumus yang sama dengan
// distanceFromRangePct di src/v3math.js, supaya angka di bar "jarak keluar" sama
// dengan yang dipakai mesin saat memutuskan menutup.
const farPct = (tick, lo, hi) => {
  const d = tick < lo ? lo - tick : tick >= hi ? tick - hi + 1 : 0;
  return d > 0 ? (1.0001 ** d - 1) * 100 : 0;
};

// Pemicu keluar otomatis untuk satu posisi: tiap aturan yang menyala jadi satu bar
// kemajuan 0…1 ke ambangnya. Mengikuti urutan penilaian di Positions.exitTriggers:
// stop loss, take profit, umur, jauh dari rentang, lama di luar rentang.
function triggersOf(p, mon, liveTick, now, t) {
  if (!mon?.exit) return [];
  const e = mon.exit;
  const out = [];
  const pnl = p.pnlPct ?? 0;
  if (e.stop_loss_pct > 0) out.push({ key: 'sl', label: 'Stop loss', good: false, ratio: Math.max(0, -pnl) / e.stop_loss_pct, now: pct(pnl, 1), limit: `−${num(e.stop_loss_pct, 1)}%` });
  if (e.take_profit_pct > 0) out.push({ key: 'tp', label: 'Take profit', good: true, ratio: Math.max(0, pnl) / e.take_profit_pct, now: pct(pnl, 1), limit: `+${num(e.take_profit_pct, 1)}%` });
  if (e.max_age_hours > 0) out.push({ key: 'age', label: 'Umur maksimum', good: false, ratio: (p.ageHours || 0) / e.max_age_hours, now: age(p.ageHours), limit: age(e.max_age_hours) });
  const tick = liveTick ?? p.curTick;
  const outside = tick != null && p.tick_lower != null && (tick < p.tick_lower || tick >= p.tick_upper);
  if (e.out_of_range_pct > 0) {
    const far = outside ? farPct(tick, p.tick_lower, p.tick_upper) : 0;
    out.push({ key: 'far', label: 'Jarak dari rentang', good: false, ratio: far / e.out_of_range_pct, now: `${num(Math.min(far, 9999), 1)}%`, limit: `${num(e.out_of_range_pct, 0)}%`,
      note: far > e.out_of_range_pct && mon.farStreak < 2 ? 'menunggu sinkron kedua' : null });
  }
  if (e.out_of_range_minutes > 0) {
    // Pencatat milik mesin (oor:<id>) baru diisi saat sinkron; kalau harga live
    // baru saja keluar rentang, hitung dari sekarang supaya barnya tidak diam.
    const since = p.inRange === false ? mon.oorSince : null;
    const mins = outside ? (now - (since || now)) / 60000 : 0;
    out.push({ key: 'oor', label: 'Lama di luar rentang', good: false, ratio: mins / e.out_of_range_minutes, now: outside ? `${num(mins, 0)} ${t('mnt')}` : '—', limit: `${num(e.out_of_range_minutes, 0)} ${t('mnt')}` });
  }
  return out;
}

// Tingkat risiko kartu: merah = di luar rentang atau pemicu keluar ≥ 80 %; kuning =
// hampir menyentuh tepi (< 5 %) atau PnL < −5 %; hijau = sisanya. Skor dipakai untuk
// urutan "paling berisiko dulu": yang butuh perhatian ada di atas.
function riskOf(p, trig, edge) {
  const worst = Math.max(0, ...trig.filter((x) => !x.good).map((x) => x.ratio));
  let level = 'ok', score = worst;
  if (p.inRange === false || edge?.ok === false) { level = 'danger'; score = 2 + worst + (edge?.far || 0) / 100; }
  else if (worst >= 0.8) { level = 'danger'; score = 2 + worst; }
  else if ((edge?.ok && edge.pctToEdge < 5) || (p.pnlPct ?? 0) < -5) { level = 'warning'; score = 1 + worst + Math.max(0, -(p.pnlPct || 0)) / 100; }
  return { level, score };
}

const EDGE_CLS = { danger: 'border-l-danger', warning: 'border-l-warning', ok: 'border-l-success' };
// Warna pita per posisi di satu pool: dipilih supaya tetap bisa dibedakan di tema
// gelap maupun terang, dan tidak memakai hijau/merah yang sudah berarti untung/rugi.
const LEVEL_RANK = { danger: 2, warning: 1, ok: 0 };

// Satu bar pemicu keluar: label kiri, angka kini/ambang kanan, batang di bawah.
function TriggerBar({ x }) {
  const { t } = useI18n();
  const r = Math.min(1, Math.max(0, x.ratio));
  const hot = !x.good && r >= 1, warm = !x.good && r >= 0.8;
  const color = x.good ? 'bg-success' : hot ? 'bg-danger' : warm ? 'bg-warning' : 'bg-accent';
  const text = x.good ? (r >= 1 ? 'text-success' : '') : hot ? 'text-danger' : warm ? 'text-warning' : '';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[0.6875rem]">
        <span className="truncate text-muted">{t(x.label)}{x.note && <span className="ml-1 text-warning">· {t(x.note)}</span>}</span>
        <span className={`num shrink-0 ${text}`}>{x.now} <span className="text-muted">/ {x.limit}</span></span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-default" role="progressbar" aria-valuenow={Math.round(r * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t(x.label)}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${r * 100}%` }} />
      </div>
    </div>
  );
}

// Grafik lilin satu kartu (satu pool): lilin GeckoTerminal dipoll jarang, lilin
// terakhirnya digerakkan harga live. Semua posisi di pool ini jadi pita rentang
// berwarna; garis masuk & BEP hanya untuk posisi yang dipilih supaya tidak ramai.
// Mulai polling setelah `delay` ms supaya kartu-kartu tidak menembak GeckoTerminal
// serentak (jatah ~30 panggilan/menit per IP).
function CardChart({ g, sel, onPick, tf, live, delay, height }) {
  const { t } = useI18n();
  const p0 = g.p0;
  const [go, setGo] = useState(delay === 0);
  useEffect(() => { if (go) return undefined; const id = setTimeout(() => setGo(true), delay); return () => clearTimeout(id); }, [go, delay]);
  // Cukup lilin supaya posisi tertua di pool ini terlihat titik masuknya. Dibulatkan
  // ke kelipatan 50: umur bertambah tiap poll, dan URL yang berubah tiap 5 detik
  // akan memaksa lilin diambil ulang tiap 5 detik.
  const span = Math.max(...g.items.map((x) => x.p.ageHours || 0)) * 3600;
  const limit = Math.min(500, Math.max(150, Math.ceil((span / SECS[tf] + 40) / 50) * 50));
  const { data: m } = usePoll(go ? `/api/market?pool=${p0.pool_ref}&tf=${tf}&limit=${limit}&token=${p0.baseToken || ''}&pair=0` : null, 45000);
  const at = (tick) => tickPrice(tick, p0.dec0, p0.dec1, p0.quoteSide);
  const pEntry = sel ? sqrtPrice(sel.p.entrySqrt, p0.dec0, p0.dec1, p0.quoteSide) : null;
  const pNow = live?.price ?? (p0.curSqrt ? sqrtPrice(p0.curSqrt, p0.dec0, p0.dec1, p0.quoteSide) : (p0.curTick != null ? at(p0.curTick) : null));
  const oriented = useMemo(() => orientCandles(m?.ohlcv, p0.baseToken, pNow ?? pEntry), [m, p0.baseToken, pNow, pEntry]);
  const candles = useLiveCandles(oriented, SECS[tf], live, `${p0.pool_ref}:${tf}:mon`);
  const ranges = useMemo(() => g.items.filter((x) => !x.full).map((x) => {
    const a = at(x.p.tick_lower), b = at(x.p.tick_upper);
    return { id: x.p.id, lo: Math.min(a, b), hi: Math.max(a, b), color: x.color, label: x.tag, selected: sel?.p.id === x.p.id };
  }), [g.items, sel?.p.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const bep = sel ? breakEven(sel.p) : null;
  const quote = p0.quoteSide === 0 ? p0.symbol0 : p0.quoteSide === 1 ? p0.symbol1 : null;
  if (!m) return <div className="flex items-center justify-center" style={{ height }}><Loading text={go ? 'Memuat lilin…' : 'Antre…'} /></div>;
  if (m.ohlcv?.error || !candles.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted" style={{ height }}>
        <span>{t('Grafik belum tersedia')}</span>
        <span>{m.ohlcv?.error ? t(m.ohlcv.error) : t('GeckoTerminal belum punya riwayat harga untuk pool ini.')}</span>
      </div>
    );
  }
  return (
    <CandleChart candles={candles} tf={tf} quote={quote} height={height} ranges={ranges} onRangeClick={onPick}
      entry={sel && (sel.p.opened_ts || pEntry != null) ? { t: sel.p.opened_ts, p: pEntry } : null}
      now={pNow} bep={bep?.price > 0 ? bep.price : null} />
  );
}

// Perubahan harga DexScreener sebagai chip kecil: 5 mnt / 1 jam / 24 jam.
function MarketStrip({ pair }) {
  const { t } = useI18n();
  if (!pair || pair.error) return null;
  const pc = pair.priceChange || {};
  const tx = pair.txns?.h24;
  const items = [['m5', '5 mnt'], ['h1', '1 jam'], ['h24', '24 jam']].filter(([k]) => pc[k] != null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted">
      {items.map(([k, l]) => <span key={k} className="whitespace-nowrap">{t(l)} <span className={`num ${tone(pc[k])}`}>{pct(pc[k], 1)}</span></span>)}
      {pair.volume?.h24 != null && <span className="whitespace-nowrap">{t('vol')} <span className="num text-foreground">{kUsd(pair.volume.h24)}</span></span>}
      {pair.liquidityUsd != null && <span className="whitespace-nowrap">{t('likuiditas')} <span className="num text-foreground">{kUsd(pair.liquidityUsd)}</span></span>}
      {tx && <span className="whitespace-nowrap"><span className="num text-success">{num(tx.buys)}</span> {t('beli')} · <span className="num text-danger">{num(tx.sells)}</span> {t('jual')}</span>}
    </div>
  );
}

// Legenda posisi di satu pool: satu chip per posisi, warnanya sama dengan pitanya
// di grafik; klik chip = pilih posisi (sama seperti klik pitanya).
function PositionChips({ items, selId, onPick }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('Posisi di pool ini')}>
      {items.map((x) => {
        const on = x.p.id === selId;
        const inR = x.edge ? x.edge.ok : x.p.inRange;
        return (
          <button key={x.p.id} type="button" role="tab" aria-selected={on} onClick={() => onPick(x.p.id)}
            title={x.full ? t('Seluruh rentang') : `${price(x.lo)} – ${price(x.hi)}`}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.6875rem] transition-colors ${on ? 'border-transparent bg-default text-foreground' : 'border-border text-muted hover:text-foreground'}`}
            style={on ? { boxShadow: `inset 0 0 0 1px ${x.color}` } : undefined}>
            <span className="inline-block size-2 rounded-sm" style={{ background: x.color }} />
            <span className="mono font-medium">{x.tag}</span>
            <span className={`num ${tone(x.p.pnlUsd)}`}>{x.p.syncing ? '—' : pct(x.p.pnlPct, 1)}</span>
            {inR != null && <Dot tone={inR ? 'success' : 'danger'} />}
          </button>
        );
      })}
    </div>
  );
}

function MonitorCard({ g, tf, dense, delay, actions }) {
  const { t } = useI18n();
  const { close, closeAll, closing, claim, claiming, reload } = actions;
  const p0 = g.p0;
  // Posisi yang dipilih: pilihan pengguna kalau masih ada, kalau tidak yang paling
  // berisiko di pool ini (urutan g.items sudah begitu).
  const [pick, setPick] = useState(null);
  const sel = g.items.find((x) => x.p.id === pick) || g.items[0];
  const p = sel.p;
  const at = (tick) => tickPrice(tick, p0.dec0, p0.dec1, p0.quoteSide);
  const pEntry = sqrtPrice(p.entrySqrt, p0.dec0, p0.dec1, p0.quoteSide);
  const pNow = g.live?.price ?? (p0.curSqrt ? sqrtPrice(p0.curSqrt, p0.dec0, p0.dec1, p0.quoteSide) : (p0.curTick != null ? at(p0.curTick) : null));
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  const quote = p0.quoteSide === 0 ? p0.symbol0 : p0.quoteSide === 1 ? p0.symbol1 : null;
  const inRange = sel.edge ? sel.edge.ok : p.inRange;
  const busy = closing != null || claiming != null;
  const headline = inRange == null ? null : inRange ? ['IN-RANGE', 'text-success', 'success'] : ['DI LUAR RENTANG', 'text-danger', 'danger'];
  const many = g.items.length > 1;
  const sum = (f) => g.items.reduce((a, x) => a + (f(x.p) || 0), 0);
  const gPnl = sum((x) => x.pnlUsd), gCost = sum((x) => x.costUsd), gFee = sum((x) => x.feeUsd);
  const gIn = g.items.filter((x) => (x.edge ? x.edge.ok : x.p.inRange) === true).length;
  const h = g.hist;   // riwayat posisi tertutup di pool ini (null sampai /api/monitor tiba)
  const pairName = `${p0.symbol0}/${p0.symbol1}`;

  return (
    <article className={`flex min-w-0 flex-col rounded-lg border border-border border-l-[3px] bg-surface ${EDGE_CLS[g.risk.level]}`} aria-label={`${p0.symbol0}/${p0.symbol1}`}>
      {/* kepala: pasangan & pool di kiri, status posisi terpilih di kanan */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <TokenPair token0={p0.token0} token1={p0.token1} symbol0={p0.symbol0} symbol1={p0.symbol1} size={dense ? 22 : 26} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <PairName token0={p0.token0} token1={p0.token1} symbol0={p0.symbol0} symbol1={p0.symbol1} pool={p0.pool_ref} sep="/" className="text-sm font-semibold" />
              <a href={'#positions/' + p.id} className="text-muted hover:text-foreground" title={t('Buka detail posisi {tag}', { tag: sel.tag })} aria-label={t('Buka detail posisi {tag}', { tag: sel.tag })}><ArrowUpRight className="size-3.5" /></a>
              {/* Tumpukan logo: GMGN / Based / fomo / Uniswap, lalu DexScreener / GeckoTerminal —
                  satu klik dari kartu ke terminal luar untuk token & pool ini. */}
              <TradeLinks token={baseTokenOf(p0)} pool={p0.pool_ref} compact className="ml-2" />
              <DataLinks pool={p0.pool_ref} dexUrl={g.pair?.url} className="ml-1.5" compact />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted">
              <span className="uppercase">{p0.venue}</span><span>·</span><span className="num">{num(p0.fee / 10000, 2)}%</span>
              <span>·</span>
              {many
                ? <span>{t('{n} posisi', { n: g.items.length })} · <span className="num">{gIn}/{g.items.length}</span> {t('in-range')}</span>
                : <><span>{age(p.ageHours)}</span><span>·</span>{p.target ? <a href={'#targets/' + p.target} className="hover:underline">{p.targetLabel || short(p.target)}</a> : <span>{t('manual')}</span>}</>}
            </div>
          </div>
        </div>
        <div className="text-end">
          {headline
            ? <div className={`flex items-center justify-end gap-1.5 text-xs font-semibold tracking-wide ${headline[1]}`}><Dot tone={headline[2]} />{t(headline[0])}{many && <span className="mono font-medium text-muted">{sel.tag}</span>}</div>
            : <div className="text-xs text-muted">{t(p.syncing ? 'menyinkronkan…' : 'belum tersinkron')}</div>}
          {sel.edge && <div className={`num text-[0.6875rem] ${sel.edge.ok ? 'text-muted' : 'text-danger'}`}>{sel.edge.text}</div>}
          {sel.full && <div className="text-[0.6875rem] text-muted">{t('Seluruh rentang')}</div>}
        </div>
      </div>

      {/* Total pool: PnL gabungan dibuat besar — inilah angka yang dilihat pertama
          saat memutuskan bertahan atau tidak di pool ini, sebelum turun ke posisi satu
          per satu. Tampil juga untuk pool berposisi tunggal supaya semua kartu punya
          angka besar di tempat yang sama. */}
      <div className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5 rounded-md bg-default/50 px-3 py-2">
        <div>
          <div className="text-[0.6875rem] text-muted">{t('PnL seluruh pool')} · {t('{n} posisi', { n: g.items.length })}</div>
          <div className={`num text-xl leading-tight font-semibold tracking-tight ${tone(gPnl)}`}>
            {usd(gPnl)}{gCost > 0 && <span className="ml-1.5 text-sm font-medium">({pct((gPnl / gCost) * 100, 2)})</span>}
          </div>
          {/* Sejak awal: posisi terbuka + semua yang pernah ditutup di pool ini. Pool
              yang tampak untung sekarang bisa saja sudah beberapa kali merugikan. */}
          {h && h.closedCount > 0 && (
            <div className="num mt-0.5 text-[0.6875rem] text-muted">
              {t('sejak awal')} <span className={`font-semibold ${tone(gPnl + h.realizedUsd)}`}>{usd(gPnl + h.realizedUsd)}</span>
              <span className="mx-1">·</span>
              {t('{n} ditutup', { n: h.closedCount })} <span className={`font-medium ${tone(h.realizedUsd)}`}>{usd(h.realizedUsd)}</span>
              {(h.wins > 0 || h.losses > 0) && <span className="ml-1">(<span className="text-success">{h.wins}</span>/<span className="text-danger">{h.losses}</span>)</span>}
            </div>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div><dt className="text-[0.6875rem] text-muted">{t('Nilai')}</dt><dd className="num font-medium">{usd(sum((x) => x.valueUsd))}</dd></div>
          <div><dt className="text-[0.6875rem] text-muted">{t('Modal')}</dt><dd className="num font-medium">{usd(gCost)}</dd></div>
          <div><dt className="text-[0.6875rem] text-muted">{t('Fee belum diklaim')}</dt><dd className={`num font-medium ${gFee > 0.005 ? 'text-success' : ''}`}>{usd(gFee)}</dd></div>
          <div title={h?.closedCount ? t('PnL {n} posisi yang sudah ditutup di pool ini', { n: h.closedCount }) : undefined}>
            <dt className="text-[0.6875rem] text-muted">{t('Realisasi')}</dt>
            <dd className={`num font-medium ${h?.closedCount ? tone(h.realizedUsd) : 'text-muted'}`}>{!h ? '…' : h.closedCount ? usd(h.realizedUsd) : '—'}</dd>
          </div>
        </dl>
      </div>
      {/* legenda posisi (hanya kalau lebih dari satu) */}
      {many && <div className="px-4 pb-2"><PositionChips items={g.items} selId={p.id} onPick={setPick} /></div>}

      {/* harga kini + rentang posisi terpilih, lalu grafik */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-4 pb-1">
        <div className="num text-lg leading-tight font-semibold tracking-tight">
          {price(pNow)}{quote && <span className="ml-1 text-xs font-medium text-muted">{quote}</span>}
          {move != null && <span className={`ml-2 text-xs font-medium ${tone(move)}`} title={t('dari harga masuk')}>{pct(move, 1)}</span>}
          {g.live && <span className="ml-2 align-middle text-[0.6875rem] font-normal"><LiveBadge /></span>}
        </div>
        {!sel.full && <div className="num text-[0.6875rem] text-muted">
          <span className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: sel.color }} />
          {t('rentang')} <span className="text-foreground">{price(sel.lo)} – {price(sel.hi)}</span>
        </div>}
      </div>
      <div className="px-1">
        <CardChart g={g} sel={sel} onPick={setPick} tf={tf} live={g.live} delay={delay} height={dense ? 170 : 250} />
      </div>

      {/* posisi terpilih: sumber & umur (kalau banyak), pita rentang linear, angka kunci */}
      <div className="px-4 pt-2 pb-3">
        {many && <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted">
          <span className="mono font-medium text-foreground">{sel.tag}</span><span>·</span>
          <span>{age(p.ageHours)}</span><span>·</span>
          {p.target ? <a href={'#targets/' + p.target} className="hover:underline">{p.targetLabel || short(p.target)}</a> : <span>{t('manual')}</span>}
          {p.takeover_ts != null && <span className="rounded bg-warning/15 px-1 py-px font-medium text-warning">{t('Kendali manual')}</span>}
        </div>}
        <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
          <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={g.live?.tick ?? p.curTick} dec0={p0.dec0} dec1={p0.dec1} quoteSide={p0.quoteSide}
            symbol0={p0.symbol0} symbol1={p0.symbol1} entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} showPrices={false} />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
            <div><dt className="text-[0.6875rem] text-muted">{t('Nilai')}</dt><dd className="num font-medium">{usd(p.valueUsd)}<span className="ml-1 font-normal text-muted">/ {usd(p.costUsd)}</span></dd></div>
            <div><dt className="text-[0.6875rem] text-muted">PnL</dt><dd className={`num font-medium ${tone(p.pnlUsd)}`}>{p.syncing ? '—' : <>{usd(p.pnlUsd)} <span className="font-normal">{pct(p.pnlPct, 2)}</span></>}</dd></div>
            <div><dt className="text-[0.6875rem] text-muted">{t('Fee belum diklaim')}</dt><dd className={`num font-medium ${p.feeUsd > 0.005 ? 'text-success' : ''}`}>{p.syncing ? '—' : usd(p.feeUsd)}</dd></div>
            <div><dt className="text-[0.6875rem] text-muted">IL</dt><dd className={`num font-medium ${tone(p.ilUsd)}`}>{p.ilUsd == null ? '—' : usd(p.ilUsd)}</dd></div>
          </dl>
        </div>
      </div>

      {/* pemicu keluar otomatis posisi terpilih */}
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[0.6875rem]">
          <span className="font-medium">{t('Pemicu keluar otomatis')}{many && <span className="mono ml-1.5 font-medium text-muted">{sel.tag}</span>}</span>
          {sel.mon?.stale && <span className="text-warning" title={t('Nilai posisi dari sinkron terakhir tidak terbaca; aturan mandiri menunggu sinkron yang berhasil.')}>{t('data basi')}</span>}
          {!sel.mon?.stale && sel.mon?.exit?.follow_target && p.target && p.takeover_ts == null && <span className="text-muted">{t('ikut target keluar')}</span>}
        </div>
        {!sel.mon ? <div className="text-xs text-muted">…</div>
          : sel.trig.length === 0 ? <p className="text-xs text-muted">{t('Tidak ada aturan keluar mandiri yang aktif untuk posisi ini — hanya ditutup mengikuti target atau manual.')}</p>
          : <div className={`grid gap-x-4 gap-y-2.5 ${dense ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-3'}`}>{sel.trig.map((x) => <TriggerBar key={x.key} x={x} />)}</div>}
      </div>

      {/* pasar + aksi untuk posisi terpilih */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-2.5">
        <MarketStrip pair={g.pair} />
        {!p.empty && (
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            <AutoCompoundButton p={p} reload={reload} disabled={busy} />
            <TakeoverButton p={p} reload={reload} disabled={busy} />
            <Button size="sm" variant="secondary" isPending={claiming === p.id} isDisabled={busy} onPress={() => claim(p)}>{t('Claim fee')}{many && <span className="mono ml-1 opacity-70">{sel.tag}</span>}</Button>
            <Button size="sm" variant="danger-soft" isPending={closing === p.id} isDisabled={busy} onPress={() => close(p)}>{t('Tutup')}{many && <span className="mono ml-1 opacity-70">{sel.tag}</span>}</Button>
            {/* Tutup semua posisi di pool ini: satu konfirmasi, ditutup berurutan. */}
            {many && <Button size="sm" variant="danger" isPending={closing != null && closing !== p.id} isDisabled={busy}
              onPress={() => closeAll(g.items.filter((x) => !x.p.empty).map((x) => x.p), { pair: pairName })}>
              {t('Tutup semua')} <span className="num ml-1 opacity-80">({g.items.length})</span>
            </Button>}
          </div>
        )}
      </div>
      {p.empty && <div className="border-t border-border px-4 py-2 text-xs text-warning">{t('Likuiditas sudah nol di chain — akan ditandai tertutup pada sinkron berikutnya.')}</div>}
    </article>
  );
}

// Peringatan saat sebuah posisi berubah status: masuk → keluar rentang, atau pemicu
// keluar melewati 80 %. Hanya perubahan yang dibunyikan — bukan setiap poll — dan
// status pertama yang terbaca tidak dianggap perubahan (membuka halaman dengan tiga
// posisi di luar rentang tidak boleh langsung meraung).
function useMonitorAlerts(items) {
  const { t } = useI18n();
  const prefs = useAlertPrefs();
  const seen = useRef(new Map());
  useEffect(() => {
    if (!items.length) return;
    const news = [];
    for (const c of items) {
      const key = c.p.id;
      // Garis dasar baru dicatat setelah aturan keluarnya tiba: sebelum itu semua
      // bar kosong, dan "muncul"-nya bar saat /api/monitor mendarat bukan perubahan.
      if (!c.mon) continue;
      const worst = Math.max(0, ...c.trig.filter((x) => !x.good).map((x) => x.ratio));
      const cur = { out: c.edge ? !c.edge.ok : c.p.inRange === false, hot: worst >= 0.8 };
      const prev = seen.current.get(key);
      seen.current.set(key, cur);
      if (!prev) continue;
      const pair = `${c.p.symbol0}/${c.p.symbol1} ${c.tag}`;
      if (cur.out && !prev.out) news.push(['warning', t('{pair} keluar dari rentang', { pair }), c.edge?.text || null]);
      if (cur.hot && !prev.hot) {
        const x = c.trig.filter((y) => !y.good).sort((a, b) => b.ratio - a.ratio)[0];
        news.push(['danger', t('{pair} mendekati pemicu keluar', { pair }), x ? `${t(x.label)}: ${x.now} / ${x.limit}` : null]);
      }
    }
    if (!news.length) return;
    for (const [kind, title, desc] of news) toast[kind](title, { description: desc || undefined, timeout: 12000 });
    if (prefs.enabled && prefs.sound) alarm();
    bumpTitle(news.length);
  }, [items, prefs.enabled, prefs.sound, t]);
}

export default function Monitor() {
  const { t } = useI18n();
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = (patch) => setPrefsState((v) => { const n = { ...v, ...patch }; writePrefs(n); return n; });
  const { data: d, error, reload } = usePoll('/api/positions', 5000);
  const { data: mon } = usePoll('/api/monitor', 10000);
  const [resync, syncing] = useResync(reload);
  const { close, closeAll, closing } = useClosePosition(reload);
  const { claim, claiming } = useClaimFees(reload);
  useTick(1000);   // bar "lama di luar rentang" dan jam kesegaran berdetak

  const open = useMemo(() => d?.positions || [], [d]);
  const pools = useMemo(() => [...new Set(open.map((p) => String(p.pool_ref || '').toLowerCase()).filter(Boolean))].sort(), [open]);
  const { data: px } = usePoll(pools.length ? `/api/prices?pools=${pools.join(',')}` : null, 3000);
  // Statistik pasar per pool (DexScreener) — jarang, karena hanya untuk chip Δ/volume.
  const { data: mk } = usePoll(pools.length ? `/api/monitor/market?pools=${pools.join(',')}` : null, 60000);
  const fresh = px && Date.now() - px.ts < 30_000 ? px : null;

  const now = Date.now();
  // Satu butir per posisi: harga live pool-nya, jarak ke tepi, pemicu, risiko.
  const items = useMemo(() => open.map((p) => {
    const ref = String(p.pool_ref || '').toLowerCase();
    const s = fresh?.prices?.[ref];
    const price_ = s ? sqrtPrice(s.sqrt, p.dec0, p.dec1, p.quoteSide) : null;
    const live = price_ > 0 ? { price: price_, ts: fresh.ts, tick: s.tick } : null;
    const tick = live?.tick ?? p.curTick;
    const full = p.tick_lower <= -880000 && p.tick_upper >= 880000;
    const at = (x) => tickPrice(x, p.dec0, p.dec1, p.quoteSide);
    const a = p.tick_lower != null ? at(p.tick_lower) : null, b = p.tick_upper != null ? at(p.tick_upper) : null;
    const lo = a != null ? Math.min(a, b) : null, hi = a != null ? Math.max(a, b) : null;
    let edge = null;
    if (tick != null && !full && lo != null) {
      const pNow = live?.price ?? at(tick);
      if (tick >= p.tick_lower && tick < p.tick_upper) {
        const toLo = (pNow / lo - 1) * 100, toHi = (hi / pNow - 1) * 100;
        const m = Math.min(toLo, toHi);
        edge = { ok: true, pctToEdge: m, text: t(toLo < toHi ? '{n}% ke tepi bawah' : '{n}% ke tepi atas', { n: num(m, 1) }) };
      } else {
        const far = farPct(tick, p.tick_lower, p.tick_upper);
        edge = { ok: false, far, text: t(tick < p.tick_lower ? '{n}% di bawah rentang' : '{n}% di atas rentang', { n: num(Math.min(far, 9999), 1) }) };
      }
    }
    const m = mon?.positions?.[p.id] || null;
    const trig = triggersOf(p, m, live?.tick ?? null, now, t);
    // Nama pendek posisi: nomor NFT-nya kalau ada (itu yang tampil di Uniswap), kalau tidak id bot.
    const tag = p.token_id ? `#${p.token_id}` : `#${p.id}`;
    return { p, ref, mon: m, live, edge, full, lo, hi, tag, trig, risk: riskOf(p, trig, edge) };
  }), [open, fresh, mon, now, t]);

  // Kelompokkan per pool; di dalam pool urut paling berisiko dulu (posisi terpilih
  // awal), warna pita mengikuti urutan id supaya tidak berganti saat urutan risiko
  // berubah. Risiko kartu = posisi terburuk di pool itu.
  const groups = useMemo(() => {
    const by = new Map();
    for (const x of items) { if (!by.has(x.ref)) by.set(x.ref, []); by.get(x.ref).push(x); }
    return [...by.entries()].map(([ref, list]) => {
      const byId = [...list].sort((a, b) => a.p.id - b.p.id);
      byId.forEach((x, i) => { x.color = BAND_COLORS[i % BAND_COLORS.length]; });
      const sorted = [...list].sort((a, b) => b.risk.score - a.risk.score || (a.p.pnlPct ?? 0) - (b.p.pnlPct ?? 0));
      const worst = sorted[0];
      const risk = { level: worst.risk.level, score: worst.risk.score };
      for (const x of list) if (LEVEL_RANK[x.risk.level] > LEVEL_RANK[risk.level]) risk.level = x.risk.level;
      return { ref, p0: list[0].p, items: sorted, live: list[0].live, risk, pair: mk?.pairs?.[ref] || null, hist: mon?.pools?.[ref] || null,
        pnlPct: (() => { const c = list.reduce((a, x) => a + (x.p.costUsd || 0), 0); return c > 0 ? list.reduce((a, x) => a + (x.p.pnlUsd || 0), 0) / c * 100 : 0; })(),
        valueUsd: list.reduce((a, x) => a + (x.p.valueUsd || 0), 0), ageHours: Math.max(...list.map((x) => x.p.ageHours || 0)) };
    });
  }, [items, mk, mon]);

  const sorted = useMemo(() => {
    const s = [...groups];
    const by = { risk: (a, b) => b.risk.score - a.risk.score || a.pnlPct - b.pnlPct,
      pnl: (a, b) => a.pnlPct - b.pnlPct, value: (a, b) => b.valueUsd - a.valueUsd,
      age: (a, b) => b.ageHours - a.ageHours }[prefs.sort] || (() => 0);
    return s.sort(by);
  }, [groups, prefs.sort]);
  useMonitorAlerts(items);

  // Jarak mulai poll lilin per kartu: urutan tetap per pool (bukan per urutan
  // tampil) supaya mengubah urutan tidak memulai ulang polling.
  const delayOf = useMemo(() => new Map(pools.map((ref, i) => [ref, i * 600])), [pools]);

  const header = (
    <PageHeader group="Pemantauan" title="Monitor" desc="Semua posisi terbuka dalam satu layar: satu grafik per pool dengan rentang tiap posisi sebagai pita berwarna (klik pita untuk memilih), harga live dari chain, PnL, dan seberapa dekat posisi ke aturan keluar otomatis.">
      <Segmented size="sm" aria="Rentang lilin" value={prefs.tf} onChange={(tf) => setPrefs({ tf })} options={TFS} />
      <Segmented size="sm" aria="Urutan" value={prefs.sort} onChange={(sort) => setPrefs({ sort })} options={SORTS} />
      <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label={t('Ukuran kartu')}>
        {[[false, LayoutGrid, 'Kartu besar'], [true, Rows3, 'Kartu ringkas']].map(([v, Icon, label]) => (
          <button key={String(v)} type="button" aria-pressed={prefs.dense === v} title={t(label)} aria-label={t(label)} onClick={() => setPrefs({ dense: v })}
            className={`flex size-7 items-center justify-center rounded-md transition-colors ${prefs.dense === v ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
      <Refresh at={d?.syncedAt} busy={syncing} onPress={resync} />
    </PageHeader>
  );

  if (!d?.positions) {
    return <>{header}{error ? <Notice status="danger" title="Daftar posisi gagal dimuat">{error} — {t('mencoba lagi otomatis.')}</Notice> : <Loading page />}</>;
  }
  if (!open.length) {
    return <>{header}<Panel><Empty title="Belum ada posisi terbuka" sub="Kartu muncul di sini begitu bot menyalin LP dari wallet target atau Anda membuka LP manual." /></Panel></>;
  }

  const sum = (f) => open.reduce((a, p) => a + (f(p) || 0), 0);
  const inN = items.filter((c) => (c.edge ? c.edge.ok : c.p.inRange) === true).length;
  const outN = items.filter((c) => (c.edge ? c.edge.ok : c.p.inRange) === false).length;
  const danger = items.filter((c) => c.risk.level === 'danger').length;
  const pnl = sum((p) => p.pnlUsd), cost = sum((p) => p.costUsd);
  const tfOf = (g) => (prefs.tf === 'auto' ? tfFor(g.ageHours) : prefs.tf);

  return (
    <>
      {header}
      {error && <div className="mb-4"><Notice status="warning" title="Gagal memperbarui daftar posisi">{error} — {t('data di bawah dari pembaruan terakhir.')}</Notice></div>}
      {/* pita ringkasan: angka yang dicari sebelum membaca kartu satu per satu */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium"><Activity className="size-3.5 text-muted" />{t('{n} posisi terbuka', { n: open.length })}{groups.length !== open.length && <span className="font-normal text-muted">· {t('{n} pool', { n: groups.length })}</span>}</span>
        <span><Dot tone="success" /> <span className="num">{inN}</span> {t('in-range')}</span>
        <span><Dot tone="danger" /> <span className="num">{outN}</span> {t('di luar')}</span>
        {danger > 0 && <span className="font-medium text-danger">{t('{n} perlu perhatian', { n: danger })}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="whitespace-nowrap"><span className="text-muted">{t('Nilai')}</span> <span className="num font-medium">{usd(sum((p) => p.valueUsd))}</span></span>
          <span className="whitespace-nowrap"><span className="text-muted">{t('Fee')}</span> <span className="num font-medium">{usd(sum((p) => p.feeUsd))}</span></span>
          <span className="whitespace-nowrap"><span className="text-muted">PnL</span> <span className={`num font-medium ${tone(pnl)}`}>{usd(pnl)}{cost > 0 && <> ({pct((pnl / cost) * 100, 2)})</>}</span></span>
          {fresh ? <LiveBadge /> : <span className="text-muted" title={t('Harga live belum terbaca; memakai hasil sinkron terakhir.')}>{t('harga dari sinkron')}{d.syncedAt ? ` · ${ago(d.syncedAt)}` : ''}</span>}
        </span>
      </div>
      <div className={`grid gap-4 ${prefs.dense ? 'lg:grid-cols-2 2xl:grid-cols-3' : 'xl:grid-cols-2'}`}>
        {sorted.map((g) => (
          <MonitorCard key={g.ref} g={g} tf={tfOf(g)} dense={prefs.dense} delay={delayOf.get(g.ref) || 0}
            actions={{ close, closeAll, closing, claim, claiming, reload }} />
        ))}
      </div>
      <p className="mt-4 text-[0.6875rem] text-muted">
        {t('Harga dibaca langsung dari pool tiap 3 detik; nilai, fee, dan PnL dari sinkron mesin tiap ~30 detik; lilin dari GeckoTerminal. Bar pemicu memakai aturan keluar yang berlaku untuk tiap posisi (aturan per-target menimpa aturan global).')}
      </p>
    </>
  );
}
