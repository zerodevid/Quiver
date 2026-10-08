import { chainInfo, isSolana, CHAIN_ICON } from '../chain';
import { isSolanaKeystore, openSolanaKeystore } from '../solKeystore';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, Checkbox, Separator, Tabs, toast } from '@heroui/react';
import { Pencil, Activity as Pulse, Trash2, KeyRound, Unlock, ChevronUp, ChevronDown, Copy, Wallet, Network, Fuel, Bell, MessageCircle, Settings2, ShieldCheck, ShieldAlert, ChartCandlestick, Coins, RefreshCw, DatabaseBackup, Download, ArchiveRestore, Shuffle, Trophy, Link2 } from 'lucide-react';
import { Wallet as EthersWallet } from 'ethers';
import SettingInfo from '../components/SettingInfo';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Loading, Notice, Text, Pick, Toggle, ask } from '../components/ui';
import { num, usd, plainUsd, locale as fmtLocale, ago } from '../fmt';
import { fxFormat } from '../currency';
import { usePrivacy } from '../privacy';
import { useI18n, translate as tt, reason } from '../i18n';

const amt = (v, d = 4) => (v == null ? '—' : Number(v).toLocaleString(fmtLocale(), { maximumFractionDigits: d }));

const SETTINGS_NAV = [
  ['wallet', 'Wallet & mode', 'Dana dan mode transaksi', Wallet],
  ['risk', 'Drawdown harian', 'Jeda otomatis kalau rugi kebablasan', ShieldAlert],
  ['chains', 'Chain', 'Jaringan mana yang dijalankan bot', Link2],
  ['rpc', 'RPC', 'Koneksi ke jaringan', Network],
  ['gas', 'Gas', 'Biaya dan cadangan transaksi', Fuel],
  ['notify', 'Notifikasi', 'Kabar ke ponsel lewat ntfy', Bell],
  ['telegram', 'Telegram', 'Hubungkan bot dan chat', MessageCircle],
  ['gmgn', 'GMGN', 'API key untuk lilin harga GMGN', ChartCandlestick],
  ['loop', 'Mesin', 'Pemindaian dan harga ETH', Settings2],
  ['display', 'Tampilan', 'Sensor nilai dan mata uang kedua', Coins],
  ['security', 'Keamanan', 'Akses masuk dasbor', ShieldCheck],
  ['aggregators', 'Agregator swap', 'Kyber, OKX, LI.FI, 0x, 1inch, OpenOcean', Shuffle],
  ['backup', 'Cadangan', 'Unduh & pulihkan pengaturan, data, wallet', DatabaseBackup],
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

// ---------------- simulation balance (paper trading) ----------------
// A virtual balance for simulation mode: open follows open, close follows close, with a profit.
function SimBox({ sim, act, busy }) {
  const { t } = useI18n();
  const [bal, setBal] = useState(sim?.balance_usd ? String(sim.balance_usd) : '');
  const [fric, setFric] = useState(sim ? String(sim.friction_pct) : '0.3');
  const st = sim?.status;
  const on = !!st;
  const save = () => act('sim', '/api/settings/sim', { balance_usd: Number(bal) || 0, friction_pct: Number(fric) || 0 }, on ? 'Pengaturan simulasi disimpan' : 'Simulasi dengan saldo menyala');
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div>
        <div className="font-medium">{t('Saldo simulasi')}</div>
        <p className="mt-1 text-sm text-muted">{t('Isi saldo awal (USD) supaya simulasi berjalan seperti trading sungguhan: bot membuka posisi virtual saat target membuka, menutupnya saat target menutup, dan menghitung profit dari saldo itu. Fee mengikuti fee posisi target. Kosongkan atau isi 0 untuk simulasi biasa (hanya mencatat keputusan).')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Text label="Saldo awal (USD)" type="number" placeholder="1000" value={bal} onChange={setBal} />
        <Text label="Biaya per transaksi (%)" type="number" placeholder="0.3" value={fric} onChange={setFric} hint="Slippage, swap, dan fee yang dibayar tiap masuk dan keluar." />
        <div className="flex items-end gap-2">
          <Button variant="outline" isPending={busy === 'sim'} onPress={save}>{t('Simpan')}</Button>
          {on && <Button variant="ghost" isPending={busy === 'simr'}
            onPress={async () => { if (await ask({ title: t('Ulangi simulasi dari awal? Posisi virtual dan kurva ekuitasnya dihapus; saldo kembali ke saldo awal.'), confirm: t('Ulangi'), danger: true })) act('simr', '/api/settings/sim', { reset: true }, 'Simulasi diulang dari awal'); }}>{t('Ulangi dari awal')}</Button>}
        </div>
      </div>
      {on && (
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-4">
          <div><dt className="text-xs text-muted">{t('Kas virtual')}</dt><dd className="num mt-0.5 font-medium">{usd(st.cashUsd)}</dd></div>
          <div><dt className="text-xs text-muted">{t('Ekuitas')}</dt><dd className="num mt-0.5 font-medium">{usd(st.equityUsd)}</dd></div>
          <div><dt className="text-xs text-muted">{t('Untung')}</dt><dd className={`num mt-0.5 font-medium ${st.pnlUsd >= 0 ? 'text-success' : 'text-danger'}`}>{usd(st.pnlUsd)} ({st.pnlPct.toFixed(2)}%)</dd></div>
          <div><dt className="text-xs text-muted">{t('Posisi')}</dt><dd className="num mt-0.5 font-medium">{t('{o} terbuka · {c} selesai', { o: st.openCount, c: st.closedCount })}</dd></div>
        </dl>
      )}
    </div>
  );
}

// ---------------- chains ----------------
// Every network the bot knows, with an on/off switch. One engine per enabled chain is built at
// boot, so a changed switch is saved right away but only takes effect after a restart.
function ChainsTab({ d, setD }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState('');
  const list = d.chains || [];
  const pending = list.some((c) => c.enabled !== c.running);
  const flip = async (c, enabled) => {
    setBusy(c.key);
    const r = await post('/api/settings/chains', { key: c.key, enabled });
    setBusy('');
    say(r, enabled ? 'Chain dinyalakan — restart bot supaya berlaku' : 'Chain dimatikan — restart bot supaya berlaku');
    if (!r.error) setD((prev) => ({ ...prev, chains: r.chains }));
  };
  return (
    <Section title="Chain yang dijalankan" desc="Satu proses bot menjalankan semua chain yang dinyalakan dengan wallet yang sama. Chain baru mulai dalam mode simulasi tanpa target, jadi aman dinyalakan dulu untuk dicoba. Setiap chain yang aktif menambah pemakaian RAM dan permintaan RPC.">
      {pending && <Notice status="warning" title="Perlu restart">{t('Ada perubahan yang belum berlaku. Restart bot (pm2 restart lpcopy) supaya chain yang dinyalakan atau dimatikan mulai berjalan.')}</Notice>}
      <div className="flex flex-col divide-y divide-border">
        {list.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <img src={CHAIN_ICON[c.key] || '/favicon.svg'} alt="" width="32" height="32" className="size-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.label}</span>
                {c.chainId != null && <Chip size="sm" variant="soft">{t('id {n}', { n: c.chainId })}</Chip>}
                <Chip size="sm" variant="soft">{c.nativeSymbol}</Chip>
                {c.running && <Chip size="sm" variant="soft" color="success">{t('Berjalan')}</Chip>}
                {c.enabled !== c.running && <Chip size="sm" variant="soft" color="warning">{t(c.enabled ? 'Mulai setelah restart' : 'Berhenti setelah restart')}</Chip>}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {c.venues.map((v) => ({ v3: 'Uniswap v3', v4: 'Uniswap v4', pancakev3: 'PancakeSwap v3', meteora: 'Meteora DLMM', orca: 'Orca', raydium: 'Raydium' }[v] || v)).join(' · ')}
                {' · '}{c.stable}{' · '}{t('{n} target', { n: c.targets })}{' · '}{t(c.dryRun ? 'simulasi' : 'LIVE')}{' · '}{t('{n} RPC', { n: c.endpoints })}
              </div>
            </div>
            <Toggle label={c.enabled ? 'Nyala' : 'Mati'} value={c.enabled} isDisabled={busy === c.key} onChange={(v) => flip(c, v)} />
          </div>
        ))}
      </div>
    </Section>
  );
}

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
              {t(w.kind === 'solana'
                ? 'Menghasilkan berkas keystore terenkripsi (PBKDF2 + AES-GCM). Dompet Solana tidak punya format keystore baku: buka berkasnya di "Buka keystore (offline)" di bawah untuk mendapat kunci base58 yang bisa diimpor ke Phantom/Solflare. Butuh token dashboard, diketik ulang di sini, bukan diambil dari sesi login.'
                : 'Menghasilkan berkas keystore terenkripsi (format sama dengan geth/MetaMask) yang bisa diimpor ke wallet lain lewat "Import via JSON". Kunci privat mentah tidak pernah dikirim — tanpa password di bawah, isi berkasnya tidak berguna. Butuh token dashboard, diketik ulang di sini, bukan diambil dari sesi login.')}
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
              let j = null;
              try { j = JSON.parse(text); } catch { /* let ethers report it */ }
              if (isSolanaKeystore(j)) setKsResult(await openSolanaKeystore(j, ksPass));
              else {
                const w = await EthersWallet.fromEncryptedJson(text, ksPass);
                setKsResult({ address: w.address, pk: w.privateKey });
              }
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

      {m.dry_run && <SimBox key={m.sim?.balance_usd ?? 0} sim={m.sim} act={act} busy={busy} />}

      <Separator />
      {w.fromEnv ? <EnvNotice name={w.fromEnv} what="Kunci wallet" />
        : !m.dry_run ? <Notice status="warning">{t('Matikan mode LIVE dulu untuk mengganti wallet.')}</Notice> : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="font-medium">{t('Impor kunci privat')}</div>
              <Text label="Kunci privat" type="password" mono placeholder={w.kind === 'solana' ? 'base58 (ekspor Phantom/Solflare) atau [larik JSON solana-keygen]' : '0x… (64 karakter hex)'} value={pk} onChange={setPk} autoComplete="off" />
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
                <Button variant="danger" isDisabled={(w.kind === 'solana' ? rm.trim() : rm.toLowerCase()) !== w.address} isPending={busy === 'rm'}
                  onPress={() => act('rm', '/api/settings/wallet/remove', { confirm: rm }, 'Wallet dilepas, kunci dicadangkan')}>{t('Lepas')}</Button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------- daily drawdown ----------------
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

// `rank`/`total` = priority order; onMove(-1|+1) shifts up/down. The top one
// is used first, the rest are ordered fallbacks (see rpc.js usable()).
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

// Answers that can no longer change (past blocks) are stored in the database and reused
// without touching the network — see src/rpccache.js. The row is only a report: there is
// nothing to tune, and an empty cache is not wrong either.
function RpcCache({ c }) {
  const { t } = useI18n();
  if (!c) return null;
  const mb = c.bytes / 1048576;
  return (
    <div className="flex items-center gap-1 text-sm text-muted">
      <span>{t('Cache jawaban pasti: {n} tersimpan · {mb} MB · {p}% pembacaan dijawab tanpa menyentuh jaringan',
        { n: num(c.rows), mb: mb.toLocaleString(fmtLocale(), { maximumFractionDigits: mb < 10 ? 1 : 0 }), p: c.hitPct })}</span>
      <SettingInfo title="Cache jawaban pasti">
        <span>{t('Panggilan yang terikat pada blok lampau — receipt transaksi, header blok, saldo dan eth_call di blok tertentu, getLogs untuk rentang yang sudah lewat — jawabannya tidak mungkin berubah lagi, jadi disimpan di database dan dipakai ulang. Data hidup (harga pool, saldo terkini, tinggi blok) tidak pernah disimpan. Satu blok dianggap pasti setelah tertinggal {n} blok dari kepala rantai. Simpanan lama dibuang sendiri; kehilangannya paling banter berarti satu panggilan RPC lagi.', { n: c.confirmations })}</span>
      </SettingInfo>
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
      max_log_blocks: tested.max_log_blocks, archive: tested.archive, max_batch: 40,
      no_gpa: tested.no_gpa, no_history: tested.no_history }], 'Endpoint ditambahkan dan langsung dipakai');
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

      <RpcCache c={d.rpcCache} />

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

