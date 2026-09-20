import { useCallback, useState } from 'react';
import { useStatus } from '../App';
import { usePoll, useResync } from '../hooks';
import { PageHeader, Stat, Panel, Empty, Loading, Notice, KV, Dot, DataTable, PriceRange, Segmented, Refresh } from '../components/ui';
import PnlCalendar from '../components/PnlCalendar';
import GrowthChart from '../components/GrowthChart';
import ShareButton, { ShareDialog, totalCard, dailyCard } from '../components/ShareCard';
import { Pair, SyncState } from './Positions';
import PositionHistory from '../components/PositionHistory';
import { usd, tone, num, pct, age, ago, short, txHref, locale as fmtLocale, TXKIND, TXSTATUS } from '../fmt';
import { useI18n, reason } from '../i18n';

const RANGES = [['24h', '24 jam'], ['7d', '7 hari'], ['30d', '30 hari'], ['all', 'Semua']];
const VIEWS = [['pnl', 'PnL kumulatif'], ['value', 'Nilai']];
// PnL bersih hanya ada kalau modal wallet terlacak (setoran/penarikan via Alchemy).
const VIEWS_NET = [['net', 'PnL bersih'], ...VIEWS];
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);

// Jembatan PnL kumulatif → PnL bersih. Dua angka "PnL" yang beda $20-an tanpa
// keterangan terbaca sebagai bug. Selisihnya biaya yang dibayar dari wallet di luar
// posisi: gas (dihitung dari tabel txs) dan sisanya — slippage swap, pergerakan
// harga ETH yang dipegang — yang tidak bisa dipisah satu per satu.
function PnlGap({ p }) {
  const { t } = useI18n();
  const n = p.now, c = p.capital;
  if (n.netPnl == null) return null;
  const gas = n.gasUsd || 0;
  const other = n.netPnl - (n.pnl - gas);
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
          {t('{a} − gas {g} {o} = {b}', { a: usd(n.pnl), g: usd(gas), o: `${other < 0 ? '−' : '+'} ${usd(Math.abs(other))}`, b: usd(n.netPnl) })}
        </span>
      </summary>
      <div className="mt-2 max-w-2xl pl-4">
        <p className="text-xs text-muted">
          {t('PnL kumulatif menjumlahkan hasil tiap posisi: hasil keluar dikurangi modal posisi itu. PnL bersih membandingkan nilai wallet sekarang dengan modal, jadi semua yang dibayar dari wallet di luar posisi ikut terhitung. PnL bersih adalah untung yang benar-benar bertambah.')}
        </p>
        <div className="mt-2 divide-y divide-border">
          <Row label="PnL kumulatif (hasil posisi)" v={n.pnl} />
          <Row label="Gas" sub={t('{n} transaksi, termasuk yang gagal', { n: num(n.gasTxCount || 0) })} v={-gas} />
          <Row label="Slippage swap & pergerakan harga ETH" sub={t('sisa selisih')} v={other} />
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

// Ke mana uangnya. Pertanyaan utama untuk bot LP: berapa bagian dana yang benar-benar
// bekerja di posisi, berapa yang menganggur di kas. Satu batang bertumpuk (bagian dari
// keseluruhan) dengan dua keluarga warna — biru = bekerja, abu = kas — dan daftar
// yang dikelompokkan sama. Identitas tiap potong tidak hanya dari warna: tiap baris
// punya kotak warnanya, dan menyorot baris/potong saling menyalakan.
function Composition({ now, ethUsd }) {
  const { t } = useI18n();
  const [hot, setHot] = useState(null);
  const c = now.cash;
  const ethVal = c ? (c.usd - c.usdg) : 0;            // nilai ETH+WETH saat kas dibaca
  const perEth = c && c.eth + c.weth > 0 ? ethVal / (c.eth + c.weth) : ethUsd;
  const tint = (base, pct) => `color-mix(in oklab, ${base} ${pct}%, var(--surface))`;
  const working = [
    { k: 'Posisi LP', v: now.positionsUsd, sub: t('{n} posisi · {r} in-range', { n: now.openCount, r: now.inRange }), color: tint('var(--accent)', 100) },
    { k: 'Fee belum diklaim', v: now.feeUsd, color: tint('var(--accent)', 62) },
    { k: 'Token sisa belum dijual', v: now.leftoverUsd || 0, color: tint('var(--accent)', 38) },
  ].filter((r, i) => i === 0 || r.v > 0.005);
  const idle = c ? [
    { k: 'USDG', v: c.usdg },
    { k: 'WETH', v: c.weth * perEth, sub: `${num(c.weth, 5)} WETH` },
    { k: 'ETH', v: c.eth * perEth, sub: `${num(c.eth, 5)} ETH` },
  ].filter((r) => r.v > 0.005).sort((x, y) => y.v - x.v).map((r, i) => ({ ...r, color: tint('var(--foreground)', [36, 24, 15][i] ?? 15) })) : [];
  const all = [...working, ...idle];
  const total = Math.max(1e-9, sum(all, (r) => r.v));
  const workUsd = sum(working, (r) => r.v), idleUsd = sum(idle, (r) => r.v);
  const share = (v) => (v / total) * 100;
  const fmtPct = (v) => `${num(share(v), share(v) < 10 ? 1 : 0)}%`;
  const dimmed = (k) => hot != null && hot !== k;

  // fungsi render biasa, bukan komponen: komponen yang dibuat ulang tiap render akan
  // dipasang ulang saat sorotan berubah dan hover-nya berkedip
  const item = (r) => (
    <div key={r.k} className={`flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm transition-colors ${hot === r.k ? 'bg-default/60' : ''}`}
      onMouseEnter={() => setHot(r.k)} onMouseLeave={() => setHot(null)}>
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: r.color }} />
      <span className="min-w-0 flex-1 truncate">{t(r.k)}{r.sub && <span className="ml-1.5 text-xs text-muted">{r.sub}</span>}</span>
      <span className="num shrink-0 font-medium">{usd(r.v)}</span>
      <span className="num w-11 shrink-0 text-end text-xs text-muted">{fmtPct(r.v)}</span>
    </div>
  );
  const group = (label, v, rows) => (
    <div className="pt-2.5">
      <div className="flex items-baseline gap-2.5 px-1.5 pb-0.5 text-xs">
        <span className="flex-1 font-medium text-muted">{t(label)}</span>
        <span className="num font-medium text-muted">{usd(v)}</span>
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
          // modal nyata: baseline + setoran − penarikan (capital.js) — sama dengan kartu PnL bersih
          ? <KV label="Modal bersih"><span title={t('Nilai wallet saat bot mulai mencatat + setoran − penarikan')}>{usd(now.capitalNet)}</span></KV>
          : now.capital != null && (
          <KV label="Modal bersih"><span title={t('Nilai sekarang dikurangi seluruh PnL — kira-kira dana yang disetor ke wallet bot')}>{usd(now.capital)}</span></KV>
        )}
        <KV label="Modal di posisi">{usd(now.costUsd)}</KV>
      </div>
    </div>
  );
}

