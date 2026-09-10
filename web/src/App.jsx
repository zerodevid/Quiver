import { createContext, lazy, Suspense, useContext, useState } from 'react';
import { Button, Chip, Toast } from '@heroui/react';
import {
  LayoutDashboard, Layers, ListChecks, Users, SlidersHorizontal, Wallet as WalletIcon,
  Radar, Settings as SettingsIcon, Moon, Sun, Pause, Play, Menu, X,
} from 'lucide-react';
import { usePoll, useHash, useTheme } from './hooks';
import { post } from './api';
import { short } from './fmt';
import { useI18n, LOCALES } from './i18n';

import { Loading } from './components/ui';

// Tiap halaman dimuat saat dibuka — pustaka grafik cuma diunduh untuk Ringkasan.
const Overview = lazy(() => import('./pages/Overview'));
const Positions = lazy(() => import('./pages/Positions'));
const Activity = lazy(() => import('./pages/Activity'));
const Targets = lazy(() => import('./pages/Targets'));
const Rules = lazy(() => import('./pages/Rules'));
const WalletPage = lazy(() => import('./pages/Wallet'));
const Scout = lazy(() => import('./pages/Scout'));
const Settings = lazy(() => import('./pages/Settings'));

// Status mesin dipoll SEKALI di sini lalu dibagi ke semua halaman.
const StatusCtx = createContext(null);
export const useStatus = () => useContext(StatusCtx);

const NAV = [
  ['Pemantauan', [
    ['ringkasan', 'Ringkasan', LayoutDashboard, Overview],
    ['posisi', 'Posisi', Layers, Positions],
    ['aktivitas', 'Aktivitas', ListChecks, Activity],
  ]],
  ['Copy', [
    ['target', 'Target', Users, Targets],
    ['aturan', 'Aturan', SlidersHorizontal, Rules],
  ]],
  ['Riset', [
    ['wallet', 'Wallet', WalletIcon, WalletPage],
    ['scout', 'Scout', Radar, Scout],
  ]],
  ['Sistem', [
    ['pengaturan', 'Pengaturan', SettingsIcon, Settings],
  ]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, , , C]) => [id, C])));

function NavLinks({ page, onPick }) {
  const { t } = useI18n();
  return (
    <nav className="flex flex-col gap-5">
      {NAV.map(([group, items]) => (
        <div key={group}>
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(group)}</div>
          <div className="flex flex-col gap-0.5">
            {items.map(([id, label, Icon]) => {
              const active = page === id;
              return (
                <a key={id} href={'#' + id} onClick={onPick}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors
                    ${active ? 'bg-default font-medium text-foreground' : 'text-muted hover:bg-default/60 hover:text-foreground'}`}>
                  <Icon className="size-4" strokeWidth={active ? 2 : 1.75} />{t(label)}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function StatusFoot({ status, reload, theme, toggleTheme }) {
  const { t, locale, setLocale } = useI18n();
  const m = status?.mode;
  const pause = async () => { await post('/api/mode', { paused: !m?.paused }); reload(); };
  return (
    <div className="flex flex-col gap-3 border-t border-border p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">{t('Mode')}</span>
        {m ? <Chip size="sm" variant="soft" color={m.paused ? 'default' : m.dry_run ? 'accent' : 'danger'}>
          {t(m.paused ? 'Dijeda' : m.dry_run ? 'Simulasi' : 'Live')}</Chip> : '…'}
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">{t('Wallet')}</span>
        <span className="mono text-muted">{m?.wallet ? short(m.wallet) : t('belum ada')}</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onPress={pause} isDisabled={!m}>
          {m?.paused ? <><Play className="size-3.5" />{t('Lanjutkan')}</> : <><Pause className="size-3.5" />{t('Jeda')}</>}
        </Button>
        <Button size="sm" variant="outline" isIconOnly aria-label={t('Ganti tema')} onPress={toggleTheme}>
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
      {/* Pemilih bahasa: dua pilihan saja, jadi cukup tombol berdampingan. */}
      <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={t('Bahasa')}>
        {Object.entries(LOCALES).map(([k, name]) => (
          <button key={k} onClick={() => setLocale(k)} type="button"
            className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${locale === k ? 'bg-default font-medium' : 'text-muted hover:text-foreground'}`}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Brand() {
  return (
    <a href="#ringkasan" className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="flex size-7 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-foreground">LP</span>
      lpcopy
    </a>
  );
}

export default function App() {
  const { t } = useI18n();
  // Rute berbentuk "halaman/parameter", mis. #target/0xabc… membuka detail satu wallet.
  const [page, ...rest] = useHash('ringkasan').split('/');
  const param = rest.join('/') || null;
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: status, reload } = usePoll('/api/overview', 5000);
  const Page = PAGES[page] || Overview;

  return (
    <StatusCtx.Provider value={{ status, reload }}>
      <Toast.Provider />
      <div className="flex min-h-dvh">
        {/* sidebar desktop */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="px-5 py-5"><Brand /></div>
          <div className="flex-1 overflow-y-auto px-2"><NavLinks page={page} /></div>
          <StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header mobile */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
            <Brand />
            <div className="flex items-center gap-1">
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

          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Suspense fallback={<Loading />}><Page key={page + (param || '')} param={param} /></Suspense>
          </main>
          <footer className="mx-auto w-full max-w-7xl px-4 pb-6 text-xs text-muted sm:px-6 lg:px-8">
            {t('lpcopy · cermin posisi likuiditas Uniswap v3/v4 · Robinhood Chain (4663)')}
          </footer>
        </div>
      </div>
    </StatusCtx.Provider>
  );
}
