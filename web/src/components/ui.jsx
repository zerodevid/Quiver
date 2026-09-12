// Komponen kecil yang dipakai berulang. Semuanya dirakit dari komponen HeroUI;
// tidak ada gaya visual baru di luar token tema HeroUI.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Chip, EmptyState, Label, Description, TextField, Input, Select, ListBox,
  Switch, Table, Spinner, Alert, Pagination, AlertDialog, Button,
} from '@heroui/react';
import { Inbox, Search, ArrowLeft, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import { price, tickPrice, sqrtPrice, widthPct, pct, short, txHref, ago } from '../fmt';
import { useTick } from '../hooks';
import { translate as t } from '../i18n';

export function PageHeader({ group, title, desc, children }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border pb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{t(title)}</h1>
        {desc && <p className="mt-1 max-w-prose text-sm text-muted">{t(desc)}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

// Angka utama. Label kecil di atas, nilai besar, keterangan di bawah — tanpa
// HURUF BESAR SEMUA, yang pada empat kartu berjajar berubah jadi teriakan.
export function Stat({ label, value, sub, valueClass = '' }) {
  return (
    <Card className="min-w-0 gap-1.5! p-3.5!">
      <div className="truncate text-xs font-medium text-muted">{t(label)}</div>
      <div className={`num text-[1.375rem] leading-tight font-semibold tracking-tight ${valueClass}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{typeof sub === 'string' ? t(sub) : sub}</div>}
    </Card>
  );
}

// Baris label/nilai — dipakai di semua panel ringkasan.
export function KV({ label, children, className = '' }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-2 text-sm ${className}`}>
      <span className="shrink-0 text-muted">{t(label)}</span>
      <span className="num min-w-0 text-end font-medium">{children}</span>
    </div>
  );
}

// Titik status: lebih tenang daripada chip berwarna yang diulang tiap baris.
export function Dot({ tone = 'default', title }) {
  const c = { success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning', accent: 'bg-accent', default: 'bg-muted' }[tone] || 'bg-muted';
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${c}`} title={title ? t(title) : undefined} />;
}

// Kotak kartu dengan judul — pola yang paling sering dipakai.
export function Panel({ title, desc, action, children, className = '', bodyClass = '' }) {
  return (
    // min-w-0: item grid default-nya min-width:auto, sehingga teks panjang di dalamnya
    // memaksa kartu melebar melewati layar HP.
    <Card className={`min-w-0 gap-0! p-0! ${className}`}>
      {(title || action) && (
        <div className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
          <div className="min-w-0 shrink-0">
            {title && <h2 className="text-sm font-semibold tracking-tight">{t(title)}</h2>}
            {desc && <p className="mt-0.5 text-xs text-muted">{t(desc)}</p>}
          </div>
          {/* max-w-full: di HP isi action (mis. dua Segmented) boleh membungkus, bukan menjebol kartu */}
          {action && <div className="max-w-full shrink-0">{action}</div>}
        </div>
      )}
      <div className={bodyClass.includes('p-0') ? bodyClass : `p-4 ${bodyClass}`}>{children}</div>
    </Card>
  );
}

export function Tag({ map, k, fallback }) {
  const v = map?.[k];
  return <Chip size="sm" variant="soft" color={v ? v[1] : 'default'} className="whitespace-nowrap">{v ? t(v[0]) : (fallback ?? k ?? '—')}</Chip>;
}

export function Empty({ title, sub }) {
  return (
    <EmptyState className="flex w-full flex-col items-center justify-center gap-2 py-10 text-center">
      <Inbox className="size-6 text-muted" strokeWidth={1.5} />
      <div className="text-sm font-medium">{t(title)}</div>
      {sub && <div className="max-w-sm text-sm text-muted">{t(sub)}</div>}
    </EmptyState>
  );
}

export function Loading({ text = 'Memuat…' }) {
  return <div className="flex items-center justify-center gap-3 py-12 text-sm text-muted"><Spinner size="sm" color="current" />{t(text)}</div>;
}

// Penanda "sedang mengambil data baru" untuk kepala panel. Tabel TIDAK pernah
// dikosongkan selama memuat ulang — data lama tetap terbaca sampai yang baru tiba,
// dan penanda ini yang memberi tahu bahwa angkanya sebentar lagi berganti. Kosong
// saat tidak memuat, supaya tidak jadi perabot yang selalu ada.
export function Refreshing({ loading, text = 'Memperbarui…' }) {
  if (!loading) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted" role="status">
      <Spinner size="sm" color="current" className="size-3" />{t(text)}
    </span>
  );
}

// Tombol perbarui + jam "terakhir dibaca". Satu paket dengan sengaja: tombol tanpa
// jam tidak bisa dipercaya — ditekan, angkanya sama, dan tidak ada cara tahu apakah
// memang belum berubah atau permintaannya hilang; jam tanpa tombol cuma memberi
// kabar basi tanpa jalan keluar.
//
// `at` adalah waktu server membaca chain, BUKAN waktu halaman mengambil data:
// memuat ulang halaman tiap detik tidak membuat angkanya lebih baru. Lewat 90 detik
// jamnya berubah kuning — di situ umur data sudah cukup untuk mengubah keputusan
// (harga bergerak, fee bertambah, posisi keluar rentang).
//
// `at` tidak dioper sama sekali = tabelnya tidak punya jam semacam itu (isinya dari
// basis data, bukan dari sinkron chain): tombol saja, tanpa jam yang mengaku-aku.
export function Refresh({ at, busy, onPress, label = 'Perbarui', stale = 90_000 }) {
  useTick(1000);
  const old = at ? Date.now() - at > stale : false;
  return (
    <span className="flex items-center gap-2">
      {at !== undefined && (
        <span className={`text-xs whitespace-nowrap ${old ? 'text-warning' : 'text-muted'}`}
          title={at ? new Date(at).toLocaleString() : undefined}>
          {at ? t('diperbarui {n}', { n: ago(at) }) : t('belum terbaca')}
        </span>
      )}
      <Button size="sm" variant="tertiary" isPending={busy} isDisabled={busy} onPress={onPress}>
        <RefreshCw className="size-4" />{t(label)}
      </Button>
    </span>
  );
}

export function Notice({ status = 'default', title, children }) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        {title && <Alert.Title>{t(title)}</Alert.Title>}
        {children && <Alert.Description>{children}</Alert.Description>}
      </Alert.Content>
    </Alert>
  );
}

// Rentang harga posisi LP.
//
// Menampilkan HARGA sebenarnya, bukan lebar dalam persen: "lebar 530%" tidak
// memberi tahu di harga berapa posisi ini bekerja, apakah harga sekarang masih di
// dalamnya, dan seberapa dekat dengan tepi. Sumbu digambar logaritmik karena
// tick Uniswap linear terhadap log harga — jarak yang sama di layar berarti
// perubahan harga persen yang sama.
export function PriceRange({
  lo, hi, cur, entrySqrt, exitSqrt, dec0, dec1, quoteSide, symbol0, symbol1, showPrices = true,
}) {
  if (lo == null || hi == null) return <span className="text-muted">—</span>;
  // Rentang penuh (tick ±887272, dibulatkan ke tick spacing): harganya 3e-39 … 3e+38,
  // angka yang benar tapi tidak berarti apa-apa. Posisi seperti ini selalu in-range.
  if (lo <= -880000 && hi >= 880000) {
    const pE = sqrtPrice(entrySqrt, dec0, dec1, quoteSide), pX = sqrtPrice(exitSqrt, dec0, dec1, quoteSide);
    const mv = pE != null && pX != null ? (pX / pE - 1) * 100 : null;
    return (
      <div className="w-44 min-w-40 text-xs">
        <div className="font-medium">{t('Seluruh rentang')}</div>
        {/* tanpa tepi: pita memudar ke kedua sisi, bukan berhenti di satu harga */}
        <div className="relative mt-0.5 h-3.5">
          <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-linear-to-r from-transparent via-accent/40 to-transparent" />
        </div>
        {pE != null && <div className="num mt-1 whitespace-nowrap text-muted">
          {t('masuk {p}', { p: price(pE) })}
          {mv != null && <><span className="mx-1">·</span><span className={mv > 0.05 ? 'text-success' : mv < -0.05 ? 'text-danger' : ''}>{t('keluar ')}{pct(mv, 1)}</span></>}
        </div>}
      </div>
    );
  }
  const at = (t) => tickPrice(t, dec0, dec1, quoteSide);
  const a = at(lo), b = at(hi);
  const [pLo, pHi] = a <= b ? [a, b] : [b, a];
  if (!Number.isFinite(pLo) || !Number.isFinite(pHi) || pLo <= 0) return <span className="text-muted">—</span>;
  const quote = quoteSide === 0 ? symbol0 : quoteSide === 1 ? symbol1 : null;
  const base = quoteSide === 0 ? symbol1 : quoteSide === 1 ? symbol0 : null;

  const pEntry = sqrtPrice(entrySqrt, dec0, dec1, quoteSide);
  const pExit = sqrtPrice(exitSqrt, dec0, dec1, quoteSide);
  const pNow = pExit ?? (cur != null ? at(cur) : null);   // posisi tertutup: harga saat keluar
  const closed = pExit != null;

  // Sumbu logaritmik: rentang + bantalan, diperlebar bila harga masuk/kini ada di luar
  // rentang supaya penandanya tetap terlihat, bukan menempel di tepi.
  const L = Math.log;
  const pts = [pLo, pHi, pEntry, pNow].filter((x) => x != null && x > 0);
  const dataLo = Math.min(...pts), dataHi = Math.max(...pts);
  const pad = (L(pHi) - L(pLo) || 1) * 0.5;
  const min = Math.min(L(pLo) - pad, L(dataLo) - pad * 0.4);
  const max = Math.max(L(pHi) + pad, L(dataHi) + pad * 0.4);
  const at100 = (p) => Math.max(0, Math.min(100, ((L(p) - min) / (max - min)) * 100));

  const inRange = pNow != null && pNow >= pLo && pNow <= pHi;
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  // Posisi tertutup atau tanpa harga kini: status in/out tidak berlaku, pita netral.
  const band = closed || pNow == null ? 'bg-accent/25 border-accent'
    : inRange ? 'bg-success/25 border-success' : 'bg-warning/20 border-warning';

  // Jarak ke tepi terdekat = berapa persen harga harus bergerak sebelum posisi
  // berhenti menghasilkan fee.
  let edge = null;
  const cap = (x) => (x >= 1000 ? '999+' : x.toFixed(0));
  if (!closed && pNow != null) {
    if (inRange) {
      const toLo = (pNow / pLo - 1) * 100, toHi = (pHi / pNow - 1) * 100;
      edge = <span className="text-success">{t(toLo < toHi ? 'di dalam · {n}% ke tepi bawah' : 'di dalam · {n}% ke tepi atas', { n: cap(Math.min(toLo, toHi)) })}</span>;
    } else {
      const off = pNow < pLo ? (pLo / pNow - 1) * 100 : (pNow / pHi - 1) * 100;
      edge = <span className="text-warning">{t(pNow < pLo ? 'di luar · {n}% di bawah' : 'di luar · {n}% di atas', { n: cap(off) })}</span>;
    }
  }

  const title = [
    t('Rentang {lo} – {hi}{q} per {b}', { lo: price(pLo), hi: price(pHi), q: quote ? ' ' + quote : '', b: base || '—' }),
    pEntry != null ? t('Harga masuk {p}', { p: price(pEntry) }) : null,
    pNow != null ? t(closed ? 'Harga keluar {p}{m}' : 'Harga kini {p}{m}', { p: price(pNow), m: move != null ? ` (${pct(move, 1)})` : '' }) : null,
    t('Lebar {w}% ({x}×) · tick {lo} … {hi}', { w: widthPct(lo, hi).toFixed(0), x: (pHi / pLo).toFixed(2), lo, hi }),
  ].filter(Boolean).join('\n');

  return (
    <div className="w-44 min-w-40" title={title}>
      {showPrices && (
        <div className="num mb-0.5 text-xs whitespace-nowrap">
          {price(pLo)} <span className="text-muted">–</span> {price(pHi)}
          {quote && <span className="ml-1 text-muted">{quote}</span>}
        </div>
      )}
      {/* Jalur tipis = seluruh sumbu; pita tebal bertepi = rentang posisi, diwarnai
          statusnya supaya in/out terbaca sebelum teksnya. Penanda dipusatkan pada
          harganya (-translate-x-1/2), bukan menempel dengan tepi kirinya. */}
      <div className="relative h-3.5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-default" />
        <div className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[1px] border-x-2 ${band}`}
          style={{ left: `${at100(pLo)}%`, width: `${Math.max(2, at100(pHi) - at100(pLo))}%` }} />
        {/* masuk: garis tipis & redup; kini/keluar: titik tegas berbingkai warna kartu */}
        {pEntry != null && <div className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-muted" style={{ left: `${at100(pEntry)}%` }} title={t('harga masuk')} />}
        {pNow != null && <div className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-surface" style={{ left: `${at100(pNow)}%` }} title={t(closed ? 'harga keluar' : 'harga kini')} />}
      </div>
      {pEntry != null && (
        <div className="num mt-0.5 text-xs whitespace-nowrap text-muted">
          {t('masuk {p}', { p: price(pEntry) })}
          {move != null && <>
            <span className="mx-1 text-muted">·</span>
            {/* pool yang disapu kosong bisa menaruh harga di tick maksimum — +1e19% tidak
                memberi tahu apa-apa selain "jauh"; dibatasi seperti jarak ke tepi */}
            <span className={move > 0.05 ? 'text-success' : move < -0.05 ? 'text-danger' : ''}>
              {closed ? t('keluar ') : ''}{move >= 1000 ? '+999+%' : pct(move, 1)}</span>
          </>}
        </div>
      )}
      {edge && <div className="mt-0.5 text-xs">{edge}</div>}
    </div>
  );
}

// Tabel data: menyortir, mencari, dan membagi halaman sendiri.
//
// Kolom: { key, label, align, className, render, sort, search, sortable:false }
//  - sort   : (row) => nilai pembanding (angka/teks). Default: pakai row[key].
//  - search : (row) => teks yang ikut dicari. Default: hasil sort kalau berupa teks.
// Semua tabel memakai komponen ini, jadi perilakunya seragam di seluruh dasbor.
const cmp = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;              // kosong selalu di bawah, di kedua arah
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
const valOf = (c, r) => (c.sort ? c.sort(r) : r[c.key]);

export function DataTable({
  label, columns, rows, rowKey, empty, dense, footer,
  searchable, pageSize = 0, defaultSort, onRow,
}) {
  const [sort, setSort] = useState(defaultSort || null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const searchCols = columns.filter((c) => c.search || (c.sortable !== false && typeof valOf(c, rows[0] || {}) === 'string'));
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => searchCols.some((c) => {
      const v = c.search ? c.search(r) : valOf(c, r);
      return v != null && String(v).toLowerCase().includes(needle);
    }));
  }, [rows, q]);

  const sorted = useMemo(() => {
    if (!sort?.column) return filtered;
    const col = columns.find((c) => c.key === sort.column);
    if (!col) return filtered;
    const dir = sort.direction === 'descending' ? -1 : 1;
    return [...filtered].sort((a, b) => cmp(valOf(col, a), valOf(col, b)) * dir);
  }, [filtered, sort, columns]);

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const cur = Math.min(page, pages);
  const view = pageSize ? sorted.slice((cur - 1) * pageSize, cur * pageSize) : sorted;

  // Menyaring atau menyortir mengubah isi halaman — kembali ke halaman pertama.
  useEffect(() => { setPage(1); }, [q, sort?.column, sort?.direction, rows.length]);

  // Kotak cari di atas tabel berisi 2 baris cuma perabot kosong; muncul setelah
  // daftarnya cukup panjang untuk benar-benar perlu disaring.
  const bisaCari = searchable && rows.length >= 8;
  const head = rows.length > 0 && (bisaCari || (pageSize > 0 && rows.length > pageSize));
  return (
    <div>
      {head && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          {bisaCari ? (
            <div className="relative w-full max-w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input variant="secondary" className="pl-8" value={q} aria-label={t('Cari')}
                placeholder={t('Cari…')} onChange={(e) => setQ(e.target.value)} />
            </div>
          ) : <span />}
          <span className="text-sm text-muted">
            {q ? t('{n} dari {total} baris', { n: sorted.length, total: rows.length }) : t('{n} baris', { n: rows.length })}
          </span>
        </div>
      )}
      <Table variant="secondary">
        <Table.ScrollContainer>
          {/* onRow: seluruh baris bisa diklik (mis. membuka laci riwayat). Tombol dan
              tautan di dalam sel tetap bekerja sendiri — react-aria menghentikan
              tekanan bersarang sebelum sampai ke baris. */}
          <Table.Content aria-label={t(label)} className="min-w-[640px]"
            sortDescriptor={sort || undefined} onSortChange={setSort}
            onRowAction={onRow ? (key) => { const r = rows.find((x, i) => String(rowKey ? rowKey(x, i) : i) === String(key)); if (r) onRow(r); } : undefined}>
            <Table.Header>
              {columns.map((c, i) => {
                const canSort = c.sortable !== false && !!c.key;
                // Kepala kolom sortable bawaan HeroUI adalah flex space-between, jadi
                // text-end di <th> tidak berpengaruh; rata kanan diatur di span-nya.
                return (
                  <Table.Column key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting={canSort}
                    className={c.align === 'end' ? 'text-end' : ''}>
                    {canSort
                      ? ({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}
                          className={`gap-1 ${c.align === 'end' ? 'justify-end' : 'justify-start'}`}>
                          {t(c.label)}
                        </Table.SortableColumnHeader>)
                      : t(c.label)}
                  </Table.Column>
                );
              })}
            </Table.Header>
            <Table.Body renderEmptyState={() => (q ? <Empty title="Tidak ada yang cocok" sub="Coba kata kunci lain." /> : empty || <Empty title="Belum ada data" />)}>
              {view.map((r, i) => (
                <Table.Row key={rowKey ? rowKey(r, i) : i} id={rowKey ? rowKey(r, i) : i} className={onRow ? 'cursor-pointer' : ''}>
                  {columns.map((c) => (
                    <Table.Cell key={c.key} className={`${c.align === 'end' ? 'text-end num' : ''} ${dense ? 'py-2' : ''} ${c.className || ''}`}>
                      {c.render ? c.render(r) : r[c.key]}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {footer && rows.length > 0 && (
        <div className="border-t border-border px-4 py-2.5 text-sm">{footer}</div>
      )}
      {pageSize > 0 && pages > 1 && (
        <div className="border-t border-border px-4 py-3">
          <Pager page={cur} pages={pages} total={sorted.length} pageSize={pageSize} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

function Pager({ page, pages, total, pageSize, onChange }) {
  const nums = [];
  if (pages <= 7) for (let i = 1; i <= pages; i++) nums.push(i);
  else {
    nums.push(1);
    if (page > 3) nums.push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) nums.push(i);
    if (page < pages - 2) nums.push('…');
    nums.push(pages);
  }
  return (
    <Pagination>
      <Pagination.Summary>
        {t('Baris {a}–{b} dari {n}', { a: (page - 1) * pageSize + 1, b: Math.min(page * pageSize, total), n: total })}
      </Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous isDisabled={page === 1} onPress={() => onChange(page - 1)}>
            <Pagination.PreviousIcon /><span className="hidden sm:inline">{t('Sebelumnya')}</span>
          </Pagination.Previous>
        </Pagination.Item>
        {nums.map((p, i) => (
          <Pagination.Item key={p === '…' ? `e${i}` : p}>
            {p === '…' ? <Pagination.Ellipsis />
              : <Pagination.Link isActive={p === page} onPress={() => onChange(p)}>{p}</Pagination.Link>}
          </Pagination.Item>
        ))}
        <Pagination.Item>
          <Pagination.Next isDisabled={page === pages} onPress={() => onChange(page + 1)}>
            <span className="hidden sm:inline">{t('Berikutnya')}</span><Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  );
}

// ---- field form ----
export function Text({ label, value, onChange, placeholder, hint, type = 'text', mono, isInvalid, isDisabled, error, autoComplete, className = '', aria, step }) {
  return (
    <TextField value={value ?? ''} onChange={onChange} type={type} isInvalid={isInvalid} isDisabled={isDisabled} aria-label={aria ? t(aria) : undefined} className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{t(label)}</Label>}
      {/* variant="secondary": varian HeroUI untuk field di dalam Card/Surface. Varian bawaan
          (primary) berwarna sama persis dengan kartu dan tanpa garis tepi — tidak terlihat. */}
      <Input step={type === 'number' ? (step ?? 'any') : undefined} variant="secondary" placeholder={placeholder && t(placeholder)} autoComplete={autoComplete} className={mono ? 'mono' : type === 'number' ? 'num' : ''} />
      {isInvalid && error ? <Description className="text-danger">{t(error)}</Description> : hint && <Description>{t(hint)}</Description>}
    </TextField>
  );
}

// `aria` dipakai saat field sengaja tanpa label terlihat (mis. pemilih token di
// kartu swap, yang labelnya sudah dibawa judul kotaknya) — pembaca layar tetap
// butuh nama.
export function Pick({ label, value, onChange, options, hint, className = '', aria, isDisabled }) {
  return (
    <Select variant="secondary" isDisabled={isDisabled} value={value} onChange={(v) => onChange(v)} aria-label={aria ? t(aria) : undefined}
      className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{t(label)}</Label>}
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      {hint && <Description>{t(hint)}</Description>}
      <Select.Popover>
        <ListBox>
          {options.map(([id, text]) => (
            <ListBox.Item key={id} id={id} textValue={t(text)}>{t(text)}<ListBox.ItemIndicator /></ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function Toggle({ label, desc, value, onChange, isDisabled }) {
  return (
    // Switch.Content-lah elemen yang bisa diklik (ia yang membawa <input>); Switch
    // sendiri cuma pembungkus. Kalau Switch.Control ditaruh di luar Content, sakelarnya
    // tampak normal tapi mati. Description harus jadi saudara Content, bukan isinya.
    <Switch isSelected={!!value} onChange={onChange} isDisabled={isDisabled}>
      <Switch.Content>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <Label>{t(label)}</Label>
      </Switch.Content>
      {desc && <Description>{t(desc)}</Description>}
    </Switch>
  );
}

// ---- konfirmasi ----
// Pengganti window.confirm(): dialog bawaan browser tidak bisa diberi gaya, memuat
// nama domain di judulnya, dan di Safari menghentikan seluruh halaman. Pemakaian
// tetap satu baris: `if (!(await ask({ title, body, confirm, danger }))) return;`
// Teks sudah diterjemahkan oleh pemanggil.
let pushAsk = null;
export function ask(opts) {
  return new Promise((resolve) => {
    if (!pushAsk) return resolve(window.confirm(opts.title));
    pushAsk({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [q, setQ] = useState(null);
  const last = useRef(null);        // isi tetap tampil selama animasi menutup
  useEffect(() => { pushAsk = setQ; return () => { pushAsk = null; }; }, []);
  if (q) last.current = q;
  const v = q || last.current || {};
  const done = (ok) => { q?.resolve(ok); setQ(null); };
  return (
    <AlertDialog isOpen={!!q} onOpenChange={(o) => { if (!o) done(false); }}>
      <AlertDialog.Backdrop isDismissable isKeyboardDismissDisabled={false}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status={v.danger ? 'danger' : 'warning'} />
              <AlertDialog.Heading>{v.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            {v.body && <AlertDialog.Body><div className="text-sm text-muted">{v.body}</div></AlertDialog.Body>}
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => done(false)}>{t('Batal')}</Button>
              <Button variant={v.danger ? 'danger' : 'primary'} onPress={() => done(true)} autoFocus>{v.confirm || t('Ya, lanjutkan')}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

// Pilihan saling-eksklusif yang sedikit (2–6): semuanya terlihat sekaligus, satu
// klik, dan bisa membawa jumlah per pilihan — lebih cepat dibaca daripada dropdown.
// options: [[id, label, count?], ...]
export function Segmented({ value, onChange, options, aria, size = 'md' }) {
  const h = size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[0.8125rem]';
  return (
    <div role="radiogroup" aria-label={aria ? t(aria) : undefined}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-surface p-0.5">
      {options.map(([id, label, count]) => {
        const on = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onChange(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap transition-colors ${h}
              ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
            {t(label)}
            {count != null && <span className={`num text-[0.6875rem] ${on ? 'text-muted' : 'text-muted/80'}`}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Alamat pendek yang bisa diklik untuk disalin utuh.
export function CopyAddr({ address }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const id = setTimeout(() => setDone(false), 1500); return () => clearTimeout(id); }, [done]);
  const copy = async () => { try { await navigator.clipboard.writeText(address); setDone(true); } catch { /* izin clipboard ditolak */ } };
  return (
    <button type="button" onClick={copy} title={address} aria-label={t('Salin alamat')}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-muted transition-colors hover:bg-default hover:text-foreground">
      {short(address)}{done ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}

// Hash transaksi: tautan ke penjelajah blok + tombol salin. Dipakai laci riwayat
// posisi bot maupun laci riwayat posisi wallet yang diriset.
export function TxHash({ hash }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const id = setTimeout(() => setDone(false), 1500); return () => clearTimeout(id); }, [done]);
  if (!hash) return <span className="text-muted">—</span>;
  const copy = async () => { try { await navigator.clipboard.writeText(hash); setDone(true); } catch { /* izin clipboard ditolak */ } };
  return (
    <span className="inline-flex items-center gap-1">
      <a href={txHref(hash)} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-accent hover:underline">
        {short(hash)}<ExternalLink className="size-3" />
      </a>
      <button type="button" onClick={copy} className="text-muted hover:text-foreground" aria-label={t('Salin hash')}>
        {done ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

// "← Kembali" ke halaman sebelumnya; dibuka langsung dari tautan: ke `fallback`.
export function BackLink({ fallback = 'positions' }) {
  const back = (e) => {
    e.preventDefault();
    if (history.length > 1) history.back(); else location.hash = fallback;
  };
  return (
    <a href={'#' + fallback} onClick={back} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
      <ArrowLeft className="size-3.5" />{t('Kembali')}
    </a>
  );
}

// Tautan ke situs luar (DexScreener, GeckoTerminal, situs token), tab baru.
export function ExtLink({ href, muted, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className={`inline-flex items-center gap-1 hover:underline ${muted ? 'text-muted' : 'text-accent'}`}>{children} <ExternalLink className="size-3" /></a>
  );
}
