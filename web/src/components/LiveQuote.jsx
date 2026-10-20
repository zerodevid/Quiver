import { useEffect, useState } from 'react';
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

export function QuoteBox({ title, children }) {
  return <div className="space-y-1 rounded-lg border border-border p-2.5 text-[0.8125rem]">
    <div className="font-medium text-foreground">{title}</div>
    {children}
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
// Returns { data, error, loading }. A reply with `error` is reported as `error`, not as data.
export function useLiveQuote(path, chainName, { delay = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      get(withChain(path, chainName))
        .then((d) => { if (alive) setState(d?.error ? { data: null, error: d.error, loading: false } : { data: d, error: null, loading: false }); })
        .catch((e) => { if (alive) setState({ data: null, error: e.message, loading: false }); });
    }, delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [path, chainName, delay]);
  return state;
}

// The estimate block of the single close dialog.
export function CloseEstimate({ q }) {
  const { t } = useI18n();
  return <QuoteBox title={t('Estimasi jika ditutup sekarang')}>
    <QuoteRow label={t('Diterima di wallet')} value={usd(q.receiveUsd)} />
    {q.sellCostUsd > 0.005 && <QuoteRow label={t('Kerugian jual memecoin')} value={`−${usd(q.sellCostUsd)}`} cls="text-danger" />}
    <QuoteRow label={t('Gas')} value={`−${usd(q.gasUsd)}`} />
    {q.claimedUsd > 0.005 && <QuoteRow label={t('Fee yang sudah diklaim')} value={`+${usd(q.claimedUsd)}`} />}
    <QuoteLegs legs={q.legs} />
    <QuoteRow label={t('PnL riil')} value={`${signed(q.pnlUsd)} (${q.pnlPct >= 0 ? '+' : ''}${q.pnlPct.toFixed(1)}%)`}
      cls={q.pnlUsd >= 0 ? 'text-success font-medium' : 'text-danger font-medium'} />
    <div className="text-xs text-muted">{t('Harga tengah pool menunjukkan {v}', { v: signed(q.pnlMidUsd) })}</div>
    {!q.quoted && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
  </QuoteBox>;
}

export function LiveCloseEstimate({ p }) {
  const { t } = useI18n();
  const { data, error, loading } = useLiveQuote(`/api/position/exit-quote?id=${p.id}`, p.chain);
  if (loading) return <QuoteLoading text={t('Menghitung estimasi hasil tutup…')} hint={t('Kamu bisa langsung menutup tanpa menunggu.')} />;
  if (error || !data) return null;   // the plain dialog still works
  return <CloseEstimate q={data} />;
}
