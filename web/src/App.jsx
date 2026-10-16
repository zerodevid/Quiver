import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react';
import { Button, Chip, Toast, toast } from '@heroui/react';
import {
  LayoutDashboard, Layers, ListChecks, Users, SlidersHorizontal, Wallet as WalletIcon,
  Settings as SettingsIcon, Moon, Sun, Pause, Play, Menu, X, LogOut, Eye, EyeOff,
  PlusCircle, ArrowDownUp, BookOpen, MonitorDot, ScrollText, UserCog,
} from 'lucide-react';
import { usePoll, useHash, useTheme } from './hooks';
import { post, withChain, setMergedPage } from './api';
import { short, usd, num } from './fmt';
import { chainInfo, setChain, registerChains, setAllMode, getScope, setScope, getChainFilter, setChainFilter, CHAIN_ICON } from './chain';
import { setFx } from './currency';
import { usePrivacy, setDefaultHidden } from './privacy';
import { useI18n, LOCALES } from './i18n';
import { QuiverLogo } from './components/Logo';
import { AlertBell, useTargetAlerts, setBaseTitle } from './components/TargetAlerts';
import StuckAlert from './components/StuckAlert';
import SearchModal, { SearchTrigger } from './components/GlobalSearch';

import { Loading, ConfirmHost, WalletLinks, ask } from './components/ui';
import { hideSplash } from './splash';
import { isMini } from './telegram';
import { useMe, isSuperadmin } from './me';

// Each page is loaded when opened — the chart library is only downloaded for the Summary.
const Overview = lazy(() => import('./pages/Overview'));
const Monitor = lazy(() => import('./pages/Monitor'));
const Positions = lazy(() => import('./pages/Positions'));
const Activity = lazy(() => import('./pages/Activity'));
const Logs = lazy(() => import('./pages/Logs'));
const Targets = lazy(() => import('./pages/Targets'));
const Rules = lazy(() => import('./pages/Rules'));
const WalletPage = lazy(() => import('./pages/Wallet'));
const Settings = lazy(() => import('./pages/Settings'));
const ManualLp = lazy(() => import('./pages/ManualLp'));
const Swap = lazy(() => import('./pages/Swap'));
const Learn = lazy(() => import('./pages/Learn'));
const Admin = lazy(() => import('./pages/Admin'));
// Not in the menu: opened from a token icon (#token/0x…) and a pair name (#pool/0x…).
const TokenDetail = lazy(() => import('./pages/TokenDetail'));
const PoolDetail = lazy(() => import('./pages/PoolDetail'));

// The engine status is polled ONCE here and then shared to all pages.
const StatusCtx = createContext(null);
export const useStatus = () => useContext(StatusCtx);

const NAV = [
  ['Pemantauan', [
    ['summary', 'Ringkasan', LayoutDashboard, Overview],
    ['monitor', 'Monitor', MonitorDot, Monitor],
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
    ['logs', 'Log', ScrollText, Logs],
    ['settings', 'Pengaturan', SettingsIcon, Settings],
  ]],
];
// #scout used to be its own page; its content is now inside Wallet. Old links
// (bookmarks, Telegram messages) still land in the right place.
// Multi-user: the superadmin also gets the account console under System.
const ADMIN_ITEM = ['admin', 'Akun', UserCog, Admin];
const navFor = (me) => (isSuperadmin(me) && me.multiUser
  ? NAV.map(([g, items]) => [g, g === 'Sistem' ? [...items, ADMIN_ITEM] : items]) : NAV);
const PAGES = { ...Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, , , C]) => [id, C]))), scout: WalletPage, token: TokenDetail, pool: PoolDetail, admin: Admin };

