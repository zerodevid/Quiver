import { useState } from 'react';
import { Button, Card, Switch, toast } from '@heroui/react';
import { Trash2, SlidersHorizontal, Plus, ChevronRight, ArrowLeft, Copy, Pencil, Check as CheckIcon, X } from 'lucide-react';
import { usePoll } from '../hooks';
import { post } from '../api';
import { PageHeader, Panel, Text, Empty, Loading } from '../components/ui';
import RulesForm from '../components/RulesForm';
import WalletDetail from '../components/WalletDetail';
import { usd, kUsd, tone, ago } from '../fmt';

// Editor aturan per-target — dipakai di kartu (dilipat) dan di halaman detail.
function TargetRules({ t, onChanged }) {
  const [rules, setRules] = useState(t.rulesResolved);
  const [saving, setSaving] = useState(false);
  const own = !!t.rulesOwn;
  const save = async () => {
    setSaving(true);
    const r = await post('/api/targets/rules', { address: t.address, rules });
    setSaving(false);
    r.ok ? toast.success('Aturan wallet ini tersimpan') : toast.danger(r.error || 'Gagal');
    onChanged();
  };
  const reset = async () => { await post('/api/targets/rules', { address: t.address, rules: null }); toast.success('Kembali ke aturan default'); onChanged(); };
  return (
    <>
      <p className="mb-5 text-sm text-muted">Aturan khusus wallet ini. Selama tidak diubah, aturan default yang dipakai.</p>
      <RulesForm value={rules} onChange={setRules} />
      <div className="mt-6 flex justify-end gap-2">
        {own && <Button variant="outline" onPress={reset}>Pakai default</Button>}
        <Button onPress={save} isPending={saving}>Simpan aturan</Button>
      </div>
    </>
  );
}

// Ringkasan PnL dari hasil riset yang tersimpan (tanpa memanggil chain).
function ResearchLine({ r }) {
  if (!r) return <span className="text-muted">Belum pernah dipindai — buka untuk melihat PnL</span>;
  return (
    <span className="num">
      <span className={`font-medium ${tone(r.totalProfitUsd)}`}>{kUsd(r.totalProfitUsd || 0)}</span>
      <span className="text-muted"> PnL · win {(r.winRatePct || 0).toFixed(0)}% · {r.closedCount || 0} posisi ditutup</span>
    </span>
  );
}

const toggle = async (t, on, onChanged) => { await post('/api/targets/toggle', { address: t.address, enabled: on }); onChanged(); };

function TargetCard({ t, onChanged }) {
  const [open, setOpen] = useState(false);
  const href = '#target/' + t.address;
  const remove = async () => {
    if (!confirm(`Hapus ${t.label || t.address} dari daftar target?`)) return;
    await post('/api/targets/delete', { address: t.address }); onChanged();
  };
  return (
    <Card>
      <Card.Content className="gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={!!t.enabled} onChange={(on) => toggle(t, on, onChanged)} aria-label="Aktifkan target">
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch>
          {/* Bagian kiri bisa diklik: membuka PnL, posisi, dan riwayat wallet ini */}
          <a href={href} className="group min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <div className="flex items-center gap-2 font-medium group-hover:underline">
              {t.label || 'Tanpa label'}
              {t.rulesOwn && <span className="rounded bg-default px-1.5 py-0.5 text-[11px] font-normal text-muted no-underline">aturan sendiri</span>}
            </div>
            <div className="mono truncate text-muted">{t.address}</div>
            <div className="mt-1 text-sm"><ResearchLine r={t.research} /></div>
          </a>
          <div className="text-right text-sm text-muted">
            <div className="num">{t.actions} aksi · {t.copied} disalin</div>
            <div className="num">{t.openPositions} posisi kita · {usd(t.openCostQuote)}{t.lastActionTs ? ` · ${ago(t.lastActionTs)}` : ''}</div>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant={open ? 'secondary' : 'outline'} onPress={() => setOpen(!open)}>
              <SlidersHorizontal className="size-3.5" />Aturan</Button>
            <Button size="sm" variant="ghost" isIconOnly aria-label="Hapus" onPress={remove}><Trash2 className="size-4 text-danger" /></Button>
            <a href={href} aria-label="Buka detail" className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-default hover:text-foreground">
              <ChevronRight className="size-4" /></a>
          </div>
        </div>
        {open && <div className="border-t border-border pt-5"><TargetRules t={t} onChanged={onChanged} /></div>}
      </Card.Content>
    </Card>
  );
}

