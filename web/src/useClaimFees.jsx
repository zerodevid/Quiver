import { useRef, useState } from 'react';
import { Checkbox, toast } from '@heroui/react';
import { post, withChain } from './api';
import { ask } from './components/ui';
import { useI18n, reason } from './i18n';
import { usd, short } from './fmt';
import { QuoteBox, QuoteRow, QuoteLegs, QuoteLoading, SellTarget, useLiveQuote } from './components/LiveQuote';

// The memecoin side and the quote side of the position, for the sentence "sell MEME to USDG".
const sides = (p) => {
  const q = p.quoteSide === 1 ? 1 : 0;
  return { meme: (q === 0 ? p.symbol1 : p.symbol0) || 'token', quote: (q === 0 ? p.symbol0 : p.symbol1) || 'USDG' };
};

// Body of the claim dialog: the checkbox and the sale target have their own state (ask() only draws
// the body once), and the choices are reported to the caller through `state`.
function ClaimBody({ p, state }) {
  const { t } = useI18n();
  const [sell, setSell] = useState(state.sell);
  const [to, setTo] = useState(null);
  const { meme, quote } = sides(p);
  // Live estimate (aggregator-quoted); the confirm button works while it loads.
  const { data: q, error, loading, refresh } = useLiveQuote(`/api/positions/claim-quote?id=${p.id}${to ? `&to=${to}` : ''}`, p.chain);
  const into = q?.sellTargets?.find((x) => x.address === (to || q.sellTo))?.symbol || quote;
  return (
    <div className="flex flex-col gap-3">
      <span>{t('Perkiraan fee {v}. Fee masuk ke wallet dalam token pool. Likuiditas tetap terbuka; gas tetap dibayar.', { v: usd(p.feeUsd) })}</span>
      {loading && !q
        ? <QuoteLoading text={t('Menghitung estimasi…')} hint={t('Kamu bisa langsung klaim tanpa menunggu.')} />
        : !error && q && <QuoteBox title={t('Estimasi jika diklaim sekarang')} onRefresh={refresh} refreshing={loading}>
          <QuoteRow label={t('Diterima di wallet')} value={usd(sell && q.quoteReceiveUsd != null ? q.quoteReceiveUsd : q.midUsd ?? q.feeUsd)} />
          {sell && q.sellCostUsd > 0.005 && <QuoteRow label={t('Kerugian jual memecoin')} value={`−${usd(q.sellCostUsd)}`} cls="text-danger" />}
          {q.gasUsd != null && <QuoteRow label={t('Gas')} value={`−${usd(q.gasUsd)}`} />}
          {sell && <QuoteLegs legs={q.legs} />}
          {sell && q.quoted === false && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
        </QuoteBox>}
      <Checkbox isSelected={sell} onChange={(v) => { setSell(v); state.sell = v; }}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          <span className="flex flex-col">
            <span className="text-foreground">{t('Jual {m} dari fee ke {q} sekalian', { m: meme, q: into })}</span>
            <span className="text-xs">{t('Dijual lewat agregator tepat sesudah klaim. {q} dari fee tetap di wallet.', { q: quote })}</span>
          </span>
        </Checkbox.Content>
      </Checkbox>
      {sell && q && <SellTarget targets={q.sellTargets} value={to || q.sellTo} onChange={(a) => { setTo(a); state.sellTo = a; }} />}
    </div>
  );
}

export function useClaimFees(reload) {
  const { t } = useI18n();
  const lock = useRef(false);
  const [claiming, setClaiming] = useState(null);
  const claim = async (p) => {
    if (lock.current) return;
    lock.current = true;
    try {
      // Checkbox default = this position's harvest settings (claim mode + sell fees), if enabled.
      const c = p.compound;
      const state = { sell: !!(c?.enabled && c.mode === 'claim' && c.sellFee), sellTo: null };
      if (!await ask({ title: t('Claim fee'), body: <ClaimBody p={p} state={state} />,
        confirm: t('Claim fee') })) return;
      setClaiming(p.id);
      const r = await post(withChain('/api/positions/claim', p.chain),
        { id: p.id, sell: state.sell, ...(state.sell && state.sellTo ? { sellTo: state.sellTo } : {}) });
      if (r.error) toast.danger(t('Claim fee gagal'), { description: reason(r.error) });
      else if (r.pending) toast.warning(t('Claim fee masih diproses'), { description: `Tx: ${r.tx}` });
      else {
        toast.success(t('Fee sudah diklaim'), { description: r.accountingPending
          ? t('Pencatatan nominal menunggu sinkronisasi.') : `Tx: ${short(r.tx)}` });
        if (r.sold) toast.success(t('Fee dijual'), { description: reason(r.sold) });
        else if (r.sellError) toast.warning(t('Fee belum terjual'), { description: t('Masuk antrean jual dan dicoba lagi otomatis. {e}', { e: reason(r.sellError) }) });
      }
    } catch {
      toast.warning(t('Status claim belum pasti'), { description: t('Koneksi terputus. Cek lagi sebelum mencoba ulang.') });
    } finally {
      lock.current = false;
      setClaiming(null);
      reload?.();
    }
  };
  return { claim, claiming };
}
