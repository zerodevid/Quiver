// Laboratorium LP: satu posisi TOKEN/USDG dengan entry 100 dan modal 100 USDG.
// Pengguna menggeser range dan harga skenario lalu melihat inventori, nilai terhadap
// hold, dan BEP. Tidak ada harga live dan tidak ada transaksi.
import { useMemo } from 'react';
import { Button, Chip } from '@heroui/react';
import { RotateCcw } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from 'recharts';
import { Panel, Stat } from '../components/ui';
import { num, pct } from '../fmt';
import { simulation, ENTRY, CAPITAL } from './math';
import { sources } from './content';

const AXIS = [10, 250];

// Setiap preset adalah hipotesis untuk dicoba, bukan rekomendasi range.
export const PRESETS = [
  {
    id: 'sideways', lo: 90, hi: 110, price: 100,
    label: ['Sideways', 'Sideways'],
    thesis: ['Harga diasumsikan bolak-balik di sekitar 100. Range sempit memusatkan likuiditas, tetapi breakout kecil sudah mengeluarkannya.', 'Price is assumed to oscillate around 100. A narrow range concentrates liquidity, but a small breakout exits it.'],
  },
  {
    id: 'rise', lo: 90, hi: 140, price: 130,
    label: ['Naik, tetap aktif', 'Rise, stay active'],
    thesis: ['Harga naik ke 130 dan masih di dalam range. LP sudah menjual sebagian TOKEN, sehingga tertinggal dari hold sebelum fee.', 'Price rises to 130 and stays in range. The LP has sold part of its TOKEN, so it trails holding before fees.'],
  },
  {
    id: 'sell', lo: 110, hi: 150, price: 140,
    label: ['Jual bertahap', 'Staged sell'],
    thesis: ['Range di atas harga dimulai sebagai 100% TOKEN dan menukarnya ke USDG saat harga naik melewati range.', 'A range above price starts as 100% TOKEN and converts it to USDG as price rises through the range.'],
  },
  {
    id: 'buy', lo: 60, hi: 90, price: 75,
    label: ['Beli bertahap', 'Staged buy'],
    thesis: ['Range di bawah harga dimulai sebagai 100% USDG dan membeli TOKEN saat harga turun. Di bawah 60 posisi seluruhnya TOKEN.', 'A range below price starts as 100% USDG and buys TOKEN as price falls. Below 60 the position is entirely TOKEN.'],
  },
  {
    id: 'dump', lo: 80, hi: 120, price: 50,
    label: ['Dump −50%', 'Dump −50%'],
    thesis: ['Harga jatuh ke 50, di bawah range. Pokok kini 100% TOKEN dan tidak ada fee swap baru. Batas bawah tidak berfungsi sebagai stop-loss.', 'Price falls to 50, below the range. Principal is now 100% TOKEN and earns no new swap fees. The lower bound is not a stop-loss.'],
  },
  {
    id: 'volatile', lo: 60, hi: 160, price: 140,
    label: ['Volatil, range lebar', 'Volatile, wide range'],
    thesis: ['Range lebar memberi ruang untuk gerak besar. Likuiditas lebih tersebar, sehingga porsi fee per modal biasanya lebih kecil.', 'A wide range leaves room for large moves. Liquidity is spread thinner, so fees per unit of capital are usually lower.'],
  },
];

export const LAB_DEFAULT = { lo: 80, hi: 120, price: 100, fees: 0, costs: 0 };

const usdg = (n) => `${num(n, 2)} USDG`;

function Slider({ id, label, value, min, max, unit, onChange }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="num font-medium">{num(value, 0)}{unit && <span className="ms-1 text-xs text-muted">{unit}</span>}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step="1" value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-[var(--color-accent)]" />
    </div>
  );
}

// Keterangan grafik: contoh garis yang sebenarnya, bukan karakter ━ yang tergantung font.
function Key({ color, dashed, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden="true">
        <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      {children}
    </span>
  );
}

