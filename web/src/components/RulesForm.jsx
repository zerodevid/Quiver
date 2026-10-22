import { useId, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { ChevronDown, Ruler, MoveHorizontal, ArrowRightToLine, RefreshCw, LogOut, Filter, ShieldAlert } from 'lucide-react';
import { SCHEMA, RULE_HELP } from '../rulesSchema';
import { Text, Pick, Toggle } from './ui';
import SettingInfo from './SettingInfo';
import { useI18n } from '../i18n';

const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function put(o, p, v) {
  const next = structuredClone(o);
  const ks = p.split('.'); const last = ks.pop();
  let c = next; for (const k of ks) c = (c[k] = c[k] || {});
  c[last] = v;
  return next;
}
const GROUPS = [
  [Ruler, 'Tentukan modal dan batas pengeluaran.'],
  [MoveHorizontal, 'Atur rentang harga posisi salinan.'],
  [ArrowRightToLine, 'Pilih tindakan saat posisi hanya berisi satu token.'],
  [RefreshCw, 'Siapkan token yang dibutuhkan secara otomatis.'],
  [LogOut, 'Tentukan kapan posisi ditutup dan token sisa dijual.'],
  [Filter, 'Batasi pool dan token yang boleh disalin.'],
  [ShieldAlert, 'Penjaga dari token jebakan: panduan, preset, dan rekomendasi tiap kolom.'],
];

// Shared by default rules and per-target rules; collapsed fields keep their values.
export default function RulesForm({ value, onChange, isDisabled = false }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(() => new Set([0, SCHEMA.length - 1]));
  const [query, setQuery] = useState('');
  if (!value) return null;
  const applyPreset = (preset) => onChange(Object.entries(preset.values).reduce((acc, [path, v]) => put(acc, path, v), value));
  const search = query.trim().toLocaleLowerCase();
  const groups = SCHEMA.map((g, gi) => ({ ...g, gi, fields: g.fields.filter((f) => (!f.when || f.when(value)) &&
    (!search || [g.group, f.label, RULE_HELP[f.path] || f.help || ''].some((text) => t(text).toLocaleLowerCase().includes(search)))) })).filter((g) => g.fields.length);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Text label="Cari pengaturan aturan" placeholder="Misalnya: slippage, modal, keluar…" value={query} onChange={setQuery} className="w-full sm:max-w-sm" />
        <Button variant="ghost" onPress={() => setOpen(open.size === SCHEMA.length ? new Set() : new Set(SCHEMA.map((_, i) => i)))}>
          {t(open.size === SCHEMA.length ? 'Tutup semua bagian' : 'Buka semua bagian')}
        </Button>
      </div>
      <p className="text-sm text-muted">{t('Klik ikon i untuk penjelasan dan contoh. Opsi tambahan muncul sesuai pilihanmu.')}</p>
      {!groups.length && <div role="status" className="rounded-xl border border-border p-6 text-center"><p>{t('Tidak ada pengaturan yang cocok.')}</p><Button variant="ghost" onPress={() => setQuery('')}>{t('Hapus pencarian')}</Button></div>}
      {groups.map((g) => {
        const [Icon, desc] = GROUPS[g.gi];
        const expanded = !!search || open.has(g.gi);
        return <section key={g.group} className="overflow-hidden rounded-xl border border-border">
          <h3><button type="button" aria-expanded={expanded} aria-controls={`${id}-${g.gi}`} onClick={() => {
            setOpen((prev) => { const next = new Set(prev); if (next.has(g.gi)) next.delete(g.gi); else next.add(g.gi); return next; });
          }} className="flex w-full items-center gap-3 bg-surface-secondary/40 p-4 text-left outline-offset-[-3px] hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-accent">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface"><Icon className="size-5" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block font-semibold">{t(g.group)}</span><span className="mt-1 block text-sm font-normal text-muted">{t(desc)}</span></span>
            <ChevronDown aria-hidden="true" className={`size-4 shrink-0 ${expanded ? 'rotate-180' : ''}`} />
          </button></h3>
          <div id={`${id}-${g.gi}`} hidden={!expanded}>
            {g.guide && <AntiRugGuide guide={g.guide} presets={g.presets} value={value} onApply={applyPreset} isDisabled={isDisabled} />}
            <div className="grid gap-4 border-t border-border p-4 md:grid-cols-2">
              {g.fields.map((f) => {
                const v = dig(value, f.path);
                const set = (nv) => onChange(put(value, f.path, nv));
                const help = RULE_HELP[f.path] || f.help;
                const percent = f.path === 'filters.max_fee_bps' ? Number(v) / 10000 : f.path.endsWith('_bps') ? Number(v) / 100 : null;
                return <div key={f.path} className="min-w-0 rounded-lg border border-border p-3">
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      {f.type === 'select' ? <Pick label={f.label} value={v} onChange={set} options={f.options} isDisabled={isDisabled} />
                        : f.type === 'bool' ? <Toggle label={f.label} value={v} onChange={set} isDisabled={isDisabled} />
                        : f.type === 'list' ? <RuleList label={f.label} value={v} onChange={set} isDisabled={isDisabled} />
                        : <Text label={f.label} type="number" step={f.step} value={String(v ?? 0)} onChange={(text) => set(text === '' ? 0 : Number(text))} isDisabled={isDisabled} />}
                    </div>
                    {help && <SettingInfo title={f.label}>{help}</SettingInfo>}
                  </div>
                  {f.rec && <Recommendation field={f} value={v} onUse={set} isDisabled={isDisabled} />}
                  {f.type === 'bool' && <div className="mt-2"><Chip size="sm" variant="soft" color={v ? 'accent' : 'default'}>{t(v ? 'Aktif' : 'Nonaktif')}</Chip></div>}
                  {percent != null && Number.isFinite(percent) && <p className="mt-2 text-xs text-muted">{t('Setara {n}%', { n: percent })}</p>}
                  {f.label.includes('0=mati') && <p className="mt-2 text-xs text-muted">{t('0 = nonaktif')}</p>}
                </div>;
              })}
            </div>
          </div>
        </section>;
      })}
    </div>
  );
}

