import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Panel } from './ui';
import { usePoll, useTick } from '../hooks';
import { useI18n } from '../i18n';
import { usd, num, pct, price, short, ago } from '../fmt';
import { breakEven } from '../breakeven';
import { makeCurve, buyToPrice, exitScenarios } from '../liquidityRisk.mjs';
const explanation = {
  liquidity_gap: 'Likuiditas habis di jalur harga; penjualan penuh belum dapat dihitung.',
  depth_limit: 'Melewati kedalaman yang terbaca; estimasi belum lengkap.',
  target_unknown: 'Posisi atau saldo target belum lengkap.',
  unavailable: 'Data simulasi belum tersedia.',
};
export default function LiquidityRisk({ pool, focus }) {
  const { t } = useI18n();
  const [owner, setOwner] = useState(''), [salePct, setSalePct] = useState(100), [wallet, setWallet] = useState(false), [sellUsd, setSellUsd] = useState(100);
  const { data, error, loading, reload } = usePoll(`/api/pool-depth?ref=${encodeURIComponent(pool.pool_ref)}`, 60000);
  useTick(30000);
  const d = !error && data?.ref === pool.pool_ref && Date.now() - data.fetchedAt < 120000 ? data : null;
  const curve = makeCurve(d);
  const targets = [...new Map((d?.positions || []).filter((p) => p.kind === 'target').map((p) => [p.owner, p.label || short(p.owner)])).entries()];
  const selected = targets.some(([a]) => a === owner) ? owner : '';
  const p = focus?.status === 'open' ? focus : null;
  const result = curve ? exitScenarios(d, { ownId: p?.id, targetOwner: selected, salePct, includeWallet: wallet, sellUsd }) : null;
  const bep = p ? breakEven(p, { all: true }) : null;
  const required = curve && bep?.price ? buyToPrice(curve, bep.price) : null;
  const received = (r) => r?.error ? <span className="text-xs text-warning">{t(explanation[r.error] || explanation.unavailable)}</span> : r ? usd(r.receivedUsd) : '—';
  const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
  return <Panel title="Kedalaman harga & risiko keluar" className="mb-4" desc="Simulasi satu pool berdasarkan likuiditas per rentang harga">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{d ? `${t('Blok')} ${num(d.block)} · ${ago(d.fetchedAt)}` : t(loading ? 'Membaca kedalaman pool…' : 'Kedalaman pool belum tersedia.')}</span><button type="button" onClick={reload} disabled={loading} className="text-accent disabled:opacity-50">{t('Perbarui')}</button></div>
    {!curve ? <p className="text-sm text-warning">{t(d?.hook ? 'Pool memakai hook. Dampak harga tidak dapat dihitung andal dengan model swap standar.' : data?.error || 'Kedalaman pool belum tersedia.')}</p> : <>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">{t('USD untuk menggerakkan harga')}</h3>
          <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="py-2 text-left font-normal">{t('Target harga')}</th><th className="text-right font-normal">{t('Pembelian bruto')}</th></tr></thead><tbody>
            {[1, 5, 10].map((move) => { const r = buyToPrice(curve, curve.price * (1 + move / 100)); return <tr className="border-t border-border" key={move}><td className="py-2">+{move}%</td><td className="text-right num">{r.error ? t('Belum terukur') : usd(r.quote * d.quoteUsd)}</td></tr>; })}
            <tr className="border-t border-border"><td className="py-2">{t('Ke BEP posisi')}{p && <span className="ml-1 text-xs text-muted">#{p.token_id}</span>}</td><td className="text-right num">{required && !required.error ? usd(required.quote * d.quoteUsd) : '—'}</td></tr>
          </tbody></table>
          <p className="mt-2 text-xs leading-relaxed text-muted">{bep?.price ? <>{t('Harga BEP')}: {price(bep.price)} {pool.quoteSide === 0 ? pool.symbol0 : pool.symbol1} · {pct((bep.price / curve.price - 1) * 100, 2)}. {required?.error && t(explanation[required.error])}</> : t(bep?.reason || 'Pilih posisi terbuka untuk menghitung BEP.')}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('Ini pembelian pasar yang dibutuhkan dalam model, bukan dana tambahan yang harus Anda setor. BEP belum memasukkan gas dan biaya keluar.')}</p>
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">{t('Jika target tarik LP lalu jual token')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">{t('Target terpantau')}<select value={selected} onChange={(e) => setOwner(e.target.value)} className={`${inputClass} mt-1`}><option value="">{t('Semua target terpantau')}</option>{targets.map(([a, label]) => <option value={a} key={a}>{label}</option>)}</select></label>
            <label className="text-xs text-muted">{t('Token target dijual (%)')}<input className={`${inputClass} mt-1`} type="number" min="0" max="100" value={salePct} onChange={(e) => setSalePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} /></label>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" checked={wallet} onChange={(e) => setWallet(e.target.checked)} className="mt-0.5" /><span>{t('Sertakan saldo token di wallet target, selain token dari LP')}</span></label>
          {!p && <label className="mt-3 block text-xs text-muted">{t('Nilai token kita yang dijual (USD)')}<input className={`${inputClass} mt-1`} type="number" min="0" value={sellUsd} onChange={(e) => setSellUsd(Math.max(0, Number(e.target.value) || 0))} /></label>}
          <p className="mt-3 text-xs leading-relaxed text-muted">{t('LP target yang terbaca: {n} posisi · {share}% likuiditas aktif.', { n: result.targets.length, share: result.targetSharePct == null ? '—' : num(result.targetSharePct, 1) })}</p>
          <p className="mt-1 text-xs text-muted">{t('Asumsi penjualan target: {n} token (tanpa fee LP yang belum diklaim).', { n: num(result.targetSold, 4) })}</p>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto"><table className="w-full table-fixed text-xs sm:text-sm"><thead className="text-xs text-muted"><tr><th className="w-1/2 py-2 text-left font-normal">{t('Urutan transaksi')}</th><th className="text-right font-normal">{t(p ? 'Hasil pokok LP kita' : 'Hasil jual kita')}</th><th className="pl-3 text-right font-normal">{t('Potongan swap*')}</th></tr></thead><tbody>
        {[[t('Kita keluar sekarang'), result.current], [t('Target tarik LP → kita keluar'), result.lpFirst], [t('Target tarik LP + jual → kita keluar'), result.sellFirst]].map(([label, r]) => <tr className="border-t border-border" key={label}><td className="py-3 pr-3">{label}</td><td className="max-w-64 py-3 text-right num">{received(r)}</td><td className={`pl-3 text-right num ${r?.lossPct >= 5 ? 'text-danger' : r?.lossPct >= 1 ? 'text-warning' : ''}`}>{r && !r.error ? `${num(r.lossPct, 2)}%` : '—'}</td></tr>)}
      </tbody></table></div>
      {result.targetSale && !result.targetSale.error && <p className="mt-2 text-xs text-warning">{t('Sesudah jual target, harga model berubah {value}%.', { value: num((result.targetSale.price / curve.price - 1) * 100, 2) })}</p>}
      <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted"><TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" /><div><p>{t('* Potongan swap = dampak harga + fee swap terhadap harga sebelum penjualan kita. LP kita ditarik sebelum token dijual. Hasil pokok belum termasuk fee LP yang diklaim dan gas.')}</p><p className="mt-2">{t('Target diasumsikan menarik seluruh posisi yang terpantau lalu menjual persentase token di atas melalui pool ini. Urutan aktual, pajak token, MEV, perubahan fee, dan rute lain dapat mengubah hasil. Ini bukan quote eksekusi atau batas slippage.')}</p></div></div>
      {d.dynamicFee && <p className="mt-2 text-xs text-warning">{t('Fee dinamis: model memakai fee saat snapshot; fee berikutnya dapat berubah.')}</p>}
    </>}
  </Panel>;
}
