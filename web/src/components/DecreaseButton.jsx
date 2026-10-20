import { useRef, useState, useEffect } from 'react';
import { Button, Checkbox, toast } from '@heroui/react';
import { Minus } from 'lucide-react';
import { post, withChain } from '../api';
import { ask } from './ui';
import { useI18n, reason } from '../i18n';
import { usd, short } from '../fmt';
import { QuoteBox, QuoteRow, QuoteLegs, QuoteLoading, useLiveQuote } from './LiveQuote';

const PRESETS = [25, 50, 75];

// Body of the decrease dialog: percentage chips + custom input, a live estimate from the server
// (aggregator-quoted, like the close dialog) and the "sell leftover" checkbox. ask() draws the body
// once, so the choices live in local state and are reported to the caller through `state`.
// `state.sell` stays null until the owner touches the checkbox or the quote brings the target's
// default; null is sent as "follow the rule".
function DecreaseBody({ p, state }) {
  const { t } = useI18n();
  const [pct, setPct] = useState(state.pct);
  const [sell, setSell] = useState(false);
  const [touched, setTouched] = useState(false);
  const meme = (p.quoteSide === 1 ? p.symbol0 : p.symbol1) || 'token';
  const valid = Number(pct) > 0 && Number(pct) < 100;
  const { data: q, error, loading } = useLiveQuote(`/api/positions/decrease-quote?id=${p.id}&pct=${encodeURIComponent(pct)}`, p.chain, { delay: 250 });
  useEffect(() => {
    if (q && !touched) { setSell(!!q.sellDefault); state.sell = !!q.sellDefault; }
  }, [q, touched, state]);
  const change = (v) => { state.pct = v; setPct(v); };
  return (
    <div className="flex flex-col gap-3">
      <span>{t('Sebagian likuiditas ditarik ke wallet, sisanya tetap terbuka. Mengirim transaksi on-chain dan butuh gas.')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((v) => (
          <Button key={v} size="sm" variant={Number(pct) === v ? 'primary' : 'outline'} onPress={() => change(v)}>{v}%</Button>
        ))}
        <input type="number" min="0.01" max="99.99" step="any" value={pct} aria-label={t('Persentase likuiditas yang dikurangi')}
          onChange={(e) => change(e.target.value)} className="h-8 w-24 rounded-lg border border-divider bg-transparent px-2 text-sm" />
        <span className="text-sm">%</span>
      </div>
      {!valid
        ? <span className="text-warning text-sm">{t('Isi persentase antara 0,01 dan 99,99. Untuk 100% pakai Tutup posisi.')}</span>
        : loading
          ? <QuoteLoading text={t('Menghitung estimasi…')} hint={t('Kamu bisa langsung mengurangi tanpa menunggu.')} />
          : error
            ? <span className="text-danger text-sm">{reason(error)}</span>
            : <QuoteBox title={t('Estimasi jika dikurangi {p}%', { p: q.pct })}>
              <QuoteRow label={t('Diterima di wallet')} value={usd(sell && q.quoteReceiveUsd != null ? q.quoteReceiveUsd : q.receiveUsd)} />
              {sell && q.sellCostUsd > 0.005 && <QuoteRow label={t('Kerugian jual memecoin')} value={`−${usd(q.sellCostUsd)}`} cls="text-danger" />}
              {q.gasUsd != null && <QuoteRow label={t('Gas')} value={`−${usd(q.gasUsd)}`} />}
              {sell && <QuoteLegs legs={q.legs} />}
              <QuoteRow label={t('Sisa di posisi')} value={usd(q.remainUsd)} />
              {q.feesIncluded && <div className="text-xs text-muted">{t('Fee yang terkumpul ikut dikirim.')}</div>}
              {sell && q.quoted === false && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
            </QuoteBox>}
      <Checkbox isSelected={sell} onChange={(v) => { setTouched(true); setSell(v); state.sell = v; }}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          <span className="text-foreground">{t('Jual sisa token {m} sekalian', { m: meme })}</span>
        </Checkbox.Content>
      </Checkbox>
    </div>
  );
}

// Manual partial decrease: removes `pct` % of the position's liquidity and keeps it open.
// The sell checkbox defaults to the target's sell_leftover rule (decrease-quote.sellDefault).
export default function DecreaseButton({ p, reload, disabled = false, size = 'sm' }) {
  const { t } = useI18n();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  if (!p || p.empty || p.status === 'closed') return null;
  const pair = `${p.symbol0}/${p.symbol1}`;

  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    try {
      const state = { pct: 50, sell: null };
      if (!await ask({ title: t('Kurangi likuiditas {pair}', { pair }), body: <DecreaseBody p={p} state={state} />, confirm: t('Kurangi sekarang') })) return;
      setBusy(true);
      const r = await post(withChain('/api/positions/decrease', p.chain), { id: p.id, pct: Number(state.pct), sell: state.sell });
      if (r.error) toast.danger(t('Pengurangan likuiditas gagal'), { description: reason(r.error), timeout: 12000 });
      else {
        toast.success(t('Likuiditas dikurangi {p}%', { p: state.pct }), { description: r.tx ? `Tx: ${short(r.tx)}` : undefined });
        if (r.sold) toast.success(t('Sisa token dijual'), { description: reason(r.sold) });
      }
    } catch {
      toast.warning(t('Status pengurangan belum pasti'), { description: t('Koneksi terputus. Cek lagi sebelum mencoba ulang.') });
    } finally {
      lock.current = false;
      setBusy(false);
      reload?.();
    }
  };

  return <Button size={size} variant="outline" isPending={busy} isDisabled={disabled || busy} onPress={run}>
    <Minus className="size-3.5" />{t('Kurangi')}</Button>;
}
