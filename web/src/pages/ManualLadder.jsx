// Layered ("ladder") entry for manual LP: one budget spread over several adjacent
// single-sided ranges below the price, heavier the deeper they go. The math that decides the
// real layers lives on the server (manual.ladderLayers); the edges are mirrored here only to
// draw the bands before a plan has arrived.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner, toast } from '@heroui/react';
import { TriangleAlert } from 'lucide-react';
import { get, post } from '../api';
import { Notice, Segmented, KV } from '../components/ui';
import { usd, num, price, tickPrice } from '../fmt';
import { useI18n } from '../i18n';

export const LADDER_METHODS = [
  ['linear', 'Naik bertahap'],
  ['equal', 'Rata'],
  ['grow15', 'Berat ×1,5'],
  ['double', 'Berat ×2'],
];
const METHOD_HINT = {
  equal: 'Setiap layer dapat porsi yang sama.',
  linear: 'Layer ke-1 porsi 1, ke-2 porsi 2, dst — makin dalam makin besar.',
  grow15: 'Tiap layer 1,5× layer di atasnya — dana menumpuk di bawah.',
  double: 'Tiap layer 2× layer di atasnya — hampir semua dana di layer terdalam.',
};
// [top %, bottom %, label]: how far below the price the nearest layer starts and the deepest ends
const LADDER_PRESETS = [[0, 40, 'Dekat · −40%'], [5, 60, 'Sedang · −5% … −60%'], [10, 80, 'Dalam · −10% … −80%']];
const LAYER_CHOICES = [3, 4, 5, 6, 8, 10];

const toNum = (s) => Number(String(s).replace(',', '.') || 0);

// Price ratios (to the current price) of the n+1 layer edges, nearest first.
function edges(top, bottom, n) {
  const rTop = 1 - top / 100, rBot = 1 - bottom / 100;
  return Array.from({ length: n + 1 }, (_, i) => rTop * (rBot / rTop) ** (i / n));
}

// Budget per layer, same weights and rounding as the server (manual.ladderLayers): shown
// at once, while the plan is still being fetched.
const WEIGHT = { equal: () => 1, linear: (i) => i + 1, grow15: (i) => 1.5 ** i, double: (i) => 2 ** i };
function split(total, n, method) {
  const w = Array.from({ length: n }, (_, i) => WEIGHT[method](i));
  const sum = w.reduce((a, b) => a + b, 0);
  const cents = w.map((x) => Math.floor((total * x / sum) * 100));
  cents[n - 1] += Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);
  return cents.map((c) => c / 100);
}

export function useLadder({ pool, usdNum, enabled, onOpened }) {
  const [top, setTop] = useState('0');
  const [bottom, setBottom] = useState('60');
  const [layers, setLayers] = useState(5);
  const [method, setMethod] = useState('linear');
  const [plan, setPlan] = useState(null);       // { layers, preview, warnings } | { error }
  const [compute, setCompute] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState(null);         // job state while/after opening
  const seq = useRef(0);

  const topN = toNum(top), botN = toNum(bottom);
  const rangeOk = topN >= 0 && botN > topN && botN < 100;
  const ready = !!pool && usdNum > 0 && rangeOk;
  const bands = useMemo(() => {
    if (!rangeOk) return null;
    const e = edges(topN, botN, layers);
    const amounts = usdNum > 0 ? split(usdNum, layers, method) : null;
    return e.slice(0, -1).map((hi, i) => ({ hi, lo: e[i + 1], usd: amounts ? amounts[i] : null }));
  }, [rangeOk, topN, botN, layers, method, usdNum]);

  useEffect(() => {
    setConfirm(false);
    if (!enabled || !ready) { setPlan(null); setCompute(false); return undefined; }
    const mine = ++seq.current;
    setCompute(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/ladder/plan', { poolRef: pool.poolRef, usd: usdNum, topPct: topN, bottomPct: botN, layers, method });
      if (mine !== seq.current) return;
      setPlan({ ...r, _ref: pool.poolRef }); setCompute(false);
    }, 400);
    return () => clearTimeout(id);
  }, [enabled, ready, pool?.poolRef, usdNum, topN, botN, layers, method]);

  const start = useCallback(async () => {
    setConfirm(false);
    setRun({ status: 'running', done: 0, total: layers, opened: [] });
    const r = await post('/api/manual/ladder/open', { poolRef: pool.poolRef, usd: usdNum, topPct: topN, bottomPct: botN, layers, method });
    if (r.error) { setRun(null); return toast.danger(r.error); }
    const poll = async () => {
      const j = await get(`/api/manual/ladder/job?id=${r.job}`).catch(() => null);
      if (!j || j.error === 'job tidak ditemukan') { setRun((x) => ({ ...x, status: 'error', error: j?.error || 'koneksi terputus — cek halaman Posisi' })); return; }
      setRun(j);
      if (j.status === 'running') { setTimeout(poll, 1500); return; }
      onOpened?.();
      if (j.status === 'done') toast.success(`${j.opened.length} layer dibuka`);
    };
    poll();
  }, [pool?.poolRef, usdNum, topN, botN, layers, method, onOpened]);

  return { top, setTop, bottom, setBottom, layers, setLayers, method, setMethod, plan, compute, confirm, setConfirm,
    run, setRun, start, topN, botN, rangeOk, ready, bands };
}

