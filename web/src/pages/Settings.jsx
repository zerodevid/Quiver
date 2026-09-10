import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, Checkbox, Separator, Tabs, toast } from '@heroui/react';
import { Pencil, Activity as Pulse, Trash2, KeyRound, Copy } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Loading, Notice, Text, Pick, Toggle } from '../components/ui';
import { num, locale as fmtLocale } from '../fmt';
import { useI18n, translate as tt } from '../i18n';

const amt = (v, d = 4) => (v == null ? '—' : Number(v).toLocaleString(fmtLocale(), { maximumFractionDigits: d }));

function Section({ title, desc, children }) {
  return (
    <div className="flex flex-col gap-5">
      <div><h2 className="text-lg font-semibold">{tt(title)}</h2>{desc && <p className="mt-1 text-sm text-muted">{typeof desc === 'string' ? tt(desc) : desc}</p>}</div>
      {children}
    </div>
  );
}
const say = (r, ok) => (r.error ? toast.danger(r.error) : toast.success(tt(ok)));

// ---------------- wallet & mode ----------------
function WalletTab({ d, reload }) {
  const { t } = useI18n();
  const { reload: reloadStatus } = useStatus();
  const w = d.wallet, m = d.mode;
  const [pk, setPk] = useState('');
  const [replace, setReplace] = useState(false);
  const [liveTxt, setLiveTxt] = useState('');
  const [rm, setRm] = useState('');
  const [busy, setBusy] = useState('');
  const act = async (key, url, body, ok) => {
    setBusy(key);
    const r = await post(url, body);
    setBusy('');
    say(r, typeof ok === 'function' ? ok(r) : ok);
    if (!r.error) { reload(); reloadStatus(); }
    return r;
  };
  return (
    <Section title="Wallet bot" desc={<>{t('Pakai wallet khusus bot, jangan wallet utama. Kunci privat disimpan di server')} (<span className="mono">{w.keyFile}</span>) {t('dan tidak pernah ditampilkan lagi.')}</>}>
      {w.address ? (
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <div className="sm:col-span-2"><dt className="text-xs text-muted">{t('Alamat')}</dt><dd className="mono mt-0.5 break-all">{w.address}</dd></div>
          <div><dt className="text-xs text-muted">{t('Izin berkas kunci')}</dt><dd className="mt-1">
            <Chip size="sm" variant="soft" color={w.perms === '600' ? 'success' : 'danger'}>{w.perms === '600' ? t('600 · aman') : t('{p} · terlalu longgar', { p: w.perms || '?' })}</Chip></dd></div>
          <div><dt className="text-xs text-muted">ETH</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.eth, 6)}</dd></div>
          <div><dt className="text-xs text-muted">USDG</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.usdg, 2)}</dd></div>
          <div><dt className="text-xs text-muted">WETH</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.weth, 6)}</dd></div>
        </dl>
      ) : <Notice>{t('Belum ada wallet terpasang. Bot hanya bisa berjalan dalam mode simulasi.')}</Notice>}

      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-medium">{t('Mode: {m}', { m: t(m.dry_run ? 'Simulasi' : 'Live') })}</div>
          <div className="text-sm text-muted">{t(m.dry_run ? 'Bot memutuskan dan mencatat, tapi tidak mengirim transaksi.' : 'Bot mengirim transaksi sungguhan dari wallet di atas.')}</div>
        </div>
        {m.dry_run ? (
          <div className="flex items-end gap-2">
            <Text placeholder="ketik LIVE" value={liveTxt} onChange={setLiveTxt} className="w-32" />
            <Button variant="danger" isDisabled={!w.address || liveTxt !== 'LIVE'} isPending={busy === 'live'}
              onPress={() => act('live', '/api/settings/live', { live: true, confirm: liveTxt }, 'Mode LIVE menyala')}>{t('Nyalakan LIVE')}</Button>
          </div>
        ) : (
          <Button variant="outline" isPending={busy === 'live'} onPress={() => act('live', '/api/settings/live', { live: false }, 'Kembali ke simulasi')}>{t('Kembali ke simulasi')}</Button>
        )}
      </div>

      <Separator />
      {!m.dry_run ? <Notice status="warning">{t('Matikan mode LIVE dulu untuk mengganti wallet.')}</Notice> : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="font-medium">{t('Impor kunci privat')}</div>
              <Text type="password" mono placeholder="0x… (64 karakter hex)" value={pk} onChange={setPk} autoComplete="off" />
              <Button variant="outline" className="w-fit" isDisabled={!pk} isPending={busy === 'imp'}
                onPress={async () => { const r = await act('imp', '/api/settings/wallet/import', { privateKey: pk, replace }, (x) => tt('Wallet {a} terpasang', { a: x.address })); if (!r.error) setPk(''); }}>
                <KeyRound className="size-4" />{t('Impor')}</Button>
            </div>
            <div className="flex flex-col gap-3">
              <div className="font-medium">{t('Buat wallet baru')}</div>
              <p className="text-sm text-muted">{t('Kunci dibuat di server. Frasa pemulihan disimpan di sebelah berkas kunci.')}</p>
              <Button variant="outline" className="w-fit" isPending={busy === 'gen'}
                onPress={() => act('gen', '/api/settings/wallet/generate', { replace }, (x) => tt('Wallet baru {a} dibuat', { a: x.address }))}>{t('Buat wallet')}</Button>
            </div>
          </div>
          <Checkbox isSelected={replace} onChange={setReplace}>
            <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              {t('Ganti kunci yang sudah ada — kunci lama dipindah ke berkas cadangan, tidak dihapus')}</Checkbox.Content>
          </Checkbox>
          {w.address && (
            <div className="flex flex-col gap-3 rounded-md border border-border p-4">
              <div className="font-medium">{t('Lepas wallet')}</div>
              <div className="flex flex-wrap items-end gap-2">
                <Text mono placeholder="ketik alamat wallet untuk konfirmasi" value={rm} onChange={setRm} className="min-w-72 flex-1" />
                <Button variant="danger" isDisabled={rm.toLowerCase() !== w.address} isPending={busy === 'rm'}
                  onPress={() => act('rm', '/api/settings/wallet/remove', { confirm: rm }, 'Wallet dilepas, kunci dicadangkan')}>{t('Lepas')}</Button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------- RPC ----------------
function Caps({ e }) {
  return (
    <div className="flex flex-wrap gap-1">
      {e.no_logs ? <Chip size="sm" variant="soft">{tt('tanpa getLogs')}</Chip>
        : e.max_log_blocks ? <Chip size="sm" variant="soft" color="warning">{tt('getLogs ≤ {n} blok', { n: num(e.max_log_blocks) })}</Chip>
        : <Chip size="sm" variant="soft" color="success">{tt('getLogs penuh')}</Chip>}
      {e.archive && <Chip size="sm" variant="soft" color="accent">{tt('arsip')}</Chip>}
      {e.secret && <Chip size="sm" variant="soft"><KeyRound className="size-3" />{tt('API key')}</Chip>}
    </div>
  );
}

function RpcRow({ e, onSave, onDelete }) {
  const { t } = useI18n();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(e);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => { setTesting(true); setTest(await post('/api/settings/rpc/test', { id: e.id })); setTesting(false); };
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="mono break-all">{e.url}</div>
          {e.headers && <div className="mono mt-0.5 text-xs text-muted">{Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>}
          <div className="mt-2"><Caps e={e} /></div>
          {test && <div className={`mt-2 text-sm ${test.usable ? 'text-success' : 'text-danger'}`}>{test.error || test.summary}</div>}
        </div>
        <div className="num w-40 shrink-0 text-right text-sm">
          <div>{e.lastMs ? `${e.lastMs} ms` : '—'}</div>
          <div className="whitespace-nowrap text-xs text-muted">{t('{n} panggilan · {e} err', { n: num(e.calls), e: e.errors })}</div>
          {e.cooling && <div className="text-xs text-warning">{t('istirahat')}</div>}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant={edit ? 'secondary' : 'ghost'} isIconOnly aria-label={t('Ubah')} onPress={() => setEdit(!edit)}><Pencil className="size-4" /></Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Uji')} isPending={testing} onPress={runTest}><Pulse className="size-4" /></Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Hapus')} onPress={() => onDelete(e.id)}><Trash2 className="size-4 text-danger" /></Button>
        </div>
      </div>
      {edit && (
        <div className="grid items-end gap-4 rounded-md bg-surface-secondary p-4 md:grid-cols-4">
          <Toggle label="Tanpa getLogs" value={f.no_logs} onChange={(v) => setF({ ...f, no_logs: v })} />
          <Text label="Batas rentang getLogs" type="number" hint="0 = tanpa batas" value={String(f.max_log_blocks || 0)} onChange={(v) => setF({ ...f, max_log_blocks: Number(v) || 0 })} />
          <Toggle label="Node arsip" value={f.archive} onChange={(v) => setF({ ...f, archive: v })} />
          <Button onPress={() => { onSave(f); setEdit(false); }}>{t('Simpan')}</Button>
        </div>
      )}
    </div>
  );
}

function RpcTab({ d, setD }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('none');
  const [hname, setHname] = useState('');
  const [key, setKey] = useState('');
  const [tested, setTested] = useState(null);
  const [testing, setTesting] = useState(false);
  const reset = () => setTested(null);

  const current = () => d.rpc.map((e) => ({ id: e.id, no_logs: e.no_logs, max_log_blocks: e.max_log_blocks, archive: e.archive, max_batch: e.max_batch }));
  const saveList = async (endpoints, ok) => {
    const r = await post('/api/settings/rpc', { endpoints });
    say(r, ok);
    if (!r.error) setD({ ...d, rpc: r.rpc });
    return r;
  };
  const draft = () => {
    let headers = null;
    if (auth === 'x-api-key' && key) headers = { 'x-api-key': key };
    if (auth === 'bearer' && key) headers = { authorization: 'Bearer ' + key };
    if (auth === 'custom' && key && hname) headers = { [hname]: key };
    return { url: url.trim(), headers };
  };
  const runTest = async () => {
    setTesting(true);
    const r = await post('/api/settings/rpc/test', draft());
    setTesting(false);
    setTested(r.error || !r.usable ? { bad: true, msg: r.error || r.summary } : { ...draft(), ...r.suggest, summary: r.summary });
  };
  const add = async () => {
    const r = await saveList([...current(), { url: tested.url, headers: tested.headers || undefined, no_logs: tested.no_logs,
      max_log_blocks: tested.max_log_blocks, archive: tested.archive, max_batch: 40 }], 'Endpoint ditambahkan dan langsung dipakai');
    if (!r.error) { setUrl(''); setKey(''); setHname(''); setTested(null); }
  };

  return (
    <Section title="Endpoint RPC" desc="Permintaan dibagi otomatis: getLogs hanya ke endpoint yang sanggup, pembacaan state lampau hanya ke endpoint arsip, sisanya ke yang paling senggang. Perubahan berlaku tanpa restart.">
      <div className="divide-y divide-border rounded-md border border-border px-4">
        {d.rpc.map((e) => (
          <RpcRow key={e.id + e.url} e={e}
            onSave={(f) => saveList(current().map((x) => (x.id === e.id ? { ...x, ...f, id: e.id } : x)), 'Endpoint diperbarui')}
            onDelete={(id) => { if (confirm(t('Hapus endpoint ini?'))) saveList(current().filter((x) => x.id !== id), 'Endpoint dihapus'); }} />
        ))}
      </div>

      <Separator />
      <div className="font-medium">{t('Tambah endpoint')}</div>
      <div className="grid gap-4 md:grid-cols-2">
        <Text label="URL" mono placeholder="https://…" value={url} onChange={(v) => { setUrl(v); reset(); }}
          hint="Kalau API key bagian dari URL (mis. Alchemy, Ankr), tempel URL lengkapnya — tetap disamarkan di tampilan." />
        <Pick label="Autentikasi" value={auth} onChange={(v) => { setAuth(v); reset(); }}
          options={[['none', 'Tanpa header / key di URL'], ['x-api-key', 'Header x-api-key'], ['bearer', 'Header Authorization: Bearer'], ['custom', 'Header lain…']]} />
        {auth === 'custom' && <Text label="Nama header" mono placeholder="mis. x-token" value={hname} onChange={(v) => { setHname(v); reset(); }} />}
        {auth !== 'none' && <Text label="API key" type="password" mono autoComplete="off" value={key} onChange={(v) => { setKey(v); reset(); }} />}
      </div>
      {tested && (tested.bad
        ? <Notice status="danger" title="Tidak bisa dipakai">{tested.msg}</Notice>
        : <Notice status="success" title={tested.summary}><span className="mr-2">{t('Bendera yang akan dipasang:')}</span><span className="inline-flex align-middle"><Caps e={{ ...tested, secret: !!tested.headers }} /></span></Notice>)}
      <div className="flex gap-2">
        <Button variant="outline" isDisabled={!url.trim()} isPending={testing} onPress={runTest}>{t('Uji dulu')}</Button>
        <Button isDisabled={!tested || tested.bad} onPress={add}>{t('Tambah')}</Button>
      </div>
    </Section>
  );
}

// ---------------- form sederhana ----------------
function SimpleForm({ title, desc, fields, initial, url, okText, extra }) {
  const { t } = useI18n();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); say(await post(url, v), okText); setBusy(false); };
  return (
    <Section title={title} desc={desc}>
      <div className="grid gap-5 md:grid-cols-2">
        {fields.map(([k, label, hint, type]) => (type === 'bool'
          ? <Toggle key={k} label={label} desc={hint} value={v[k]} onChange={(x) => setV({ ...v, [k]: x })} />
          : <Text key={k} label={label} hint={hint} type={type || 'number'} mono={type === 'text'} value={String(v[k] ?? '')} onChange={(x) => setV({ ...v, [k]: x })} />))}
      </div>
      <div className="flex gap-2"><Button onPress={save} isPending={busy}>{t('Simpan')}</Button>{extra}</div>
    </Section>
  );
}

