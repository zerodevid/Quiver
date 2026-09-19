import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react';
import { Button, Chip, Toast } from '@heroui/react';
import {
  LayoutDashboard, Layers, ListChecks, Users, SlidersHorizontal, Wallet as WalletIcon,
  Settings as SettingsIcon, Moon, Sun, Pause, Play, Menu, X, LogOut,
  PlusCircle, ArrowDownUp, BookOpen,
} from 'lucide-react';
import { usePoll, useHash, useTheme } from './hooks';
import { post } from './api';
import { short, usd, num } from './fmt';
import { chainInfo, setChain, CHAIN_ICON } from './chain';
import { useI18n, LOCALES } from './i18n';
import { QuiverLogo } from './components/Logo';
import { AlertBell, useTargetAlerts, setBaseTitle } from './components/TargetAlerts';
import StuckAlert from './components/StuckAlert';
import SearchModal, { SearchTrigger } from './components/GlobalSearch';

import { Loading, ConfirmHost, ask } from './components/ui';
import { hideSplash } from './splash';

// Tiap halaman dimuat saat dibuka — pustaka grafik cuma diunduh untuk Ringkasan.
const Overview = lazy(() => import('./pages/Overview'));
const Positions = lazy(() => import('./pages/Positions'));
const Activity = lazy(() => import('./pages/Activity'));
const Targets = lazy(() => import('./pages/Targets'));
const Rules = lazy(() => import('./pages/Rules'));
const WalletPage = lazy(() => import('./pages/Wallet'));
const Settings = lazy(() => import('./pages/Settings'));
const ManualLp = lazy(() => import('./pages/ManualLp'));
const Swap = lazy(() => import('./pages/Swap'));
const Learn = lazy(() => import('./pages/Learn'));
// Tidak ada di menu: dibuka dari lambang token (#token/0x…) dan nama pasangan (#pool/0x…).
const TokenDetail = lazy(() => import('./pages/TokenDetail'));
const PoolDetail = lazy(() => import('./pages/PoolDetail'));

// Status mesin dipoll SEKALI di sini lalu dibagi ke semua halaman.
const StatusCtx = createContext(null);
export const useStatus = () => useContext(StatusCtx);

const NAV = [
  ['Pemantauan', [
    ['summary', 'Ringkasan', LayoutDashboard, Overview],
    ['positions', 'Posisi', Layers, Positions],
    ['activity', 'Aktivitas', ListChecks, Activity],
  ]],
  ['Copy', [
    ['targets', 'Target', Users, Targets],
    ['rules', 'Aturan', SlidersHorizontal, Rules],
  ]],
  ['Aksi', [
    ['manual-lp', 'LP manual', PlusCircle, ManualLp],
    ['swap', 'Swap', ArrowDownUp, Swap],
  ]],
  ['Riset', [
    ['wallet', 'Wallet', WalletIcon, WalletPage],
    ['learn', 'Belajar LP', BookOpen, Learn],
  ]],
  ['Sistem', [
    ['settings', 'Pengaturan', SettingsIcon, Settings],
  ]],
];
// #scout dulu halaman sendiri; isinya sekarang ada di dalam Wallet. Tautan lama
// (bookmark, pesan Telegram) tetap mendarat di tempat yang benar.
const PAGES = { ...Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, , , C]) => [id, C]))), scout: WalletPage, token: TokenDetail, pool: PoolDetail };

