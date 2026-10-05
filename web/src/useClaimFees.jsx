import { useRef, useState } from 'react';
import { Checkbox, toast } from '@heroui/react';
import { post } from './api';
import { ask } from './components/ui';
import { useI18n, reason } from './i18n';
import { usd, short } from './fmt';

// The memecoin side and the quote side of the position, for the sentence "sell MEME to USDG".
const sides = (p) => {
  const q = p.quoteSide === 1 ? 1 : 0;
  return { meme: (q === 0 ? p.symbol1 : p.symbol0) || 'token', quote: (q === 0 ? p.symbol0 : p.symbol1) || 'USDG' };
};

// Body of the claim dialog: the checkbox has its own state (ask() only draws the body once),
// and the choice is reported to the caller through onChange.
function ClaimBody({ p, initial, onChange }) {
  const { t } = useI18n();
  const [sell, setSell] = useState(initial);
  const { meme, quote } = sides(p);
  return (
    <div className="flex flex-col gap-3">
      <span>{t('Perkiraan fee {v}. Fee masuk ke wallet dalam token pool. Likuiditas tetap terbuka; gas tetap dibayar.', { v: usd(p.feeUsd) })}</span>
      <Checkbox isSelected={sell} onChange={(v) => { setSell(v); onChange(v); }}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          <span className="flex flex-col">
            <span className="text-foreground">{t('Jual {m} dari fee ke {q} sekalian', { m: meme, q: quote })}</span>
            <span className="text-xs">{t('Dijual lewat agregator tepat sesudah klaim. {q} dari fee tetap di wallet.', { q: quote })}</span>
          </span>
        </Checkbox.Content>
      </Checkbox>
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
      let sell = !!(c?.enabled && c.mode === 'claim' && c.sellFee);
      if (!await ask({ title: t('Claim fee'), body: <ClaimBody p={p} initial={sell} onChange={(v) => { sell = v; }} />,
        confirm: t('Claim fee') })) return;
      setClaiming(p.id);
      const r = await post('/api/positions/claim', { id: p.id, sell });
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
