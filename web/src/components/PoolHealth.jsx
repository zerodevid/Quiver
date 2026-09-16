import { ShieldCheck, TriangleAlert, CircleHelp, ExternalLink } from 'lucide-react';
import { usePoll, useTick } from '../hooks';
import { useI18n } from '../i18n';
import { num, ago, short } from '../fmt';
import { poolHealth } from '../poolHealth.mjs';

const STATUS = {
  healthy: ['Sehat pada indikator yang diperiksa', 'text-success', ShieldCheck],
  warn: ['Perlu waspada', 'text-warning', TriangleAlert],
  risk: ['Tidak sehat · risiko tinggi', 'text-danger', TriangleAlert],
  unknown: ['Belum dapat dinilai', 'text-muted', CircleHelp],
};
export default function PoolHealth({ pool, pair, open = [] }) {
  const { t } = useI18n();
  const token = pool?.baseToken;
  const { data, error } = usePoll(token ? `/api/holders?token=${encodeURIComponent(token)}` : null, 15000);
  useTick(30000);
  const holders = data?.token === token?.toLowerCase() && !error ? data : null;
  const h = poolHealth({ pool, pair, holders, open });
  const [title, color, Icon] = STATUS[h.status];
  const items = h.holdersOk ? holders.items : [];
  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-border bg-surface" aria-label={t('Kesehatan pool dan token')}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className={`flex items-center gap-2 text-sm font-semibold ${color}`}><Icon size={18} aria-hidden />{t(title)}</h2>
          <p className="mt-1 text-xs text-muted">{t('Penilaian pasar, posisi bot, dan distribusi holder; bukan audit kontrak.')}</p>
        </div>
        <span className="text-xs text-muted">{pair?.fetchedAt ? `${t('Pasar')} · ${ago(pair.fetchedAt)}` : t('Menunggu data pasar')}</span>
      </div>
      <div className="grid gap-5 p-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-medium text-muted">{t('Peringatan dari data')}</h3>
          {h.signals.length ? <ul className="space-y-2">{h.signals.map((s, i) => <li key={i} className="flex items-start gap-2 text-sm leading-relaxed"><TriangleAlert size={15} aria-hidden className={`mt-1 shrink-0 ${s.level === 'risk' ? 'text-danger' : 'text-warning'}`} /><span>{t(s.key, Object.fromEntries(Object.entries(s.values).map(([key, value]) => [key, Number.isFinite(Number(value)) ? num(Number(value), 2) : value])))}</span></li>)}</ul> : <p className="text-sm">{t(h.status === 'healthy' ? 'Tidak ada indikator yang melewati ambang peringatan.' : 'Belum ada peringatan terukur dari data yang tersedia.')}</p>}
          {h.missing.length > 0 && <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs leading-relaxed text-muted">{h.missing.map((key) => <p key={key}>{t(key)}</p>)}</div>}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-medium text-muted">{t('Distribusi holder')}</h3>
          <div className="grid grid-cols-3 gap-3">
            {[[t('Alamat pemilik'), h.holdersOk && holders.holderCount != null ? num(holders.holderCount) : '—'], [t('Terbesar*'), h.largest != null ? `${num(h.largest, 1)}%` : '—'], [t('Top 10*'), h.top10 != null ? `${num(h.top10, 1)}%` : '—']].map(([label, value]) => <div key={label}><div className="text-xs text-muted">{label}</div><div className="mt-1 text-lg font-semibold num">{value}</div></div>)}
          </div>
          {h.top10 != null && h.largest != null && <p className={`mt-2 text-xs font-medium ${h.largest >= 10 || h.top10 >= 40 ? 'text-warning' : 'text-success'}`}>{t(h.largest >= 10 || h.top10 >= 40 ? 'Kepemilikan terkonsentrasi' : 'Tidak melewati ambang dominasi')}</p>}
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('* Persentase total suplai, tanpa PoolManager, pool ini, dan alamat burn. Alamat belum tentu mewakili orang yang berbeda; kontrak lain tetap dihitung.')}</p>
          {items.length > 0 ? <details className="mt-3 text-xs">
            <summary className="cursor-pointer py-1 text-accent">{t('Lihat pemilik terbesar dan jenis alamat')}</summary>
            <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead className="text-muted"><tr><th className="py-2 font-normal">{t('Alamat')}</th><th className="font-normal">{t('Jenis')}</th><th className="text-right font-normal">{t('Suplai')}</th></tr></thead><tbody>{items.slice(0, 10).map((r) => <tr key={r.address} className="border-t border-border"><td className="py-2"><a className="text-accent" href={`https://robinhoodchain.blockscout.com/address/${r.address}`} target="_blank" rel="noreferrer">{short(r.address)}</a></td><td>{t(r.kind === 'pool_manager' || r.address === pool.pool_ref ? 'Likuiditas pool' : r.kind === 'burn' ? 'Burn' : r.isContract ? 'Kontrak' : 'Wallet')}</td><td className="text-right num">{num(r.percent, 2)}%</td></tr>)}</tbody></table></div>
          </details> : <p className="mt-3 text-xs text-muted">{t(holders?.queued ? 'Menunggu giliran pemindaian holder; data pasar tetap diperiksa.' : holders?.error === 'scanning' ? 'Memindai riwayat dan memverifikasi saldo holder…' : holders?.error === 'scan_limit' ? 'Riwayat melewati batas pemindaian; jumlah holder belum terverifikasi.' : holders?.error === 'incomplete' ? 'Saldo belum cocok dengan total suplai; data holder belum lengkap.' : 'Data holder belum tersedia. Pemeriksaan pasar tetap berjalan.')}</p>}
          {holders?.error === 'scanning' && holders.progress && <p className="mt-2 text-xs text-muted">{holders.progress.phase === 'balances' ? t('Saldo diperiksa: {n}/{total} alamat', { n: num(holders.progress.checked), total: num(holders.progress.total) }) : t('Riwayat: {n} halaman transfer', { n: num(holders.progress.pages) })}</p>}
          {h.holdersOk && <p className="mt-3 text-xs text-muted">{holders.source} · {ago(holders.snapshotAt || holders.fetchedAt)}{holders.block ? ` · ${t('Blok')} ${num(holders.block)}` : ''} <a className="ml-2 inline-flex items-center gap-1 text-accent" href={holders.url} target="_blank" rel="noreferrer">Blockscout <ExternalLink size={11} /></a></p>}
        </div>
      </div>
      <details className="border-t border-border px-4 py-3 text-xs text-muted"><summary className="cursor-pointer">{t('Ambang penilaian')}</summary><p className="mt-2 leading-relaxed">{t('Waspada: turun ≥20%/24j atau ≥10%/1j, likuiditas <$50rb, satu alamat ≥10%, top 10 ≥40%, holder <100. Risiko tinggi: turun ≥50%/24j atau ≥20%/1j, likuiditas <$10rb, satu alamat ≥20%, top 10 ≥60%. Data tidak lengkap tidak diberi status sehat.')}</p></details>
    </section>
  );
}
