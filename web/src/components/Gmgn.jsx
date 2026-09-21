// Data OpenAPI GMGN di dasbor — hanya tampil kalau API key sudah diisi
// (Pengaturan → GMGN); tanpa key server menjawab { enabled: false } dan
// komponen-komponen ini tidak menggambar apa pun.
//
//  - GmgnTokenPanel   : profil token (harga/MCap/ATH, komposisi wallet, volume
//                       per jendela, dev, tautan) — halaman token.
//  - GmgnSecurity     : ringkasan keamanan kontrak — kartu kesehatan pool.
//  - GmgnWallets      : pemegang / trader teratas dengan PnL per wallet —
//                       halaman token (holders) dan pool (traders).
//  - GmgnWalletCard   : reputasi satu wallet (winrate, PnL, tag, umur) —
//                       halaman wallet / target.
import { useState } from 'react';
import { Chip } from '@heroui/react';
import { ExternalLink } from 'lucide-react';
import { usePoll } from '../hooks';
import { useI18n } from '../i18n';
import { Panel, KV, DataTable, Empty, Loading, Segmented, ExtLink } from './ui';
import { usd, pct, num, ago, age, short, tone, addrHref } from '../fmt';

// Angka besar: $1.2M / $340.0k / $12.34 — sama dengan kUsd halaman posisi.
const kUsd = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? usd(v / 1e6, 2) + 'M' : Math.abs(v) >= 1e4 ? usd(v / 1e3, 1) + 'k' : usd(v));

const W = ['1m', '5m', '1h', '6h', '24h'];
const WL = { '1m': '1 mnt', '5m': '5 mnt', '1h': '1 jam', '6h': '6 jam', '24h': '24 jam' };
const fmtPx = (v) => (v == null ? '—' : usd(v, v < 0.01 ? 6 : 4));
const okAddr = (a) => /^0x[0-9a-f]{40}$/i.test(String(a || ''));

// Tag wallet versi GMGN -> label pendek + warna.
const TAG = {
  smart_degen: ['smart money', 'success'], smart_money: ['smart money', 'success'], renowned: ['KOL', 'accent'], kol: ['KOL', 'accent'],
  fresh_wallet: ['wallet baru', 'default'], sniper: ['sniper', 'warning'], rat_trader: ['rat trader', 'danger'], bundler: ['bundler', 'danger'],
  dev: ['dev', 'warning'], transfer_in: ['transfer masuk', 'default'], dex_bot: ['bot DEX', 'default'], bluechip_owner: ['pemilik bluechip', 'success'],
  whale: ['whale', 'accent'], top_holder: ['top holder', 'default'], paper_hands: ['paper hands', 'default'], diamond_hands: ['diamond hands', 'success'],
  sandwich_bot: ['bot sandwich', 'danger'], gmgn: ['GMGN', 'default'], fomo: ['fomo', 'default'], axiom: ['Axiom', 'default'], photon: ['Photon', 'default'],
};
// Urutan tampil: yang berarti untuk risiko dulu; "transfer masuk" hampir semua
// wallet punya, jadi paling belakang.
const TAG_RANK = ['sandwich_bot', 'bundler', 'rat_trader', 'smart_degen', 'smart_money', 'renowned', 'kol', 'whale', 'sniper', 'dev', 'fresh_wallet', 'paper_hands', 'diamond_hands', 'top_holder', 'bluechip_owner', 'dex_bot', 'gmgn', 'fomo', 'axiom', 'photon', 'transfer_in'];
const rank = (k) => { const i = TAG_RANK.indexOf(k); return i < 0 ? TAG_RANK.length - 1 : i; };
function Tags({ tags = [], max = 3 }) {
  const { t } = useI18n();
  const items = [...new Set(tags)].sort((a, b) => rank(a) - rank(b)).slice(0, max);
  if (!items.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((k) => { const [label, color] = TAG[k] || [k.replace(/_/g, ' '), 'default']; return <Chip key={k} size="sm" variant="soft" color={color === 'accent' ? 'accent' : color}>{t(label)}</Chip>; })}
    </span>
  );
}

