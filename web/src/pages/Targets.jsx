import { useEffect, useState } from 'react';
import { Button, Card, Chip, Switch, toast } from '@heroui/react';
import { Trash2, SlidersHorizontal, Plus, ChevronRight, ArrowLeft, Copy, Pencil, Check as CheckIcon, X } from 'lucide-react';
import { usePoll } from '../hooks';
import { post } from '../api';
import { PageHeader, Panel, Text, Empty, Loading, Stat, WalletLinks, ask } from '../components/ui';
import RulesForm from '../components/RulesForm';
import WalletDetail from '../components/WalletDetail';
import WalletHoldings from '../components/WalletHoldings';
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

const signed = (v) => (v > 0.005 ? '+' : '') + usd(v);
const oursTotal = (o) => (o ? o.realized + o.upnl : 0);

// Uang TARGET sendiri: kas di walletnya + nilai posisi LP-nya yang masih terbuka.
// Wallet yang sisanya tinggal beberapa puluh dolar praktis sudah berhenti nge-LP,
// jadi angkanya diberi warna — wallet mati terlihat tanpa membuka detailnya satu
// per satu, dan aksinya (matikan / hapus) bisa langsung diambil dari daftar.
const DEAD_USD = 50;    // sudah habis: hampir pasti tidak nge-LP lagi
const LOW_USD = 100;    // tipis: masih mungkin, tapi ukurannya sudah kecil
const balKnown = (b) => !!b && (b.cashUsd != null || b.lpUsd != null);
// Sisi yang belum terbaca ditulis "—": "$0" akan terbaca sebagai wallet kosong.
const money = (v) => (v == null ? '—' : usd(v, 0));
const balTotal = (b) => (b ? (b.cashUsd || 0) + (b.lpUsd || 0) : 0);
// Diwarnai hanya kalau KEDUA sisinya sudah terbaca — wallet yang belum diriset
// LP-nya tidak diketahui, bukan nol, dan tidak boleh tampil seolah modalnya habis.
const balTone = (b) => {
  if (!b || b.cashUsd == null || b.lpUsd == null) return '';
  const v = balTotal(b);
  return v < DEAD_USD ? 'text-danger' : v < LOW_USD ? 'text-warning' : '';
};

function Saldo({ b }) {
  const { t } = useI18n();
  if (!balKnown(b)) return <span className="text-xs text-muted">{t('Belum terbaca')}</span>;
  const tip = [
    b.cashTs ? t('kas dibaca {w}', { w: ago(b.cashTs) }) : t('kas belum terbaca'),
    b.lpTs ? t('posisi dari riset {w}', { w: ago(b.lpTs) }) : t('wallet ini belum diriset'),
  ].join(' · ');
  return (
    <div className="num" title={tip}>
      <div className={`font-medium ${balTone(b)}`}>{kUsd(balTotal(b))}</div>
      <div className="truncate text-xs text-muted">{t('kas {c} · LP {l}', { c: money(b.cashUsd), l: money(b.lpUsd) })}</div>
    </div>
  );
}

// Hasil posisi KITA yang disalin dari wallet ini: terealisasi (sudah ditutup) +
// berjalan (posisi yang masih terbuka). Diletakkan di samping PnL wallet supaya
// "dia dapat berapa" dan "kita dapat berapa" terbaca berdampingan.
function Ours({ o }) {
  const { t } = useI18n();
  if (!o) return <span className="text-xs text-muted">{t('Belum ada posisi')}</span>;
  const tot = oursTotal(o);
  const wr = o.closed ? (o.wins / o.closed) * 100 : null;
  const tip = [t('{o} terbuka · {c} ditutup', { o: o.open, c: o.closed }), wr != null ? t('menang {p}%', { p: wr.toFixed(0) }) : null].filter(Boolean).join(' · ');
  return (
    <div className="num" title={tip}>
      <div className={`font-medium ${tone(tot)}`}>{signed(tot)}</div>
      <div className="truncate text-xs text-muted">{t('terealisasi {r} · berjalan {u}', { r: usd(o.realized), u: usd(o.upnl) })}</div>
    </div>
  );
}

