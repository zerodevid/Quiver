// Laci riwayat satu posisi wallet yang diriset — dibuka dengan mengklik baris di
// tabel "Posisi berjalan"/"Riwayat posisi" halaman Wallet.
//
// Bedanya dengan laci posisi bot (PositionHistory): di sini tidak ada catatan bot,
// karena posisinya bukan milik kita. Yang ada justru lebih mentah dan lebih menarik
// untuk riset — setiap kejadian on-chain yang menyentuh posisi itu, dengan POKOK dan
// FEE yang sudah dipisahkan, plus harga pool di blok kejadian. Semuanya sudah
// tersimpan saat pindai wallet (tabel wevents), jadi membuka laci ini tidak
// memanggil chain sama sekali.
import { useEffect, useState } from 'react';
import { Button, Chip, Drawer } from '@heroui/react';
import { X, ChartCandlestick } from 'lucide-react';
import { get } from '../api';
import { Stat, Empty, Loading, Notice, PriceRange, TxHash } from './ui';
import TokenIcon, { TokenPair } from './TokenIcon';
import { usd, pct, tone, age, ago, num, short, qty, fmtQty, price, sqrtPrice, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const KIND = {
  mint: ['Buka posisi', 'success'],
  increase: ['Tambah likuiditas', 'success'],
  decrease: ['Tarik likuiditas', 'warning'],
  collect: ['Klaim fee', 'accent'],
  close: ['Tutup posisi', 'danger'],
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const big = (v) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };

// "decrease" yang menghabiskan likuiditas adalah penutupan posisi — bedanya cuma
// terlihat dari likuiditas berjalan, jadi dihitung di sini, bukan disimpan per baris.
function withKinds(events) {
  let liq = 0n;
  return events.map((e) => {
    const before = liq;
    liq += big(e.liq_delta);
    if (liq < 0n) liq = 0n;
    return { ...e, kind: e.kind === 'decrease' && before > 0n && liq === 0n ? 'close' : e.kind };
  });
}

// Jumlah token pada satu kejadian, dipecah jadi pokok dan fee — inilah yang membuat
// riwayat wallet bisa dipercaya: penarikan yang tampak besar sering sebagian besar
// pokok, bukan hasil.
function Amounts({ ev, p }) {
  const { t } = useI18n();
  const row = (addr, sym, raw, dec, cls = '') => {
    const v = qty(raw, dec);
    if (!v) return null;
    return (
      <div className={`flex items-center gap-1.5 whitespace-nowrap ${cls}`}>
        <TokenIcon address={addr} symbol={sym} size={14} />
        <span className="num">{fmtQty(v)}</span>
        <span className="text-muted">{sym}</span>
      </div>
    );
  };
  const princ = [row(p.token0, p.symbol0, ev.princ0, p.dec0), row(p.token1, p.symbol1, ev.princ1, p.dec1)].filter(Boolean);
  const fee = [row(p.token0, p.symbol0, ev.fee0, p.dec0, 'text-success'), row(p.token1, p.symbol1, ev.fee1, p.dec1, 'text-success')].filter(Boolean);
  if (!princ.length && !fee.length) return <span className="text-muted">—</span>;
  return (
    <div className="space-y-1 text-xs">
      {princ.length > 0 && <div className="space-y-0.5">{princ}</div>}
      {fee.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[0.6875rem] text-muted">{t('fee')}</div>
          {fee}
        </div>
      )}
    </div>
  );
}

