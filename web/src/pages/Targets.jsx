import { useEffect, useState } from 'react';
import { Button, Card, Chip, Switch, toast } from '@heroui/react';
import { Trash2, SlidersHorizontal, Plus, ChevronRight, ArrowLeft, Copy, Pencil, Check as CheckIcon, X } from 'lucide-react';
import { usePoll } from '../hooks';
import { post } from '../api';
import { PageHeader, Panel, Text, Empty, Loading, Stat, ask } from '../components/ui';
import RulesForm from '../components/RulesForm';
import WalletDetail from '../components/WalletDetail';
import { usd, kUsd, tone, ago, short } from '../fmt';
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
function Research({ r }) {
  const { t } = useI18n();
  if (!r) return <span className="text-xs text-muted">{t('Belum dipindai')}</span>;
  return (
    <div className="num">
      <div className={`font-medium ${tone(r.totalProfitUsd)}`}>{kUsd(r.totalProfitUsd || 0)}</div>
      <div className="text-xs text-muted">{t('win {w}% · {n} posisi', { w: (r.winRatePct || 0).toFixed(0), n: r.closedCount || 0 })}</div>
    </div>
  );
}

// Sakelar dibuat optimistis. /api/targets ikut menghitung riset tiap wallet, jadi
// balasannya bisa beberapa detik saat RPC sedang kena 429; tanpa ini sakelar diam di
// posisi lama sampai balasan datang — persis seperti tidak bisa diklik. Nilai lokal
// dipakai sampai server menyetujuinya.
function useToggles(targets, reload) {
  const [pending, setPending] = useState({});
  useEffect(() => {
    if (!targets) return;
    setPending((p) => {
      const next = {}; let changed = false;
      for (const [addr, want] of Object.entries(p)) {
        const srv = targets.find((x) => x.address === addr);
        if (srv && !!srv.enabled === want) { changed = true; continue; }   // server sudah setuju
        next[addr] = want;
      }
      return changed ? next : p;
    });
  }, [targets]);
  const enabledOf = (tg) => pending[tg.address] ?? !!tg.enabled;
  const toggle = async (tg, on) => {
    setPending((p) => ({ ...p, [tg.address]: on }));
    const r = await post('/api/targets/toggle', { address: tg.address, enabled: on });
    if (r?.error) {
      setPending((p) => { const n = { ...p }; delete n[tg.address]; return n; });
      return toast.danger(r.error);
    }
    reload();
  };
  return { enabledOf, toggle };
}

// Satu baris daftar target. Kolomnya sejajar antarbaris (grid yang sama) supaya
// PnL, aktivitas, dan posisi bisa dibandingkan menurun seperti tabel.
const ROW = 'grid items-center gap-x-4 gap-y-2 grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto]';

