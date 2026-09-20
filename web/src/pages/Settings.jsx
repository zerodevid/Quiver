import { chainInfo } from '../chain';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, Checkbox, Separator, Tabs, toast } from '@heroui/react';
import { Pencil, Activity as Pulse, Trash2, KeyRound, Unlock, ChevronUp, ChevronDown, Copy, Wallet, Network, Fuel, Bell, MessageCircle, Settings2, ShieldCheck, ShieldAlert, ChartCandlestick } from 'lucide-react';
import { Wallet as EthersWallet } from 'ethers';
import SettingInfo from '../components/SettingInfo';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Loading, Notice, Text, Pick, Toggle, ask } from '../components/ui';
import { num, usd, locale as fmtLocale } from '../fmt';
import { useI18n, translate as tt } from '../i18n';

const amt = (v, d = 4) => (v == null ? '—' : Number(v).toLocaleString(fmtLocale(), { maximumFractionDigits: d }));

const SETTINGS_NAV = [
  ['wallet', 'Wallet & mode', 'Dana dan mode transaksi', Wallet],
  ['risk', 'Drawdown harian', 'Jeda otomatis kalau rugi kebablasan', ShieldAlert],
  ['rpc', 'RPC', 'Koneksi ke jaringan', Network],
  ['gas', 'Gas', 'Biaya dan cadangan transaksi', Fuel],
  ['notify', 'Notifikasi', 'Kabar ke ponsel lewat ntfy', Bell],
  ['telegram', 'Telegram', 'Hubungkan bot dan chat', MessageCircle],
  ['gmgn', 'GMGN', 'API key untuk lilin harga GMGN', ChartCandlestick],
  ['loop', 'Mesin', 'Pemindaian dan harga ETH', Settings2],
  ['security', 'Keamanan', 'Akses masuk dasbor', ShieldCheck],
];