function NavLinks({ page, onPick }) {
  const { t } = useI18n();
  return (
    <nav className="flex flex-col gap-4">
      {NAV.map(([group, items]) => (
        <div key={group}>
          <div className="px-2.5 pb-1 text-[0.6875rem] font-medium text-muted">{t(group)}</div>
          <div className="flex flex-col gap-px">
            {items.map(([id, label, Icon]) => {
              const active = page === id;
              return (
                <a key={id} href={'#' + id} onClick={onPick} aria-current={active ? 'page' : undefined}
                  className={`relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[0.8125rem] transition-colors
                    ${active ? 'bg-default font-medium text-foreground' : 'text-muted hover:bg-default/60 hover:text-foreground'}`}>
                  <Icon className="size-4 shrink-0" strokeWidth={active ? 2 : 1.75} />{t(label)}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

// Warna & teks mode dipakai di sidebar dan header HP — satu sumber.
const modeOf = (m) => (!m ? null : m.paused ? ['Dijeda', 'bg-muted', 'text-muted']
  : m.drawdown?.tripped ? ['Drawdown', 'bg-warning', 'text-warning']
  : m.dry_run ? ['Simulasi', 'bg-accent', 'text-accent'] : ['Live', 'bg-danger', 'text-danger']);

function ModeBadge({ m }) {
  const { t } = useI18n();
  const mo = modeOf(m);
  if (!mo) return <span className="text-xs text-muted">…</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${mo[2]}`}>
      <span className="relative flex size-2">
        {/* denyut hanya saat LIVE: satu-satunya keadaan yang memindahkan uang */}
        {!m.paused && !m.dry_run && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${mo[1]}`} />}
        <span className={`relative inline-flex size-2 rounded-full ${mo[1]}`} />
      </span>
      {t(mo[0])}
    </span>
  );
}

function StatusFoot({ status, reload, theme, toggleTheme }) {
  const { t, locale, setLocale } = useI18n();
  const m = status?.mode;
  const pause = async () => { await post('/api/mode', { paused: !m?.paused }); reload(); };
  // Bukan lewat api.post: /logout membalas redirect ke halaman masuk, bukan JSON.
  const logout = async () => {
    if (!(await ask({ title: t('Keluar dari dasbor?'), body: t('Untuk masuk lagi perlu token akses.'), confirm: t('Keluar dari dasbor') }))) return;
    await fetch('/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = '/';
  };
  return (
    <div className="flex flex-col gap-2.5 border-t border-border p-3">
      <div className="rounded-md border border-border px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{t('Mode')}</span>
          <ModeBadge m={m} />
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-xs text-muted">{t('Wallet')}</span>
          <span className="mono text-xs text-muted">{m?.wallet ? short(m.wallet) : t('belum ada')}</span>
        </div>
      </div>
      {/* Jeda/lanjut satu-satunya aksi yang mengubah bot — berdiri sendiri, selebar sidebar. */}
      <Button size="sm" variant="outline" className="w-full" onPress={pause} isDisabled={!m}>
        {m?.paused ? <><Play className="size-3.5" />{t('Lanjutkan')}</> : <><Pause className="size-3.5" />{t('Jeda')}</>}
      </Button>
      {/* Baris alat: ikon tanpa bingkai di kiri, pemilih bahasa di kanan — mengikuti gaya header HP. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Ganti tema')} onPress={toggleTheme}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <AlertBell placement="top" variant="ghost" iconClass="size-4" />
          {/* Hanya saat gerbang token menyala; tanpa token tidak ada sesi yang bisa ditutup. */}
          {m?.auth && (
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Keluar dari dasbor')} onPress={logout}>
              <LogOut className="size-4" />
            </Button>
          )}
        </div>
        {/* Pemilih bahasa: dua pilihan saja, jadi cukup kontrol bersegmen. */}
        <div className="flex h-8 items-center rounded-md bg-default/60 p-0.5" role="group" aria-label={t('Bahasa')}>
          {Object.entries(LOCALES).map(([k, name]) => (
            <button key={k} onClick={() => setLocale(k)} type="button" title={name} aria-pressed={locale === k}
              className={`h-full rounded-[5px] px-2.5 text-[0.6875rem] font-semibold uppercase tracking-wide transition-colors ${locale === k ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}>
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Pemilih chain di bawah logo. Satu dasbor menampilkan satu chain; memilih chain lain
// menyimpan cookie lpcopy_chain di server lalu memuat ulang halaman supaya semua
// data yang sedang dipoll ikut berganti. Wallet-nya sama di semua chain.
function ChainSwitcher({ chain }) {
  const { t } = useI18n();
  const { data } = usePoll('/api/chains', 15000);
  const [open, setOpen] = useState(false);
  const chains = data?.chains || [];
  const cur = chainInfo();
  const pick = async (key) => {
    setOpen(false);
    if (key === cur.key) return;
    const r = await post('/api/chain/select', { chain: key });
    if (r?.ok) location.reload();
  };
  const icon = CHAIN_ICON[cur.key] || CHAIN_ICON.robinhood;
  // Satu chain saja: tampilkan labelnya tanpa menu.
  if (chains.length <= 1) {
    return (
      <span className="brand-sub flex items-center gap-1.5 text-[0.6875rem] leading-4 text-muted">
        <img src={icon} alt="" width="14" height="14" className="size-3.5 shrink-0 rounded-full" />{chain?.label || cur.label}
      </span>
    );
  }
  return (
    <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}
        title={t('Ganti chain')}
        className="brand-sub flex items-center gap-1.5 rounded-md border border-border/70 px-1.5 py-0.5 text-[0.6875rem] leading-4 text-muted transition-colors hover:border-border hover:text-foreground">
        <img src={icon} alt="" width="14" height="14" className="size-3.5 shrink-0 rounded-full" />
        <span className="font-medium">{chain?.label || cur.label}</span>
        <svg viewBox="0 0 20 20" className="size-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8l4 4 4-4" /></svg>
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 z-40 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface p-1 shadow-lg">
          {chains.map((c) => {
            const active = c.key === cur.key;
            const mode = c.paused ? t('Dijeda') : c.dryRun ? t('Simulasi') : 'Live';
            return (
              <li key={c.key}>
                <button type="button" role="option" aria-selected={active} onClick={() => pick(c.key)}
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${active ? 'bg-default text-foreground' : 'text-muted hover:bg-default/60 hover:text-foreground'}`}>
                  <img src={CHAIN_ICON[c.key] || CHAIN_ICON.robinhood} alt="" width="16" height="16" className="size-4 shrink-0 rounded-full" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{c.label}</span>
                    <span className="truncate text-[0.6875rem] opacity-80">
                      {mode} · {c.targets} {t('target')}{c.verified ? '' : ` · ${t('alamat belum diverifikasi')}`}
                    </span>
                    {/* Saldo wallet di chain ini: kas dalam USD + native. Belum terbaca (mesin baru hidup / tanpa wallet) = strip. */}
                    <span className="truncate text-[0.6875rem] opacity-80" title={c.cash ? `${num(c.cash.stable, 2)} ${c.stableSymbol} · ${num(c.cash.native, 4)} ${c.nativeSymbol}` : undefined}>
                      {c.cash ? `${usd(c.cash.usd)} · ${num(c.cash.native, 4)} ${c.nativeSymbol}` : `— ${c.nativeSymbol}`}
                    </span>
                  </span>
                  {active && <span className="text-accent">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Brand({ chain }) {
  return (
    // data-brand/data-brand-logo: tujuan logo layar pembuka saat terbang ke header
    <div data-brand className="flex shrink-0 flex-col items-start gap-2 text-foreground">
      <a href="#summary" aria-label="Quiver"><QuiverLogo className="h-[22px] w-[121px]" data-brand-logo="" /></a>
      <ChainSwitcher chain={chain} />
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  // Rute berbentuk "halaman/parameter", mis. #target/0xabc… membuka detail satu wallet.
  const [page, ...rest] = useHash('summary').split('/');
  const param = rest.join('/') || null;
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: status, error: statusError, reload } = usePoll('/api/overview', 5000);
  // Layar pembuka ditutup begitu status pertama (atau galatnya) tiba.
  useEffect(() => { if (status || statusError) hideSplash(); }, [status, statusError]);
  // Identitas chain (simbol native, penjelajah, slug DexScreener) dibagikan ke pembantu
  // non-React lewat chain.js begitu status pertama tiba.
  useEffect(() => { if (status?.chain?.key) setChain(status.chain); }, [status?.chain?.key]);
  const chain = status?.chain?.key ? status.chain : chainInfo();
  // Judul tab ikut angka hidup: "Quiver · $1.234,56 · +$56,78" (digulir, lihat setBaseTitle) — total portofolio dan
  // PnL (bersih kalau modal terlacak, kalau tidak PnL posisi), sama dengan kartu di
  // Ringkasan. Dibaca dari sebelah tab lain tanpa membuka dasbornya.
  const w = status?.wallet;
  useEffect(() => {
    if (!w) return;
    const pnl = w.netPnl ?? w.pnl;
    setBaseTitle(`Quiver · ${usd(w.value)} · ${pnl > 0 ? '+' : ''}${usd(pnl)}`);
  }, [w?.value, w?.pnl, w?.netPnl]);
  const Page = PAGES[page] || Overview;
  useTargetAlerts();

  return (
    <StatusCtx.Provider value={{ status, reload }}>
      {/* Toast di atas: peringatan target tidak ketiban baris tabel paling bawah. */}
      <Toast.Provider placement="top" />
      <ConfirmHost />
      <SearchModal />
      <div className="flex min-h-dvh">
        {/* sidebar desktop */}
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex h-[76px] items-center border-b border-border px-5"><Brand chain={chain} /></div>
          {/* data-reveal: disembunyikan selama layar pembuka, muncul berurutan setelah logo mendarat */}
          <div className="flex-1 overflow-y-auto px-2 py-4" data-reveal="nav">
            <div className="mb-3 px-0.5"><SearchTrigger /></div>
            <NavLinks page={page} />
          </div>
          <div data-reveal="nav"><StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} /></div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header mobile */}
          <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
            <Brand chain={chain} />
            <div className="flex items-center gap-1" data-reveal="nav">
              <span className="mr-1 hidden min-[360px]:inline"><ModeBadge m={status?.mode} /></span>
              <SearchTrigger compact />
              <AlertBell placement="bottom" variant="ghost" iconClass="size-4" />
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('Ganti tema')} onPress={toggleTheme}>
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('Menu')} onPress={() => setMenuOpen(!menuOpen)}>
                {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
              </Button>
            </div>
          </header>
          {menuOpen && (
            <div className="border-b border-border bg-surface px-2 py-3 lg:hidden">
              <NavLinks page={page} onPick={() => setMenuOpen(false)} />
              <div className="mt-3"><StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} /></div>
            </div>
          )}

          <StuckAlert />
          <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-reveal="main">
            <Suspense fallback={<Loading page />}><Page key={page + (param || '')} param={param} /></Suspense>
          </main>
          <footer className="mx-auto w-full max-w-[90rem] px-4 pb-5 text-[0.6875rem] text-muted sm:px-6 lg:px-8" data-reveal="foot">
            {t('Quiver · cermin posisi likuiditas')} {chain.key === 'bsc' ? 'Uniswap v3/v4 + PancakeSwap v3' : 'Uniswap v3/v4'} · {chain.label} ({chain.chainId})
          </footer>
        </div>
      </div>
    </StatusCtx.Provider>
  );
}