function SecurityTab() {
  const { t } = useI18n();
  const [tok, setTok] = useState(null);
  const rotate = async () => {
    if (!confirm(t('Ganti token akses? Perangkat lain harus masuk ulang.'))) return;
    const r = await post('/api/settings/token/rotate', {});
    if (r.error) return toast.danger(r.error);
    setTok(r.token);
  };
  return (
    <Section title="Keamanan" desc="Dasbor ini bisa menyalakan LIVE dan menutup posisi, jadi dilindungi token akses.">
      <div>
        <div className="font-medium">{t('Ganti token akses')}</div>
        <p className="mb-3 mt-1 text-sm text-muted">{t('Token lama langsung tidak berlaku; perangkat lain harus masuk ulang. Browser ini tetap masuk.')}</p>
        <Button variant="danger" onPress={rotate}>{t('Buat token baru')}</Button>
      </div>
      {tok && (
        <Card variant="secondary"><Card.Content className="gap-2">
          <div className="text-sm font-medium">{t('Token baru — simpan sekarang, tidak akan ditampilkan lagi')}</div>
          <div className="flex items-center gap-2"><code className="mono flex-1 break-all rounded bg-surface px-3 py-2">{tok}</code>
            <Button variant="outline" onPress={() => { navigator.clipboard?.writeText(tok); toast.success(t('Tersalin')); }}><Copy className="size-4" />{t('Salin')}</Button></div>
        </Card.Content></Card>
      )}
    </Section>
  );
}

