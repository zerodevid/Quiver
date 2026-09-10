// Komponen kecil yang dipakai berulang. Semuanya dirakit dari komponen HeroUI;
// tidak ada gaya visual baru di luar token tema HeroUI.
import { useEffect, useMemo, useState } from 'react';
import {
  Card, Chip, EmptyState, Label, Description, TextField, Input, Select, ListBox,
  Switch, Table, Spinner, Alert, Pagination,
} from '@heroui/react';
import { Inbox, Search } from 'lucide-react';
import { price, tickPrice, sqrtPrice, widthPct, pct } from '../fmt';
import { translate as t } from '../i18n';

export function PageHeader({ group, title, desc, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-muted">{t(group)}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t(title)}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-muted">{t(desc)}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, valueClass = '' }) {
  return (
    <Card className="min-w-0">
      <Card.Content className="gap-1">
        <div className="text-xs font-medium uppercase tracking-wider text-muted">{t(label)}</div>
        <div className={`num text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</div>
        {sub && <div className="text-sm text-muted">{typeof sub === 'string' ? t(sub) : sub}</div>}
      </Card.Content>
    </Card>
  );
}

// Kotak kartu dengan judul — pola yang paling sering dipakai.
export function Panel({ title, desc, action, children, className = '', bodyClass = '' }) {
  return (
    // min-w-0: item grid default-nya min-width:auto, sehingga teks panjang di dalamnya
    // memaksa kartu melebar melewati layar HP.
    <Card className={`min-w-0 ${className}`}>
      {(title || action) && (
        <Card.Header className="flex-row items-start justify-between gap-3">
          <div>
            {title && <Card.Title>{t(title)}</Card.Title>}
            {desc && <Card.Description>{t(desc)}</Card.Description>}
          </div>
          {action}
        </Card.Header>
      )}
      <Card.Content className={bodyClass}>{children}</Card.Content>
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

  // Jarak ke tepi terdekat = berapa persen harga harus bergerak sebelum posisi
  // berhenti menghasilkan fee.
  let edge = null;
  if (!closed && pNow != null) {
    if (inRange) {
      const toLo = (pNow / pLo - 1) * 100, toHi = (pHi / pNow - 1) * 100;
      edge = <span className="text-success">{t(toLo < toHi ? 'di dalam · {n}% ke tepi bawah' : 'di dalam · {n}% ke tepi atas', { n: Math.min(toLo, toHi).toFixed(0) })}</span>;
    } else {
      const off = pNow < pLo ? (pLo / pNow - 1) * 100 : (pNow / pHi - 1) * 100;
      edge = <span className="text-warning">{t(pNow < pLo ? 'di luar · {n}% di bawah' : 'di luar · {n}% di atas', { n: off.toFixed(0) })}</span>;
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
        <div className="num mb-1 text-xs whitespace-nowrap">
          {price(pLo)} <span className="text-muted">–</span> {price(pHi)}
          {quote && <span className="ml-1 text-muted">{quote}</span>}
        </div>
      )}
      <div className="relative h-1.5 rounded-full bg-default">
        <div className="absolute inset-y-0 rounded-full bg-accent/60"
          style={{ left: `${at100(pLo)}%`, width: `${Math.max(2, at100(pHi) - at100(pLo))}%` }} />
        {/* masuk: penanda tipis & redup; kini/keluar: penanda tegas */}
        {pEntry != null && <div className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-muted" style={{ left: `${at100(pEntry)}%` }} title={t('harga masuk')} />}
        {pNow != null && <div className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-foreground" style={{ left: `${at100(pNow)}%` }} title={t(closed ? 'harga keluar' : 'harga kini')} />}
      </div>
      {pEntry != null && (
        <div className="num mt-1 text-xs whitespace-nowrap text-muted">
          {t('masuk {p}', { p: price(pEntry) })}
          {move != null && <>
            <span className="mx-1 text-muted">·</span>
            <span className={move > 0.05 ? 'text-success' : move < -0.05 ? 'text-danger' : ''}>
              {closed ? t('keluar ') : ''}{pct(move, 1)}</span>
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
  searchable, pageSize = 0, defaultSort,
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

  const head = (searchable || pageSize) && rows.length > 0;
  return (
    <div>
      {head && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          {searchable ? (
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
          <Table.Content aria-label={t(label)} className="min-w-[640px]"
            sortDescriptor={sort || undefined} onSortChange={setSort}>
            <Table.Header>
              {columns.map((c, i) => {
                const canSort = c.sortable !== false && !!c.key;
                return (
                  <Table.Column key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting={canSort}
                    className={c.align === 'end' ? 'text-end' : ''}>
                    {canSort
                      ? ({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>{t(c.label)}</Table.SortableColumnHeader>)
                      : t(c.label)}
                  </Table.Column>
                );
              })}
            </Table.Header>
            <Table.Body renderEmptyState={() => (q ? <Empty title="Tidak ada yang cocok" sub="Coba kata kunci lain." /> : empty || <Empty title="Belum ada data" />)}>
              {view.map((r, i) => (
                <Table.Row key={rowKey ? rowKey(r, i) : i} id={rowKey ? rowKey(r, i) : i}>
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
export function Text({ label, value, onChange, placeholder, hint, type = 'text', mono, isInvalid, error, autoComplete, className = '' }) {
  return (
    <TextField value={value ?? ''} onChange={onChange} type={type} isInvalid={isInvalid} className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{t(label)}</Label>}
      {/* variant="secondary": varian HeroUI untuk field di dalam Card/Surface. Varian bawaan
          (primary) berwarna sama persis dengan kartu dan tanpa garis tepi — tidak terlihat. */}
      <Input variant="secondary" placeholder={placeholder && t(placeholder)} autoComplete={autoComplete} className={mono ? 'mono' : type === 'number' ? 'num' : ''} />
      {isInvalid && error ? <Description className="text-danger">{t(error)}</Description> : hint && <Description>{t(hint)}</Description>}
    </TextField>
  );
}

export function Pick({ label, value, onChange, options, hint, className = '' }) {
  return (
    <Select variant="secondary" value={value} onChange={(v) => onChange(v)} className={`flex flex-col gap-1 ${className}`}>
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
    <Switch isSelected={!!value} onChange={onChange} isDisabled={isDisabled}>
      <Switch.Control><Switch.Thumb /></Switch.Control>
      <Switch.Content>
        <Label>{t(label)}</Label>
        {desc && <Description>{t(desc)}</Description>}
      </Switch.Content>
    </Switch>
  );
}