// Rekap di atas daftar: total yang kita dapat dari semua wallet yang diikuti.
function Recap({ list }) {
  const { t } = useI18n();
  const rows = list.filter((x) => x.ours);
  const sum = (f) => rows.reduce((a, x) => a + f(x.ours), 0);
  const realized = sum((o) => o.realized), upnl = sum((o) => o.upnl);
  const closed = sum((o) => o.closed), wins = sum((o) => o.wins), losses = sum((o) => o.losses || 0);
  const open = sum((o) => o.open), value = sum((o) => o.value);
  const best = rows.length ? rows.reduce((a, b) => (oursTotal(b.ours) > oursTotal(a.ours) ? b : a)) : null;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat label="Hasil dari semua target" value={signed(realized + upnl)} fx={realized + upnl} valueClass={tone(realized + upnl)}
        sub={t('terealisasi {r} · berjalan {u}', { r: usd(realized), u: usd(upnl) })} />
      <Stat label="Posisi ditutup" value={closed}
        sub={closed ? t(closed - wins - losses ? '{w} menang · {l} kalah · {f} impas' : '{w} menang · {l} kalah', { w: wins, l: losses, f: closed - wins - losses }) : t('belum ada')} />
      <Stat label="Posisi berjalan" value={open} sub={t('nilai {v}', { v: usd(value) })} />
      <Stat label="Wallet paling cuan" value={best ? <a href={'#targets/' + best.address} className="hover:underline">{best.label || short(best.address)}</a> : '—'}
        sub={best ? <span className={`num ${tone(oursTotal(best.ours))}`}>{signed(oursTotal(best.ours))}</span> : t('belum ada')} />
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
const ROW = 'grid items-center gap-x-4 gap-y-2 grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,0.8fr)_minmax(0,0.95fr)_minmax(0,0.65fr)_minmax(0,0.9fr)_auto]';

function TargetRow({ tg, enabled, onToggle, onChanged }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const href = '#targets/' + tg.address;
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
        {/* Nama bisa diklik: membuka PnL, posisi, dan riwayat wallet ini. Tombol ke
            situs luar berdiri di luar tautan itu — tautan tidak boleh bersarang. */}
        <div className="min-w-0">
          <a href={href} className="group block min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <div className="flex items-center gap-2">
              <span className={`truncate font-medium group-hover:underline ${enabled ? '' : 'text-muted'}`}>{tg.label || t('Tanpa label')}</span>
              {tg.rulesOwn && <Chip size="sm" variant="soft" color="accent" className="shrink-0">{t('aturan sendiri')}</Chip>}
              {balTone(tg.balance) && (
                <Chip size="sm" variant="soft" color={balTotal(tg.balance) < DEAD_USD ? 'danger' : 'warning'} className="shrink-0">
                  {t(balTotal(tg.balance) < DEAD_USD ? 'dana habis' : 'dana tipis')}</Chip>)}
            </div>
          </a>
          <div className="flex min-w-0 items-center gap-1">
            <a href={href} className="mono truncate text-xs text-muted hover:text-foreground">{short(tg.address)}</a>
            <WalletLinks address={tg.address} compact className="ml-2" />
          </div>
        </div>
        <div className="hidden min-w-0 md:block"><Saldo b={tg.balance} /></div>
        <div className="hidden md:block"><Research r={tg.research} /></div>
        <div className="hidden min-w-0 md:block"><Ours o={tg.ours} /></div>
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
          {balKnown(tg.balance) && <span className={`num font-medium ${balTone(tg.balance)}`}>{t('saldo {v}', { v: kUsd(balTotal(tg.balance)) })}</span>}
          {tg.research && <span className={`num font-medium ${tone(tg.research.totalProfitUsd)}`}>{kUsd(tg.research.totalProfitUsd || 0)} PnL</span>}
          {tg.ours && <span className={`num font-medium ${tone(oursTotal(tg.ours))}`}>{t('kita {v}', { v: signed(oursTotal(tg.ours)) })}</span>}
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
        <a href="#targets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />{t('Target')}</a>
        <Card><Card.Content><Empty title="Wallet ini tidak ada di daftar target" sub="Mungkin sudah dihapus. Kembali ke daftar target." /></Card.Content></Card>
      </>
    );
  }
  return (
    <>
      <a href="#targets" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />{t('Semua target')}</a>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <EditableLabel tg={tg} onChanged={reload} />
          <div className="mt-1 flex items-center gap-2">
            <span className="mono break-all text-muted">{tg.address}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Salin alamat')}
              onPress={() => { navigator.clipboard?.writeText(tg.address); toast.success(t('Alamat tersalin')); }}><Copy className="size-3.5" /></Button>
          </div>
          {/* Lihat wallet ini di luar: isi dompetnya (DeBank), portofolio LP-nya
              (LPAgent), dan tiap transaksinya (Etherscan, penjelajah chain). */}
          <WalletLinks address={tg.address} className="mt-2" />
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
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
        {/* Uang dia sendiri — kalau tinggal puluhan dolar, mengikutinya sudah tidak ada gunanya. */}
        <Stat label="Saldo dia" value={balKnown(tg.balance) ? kUsd(balTotal(tg.balance)) : '—'} fx={balKnown(tg.balance) ? balTotal(tg.balance) : null} valueClass={balTone(tg.balance)}
          sub={balKnown(tg.balance)
            ? t('kas {c} · LP {l} ({n} posisi)', { c: money(tg.balance.cashUsd), l: money(tg.balance.lpUsd), n: tg.balance.lpOpenN })
            : t('Belum terbaca')} />
        <Stat label="Aksi terdeteksi" value={tg.actions} sub={tg.lastActionTs ? t('terakhir {w}', { w: ago(tg.lastActionTs) }) : t('belum ada aksi')} />
        <Stat label="Disalin / simulasi" value={tg.copied} />
        <Stat label="Posisi kita terbuka" value={tg.openPositions} sub={t('modal {v}', { v: usd(tg.openCostQuote) })} />
        <Stat label="Hasil kita" value={signed(oursTotal(tg.ours))} fx={oursTotal(tg.ours)} valueClass={tone(oursTotal(tg.ours))}
          sub={tg.ours ? t('terealisasi {r} · berjalan {u}', { r: usd(tg.ours.realized), u: usd(tg.ours.upnl) }) : t('Belum ada posisi')} />
      </div>

      {rulesOpen && <Panel title="Aturan wallet ini" className="mb-4"><TargetRules tg={tg} onChanged={reload} /></Panel>}

      {/* apa yang sedang dia pegang di luar posisi LP: kas, hasil tutup yang belum dijual, token yang ditimbun */}
      <WalletHoldings address={tg.address} />

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

  if (param) return !d ? <Loading page /> : <TargetDetail address={param} targets={d.targets} reload={reload} enabledOf={enabledOf} onToggle={toggle} />;

  const add = async () => {
    setBusy(true);
    const r = await post('/api/targets', { address: addr.trim(), label: label.trim() || null });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setAddr(''); setLabel(''); setAdding(false); toast.success(t('Wallet ditambahkan')); reload();
  };

  const list = d?.targets || [];
  const on = list.filter((x) => enabledOf(x)).length;
  // Yang aktif ditaruh di atas supaya langsung terlihat, tanpa mengubah urutan sesama status.
  const sorted = [...list].sort((a, b) => (enabledOf(b) ? 1 : 0) - (enabledOf(a) ? 1 : 0));
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

      {d && list.length > 0 && <Recap list={list} />}

      {!d ? <Loading /> : list.length ? (
        <Card className="gap-0! overflow-hidden p-0!">
          <div className={`${ROW} hidden border-b border-border bg-default/40 px-4 py-2 text-[0.7188rem] font-medium text-muted md:grid`}>
            <span className="w-9" />
            <span>{t('{on} dari {n} aktif', { on, n: list.length })}</span>
            <span>{t('Saldo dia')}</span>
            <span>{t('PnL wallet')}</span>
            <span>{t('Hasil kita')}</span>
            <span>{t('Aktivitas')}</span>
            <span>{t('Posisi kita')}</span>
            <span className="w-24" />
          </div>
          <div className="divide-y divide-border">
            {sorted.map((x) => <TargetRow key={x.address + (x.rules || '')} tg={x} enabled={enabledOf(x)} onToggle={toggle} onChanged={reload} />)}
          </div>
        </Card>
      ) : (
        <Card><Empty title="Belum ada wallet target" sub="Tambahkan alamat lewat tombol di atas, atau dari halaman Wallet setelah memeriksa kinerjanya." /></Card>
      )}
    </>
  );
}
