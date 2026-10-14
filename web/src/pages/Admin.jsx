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
  const regular = users.filter((u) => u.role !== 'superadmin').length;
  return (
    <Panel title="Akun" desc={maxUsers ? t('{n} dari {max} akun pengguna', { n: regular, max: maxUsers }) : null} bodyClass="p-0">
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
            <div className="flex justify-end">
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
  const link = `${location.origin}/register`;
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
            <p className="text-sm">{t('Kode ini hanya ditampilkan sekali. Kirim ke calon pengguna beserta tautan pendaftarannya.')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="mono rounded bg-default px-2 py-1 text-sm break-all">{fresh}</code>
              <Button size="sm" variant="outline" onPress={() => copy(fresh, t('Kode disalin'))}><Copy className="size-3.5" />{t('Salin kode')}</Button>
              <Button size="sm" variant="ghost" onPress={() => copy(`${link}\n${fresh}`, t('Tautan & kode disalin'))}>{t('Salin dengan tautan')}</Button>
            </div>
            <p className="mono mt-2 text-xs text-muted break-all">{link}</p>
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
          <Invites invites={invites.data.invites} users={users.data.users} reload={reload} />
          {audit.data?.entries && <Audit entries={audit.data.entries} users={users.data.users} />}
        </div>
      )}
    </>
  );
}
