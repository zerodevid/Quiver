import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { RotateCw } from 'lucide-react';
import { get, withChain } from '../api';
import { useI18n } from '../i18n';
import { usd } from '../fmt';

// Shared pieces of the confirm dialogs that show a live estimate (close, reduce, claim, compound).
// The dialog opens at once and its confirm button works throughout; the estimate fills in below
// when the read-only quote arrives (or never, if the owner confirms first).

export const signed = (v) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;

export function QuoteRow({ label, value, cls = '' }) {
  return <div className="flex justify-between gap-4"><span>{label}</span><span className={`num ${cls}`}>{value}</span></div>;
}

// `onRefresh` adds a "quote again" button to the header; `refreshing` spins it while a new quote loads
// (the old figures stay visible meanwhile).
export function QuoteBox({ title, children, onRefresh, refreshing = false }) {
  const { t } = useI18n();
  return <div className="space-y-1 rounded-lg border border-border p-2.5 text-[0.8125rem]">
    <div className="flex items-center justify-between gap-2">
      <span className="font-medium text-foreground">{title}</span>
      {onRefresh && <button type="button" onClick={onRefresh} disabled={refreshing}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-default hover:text-foreground disabled:opacity-60">
        <RotateCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />{t('Quote ulang')}
      </button>}
    </div>
    {children}
  </div>;
}

// "Sell into: USDG · WETH" — the quote asset a dialog sells the memecoin into. `targets` and the
// default come from the quote reply (sellTargets / sellTo); nothing is drawn with fewer than two.
export function SellTarget({ targets, value, onChange }) {
  const { t } = useI18n();
  if (!targets || targets.length < 2) return null;
  return <div className="flex flex-wrap items-center gap-1.5 text-sm">
    <span className="text-muted">{t('Jual ke')}</span>
    {targets.map((x) => (
      <Button key={x.address} size="sm" variant={value === x.address ? 'primary' : 'outline'} onPress={() => onChange(x.address)}>{x.symbol}</Button>
    ))}
  </div>;
}

// Per-aggregator line under a memecoin leg: "Kyber $1.20 ✓ · OKX $1.18".
export function QuoteLegs({ legs }) {
  return (legs || []).map((l) => l.all?.length > 0 && (
    <div key={l.token} className="text-xs text-muted">
      {l.all.map((a, i) => `${a.label} ${usd(a.outUsd)}${i === 0 ? ' ✓' : ''}`).join(' · ')}
    </div>
  ));
}

export function QuoteLoading({ text, hint }) {
  return <div className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-xs text-muted" role="status">
    <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
    {text} {hint && <span>{hint}</span>}
  </div>;
}

// Fetches `path` (a GET returning JSON) and re-fetches when it changes; `delay` debounces typing.
// Returns { data, error, loading, refresh }. A reply with `error` is reported as `error`, not as data.
// While a new quote loads the previous `data` stays, so the dialog does not jump.
export function useLiveQuote(path, chainName, { delay = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      get(withChain(path, chainName))
        .then((d) => { if (alive) setState(d?.error ? { data: null, error: d.error, loading: false } : { data: d, error: null, loading: false }); })
        .catch((e) => { if (alive) setState({ data: null, error: e.message, loading: false }); });
    }, delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [path, chainName, delay, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

// The estimate block of the single close dialog. `keep`: the memecoin stays in the wallet, so the
// figures are the unsold ones (q.keep; an engine without it falls back to the mid price).
export function CloseEstimate({ q, keep = false, onRefresh, refreshing }) {
  const { t } = useI18n();
  const k = keep ? (q.keep || { receiveUsd: q.midUsd, gasUsd: null, pnlUsd: q.pnlMidUsd, pnlPct: q.costUsd > 0 ? (q.pnlMidUsd / q.costUsd) * 100 : 0 }) : q;
  return <QuoteBox title={t('Estimasi jika ditutup sekarang')} onRefresh={onRefresh} refreshing={refreshing}>
    <QuoteRow label={t('Diterima di wallet')} value={usd(k.receiveUsd)} />
    {!keep && q.sellCostUsd > 0.005 && <QuoteRow label={t('Kerugian jual memecoin')} value={`−${usd(q.sellCostUsd)}`} cls="text-danger" />}
    {k.gasUsd != null && <QuoteRow label={t('Gas')} value={`−${usd(k.gasUsd)}`} />}
    {q.claimedUsd > 0.005 && <QuoteRow label={t('Fee yang sudah diklaim')} value={`+${usd(q.claimedUsd)}`} />}
    {!keep && <QuoteLegs legs={q.legs} />}
    <QuoteRow label={t('PnL riil')} value={`${signed(k.pnlUsd)} (${k.pnlPct >= 0 ? '+' : ''}${k.pnlPct.toFixed(1)}%)`}
      cls={k.pnlUsd >= 0 ? 'text-success font-medium' : 'text-danger font-medium'} />
    {keep
      ? <div className="text-xs text-muted">{t('Memecoin tetap di wallet, dinilai dengan harga tengah pool — belum dijual.')}</div>
      : <div className="text-xs text-muted">{t('Harga tengah pool menunjukkan {v}', { v: signed(q.pnlMidUsd) })}</div>}
    {!keep && !q.quoted && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
  </QuoteBox>;
}

// "Sell into: USDG · WETH · Don't sell" for the close dialog. The default follows the target's
// sell_leftover rule (data.sellOn); picking a quote asset sells even when the rule is off.
function CloseSellChoice({ targets, value, keep, onPick, onKeep }) {
  const { t } = useI18n();
  return <div className="flex flex-wrap items-center gap-1.5 text-sm">
    <span className="text-muted">{t('Jual ke')}</span>
    {(targets || []).map((x) => (
      <Button key={x.address} size="sm" variant={!keep && value === x.address ? 'primary' : 'outline'} onPress={() => onPick(x.address)}>{x.symbol}</Button>
    ))}
    <Button size="sm" variant={keep ? 'primary' : 'outline'} onPress={onKeep}>{t('Jangan jual')}</Button>
  </div>;
}

// `state.sellTo` / `state.sell` (optional) receive the choice made here, for the caller's close
// request; `state.sell` stays null while the owner follows the default.
export function LiveCloseEstimate({ p, state = {} }) {
  const { t } = useI18n();
  const [to, setTo] = useState(null);
  const [sell, setSell] = useState(null);
  const { data, error, loading, refresh } = useLiveQuote(`/api/position/exit-quote?id=${p.id}${to ? `&to=${to}` : ''}`, p.chain);
  if (loading && !data) return <QuoteLoading text={t('Menghitung estimasi hasil tutup…')} hint={t('Kamu bisa langsung menutup tanpa menunggu.')} />;
  if (error || !data) return null;   // the plain dialog still works
  const hasMeme = data.legs?.length > 0;
  const keep = hasMeme && !(sell ?? data.sellOn !== false);
  const pick = (a) => { state.sell = true; state.sellTo = a; setSell(true); setTo(a); };
  const hold = () => { state.sell = false; setSell(false); };
  return <div className="space-y-2">
    {hasMeme && <CloseSellChoice targets={data.sellTargets} value={to || data.sellTo} keep={keep} onPick={pick} onKeep={hold} />}
    <CloseEstimate q={data} keep={keep} onRefresh={refresh} refreshing={loading} />
  </div>;
}