// ---------------- simple form ----------------
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

// Fields managed through .env: the dashboard refuses to change them (they would be overwritten again on
// restart), so what is shown is where to change them.
function EnvNotice({ name, what }) {
  const { t } = useI18n();
  return (
    <Notice>
      {t('{what} diatur lewat', { what: t(what) })} <span className="mono">{name}</span> {t('di berkas .env server. Ubah di sana lalu restart bot.')}
    </Notice>
  );
}

// ---------------- GMGN OpenAPI ----------------
// The key is used by the server to pull GMGN's price candles (Chart tab, "GMGN" source)
// — the same data as the gmgn.ai chart, drawn on our chart so the bot's position
// range is drawn too. It is not sent whole to the browser.
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

// ---------------- Telegram bot ----------------
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

// ---------------- display: secondary currency ----------------
// Not an engine setting: not a single bot decision changes because of it.
// Only the way the dashboard writes numbers changes — dollars stay the main figure, the chosen
// currency sits small beside it.
function DisplayTab({ d, reload }) {
  const { t } = useI18n();
  const dp = d.display || {};
  const fx = dp.fx;
  const [busy, setBusy] = useState('');
  const OFF = 'off';
  const options = [[OFF, 'Tidak ada — dolar saja'], ...(dp.currencies || []).map((c) => [c.code, `${c.code} · ${c.name}`])];
  const pick = async (id) => {
    setBusy('save');
    const r = await post('/api/settings/display', { currency: id === OFF ? '' : id });
    setBusy('');
    say(r, id === OFF ? 'Dasbor kembali menampilkan dolar saja' : 'Mata uang kedua tersimpan');
    if (!r.error) reload();
  };
  const refresh = async () => {
    setBusy('fx');
    const r = await post('/api/settings/display/refresh', {});
    setBusy('');
    say(r, 'Kurs diperbarui');
    if (!r.error) reload();
  };
  // The same switch as the eye icon (privacy.js): the value is taken from there,
  // not from this page's payload, so it does not go stale if the eye is pressed elsewhere.
  const [hidden, toggleHidden] = usePrivacy();
  const hide = async () => {
    setBusy('hide');
    const r = await toggleHidden();
    setBusy('');
    say(r, hidden ? 'Nilai portofolio kini tampil' : 'Nilai portofolio kini tersensor');
  };
  // An example is used so the choice shows its result before leaving the page.
  const sample = fx?.rate ? fxFormat(1234.56, fx) : null;
  return (
    <div className="flex flex-col gap-10">
    <Section title="Sensor nilai portofolio" desc="Menutup semua nilai dolar milik kita — saldo, modal, PnL, fee, dan jumlah token — dengan $•••••. Persen dan data pasar tetap terlihat. Berguna untuk berbagi layar, merekam, atau membuka dasbor di tempat umum.">
      <Toggle label="Sensor nilai" value={hidden} onChange={hide} isDisabled={busy === 'hide'}
        desc="Sama dengan ikon mata di sebelah tombol tema dan di mini app Telegram — satu sakelar untuk semuanya. Berlaku di semua tab dan perangkat, dan tetap tersimpan sampai dimatikan lagi." />
    </Section>
    <Section title="Mata uang kedua" desc="Semua nominal di dasbor dihitung dalam dolar — itu satuan yang dipakai pool, harga token, dan seluruh perhitungan PnL. Pilihan di sini menambahkan nilai yang sama dalam mata uang lain, ditulis kecil di sebelah angka dolarnya, supaya nominalnya punya rasa besaran. Angka utamanya tidak berubah.">
      <div className="grid gap-5 md:grid-cols-2">
        <Pick label="Mata uang" value={dp.currency || OFF} onChange={pick} isDisabled={busy === 'save'} options={options}
          hint={t('Kursnya diambil server otomatis dari sumber kurs terbuka (open.er-api.com, cadangan frankfurter.app) dan disegarkan tiap enam jam.')} />
        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted">{t('Contoh tampilan')}</div>
          <div className="num rounded-md border border-border px-3 py-2.5 text-lg font-semibold tracking-tight">
            {plainUsd(1234.56)}{sample && <span className="ml-1.5 text-xs font-medium text-muted">≈ {sample}</span>}
          </div>
          {dp.currency && !fx?.rate && <Notice status="warning">{t('Kurs belum terbaca')}{fx?.error ? ` — ${fx.error}` : ''}</Notice>}
        </div>
      </div>

      {dp.currency && (
        <>
          <Separator />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="text-sm">
              {fx?.rate
                ? <>1 USD = <span className="num font-medium">{num(fx.rate, fx.rate < 100 ? 4 : 2)} {fx.currency}</span></>
                : <span className="text-muted">{t('Kurs belum tersedia.')}</span>}
              {fx?.at && <span className="ml-2 text-xs text-muted">{t('diperbarui {w}', { w: ago(fx.at) })}{fx.source ? ` · ${fx.source}` : ''}</span>}
            </div>
            <Button variant="outline" size="sm" isPending={busy === 'fx'} onPress={refresh}><RefreshCw className="size-4" />{t('Perbarui kurs')}</Button>
          </div>
          {fx?.stale && <Notice status="warning">{t('Sumber kurs sedang tidak bisa dihubungi; yang dipakai kurs terakhir yang berhasil diambil.')}</Notice>}
        </>
      )}
    </Section>
    </div>
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

// ---------------- swap aggregators ----------------
const AGG_INFO = {
  jupiter: ['Tanpa key (lite-api, ada batas laju). Agregator utama Solana: meroute lewat Meteora, Orca, Raydium, HumidiFi, dan lainnya.', 'https://portal.jup.ag'],
  dflow: ['Butuh API key dari DFlow. Agregator Solana dengan API bergaya Jupiter.', 'https://pond.dflow.net'],
  raydium: ['Tanpa key. Hanya rute lewat pool Raydium; dipakai sebagai cadangan kalau Jupiter gagal atau memberi hasil lebih kecil.', null],
  kyber: ['Tanpa key. Calldata-nya dibaca dan dicocokkan kolom demi kolom sebelum dikirim — pengaman paling ketat.', null],
  okx: ['Butuh API key, secret key, dan passphrase. Sekitar 1 permintaan per detik per key.', 'https://web3.okx.com/onchainos/dev-portal'],
  lifi: ['Jalan tanpa key (batas laju ketat); key gratis menaikkan batasnya. LI.FI sendiri merutekan lewat agregator dan DEX lain.', 'https://portal.li.fi'],
  zerox: ['Butuh API key dari dashboard 0x. Mesin swap yang dipakai Coinbase Wallet dan MetaMask.', 'https://dashboard.0x.org'],
  oneinch: ['Butuh API key dari portal 1inch. API-nya tidak memberi minimum terima, jadi hasil simulasi yang dijadikan patokan.', 'https://business.1inch.com/portal'],
  openocean: ['Butuh API key pro — API publiknya memblokir bot lewat Cloudflare.', 'https://openocean.finance'],
};
const AGG_FIELD_LABEL = { api_key: 'API key', secret_key: 'Secret key', passphrase: 'Passphrase', project_id: 'Project ID (opsional)' };

function AggCard({ it, first, last, move, onSaved }) {
  const { t } = useI18n();
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState('');
  const [info, link] = AGG_INFO[it.id] || ['', null];
  const editable = it.fields.filter((f) => !f.fromEnv);
  const dirty = Object.values(vals).some((v) => v);
  const status = it.active ? ['success', 'Aktif'] : !it.enabled ? ['default', 'Dimatikan'] : !it.supported ? ['warning', 'Chain ini belum didukung'] : ['warning', 'Butuh API key'];
  const save = async (k, body, ok) => {
    setBusy(k);
    const r = await post('/api/settings/aggregators', { id: it.id, ...body });
    setBusy('');
    if (r.error) return toast.danger(reason(r.error));
    toast.success(tt(ok));
    setVals({});
    onSaved(r.aggregators);
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Naikkan')} isDisabled={first} onPress={() => move(-1)}><ChevronUp className="size-4" /></Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Turunkan')} isDisabled={last} onPress={() => move(1)}><ChevronDown className="size-4" /></Button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{it.label}</span>
            <Chip size="sm" variant="soft" color={status[0]}>{t(status[1])}</Chip>
            {it.fields.some((f) => f.set) && <Chip size="sm" variant="soft">{t('key terpasang')}</Chip>}
          </div>
          <p className="mt-1 text-sm text-muted">{t(info)}{link && <> <a href={link} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t('Daftar key')}</a></>}</p>
        </div>
        <Toggle label={it.enabled ? 'Nyala' : 'Mati'} value={it.enabled} isDisabled={busy === 'toggle'}
          onChange={(v) => save('toggle', { enabled: v }, v ? 'Agregator dinyalakan' : 'Agregator dimatikan')} />
      </div>
      {it.fields.length > 0 && (
        <>
          {it.fields.filter((f) => f.fromEnv).map((f) => <EnvNotice key={f.name} name={f.fromEnv} what={AGG_FIELD_LABEL[f.name]} />)}
          {editable.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {editable.map((f) => (
                <Text key={f.name} label={AGG_FIELD_LABEL[f.name]} type="password" mono autoComplete="off"
                  placeholder={f.masked || (it.keyOptional ? t('opsional') : '')} value={vals[f.name] || ''}
                  onChange={(v) => setVals((x) => ({ ...x, [f.name]: v }))} />
              ))}
            </div>
          )}
          {editable.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" isDisabled={!dirty} isPending={busy === 'key'} onPress={() => save('key', { keys: vals }, 'Key tersimpan — berlaku di swap berikutnya')}>{t('Simpan key')}</Button>
              {editable.some((f) => f.set) && (
                <Button size="sm" variant="outline" isPending={busy === 'rm'} onPress={async () => {
                  if (await ask({ title: tt('Lepas key {a}?', { a: it.label }), confirm: tt('Lepas'), danger: true })) {
                    save('rm', { keys: Object.fromEntries(editable.map((f) => [f.name, ''])) }, 'Key dilepas');
                  }
                }}>{t('Lepas key')}</Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AggregatorsTab({ d, setD }) {
  const { t } = useI18n();
  const ag = d.aggregators;
  const [cmp, setCmp] = useState(null);
  const [busy, setBusy] = useState('');
  if (!ag) return <Section title="Agregator swap"><Notice>{t('Router swap belum siap. Muat ulang halaman sebentar lagi.')}</Notice></Section>;
  const setAg = (aggregators) => setD((prev) => ({ ...prev, aggregators }));
  const post2 = async (k, body, ok) => {
    setBusy(k);
    const r = await post('/api/settings/aggregators', body);
    setBusy('');
    if (r.error) return toast.danger(reason(r.error));
    if (ok) toast.success(tt(ok));
    setAg(r.aggregators);
  };
  const move = (i, dir) => {
    const order = [...ag.order];
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    post2('order', { order });
  };
  const compare = async () => {
    setBusy('cmp'); setCmp(null);
    const r = await post('/api/settings/aggregators/test', { usd: 10 });
    setBusy('');
    if (r.error) return toast.danger(reason(r.error));
    setCmp(r);
  };
  const activeN = ag.items.filter((x) => x.active).length;
  return (
    <Section title="Agregator swap" desc="Semua swap bot — zap saat membuka LP, jembatan ETH/USDG, jual sisa dan fee, isi gas, swap manual — lewat agregator di bawah. Perubahan berlaku di swap berikutnya, tanpa restart.">
      <div className="flex flex-col gap-2">
        <div className="font-medium">{t('Cara memilih rute')}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={ag.mode === 'best' ? 'primary' : 'outline'} isPending={busy === 'mode' && ag.mode !== 'best'} onPress={() => ag.mode !== 'best' && post2('mode', { mode: 'best' }, 'Mode: rute terbaik')}>
            <Trophy className="size-4" />{t('Rute terbaik')}</Button>
          <Button size="sm" variant={ag.mode === 'order' ? 'primary' : 'outline'} isPending={busy === 'mode' && ag.mode !== 'order'} onPress={() => ag.mode !== 'order' && post2('mode', { mode: 'order' }, 'Mode: urutan cadangan')}>
            {t('Urutan cadangan')}</Button>
        </div>
        <p className="text-sm text-muted">{t(ag.mode === 'best'
          ? 'Setiap swap menanyai semua agregator yang aktif sekaligus, lalu yang memberi hasil terbanyak yang dieksekusi. Kalau gagal, pindah ke peringkat berikutnya. Urutan di bawah hanya jadi penentu kalau hasilnya seri.'
          : 'Agregator dicoba satu per satu sesuai urutan di bawah; yang berikutnya hanya dipakai kalau yang sebelumnya tidak menemukan rute, terlalu rugi, atau gagal.')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onPress={compare} isPending={busy === 'cmp'} isDisabled={!activeN}><Pulse className="size-4" />{t('Bandingkan sekarang')}</Button>
        <span className="text-sm text-muted">{t('{n} agregator aktif. Membandingkan kutipan 10 {q} → {n2} tanpa mengirim transaksi.', { n: activeN, q: chainInfo().usdgSymbol, n2: chainInfo().nativeSymbol })}</span>
      </div>
      {cmp && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr>
              <th className="px-3 py-2">{t('Agregator')}</th><th className="px-3 py-2 text-right">{t('Hasil')}</th><th className="px-3 py-2">{t('Lewat')}</th><th className="px-3 py-2 text-right">{t('Waktu')}</th>
            </tr></thead>
            <tbody>
              {cmp.rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{r.label || r.id} {cmp.best === r.id && <Chip size="sm" variant="soft" color="success">{t('terbaik')}</Chip>}</td>
                  <td className="num px-3 py-2 text-right">{r.amountOut != null ? `${r.amountOut.toLocaleString(fmtLocale(), { maximumFractionDigits: 8 })} ${cmp.symbolOut}` : <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2 text-muted">{r.skipped ? t(r.skipped) : r.error ? <span className="text-danger">{reason(r.error)}</span> : r.dex}</td>
                  <td className="num px-3 py-2 text-right text-muted">{r.ms != null ? `${r.ms} ms` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {ag.items.map((it, i) => (
          <AggCard key={it.id} it={it} first={i === 0} last={i === ag.items.length - 1} move={(dir) => move(i, dir)} onSaved={setAg} />
        ))}
      </div>
    </Section>
  );
}

// ---------------- backup & restore ----------------
const BACKUP_PARTS = [
  ['config', 'Pengaturan', 'config.json: aturan, target, RPC, gas, notifikasi, Telegram. Rahasia yang diatur lewat .env tidak ikut.'],
  ['db', 'Basis data', 'Riwayat posisi, transaksi, ekuitas, riset wallet target. Cache RPC tidak ikut (terisi lagi sendiri).'],
  ['wallet', 'Wallet', 'Kunci wallet bot sebagai keystore terenkripsi password — kunci privat mentah tidak pernah masuk berkas.'],
];

function PartBox({ label, desc, selected, onChange, isDisabled, note }) {
  const { t } = useI18n();
  return (
    <Checkbox isSelected={selected} onChange={onChange} isDisabled={isDisabled} aria-label={t(label)}>
      <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
        <span className="flex min-w-0 flex-col"><span className="font-medium">{t(label)}{note && <span className="ml-2 break-all text-xs font-normal text-muted">{note}</span>}</span>
          <span className="text-xs text-muted">{t(desc)}</span></span>
      </Checkbox.Content>
    </Checkbox>
  );
}

const fileStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const mb = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3)).toLocaleString(fmtLocale())} KB`
  : `${(n / 1e6).toLocaleString(fmtLocale(), { maximumFractionDigits: 1 })} MB`);

function BackupTab({ d }) {
  const { t } = useI18n();
  const hasWallet = !!d.wallet?.address;
  // ---- create a backup ----
  const [pick, setPick] = useState({ config: true, db: true, wallet: false });
  const [tok, setTok] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const any = pick.config || pick.db || pick.wallet;
  const passOk = !pick.wallet || (pass.length >= 8 && pass === pass2);
  const download = async () => {
    setBusy(true);
    const r = await post('/api/settings/backup', { token: tok, parts: pick, password: pick.wallet ? pass : undefined });
    setBusy(false);
    if (r.error) { toast.danger(reason(r.error)); return; }
    setTok(''); setPass(''); setPass2('');
    const blob = new Blob([JSON.stringify(r.backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `quiver-backup-${r.backup.instance || 'quiver'}-${fileStamp()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(tt('Cadangan terunduh ({s}) — simpan di tempat aman: isinya bisa berisi API key dan riwayat lengkap bot.', { s: mb(blob.size) }));
  };

  // ---- restore ----
  const [file, setFile] = useState(null);        // { name, size, backup }
  const [fileErr, setFileErr] = useState('');
  const [rpick, setRpick] = useState({});
  const [rtok, setRtok] = useState('');
  const [rpass, setRpass] = useState('');
  const [rbusy, setRbusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const readFile = async (f) => {
    setFile(null); setFileErr(''); setRpick({});
    if (!f) return;
    try {
      const b = JSON.parse(await f.text());
      if (b?.format !== 'quiver-backup' || !b.parts) throw new Error(tt('Bukan berkas cadangan Quiver.'));
      setFile({ name: f.name, size: f.size, backup: b });
      setRpick(Object.fromEntries(Object.keys(b.parts).map((k) => [k, true])));
    } catch (e) { setFileErr(e instanceof SyntaxError ? tt('Berkas cadangan bukan JSON yang valid.') : e.message); }
  };
  const b = file?.backup;
  const rany = rpick.config || rpick.db || rpick.wallet;
  const liveOn = !d.mode?.dry_run;
  const restore = async () => {
    const what = BACKUP_PARTS.filter(([k]) => rpick[k]).map(([, l]) => tt(l)).join(', ');
    const body = rpick.db
      ? tt('Riwayat bot di server ini diganti isi cadangan. Posisi yang dibuka SESUDAH cadangan dibuat tidak akan dikenal bot. Berkas lama tidak dihapus — disimpan di sebelahnya sebagai *.pre-restore-*.')
      : rpick.config ? tt('Pengaturan diganti isi cadangan (port, token dasbor, dan lokasi data tetap milik server ini). Bot mulai lagi dalam mode simulasi.') : null;
    if (!(await ask({ title: tt('Pulihkan {w} dari cadangan?', { w: what }), body, confirm: tt('Pulihkan'), danger: true }))) return;
    setRbusy(true);
    const r = await post('/api/settings/restore', { token: rtok, parts: rpick, password: rpick.wallet ? rpass : undefined, backup: b });
    setRbusy(false);
    if (r.error) { toast.danger(reason(r.error)); return; }
    setRtok(''); setRpass('');
    if (r.wallet && !r.wallet.unchanged) toast.success(tt('Wallet {a} terpasang', { a: r.wallet.address }));
    if (!r.restarting) { toast.success(tt('Cadangan dipulihkan')); return; }
    // The bot stops in an orderly way and is started again by pm2; the files are swapped at boot.
    setRestarting(true);
    const t0 = Date.now();
    await new Promise((res) => setTimeout(res, 5000));
    while (Date.now() - t0 < 4 * 60_000) {
      try { const x = await get('/api/settings'); if (x && !x.error) { location.reload(); return; } } catch { /* still down */ }
      await new Promise((res) => setTimeout(res, 2500));
    }
    setRestarting(false);
    toast.danger(tt('Bot belum menyala lagi setelah 4 menit — periksa pm2/log di server.'));
  };

  return (
    <Section title="Cadangan" desc="Unduh salinan pengaturan, basis data, dan wallet bot ke satu berkas, lalu pulihkan di instance ini atau instance lain. Kedua arah butuh token dashboard yang diketik ulang.">
      <div className="flex flex-col gap-4 rounded-md border border-border p-4">
        <div className="font-medium">{t('Buat cadangan')}</div>
        <div className="flex flex-col gap-3">
          {BACKUP_PARTS.map(([k, label, desc]) => (
            <PartBox key={k} label={label} desc={desc} selected={!!pick[k]} onChange={(v) => setPick((p) => ({ ...p, [k]: v }))}
              isDisabled={k === 'wallet' && !hasWallet} note={k === 'wallet' && !hasWallet ? t('belum ada wallet') : null} />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Text label="Token dashboard" type="password" mono placeholder="token" value={tok} onChange={setTok} autoComplete="off" />
          {pick.wallet && <>
            <Text label="Password keystore baru" type="password" placeholder="min. 8 karakter" value={pass} onChange={setPass} autoComplete="off" />
            <Text label="Ulangi password" type="password" placeholder="min. 8 karakter" value={pass2} onChange={setPass2} autoComplete="off"
              isInvalid={!!pass2 && pass !== pass2} />
          </>}
        </div>
        <Button variant="outline" className="w-fit" isDisabled={!any || !tok || !passOk} isPending={busy} onPress={download}>
          <Download className="size-4" />{t('Unduh cadangan')}</Button>
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-border p-4">
        <div className="font-medium">{t('Pulihkan dari cadangan')}</div>
        {liveOn && <Notice status="warning">{t('Matikan mode LIVE dulu (tab Wallet & mode) sebelum memulihkan cadangan.')}</Notice>}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">{t('Berkas cadangan (.json)')}</label>
          <input type="file" accept=".json,application/json" disabled={rbusy || restarting}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => readFile(e.target.files?.[0] || null)} />
        </div>
        {fileErr && <Notice status="danger">{fileErr}</Notice>}
        {b && (
          <>
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted">{t('Dibuat')}</dt><dd className="mt-0.5">{new Date(b.createdAt).toLocaleString(fmtLocale())} <span className="text-muted">({ago(Date.parse(b.createdAt))})</span></dd></div>
              <div><dt className="text-xs text-muted">{t('Instance')}</dt><dd className="mono mt-0.5">{b.instance || '—'}{b.chains?.length ? ` · ${b.chains.join(', ')}` : ''}</dd></div>
              <div><dt className="text-xs text-muted">{t('Ukuran berkas')}</dt><dd className="num mt-0.5">{mb(file.size)}</dd></div>
            </dl>
            <div className="flex flex-col gap-3">
              {BACKUP_PARTS.filter(([k]) => b.parts[k]).map(([k, label]) => {
                const note = k === 'db' ? tt('{n} posisi ({o} terbuka) · {s}', { n: b.parts.db.stats?.positions ?? '?', o: b.parts.db.stats?.open ?? '?', s: mb(b.parts.db.bytes || 0) })
                  : k === 'wallet' ? `${b.parts.wallet.address}${b.parts.wallet.address === d.wallet?.address ? ` · ${tt('sama dengan wallet sekarang')}` : ''}`
                  : k === 'config' ? tt('{n} chain', { n: Object.keys(b.parts.config.json?.chains || {}).length || 1 }) : null;
                const desc = k === 'db' ? 'Menggantikan seluruh riwayat bot di server ini. Bot dinyalakan ulang.'
                  : k === 'config' ? 'Port, token dasbor, dan lokasi data tetap milik server ini. Bot dinyalakan ulang dalam mode simulasi.'
                  : 'Kunci wallet sekarang (kalau ada) dipindah ke berkas cadangan bertanggal, tidak dihapus.';
                return <PartBox key={k} label={label} desc={desc} note={note} selected={!!rpick[k]} onChange={(v) => setRpick((p) => ({ ...p, [k]: v }))} />;
              })}
            </div>
            {rpick.wallet && d.wallet?.fromEnv && <EnvNotice name={d.wallet.fromEnv} what="Kunci wallet" />}
            <div className="grid gap-3 sm:grid-cols-3">
              <Text label="Token dashboard" type="password" mono placeholder="token" value={rtok} onChange={setRtok} autoComplete="off" />
              {rpick.wallet && <Text label="Password keystore" type="password" placeholder="password saat mencadangkan" value={rpass} onChange={setRpass} autoComplete="off" />}
            </div>
            {restarting ? <Notice status="warning" title="Bot sedang dinyalakan ulang…">{t('Halaman ini dimuat ulang otomatis begitu bot menyala lagi.')}</Notice> : (
              <Button variant="danger" className="w-fit" isDisabled={!rany || !rtok || liveOn || (rpick.wallet && !rpass)} isPending={rbusy} onPress={restore}>
                <ArchiveRestore className="size-4" />{t('Pulihkan')}</Button>
            )}
          </>
        )}
      </div>
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
                  {SETTINGS_NAV.map(([id, label, description0, Icon]) => {
                    const description = id === 'aggregators' && isSolana() ? 'Jupiter, Raydium, LI.FI, OKX, OpenOcean, DFlow' : description0;
                    return (
                    <Tabs.Tab key={id} id={id} className="min-h-16 justify-start gap-3 px-3 py-3 text-left">
                      <Icon className="size-5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 whitespace-normal"><span className="block font-medium">{t(label)}</span><span className="mt-0.5 block text-xs font-normal text-muted">{t(description)}</span></span><Tabs.Indicator />
                    </Tabs.Tab>
                    );
                  })}
                </Tabs.List>
              </Tabs.ListContainer>
              <div className="min-w-0 flex-1">
                <Tabs.Panel id="wallet"><WalletTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="risk"><RiskTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="chains"><ChainsTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="rpc"><RpcTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="gas" shouldForceMount className="data-[inert]:hidden">
                  <SimpleForm title="Gas" desc="Berlaku untuk transaksi berikutnya, tanpa restart." url="/api/settings/gas" okText="Pengaturan gas tersimpan"
                    onSaved={(gas) => setD((prev) => ({ ...prev, gas }))} initial={d.gas} fields={isSolana() ? [
                      ['price_multiplier', 'Pengali harga prioritas', 'Fee prioritas terkini (persentil 75 untuk akun yang ditulis transaksi) × angka ini.'],
                      ['min_cu_price_micro', 'Harga prioritas minimum (µlamport/CU)', 'Tidak pernah di bawah ini, walau jaringan sepi. 10.000 µlamport × 200.000 CU = 0,000002 SOL.'],
                      ['max_cu_price_micro', 'Harga prioritas maksimum (µlamport/CU)', 'Batas atas saat jaringan padat — melindungi dari lonjakan fee prioritas.'],
                      ['jupiter_max_priority_sol', 'Batas prioritas swap Jupiter (SOL)', 'Fee prioritas maksimum per swap yang dikirim lewat Jupiter.'],
                      ['reserve_sol', 'Cadangan SOL untuk biaya', 'SOL sebanyak ini tidak pernah dipakai untuk LP maupun swap — untuk biaya transaksi dan sewa akun posisi.'],
                      ['topup_max_usd', 'Isi ulang SOL maksimum (USD)', 'Kalau SOL di bawah separuh cadangan, bot membeli SOL dari USDC paling banyak senilai ini per kali.'],
                    ] : [
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
                <Tabs.Panel id="display"><DisplayTab d={d} reload={load} /></Tabs.Panel>
                <Tabs.Panel id="security"><SecurityTab d={d} /></Tabs.Panel>
                <Tabs.Panel id="aggregators"><AggregatorsTab d={d} setD={setD} /></Tabs.Panel>
                <Tabs.Panel id="backup"><BackupTab d={d} /></Tabs.Panel>
              </div>
            </Tabs>
          </Card.Content>
        </Card>
      )}
    </>
  );
}
