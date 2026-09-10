// Komponen kecil yang dipakai berulang. Semuanya dirakit dari komponen HeroUI;
// tidak ada gaya visual baru di luar token tema HeroUI.
import {
  Card, Chip, EmptyState, Label, Description, TextField, Input, Select, ListBox,
  Switch, Table, Spinner, Alert,
} from '@heroui/react';
import { Inbox } from 'lucide-react';
import { price, tickPrice, sqrtPrice, widthPct, pct } from '../fmt';

export function PageHeader({ group, title, desc, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-muted">{group}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-muted">{desc}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, valueClass = '' }) {
  return (
    <Card className="min-w-0">
      <Card.Content className="gap-1">
        <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
        <div className={`num text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</div>
        {sub && <div className="text-sm text-muted">{sub}</div>}
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
            {title && <Card.Title>{title}</Card.Title>}
            {desc && <Card.Description>{desc}</Card.Description>}
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
  return <Chip size="sm" variant="soft" color={v ? v[1] : 'default'} className="whitespace-nowrap">{v ? v[0] : (fallback ?? k ?? '—')}</Chip>;
}

export function Empty({ title, sub }) {
  return (
    <EmptyState className="flex w-full flex-col items-center justify-center gap-2 py-10 text-center">
      <Inbox className="size-6 text-muted" strokeWidth={1.5} />
      <div className="text-sm font-medium">{title}</div>
      {sub && <div className="max-w-sm text-sm text-muted">{sub}</div>}
    </EmptyState>
  );
}

export function Loading({ text = 'Memuat…' }) {
  return <div className="flex items-center justify-center gap-3 py-12 text-sm text-muted"><Spinner size="sm" color="current" />{text}</div>;
}

export function Notice({ status = 'default', title, children }) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        {title && <Alert.Title>{title}</Alert.Title>}
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
      edge = <span className="text-success">di dalam · {Math.min(toLo, toHi).toFixed(0)}% ke tepi {toLo < toHi ? 'bawah' : 'atas'}</span>;
    } else {
      const off = pNow < pLo ? (pLo / pNow - 1) * 100 : (pNow / pHi - 1) * 100;
      edge = <span className="text-warning">di luar · {off.toFixed(0)}% {pNow < pLo ? 'di bawah' : 'di atas'}</span>;
    }
  }

  const title = [
    `Rentang ${price(pLo)} – ${price(pHi)}${quote ? ' ' + quote : ''}${base ? ' per ' + base : ''}`,
    pEntry != null ? `Harga masuk ${price(pEntry)}` : null,
    pNow != null ? `Harga ${closed ? 'keluar' : 'kini'} ${price(pNow)}${move != null ? ` (${pct(move, 1)})` : ''}` : null,
    `Lebar ${widthPct(lo, hi).toFixed(0)}% (${(pHi / pLo).toFixed(2)}×) · tick ${lo} … ${hi}`,
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
        {pEntry != null && <div className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-muted" style={{ left: `${at100(pEntry)}%` }} title="harga masuk" />}
        {pNow != null && <div className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-foreground" style={{ left: `${at100(pNow)}%` }} title={closed ? 'harga keluar' : 'harga kini'} />}
      </div>
      {pEntry != null && (
        <div className="num mt-1 text-xs whitespace-nowrap text-muted">
          masuk {price(pEntry)}
          {move != null && <>
            <span className="mx-1 text-muted">·</span>
            <span className={move > 0.05 ? 'text-success' : move < -0.05 ? 'text-danger' : ''}>
              {closed ? 'keluar ' : ''}{pct(move, 1)}</span>
          </>}
        </div>
      )}
      {edge && <div className="mt-0.5 text-xs">{edge}</div>}
    </div>
  );
}

// Tabel data: kolom = [{key,label,align,className,render}]
export function DataTable({ label, columns, rows, rowKey, empty, dense, footer }) {
  return (
    <Table variant="secondary">
      <Table.ScrollContainer>
        <Table.Content aria-label={label} className="min-w-[640px]">
          <Table.Header>
            {columns.map((c, i) => (
              <Table.Column key={c.key} id={c.key} isRowHeader={i === 0} className={c.align === 'end' ? 'text-end' : ''}>
                {c.label}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body renderEmptyState={() => empty || <Empty title="Belum ada data" />}>
            {rows.map((r, i) => (
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
      {footer && rows.length > 0 && (
        <div className="border-t border-border px-4 py-2.5 text-sm">{footer}</div>
      )}
    </Table>
  );
}

// ---- field form ----
export function Text({ label, value, onChange, placeholder, hint, type = 'text', mono, isInvalid, error, autoComplete, className = '' }) {
  return (
    <TextField value={value ?? ''} onChange={onChange} type={type} isInvalid={isInvalid} className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{label}</Label>}
      {/* variant="secondary": varian HeroUI untuk field di dalam Card/Surface. Varian bawaan
          (primary) berwarna sama persis dengan kartu dan tanpa garis tepi — tidak terlihat. */}
      <Input variant="secondary" placeholder={placeholder} autoComplete={autoComplete} className={mono ? 'mono' : type === 'number' ? 'num' : ''} />
      {isInvalid && error ? <Description className="text-danger">{error}</Description> : hint && <Description>{hint}</Description>}
    </TextField>
  );
}

export function Pick({ label, value, onChange, options, hint, className = '' }) {
  return (
    <Select variant="secondary" value={value} onChange={(v) => onChange(v)} className={`flex flex-col gap-1 ${className}`}>
      {label && <Label>{label}</Label>}
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      {hint && <Description>{hint}</Description>}
      <Select.Popover>
        <ListBox>
          {options.map(([id, text]) => (
            <ListBox.Item key={id} id={id} textValue={text}>{text}<ListBox.ItemIndicator /></ListBox.Item>
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
        <Label>{label}</Label>
        {desc && <Description>{desc}</Description>}
      </Switch.Content>
    </Switch>
  );
}