function TargetRow({ tg, enabled, onToggle, onChanged }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const href = '#target/' + tg.address;
  const remove = async () => {
    const ok = await ask({
      title: t('Hapus {name} dari daftar target?', { name: tg.label || short(tg.address) }),
      body: t('Posisi yang sudah disalin tetap ada dan tetap dipantau; bot hanya berhenti mengikuti wallet ini.'),
      confirm: t('Hapus'), danger: true,
    });
    if (!ok) return;
    await post('/api/targets/delete', { address: tg.address }); onChanged();
  };
  return (
    <div className={enabled ? '' : 'bg-default/30'}>
      <div className={`${ROW} px-4 py-3`}>
        <Switch isSelected={enabled} onChange={(on) => onToggle(tg, on)} aria-label={t('Aktifkan target')} size="sm">
          <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch>
        {/* Nama bisa diklik: membuka PnL, posisi, dan riwayat wallet ini */}
        <a href={href} className="group min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <div className="flex items-center gap-2">
            <span className={`truncate font-medium group-hover:underline ${enabled ? '' : 'text-muted'}`}>{tg.label || t('Tanpa label')}</span>
            {tg.rulesOwn && <Chip size="sm" variant="soft" color="accent" className="shrink-0">{t('aturan sendiri')}</Chip>}
          </div>
          <div className="mono truncate text-xs text-muted">{short(tg.address)}</div>
        </a>
        <div className="hidden md:block"><Research r={tg.research} /></div>
        <div className="num hidden text-sm md:block">
          <div>{t('{a} aksi', { a: tg.actions })}</div>
          <div className="text-xs text-muted">{t('{c} disalin', { c: tg.copied })}</div>
        </div>
        <div className="num hidden text-sm md:block">
          <div>{t('{n} posisi · {v}', { n: tg.openPositions, v: usd(tg.openCostQuote, 0) })}</div>
          <div className="text-xs text-muted">{tg.lastActionTs ? t('aksi terakhir {w}', { w: ago(tg.lastActionTs) }) : t('belum ada aksi')}</div>
        </div>
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant={open ? 'secondary' : 'ghost'} isIconOnly aria-label={t('Aturan')} onPress={() => setOpen(!open)}>
            <SlidersHorizontal className="size-4" /></Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Hapus')} onPress={remove}><Trash2 className="size-4 text-muted" /></Button>
          <a href={href} aria-label={t('Buka detail')} className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-default hover:text-foreground">
            <ChevronRight className="size-4" /></a>
        </div>
        {/* HP: ringkasan dalam satu baris di bawah nama */}
        <div className="col-span-3 flex flex-wrap gap-x-4 gap-y-1 pl-12 text-xs text-muted md:hidden">
          {tg.research && <span className={`num font-medium ${tone(tg.research.totalProfitUsd)}`}>{kUsd(tg.research.totalProfitUsd || 0)} PnL</span>}
          <span className="num">{t('{a} aksi · {c} disalin', { a: tg.actions, c: tg.copied })}</span>
          <span className="num">{t('{n} posisi · {v}', { n: tg.openPositions, v: usd(tg.openCostQuote, 0) })}</span>
        </div>
      </div>
      {open && <div className="border-t border-border bg-surface px-4 py-5"><TargetRules tg={tg} onChanged={onChanged} /></div>}
    </div>
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
        <h1 className="text-xl font-semibold tracking-tight">{tg.label || t('Tanpa label')}</h1>
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
function TargetDetail({ address, targets, reload, enabledOf, onToggle }) {
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
      <a href="#target" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />{t('Semua target')}</a>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <EditableLabel tg={tg} onChanged={reload} />
          <div className="mt-1 flex items-center gap-2">
            <span className="mono break-all text-muted">{tg.address}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Salin alamat')}
              onPress={() => { navigator.clipboard?.writeText(tg.address); toast.success(t('Alamat tersalin')); }}><Copy className="size-3.5" /></Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Switch isSelected={enabledOf(tg)} onChange={(on) => onToggle(tg, on)}>
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <span className="text-sm">{t(enabledOf(tg) ? 'Sedang dicopy' : 'Dimatikan')}</span>
            </Switch.Content>
          </Switch>
          <Button variant={rulesOpen ? 'secondary' : 'outline'} onPress={() => setRulesOpen(!rulesOpen)}>
            <SlidersHorizontal className="size-4" />{t('Aturan')}</Button>
        </div>
      </div>

      {/* aktivitas copy untuk target ini */}
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Aksi terdeteksi" value={tg.actions} sub={tg.lastActionTs ? t('terakhir {w}', { w: ago(tg.lastActionTs) }) : t('belum ada aksi')} />
        <Stat label="Disalin / simulasi" value={tg.copied} />
        <Stat label="Posisi kita terbuka" value={tg.openPositions} />
        <Stat label="Modal di posisi kita" value={usd(tg.openCostQuote)} />
      </div>

      {rulesOpen && <Panel title="Aturan wallet ini" className="mb-4"><TargetRules tg={tg} onChanged={reload} /></Panel>}

      <h2 className="mb-3 mt-6 text-base font-semibold tracking-tight">{t('Kinerja LP wallet ini')}</h2>
      <WalletDetail address={tg.address} showTargetButton={false} onChanged={reload} />
    </>
  );
}

export default function Targets({ param }) {
  const { t } = useI18n();
  const { data: d, reload } = usePoll('/api/targets', 15000);
  const { enabledOf, toggle } = useToggles(d?.targets, reload);
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  if (param) return !d ? <Loading /> : <TargetDetail address={param} targets={d.targets} reload={reload} enabledOf={enabledOf} onToggle={toggle} />;

  const add = async () => {
    setBusy(true);
    const r = await post('/api/targets', { address: addr.trim(), label: label.trim() || null });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setAddr(''); setLabel(''); setAdding(false); toast.success(t('Wallet ditambahkan')); reload();
  };

  const list = d?.targets || [];
  const on = list.filter((x) => enabledOf(x)).length;
  return (
    <>
      <PageHeader group="Copy" title="Target"
        desc="Wallet yang posisi LP-nya dicermin. Klik sebuah wallet untuk melihat PnL, posisi berjalan, dan riwayat posisinya.">
        <Button variant={adding ? 'secondary' : 'primary'} onPress={() => setAdding(!adding)}>
          {adding ? <X className="size-4" /> : <Plus className="size-4" />}{t(adding ? 'Batal' : 'Tambah target')}</Button>
      </PageHeader>

      {adding && (
        <Panel className="mb-4">
          <div className="grid items-start gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
            <Text label="Alamat" mono placeholder="0x…" value={addr} onChange={setAddr}
              isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
            <Text label="Label (opsional)" placeholder="mis. LP pro #1" value={label} onChange={setLabel} />
            <Button className="md:mt-[1.6rem]" onPress={add} isDisabled={!valid} isPending={busy}><Plus className="size-4" />{t('Tambah')}</Button>
          </div>
          <p className="mt-3 text-xs text-muted">{t('Aturan default dipakai sampai kamu setel sendiri per wallet.')}</p>
        </Panel>
      )}

      {!d ? <Loading /> : list.length ? (
        <Card className="gap-0! overflow-hidden p-0!">
          <div className={`${ROW} hidden border-b border-border bg-default/40 px-4 py-2 text-[0.7188rem] font-medium text-muted md:grid`}>
            <span className="w-9" />
            <span>{t('{on} dari {n} aktif', { on, n: list.length })}</span>
            <span>{t('PnL wallet')}</span>
            <span>{t('Aktivitas')}</span>
            <span>{t('Posisi kita')}</span>
            <span className="w-24" />
          </div>
          <div className="divide-y divide-border">
            {list.map((x) => <TargetRow key={x.address + (x.rules || '')} tg={x} enabled={enabledOf(x)} onToggle={toggle} onChanged={reload} />)}
          </div>
        </Card>
      ) : (
        <Card><Empty title="Belum ada wallet target" sub="Tambahkan alamat lewat tombol di atas, atau dari halaman Wallet setelah memeriksa kinerjanya." /></Card>
      )}
    </>
  );
}
