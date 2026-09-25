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
import { useI18n, reason } from '../i18n';

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

// ---- sisi kita atas posisi orang lain ----
//
// Laci ini menilai posisi WALLET LAIN sampai tuntas, lalu berhenti tepat sebelum
// pertanyaan yang membuat orang membukanya: "kita ikut atau tidak?". Jawabannya
// dulu tersebar — salinan kita di halaman Posisi, alasan melewat di Aktivitas —
// jadi menilai satu posisi target berarti membuka tiga halaman dan mencocokkan
// nomor NFT sendiri. Di sini keduanya diletakkan di bawah angka target: salinan
// kita kalau ada, dan kalau tidak, alasan mesin menolak — apa adanya, dengan
// kata-kata yang sama seperti yang tercatat saat keputusannya dibuat.
const VERDICT = { copy: ['Disalin', 'success'], dry: ['Simulasi', 'accent'], skip: ['Dilewati', 'default'], error: ['Gagal', 'danger'] };
const AKSI = {
  mint: 'buka posisi', increase: 'tambah likuiditas', decrease: 'tarik likuiditas', burn: 'tutup posisi',
  collect: 'klaim fee', claim: 'klaim fee', transfer_in: 'terima posisi', transfer_out: 'kirim posisi',
  custody_in: 'ambil dari otomasi', custody_out: 'titip ke otomasi',
};
const STATUS = { open: ['Terbuka', 'success'], closed: ['Ditutup', 'danger'], pending: ['Menunggu', 'warning'], failed: ['Gagal', 'danger'] };

