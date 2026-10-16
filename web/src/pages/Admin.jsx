// Superadmin console: accounts (suspend / resume) and invite codes.
// Every account gets its own engines, database and wallet on this server (src/tenants.js);
// the RPC endpoints stay under Settings → RPC and are shared by all accounts.
import { useState } from 'react';
import { Button, Chip, toast } from '@heroui/react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { post } from '../api';
import { usePoll } from '../hooks';
import { useMe, isSuperadmin } from '../me';
import { PageHeader, Panel, DataTable, Empty, Loading, Notice, Pick, ask } from '../components/ui';
import { ago, locale as fmtLocale } from '../fmt';
import { useI18n } from '../i18n';

const when = (ts) => (ts ? <span title={new Date(ts).toLocaleString(fmtLocale())}>{ago(ts)}</span> : '—');

function copy(text, ok) {
  navigator.clipboard?.writeText(text).then(() => toast.success(ok), () => toast.danger(text));
}

function Users({ users, maxUsers, me, reload }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(null);
  const setStatus = async (u, status) => {
    const suspend = status === 'suspended';
    if (suspend && !(await ask({
      title: t('Nonaktifkan akun {u}?', { u: u.username }),
      body: t('Mesinnya berhenti setelah transaksi yang sedang berjalan selesai, dan semua sesinya ditutup. Data dan wallet-nya tetap tersimpan.'),
      confirm: t('Nonaktifkan'), danger: true,
    }))) return;
    setBusy(u.id);
    const r = await post('/api/auth/users/status', { id: u.id, status });
    setBusy(null);
    if (r.error) toast.danger(r.error); else toast.success(t(suspend ? 'Akun dinonaktifkan' : 'Akun diaktifkan'));
    reload();
  };
  const [temp, setTemp] = useState(null);      // { username, password } — shown once
  const reset = async (u) => {
    if (!(await ask({
      title: t('Reset kata sandi {u}?', { u: u.username }),
      body: t('Kata sandi lama langsung tidak berlaku dan semua sesinya ditutup. Anda akan mendapat kata sandi sementara untuk dikirim ke pengguna.'),
      confirm: t('Reset kata sandi'), danger: true,
    }))) return;
    setBusy(u.id);
    const r = await post('/api/auth/users/reset', { id: u.id });
    setBusy(null);
    if (r.error) return toast.danger(r.error);
    setTemp({ username: u.username, password: r.password });
    reload();
  };
  const regular = users.filter((u) => u.role !== 'superadmin').length;
  return (
    <Panel title="Akun" desc={maxUsers ? t('{n} dari {max} akun pengguna', { n: regular, max: maxUsers }) : null} bodyClass="p-0">
      {temp && (
        <div className="border-b border-border p-4">
          <Notice status="warning" title={t('Kata sandi sementara untuk {u}', { u: temp.username })}>
            <p className="text-sm">{t('Hanya ditampilkan sekali. Kirim lewat jalur pribadi, lalu minta pengguna menggantinya di Pengaturan → Keamanan.')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="mono rounded bg-default px-2 py-1 text-sm break-all">{temp.password}</code>
              <Button size="sm" variant="outline" onPress={() => copy(temp.password, t('Tersalin'))}><Copy className="size-3.5" />{t('Salin')}</Button>
              <Button size="sm" variant="ghost" onPress={() => setTemp(null)}>{t('Tutup')}</Button>
            </div>
          </Notice>
        </div>
      )}
      <DataTable label="Akun" rows={users} rowKey={(u) => u.id} searchable={users.length > 8}
        defaultSort={{ column: 'created', direction: 'ascending' }}
        empty={<Empty title="Belum ada akun" />}
        columns={[
          { key: 'username', label: 'Nama pengguna', render: (u) => (
            <div className="flex items-center gap-2">
              <span className="font-medium">{u.username}</span>
              {u.id === me?.user?.id && <span className="text-xs text-muted">({t('Anda')})</span>}
            </div>) },
          { key: 'role', label: 'Peran', render: (u) => <Chip size="sm" variant="soft" color={u.role === 'superadmin' ? 'accent' : 'default'}>{u.role === 'superadmin' ? 'Superadmin' : t('Pengguna')}</Chip> },
          { key: 'status', label: 'Status', sort: (u) => `${u.status}${u.running ? 1 : 0}`, render: (u) => (
            u.status === 'suspended'
              ? <Chip size="sm" variant="soft" color="danger">{t('Nonaktif')}</Chip>
              : <Chip size="sm" variant="soft" color={u.running ? 'success' : 'warning'}>{t(u.running ? 'Berjalan' : 'Mesin mati')}</Chip>) },
          { key: 'created', label: 'Dibuat', sort: (u) => u.created_at, render: (u) => <span className="text-xs text-muted">{when(u.created_at)}</span> },
          { key: 'act', label: '', sortable: false, render: (u) => (u.role === 'superadmin' ? null : (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" isPending={busy === u.id} onPress={() => reset(u)}>{t('Reset kata sandi')}</Button>
              {u.status === 'suspended'
                ? <Button size="sm" variant="outline" isPending={busy === u.id} onPress={() => setStatus(u, 'active')}>{t('Aktifkan')}</Button>
                : <Button size="sm" variant="ghost" isPending={busy === u.id} onPress={() => setStatus(u, 'suspended')}>{t('Nonaktifkan')}</Button>}
            </div>)) },
        ]} />
    </Panel>
  );
}

function Invites({ invites, users, reload }) {
  const { t } = useI18n();
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);     // the plain code is only known right after creation
  // The sign-up page prefills the code from ?code=, so the link alone is enough to share.
  const linkOf = (code) => `${location.origin}/register?code=${code}`;
  const nameOf = (id) => users.find((u) => u.id === id)?.username || `#${id}`;
  const create = async () => {
    setBusy(true);
    const r = await post('/api/auth/invites', { days: Number(days) });
    setBusy(false);
    if (r.error) return toast.danger(r.error);
    setFresh(r.code);
    reload();
  };
  const revoke = async (inv) => {
    if (!(await ask({ title: t('Cabut kode undangan ini?'), confirm: t('Cabut'), danger: true }))) return;
    const r = await post('/api/auth/invites/revoke', { id: inv.id });
    if (r.error || !r.ok) toast.danger(r.error || t('Kode sudah terpakai')); else toast.success(t('Kode dicabut'));
    reload();
  };
  const now = Date.now();
  const stateOf = (i) => (i.used_by ? ['Terpakai', 'default'] : i.expires_at < now ? ['Kedaluwarsa', 'warning'] : ['Masih berlaku', 'success']);
  return (
    <Panel title="Kode undangan" desc="Pendaftaran hanya bisa dengan kode dari sini. Satu kode untuk satu akun."
      action={(
        <div className="flex items-end gap-2">
          <Pick className="w-36" aria="Masa berlaku" value={days} onChange={setDays}
            options={[['1', '1 hari'], ['3', '3 hari'], ['7', '7 hari'], ['30', '30 hari']]} />
          <Button size="sm" isPending={busy} onPress={create}><Plus className="size-3.5" />{t('Buat kode')}</Button>
        </div>
      )} bodyClass="p-0">
      {fresh && (
        <div className="border-b border-border p-4">
          <Notice status="success" title={t('Kode undangan baru')}>
            <p className="text-sm">{t('Kode ini hanya ditampilkan sekali. Kirim tautan pendaftaran di bawah ke calon pengguna; kodenya sudah terisi di sana.')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="mono rounded bg-default px-2 py-1 text-sm break-all">{fresh}</code>
              <Button size="sm" variant="outline" onPress={() => copy(fresh, t('Kode disalin'))}><Copy className="size-3.5" />{t('Salin kode')}</Button>
              <Button size="sm" variant="ghost" onPress={() => copy(linkOf(fresh), t('Tautan pendaftaran disalin'))}>{t('Salin tautan pendaftaran')}</Button>
            </div>
            <p className="mono mt-2 text-xs text-muted break-all">{linkOf(fresh)}</p>
          </Notice>
        </div>
      )}
      <DataTable label="Kode undangan" rows={invites} rowKey={(i) => i.id} pageSize={10}
        defaultSort={{ column: 'created', direction: 'descending' }}
        empty={<Empty title="Belum ada kode undangan" sub="Buat kode untuk mengundang pengguna pertama." />}
        columns={[
          { key: 'created', label: 'Dibuat', sort: (i) => i.created_at, render: (i) => <span className="text-xs text-muted">{when(i.created_at)}</span> },
          { key: 'state', label: 'Status', sort: (i) => stateOf(i)[0], render: (i) => { const [s, c] = stateOf(i); return <Chip size="sm" variant="soft" color={c}>{t(s)}</Chip>; } },
          { key: 'used', label: 'Dipakai oleh', sort: (i) => i.used_by, render: (i) => (i.used_by ? <span className="font-medium">{nameOf(i.used_by)}</span> : <span className="text-muted">—</span>) },
          { key: 'exp', label: 'Berlaku sampai', sort: (i) => i.expires_at, render: (i) => <span className="text-xs text-muted">{new Date(i.expires_at).toLocaleString(fmtLocale())}</span> },
          { key: 'act', label: '', sortable: false, render: (i) => (i.used_by ? null : (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('Cabut')} onPress={() => revoke(i)}><Trash2 className="size-3.5" /></Button>
            </div>)) },
        ]} />
    </Panel>
  );
}