function NavLinks({ page, onPick }) {
  const { t } = useI18n();
  const me = useMe();
  return (
    <nav className="flex flex-col gap-4">
      {navFor(me).map(([group, items]) => (
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

// Mode colours & text are used in the sidebar and the mobile header — one source.
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
        {/* pulse only when LIVE: the one state that moves money */}
        {!m.paused && !m.dry_run && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${mo[1]}`} />}
        <span className={`relative inline-flex size-2 rounded-full ${mo[1]}`} />
      </span>
      {t(mo[0])}
    </span>
  );
}

// Portfolio value redaction (privacy.js): the eye icon next to the theme button. One
// switch for all — stored on the server, so other tabs, devices, and the mini app
// follow within one poll round.
function PrivacyButton({ hidden, toggle }) {
  const { t } = useI18n();
  const label = t(hidden ? 'Tampilkan nilai portofolio' : 'Sensor nilai portofolio');
  return (
    <Button size="sm" variant="ghost" isIconOnly aria-label={label} aria-pressed={hidden}
      onPress={async () => { const r = await toggle(); if (r?.error) toast.danger(r.error); }}>
      <span title={label}>{hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</span>
    </Button>
  );
}

function StatusFoot({ status, reload, theme, toggleTheme, privacy }) {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const account = me?.user && !me.user.legacy ? me.user : null;
  const m = status?.mode;
  // The combined view pauses/resumes every chain it shows, each through its own server.
  const pause = async () => {
    const keys = status?.chain?.all ? status.chain.chains || [] : [null];
    await Promise.all(keys.map((k) => post(withChain('/api/mode', k), { paused: !m?.paused })));
    reload();
  };
  // Not via api.post: /logout replies with a redirect to the sign-in page, not JSON.
  const logout = async () => {
    if (!(await ask({ title: t('Keluar dari dasbor?'), body: t(account ? 'Untuk masuk lagi perlu nama pengguna dan kata sandi.' : 'Untuk masuk lagi perlu token akses.'), confirm: t('Keluar dari dasbor') }))) return;
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
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{t('Wallet')}</span>
          {/* The bot's own wallet can also be opened externally — check its balance & txs
              without copying the address first. */}
          <span className="flex items-center gap-1">
            <span className="mono text-xs whitespace-nowrap text-muted">{m?.wallet ? short(m.wallet) : t('belum ada')}</span>
            {m?.wallet && <WalletLinks address={m.wallet} compact className="trade-snug" />}
          </span>
        </div>
        {account && (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{t('Akun')}</span>
            <span className="truncate text-xs font-medium" title={account.username}>{account.username}</span>
          </div>
        )}
      </div>
      {/* Pause/resume is the only action that changes the bot — standalone, as wide as the sidebar. */}
      <Button size="sm" variant="outline" className="w-full" onPress={pause} isDisabled={!m}>
        {m?.paused ? <><Play className="size-3.5" />{t('Lanjutkan')}</> : <><Pause className="size-3.5" />{t('Jeda')}</>}
      </Button>
      {/* Tool row: frameless icons on the left, language picker on the right — follows the mobile header style. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('Ganti tema')} onPress={toggleTheme}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <PrivacyButton hidden={privacy[0]} toggle={privacy[1]} />
          <AlertBell placement="top" variant="ghost" iconClass="size-4" />
          {/* Only when the gate is on (token or accounts); otherwise there is no session to close. The
              Telegram mini app signs in by itself each time it opens, so it has nothing to log out of. */}
          {(m?.auth || account) && !isMini() && (
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Keluar dari dasbor')} onPress={logout}>
              <LogOut className="size-4" />
            </Button>
          )}
        </div>
        {/* Language picker: only two choices, so a segmented control is enough. */}
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

// Chain picker under the logo. One dashboard shows one chain; choosing another chain
// saves the lpcopy_chain cookie on the server then reloads the page so all
// data being polled changes too. The wallet is the same on all chains.
function ChainSwitcher({ chain, data }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const chains = data?.chains || [];
  const all = data?.current === 'all';
  const cur = all ? { key: 'all', label: t('Semua chain') } : chainInfo();
  const pick = async (key) => {
    setOpen(false);
    if (key === cur.key) return;
    const r = await post('/api/chain/select', { chain: key });
    if (r?.ok) { setScope(null); location.reload(); }
  };
  const icon = all ? null : CHAIN_ICON[cur.key] || CHAIN_ICON.robinhood;
  const allUsd = chains.reduce((a, c) => a + (c.cash?.usd || 0), 0);
  // A single chain: show its label without a menu.
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
        {icon ? <img src={icon} alt="" width="14" height="14" className="size-3.5 shrink-0 rounded-full" /> : <ChainStack keys={chains.map((c) => c.key)} />}
        <span className="font-medium">{all ? cur.label : chain?.label || cur.label}</span>
        <svg viewBox="0 0 20 20" className="size-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8l4 4 4-4" /></svg>
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 z-40 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface p-1 shadow-lg">
          {/* Every chain together: portfolio, positions, activity and transactions merged. */}
          <li>
            <button type="button" role="option" aria-selected={all} onClick={() => pick('all')}
              className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${all ? 'bg-default text-foreground' : 'text-muted hover:bg-default/60 hover:text-foreground'}`}>
              <ChainStack keys={chains.map((c) => c.key)} size={16} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{t('Semua chain')}</span>
                <span className="truncate text-[0.6875rem] opacity-80">{t('{n} chain · kas {v}', { n: chains.length, v: usd(allUsd) })}</span>
              </span>
              {all && <span className="text-accent">✓</span>}
            </button>
          </li>
          <li className="my-1 border-t border-border" aria-hidden="true" />
          {chains.map((c) => {
            const active = !all && c.key === cur.key;
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
                    {/* Wallet balance on this chain: cash in USD + native. Not read yet (engine just started / no wallet) = dash. */}
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

// Overlapping chain logos: the mark of the all-chains view.
function ChainStack({ keys, size = 14 }) {
  const shown = keys.slice(0, 3);
  return (
    <span className="flex shrink-0 items-center" style={{ width: size + (shown.length - 1) * (size * 0.45) }}>
      {shown.map((k, i) => (
        <img key={k} src={CHAIN_ICON[k] || CHAIN_ICON.robinhood} alt="" width={size} height={size}
          className="shrink-0 rounded-full ring-1 ring-surface" style={{ width: size, height: size, marginLeft: i ? -size * 0.55 : 0 }} />
      ))}
    </span>
  );
}

// Pages that show every chain together in the all-chains view. The rest belong to one chain
// (rules, targets, swaps, a position's detail) and get a chain picker on top instead.
const MERGED_PAGES = new Set(['summary', 'positions', 'activity']);
const isMergedPage = (page, param) => MERGED_PAGES.has(page) && !param;

// All-chains view: which chains are summed (merged pages) or which chain a single-chain page
// is looking at. Changing either reloads, like the chain switcher.
function ChainScopeBar({ merged, byChain, chains }) {
  const { t } = useI18n();
  if (!chains?.length) return null;
  const chip = (key, on, onPress, sub) => (
    <button key={key} type="button" onClick={onPress} aria-pressed={on}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? 'border-accent bg-accent/10 text-foreground' : 'border-border text-muted hover:text-foreground'}`}>
      <img src={CHAIN_ICON[key] || CHAIN_ICON.robinhood} alt="" className="size-3.5 rounded-full" />
      {chains.find((c) => c.key === key)?.label || key}
      {sub && <span className="opacity-70">{sub}</span>}
    </button>
  );
  if (merged) {
    const shown = new Set((byChain || []).map((c) => c.key));
    const filter = getChainFilter();
    const toggle = (key) => {
      const next = shown.has(key) ? [...shown].filter((k) => k !== key) : [...shown, key];
      if (!next.length) return;
      setChainFilter(next);
      location.reload();
    };
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{t('Chain dijumlah')}</span>
        {chains.map((c) => chip(c.key, shown.has(c.key), () => toggle(c.key), c.dryRun ? t('simulasi') : null))}
        {filter.length > 0 && (
          <button type="button" className="text-xs text-muted underline hover:text-foreground" onClick={() => { setChainFilter([]); location.reload(); }}>
            {t('Hanya yang live')}
          </button>
        )}
      </div>
    );
  }
  const cur = getScope() || chains[0]?.key;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">{t('Halaman ini untuk satu chain')}</span>
      {chains.map((c) => chip(c.key, c.key === cur, () => { if (c.key !== cur) { setScope(c.key); location.reload(); } }))}
    </div>
  );
}

function Brand({ chain, chains }) {
  return (
    // data-brand/data-brand-logo: the destination of the splash logo when it flies to the header
    <div data-brand className="flex shrink-0 flex-col items-start gap-2 text-foreground">
      <a href="#summary" aria-label="Quiver"><QuiverLogo className="h-[22px] w-[121px]" data-brand-logo="" /></a>
      <ChainSwitcher chain={chain} data={chains} />
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  // Routes of the form "page/parameter", e.g. #target/0xabc… opens the detail of a single wallet.
  const [page, ...rest] = useHash('summary').split('/');
  const param = rest.join('/') || null;
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // Value redaction: App is redrawn when its switch changes, so the whole
  // page reformats its numbers via usd()/fmtQty(), which already know the state.
  const privacy = usePrivacy();
  const { data: status, error: statusError, reload } = usePoll('/api/overview', 5000);
  // Every chain with its identity and cash: the chain picker, and the rows of the all-chains view.
  const { data: chainList } = usePoll('/api/chains', 15000);
  if (chainList?.chains) registerChains(chainList.chains);
  // The splash screen closes as soon as the first status (or its error) arrives.
  useEffect(() => { if (status || statusError) hideSplash(); }, [status, statusError]);
  // The chain identity (native symbol, explorer, DexScreener slug) is shared with non-React
  // helpers via chain.js as soon as the first status arrives.
  // All-chains view: the merged pages keep the combined identity; a single-chain page takes the
  // identity of the chain it is scoped to, and its requests carry ?chain= (api.js).
  const allView = !!status?.chain?.all;
  const merged = isMergedPage(page, param);
  if (status?.chain) setAllMode(allView);   // before the first status: the cookie decides (chain.js)
  setMergedPage(merged);
  const scope = allView && !merged ? getScope() || status.chain.chains?.[0] : null;
  if (allView && !merged && !getScope() && scope) setScope(scope);
  // Set during render, not in an effect: the page below reads it in its own first render.
  if (status?.chain?.key) setChain(scope && chainInfo(scope).key === scope ? { ...chainInfo(scope), all: false } : status.chain);
  // The secondary currency rate rides on the same poll; the <Fx> component reads it.
  useEffect(() => { setFx(status?.fx || null); }, [status?.fx?.currency, status?.fx?.rate]);
  // The default value redaction from Settings → Display; the eye icon overrides it per tab.
  useEffect(() => { if (status && 'hideValues' in status) setDefaultHidden(status.hideValues); }, [status?.hideValues]);
  const chain = status?.chain?.key ? status.chain : chainInfo();
  // A single-chain page inside the combined view renders once its chain identity is in place.
  const pageKey = page + (param || '') + (scope ? `@${scope}` : '');
  // The tab title follows the live figures: "Quiver · $1,234.56 · +$56.78" (scrolling, see setBaseTitle) — portfolio total and
  // PnL (net if capital is tracked, otherwise position PnL), the same as the card on the
  // Summary. Readable from beside another tab without opening the dashboard.
  const w = status?.wallet;
  useEffect(() => {
    if (!w) return;
    const pnl = w.netPnl ?? w.pnl;
    // Value redaction: the tab title is readable from anywhere (taskbar, screen recording) — blank it.
    setBaseTitle(privacy[0] ? 'Quiver' : `Quiver · ${usd(w.value)} · ${pnl > 0 ? '+' : ''}${usd(pnl)}`);
  }, [w?.value, w?.pnl, w?.netPnl, privacy[0]]);
  const Page = PAGES[page] || Overview;
  useTargetAlerts();

  return (
    <StatusCtx.Provider value={{ status, reload }}>
      {/* Toast on top: a target warning must not be covered by the bottom table row. */}
      <Toast.Provider placement="top" />
      <ConfirmHost />
      <SearchModal />
      <div className="flex min-h-dvh">
        {/* sidebar desktop */}
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex h-[76px] items-center border-b border-border px-5"><Brand chain={chain} chains={chainList} /></div>
          {/* data-reveal: disembunyikan selama layar pembuka, muncul berurutan setelah logo mendarat */}
          <div className="flex-1 overflow-y-auto px-2 py-4" data-reveal="nav">
            <div className="mb-3 px-0.5"><SearchTrigger /></div>
            <NavLinks page={page} />
          </div>
          <div data-reveal="nav"><StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} privacy={privacy} /></div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header mobile */}
          <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
            <Brand chain={chain} chains={chainList} />
            <div className="flex items-center gap-1" data-reveal="nav">
              <span className="mr-1 hidden min-[360px]:inline"><ModeBadge m={status?.mode} /></span>
              <SearchTrigger compact />
              <PrivacyButton hidden={privacy[0]} toggle={privacy[1]} />
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
              <div className="mt-3"><StatusFoot status={status} reload={reload} theme={theme} toggleTheme={toggleTheme} privacy={privacy} /></div>
            </div>
          )}

          <StuckAlert />
          <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-reveal="main">
            {allView && <ChainScopeBar merged={merged} byChain={status.byChain} chains={chainList?.chains} />}
            <Suspense fallback={<Loading page />}><Page key={pageKey} param={param} /></Suspense>
          </main>
          <footer className="mx-auto w-full max-w-[90rem] px-4 pb-5 text-[0.6875rem] text-muted sm:px-6 lg:px-8" data-reveal="foot">
            {t('Quiver · cermin posisi likuiditas')} {chain.all ? `· ${t('Semua chain')}` : <>{chain.key === 'bsc' ? 'Uniswap v3/v4 + PancakeSwap v3' : 'Uniswap v3/v4'} · {chain.label} ({chain.chainId})</>}
          </footer>
        </div>
      </div>
    </StatusCtx.Provider>
  );
}
