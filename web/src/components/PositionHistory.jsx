// Laci riwayat satu posisi bot — dibuka dengan mengklik baris di halaman Posisi.
// Menjawab "apa saja yang bot lakukan untuk posisi ini": setiap transaksi yang
// menyentuhnya (swap zap, mint, tambah, kurangi, tutup, jual sisa) dengan jumlah
// token dan nilainya, lalu catatan bot — keputusan atas aksi target yang memicunya
// dan baris log yang menyebut posisi ini. Grafik harga tetap di halaman detail.
import { useEffect, useState } from 'react';
import PositionSnapshot from './PositionSnapshot';
import { Button, Chip, Drawer, toast } from '@heroui/react';
import { Copy, ExternalLink, X, ChartCandlestick } from 'lucide-react';
import { get } from '../api';
import { Stat, Empty, Loading, Notice } from './ui';
import TokenIcon, { TokenPair } from './TokenIcon';
import { usd, pct, tone, age, ago, short, txHref, locale as fmtLocale } from '../fmt';
import { useI18n, reason } from '../i18n';

// Jenis transaksi -> label & warna chip.
const KIND = {
  mint: ['Buka posisi', 'success'],
  increase: ['Tambah likuiditas', 'success'],
  decrease: ['Kurangi likuiditas', 'warning'],
  claim_fees: ['Klaim fee', 'success'],
  compound: ['Auto-compound', 'success'],
  burn: ['Tutup posisi', 'danger'],
  zap_swap: ['Swap zap', 'accent'],
  bridge_swap: ['Swap kuotasi', 'accent'],
  sell_leftover: ['Jual sisa', 'warning'],
  kyber_swap: ['Swap', 'accent'],
  swap_manual: ['Swap manual', 'accent'],
};
const VERDICT = { copy: ['Disalin', 'success'], dry: ['Simulasi', 'accent'], skip: ['Dilewati', 'default'], error: ['Gagal', 'danger'] };

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const qty = (raw, dec) => (raw == null ? null : Number(BigInt(String(raw))) / 10 ** (dec ?? 18));
const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—'
  : v >= 1e6 ? v.toLocaleString(fmtLocale(), { maximumFractionDigits: 0 })
    : v.toLocaleString(fmtLocale(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));

function TxHash({ hash }) {
  const { t } = useI18n();
  if (!hash) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <a href={txHref(hash)} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-accent hover:underline">
        {short(hash)}<ExternalLink className="size-3" />
      </a>
      <button type="button" className="text-muted hover:text-foreground" aria-label={t('Salin hash')}
        onClick={() => { navigator.clipboard?.writeText(hash); toast.success(t('Hash tersalin')); }}><Copy className="size-3" /></button>
    </span>
  );
}

// Saldo token yang berpindah di satu kejadian: mint/tambah = masuk ke posisi,
// kurangi/tutup = keluar dari posisi. Swap ditampilkan sebagai USD masuk → keluar.
function Amounts({ ev, p }) {
  const { t } = useI18n();
  if (ev.swap) return <div className="space-y-0.5 text-xs">
    <div className="num">{fmtQty(ev.swap.amountIn)} {ev.swap.symbolIn || short(ev.swap.tokenIn)}</div>
    <div className="num">→ {fmtQty(ev.swap.amountOut)} {ev.swap.symbolOut || short(ev.swap.tokenOut)}</div>
    {ev.dex && <div className="text-muted">{t('via {dex}', { dex: ev.dex })}</div>}
  </div>;
  if (ev.usdIn != null || ev.usdOut != null) {
    return (
      <div className="text-xs">
        <div className="num">{usd(ev.usdIn)} → {usd(ev.usdOut)}</div>
        {ev.dex && <div className="text-muted">{t('via {dex}', { dex: ev.dex })}</div>}
      </div>
    );
  }
  if (ev.amount0 == null && ev.amount1 == null) return <span className="text-muted">—</span>;
  const row = (addr, sym, raw, dec) => (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <TokenIcon address={addr} symbol={sym} size={14} />
      <span className="num">{fmtQty(qty(raw, dec))}</span>
      <span className="text-muted">{sym}</span>
    </div>
  );
  return (
    <div className="space-y-0.5 text-xs">
      {row(p.token0, p.symbol0, ev.amount0, p.dec0)}
      {row(p.token1, p.symbol1, ev.amount1, p.dec1)}
    </div>
  );
}