// The audit trail: sign-ins, account admin, wallet keys, LIVE, backups, shared settings.
function Audit({ entries, users }) {
  const { t } = useI18n();
  const [who, setWho] = useState('all');
  const rows = who === 'all' ? entries : entries.filter((e) => String(e.user_id) === who);
  const LABEL = {
    login: 'Masuk', 'login (token)': 'Masuk (token)', logout: 'Keluar dari dasbor', register: 'Daftar',
    'api/auth/invites': 'Buat kode undangan', 'api/auth/invites/revoke': 'Cabut kode undangan', 'api/auth/users/status': 'Ubah status akun',
    'api/mode': 'Jeda / lanjut', 'api/settings/live': 'Mode LIVE',
    'api/settings/wallet/generate': 'Buat wallet', 'api/settings/wallet/import': 'Impor wallet', 'api/settings/wallet/remove': 'Lepas wallet', 'api/settings/wallet/export': 'Ekspor wallet',
    'api/settings/backup': 'Buat cadangan', 'api/settings/restore': 'Pulihkan cadangan',
    'api/positions/close': 'Tutup posisi', 'api/positions/takeover': 'Ambil alih posisi', 'api/manual/lp/open': 'Buka LP manual', 'api/manual/swap': 'Swap manual',
  };
  return (
    <Panel title="Log audit" desc="Masuk, pengelolaan akun, kunci wallet, LIVE, cadangan, dan pengaturan bersama. Isi permintaan tidak pernah dicatat." bodyClass="p-0"
      action={<Pick className="w-44" aria="Saring akun" value={who} onChange={setWho} options={[['all', 'Semua akun'], ...users.map((u) => [String(u.id), u.username])]} />}>
      <DataTable label="Log audit" rows={rows} rowKey={(e) => e.id} pageSize={25} searchable
        defaultSort={{ column: 'ts', direction: 'descending' }}
        empty={<Empty title="Belum ada catatan" />}
        columns={[
          { key: 'ts', label: 'Waktu', sort: (e) => e.ts, render: (e) => <span className="text-xs whitespace-nowrap text-muted">{when(e.ts)}</span> },
          { key: 'username', label: 'Akun', render: (e) => <span className="font-medium">{e.username || '—'}</span> },
          { key: 'action', label: 'Aksi', search: (e) => `${e.action} ${t(LABEL[e.action] || '')}`, render: (e) => (
            <div>
              <div>{LABEL[e.action] ? t(LABEL[e.action]) : <span className="mono text-xs">{e.action}</span>}</div>
              {e.detail && <div className="mono mt-0.5 text-xs break-all text-muted">{e.detail}</div>}
            </div>) },
          { key: 'ok', label: 'Hasil', sort: (e) => e.ok, render: (e) => <Chip size="sm" variant="soft" color={e.ok ? 'success' : 'danger'}>{t(e.ok ? 'Berhasil' : 'Gagal')}</Chip> },
          { key: 'ip', label: 'IP', render: (e) => <span className="mono text-xs text-muted">{e.ip || '—'}</span> },
        ]} />
    </Panel>
  );
}