// Nama target bisa diubah langsung di tempat — alamat 0x… sulit dibedakan satu sama lain.
function EditableLabel({ t, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(t.label || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await post('/api/targets/label', { address: t.address, label: val });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setEditing(false); toast.success('Nama diperbarui'); onChanged();
  };
  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{t.label || 'Tanpa label'}</h1>
        <Button size="sm" variant="ghost" isIconOnly aria-label="Ubah nama"
          onPress={() => { setVal(t.label || ''); setEditing(true); }}><Pencil className="size-3.5" /></Button>
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2">
      <Text className="w-64" value={val} onChange={setVal} placeholder="mis. LP pro #1" />
      <Button size="sm" isPending={busy} onPress={save}><CheckIcon className="size-4" />Simpan</Button>
      <Button size="sm" variant="ghost" isIconOnly aria-label="Batal" onPress={() => setEditing(false)}><X className="size-4" /></Button>
    </div>
  );
}

// Halaman detail satu target: status copy + riset wallet lengkap (sama dengan menu Wallet).
function TargetDetail({ address, targets, reload }) {
  const t = targets.find((x) => x.address === address.toLowerCase());
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!t) {
    return (
      <>
        <a href="#target" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />Target</a>
        <Card><Card.Content><Empty title="Wallet ini tidak ada di daftar target" sub="Mungkin sudah dihapus. Kembali ke daftar target." /></Card.Content></Card>
      </>
    );
  }
  return (
    <>
      <a href="#target" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />Semua target</a>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-muted">Target</div>
          <div className="mt-1"><EditableLabel t={t} onChanged={reload} /></div>
          <div className="mt-1 flex items-center gap-2">
            <span className="mono break-all text-muted">{t.address}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label="Salin alamat"
              onPress={() => { navigator.clipboard?.writeText(t.address); toast.success('Alamat tersalin'); }}><Copy className="size-3.5" /></Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Switch isSelected={!!t.enabled} onChange={(on) => toggle(t, on, reload)}>
            <Switch.Control><Switch.Thumb /></Switch.Control>
            <Switch.Content><span className="text-sm">{t.enabled ? 'Sedang dicopy' : 'Dimatikan'}</span></Switch.Content>
          </Switch>
          <Button variant={rulesOpen ? 'secondary' : 'outline'} onPress={() => setRulesOpen(!rulesOpen)}>
            <SlidersHorizontal className="size-4" />Aturan</Button>
        </div>
      </div>

      {/* aktivitas copy untuk target ini */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[['Aksi terdeteksi', t.actions], ['Disalin / simulasi', t.copied], ['Posisi kita terbuka', t.openPositions],
          ['Modal di posisi kita', usd(t.openCostQuote)]].map(([k, v]) => (
          <Card key={k} className="min-w-0"><Card.Content className="gap-1">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">{k}</div>
            <div className="num text-xl font-semibold">{v}</div>
          </Card.Content></Card>
        ))}
      </div>

      {rulesOpen && <Panel title="Aturan wallet ini" className="mb-6"><TargetRules t={t} onChanged={reload} /></Panel>}

      <h2 className="mb-3 text-lg font-semibold">Kinerja LP wallet ini</h2>
      <WalletDetail address={t.address} showTargetButton={false} onChanged={reload} />
    </>
  );
}

export default function Targets({ param }) {
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
    setAddr(''); setLabel(''); toast.success('Wallet ditambahkan'); reload();
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
            <Button fullWidth onPress={add} isDisabled={!valid} isPending={busy}><Plus className="size-4" />Tambah</Button>
            <p className="text-sm text-muted">Aturan default dipakai sampai kamu setel sendiri per wallet.</p>
          </div>
        </Panel>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {!d ? <Loading /> : d.targets.length
            ? d.targets.map((t) => <TargetCard key={t.address + (t.rules || '')} t={t} onChanged={reload} />)
            : <Card><Card.Content><Empty title="Belum ada wallet target" sub="Tambahkan alamat di sebelah kiri, atau dari halaman Wallet setelah memeriksa kinerjanya." /></Card.Content></Card>}
        </div>
      </div>
    </>
  );
}
