// "Create a pool" for manual LP: a new pool for a token against one of the chain's quote
// assets, opened together with its first position.
//   EVM    : Uniswap v3 / PancakeSwap v3 (fee tiers), Uniswap v4 (any fee + tick spacing + hook)
//   Solana : Meteora DAMM v2 (any fee, full range), Meteora DLMM (bin step + fee presets)
// Only the pool's settings are picked here; amount and range reuse the manual LP steps, and the
// server (manual.planCreate / openCreate) checks everything again before sending.
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { get, post } from '../api';
import { num, price } from '../fmt';
import { plainDecimal } from '../../../src/number-format.mjs';
import { useI18n } from '../i18n';
import { isAddr, canonAddr } from '../chain';

// v4 fee in percent -> the tick spacing Uniswap's own UI pairs with it.
const V4_PRESETS = [[0.01, 1], [0.05, 10], [0.3, 60], [1, 200]];
const spacingFor = (pct) => (V4_PRESETS.find(([f]) => f === pct)?.[1] ?? (pct <= 0.01 ? 1 : pct <= 0.05 ? 10 : pct <= 0.3 ? 60 : 200));
// DAMM v2 static fee presets (percent); any multiple of 0.01% is accepted.
const DAMM_PRESETS = [0.25, 0.3, 1, 2, 5];
const toNum = (s) => Number(String(s).replace(',', '.'));

export function useCreatePool(enabled) {
  const [meta, setMeta] = useState(null);          // { venues, quotes }
  const [venue, setVenue] = useState('');
  const [token, setToken] = useState('');
  const [quote, setQuote] = useState('');
  const [feePct, setFeePct] = useState('0.3');
  const [spacing, setSpacing] = useState('60');
  const [spacingTouched, setSpacingTouched] = useState(false);
  const [binStep, setBinStep] = useState(null);
  const [hooks, setHooks] = useState('');
  const [price, setPrice] = useState('');
  const [market, setMarket] = useState(null);      // suggested starting price from USD prices

  useEffect(() => {
    if (!enabled || meta) return;
    get('/api/manual/create/venues').then((d) => {
      setMeta(d);
      if (d.venues?.length) setVenue((x) => (d.venues.some((v) => v.key === x) ? x : d.venues[0].key));
      if (d.quotes?.length) setQuote((q) => q || d.quotes[0].address);
    });
  }, [enabled, meta]);

  const v = meta?.venues?.find((x) => x.key === venue) || null;
  const v4 = venue === 'v4', damm = venue === 'dammv2', dlmm = venue === 'meteora';
  const fee = Math.round(toNum(feePct) * 10000);
  // Keep the fee valid for the venue picked: v3 tiers, DLMM presets of the bin step.
  const binSteps = useMemo(() => [...new Set((v?.presets || []).map((p) => p.binStep))], [v]);
  const dlmmFees = useMemo(() => (v?.presets || []).filter((p) => p.binStep === binStep).map((p) => p.fee), [v, binStep]);
  useEffect(() => {
    if (!v) return;
    if (v.fees && !v.fees.includes(fee)) setFeePct(String((v.fees.includes(3000) ? 3000 : v.fees[0]) / 10000));
    if (dlmm && !binSteps.includes(binStep)) setBinStep(binSteps.includes(80) ? 80 : binSteps[0] ?? null);
  }, [venue, v]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dlmm && dlmmFees.length && !dlmmFees.includes(fee)) setFeePct(String(dlmmFees[0] / 10000));
  }, [dlmm, binStep, dlmmFees]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v4 && !spacingTouched) setSpacing(String(spacingFor(toNum(feePct)))); }, [feePct, v4, spacingTouched]);

  const tok = canonAddr(token.trim());
  useEffect(() => {
    setMarket(null);
    if (!enabled || !isAddr(tok) || !quote) return undefined;
    let alive = true;
    post('/api/manual/prices', { addresses: [tok, quote] }).then((d) => {
      const a = d.prices?.[tok], b = d.prices?.[quote];
      if (alive && a > 0 && b > 0) setMarket(a / b);
    });
    return () => { alive = false; };
  }, [enabled, tok, quote]);

  const px = toNum(price);
  const feeOk = Number.isFinite(fee) && fee >= 0
    && (!damm || (fee >= 100 && fee % 100 === 0 && fee <= 990_000))
    && (!dlmm || dlmmFees.includes(fee));
  const ok = !!v && isAddr(tok) && !!quote && feeOk && px > 0
    && (!v4 || (Number.isInteger(toNum(spacing)) && toNum(spacing) >= 1)) && (!hooks || isAddr(hooks.trim()));
  const spec = useMemo(() => (ok ? {
    venue, token: tok, quote, fee, price: px,
    ...(v4 ? { tickSpacing: toNum(spacing), hooks: hooks.trim() || null } : {}),
    ...(dlmm ? { binStep } : {}),
  } : null), [ok, venue, tok, quote, fee, px, v4, dlmm, spacing, hooks, binStep]);

  return { meta, venue, setVenue, token, setToken, quote, setQuote, feePct, setFeePct, spacing,
    setSpacing: (x) => { setSpacingTouched(true); setSpacing(x); }, hooks, setHooks, price, setPrice, market, v, v4, damm, dlmm,
    binStep, setBinStep, binSteps, dlmmFees, ok, spec, key: spec ? JSON.stringify(spec) : '' };
}