// Platform fees: the flat per-action schedule, the per-chain treasury the fee is sent to, and
// the revenue collected across all accounts. Superadmin only (the backend also enforces it).
const ACTION_LABELS = { open: 'Buka posisi', close: 'Tutup posisi', tp_sl: 'TP / SL otomatis', rebalance: 'Rebalance' };
function Fees() {
  const { t } = useI18n();
  const fees = usePoll('/api/admin/fees', 30000);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = draft || (fees.data && !fees.data.error ? {
    enabled: fees.data.enabled,
    schedule: { ...fees.data.schedule },
    referral_share: fees.data.referralShare,
    treasury: Object.fromEntries(fees.data.chains.map((k) => [k, { ...fees.data.treasury[k] }])),
  } : null);
  if (fees.data?.error) return <Panel title="Fee platform"><Notice status="warning">{t(fees.data.error)}</Notice></Panel>;
  if (!d) return <Panel title="Fee platform"><Loading /></Panel>;
  const set = (patch) => setDraft({ ...d, ...patch });
  const setFee = (k, v) => set({ schedule: { ...d.schedule, [k]: v } });
  const setTre = (k, field, v) => set({ treasury: { ...d.treasury, [k]: { ...d.treasury[k], [field]: v } } });
  const save = async () => {
    setBusy(true);
    const r = await post('/api/admin/fees', { enabled: d.enabled, schedule: d.schedule, referral_share: Number(d.referral_share), treasury: d.treasury });
    setBusy(false);
    if (r.error) return toast.danger(t(r.error));
    toast.success(t('Fee disimpan')); setDraft(null); fees.reload();
  };
  const rev = fees.data.revenue;
  const field = 'w-28 rounded-md border border-[var(--field-border)] bg-[var(--surface)] px-2 py-1 text-sm';
  const addr = 'flex-1 min-w-0 rounded-md border border-[var(--field-border)] bg-[var(--surface)] px-2 py-1 font-mono text-xs';
  return (
    <Panel title="Fee platform" desc={t('Fee rata per aksi, dibayar dalam koin native, dikirim ke treasury tiap chain. Hanya berlaku untuk akun pengguna (bukan superadmin).')}>
      <div className="flex flex-col gap-4 p-1">
        {rev && (
          <div className="flex flex-wrap gap-2 text-sm">
            <Chip color="success" variant="flat">{t('Terkumpul')}: ${rev.paidUsd.toFixed(2)} · {rev.paidCount}×</Chip>
            {rev.debtUsd > 0 && <Chip color="warning" variant="flat">{t('Utang')}: ${rev.debtUsd.toFixed(2)} · {rev.debtCount}×</Chip>}
            <Chip variant="flat">{t('{n} akun kena fee', { n: rev.accounts })}</Chip>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {t('Tagih fee (matikan untuk gratiskan semua aksi)')}
        </label>
        <div className="grid gap-2">
          {Object.keys(ACTION_LABELS).map((k) => (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className="w-40">{t(ACTION_LABELS[k])}</span>
              <span className="text-[var(--muted)]">$</span>
              <input className={field} type="number" step="0.01" min="0" value={d.schedule[k] ?? ''} disabled={!d.enabled}
                onChange={(e) => setFee(k, e.target.value === '' ? '' : Number(e.target.value))} />
            </div>
          ))}
          <p className="text-xs text-[var(--muted)]">{t('Collect fee, tambah likuiditas, dan compound selalu gratis.')}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="w-40">{t('Bagian referral')}</span>
          <input className={field} type="number" step="0.05" min="0" max="1" value={d.referral_share}
            onChange={(e) => set({ referral_share: e.target.value })} />
          <span className="text-[var(--muted)]">{t('(0–1, mis. 0.25 = 25%)')}</span>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('Treasury per chain')}</span>
          {Object.keys(d.treasury).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <span className="text-xs uppercase text-[var(--muted)]">{k}</span>
              <div className="flex gap-2">
                <input className={addr} placeholder={t('Alamat treasury 0x…')} value={d.treasury[k].address || ''} onChange={(e) => setTre(k, 'address', e.target.value)} />
                <input className={addr} placeholder={t('Referral 0x… (opsional)')} value={d.treasury[k].referral || ''} onChange={(e) => setTre(k, 'referral', e.target.value)} />
              </div>
            </div>
          ))}
          <p className="text-xs text-[var(--muted)]">{t('Tanpa alamat treasury, fee di chain itu tidak ditagih (gratis).')}</p>
        </div>
        <div className="flex gap-2">
          <Button color="primary" size="sm" isLoading={busy} onPress={save}>{t('Simpan')}</Button>
          {draft && <Button variant="flat" size="sm" onPress={() => setDraft(null)}>{t('Batal')}</Button>}
        </div>
      </div>
    </Panel>
  );
}

