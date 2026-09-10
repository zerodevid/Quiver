import { useState } from 'react';
import { Button, Card, Switch, toast } from '@heroui/react';
import { Trash2, SlidersHorizontal, Plus, ChevronRight, ArrowLeft, Copy, Pencil, Check as CheckIcon, X } from 'lucide-react';
import { usePoll } from '../hooks';
import { post } from '../api';
import { PageHeader, Panel, Text, Empty, Loading } from '../components/ui';
import RulesForm from '../components/RulesForm';
import WalletDetail from '../components/WalletDetail';
import { usd, kUsd, tone, ago } from '../fmt';
import { useI18n } from '../i18n';

// Editor aturan per-target — dipakai di kartu (dilipat) dan di halaman detail.
function TargetRules({ tg, onChanged }) {
  const { t } = useI18n();
  const [rules, setRules] = useState(tg.rulesResolved);
  const [saving, setSaving] = useState(false);
  const own = !!tg.rulesOwn;
  const save = async () => {
    setSaving(true);
    const r = await post('/api/targets/rules', { address: tg.address, rules });
    setSaving(false);
    r.ok ? toast.success(t('Aturan wallet ini tersimpan')) : toast.danger(r.error || t('Gagal'));
    onChanged();
  };
  const reset = async () => { await post('/api/targets/rules', { address: tg.address, rules: null }); toast.success(t('Kembali ke aturan default')); onChanged(); };
  return (
    <>
      <p className="mb-5 text-sm text-muted">{t('Aturan khusus wallet ini. Selama tidak diubah, aturan default yang dipakai.')}</p>
      <RulesForm value={rules} onChange={setRules} />
      <div className="mt-6 flex justify-end gap-2">
        {own && <Button variant="outline" onPress={reset}>{t('Pakai default')}</Button>}
        <Button onPress={save} isPending={saving}>{t('Simpan aturan')}</Button>
      </div>
    </>
  );
}

// Ringkasan PnL dari hasil riset yang tersimpan (tanpa memanggil chain).
function ResearchLine({ r }) {
  const { t } = useI18n();
  if (!r) return <span className="text-muted">{t('Belum pernah dipindai — buka untuk melihat PnL')}</span>;
  return (
    <span className="num">
      <span className={`font-medium ${tone(r.totalProfitUsd)}`}>{kUsd(r.totalProfitUsd || 0)}</span>
      <span className="text-muted"> {t('{v} PnL · win {w}% · {n} posisi ditutup', { v: '', w: (r.winRatePct || 0).toFixed(0), n: r.closedCount || 0 })}</span>
    </span>
  );
}

const toggle = async (t, on, onChanged) => { await post('/api/targets/toggle', { address: t.address, enabled: on }); onChanged(); };

function TargetCard({ tg, onChanged }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const href = '#target/' + tg.address;
  const remove = async () => {
    if (!confirm(t('Hapus {name} dari daftar target?', { name: tg.label || tg.address }))) return;
    await post('/api/targets/delete', { address: tg.address }); onChanged();
  };
  return (
    <Card>
      <Card.Content className="gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={!!tg.enabled} onChange={(on) => toggle(tg, on, onChanged)} aria-label={t('Aktifkan target')}>
            <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
          </Switch>
          {/* Bagian kiri bisa diklik: membuka PnL, posisi, dan riwayat wallet ini */}
          <a href={href} className="group min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <div className="flex items-center gap-2 font-medium group-hover:underline">
              {tg.label || t('Tanpa label')}
              {tg.rulesOwn && <span className="rounded bg-default px-1.5 py-0.5 text-[11px] font-normal text-muted no-underline">{t('aturan sendiri')}</span>}
            </div>
            <div className="mono truncate text-muted">{tg.address}</div>
            <div className="mt-1 text-sm"><ResearchLine r={tg.research} /></div>
          </a>
          <div className="text-right text-sm text-muted">
            <div className="num">{t('{a} aksi · {c} disalin', { a: tg.actions, c: tg.copied })}</div>
            <div className="num">{t('{n} posisi kita · {v}', { n: tg.openPositions, v: usd(tg.openCostQuote) })}{tg.lastActionTs ? ` · ${ago(tg.lastActionTs)}` : ''}</div>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant={open ? 'secondary' : 'outline'} onPress={() => setOpen(!open)}>
              <SlidersHorizontal className="size-3.5" />{t('Aturan')}</Button>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Hapus')} onPress={remove}><Trash2 className="size-4 text-danger" /></Button>
            <a href={href} aria-label={t('Buka detail')} className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-default hover:text-foreground">
              <ChevronRight className="size-4" /></a>
          </div>
        </div>
        {open && <div className="border-t border-border pt-5"><TargetRules tg={tg} onChanged={onChanged} /></div>}
      </Card.Content>
    </Card>
  );
}