// Kinerja per sumber: target mana yang benar-benar menghasilkan setelah disalin.
// Batang divergen dari satu garis nol — untung ke kanan (hijau), rugi ke kiri
// (merah) — supaya sumber yang merugi terbaca sebagai rugi, bukan batang pendek.
function BySource({ rows }) {
  const { t } = useI18n();
  if (!rows.length) return <div className="p-4"><Empty title="Belum ada posisi" /></div>;
  const tots = rows.map((r) => r.realized + r.upnl);
  const maxPos = Math.max(0, ...tots), maxNeg = Math.max(0, ...tots.map((v) => -v));
  const span = Math.max(1e-9, maxPos + maxNeg);
  const zero = (maxNeg / span) * 100;   // letak garis nol dalam persen lebar
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

// Ringkasan posisi ditutup: empat angka dalam kisi, bukan daftar label panjang.
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

// Delapan angka milidetik berjajar tidak bisa dibaca sekilas. Yang dicari mata:
// "apakah RPC-nya sehat?" — jadi tampilkan median, dan sisanya di tooltip.
function Latency({ rpc }) {
  const { t } = useI18n();
  const ms = rpc.map((r) => r.lastMs).filter((x) => x != null).sort((a, b) => a - b);
  if (!ms.length) return <span className="text-muted">—</span>;
  const med = ms[Math.floor(ms.length / 2)];
  const cooling = rpc.filter((r) => r.cooling).length;
  const judul = rpc.map((r) => `${r.host} · ${r.lastMs} ms${r.cooling ? ' · istirahat' : ''}${r.errors ? ` · ${r.errors} error` : ''}`).join('\n');
  return (
    <span title={judul}>
      {t('{n} ms', { n: med })}
      <span className="ml-1.5 font-normal text-muted">{t('median · {n} RPC', { n: rpc.length })}</span>
      {cooling > 0 && <span className="ml-1.5 font-normal text-warning">{t('{n} istirahat', { n: cooling })}</span>}
    </span>
  );
}

// PnL per hari dikelompokkan di browser supaya "hari" mengikuti zona waktu pengguna,
// bukan zona waktu server.
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

export default function Overview() {
  const { t } = useI18n();
  const { status: d } = useStatus();
  const [range, setRange] = useState('7d');
  // Tampilan awal: PnL bersih kalau modal terlacak; kalau tidak, PnL kumulatif.
  const [viewPick, setView] = useState('net');
  const [shareDay, setShareDay] = useState(null);   // 'YYYY-MM-DD' yang diklik di kalender
  const { data: p, reload: reloadPortfolio } = usePoll('/api/portfolio?range=' + range, 30000);
  // Sama dengan halaman Posisi: endpoint murah, jadi posisi baru muncul dalam ~5 detik.
  const { data: pos, reload: reloadPos } = usePoll('/api/positions', 5000);
  // Klik baris posisi aktif -> laci riwayat yang sama dengan halaman Posisi (PnL,
  // komposisi token, transaksi); nama token tetap menaut ke halaman tokennya.
  const [hist, setHist] = useState(null);
  const { data: tx } = usePoll('/api/txs', 10000);
  // Satu sinkron chain menyegarkan SELURUH halaman, bukan cuma tabelnya: kartu total
  // portofolio dan PnL dihitung dari hasil sinkron yang sama, dan dua angka untuk
  // hal yang sama dengan umur berbeda di satu layar adalah bug yang terlihat.
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadPos(), reloadPortfolio()]);
  }, [reloadPos, reloadPortfolio]);
  const [resync, syncing] = useResync(reloadAll);
  if (!d) return <Loading page />;
  const s = d.summary, T = d.totals || {};
  // Kursor bisa sedikit MENDAHULUI kepala rantai yang terakhir dibaca; itu sinkron,
  // bukan "tertinggal −19 blok".
  const lag = Math.max(0, d.chain.lag);
  const maxSkip = Math.max(1, ...(d.skipReasons || []).map((r) => r.n));
  const now = p?.now, st = p?.stats;
  const view = viewPick === 'net' && now?.netPnl == null ? 'pnl' : viewPick;
  const open = (pos?.positions || []).filter((x) => !x.empty);
  // Posisi yang belum ikut sinkron chain: nilai masih taksiran modal, fee & PnL belum ada.
  const pendingSync = open.filter((x) => x.syncing).length;
  const dash = (x, node) => (x.syncing ? <span className="text-muted">—</span> : node);
  const cal = p ? dailyOf(p.closed) : null;

  return (
    <>
      <PageHeader group="Pemantauan" title="Ringkasan">
        <ShareButton label="Bagikan total PnL" isDisabled={!now} card={now ? totalCard({ pnl: now.netPnl ?? now.pnl, net: now.netPnl != null }) : null} />
      </PageHeader>
      {/* Kartu PnL harian: hari yang diklik di kalender. Server merakit datanya sendiri. */}
      <ShareDialog card={shareDay && cal ? dailyCard({ day: shareDay, pnl: cal.daily[shareDay] }) : null} onClose={() => setShareDay(null)} />
      <PositionHistory id={hist} onClose={() => setHist(null)} />
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Total portofolio" value={now ? usd(now.value) : '—'}
          sub={!now ? null : now.cash
            ? t('kas {c} · di posisi {p}', { c: usd(now.cash.usd), p: usd(now.positionsUsd + now.feeUsd) })
              + ((now.leftoverUsd || 0) > 0.005 ? t(' · sisa token {v}', { v: usd(now.leftoverUsd) }) : '')
            : t('hanya posisi — saldo kas tidak terbaca')} />
        {now?.netPnl != null
          // Modal wallet terlacak: yang utama PnL bersih terhadap modal nyata; PnL
          // per-posisi (tanpa biaya zap/gas/swap) jadi keterangan.
          ? <Stat label="PnL bersih" value={usd(now.netPnl)} valueClass={tone(now.netPnl)}
            sub={t('modal {m} · {p} · PnL posisi {v}', { m: usd(now.capitalNet), p: pct((now.netPnl / now.capitalNet) * 100, 2), v: usd(now.pnl) })} />
          : <Stat label="Total PnL" value={now ? usd(now.pnl) : '—'} valueClass={now ? tone(now.pnl) : ''}
            sub={!now ? null : t('terealisasi {r} · berjalan {u}', { r: usd(now.realizedUsd), u: usd(now.unrealizedUsd) })
              + (now.capital > 0 ? ` · ${pct((now.pnl / now.capital) * 100, 2)}` : '')} />}
        <Stat label="Fee terkumpul" value={usd(s.feeUsd)}
          sub={s.costUsd > 0 ? t('{p}% dari modal · belum diklaim', { p: num((s.feeUsd / s.costUsd) * 100, 2) }) : t('belum diklaim')} />
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
        action={<div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
          <Refresh at={pos?.syncedAt} busy={syncing} onPress={resync} />
          <SyncState syncedAt={pos?.syncedAt} pending={pendingSync} />
          {open.length > 0 && <>
            <span className="whitespace-nowrap"><span className="text-muted">{t('Nilai')}</span> <span className="num font-medium">{usd(sum(open, (x) => x.valueUsd))}</span></span>
            <span className="whitespace-nowrap"><span className="text-muted">{t('uPnL')}</span> <span className={`num font-medium ${tone(sum(open, (x) => x.pnlUsd))}`}>{usd(sum(open, (x) => x.pnlUsd))}</span></span>
          </>}
          <a href="#positions" className="font-medium text-accent hover:underline">{t('Semua posisi →')}</a>
        </div>}>
        {!pos?.positions ? <Loading text="Memuat posisi…" /> : (
          <DataTable label="Posisi aktif" rows={open} rowKey={(x) => x.id} dense onRow={(x) => setHist(x.id)}
            defaultSort={{ column: 'val', direction: 'descending' }}
            empty={<Empty title="Tidak ada posisi aktif" sub="Posisi muncul di sini setelah bot menyalin LP dari wallet target." />}
            columns={[
              { key: 'pair', label: 'Pasangan', sort: (x) => `${x.symbol0}/${x.symbol1}`, render: (x) => <Pair p={x} link={false} /> },
              // Versi ringkas kolom Sumber di halaman Posisi: cukup siapa yang disalin
              // (rincian PnL target ada di sana), supaya panel ringkasan tetap padat.
              { key: 'tgt', label: 'Sumber', sort: (x) => x.targetLabel || x.target || '', render: (x) => (
                x.target ? (
                  <a href={'#targets/' + x.target} className="group block max-w-40" title={x.target}>
                    {x.targetLabel && <div className="truncate font-medium group-hover:underline">{x.targetLabel}</div>}
                    <div className="mono text-xs whitespace-nowrap text-muted group-hover:text-foreground">{short(x.target)}</div>
                  </a>
                ) : <span className="text-xs text-muted">{t('Manual / di luar bot')}</span>) },
              { key: 'range', label: 'Rentang harga', sortable: false, render: (x) => (
                <PriceRange position={x} lo={x.tick_lower} hi={x.tick_upper} cur={x.curTick}
                  dec0={x.dec0} dec1={x.dec1} quoteSide={x.quoteSide} symbol0={x.symbol0} symbol1={x.symbol1}
                  entrySqrt={x.entrySqrt} exitSqrt={x.exitSqrt} showPrices={false} />) },
              { key: 'val', label: 'Nilai', align: 'end', sort: (x) => x.valueUsd, render: (x) => (
                <div className="whitespace-nowrap">{usd(x.valueUsd)}<div className="text-xs text-muted">{t('modal {v}', { v: usd(x.costUsd) })}</div></div>) },
              { key: 'fee', label: 'Fee', align: 'end', sort: (x) => x.feeUsd, render: (x) => dash(x, <span className={x.feeUsd > 0.005 ? 'text-success' : 'text-muted'}>{usd(x.feeUsd)}</span>) },
              { key: 'pnl', label: 'PnL', align: 'end', sort: (x) => x.pnlUsd, render: (x) => dash(x, (
                <div className={`whitespace-nowrap ${tone(x.pnlUsd)}`}>{usd(x.pnlUsd)}<div className="text-xs">{pct(x.pnlPct)}</div></div>)) },
              { key: 'age', label: 'Umur', align: 'end', sort: (x) => x.ageHours, render: (x) => <span className="whitespace-nowrap text-muted">{age(x.ageHours)}</span> },
            ]} />
        )}
      </Panel>

      {/* Rata tinggi: kolom kanan meregang setinggi kalender, tidak meninggalkan celah */}
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

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Kesehatan mesin" bodyClass="p-0" className="h-full">
          <div className="divide-y divide-border px-4">
            <KV label="Blok terkini">{num(d.chain.head)}</KV>
            <KV label="Tertinggal">
              <Dot tone={lag < 60 ? 'success' : 'warning'} />
              <span className="ml-1.5">{lag === 0 ? t('sinkron') : t('{n} blok', { n: num(lag) })}</span>
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
                    {/* batang tipis: perbandingan antaralasan terbaca tanpa membaca angkanya */}
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
                    {/* status bukan hanya warna titik — dan tidak ikut terpotong bersama namanya */}
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