export default function Admin() {
  const { t } = useI18n();
  const me = useMe();
  const users = usePoll('/api/auth/users', 15000);
  const invites = usePoll('/api/auth/invites', 30000);
  const audit = usePoll('/api/auth/audit?limit=500', 30000);
  const reload = () => { users.reload(); invites.reload(); audit.reload(); };
  if (me && !isSuperadmin(me)) {
    return (<><PageHeader group="Sistem" title="Akun" /><Notice status="warning">{t('Halaman ini khusus superadmin.')}</Notice></>);
  }
  const err = users.data?.error || invites.data?.error;
  return (
    <>
      <PageHeader group="Sistem" title="Akun"
        desc="Kelola pengguna server ini. Tiap akun punya mesin, data, dan wallet sendiri; RPC di Pengaturan dipakai bersama semua akun." />
      {err ? <Notice status="danger">{t(err)}</Notice> : !users.data || !invites.data ? <Loading page /> : (
        <div className="flex flex-col gap-5">
          <Users users={users.data.users} maxUsers={users.data.maxUsers} me={me} reload={reload} />
          <Fees />
          <Invites invites={invites.data.invites} users={users.data.users} reload={reload} />
          {audit.data?.entries && <Audit entries={audit.data.entries} users={users.data.users} />}
        </div>
      )}
    </>
  );
}