function Field({ label, children, hint }) {
  const { t } = useI18n();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{t(label)}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const box = 'h-9 w-full rounded-md border border-field-border bg-surface px-3 text-sm outline-none focus:border-accent';
const chip = (on) => `num h-8 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-foreground hover:bg-default/60'}`;

// Free fee input with quick choices (Uniswap v4, Meteora DAMM v2).
function FeeInput({ C, presets, hint }) {
  return (
    <Field label="Fee (%)" hint={hint}>
      <div className="flex flex-col gap-1.5">
        <input value={C.feePct} onChange={(e) => C.setFeePct(e.target.value.replace(/[^\d.,]/g, ''))} inputMode="decimal" className={`${box} num max-w-40`} />
        <div className="flex flex-wrap gap-1">
          {presets.map((f) => <button key={f} type="button" className={chip(toNum(C.feePct) === f)} onClick={() => C.setFeePct(String(f))}>{f}%</button>)}
        </div>
      </div>
    </Field>
  );
}

export function CreatePoolStep({ C }) {
  const { t } = useI18n();
  if (!C.meta) return <p className="text-sm text-muted">{t('Memuat…')}</p>;
  if (!C.meta.venues?.length) return <p className="text-sm text-muted">{t('Membuat pool belum tersedia di chain ini.')}</p>;
  const qSym = C.meta.quotes.find((q) => q.address === C.quote)?.symbol || '';
  return (
    <div className="flex flex-col gap-3">
      <Field label="Venue">
        <div className="flex flex-wrap gap-1.5">
          {C.meta.venues.map((v) => <button key={v.key} type="button" className={chip(C.venue === v.key)} onClick={() => C.setVenue(v.key)}>{v.label}</button>)}
        </div>
      </Field>
      <Field label="Alamat token">
        <input value={C.token} onChange={(e) => C.setToken(e.target.value)} placeholder={C.damm || C.dlmm ? 'mint…' : '0x…'} spellCheck={false} className={`${box} mono`} />
      </Field>
      <Field label="Dipasangkan dengan">
        <div className="flex flex-wrap gap-1.5">
          {C.meta.quotes.map((q) => <button key={q.address} type="button" className={chip(C.quote === q.address)} onClick={() => C.setQuote(q.address)}>{q.symbol}</button>)}
        </div>
      </Field>
      {C.v4 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FeeInput C={C} presets={V4_PRESETS.map(([f]) => f)} hint={t('Bebas, misal 0,3 atau 1. Fee dinamis tidak didukung.')} />
          <Field label="Tick spacing" hint={t('Jarak antar tick. Kecil = rentang bisa lebih rapat, gas swap lebih mahal.')}>
            <input value={C.spacing} onChange={(e) => C.setSpacing(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${box} num`} />
          </Field>
        </div>
      ) : C.damm ? (
        <>
          <FeeInput C={C} presets={DAMM_PRESETS} hint={t('Kelipatan 0,01%. Fee tetap, ditagih dalam aset kuotasi.')} />
          <p className="text-xs text-muted">{t('DAMM v2: satu rentang untuk seluruh pool (harga 0 sampai tak hingga) — semua LP di pool ini berbagi rentang yang sama. Pool dan posisimu dibuat dalam satu transaksi.')}</p>
        </>
      ) : C.dlmm ? (
        <>
          <Field label="Bin step" hint={t('Jarak harga antar bin (basis poin). Kecil untuk pasangan stabil, besar untuk token yang liar.')}>
            <div className="flex flex-wrap gap-1">
              {C.binSteps.map((b) => <button key={b} type="button" className={chip(C.binStep === b)} onClick={() => C.setBinStep(b)}>{b}</button>)}
            </div>
          </Field>
          <Field label="Fee dasar" hint={t('Pilihan fee mengikuti preset Meteora untuk bin step ini; fee dinamis ikut naik saat harga bergejolak.')}>
            <div className="flex flex-wrap gap-1">
              {C.dlmmFees.map((f) => <button key={f} type="button" className={chip(Math.round(toNum(C.feePct) * 10000) === f)} onClick={() => C.setFeePct(String(f / 10000))}>{num(f / 10000, 2)}%</button>)}
            </div>
          </Field>
        </>
      ) : (
        <Field label="Tier fee">
          <div className="flex flex-wrap gap-1.5">
            {(C.v?.fees || []).map((f) => <button key={f} type="button" className={chip(Math.round(toNum(C.feePct) * 10000) === f)} onClick={() => C.setFeePct(String(f / 10000))}>{num(f / 10000, 2)}%</button>)}
          </div>
        </Field>
      )}
      {C.v4 && (
        <Field label="Hook (opsional)" hint={t('Kosongkan untuk pool tanpa hook. Hook yang bisa menahan penarikan ditolak kecuali ada di "Hook dipercaya".')}>
          <input value={C.hooks} onChange={(e) => C.setHooks(e.target.value)} placeholder="0x…" spellCheck={false} className={`${box} mono`} />
        </Field>
      )}
      <Field label="Harga awal" hint={t('Harga 1 token dalam {q}. Kamu LP pertama — harga ini yang dipakai pool.', { q: qSym })}>
        <div className="flex flex-wrap items-center gap-2">
          <input value={C.price} onChange={(e) => C.setPrice(e.target.value.replace(/[^\d.,eE-]/g, ''))} inputMode="decimal" placeholder="0" className={`${box} num max-w-56`} />
          <span className="text-sm text-muted">{qSym}</span>
          {C.market > 0 && (
            <Button size="sm" variant="outline" onPress={() => C.setPrice(plainDecimal(C.market))}>
              {t('Harga pasar ≈ {p}', { p: price(C.market) })}
            </Button>
          )}
        </div>
      </Field>
      {C.market > 0 && toNum(C.price) > 0 && Math.abs(toNum(C.price) / C.market - 1) > 0.05 && (
        <p className="text-xs text-warning">{t('Harga awal {d}% dari harga pasar — selisihnya akan diambil arbitrase begitu pool hidup.', { d: `${toNum(C.price) > C.market ? '+' : ''}${num((toNum(C.price) / C.market - 1) * 100, 1)}` })}</p>
      )}
    </div>
  );
}