const Fig = ({ label, value, sub, cls = '' }) => {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted">{t(label)}</div>
      <div className={`num truncate text-sm font-semibold ${cls}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
};

function Salinan({ q, p }) {
  const { t } = useI18n();
  const open = q.status === 'open';
  const s = STATUS[q.status] || [q.status, 'default'];
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {t('Salinan kita')}
          <Chip size="sm" variant="soft" color={s[1]}>{t(s[0])}</Chip>
          {q.takeoverTs != null && open && (
            <Chip size="sm" variant="soft" color="warning">{t('Kendali manual')}</Chip>
          )}
        </span>
        <a href={'#positions/' + q.id} className="text-xs text-accent hover:underline">{t('Lihat posisi #{id}', { id: q.id })}</a>
      </div>
      {q.status === 'open' || q.status === 'closed' ? (
        q.syncing ? (
          <div className="text-xs text-muted">{t('Baru dibuka — modal {v}; angka selengkapnya menyusul sinkron berikutnya.', { v: usd(q.costUsd) })}</div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Fig label="Modal" value={usd(q.costUsd)} />
            <Fig label={open ? 'Nilai kini' : 'Hasil'} value={usd(open ? q.valueUsd : q.outUsd)}
              sub={q.feeUsd > 0.005 ? t('fee {v}', { v: usd(q.feeUsd) }) : null} />
            <Fig label={open ? 'PnL (belum terealisasi)' : 'PnL'} value={usd(q.pnlUsd)} cls={tone(q.pnlUsd)}
              sub={q.pnlPct == null ? null : pct(q.pnlPct, 2)} />
          </div>
        )
      ) : (
        <div className="text-xs text-muted">{t('Salinan ini tidak pernah jadi posisi — transaksinya {s}.', { s: t(q.status === 'pending' ? 'masih menggantung' : 'gagal') })}</div>
      )}
      {/* Modal kita hampir tidak pernah sebesar modal target, jadi dolarnya tidak
          bisa diadu; persen terhadap modal masing-masing bisa. */}
      {q.pnlPct != null && p.pnlPct != null && !q.syncing && (
        <div className="mt-2 text-xs text-muted">
          {t('Target {a} atas modalnya · kita {b} atas modal kita', { a: pct(p.pnlPct, 2), b: pct(q.pnlPct, 2) })}
        </div>
      )}
      <div className="mt-1 text-xs text-muted">
        {q.openedTs ? t('dibuka {w}', { w: ago(q.openedTs) }) : null}
        {q.closedTs ? ` · ${t('ditutup {w}', { w: ago(q.closedTs) })}` : null}
      </div>
    </div>
  );
}

function OurSide({ copy, p }) {
  const { t } = useI18n();
  if (!copy) return null;
  const ours = copy.positions || [];
  // Urut kronologis, bukan terbaru di atas seperti tabel lain: yang menjawab
  // "kenapa tidak ikut" adalah keputusan atas pembukaan posisi — keputusan
  // sesudahnya ("tidak ada cermin yang cocok" saat target menarik) cuma akibatnya.
  const decs = copy.decisions || [];
  const ditolak = decs.some((d) => d.verdict && d.verdict !== 'copy');
  // Kenapa tidak ada salinan. Urutannya dari yang paling menjelaskan: wallet ini
  // memang bukan target > target baru ditambah setelah posisinya dibuka > mesin
  // memang tidak pernah melihat aksinya > mesin melihat tapi menolak (daftar
  // alasannya menyusul di bawah).
  const sebab = !copy.isTarget
    ? 'Wallet ini bukan target — posisinya hanya diriset, tidak pernah diikuti mesin.'
    : !decs.length
      ? (copy.addedTs && p.opened_ts && copy.addedTs > p.opened_ts
        ? 'Target ini baru ditambahkan setelah posisi ini dibuka, jadi pembukaannya tidak pernah dilihat pemantau.'
        : 'Pemantau tidak mencatat satu aksi pun di posisi ini — kemungkinan terjadi selagi mesin mati dan di luar jangkauan backfill.')
      : ditolak
        ? 'Mesin melihat aksinya, tapi tidak menyalinnya:'
        : 'Aksinya tercatat, tapi belum ada keputusan atasnya.';
  return (
    <div className="mb-4 space-y-3">
      {ours.map((q) => <Salinan key={q.id} q={q} p={p} />)}
      {!ours.length && (
        <div className="rounded-lg border border-border p-3">
          <div className="text-sm font-medium">{t('Kita tidak menyalin posisi ini')}</div>
          <p className="mt-1 text-xs text-muted">{t(sebab)}</p>
          {copy.isTarget && !copy.enabled && (
            <p className="mt-1 text-xs text-muted">{t('Target ini sedang dimatikan.')}</p>
          )}
          {decs.length > 0 && (
            <ul className="mt-2 space-y-2 border-t border-border pt-2">
              {decs.slice(0, 6).map((d) => {
                const v = d.verdict ? VERDICT[d.verdict] : null;
                return (
                  <li key={d.actionId} className="flex flex-col gap-1 text-xs sm:flex-row sm:items-baseline sm:gap-2">
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Chip size="sm" variant="soft" color={v ? v[1] : 'default'}>{v ? t(v[0]) : t('Belum diputuskan')}</Chip>
                      <span className="text-muted">{t(AKSI[d.kind] || d.kind)}</span>
                    </span>
                    <span className="min-w-0 flex-1 break-words">{d.reason ? reason(d.reason) : '—'}</span>
                    <span className="shrink-0 text-muted" title={fmtDate(d.ts)}>{ago(d.ts)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
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
  const [copy, setCopy] = useState(null);
  const [err, setErr] = useState(null);
  const id = p?.token_id;
  const venue = p?.venue || '';

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setEvents(null); setCopy(null); setErr(null);
    get(`/api/wallet/events?address=${address}&token_id=${id}&venue=${venue}`)
      .then((r) => {
        if (!alive) return;
        if (r.error) setErr(r.error);
        else { setEvents(r.events || []); setCopy(r.copy || null); }
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [id, address, venue]);

  const open = p?.status === 'open';
  const fee = (p?.fees_q || 0) + (open ? (p?.live_fee_q || 0) : 0);
  return (
    <Drawer isOpen={!!p} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Drawer.Backdrop isDismissable>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="position-drawer">
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
                  <div className="mb-4 grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
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

                  <OurSide copy={copy} p={p} />

                  {p.incomplete === 1 && (
                    <div className="mb-4"><Notice status="warning" title="Riwayat posisi ini terpotong">
                      {t('Sebagian kejadiannya terjadi sebelum jendela pindai, jadi modal dan PnL-nya tidak ikut dihitung di ringkasan wallet. Perluas jendela lalu pindai ulang untuk melengkapinya.')}
                    </Notice></div>
                  )}
                  {p.incomplete === 2 && (
                    <div className="mb-4"><Notice status="warning" title="Harga saat kejadian belum terbaca">
                      {t('RPC sedang sibuk ketika posisi ini dipindai, jadi salah satu kejadiannya belum bisa dinilai dan modal/PnL-nya tidak ikut ringkasan wallet. Akan dibaca ulang otomatis pada pembaruan berikutnya.')}
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