// Preserve separators while typing while keeping the parent value ready to save.
function RuleList({ label, value, onChange, isDisabled }) {
  const [draft, setDraft] = useState(null);
  return <div onBlur={() => { if (draft !== null) { onChange(draft.split(',').map((x) => x.trim()).filter(Boolean)); setDraft(null); } }}>
    <Text label={label} mono value={draft ?? (value || []).join(', ')} onChange={(text) => { setDraft(text); onChange(text.split(',').map((x) => x.trim()).filter(Boolean)); }} isDisabled={isDisabled} />
  </div>;
}

// Guide for the anti-rug section: how the scam works, how to use the section, the presets, and the limits.
function AntiRugGuide({ guide, presets, value, onApply, isDisabled }) {
  const { t } = useI18n();
  const isActive = (preset) => Object.entries(preset.values).every(([path, v]) => dig(value, path) === v);
  return <div className="flex flex-col gap-4 border-t border-border p-4">
    <p className="text-sm leading-relaxed">{t(guide.intro)}</p>
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <h4 className="text-sm font-semibold">{t('Pola yang dipakai penipu')}</h4>
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {guide.patterns.map(([title, text]) => <li key={title}><span className="font-medium">{t(title)}.</span> <span className="text-muted">{t(text)}</span></li>)}
        </ul>
      </div>
      <div>
        <h4 className="text-sm font-semibold">{t('Cara memakai bagian ini')}</h4>
        <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm text-muted">
          {guide.steps.map((step) => <li key={step}>{t(step)}</li>)}
        </ol>
      </div>
    </div>
    <div>
      <h4 className="text-sm font-semibold">{t('Preset')}</h4>
      <p className="mt-1 text-xs text-muted">{t('Preset hanya menulis kolom anti rug di bawah. Ukuran posisi dan anggaran tidak diubah.')}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {presets.map((preset) => <div key={preset.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2"><span className="font-medium">{t(preset.label)}</span>{isActive(preset) && <Chip size="sm" variant="soft" color="accent">{t('Sedang dipakai')}</Chip>}</div>
          <p className="text-xs text-muted">{t(preset.desc)}</p>
          <Button size="sm" variant="outline" onPress={() => onApply(preset)} isDisabled={isDisabled}>{t('Terapkan')}</Button>
        </div>)}
      </div>
    </div>
    <div className="rounded-lg border border-border bg-surface-secondary/40 p-3">
      <h4 className="text-sm font-semibold">{t('Batasan yang perlu diketahui')}</h4>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
        {guide.limits.map((text) => <li key={text}>{t(text)}</li>)}
      </ul>
    </div>
  </div>;
}

// Recommended value for one field, with the reason, and a button to apply it. List fields only show text:
// applying would overwrite what the user has typed.
function Recommendation({ field, value, onUse, isDisabled }) {
  const { t } = useI18n();
  const hasValue = 'value' in field.rec;
  const matches = hasValue && value === field.rec.value;
  return <div className="mt-2 rounded-md bg-surface-secondary/50 p-2 text-xs">
    <p className="flex flex-wrap items-center gap-2"><span><span className="font-semibold">{t('Rekomendasi')}:</span> {t(field.rec.label)}</span>
      {matches && <Chip size="sm" variant="soft" color="success">{t('Sesuai rekomendasi')}</Chip>}</p>
    <p className="mt-1 text-muted">{t(field.why)}</p>
    {hasValue && !matches && <Button size="sm" variant="ghost" className="mt-1" onPress={() => onUse(field.rec.value)} isDisabled={isDisabled}>{t('Pakai rekomendasi')}</Button>}
  </div>;
}