export default function Settings() {
  const { t } = useI18n();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('wallet');
  const load = useCallback(() => get('/api/settings').then(setD), []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader group="Sistem" title="Pengaturan" />
      {!d ? <Loading /> : (
        <Card>
          <Card.Content>
            <Tabs selectedKey={tab} onSelectionChange={setTab} orientation="vertical" variant="secondary" className="flex flex-col gap-6 md:flex-row">
              <Tabs.ListContainer className="md:w-48 md:shrink-0">
                <Tabs.List aria-label={t('Bagian pengaturan')}>
                  {[['wallet', 'Wallet & mode'], ['rpc', 'RPC'], ['gas', 'Gas'], ['notify', 'Notifikasi'], ['loop', 'Mesin'], ['security', 'Keamanan']].map(([id, label]) => (
                    <Tabs.Tab key={id} id={id} className="justify-start">{t(label)}<Tabs.Indicator /></Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
              <div className="min-w-0 flex-1">
                <Tabs.Panel id="wallet"><WalletTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="rpc"><RpcTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="gas">
                  <SimpleForm title="Gas" desc="Berlaku untuk transaksi berikutnya, tanpa restart." url="/api/settings/gas" okText="Pengaturan gas tersimpan"
                    initial={d.gas} fields={[
                      ['price_multiplier', 'Pengali harga gas', 'Harga gas jaringan × angka ini. 1,5 = 50% di atas harga saat itu.'],
                      ['priority_gwei', 'Priority fee (gwei)'],
                      ['max_gas_limit', 'Batas gas per transaksi'],
                      ['reserve_eth', 'Cadangan ETH untuk gas', 'ETH sebanyak ini tidak pernah dipakai untuk LP maupun swap.'],
                    ]} />
                </Tabs.Panel>
                <Tabs.Panel id="notify">
                  <SimpleForm title="Notifikasi" url="/api/settings/notify" okText="Topik tersimpan" initial={d.notify}
                    desc="Kabar tiap posisi disalin atau ditutup, lewat ntfy.sh. Pasang aplikasi ntfy di HP lalu langganan topik yang sama."
                    fields={[['ntfy_topic', 'Topik ntfy', 'Siapa pun yang tahu nama topiknya bisa membaca notifikasinya — pakai nama yang sulit ditebak. Kosongkan untuk mematikan.', 'text']]}
                    extra={<Button variant="outline" onPress={async () => say(await post('/api/settings/notify/test', {}), 'Notifikasi uji terkirim')}>{t('Kirim uji')}</Button>} />
                </Tabs.Panel>
                <Tabs.Panel id="loop">
                  <SimpleForm title="Mesin" desc="Berlaku setelah bot di-restart (pm2 restart lpcopy)." url="/api/settings/loop" okText="Tersimpan — restart bot supaya berlaku"
                    initial={{ ...d.loop, ...d.prices }} fields={[
                      ['poll_ms', 'Interval pindai (ms)', 'Seberapa sering blok baru diperiksa.'],
                      ['max_block_span', 'Blok per pindai', 'Maks 3.000 — batas getLogs endpoint arsip.'],
                      ['sync_seconds', 'Sinkron posisi (detik)'],
                      ['eth_usd', 'Harga ETH cadangan (USD)', 'Dipakai hanya kalau harga dari pool ETH/USDG gagal dibaca.'],
                      ['auto_eth_price', 'Ambil harga ETH dari chain', null, 'bool'],
                    ]} />
                </Tabs.Panel>
                <Tabs.Panel id="security"><SecurityTab /></Tabs.Panel>
              </div>
            </Tabs>
          </Card.Content>
        </Card>
      )}
    </>
  );
}