function NumBox({ label, value, onChange, invalid, hint }) {
  const { t } = useI18n();
  return (
    <label className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border p-3 transition-colors ${invalid ? 'border-danger/60' : 'border-border focus-within:border-accent'}`}>
      <span className="text-xs text-muted">{t(label)}</span>
      <span className="flex items-baseline gap-1">
        <span className="num w-6 shrink-0 text-lg font-semibold text-muted">−</span>
        <input value={value} inputMode="decimal" placeholder="0" aria-label={t(label)}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
          className="num w-full min-w-0 bg-transparent text-lg font-semibold outline-none placeholder:text-muted/60" />
        <span className="text-lg text-muted">%</span>
      </span>
      <span className="num h-4 truncate text-xs text-muted">{hint || ''}</span>
    </label>
  );
}

// Layer prices from the plan's ticks, as the user sees them (in the quote asset).
const layerPrices = (l, p) => {
  const a = tickPrice(l.tickLower, p.dec0, p.dec1, p.quoteSide), b = tickPrice(l.tickUpper, p.dec0, p.dec1, p.quoteSide);
  return [Math.min(a, b), Math.max(a, b)];
};

export function LadderStep({ L, chart }) {
  const { t } = useI18n();
  const p = L.plan?.preview;
  const curPx = p ? tickPrice(p.curTick, p.dec0, p.dec1, p.quoteSide) : null;
  const sym = p ? (p.quoteSide === 0 ? p.symbol0 : p.symbol1) : '';
  const px = (pct) => (curPx != null ? `≈ ${price(curPx * (1 - pct / 100))} ${sym}` : '');
  return (
    <div className="flex flex-col gap-3">
      {chart}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{t('Metode')}</span>
        <Segmented size="sm" aria="Metode layer" value={L.method} onChange={L.setMethod} options={LADDER_METHODS} />
      </div>
      <p className="text-xs text-muted">{t(METHOD_HINT[L.method])}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{t('Jumlah layer')}</span>
        <Segmented size="sm" aria="Jumlah layer" value={L.layers} onChange={L.setLayers} options={LAYER_CHOICES.map((n) => [n, String(n)])} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LADDER_PRESETS.map(([a, b, label]) => (
          <button key={label} type="button" onClick={() => { L.setTop(String(a)); L.setBottom(String(b)); }}
            aria-pressed={L.topN === a && L.botN === b}
            className={`num h-8 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors ${L.topN === a && L.botN === b
              ? 'border-accent bg-accent/10 text-accent' : 'border-border text-foreground hover:bg-default/60'}`}>{t(label)}</button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <NumBox label="Layer terdekat mulai (di bawah harga)" value={L.top} onChange={L.setTop} invalid={!L.rangeOk} hint={L.rangeOk ? px(L.topN) : ''} />
        <NumBox label="Layer terdalam berakhir (di bawah harga)" value={L.bottom} onChange={L.setBottom} invalid={!L.rangeOk} hint={L.rangeOk ? px(L.botN) : ''} />
      </div>
      {!L.rangeOk && <p className="text-xs text-danger">{t('Batas terdalam harus lebih jauh di bawah harga daripada layer terdekat, dan kurang dari 100%.')}</p>}
      {L.bands?.[0]?.usd != null && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {L.bands.map((b, i) => (
            <div key={i} className="rounded-md border border-border px-2.5 py-1.5">
              <div className="text-[0.6875rem] text-muted">{t('Layer {n}', { n: i + 1 })}</div>
              <div className="num text-sm font-semibold">{usd(b.usd)}</div>
              <div className="num text-[0.6875rem] text-muted">−{num((1 - b.hi) * 100, 1)}% … −{num((1 - b.lo) * 100, 1)}%</div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted">{t('Semua layer ada di bawah harga kini, jadi hanya aset kuotasi (misal USDG) yang disetor — tanpa swap. Dana di sebuah layer baru berubah jadi token saat harga turun menembus layer itu.')}</p>
    </div>
  );
}

export function LadderPreview({ L, dry }) {
  const { t } = useI18n();
  const { plan, run } = L;
  const p = plan?.preview;

  if (run) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {run.status === 'running' && <Spinner size="sm" />}
          {run.status === 'running' ? t('Membuka layer {d}/{n}…', { d: Math.min(run.done + 1, run.total), n: run.total })
            : run.status === 'done' ? t('Semua layer terbuka') : t('Berhenti di tengah jalan')}
        </div>
        {!!run.opened?.length && (
          <ol className="divide-y divide-border rounded-md border border-border text-sm">
            {run.opened.map((o) => (
              <li key={o.tx || o.n} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>{t('Layer {n}', { n: o.n })}</span><span className="num text-muted">{usd(o.usd)}</span>
              </li>
            ))}
          </ol>
        )}
        {run.error && <Notice status="danger" title={t('Gagal')}>{run.error}{run.opened?.length ? ` — ${t('{n} layer sudah terbuka dan tetap berjalan.', { n: run.opened.length })}` : ''}</Notice>}
        {run.status !== 'running' && (
          <div className="flex gap-2">
            <Button className="flex-1" onPress={() => { location.hash = 'positions'; }}>{t('Lihat posisi')}</Button>
            <Button variant="outline" onPress={() => L.setRun(null)}>{t('Tutup')}</Button>
          </div>
        )}
      </div>
    );
  }

  if (!L.ready) return <p className="text-sm text-muted">{t('Pilih pool, isi nominal, dan atur layer — pratinjau muncul sendiri.')}</p>;
  if (plan?.error) return <Notice status="danger" title={t('Belum bisa dibuka')}>{plan.error}</Notice>;
  if (!p) return <Spinner />;
  const totalUsd = p.totalUsd;
  return (
    <>
      <div>
        <div className="text-xs text-muted">{t('Total {n} layer', { n: plan.layers.length })}</div>
        <div className="num text-[1.5rem] leading-tight font-semibold tracking-tight">{usd(totalUsd)}</div>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted">
              <th className="px-2 py-1.5 text-start font-normal">#</th>
              <th className="px-2 py-1.5 text-end font-normal">{t('Rentang')}</th>
              <th className="px-2 py-1.5 text-end font-normal">{t('Nilai')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.layers.map((l) => {
              const [a, b] = layerPrices(l, p);
              return (
                <tr key={l.n} className="border-t border-border align-top">
                  <td className="num px-2 py-1.5">{l.n}</td>
                  <td className="num px-2 py-1.5 text-end">
                    <div>{price(a)} – {price(b)}</div>
                    <div className="text-muted">−{num(-l.upperPctEff, 1)}% … −{num(l.lowerPctEff, 1)}%</div>
                  </td>
                  <td className="num px-2 py-1.5 text-end">
                    <div>{usd(l.valueUsd)}</div>
                    <div className="text-muted">{num((l.valueUsd / totalUsd) * 100, 0)}%</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-border border-y border-border">
        <KV label="Kas setelah dibuka">{usd(Math.max(0, p.walletCashUsd - totalUsd))}</KV>
      </div>
      {(plan.warnings || []).map((w) => (
        <div key={w} className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{w}</span>
        </div>
      ))}
      <p className="text-xs text-muted">{t('Layer dibuka satu per satu, dari yang terdekat. Kalau satu gagal, yang sudah terbuka tetap berjalan.')}</p>
      {dry ? (
        <Button variant="outline" className="w-full" onPress={() => { location.hash = 'settings'; }}>{t('Nyalakan LIVE dulu')}</Button>
      ) : !L.confirm ? (
        <Button className="w-full" onPress={() => L.setConfirm(true)}>{t('Buka {n} layer · {v}', { n: plan.layers.length, v: usd(totalUsd) })}</Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <div className="text-sm font-medium">{t('Kirim {n} transaksi sungguhan?', { n: plan.layers.length })}</div>
          <div className="text-sm text-muted">{t('{v} ke {pair}, di −{a}% sampai −{b}% dari harga kini.', { v: usd(totalUsd), pair: p.pair, a: num(L.topN, 1), b: num(L.botN, 1) })}</div>
          <div className="flex gap-2">
            <Button className="flex-1" onPress={L.start}>{t('Ya, buka sekarang')}</Button>
            <Button variant="outline" onPress={() => L.setConfirm(false)}>{t('Batal')}</Button>
          </div>
        </div>
      )}
    </>
  );
}