// Nama wallet: bot sendiri, target yang disalin, nama GMGN, atau alamat pendek.
function WalletName({ r }) {
  const { t } = useI18n();
  const href = r.target ? `#targets/${r.address}` : `#wallet/${r.address}`;
  if (r.mine) return <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-accent">{t('bot')}</span>;
  if (r.target) return <a href={href} className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning hover:underline" title={r.address}>{r.label || short(r.address)}</a>;
  if (r.isPool) return <span className="text-muted" title={r.address}>{t('Likuiditas pool')}{r.exchange ? ` · ${r.exchange}` : ''}</span>;
  if (/^0x0{40}$|^0x0+dead$/i.test(r.address)) return <span className="text-muted" title={r.address}>{t('Burn')} · <span className="mono">{short(r.address)}</span></span>;
  return (
    <a href={href} className="hover:underline" title={r.address}>
      {r.name ? <span className="font-medium">{r.name}</span> : <span className="mono">{short(r.address)}</span>}
      {r.twitter && <span className="ml-1 text-xs text-muted">@{r.twitter}</span>}
    </a>
  );
}

const Src = ({ at }) => {
  const { t } = useI18n();
  return <span className="text-xs text-muted">GMGN{at ? ` · ${ago(at)}` : ''}{!at && ` · ${t('memuat')}`}</span>;
};