// Nama target bisa diubah langsung di tempat — alamat 0x… sulit dibedakan satu sama lain.
function EditableLabel({ tg, onChanged }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(tg.label || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await post('/api/targets/label', { address: tg.address, label: val });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setEditing(false); toast.success(t('Nama diperbarui')); onChanged();
  };
  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{tg.label || t('Tanpa label')}</h1>
        <Button size="sm" variant="ghost" isIconOnly aria-label={t('Ubah nama')}
          onPress={() => { setVal(tg.label || ''); setEditing(true); }}><Pencil className="size-3.5" /></Button>
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2">
      <Text className="w-64" value={val} onChange={setVal} placeholder="mis. LP pro #1" />
      <Button size="sm" isPending={busy} onPress={save}><CheckIcon className="size-4" />{t('Simpan')}</Button>
      <Button size="sm" variant="ghost" isIconOnly aria-label={t('Batal')} onPress={() => setEditing(false)}><X className="size-4" /></Button>
    </div>
  );
}

// Halaman detail satu target: status copy + riset wallet lengkap (sama dengan menu Wallet).
function TargetDetail({ address, targets, reload }) {
  const { t } = useI18n();
  const tg = targets.find((x) => x.address === address.toLowerCase());
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!tg) {
    return (
      <>
        <a href="#target" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />{t('Target')}</a>
        <Card><Card.Content><Empty title="Wallet ini tidak ada di daftar target" sub="Mungkin sudah dihapus. Kembali ke daftar target." /></Card.Content></Card>
      </>
    );
  }
  return (
    <>
      <a href="#target" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />{t('Semua target')}</a>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-muted">{t('Target')}</div>
          <div className="mt-1"><EditableLabel tg={tg} onChanged={reload} /></div>
          <div className="mt-1 flex items-center gap-2">
            <span className="mono break-all text-muted">{tg.address}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Salin alamat')}
              onPress={() => { navigator.clipboard?.writeText(tg.address); toast.success(t('Alamat tersalin')); }}><Copy className="size-3.5" /></Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Switch isSelected={!!tg.enabled} onChange={(on) => toggle(tg, on, reload)}>
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <span className="text-sm">{t(tg.enabled ? 'Sedang dicopy' : 'Dimatikan')}</span>
            </Switch.Content>
          </Switch>
          <Button variant={rulesOpen ? 'secondary' : 'outline'} onPress={() => setRulesOpen(!rulesOpen)}>
            <SlidersHorizontal className="size-4" />{t('Aturan')}</Button>
        </div>
      </div>

      {/* aktivitas copy untuk target ini */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[['Aksi terdeteksi', tg.actions], ['Disalin / simulasi', tg.copied], ['Posisi kita terbuka', tg.openPositions],
          ['Modal di posisi kita', usd(tg.openCostQuote)]].map(([k, v]) => (
          <Card key={k} className="min-w-0"><Card.Content className="gap-1">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">{t(k)}</div>
            <div className="num text-xl font-semibold">{v}</div>
          </Card.Content></Card>
        ))}
      </div>

      {rulesOpen && <Panel title="Aturan wallet ini" className="mb-6"><TargetRules tg={tg} onChanged={reload} /></Panel>}

      <h2 className="mb-3 text-lg font-semibold">{t('Kinerja LP wallet ini')}</h2>
      <WalletDetail address={tg.address} showTargetButton={false} onChanged={reload} />
    </>
  );
}

export default function Targets({ param }) {
  const { t } = useI18n();
  const { data: d, reload } = usePoll('/api/targets', 15000);
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  if (param) return !d ? <Loading /> : <TargetDetail address={param} targets={d.targets} reload={reload} />;

  const add = async () => {
    setBusy(true);
    const r = await post('/api/targets', { address: addr.trim(), label: label.trim() || null });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setAddr(''); setLabel(''); toast.success(t('Wallet ditambahkan')); reload();
  };

  return (
    <>
      <PageHeader group="Copy" title="Target"
        desc="Wallet yang posisi LP-nya dicermin. Klik sebuah wallet untuk melihat PnL, posisi berjalan, dan riwayat posisinya." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Tambah wallet" className="h-fit">
          <div className="flex flex-col gap-4">
            <Text label="Alamat" mono placeholder="0x…" value={addr} onChange={setAddr}
              isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
            <Text label="Label (opsional)" placeholder="mis. LP pro #1" value={label} onChange={setLabel} />
            <Button fullWidth onPress={add} isDisabled={!valid} isPending={busy}><Plus className="size-4" />{t('Tambah')}</Button>
            <p className="text-sm text-muted">{t('Aturan default dipakai sampai kamu setel sendiri per wallet.')}</p>
          </div>
        </Panel>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {!d ? <Loading /> : d.targets.length
            ? d.targets.map((x) => <TargetCard key={x.address + (x.rules || '')} tg={x} onChanged={reload} />)
            : <Card><Card.Content><Empty title="Belum ada wallet target" sub="Tambahkan alamat di sebelah kiri, atau dari halaman Wallet setelah memeriksa kinerjanya." /></Card.Content></Card>}
        </div>
      </div>
    </>
  );
}