function Section({ title, desc, children }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="border-b border-border pb-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold tracking-tight">{tt(title)}</h2>{desc && <SettingInfo title={title}>{desc}</SettingInfo>}</div>{desc && <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">{typeof desc === 'string' ? tt(desc) : desc}</p>}</div>
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
  const [expToken, setExpToken] = useState('');
  const [expPass, setExpPass] = useState('');
  const [expPass2, setExpPass2] = useState('');
  const [ksFile, setKsFile] = useState(null);
  const [ksPass, setKsPass] = useState('');
  const [ksBusy, setKsBusy] = useState(false);
  const [ksResult, setKsResult] = useState(null);
  const act = async (key, url, body, ok) => {
    setBusy(key);
    const r = await post(url, body);
    setBusy('');
    say(r, typeof ok === 'function' ? ok(r) : ok);
    if (!r.error) { reload(); reloadStatus(); }
    return r;
  };
  return (
    <Section title="Wallet bot" desc={<>{t('Pakai wallet khusus bot, jangan wallet utama. Kunci privat disimpan di server')} (<span className="mono">{w.fromEnv ? `.env · ${w.fromEnv}` : w.keyFile}</span>) {t('dan tidak pernah dikirim mentah — cuma bisa diekspor sebagai keystore terenkripsi.')}</>}>
      {w.address ? (
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <div className="sm:col-span-2"><dt className="text-xs text-muted">{t('Alamat')}</dt><dd className="mono mt-0.5 break-all">{w.address}</dd></div>
          <div><dt className="text-xs text-muted">{t('Izin berkas kunci')}</dt><dd className="mt-1">
            {w.fromEnv
              ? <Chip size="sm" variant="soft" color="success">{t('dari .env')}</Chip>
              : <Chip size="sm" variant="soft" color={w.perms === '600' ? 'success' : 'danger'}>{w.perms === '600' ? t('600 · aman') : t('{p} · terlalu longgar', { p: w.perms || '?' })}</Chip>}</dd></div>
          <div><dt className="text-xs text-muted">{w.balances?.symbols?.eth || chainInfo().nativeSymbol}</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.eth, 6)}</dd></div>
          <div><dt className="text-xs text-muted">{w.balances?.symbols?.usdg || chainInfo().usdgSymbol}</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.usdg, 2)}</dd></div>
          <div><dt className="text-xs text-muted">{w.balances?.symbols?.weth || chainInfo().wethSymbol}</dt><dd className="num mt-0.5 font-medium">{amt(w.balances?.weth, 6)}</dd></div>
        </dl>
      ) : <Notice>{t('Belum ada wallet terpasang. Bot hanya bisa berjalan dalam mode simulasi.')}</Notice>}

      {w.address && (
        <>
          <Separator />
          <div className="flex flex-col gap-3 rounded-md border border-border p-4">
            <div className="font-medium">{t('Ekspor wallet')}</div>
            <p className="text-sm text-muted">
              {t('Menghasilkan berkas keystore terenkripsi (format sama dengan geth/MetaMask) yang bisa diimpor ke wallet lain lewat "Import via JSON". Kunci privat mentah tidak pernah dikirim — tanpa password di bawah, isi berkasnya tidak berguna. Butuh token dashboard, diketik ulang di sini, bukan diambil dari sesi login.')}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Text label="Token dashboard" type="password" mono placeholder="token" value={expToken} onChange={setExpToken} autoComplete="off" />
              <Text label="Password keystore baru" type="password" placeholder="min. 8 karakter" value={expPass} onChange={setExpPass} autoComplete="off" />
              <Text label="Ulangi password" type="password" placeholder="min. 8 karakter" value={expPass2} onChange={setExpPass2} autoComplete="off" />
            </div>
            <Button variant="outline" className="w-fit" isDisabled={!expToken || expPass.length < 8 || expPass !== expPass2} isPending={busy === 'exp'}
              onPress={async () => {
                setBusy('exp');
                const r = await post('/api/settings/wallet/export', { token: expToken, password: expPass });
                setBusy('');
                setExpToken(''); setExpPass(''); setExpPass2('');
                if (r.error) { toast.danger(r.error); return; }
                const blob = new Blob([JSON.stringify(r.keystore, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `quiver-${r.address.slice(0, 8)}-keystore.json`;
                document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
                toast.success(tt('Keystore terunduh — simpan berkas dan password-nya di tempat aman.'));
              }}>
              <KeyRound className="size-4" />{t('Unduh keystore')}</Button>
          </div>
        </>
      )}

      <Separator />
      <div className="flex flex-col gap-3 rounded-md border border-border p-4">
        <div className="font-medium">{t('Buka keystore (offline)')}</div>
        <p className="text-sm text-muted">
          {t('Buat wallet yang cuma terima kunci privat mentah (mis. OKX Wallet), bukan file keystore — dekripsi berkas keystore di sini. Ini berjalan sepenuhnya di peramban kamu, dihitung di komputer sendiri; berkas dan password TIDAK dikirim ke server Quiver atau ke mana pun.')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">{t('Berkas keystore (.json)')}</label>
            <input type="file" accept=".json,application/json" className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => { setKsFile(e.target.files?.[0] || null); setKsResult(null); }} />
          </div>
          <Text label="Password keystore" type="password" placeholder="password saat mengekspor" value={ksPass} onChange={setKsPass} autoComplete="off" />
        </div>
        <Button variant="outline" className="w-fit" isDisabled={!ksFile || !ksPass} isPending={ksBusy}
          onPress={async () => {
            setKsBusy(true); setKsResult(null);
            try {
              const text = await ksFile.text();
              const w = await EthersWallet.fromEncryptedJson(text, ksPass);
              setKsResult({ address: w.address, pk: w.privateKey });
            } catch (e) {
              toast.danger(e.shortMessage || e.message || tt('Gagal membuka keystore.'));
            } finally { setKsBusy(false); setKsPass(''); }
          }}>
          <Unlock className="size-4" />{t('Buka')}</Button>
        {ksResult && (
          <div className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/5 p-3">
            <p className="text-xs font-medium text-danger">{t('Jangan discreenshot atau disalin ke aplikasi catatan. Tutup setelah dipakai.')}</p>
            <div><dt className="text-xs text-muted">{t('Alamat')}</dt><dd className="mono mt-0.5 break-all text-sm">{ksResult.address}</dd></div>
            <div><dt className="text-xs text-muted">{t('Kunci privat')}</dt><dd className="mono mt-0.5 break-all text-sm">{ksResult.pk}</dd></div>
            <Button size="sm" variant="outline" className="w-fit" onPress={() => { navigator.clipboard?.writeText(ksResult.pk); toast.success(tt('Kunci privat disalin.')); }}>
              <Copy className="size-4" />{t('Salin kunci privat')}</Button>
            <Button size="sm" variant="ghost" className="w-fit" onPress={() => { setKsResult(null); setKsFile(null); }}>{t('Tutup')}</Button>
          </div>
        )}
      </div>

      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-medium">{t('Mode: {m}', { m: t(m.dry_run ? 'Simulasi' : 'Live') })}</div>
          <div className="text-sm text-muted">{t(m.dry_run ? 'Bot memutuskan dan mencatat, tapi tidak mengirim transaksi.' : 'Bot mengirim transaksi sungguhan dari wallet di atas.')}</div>
        </div>
        {m.dry_run ? (
          <div className="flex flex-wrap items-end gap-2">
            <Text label="Konfirmasi LIVE" placeholder="ketik LIVE" value={liveTxt} onChange={setLiveTxt} className="w-32" />
            <Button variant="danger" isDisabled={!w.address || liveTxt !== 'LIVE'} isPending={busy === 'live'}
              onPress={() => act('live', '/api/settings/live', { live: true, confirm: liveTxt }, 'Mode LIVE menyala')}>{t('Nyalakan LIVE')}</Button>
          </div>
        ) : (
          <Button variant="outline" isPending={busy === 'live'} onPress={() => act('live', '/api/settings/live', { live: false }, 'Kembali ke simulasi')}>{t('Kembali ke simulasi')}</Button>
        )}
      </div>

      <Separator />
      {w.fromEnv ? <EnvNotice name={w.fromEnv} what="Kunci wallet" />
        : !m.dry_run ? <Notice status="warning">{t('Matikan mode LIVE dulu untuk mengganti wallet.')}</Notice> : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="font-medium">{t('Impor kunci privat')}</div>
              <Text label="Kunci privat" type="password" mono placeholder="0x… (64 karakter hex)" value={pk} onChange={setPk} autoComplete="off" />
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
                <Text label="Konfirmasi alamat wallet" mono placeholder="ketik alamat wallet untuk konfirmasi" value={rm} onChange={setRm} className="w-full min-w-0 flex-1" />
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

// ---------------- drawdown harian ----------------
function RiskTab({ d, setD }) {
  const { t } = useI18n();
  const st = d.risk?.status || {};
  const saved = String(d.risk?.max_daily_drawdown_pct ?? 0);
  const [pct, setPct] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = pct !== saved;
  const save = async (event) => {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true); setError('');
    const r = await post('/api/settings/risk', { max_daily_drawdown_pct: pct });
    setBusy(false);
    if (r.error) return setError(r.error);
    setPct(String(r.max_daily_drawdown_pct));
    setD((prev) => ({ ...prev, risk: { ...prev.risk, max_daily_drawdown_pct: r.max_daily_drawdown_pct } }));
    toast.success(t('Batas drawdown tersimpan'));
  };
  const ddNow = st.peakUsd > 0 ? Math.max(0, ((st.peakUsd - (st.equityUsd ?? st.peakUsd)) / st.peakUsd) * 100) : null;
  return (
    <Section title="Drawdown harian" desc="Jeda ENTRY baru kalau ekuitas hari ini turun terlalu jauh dari puncaknya. Bukan penutup posisi paksa: posisi yang sudah terbuka tetap dikelola dan bisa keluar seperti biasa (stop loss, ikut target, dst). Breaker direset otomatis begitu hari berganti.">
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="flex items-start gap-1 rounded-xl border border-border bg-surface-secondary/30 p-4 md:max-w-sm">
          <div className="min-w-0 flex-1">
            <Text label="Batas drawdown harian (%, 0=mati)" type="number" value={pct} onChange={setPct} isDisabled={busy} />
            <p className="mt-2 text-xs text-muted">{t('0 = nonaktif')}</p>
          </div>
          <SettingInfo title="Batas drawdown harian">
            {t('Dihitung dari puncak ekuitas (kas + posisi + fee belum diklaim) sejak awal hari — zona waktu diatur di tab Telegram, kosong = zona server. Begitu ekuitas turun sebesar persentase ini dari puncaknya, entry baru dijeda sampai hari berganti. Diperiksa tiap kali ekuitas dicatat (interval "Sinkron ekuitas" di tab Mesin), bukan seketika.')}
          </SettingInfo>
        </div>
        {error && <div role="alert"><Notice status="danger">{error}</Notice></div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span role="status" className="text-sm text-muted">{t(dirty ? 'Ada perubahan belum disimpan' : 'Semua perubahan tersimpan')}</span>
          <div className="flex gap-2">
            {dirty && <Button variant="ghost" isDisabled={busy} onPress={() => { setPct(saved); setError(''); }}>{t('Batal')}</Button>}
            <Button type="submit" isDisabled={!dirty || busy} isPending={busy}>{t('Simpan perubahan')}</Button>
          </div>
        </div>
      </form>

      <Separator />
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        <div><dt className="text-xs text-muted">{t('Ekuitas sekarang')}</dt><dd className="num mt-0.5 font-medium">{usd(st.equityUsd)}</dd></div>
        <div><dt className="text-xs text-muted">{t('Puncak hari ini')}</dt><dd className="num mt-0.5 font-medium">{st.peakUsd != null ? usd(st.peakUsd) : '—'}</dd></div>
        <div><dt className="text-xs text-muted">{t('Turun dari puncak')}</dt><dd className="num mt-0.5 font-medium">{ddNow != null ? `${ddNow.toFixed(1)}%` : '—'}</dd></div>
      </dl>
      {st.enabled && st.tripped && (
        <div className="mt-4"><Notice status="warning">{t('Batas tersentuh hari ini — entry baru dijeda sampai besok. Posisi yang sudah ada tetap dikelola seperti biasa.')}</Notice></div>
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

// `rank`/`total` = urutan prioritas; onMove(-1|+1) menggeser naik/turun. Yang teratas
// dipakai lebih dulu, sisanya cadangan berurutan (lihat rpc.js usable()).
function RpcRow({ e, rank, total, onSave, onDelete, onMove }) {
  const { t } = useI18n();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(e);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => { setTesting(true); setTest(await post('/api/settings/rpc/test', { id: e.id })); setTesting(false); };
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Naikkan prioritas')} isDisabled={rank === 0} onPress={() => onMove(-1)}><ChevronUp className="size-4" /></Button>
          <span className="num text-xs text-muted" title={rank === 0 ? t('Prioritas utama') : t('Cadangan ke-{n}', { n: rank })}>#{rank + 1}</span>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Turunkan prioritas')} isDisabled={rank === total - 1} onPress={() => onMove(1)}><ChevronDown className="size-4" /></Button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mono break-all">{e.url}</div>
          {rank === 0 && <div className="mt-0.5 text-xs text-accent">{t('Prioritas utama — dipakai lebih dulu selama sehat')}</div>}
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
    <Section title="Endpoint RPC" desc="Urutan = prioritas: yang teratas dipakai lebih dulu, yang di bawahnya cadangan saat ia gagal atau istirahat (429). getLogs hanya ke endpoint yang sanggup, pembacaan state lampau hanya ke endpoint arsip. Perubahan berlaku tanpa restart.">
      <div className="divide-y divide-border rounded-md border border-border px-4">
        {d.rpc.map((e, i) => (
          <RpcRow key={e.id + e.url} e={e} rank={i} total={d.rpc.length}
            onMove={(dir) => { const l = current(); const j = i + dir; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; saveList(l, dir < 0 ? 'Prioritas dinaikkan' : 'Prioritas diturunkan'); }}
            onSave={(f) => saveList(current().map((x) => (x.id === e.id ? { ...x, ...f, id: e.id } : x)), 'Endpoint diperbarui')}
            onDelete={async (id) => { if (await ask({ title: t('Hapus endpoint ini?'), confirm: t('Hapus'), danger: true })) saveList(current().filter((x) => x.id !== id), 'Endpoint dihapus'); }} />
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
function SimpleForm({ title, desc, fields, initial, url, okText, extra, envName, onSaved }) {
  const { t } = useI18n();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = fields.some(([k]) => String(v[k] ?? '') !== String(saved[k] ?? ''));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = async (event) => {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true); setError('');
    try {
      const r = await post(url, v);
      if (r.error) { setError(r.error); return; }
      setSaved({ ...v }); onSaved?.(v); toast.success(t(okText));
    } catch { setError(t('Tidak dapat menyimpan. Periksa koneksi lalu coba lagi.')); }
    finally { setBusy(false); }
  };
  return (
    <Section title={title} desc={desc}>
      {envName && <EnvNotice name={envName} what={title} />}
      <form onSubmit={save} className="flex flex-col gap-5">
        <fieldset disabled={busy} className="grid min-w-0 gap-4 md:grid-cols-2">
          {fields.map(([k, label, hint, type]) => (
            <div key={k} className="flex items-start gap-1 rounded-xl border border-border bg-surface-secondary/30 p-4">
              <div className="min-w-0 flex-1">{type === 'bool'
                ? <Toggle label={label} value={v[k]} onChange={(x) => setV({ ...v, [k]: x })} isDisabled={!!envName || busy} />
                : <Text label={label} type={type || 'number'} mono={type === 'text'} value={String(v[k] ?? '')} onChange={(x) => setV({ ...v, [k]: x })} isDisabled={!!envName || busy} />}</div>
              {hint && <SettingInfo title={label}>{hint}</SettingInfo>}
            </div>
          ))}
        </fieldset>
        {error && <div role="alert"><Notice status="danger">{error}</Notice></div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span role="status" className="text-sm text-muted">{t(envName ? 'Diatur oleh server' : dirty ? 'Ada perubahan belum disimpan' : 'Semua perubahan tersimpan')}</span>
          <div className="flex flex-wrap gap-2">{!envName && <>
            {dirty && <Button variant="ghost" isDisabled={busy} onPress={() => { setV({ ...saved }); setError(''); }}>{t('Batal')}</Button>}
            <Button type="submit" isDisabled={!dirty || busy} isPending={busy}>{t('Simpan perubahan')}</Button>
          </>}{extra}</div>
        </div>
      </form>
    </Section>
  );
}

// Kolom yang diatur lewat .env: dasbor menolak mengubahnya (akan tertimpa lagi saat
// restart), jadi yang ditampilkan adalah di mana mengubahnya.
function EnvNotice({ name, what }) {
  const { t } = useI18n();
  return (
    <Notice>
      {t('{what} diatur lewat', { what: t(what) })} <span className="mono">{name}</span> {t('di berkas .env server. Ubah di sana lalu restart bot.')}
    </Notice>
  );
}

// ---------------- OpenAPI GMGN ----------------
// Key dipakai server untuk menarik lilin harga versi GMGN (tab Chart, sumber "GMGN")
// — data yang sama dengan chart gmgn.ai, digambar di chart kita supaya rentang
// posisi bot ikut tergambar. Tidak dikirim utuh ke peramban.
function GmgnTab({ d, reload }) {
  const { t } = useI18n();
  const g = d.gmgn || {};
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);
  const save = async (k, body, ok) => {
    setBusy(k);
    const r = await post('/api/settings/gmgn', body);
    setBusy('');
    say(r, ok);
    if (!r.error) { setKey(''); setTest(null); reload(); }
    return r;
  };
  const probe = async () => {
    setBusy('test'); setTest(null);
    const r = await post('/api/settings/gmgn/test', {});
    setBusy('');
    setTest(r.error ? { ok: false, text: r.error } : { ok: true, text: r.summary });
  };
  return (
    <Section title="OpenAPI GMGN" desc="Lilin harga versi GMGN untuk tab Chart di halaman posisi dan pool — data yang sama dengan chart gmgn.ai, tetapi digambar di sini supaya rentang posisi, harga masuk, dan BEP ikut tergambar otomatis. Pita transaksi tetap dari GeckoTerminal (GMGN tidak menyediakannya).">
      <div className="flex flex-wrap items-center gap-3">
        <Chip size="sm" variant="soft" color={g.hasKey ? 'success' : 'default'}>{g.hasKey ? t('key terpasang') : t('belum diisi')}</Chip>
        {g.hasKey && <span className="mono text-sm text-muted">{g.key}</span>}
      </div>

      <Separator />
      {g.fromEnv ? <EnvNotice name={g.fromEnv} what="API key GMGN" /> : <div className="grid gap-5 md:grid-cols-2">
        <Text label="API key GMGN" type="password" mono value={key} onChange={setKey}
          placeholder={g.key || 'gmgn_…'}
          hint={t('Buat di gmgn.ai/ai (menu API Key). Formulirnya meminta public key Ed25519 — itu hanya untuk endpoint trading; untuk membaca lilin tidak dipakai. Paket gratis ±1 permintaan/detik; server menyimpan jawabannya supaya semua tab berbagi satu tarikan.')} />
        <div className="flex flex-wrap items-end gap-2">
          <Button onPress={() => save('key', { api_key: key }, 'API key tersimpan — sumber GMGN tersedia di tab Chart')} isPending={busy === 'key'} isDisabled={!key}>{t('Simpan key')}</Button>
          {g.hasKey && <Button variant="outline" onPress={probe} isPending={busy === 'test'}>{t('Uji key')}</Button>}
          {g.hasKey && <Button variant="outline" onPress={async () => { if (await ask({ title: t('Lepas API key GMGN? Tab Chart kembali ke GeckoTerminal.'), confirm: t('Lepas'), danger: true })) save('rm', { api_key: '' }, 'API key dilepas'); }}>{t('Lepas')}</Button>}
        </div>
      </div>}
      {test && <Notice status={test.ok ? 'success' : 'danger'}>{test.text}</Notice>}

      <Separator />
      <div className="text-sm text-muted">
        <div className="mb-1 font-medium text-foreground">{t('Cara membuat key')}</div>
        <ol className="list-decimal space-y-1 pl-5">
          <li>{t('Masuk ke')} <a href="https://gmgn.ai/ai" target="_blank" rel="noreferrer" className="text-accent hover:underline">gmgn.ai/ai</a> {t('dengan akun GMGN, buka bagian API Key.')}</li>
          <li>{t('Formulir meminta public key Ed25519. Buat pasangan kunci di komputer sendiri:')} <span className="mono">openssl genpkey -algorithm ed25519 -out gmgn.pem && openssl pkey -in gmgn.pem -pubout</span></li>
          <li>{t('Tempel public key-nya, simpan, lalu salin API key yang diberikan ke kolom di atas. Private key (gmgn.pem) tidak perlu dipasang di bot — hanya dibutuhkan untuk trading lewat API.')}</li>
        </ol>
      </div>
    </Section>
  );
}

// ---------------- bot Telegram ----------------
function TelegramTab({ d, reload }) {
  const { t } = useI18n();
  const tg = d.telegram || {};
  const [tok, setTok] = useState('');
  const [pair, setPair] = useState(tg.pair || null);
  const [busy, setBusy] = useState('');
  const save = async (key, body, ok) => {
    setBusy(key);
    const r = await post('/api/settings/telegram', body);
    setBusy('');
    say(r, ok);
    if (!r.error) { setTok(''); reload(); }
    return r;
  };
  const makeCode = async () => {
    setBusy('pair');
    const r = await post('/api/settings/telegram/pair', {});
    setBusy('');
    if (r.error) return toast.danger(r.error);
    setPair(r);
  };
  const NOTIF = [
    ['penting', 'Kabar penting (LP disalin / ditutup)'],
    ['error', 'Galat'],
    ['warn', 'Peringatan'],
    ['info', 'Semua baris log'],
  ];
  return (
    <Section title="Bot Telegram" desc="Kendalikan bot ini dari Telegram: semua yang bisa dilakukan dasbor, bisa dilakukan lewat obrolan.">
      <div className="flex flex-wrap items-center gap-3">
        <Chip size="sm" variant="soft" color={tg.running ? 'success' : tg.hasToken ? 'warning' : 'default'}>
          {tg.running ? t('jalan') : tg.hasToken ? t('token terpasang, belum tersambung') : t('mati')}
        </Chip>
        {tg.username && <span className="mono text-sm">@{tg.username}</span>}
        <span className="text-sm text-muted">{t('{n} chat berwenang', { n: tg.chat_ids?.length || 0 })}</span>
      </div>

      <Separator />
      {tg.fromEnv ? <EnvNotice name={tg.fromEnv} what="Token bot" /> : <div className="grid gap-5 md:grid-cols-2">
        <Text label="Token bot" type="password" mono value={tok} onChange={setTok}
          placeholder={tg.token || '123456789:AA…'}
          hint={t('Dibuat lewat @BotFather di Telegram. Siapa pun yang punya token ini menguasai botnya — jangan dibagikan.')} />
        <div className="flex items-end gap-2">
          <Button onPress={() => save('tok', { bot_token: tok }, 'Token tersimpan — bot langsung jalan')} isPending={busy === 'tok'} isDisabled={!tok}>{t('Simpan token')}</Button>
          {tg.hasToken && <Button variant="outline" onPress={async () => { if (await ask({ title: t('Lepas token bot? Bot Telegram berhenti melayani.'), confirm: t('Lepas'), danger: true })) save('rm', { bot_token: '' }, 'Token dilepas'); }}>{t('Lepas')}</Button>}
        </div>
      </div>}

      <Separator />
      <div>
        <div className="font-medium">{t('Sambungkan obrolan')}</div>
        <p className="mb-3 mt-1 text-sm text-muted">
          {t('Buat kode, lalu kirim ke bot di Telegram. Chat yang tersambung bisa melakukan semua yang dasbor bisa — termasuk menyalakan LIVE dan menutup posisi.')}
        </p>
        <Button variant="outline" onPress={makeCode} isPending={busy === 'pair'} isDisabled={!tg.hasToken}>{t('Buat kode sambung')}</Button>
        {pair && (
          <Card variant="secondary" className="mt-3"><Card.Content className="gap-2">
            <div className="text-sm font-medium">{t('Kirim ini ke bot (berlaku {m} menit)', { m: Math.round((pair.expiresInSec || 900) / 60) })}</div>
            <div className="flex items-center gap-2">
              <code className="mono flex-1 break-all rounded bg-surface px-3 py-2">/start {pair.code}</code>
              <Button variant="outline" onPress={() => { navigator.clipboard?.writeText(`/start ${pair.code}`); toast.success(t('Tersalin')); }}><Copy className="size-4" />{t('Salin')}</Button>
            </div>
          </Card.Content></Card>
        )}
      </div>

      {!!tg.chat_ids?.length && (<>
        <Separator />
        <div>
          <div className="mb-2 font-medium">{t('Chat berwenang')}</div>
          <div className="flex flex-col gap-2">
            {tg.chat_ids.map((c) => (
              <div key={c} className="flex items-center justify-between gap-3 rounded border border-default px-3 py-2">
                <span className="mono text-sm">{c}</span>
                <Button size="sm" variant="ghost" onPress={async () => { if (await ask({ title: t('Lepas chat ini?'), confirm: t('Lepas'), danger: true })) save('c' + c, { chat_ids: tg.chat_ids.filter((x) => x !== c) }, 'Chat dilepas'); }}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button variant="outline" className="mt-3" onPress={async () => say(await post('/api/settings/telegram/test', {}), 'Pesan uji terkirim')}>{t('Kirim uji')}</Button>
        </div>
      </>)}

      <Separator />
      <div>
        <div className="mb-3 font-medium">{t('Kabar yang dikirim ke Telegram')}</div>
        <div className="grid gap-4 md:grid-cols-2">
          {NOTIF.map(([k, label]) => (
            <Toggle key={k} label={label} value={tg.notify?.[k]}
              onChange={(v) => save('n' + k, { notify: { ...tg.notify, [k]: v } }, 'Tersimpan')} />
          ))}
        </div>
      </div>
    </Section>
  );
}

function SecurityTab({ d }) {
  const { t } = useI18n();
  const [tok, setTok] = useState(null);
  const rotate = async () => {
    if (!(await ask({ title: t('Ganti token akses? Perangkat lain harus masuk ulang.'), confirm: t('Ganti token') }))) return;
    const r = await post('/api/settings/token/rotate', {});
    if (r.error) return toast.danger(r.error);
    setTok(r.token);
  };
  return (
    <Section title="Keamanan" desc="Dasbor ini bisa menyalakan LIVE dan menutup posisi, jadi dilindungi token akses.">
      <div>
        <div className="font-medium">{t('Ganti token akses')}</div>
        <p className="mb-3 mt-1 text-sm text-muted">{t('Token lama langsung tidak berlaku; perangkat lain harus masuk ulang. Browser ini tetap masuk.')}</p>
        {d?.authFromEnv ? <EnvNotice name={d.authFromEnv} what="Token akses" />
          : <Button variant="danger" onPress={rotate}>{t('Buat token baru')}</Button>}
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
  const [loadError, setLoadError] = useState('');
  const load = useCallback(async () => {
    setLoadError('');
    try { const data = await get('/api/settings'); if (data.error) setLoadError(data.error); else setD(data); }
    catch { setLoadError('Tidak dapat memuat pengaturan. Periksa koneksi lalu coba lagi.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader group="Sistem" title="Pengaturan" desc="Atur bot sesuai kebutuhan. Pilih bagian, lalu klik ikon informasi untuk memahami setiap pengaturan.">
        {d && <Chip variant="soft" color={d.mode.dry_run ? 'default' : 'warning'}>{t(d.mode.dry_run ? 'Mode simulasi' : 'Mode LIVE')}</Chip>}
      </PageHeader>
      {loadError ? <Notice status="danger"><div className="flex flex-wrap items-center gap-3">{t(loadError)}<Button variant="outline" onPress={load}>{t('Coba lagi')}</Button></div></Notice> : !d ? <Loading /> : (
        <Card>
          <Card.Content>
            <Tabs selectedKey={tab} onSelectionChange={setTab} orientation="vertical" variant="secondary" className="flex flex-col gap-6 md:flex-row">
              <Tabs.ListContainer className="md:w-60 md:shrink-0">
                <Tabs.List aria-label={t('Bagian pengaturan')} className="grid! grid-cols-2 md:flex! md:flex-col">
                  {SETTINGS_NAV.map(([id, label, description, Icon]) => (
                    <Tabs.Tab key={id} id={id} className="min-h-16 justify-start gap-3 px-3 py-3 text-left">
                      <Icon className="size-5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 whitespace-normal"><span className="block font-medium">{t(label)}</span><span className="mt-0.5 block text-xs font-normal text-muted">{t(description)}</span></span><Tabs.Indicator />
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
              <div className="min-w-0 flex-1">
                <Tabs.Panel id="wallet"><WalletTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="risk"><RiskTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="rpc"><RpcTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="gas" shouldForceMount className="data-[inert]:hidden">
                  <SimpleForm title="Gas" desc="Berlaku untuk transaksi berikutnya, tanpa restart." url="/api/settings/gas" okText="Pengaturan gas tersimpan"
                    onSaved={(gas) => setD((prev) => ({ ...prev, gas }))} initial={d.gas} fields={[
                      ['price_multiplier', 'Pengali harga gas', 'Harga gas jaringan × angka ini. 1,5 = 50% di atas harga saat itu.'],
                      ['priority_gwei', 'Priority fee (gwei)', 'Biaya prioritas tambahan per unit gas, dalam gwei. Ini bukan total biaya transaksi.'],
                      ['max_gas_limit', 'Batas gas per transaksi', 'Jumlah maksimum unit gas untuk satu transaksi, bukan jumlah ETH. Batas terlalu kecil dapat membuat transaksi gagal.'],
                      ['max_fee_gwei', 'Batas harga gas (gwei)', 'Harga gas per unit tidak pernah melebihi angka ini, walau satu RPC melaporkan harga yang ngawur. Harga normal jaringan ini sekitar 0,1 gwei.'],
                      ['reserve_eth', `Cadangan ${chainInfo().nativeSymbol} untuk gas`, `${chainInfo().nativeSymbol} sebanyak ini tidak pernah dipakai untuk LP maupun swap.`],
                    ]} />
                </Tabs.Panel>
                <Tabs.Panel id="notify" shouldForceMount className="data-[inert]:hidden">
                  <SimpleForm title="Notifikasi" url="/api/settings/notify" okText="Topik tersimpan" initial={d.notify} envName={d.notify?.fromEnv}
                    desc="Kabar tiap posisi disalin atau ditutup, lewat ntfy.sh. Pasang aplikasi ntfy di HP lalu langganan topik yang sama."
                    fields={[['ntfy_topic', 'Topik ntfy', 'Siapa pun yang tahu nama topiknya bisa membaca notifikasinya — pakai nama yang sulit ditebak. Kosongkan untuk mematikan.', 'text']]}
                    extra={<Button variant="outline" onPress={async () => say(await post('/api/settings/notify/test', {}), 'Notifikasi uji terkirim')}>{t('Kirim uji')}</Button>} />
                </Tabs.Panel>
                <Tabs.Panel id="telegram"><TelegramTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="gmgn"><GmgnTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="loop" shouldForceMount className="data-[inert]:hidden">
                  <SimpleForm title="Mesin" desc="Berlaku setelah bot di-restart (pm2 restart lpcopy)." url="/api/settings/loop" okText="Tersimpan — restart bot supaya berlaku"
                    initial={{ ...d.loop, ...d.prices }} fields={[
                      ['poll_ms', 'Interval pindai (ms)', 'Seberapa sering blok baru diperiksa. 1.500 ms = 1,5 detik. Nilai lebih kecil menambah permintaan RPC.'],
                      ['max_block_span', 'Blok per pindai', 'Maks 3.000 — batas getLogs endpoint arsip.'],
                      ['sync_seconds', 'Sinkron posisi (detik)', 'Jeda pemeriksaan ulang posisi bot terhadap data jaringan. Nilai lebih kecil menambah permintaan RPC.'],
                      ['eth_usd', `Harga ${chainInfo().nativeSymbol} cadangan (USD)`, `Dipakai kalau harga dari pool ${chainInfo().nativeSymbol}/${chainInfo().usdgSymbol} gagal dibaca (atau pencarian otomatis dimatikan).`],
                      ['auto_eth_price', `Ambil harga ${chainInfo().nativeSymbol} dari chain`, `Aktif: gunakan harga dari pool ${chainInfo().nativeSymbol}/${chainInfo().usdgSymbol}. Nonaktif: gunakan harga cadangan yang diisi di atas.`, 'bool'],
                    ]} />
                </Tabs.Panel>
                <Tabs.Panel id="security"><SecurityTab d={d} /></Tabs.Panel>
              </div>
            </Tabs>
          </Card.Content>
        </Card>
      )}
    </>
  );
}