export default function Lab({ pick, value, onChange }) {
  const { lo, hi, price, fees, costs } = value;
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const s = useMemo(() => simulation({ lo, hi, current: price, fees, costs }), [lo, hi, price, fees, costs]);
  const curve = useMemo(() => Array.from({ length: 121 }, (_, i) => s.evaluate(AXIS[0] + i * (AXIS[1] - AXIS[0]) / 120)), [s]);
  const preset = PRESETS.find((p) => p.lo === lo && p.hi === hi && p.price === price);

  const zone = price < lo ? 'below' : price >= hi ? 'above' : 'in';
  const zoneChip = {
    in: ['success', ['Di dalam range', 'In range']],
    below: ['warning', ['Di bawah range', 'Below range']],
    above: ['warning', ['Di atas range', 'Above range']],
  }[zone];
  const zoneText = {
    in: ['Pokok berisi TOKEN dan USDG. Posisi bisa menerima fee swap.', 'Principal holds TOKEN and USDG. The position can earn swap fees.'],
    below: ['Pokok 100% TOKEN. Tidak ada fee swap baru sampai harga kembali ke range.', 'Principal is 100% TOKEN. No new swap fees until price returns to the range.'],
    above: ['Pokok 100% USDG. Tidak ada fee swap baru, dan kenaikan harga berikutnya tidak menambah nilai pokok.', 'Principal is 100% USDG. No new swap fees, and further price gains add nothing to principal.'],
  }[zone];
  const baseShare = s.principal > 0 ? (s.base * price) / s.principal * 100 : 0;
  const bepOnAxis = s.bep?.price >= AXIS[0] && s.bep?.price <= AXIS[1];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          {pick([
            `Model edukasi, bukan harga live. Entry ${ENTRY} USDG/TOKEN dengan modal ${CAPITAL} USDG; komposisi awal mengikuti posisi range terhadap harga entry. USDG dianggap stabil dan tidak ada transaksi yang dikirim.`,
            `An educational model, not live prices. Entry is ${ENTRY} USDG/TOKEN with ${CAPITAL} USDG of capital; the initial mix follows where the range sits relative to entry. USDG is treated as stable and no transactions are sent.`,
          ])}
        </p>
        <Button size="sm" variant="outline" onPress={() => onChange(LAB_DEFAULT)}>
          <RotateCcw className="size-3.5" />{pick(['Atur ulang', 'Reset'])}
        </Button>
      </div>

      <div role="radiogroup" aria-label={pick(['Skenario contoh', 'Example scenarios'])} className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {PRESETS.map((p) => {
          const on = preset?.id === p.id;
          return (
            <button key={p.id} type="button" role="radio" aria-checked={on}
              onClick={() => onChange({ ...value, lo: p.lo, hi: p.hi, price: p.price })}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                ${on ? 'border-accent bg-accent/8' : 'border-border bg-surface hover:bg-default/60'}`}>
              <span className={`block text-sm font-medium ${on ? 'text-accent' : ''}`}>{pick(p.label)}</span>
              <span className="num mt-0.5 block text-xs text-muted">{p.lo}–{p.hi} · {pick(['harga', 'price'])} {p.price}</span>
            </button>
          );
        })}
      </div>
      {preset && <p className="max-w-3xl text-sm leading-relaxed" aria-live="polite">{pick(preset.thesis)}</p>}

      <div className="grid items-start gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <Panel title={pick(['Parameter', 'Parameters'])} desc={pick(['Semua nilai dalam USDG', 'All values in USDG'])}>
          <div className="space-y-5">
            <Slider id="lab-lo" label={pick(['Batas bawah', 'Lower bound'])} value={lo} min={AXIS[0]} max={hi - 1} onChange={set('lo')} />
            <Slider id="lab-hi" label={pick(['Batas atas', 'Upper bound'])} value={hi} min={lo + 1} max={AXIS[1]} onChange={set('hi')} />
            <Slider id="lab-price" label={pick(['Harga skenario', 'Scenario price'])} value={price} min={AXIS[0]} max={AXIS[1]} onChange={set('price')} />
            <div className="border-t border-border pt-4 space-y-5">
              <Slider id="lab-fees" label={pick(['Fee terkumpul', 'Accrued fees'])} value={fees} min={0} max={30} unit="USDG" onChange={set('fees')} />
              <Slider id="lab-costs" label={pick(['Gas & slippage', 'Gas & slippage'])} value={costs} min={0} max={20} unit="USDG" onChange={set('costs')} />
            </div>
            <p className="text-xs leading-relaxed text-muted">
              {pick([
                'Fee dan biaya adalah angka asumsi yang tetap, bukan perkiraan pendapatan. Fee sesungguhnya bergantung pada jalur harga, volume, dan lama posisi berada di dalam range.',
                'Fees and costs are fixed assumptions, not income forecasts. Real fees depend on the price path, volume, and time spent in range.',
              ])}
            </p>
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={pick(['Nilai posisi', 'Position value'])} value={usdg(s.lp)} sub={pick(['pokok + fee − biaya', 'principal + fees − costs'])} />
            <Stat label="PnL" value={usdg(s.pnl)} valueClass={s.pnl > 0 ? 'text-success' : s.pnl < 0 ? 'text-danger' : ''}
              sub={`${pct(s.pnl / CAPITAL * 100, 1)} ${pick(['dari modal', 'of capital'])}`} />
            <Stat label={pick(['LP vs hold (IL)', 'LP vs hold (IL)'])} value={usdg(s.il)} valueClass={s.il < -0.005 ? 'text-danger' : ''}
              sub={pick([`hold ${num(s.hold, 2)} · sebelum fee`, `hold ${num(s.hold, 2)} · before fees`])} />
            <Stat label={pick(['Harga impas (BEP)', 'Break-even (BEP)'])} value={s.bep?.price ? num(s.bep.price, 2) : '—'}
              sub={s.bep?.price ? 'USDG / TOKEN'
                : s.bep?.reason === 'Modal sudah tertutup pada semua harga.'
                  ? pick(['modal tertutup di semua harga', 'covered at every price'])
                  : pick(['tidak tercapai dari harga', 'unreachable from price'])} />
          </div>

          <Panel title={pick(['Nilai terhadap harga', 'Value across prices'])}
            desc={pick(['Garis vertikal = harga skenario · pita = range', 'Vertical line = scenario price · band = range'])}>
            <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              <Key color="var(--color-accent)">{pick(['LP + fee − biaya', 'LP + fees − costs'])}</Key>
              <Key color="var(--color-muted)" dashed>{pick(['Hold inventori awal', 'Hold initial inventory'])}</Key>
              {bepOnAxis && <Key color="var(--color-warning)" dashed>BEP</Key>}
            </div>
            <div className="h-72 w-full" role="img"
              aria-label={pick(['Grafik nilai LP dan hold dalam USDG terhadap harga TOKEN. Angka yang sama tersedia di tabel skenario.', 'Chart of LP and hold value in USDG against TOKEN price. The same figures are in the scenario table.'])}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={curve} margin={{ top: 12, right: 12, bottom: 18, left: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" vertical={false} />
                  <XAxis type="number" dataKey="price" domain={AXIS} ticks={[10, 50, 100, 150, 200, 250]}
                    tick={{ fontSize: 11, fill: 'var(--color-muted)' }} stroke="var(--color-border)"
                    label={{ value: 'USDG / TOKEN', position: 'insideBottom', offset: -10, fill: 'var(--color-muted)', fontSize: 11 }} />
                  <YAxis width={44} tick={{ fontSize: 11, fill: 'var(--color-muted)' }} stroke="var(--color-border)" />
                  <Tooltip
                    contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
                    formatter={(v, n) => [usdg(v), n]} labelFormatter={(v) => `${num(v, 2)} USDG / TOKEN`} />
                  <ReferenceArea x1={lo} x2={hi} fill="var(--color-accent)" fillOpacity={0.08} />
                  <ReferenceLine y={CAPITAL} stroke="var(--color-muted)" strokeDasharray="2 4"
                    label={{ value: pick(['modal', 'capital']), position: 'insideTopLeft', fill: 'var(--color-muted)', fontSize: 10 }} />
                  <ReferenceLine x={price} stroke="var(--color-foreground)" strokeOpacity={0.6} />
                  {bepOnAxis && <ReferenceLine x={s.bep.price} stroke="var(--color-warning)" strokeDasharray="5 3" />}
                  <Line type="monotone" dataKey="hold" name="Hold" stroke="var(--color-muted)" strokeDasharray="6 4" dot={false} strokeWidth={1.75} isAnimationActive={false} />
                  <Line type="monotone" dataKey="lp" name="LP" stroke="var(--color-accent)" dot={false} strokeWidth={2.25} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {s.bep?.price > 0 && !bepOnAxis && (
              <p className="mt-2 text-xs text-warning">BEP {num(s.bep.price, 2)} USDG/TOKEN · {pick(['di luar sumbu grafik', 'outside the chart axis'])}</p>
            )}
          </Panel>

          <Panel title={pick(['Inventori pada harga skenario', 'Inventory at the scenario price'])}
            action={<Chip size="sm" variant="soft" color={zoneChip[0]}>{pick(zoneChip[1])}</Chip>}>
            <p className="mb-3 text-sm">{pick(zoneText)}</p>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-default" role="img"
              aria-label={`TOKEN ${num(baseShare, 1)}%, USDG ${num(100 - baseShare, 1)}%`}>
              <div className="bg-accent" style={{ width: `${baseShare}%` }} />
              <div className="bg-warning/80" style={{ width: `${100 - baseShare}%` }} />
            </div>
            <div className="mt-2.5 grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
                <span className="num">{num(s.base, 4)} TOKEN</span>
                <span className="num text-xs text-muted">{num(baseShare, 1)}%</span>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                <span className="size-2 rounded-full bg-warning/80" aria-hidden="true" />
                <span className="num">{num(s.quote, 2)} USDG</span>
                <span className="num text-xs text-muted">{num(100 - baseShare, 1)}%</span>
              </div>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
              {pick(['Saat entry', 'At entry'])}: <span className="num">{num(s.initial.base, 4)} TOKEN + {num(s.initial.quote, 2)} USDG</span>.{' '}
              {pick(['Fee tidak termasuk dalam bar inventori.', 'Fees are excluded from the inventory bar.'])}
            </p>
          </Panel>
        </div>
      </div>

      <details className="group rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{pick(['Tabel skenario & rumus', 'Scenario table & formulas'])}</summary>
        <div className="border-t border-border p-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <caption className="mb-2 text-left text-xs text-muted">
                {pick(['Nilai dalam USDG. Fee dan biaya mengikuti parameter di atas.', 'Values in USDG. Fees and costs follow the parameters above.'])}
              </caption>
              <thead>
                <tr className="text-xs text-muted">
                  {['USDG / TOKEN', pick(['Nilai LP', 'LP value']), 'Hold', 'PnL', 'IL'].map((h, i) => (
                    <th key={h} scope="col" className={`border-b border-border px-2 py-2 font-medium ${i ? 'text-end' : 'text-start'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[50, 80, 100, 120, 150, 200].map((p) => {
                  const v = s.evaluate(p);
                  return (
                    <tr key={p} className={p === ENTRY ? 'bg-default/40' : ''}>
                      {[p, v.lp, v.hold, v.pnl, v.il].map((n, i) => (
                        <td key={i} className={`num border-b border-border px-2 py-2 ${i ? 'text-end' : ''}`}>{num(n, 2)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <pre className="mono mt-4 overflow-x-auto rounded-md bg-default/50 p-3 text-xs leading-relaxed">{`s     = √clamp(P, lower, upper)
base  = L × (1/s − 1/√upper)
quote = L × (s − √lower)
L     = ${pick(['modal', 'capital'])} / (base₁ × ${ENTRY} + quote₁)   ${pick(['// base₁, quote₁ pada L = 1', '// base₁, quote₁ at L = 1'])}
LP    = base × P + quote + fee − ${pick(['biaya', 'costs'])}
IL    = base × P + quote − hold`}</pre>
          <a className="mt-3 inline-block text-xs text-accent underline underline-offset-2" href={sources[2].href} target="_blank" rel="noreferrer">
            Uniswap · {sources[2].label}
          </a>
        </div>
      </details>
    </div>
  );
}