// ---------------- profil token ----------------
export function GmgnTokenPanel({ address }) {
  const { t } = useI18n();
  const { data: g } = usePoll(okAddr(address) ? `/api/gmgn/token?address=${address}` : null, 60000);
  if (!g || g.enabled === false) return null;
  if (g.error) return <Panel title="Menurut GMGN" desc={<Src />}><p className="text-sm text-muted">{t(g.error)}</p></Panel>;
  const tags = g.tags || {}, st = g.stat || {}, dv = g.dev || {}, ln = g.links || {};
  const tagRows = [['smart', 'Smart money'], ['renowned', 'KOL'], ['whale', 'Whale'], ['sniper', 'Sniper'], ['bundler', 'Bundler'], ['rat', 'Rat trader'], ['fresh', 'Wallet baru']].filter(([k]) => tags[k] != null && tags[k] > 0);
  const win = W.filter((w) => g.windows?.[w]?.volume != null || g.windows?.[w]?.change != null);
  const fromAth = g.athPriceUsd > 0 && g.priceUsd > 0 ? (g.priceUsd / g.athPriceUsd - 1) * 100 : null;
  return (
    <Panel title="Menurut GMGN" desc={<Src at={g.fetchedAt} />} bodyClass="px-4 py-1"
      action={ln.gmgn && <ExtLink href={ln.gmgn} muted>GMGN</ExtLink>}>
      <div className="divide-y divide-border">
        <KV label="Harga">
          <div className="flex flex-col items-end">
            <span>{fmtPx(g.priceUsd)}</span>
            {g.mcapUsd != null && <span className="text-xs font-normal text-muted">MCap {kUsd(g.mcapUsd)}{g.liquidityUsd != null && <> · {t('likuiditas')} {kUsd(g.liquidityUsd)}</>}</span>}
          </div>
        </KV>
        {g.athPriceUsd != null && <KV label="ATH">{fmtPx(g.athPriceUsd)}{fromAth != null && <span className={`ml-1.5 text-xs font-normal ${tone(fromAth)}`}>{pct(fromAth, 0)}</span>}</KV>}
        {g.holderCount != null && <KV label="Pemegang">{num(g.holderCount)}{st.top10Pct != null && <span className="ml-1.5 text-xs font-normal text-muted">{t('top 10 {v}%', { v: num(st.top10Pct, 1) })}</span>}</KV>}
        {(g.createdAt || g.og || g.lockedPct > 0) && <KV label="Umur">
          {g.createdAt ? age((Date.now() - g.createdAt) / 3600000) : '—'}
          {g.og && <Chip size="sm" variant="soft" color="accent" className="ml-1.5">OG</Chip>}
          {g.lockedPct > 0 && <span className="ml-1.5 text-xs font-normal text-muted">{t('{v}% terkunci', { v: num(g.lockedPct, 0) })}</span>}
        </KV>}
        {tagRows.length > 0 && <KV label="Wallet yang pegang">
          <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs font-normal">
            {tagRows.map(([k, label]) => <span key={k}><span className="num font-medium text-foreground">{num(tags[k])}</span> <span className="text-muted">{t(label)}</span></span>)}
          </div>
        </KV>}
        {(st.creatorPct != null || dv.creator) && <KV label="Dev">
          <div className="flex flex-col items-end text-xs font-normal">
            <span>
              {dv.creator && <a href={addrHref(dv.creator)} target="_blank" rel="noreferrer" className="mono hover:underline">{short(dv.creator)}</a>}
              {dv.status && <span className={`ml-1.5 ${dv.status === 'sell' ? 'text-danger' : 'text-success'}`}>{t(dv.status === 'sell' ? 'sudah jual' : 'masih pegang')}</span>}
              {st.creatorPct != null && <span className="ml-1.5 text-muted">{num(st.creatorPct, 1)}%</span>}
            </span>
            {(dv.openCount > 0 || dv.cto || dv.athToken) && <span className="text-muted">
              {dv.openCount > 0 && t('{n} token dibuat', { n: dv.openCount })}
              {dv.athToken?.mcapUsd != null && <> · {t('terbaik')} {dv.athToken.symbol || short(dv.athToken.address)} {kUsd(dv.athToken.mcapUsd)}</>}
              {dv.cto && <> · CTO</>}
            </span>}
          </div>
        </KV>}
        {win.length > 0 && (
          <div className="py-2">
            <div className="mb-1 text-xs text-muted">{t('Volume & transaksi per jendela')}</div>
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="py-0.5 text-left font-normal">{t('Jendela')}</th><th className="text-right font-normal">{t('Harga')}</th><th className="text-right font-normal">{t('Volume')}</th><th className="text-right font-normal">{t('Beli / jual')}</th></tr></thead>
              <tbody>
                {win.map((w) => { const x = g.windows[w]; return (
                  <tr key={w}>
                    <td className="py-0.5">{t(WL[w])}</td>
                    <td className={`num text-right ${tone(x.change)}`}>{x.change != null ? pct(x.change, 1) : '—'}</td>
                    <td className="num text-right">{x.volume != null ? kUsd(x.volume) : '—'}</td>
                    <td className="num text-right whitespace-nowrap">{x.buys != null || x.sells != null ? <><span className="text-success">{num(x.buys || 0)}</span> / <span className="text-danger">{num(x.sells || 0)}</span></> : '—'}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
        )}
        {(ln.website || ln.twitter || ln.telegram || ln.discord) && <KV label="Tautan">
          <span className="flex flex-wrap justify-end gap-x-3 text-xs font-normal">
            {ln.website && <ExtLink href={ln.website} muted>{t('Situs')}</ExtLink>}
            {ln.twitter && <ExtLink href={ln.twitter} muted>X</ExtLink>}
            {ln.telegram && <ExtLink href={ln.telegram} muted>Telegram</ExtLink>}
            {ln.discord && <ExtLink href={ln.discord} muted>Discord</ExtLink>}
          </span>
        </KV>}
        {ln.description && <p className="py-2 text-xs leading-relaxed text-muted">{ln.description.length > 280 ? ln.description.slice(0, 280) + '…' : ln.description}</p>}
      </div>
    </Panel>
  );
}

// ---------------- keamanan kontrak (di kartu kesehatan pool) ----------------
// Daftar chip: nilai yang aman hijau, yang perlu waspada kuning/merah, yang tidak
// diketahui abu-abu — supaya "tidak ada data" tidak tertukar dengan "aman".
export function GmgnSecurity({ g }) {
  const { t } = useI18n();
  if (!g || g.enabled === false || g.error) return null;
  const s = g.security;
  if (!s) return <p className="text-xs text-muted">{t('Keamanan kontrak menurut GMGN belum tersedia.')}{g.securityError ? ` (${t(g.securityError)})` : ''}</p>;
  // Status dev: dari security kalau ada, kalau tidak dari token/info.
  const devSold = s.creatorSold ?? (g.dev?.status === 'sell' ? true : g.dev?.status === 'hold' ? false : null);
  // Kolom yang GMGN tidak isi untuk chain ini disembunyikan — kecuali honeypot,
  // pajak, dan verifikasi kode, yang "tidak diketahui"-nya justru perlu terlihat.
  const chip = (label, value, level, keep = false) => (level === 'na' && !keep ? null :
    <span key={label} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${level === 'ok' ? 'border-success/30 bg-success/10 text-success' : level === 'bad' ? 'border-danger/30 bg-danger/10 text-danger' : level === 'warn' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-border text-muted'}`}>
      <span>{t(label)}</span><span className="num font-medium">{value}</span>
    </span>
  );
  const yn = (v, good) => (v == null ? '?' : t(v ? 'ya' : 'tidak'));
  const lv = (v, goodWhen) => (v == null ? 'na' : v === goodWhen ? 'ok' : 'bad');
  const items = [
    chip('Honeypot', yn(s.honeypot), lv(s.honeypot, false), true),
    chip('Pajak beli', s.buyTaxPct == null ? '?' : `${num(s.buyTaxPct, 1)}%`, s.buyTaxPct == null ? 'na' : s.buyTaxPct >= 10 ? 'bad' : s.buyTaxPct >= 3 ? 'warn' : 'ok', true),
    chip('Pajak jual', s.sellTaxPct == null ? '?' : `${num(s.sellTaxPct, 1)}%`, s.sellTaxPct == null ? 'na' : s.sellTaxPct >= 10 ? 'bad' : s.sellTaxPct >= 3 ? 'warn' : 'ok', true),
    chip('Risiko rug', s.rugPct == null ? '?' : `${num(s.rugPct, 0)}%`, s.rugPct == null ? 'na' : s.rugPct >= 50 ? 'bad' : s.rugPct >= 20 ? 'warn' : 'ok'),
    chip('Kode terverifikasi', yn(s.openSource), lv(s.openSource, true), true),
    chip('Owner dilepas', yn(s.ownerRenounced), lv(s.ownerRenounced, true)),
    chip('Dev', devSold == null ? '?' : t(devSold ? 'sudah jual' : 'masih pegang'), devSold == null ? 'na' : devSold ? 'warn' : 'ok'),
    chip('Wash trading', yn(s.washTrading), lv(s.washTrading, false)),
    ...(s.top10Pct != null ? [chip('Top 10', `${num(s.top10Pct, 1)}%`, s.top10Pct >= 60 ? 'bad' : s.top10Pct >= 40 ? 'warn' : 'ok')] : []),
    ...(s.insiderPct != null ? [chip('Orang dalam', `${num(s.insiderPct, 1)}%`, s.insiderPct >= 40 ? 'bad' : s.insiderPct >= 20 ? 'warn' : 'ok')] : []),
    ...(s.sniperCount != null ? [chip('Sniper', num(s.sniperCount), s.sniperCount >= 20 ? 'warn' : 'na')] : []),
    ...(s.lpBurned ? [chip('LP dibakar', yn(s.lpBurned), 'ok')] : []),
  ].filter(Boolean);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">{items}</div>
      <p className="mt-2 text-xs text-muted">{t('Keamanan kontrak menurut GMGN')} · {ago(g.fetchedAt)}{g.links?.gmgn && <a href={g.links.gmgn} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-accent">GMGN <ExternalLink size={11} /></a>}</p>
    </div>
  );
}

// ---------------- pemegang / trader teratas ----------------
const ORDERS = { holders: [['amount_percentage', 'Suplai'], ['profit', 'Profit'], ['unrealized_profit', 'Belum terealisasi']], traders: [['profit', 'Profit'], ['buy_volume_cur', 'Beli terbanyak'], ['sell_volume_cur', 'Jual terbanyak'], ['unrealized_profit', 'Belum terealisasi']] };
export function GmgnWallets({ address, kind = 'holders', symbol, className = '' }) {
  const { t } = useI18n();
  const [order, setOrder] = useState(ORDERS[kind][0][0]);
  const { data: g } = usePoll(okAddr(address) ? `/api/gmgn/wallets?address=${address}&kind=${kind}&order=${order}&limit=50` : null, 180000);
  if (!g || g.enabled === false) return null;
  const title = kind === 'traders' ? 'Trader teratas' : 'Pemegang teratas';
  const rows = g.rows || [];
  const sameFund = new Map();
  for (const r of rows) if (r.fundFrom && !r.isPool) sameFund.set(r.fundFrom, (sameFund.get(r.fundFrom) || 0) + 1);
  return (
    <Panel title={title} className={className} bodyClass="p-0"
      desc={<span className="inline-flex items-center gap-2"><Src at={g.fetchedAt} />{g.stale && <span className="text-warning">{t('tertunda')}</span>}</span>}
      action={<Segmented size="sm" aria="Urutan" value={order} onChange={setOrder} options={ORDERS[kind]} />}>
      {g.error ? <div className="p-4 text-sm text-muted">{t(g.error)}</div> : !g.rows ? <Loading /> : (
        <DataTable label={title} rows={rows} rowKey={(r) => r.address} dense pageSize={25}
          empty={<Empty title="Belum ada data" sub="GMGN belum punya daftar untuk token ini." />}
          columns={[
            { key: 'w', label: 'Wallet', sort: (r) => r.label || r.name || r.address, render: (r) => (
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5"><WalletName r={r} />{r.suspicious && <span className="text-xs text-danger" title={t('Ditandai mencurigakan oleh GMGN')}>!</span>}{r.isNew && <span className="text-xs text-muted">{t('baru')}</span>}</span>
                <span className="flex flex-wrap items-center gap-1"><Tags tags={[...r.tags, ...r.tokenTags]} />
                  {r.fundFrom && sameFund.get(r.fundFrom) > 1 && <span className="text-[0.6875rem] text-warning" title={t('Didanai dari alamat yang sama dengan {n} wallet lain di daftar ini — kemungkinan satu operator', { n: sameFund.get(r.fundFrom) - 1 })}>{t('dana sama ×{n}', { n: sameFund.get(r.fundFrom) })}</span>}
                </span>
              </div>) },
            { key: 'pct', label: 'Suplai', align: 'end', sort: (r) => r.pct ?? -1, render: (r) => (r.pct != null ? `${num(r.pct, 2)}%` : '—') },
            { key: 'usd', label: 'Nilai', align: 'end', sort: (r) => r.usd ?? -1, render: (r) => (r.usd != null ? kUsd(r.usd) : '—') },
            { key: 'cost', label: 'Harga beli rata-rata', align: 'end', sort: (r) => r.avgCost ?? -1, render: (r) => fmtPx(r.avgCost) },
            { key: 'sold', label: 'Sudah dijual', align: 'end', sort: (r) => r.soldPct ?? -1, render: (r) => (r.soldPct == null ? '—' : <span className={r.soldPct >= 100 ? 'text-muted' : ''}>{num(r.soldPct, 0)}%</span>) },
            { key: 'pnl', label: 'PnL', align: 'end', sort: (r) => r.profit ?? -Infinity, render: (r) => (r.profit == null ? '—' : (
              <div className="flex flex-col items-end"><span className={tone(r.profit)}>{kUsd(r.profit)}</span>
                {r.profitPct != null && <span className="text-xs text-muted">{pct(r.profitPct, 0)}</span>}</div>)) },
            { key: 'tx', label: 'Beli / jual', align: 'end', sort: (r) => (r.buyN || 0) + (r.sellN || 0), render: (r) => (r.buyN != null || r.sellN != null ? <span className="whitespace-nowrap"><span className="text-success">{num(r.buyN || 0)}</span> / <span className="text-danger">{num(r.sellN || 0)}</span></span> : '—') },
            { key: 'since', label: 'Sejak', align: 'end', sort: (r) => r.since || 0, render: (r) => (r.since ? <span className="whitespace-nowrap text-muted">{ago(r.since)}{r.exitAt && <span className="block text-xs">{t('keluar')} {ago(r.exitAt)}</span>}</span> : '—') },
          ]} />
      )}
      {symbol && rows.length > 0 && <p className="border-t border-border px-4 py-2 text-xs text-muted">{t('Suplai = persentase total {s} yang dipegang. PnL menurut GMGN: terealisasi + belum terealisasi pada harga sekarang.', { s: symbol })}</p>}
    </Panel>
  );
}

// Sebaran hasil per token (jumlah token per keranjang): rugi besar ... untung besar.
function PnlDist({ dist }) {
  const { t } = useI18n();
  const total = dist.reduce((a, b) => a + b, 0) || 1;
  const buckets = [['< −50%', 'bg-danger'], ['−50%…0', 'bg-danger/50'], ['0…2×', 'bg-success/50'], ['2×…5×', 'bg-success'], ['> 5×', 'bg-accent']];
  return (
    <div className="min-w-56">
      <div className="text-xs text-muted">{t('Sebaran hasil per token')}</div>
      <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-default">
        {dist.map((v, i) => v > 0 && <span key={i} className={buckets[i][1]} style={{ width: `${(v / total) * 100}%` }} title={`${buckets[i][0]}: ${num(v)}`} />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[0.6875rem] text-muted">
        {dist.map((v, i) => v > 0 && <span key={i}><span className="num font-medium text-foreground">{num(v)}</span> {buckets[i][0]}</span>)}
      </div>
    </div>
  );
}

// ---------------- reputasi satu wallet ----------------
export function GmgnWalletCard({ address }) {
  const { t } = useI18n();
  const [period, setPeriod] = useState('7d');
  const { data: g } = usePoll(okAddr(address) ? `/api/gmgn/wallet?address=${address}&period=${period}` : null, 300000);
  if (!g || g.enabled === false) return null;
  const idTags = g.tags?.length ? g.tags : g.tag ? [g.tag] : [];
  return (
    <Panel title="Menurut GMGN" desc={<Src at={g.fetchedAt} />} className="mb-4" bodyClass="px-4 py-3"
      action={<Segmented size="sm" aria="Periode" value={period} onChange={setPeriod} options={[['7d', '7 hari'], ['30d', '30 hari']]} />}>
      {g.error ? <p className="text-sm text-muted">{t(g.error)}</p> : (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          {[
            ['Winrate', g.winratePct != null ? `${num(g.winratePct, 1)}%` : '—', g.winratePct == null ? '' : g.winratePct >= 50 ? 'text-success' : 'text-danger'],
            ['Profit terealisasi', g.realized != null ? kUsd(g.realized) : '—', tone(g.realized)],
            ['Belum terealisasi', g.unrealized != null ? kUsd(g.unrealized) : '—', tone(g.unrealized)],
            ['Modal dipakai', g.cost != null ? kUsd(g.cost) : '—', ''],
            ['Beli / jual', g.buys != null || g.sells != null ? `${num(g.buys || 0)} / ${num(g.sells || 0)}` : '—', ''],
            ['PnL', g.pnlPct != null ? pct(g.pnlPct, 1) : '—', tone(g.pnlPct)],
            ...(g.tokens != null ? [['Token diperdagangkan', num(g.tokens), '']] : []),
            ...(g.avgHoldSec != null ? [['Rata-rata pegang', age(g.avgHoldSec / 3600), '']] : []),
          ].map(([label, value, cls]) => <div key={label}><div className="text-xs text-muted">{t(label)}</div><div className={`num mt-0.5 text-lg font-semibold ${cls}`}>{value}</div></div>)}
          {g.dist && g.dist.some((v) => v > 0) && <PnlDist dist={g.dist} />}
          <div className="flex min-w-48 flex-col gap-1 text-xs">
            {(g.name || g.ens || g.twitter) && <div className="text-sm font-medium">{g.name || g.ens}{g.twitter && <a href={`https://x.com/${g.twitter}`} target="_blank" rel="noreferrer" className="ml-1.5 font-normal text-muted hover:underline">@{g.twitter}{g.followers != null && ` · ${num(g.followers)} ${t('pengikut')}`}</a>}</div>}
            {idTags.length > 0 && <Tags tags={idTags} max={4} />}
            <div className="text-muted">
              {g.createdAt && <span>{t('wallet berumur {a}', { a: age((Date.now() - g.createdAt) / 3600000) })}</span>}
              {g.followCount != null && g.followCount > 0 && <span> · {t('{n} pengikut di GMGN', { n: num(g.followCount) })}</span>}
              {g.createdTokens > 0 && <span> · {t('{n} token dibuat', { n: g.createdTokens })}</span>}
            </div>
            {(g.fundFrom || g.fundFromAddress) && <div className="text-muted">{t('dana awal dari')} {g.fundFrom || short(g.fundFromAddress)}{g.fundFromAddress && <a href={addrHref(g.fundFromAddress)} target="_blank" rel="noreferrer" className="mono ml-1 hover:underline">{g.fundFrom ? short(g.fundFromAddress) : ''}</a>}</div>}
          </div>
        </div>
      )}
    </Panel>
  );
}
