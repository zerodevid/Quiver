import { createContext, lazy, Suspense, useContext, useState } from 'react';
import { Button, Chip, Toast } from '@heroui/react';
import {
  LayoutDashboard, Layers, ListChecks, Users, SlidersHorizontal, Wallet as WalletIcon,
  Settings as SettingsIcon, Moon, Sun, Pause, Play, Menu, X,
  PlusCircle, ArrowDownUp,
} from 'lucide-react';
import { usePoll, useHash, useTheme } from './hooks';
import { post } from './api';
import { short } from './fmt';
import { useI18n, LOCALES } from './i18n';
import { QuiverMark } from './components/Logo';
import { AlertBell, useTargetAlerts } from './components/TargetAlerts';
import StuckAlert from './components/StuckAlert';

import { Loading, ConfirmHost } from './components/ui';

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
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="flex-1" onPress={pause} isDisabled={!m}>
          {m?.paused ? <><Play className="size-3.5" />{t('Lanjutkan')}</> : <><Pause className="size-3.5" />{t('Jeda')}</>}
        </Button>
        <Button size="sm" variant="outline" isIconOnly aria-label={t('Ganti tema')} onPress={toggleTheme}>
          {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </Button>
        <AlertBell placement="top" />
        {/* Pemilih bahasa: dua pilihan saja, jadi cukup satu tombol berganti. */}
        <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={t('Bahasa')}>
          {Object.entries(LOCALES).map(([k, name]) => (
            <button key={k} onClick={() => setLocale(k)} type="button" title={name} aria-pressed={locale === k}
              className={`rounded px-1.5 text-[0.6875rem] font-medium uppercase transition-colors ${locale === k ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <a href="#summary" className="flex items-center gap-2.5">
      <QuiverMark className="size-7" />
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">Quiver</span>
        <span className="block text-[0.6875rem] text-muted">Robinhood Chain</span>
      </span>
    </a>
  );
}

export default function App() {
  const { t } = useI18n();
  // Rute berbentuk "halaman/parameter", mis. #target/0xabc… membuka detail satu wallet.
  const [page, ...rest] = useHash('summary').split('/');
  const param = rest.join('/') || null;
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: status, reload } = usePoll('/api/overview', 5000);
  const Page = PAGES[page] || Overview;
  useTargetAlerts();

  return (
    <StatusCtx.Provider value={{ status, reload }}>
      {/* Toast di atas: peringatan target tidak ketiban baris tabel paling bawah. */}
      <Toast.Provider placement="top" />
      <ConfirmHost />
      <div className="flex min-h-dvh">
        {/* sidebar desktop */}
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex h-14 items-center border-b border-border px-4"><Brand /></div>
          <div className="flex-1 overflow-y-auto px-2 py-4"><NavLinks page={page} /></div>
          <StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header mobile */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
            <Brand />
            <div className="flex items-center gap-1">
              <span className="mr-2"><ModeBadge m={status?.mode} /></span>
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
          <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            <Suspense fallback={<Loading />}><Page key={page + (param || '')} param={param} /></Suspense>
          </main>
          <footer className="mx-auto w-full max-w-[90rem] px-4 pb-5 text-[0.6875rem] text-muted sm:px-6 lg:px-8">
            {t('Quiver · cermin posisi likuiditas Uniswap v3/v4 · Robinhood Chain (4663)')}
          </footer>
        </div>
      </div>
    </StatusCtx.Provider>
  );
}