function Events({ d }) {
  const { t } = useI18n();
  const p = d.position;
  const evs = [...d.events].reverse();   // terbaru di atas, seperti tabel riwayat lain
  if (!evs.length) return <Empty title="Belum ada transaksi tercatat" sub="Posisi ini belum menyentuh chain lewat bot." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 text-start font-medium">{t('Transaksi')}</th>
            <th className="py-2 pr-3 text-start font-medium">{t('Aksi')}</th>
            <th className="py-2 pr-3 text-start font-medium">{t('Token')}</th>
            <th className="py-2 pr-3 text-end font-medium">{t('Nilai')}</th>
            <th className="py-2 text-end font-medium">{t('Waktu')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {evs.map((ev, i) => {
            const k = KIND[ev.kind] || [ev.kind, 'default'];
            const failed = ev.status === 'gagal';
            return (
              <tr key={ev.hash || i} className="align-top">
                <td className="py-2.5 pr-3"><TxHash hash={ev.hash} />
                  {ev.gasUsd != null && <div className="num text-xs text-muted">{t('gas {v}', { v: usd(ev.gasUsd) })}</div>}</td>
                <td className="py-2.5 pr-3">
                  <Chip size="sm" variant="soft" color={failed ? 'danger' : k[1]} className="whitespace-nowrap">{t(k[0])}</Chip>
                  {failed && <div className="mt-1 max-w-56 text-xs text-danger">{reason(ev.error) || t('gagal')}</div>}
                  {ev.status === 'pending' && <div className="mt-1 text-xs text-warning">{t('menunggu konfirmasi')}</div>}
                  {ev.reason && <div className="mt-1 max-w-64 text-xs text-muted" title={reason(ev.reason)}>{reason(ev.reason)}</div>}
                </td>
                <td className="py-2.5 pr-3"><Amounts ev={ev} p={p} /></td>
                <td className="num py-2.5 pr-3 text-end whitespace-nowrap">
                  {failed ? '—' : ev.valueUsd != null ? usd(ev.valueUsd) : ev.usdOut != null ? usd(ev.usdOut) : '—'}
                  {ev.feesUsd > 0.005 && <div className="text-xs text-success">{t('fee {v}', { v: usd(ev.feesUsd) })}</div>}
                  {ev.targetUsd != null && <div className="text-xs text-muted">{t('target {v}', { v: usd(ev.targetUsd) })}</div>}
                </td>
                <td className="py-2.5 text-end whitespace-nowrap text-muted" title={fmtDate(ev.ts)}>{ago(ev.ts)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ notes }) {
  const { t } = useI18n();
  if (!notes.length) return <Empty title="Belum ada catatan" sub="Keputusan bot dan baris log yang menyebut posisi ini akan muncul di sini." />;
  const list = [...notes].reverse();
  return (
    <ul className="divide-y divide-border text-sm">
      {list.map((n, i) => {
        const v = n.verdict ? VERDICT[n.verdict] : null;
        const cls = n.level === 'error' ? 'text-danger' : n.level === 'warn' ? 'text-warning' : '';
        return (
          <li key={i} className="flex items-start gap-3 py-2">
            <span className="w-24 shrink-0 text-xs text-muted" title={fmtDate(n.ts)}>{ago(n.ts)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {v && <Chip size="sm" variant="soft" color={v[1]}>{t(v[0])}</Chip>}
                {n.actionKind && <span className="text-xs text-muted">{t('aksi target: {k}', { k: t(({ mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Penarikan likuiditas', burn: 'Tutup posisi', collect: 'Klaim fee', transfer_out: 'Transfer posisi' })[n.actionKind] || n.actionKind) })}</span>}
                {!v && <span className="text-xs text-muted">{t(({ info: 'Informasi', warn: 'Peringatan', error: 'Kesalahan' })[n.level] || n.level)}</span>}
              </div>
              <div className={`mt-0.5 break-words ${cls}`}>{reason(n.msg)}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// id: posisi yang dibuka (null = laci tertutup)
export default function PositionHistory({ id, onClose }) {
  const { t } = useI18n();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setD((prev) => prev?.position?.id === Number(id) ? prev : null); setErr(null);
    get(`/api/position/history?id=${id}`).then((r) => { if (!alive) return; if (r.error) setErr(r.error); else setD(r); })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [id, revision]);

  const p = d?.position;
  const closed = p?.status === 'closed';
  const hours = p ? ((p.closed_ts || Date.now()) - (p.opened_ts || Date.now())) / 3600000 : null;
  return (
    <Drawer isOpen={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Drawer.Backdrop isDismissable>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-full max-w-[760px] overflow-hidden">
            <Drawer.Header className="mb-4 flex-row! items-start justify-between gap-3 pr-8">
              {p ? (
                <div className="flex min-w-0 items-center gap-3">
                  <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={28} />
                  <div className="min-w-0">
                    <Drawer.Heading className="flex flex-wrap items-center gap-2 text-base font-semibold">
                      {p.symbol0}/{p.symbol1}
                      <Chip size="sm" variant="soft" color={closed ? 'danger' : 'success'}>{t(closed ? 'Ditutup' : 'Terbuka')}</Chip>
                    </Drawer.Heading>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span className="uppercase">{p.venue}</span><span>·</span><span className="mono">#{p.token_id || p.id}</span>
                      {p.target && <><span>·</span><a href={'#targets/' + p.target} className="hover:underline">{t('meniru {t}', { t: p.targetLabel || short(p.target) })}</a></>}
                    </div>
                  </div>
                </div>
              ) : <Drawer.Heading className="text-base font-semibold">{t('Riwayat posisi')}</Drawer.Heading>}
              <Drawer.CloseTrigger aria-label={t('Tutup')}><X className="size-4" /></Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="text-foreground">
              {err && <Notice status="danger" title="Riwayat tidak terbaca">{err}</Notice>}
              {!d && !err && <Loading text="Memuat riwayat…" />}
              {d && (
                <>
                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <Stat label={closed ? 'PnL total (LP + sisa)' : 'PnL (belum terealisasi)'} value={usd(p.pnlUsd ?? 0)} valueClass={tone(p.pnlUsd)}
                      sub={p.costUsd > 0 && p.pnlUsd != null ? pct((p.pnlUsd / p.costUsd) * 100, 2) : null} />
                    <Stat label="Umur" value={age(hours)} sub={p.opened_ts ? t('dibuka {w}', { w: ago(p.opened_ts) }) : null} />
                    <Stat label="Fee didapat" value={usd(p.feesUsd)} valueClass={p.feesUsd > 0.005 ? 'text-success' : ''}
                      sub={p.costUsd > 0 ? pct((p.feesUsd / p.costUsd) * 100, 2).replace('+', '') : null} />
                    <Stat label="Modal" value={usd(p.costUsd)} sub={closed ? t('hasil {v}', { v: usd(p.outUsd) }) : null} />
                  </div>
                  <PositionSnapshot key={id} id={id} onUpdate={() => setRevision((v) => v + 1)} />
                  {closed && <div className="mb-4 rounded-lg border border-border p-3 text-sm">
                    <div className="flex justify-between gap-3"><span>{t('Hasil LP saat tutup (taksiran)')}</span><span className="num">{usd(p.closeUsd)}</span></div>
                    <div className="mt-1 flex justify-between gap-3"><span>{t('PnL LP saat tutup')}</span><span className={`num ${p.closeUsd != null ? tone(p.closeUsd - p.costUsd) : ''}`}>{usd(p.closeUsd != null ? p.closeUsd - p.costUsd : null)}</span></div>
                    {p.closeUsd != null && <div className="mt-1 flex justify-between gap-3"><span>{t('Perubahan hasil setelah tutup')}</span><span className={`num ${tone(p.outUsd - p.closeUsd)}`}>{usd(p.outUsd - p.closeUsd)}</span></div>}
                    <p className="mt-2 text-xs text-muted">{t('Hasil LP menilai token saat penutupan. PnL total mencakup hasil penjualan sisa token; nilai swap bukan tambahan utuh ke hasil LP.')}</p>
                  </div>}
                  {p.leftToken && p.leftAmount !== '0' && (
                    <div className="mb-4"><Notice status="warning" title="Sisa token belum terjual">
                      {t('{q} {s} (≈{v}) dari penutupan masih dipegang — dijual otomatis di kesempatan berikutnya.', { q: fmtQty(qty(p.leftAmount, p.leftDec)), s: p.leftSymbol || short(p.leftToken), v: usd(p.leftUsd) })}
                    </Notice></div>
                  )}

                  <h3 className="mb-2 text-sm font-semibold">{t('Riwayat transaksi ({n})', { n: d.events.length })}</h3>
                  <div className="mb-5 rounded-lg border border-border px-3"><Events d={d} /></div>

                  <h3 className="mb-2 text-sm font-semibold">{t('Catatan bot ({n})', { n: d.notes.length })}</h3>
                  <div className="rounded-lg border border-border px-3"><Notes notes={d.notes} /></div>
                </>
              )}
            </Drawer.Body>
            {p && (
              <Drawer.Footer className="mt-4 justify-between">
                <span className="text-xs text-muted">{t('Jumlah token dan nilai dicatat bot saat transaksi; harga swap dari Kyber.')}</span>
                <Button size="sm" variant="outline" onPress={() => { onClose(); location.hash = '#positions/' + p.id; }}>
                  <ChartCandlestick className="size-4" />{t('Halaman detail & grafik')}</Button>
              </Drawer.Footer>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