function Events({ events, p }) {
  const { t } = useI18n();
  const evs = [...withKinds(events)].reverse();   // terbaru di atas, seperti tabel lain
  if (!evs.length) {
    return <Empty title="Belum ada kejadian tercatat"
      sub="Riwayat posisi ini ada di luar jendela pindai — perluas jendelanya lalu pindai ulang." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 text-start font-medium">{t('Transaksi')}</th>
            <th className="py-2 pr-3 text-start font-medium">{t('Aksi')}</th>
            <th className="py-2 pr-3 text-start font-medium">{t('Token')}</th>
            <th className="py-2 pr-3 text-end font-medium">{t('Nilai')}</th>
            <th className="py-2 pr-3 text-end font-medium">{t('Harga pool')}</th>
            <th className="py-2 text-end font-medium">{t('Waktu')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {evs.map((ev) => {
            const k = KIND[ev.kind] || [ev.kind, 'default'];
            const px = sqrtPrice(ev.sqrt_price, p.dec0, p.dec1, p.quoteSide);
            return (
              <tr key={`${ev.tx_hash}:${ev.log_index}`} className="align-top">
                <td className="py-2.5 pr-3">
                  <TxHash hash={ev.tx_hash} />
                  <div className="num text-xs text-muted">{t('blok {n}', { n: num(ev.block) })}</div>
                </td>
                <td className="py-2.5 pr-3">
                  <Chip size="sm" variant="soft" color={k[1]} className="whitespace-nowrap">{t(k[0])}</Chip>
                </td>
                <td className="py-2.5 pr-3"><Amounts ev={ev} p={p} /></td>
                <td className="num py-2.5 pr-3 text-end whitespace-nowrap">{ev.value_q == null ? '—' : usd(ev.value_q)}</td>
                <td className="num py-2.5 pr-3 text-end whitespace-nowrap text-muted">{px == null ? '—' : price(px)}</td>
                <td className="py-2.5 text-end whitespace-nowrap text-muted" title={fmtDate(ev.ts)}>{ago(ev.ts)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * p       : baris posisi dari /api/wallet (null = laci tertutup)
 * address : wallet pemiliknya — kejadian diambil per (wallet, token_id)
 */
export default function WalletPositionHistory({ p, address, onClose }) {
  const { t } = useI18n();
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(null);
  const id = p?.token_id;

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setEvents(null); setErr(null);
    get(`/api/wallet/events?address=${address}&token_id=${id}`)
      .then((r) => { if (!alive) return; if (r.error) setErr(r.error); else setEvents(r.events || []); })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [id, address]);

  const open = p?.status === 'open';
  const fee = (p?.fees_q || 0) + (open ? (p?.live_fee_q || 0) : 0);
  return (
    <Drawer isOpen={!!p} onOpenChange={(o) => { if (!o) onClose(); }}>
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
                      <Chip size="sm" variant="soft" color={open ? 'success' : 'danger'}>{t(open ? 'Terbuka' : 'Ditutup')}</Chip>
                    </Drawer.Heading>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span className="uppercase">{String(p.venue || 'v4')}</span><span>·</span>
                      <span className="mono">#{p.token_id}</span><span>·</span>
                      <a href={'#wallet/' + address} className="mono hover:underline">{short(address)}</a>
                    </div>
                  </div>
                </div>
              ) : <Drawer.Heading className="text-base font-semibold">{t('Riwayat posisi')}</Drawer.Heading>}
              <Drawer.CloseTrigger aria-label={t('Tutup')}><X className="size-4" /></Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="text-foreground">
              {p && (
                <>
                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <Stat label={open ? 'PnL (belum terealisasi)' : 'PnL'} value={usd(p.pnl_q)} valueClass={tone(p.pnl_q)}
                      sub={p.pnlPct == null ? null : pct(p.pnlPct, 2)} />
                    <Stat label="Umur" value={age(p.ageHours)}
                      sub={p.opened_ts ? t('dibuka {w}', { w: ago(p.opened_ts) }) : null} />
                    <Stat label="Fee total" value={usd(fee)} valueClass={fee > 0.005 ? 'text-success' : ''}
                      sub={p.invested_q > 0 ? pct((fee / p.invested_q) * 100, 2).replace('+', '') : null} />
                    <Stat label="Modal" value={usd(p.invested_q)}
                      sub={open ? t('nilai kini {v}', { v: usd(p.live_value_q) }) : t('hasil {v}', { v: usd(p.returned_q) })} />
                  </div>

                  <div className="mb-4 rounded-lg border border-border p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{t('Rentang harga')}</span>
                      <span className="text-xs text-muted">
                        {p.dprPct == null ? null : t('DPR {v}', { v: pct(p.dprPct, 2) })}
                      </span>
                    </div>
                    <PriceRange lo={p.tick_lower} hi={p.tick_upper} cur={open ? p.curTick : null}
                      dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1}
                      entrySqrt={p.entrySqrt} exitSqrt={p.exitSqrt} />
                  </div>

                  {p.incomplete === 1 && (
                    <div className="mb-4"><Notice status="warning" title="Riwayat posisi ini terpotong">
                      {t('Sebagian kejadiannya terjadi sebelum jendela pindai, jadi modal dan PnL-nya tidak ikut dihitung di ringkasan wallet. Perluas jendela lalu pindai ulang untuk melengkapinya.')}
                    </Notice></div>
                  )}

                  {err && <Notice status="danger" title="Riwayat tidak terbaca">{err}</Notice>}
                  {!events && !err && <Loading text="Memuat riwayat…" />}
                  {events && (
                    <>
                      <h3 className="mb-2 text-sm font-semibold">{t('Kejadian on-chain ({n})', { n: events.length })}</h3>
                      <div className="rounded-lg border border-border px-3"><Events events={events} p={p} /></div>
                    </>
                  )}
                </>
              )}
            </Drawer.Body>
            {p && (
              <Drawer.Footer className="mt-4 flex-wrap justify-between gap-2">
                <span className="max-w-prose text-xs text-muted">
                  {t('Pokok dan fee dipisahkan lewat matematika likuiditas pada state pool di blok tiap kejadian, bukan ditaksir dari transfer token.')}
                </span>
                {p.pool_ref && (
                  <Button size="sm" variant="outline" onPress={() => { onClose(); location.hash = '#pool/' + p.pool_ref; }}>
                    <ChartCandlestick className="size-4" />{t('Halaman pool & grafik')}
                  </Button>
                )}
              </Drawer.Footer>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
