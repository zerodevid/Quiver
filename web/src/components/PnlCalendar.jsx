// Kalender PnL harian. Dipakai riset wallet (PnL wallet orang lain) dan Ringkasan
// (PnL posisi kita) — satu tampilan supaya keduanya dibaca dengan cara yang sama.
//
// daily  : { 'YYYY-MM-DD': pnl }
// counts : { 'YYYY-MM-DD': jumlah posisi ditutup } — opsional
import { useState } from 'react';
import { Button } from '@heroui/react';
import { Empty } from './ui';
import { usd, kUsd, tone } from '../fmt';
import { useI18n } from '../i18n';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// onShare(key, pnl, count): hari yang punya PnL bisa diklik (mis. membuat kartu bagikan).
export default function PnlCalendar({ daily, counts, empty = 'Belum ada posisi tertutup di jendela ini', onShare }) {
  const { t, locale } = useI18n();
  const days = Object.keys(daily).sort();
  // Hook harus dipanggil sebelum return bersyarat (aturan hooks React).
  const [ym, setYm] = useState(() => {
    const last = days.length ? new Date(days[days.length - 1] + 'T00:00:00') : new Date();
    return [last.getFullYear(), last.getMonth()];
  });
  if (!days.length) return <Empty title={empty} />;
  const [y, mo] = ym;
  const first = new Date(y, mo, 1), lastDay = new Date(y, mo + 1, 0).getDate();
  const prefix = `${y}-${pad(mo + 1)}`;
  const inMonth = Object.entries(daily).filter(([k]) => k.startsWith(prefix));
  const total = inMonth.reduce((a, [, v]) => a + v, 0);
  const green = inMonth.filter(([, v]) => v > 0.005).length, red = inMonth.filter(([, v]) => v < -0.005).length;
  const shift = (n) => { const d = new Date(y, mo + n, 1); setYm([d.getFullYear(), d.getMonth()]); };
  const today = keyOf(new Date());
  // Kekuatan warna mengikuti besarnya PnL (akar, supaya hari kecil tetap terlihat):
  // $5 dan $113 tidak lagi sama hijaunya. Skala per bulan yang sedang dilihat.
  const maxAbs = Math.max(1e-9, ...inMonth.map(([, v]) => Math.abs(v)));
  const shade = (v) => {
    if (v == null || Math.abs(v) <= 0.005) return undefined;
    const k = Math.sqrt(Math.min(1, Math.abs(v) / maxAbs));
    const c = v > 0 ? 'var(--success)' : 'var(--danger)';
    return { background: `color-mix(in oklab, ${c} ${Math.round(8 + 30 * k)}%, transparent)`,
      borderColor: `color-mix(in oklab, ${c} ${Math.round(22 + 38 * k)}%, transparent)` };
  };
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(<div key={'e' + i} />);
  for (let d = 1; d <= lastDay; d++) {
    const k = `${prefix}-${pad(d)}`;
    const v = daily[k], n = counts?.[k];
    const clickable = onShare && v != null;
    cells.push(
      <div key={d} title={v != null ? `${usd(v)}${n ? ' · ' + t('{n} posisi', { n }) : ''}${clickable ? ' · ' + t('klik untuk bagikan') : ''}` : undefined}
        role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onShare(k, v, n) : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShare(k, v, n); } } : undefined}
        style={shade(v)}
        className={`flex min-h-14 flex-col justify-between rounded-md border p-1.5 h-full transition-shadow ${clickable ? 'cursor-pointer hover:ring-1 hover:ring-foreground/50 focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:outline-none' : ''} ${v == null ? 'border-border/60'
          : Math.abs(v) <= 0.005 ? 'border-border bg-default/50' : ''}
          ${k === today ? 'ring-1 ring-foreground/40' : ''}`}>
        <span className="flex items-center justify-between text-[0.6875rem] text-muted">
          <span className={k === today ? 'font-semibold text-foreground' : ''}>{d}</span>
          {/* di HP sel terlalu sempit untuk angka + jumlah posisi; jumlahnya ada di tooltip */}
          {n > 1 && <span className="num hidden sm:inline">×{n}</span>}
        </span>
        {v != null && <span className={`num truncate text-[0.6875rem] font-semibold ${tone(v)}`}>
          <span className="hidden sm:inline">{kUsd(v)}</span>
          {/* HP: dibulatkan tanpa sen supaya muat di sel ±45px */}
          <span className="sm:hidden">{Math.abs(v) >= 10 ? usd(v, 0) : usd(v, 1)}</span>
        </span>}
      </div>,
    );
  }
  // Baris minggu ikut meregang kalau panelnya lebih tinggi (disejajarkan dengan kolom
  // sebelah) — tidak menyisakan ruang kosong di bawah legenda.
  const weeks = Math.ceil((first.getDay() + lastDay) / 7);
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Bulan sebelumnya')} onPress={() => shift(-1)}>‹</Button>
          <span className="w-36 text-center text-sm font-medium">{first.toLocaleDateString(locale === 'en' ? 'en-US' : 'id-ID', { month: 'long', year: 'numeric' })}</span>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Bulan berikutnya')} onPress={() => shift(1)}>›</Button>
        </div>
        <span className="text-sm text-muted">
          {(green > 0 || red > 0) && <span className="mr-3 text-xs">{t('{g} hari hijau · {r} merah', { g: green, r: red })}</span>}
          {t('Total bulan ini')} <span className={`num font-medium ${tone(total)}`}>{usd(total)}</span>
        </span>
      </div>
      <div className="grid flex-1 grid-cols-7 gap-1" style={{ gridTemplateRows: `auto repeat(${weeks}, minmax(3.5rem, 1fr))` }}>
        {(locale === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'])
          .map((n) => <div key={n} className="pb-1 text-center text-xs text-muted">{n}</div>)}
        {cells}
      </div>
      {(green > 0 || red > 0) && (
        // Legenda skala: rugi besar ← nol → untung besar
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[0.6875rem] text-muted" aria-hidden="true">
          <span>{t('Rugi')}</span>
          {[38, 20, 8].map((a) => <span key={'d' + a} className="size-3 rounded-sm" style={{ background: `color-mix(in oklab, var(--danger) ${a}%, transparent)` }} />)}
          <span className="size-3 rounded-sm border border-border bg-default/50" />
          {[8, 20, 38].map((a) => <span key={'u' + a} className="size-3 rounded-sm" style={{ background: `color-mix(in oklab, var(--success) ${a}%, transparent)` }} />)}
          <span>{t('Untung')}</span>
        </div>
      )}
    </div>
  );
}
