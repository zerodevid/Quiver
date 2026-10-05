// Trading-terminal-style alerts: a toast on the dashboard, a short sound, and a desktop
// notification when this tab is not being looked at. Two events: a target opens a position
// (the bot copies) and a copy position is closed — the second always carries its PnL,
// and sounds different so you can tell open from close without looking at the screen.
//
// Preferences are per browser (localStorage), not in the server config: sound and notification
// permission belong to the device — a laptop on the desk may sound, a phone should not.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popover, toast } from '@heroui/react';
import { Bell, BellOff } from 'lucide-react';
import { get } from '../api';
import { usd, pct, age, short } from '../fmt';
import { useI18n, reason as reasonText, translate } from '../i18n';
import { Toggle } from './ui';

// ---- preferences -----------------------------------------------------------
const KEY = 'quiver.alerts';
const DEF = { enabled: true, sound: true, desktop: false };
const load = () => {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEF }; }
};
let prefs = load();
const subs = new Set();
export function setAlertPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: memory alone is enough */ }
  subs.forEach((f) => f());
}
export const useAlertPrefs = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => prefs);

// ---- sound ----------------------------------------------------------------
// Short tones are synthesised via WebAudio — no audio files to download.
// Three sounds: chime (open: two rising sine tones), cashout (close in profit: three quickly
// rising triangle tones, "ka-ching") and loss (close at a loss: two low falling tones).
// Browsers only allow audio after a user interaction, so the context is
// opened on the first click/keystroke on the page; before that the sound silently fails.
let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
if (typeof window !== 'undefined') {
  const unlock = () => { audio(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
}
export function chime() {
  const c = audio();
  if (!c) return;
  const now = c.currentTime;
  for (const [freq, dt] of [[880, 0], [1318.5, 0.11]]) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + dt);
    g.gain.exponentialRampToValueAtTime(0.22, now + dt + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.5);
    o.connect(g).connect(c.destination);
    o.start(now + dt);
    o.stop(now + dt + 0.55);
  }
}

// Close position: profit = three quickly rising triangle tones then a long tone above;
// loss = two low falling tones, slower. The timbre (triangle) differs from the open
// chime (sine) so they can be told apart without looking at the screen.
export function cashout(pnl = 0) {
  const c = audio();
  if (!c) return;
  const now = c.currentTime;
  const seq = pnl >= 0
    ? [[659.25, 0, 0.14], [880, 0.09, 0.14], [1108.7, 0.18, 0.14], [1318.5, 0.27, 0.7]]
    : [[493.88, 0, 0.32], [369.99, 0.26, 0.75]];
  for (const [freq, dt, len] of seq) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + dt);
    g.gain.exponentialRampToValueAtTime(pnl >= 0 ? 0.2 : 0.16, now + dt + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dt + len);
    o.connect(g).connect(c.destination);
    o.start(now + dt);
    o.stop(now + dt + len + 0.05);
  }
}

// Alarm: three falling square tones, harsher and longer than the chime — for
// things that need action (stuck money), not just news.
export function alarm() {
  const c = audio();
  if (!c) return;
  const now = c.currentTime;
  for (const [freq, dt] of [[1046.5, 0], [783.99, 0.18], [523.25, 0.36], [1046.5, 0.7], [783.99, 0.88], [523.25, 1.06]]) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + dt);
    g.gain.exponentialRampToValueAtTime(0.12, now + dt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.17);
    o.connect(g).connect(c.destination);
    o.start(now + dt);
    o.stop(now + dt + 0.18);
  }
}

// ---- tab title: "(3) Quiver · $1,234.56 · +$56.78" -------------------------
// The one place that writes document.title: the base title (portfolio total & PnL,
// updated by App on every poll) and the prefix with the count of unseen alerts while the
// tab is not being looked at. If written separately, a figure that changes while the tab is
// hidden erases the "(3)" prefix, or the other way around.
// A narrow tab only holds a dozen letters, so a long title is scrolled slowly
// (one letter every ~0.4 seconds) like a ticker: the figure and the brand name
// alternate past. The "(3)" prefix does not scroll.
let unseen = 0, baseTitle = 'Quiver', shift = 0, ticker = null;
const renderTitle = () => {
  let body = baseTitle;
  if (ticker) { const s = baseTitle + ' · '; body = s.slice(shift) + s.slice(0, shift); }
  document.title = unseen ? `(${unseen}) ${body}` : body;
};
export function setBaseTitle(title) {
  if (title === baseTitle) return;
  baseTitle = title;
  // only scrolls if there is something to scroll (a plain "Quiver" title stays still)
  if (title.length > 12 && !ticker) {
    ticker = setInterval(() => { shift = (shift + 1) % (baseTitle.length + 3); renderTitle(); }, 400);
  } else if (title.length <= 12 && ticker) { clearInterval(ticker); ticker = null; shift = 0; }
  if (shift >= baseTitle.length + 3) shift = 0;
  renderTitle();
}
export function bumpTitle(n) {
  if (!document.hidden) return;
  unseen += n;
  renderTitle();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unseen) { unseen = 0; renderTitle(); }
  });
}

export const canDesktop = () => typeof Notification !== 'undefined' && window.isSecureContext;

// ---- showing a group of alerts ----------------------------------------------
const who = (it) => it.targetLabel || short(it.target);
const pairOf = (it) => `${it.symbol0 || short(it.token0)}/${it.symbol1 || short(it.token1)}`;
const titleOf = (it) => (it.kind === 'close' ? closeTitle(it)
  : translate(it.adding ? '{who} menambah likuiditas {pair}' : '{who} membuka posisi {pair}', { who: who(it), pair: pairOf(it) }));
// The close title carries its PnL directly: "PEPE/USDG closed · +$12.34 (+5.6%)".
const signed = (v) => (v >= 0 ? '+' : '') + usd(v);
// Proceeds = capital after slippage (the difference is only gas) is neither profit nor loss;
// a minus because of slippage is still a loss.
const netResult = (it) => (it.pnlUsd || 0) - (it.slipUsd || 0);
const breakEven = (it) => Math.abs(netResult(it)) < 0.01;
const closeTitle = (it) => (breakEven(it) ? translate('{pair} ditutup · impas', { pair: pairOf(it) })
  : translate(netResult(it) >= 0 ? '{pair} ditutup · untung {pnl}' : '{pair} ditutup · rugi {pnl}',
    { pair: pairOf(it), pnl: `${signed(it.pnlUsd)}${it.pnlPct != null ? ` (${pct(it.pnlPct)})` : ''}` }));
const closeDesc = (it) => [
  translate('hasil {out} · modal {cost}', { out: usd(it.outUsd), cost: usd(it.costUsd) }),
  it.ageHours != null && translate('dipegang {d}', { d: age(it.ageHours) }),
  it.mirrored ? translate('ikut target keluar{who}', { who: it.target ? ` (${who(it)})` : '' }) : translate('keluar mandiri / manual'),
].filter(Boolean).join(' · ');

// A position closed manually from the dashboard was already given a toast by its own close
// flow; the feed does not need to repeat it a few seconds later.
const mutedClose = new Set();
export function muteClose(positionId) { mutedClose.add(Number(positionId)); }
const verdictOf = (it) => (
  it.verdict === 'copy' ? translate('Disalin bot')
    : it.verdict === 'dry' ? translate('Simulasi — tidak dikirim')
      : it.verdict === 'skip' ? translate('Dilewati: {r}', { r: reasonText(it.reason) })
        : it.verdict === 'error' ? translate('Gagal disalin: {r}', { r: reasonText(it.reason) })
          : translate('Bot sedang memproses…'));
const descOf = (it) => [
  it.valueUsd != null && usd(it.valueUsd),
  it.venue && `${({ meteora: 'Meteora DLMM', orca: 'Orca', raydium: 'Raydium CLMM', pancakev3: 'PancakeSwap V3' })[it.venue] || `Uniswap ${String(it.venue).replace('pool', '').toUpperCase()}`}${it.fee != null ? ` · ${it.fee / 10000}%` : ''}`,
  verdictOf(it),
].filter(Boolean).join(' · ');

const linkOf = (it) => (it.positionId ? `positions/${it.positionId}` : `targets/${it.target}`);

function announce(all, { sound, desktop, preview = false }) {
  const items = all.filter((it) => !(it.kind === 'close' && mutedClose.has(Number(it.positionId))));
  if (!items.length) return;
  const opens = items.filter((it) => it.kind !== 'close');
  const closes = items.filter((it) => it.kind === 'close');
  if (sound) {
    // Open and close in one round: sound them in sequence, not overlapping.
    if (opens.length) chime();
    if (closes.length) {
      const net = closes.reduce((a, it) => a + (it.pnlUsd || 0), 0);
      if (opens.length) setTimeout(() => cashout(net), 750); else cashout(net);
    }
  }
  bumpTitle(items.length);
  // A flood of actions (e.g. one target opening many positions at once) becomes one summary.
  if (opens.length > 3) {
    toast(translate('{n} posisi baru dari target', { n: opens.length }), {
      variant: 'accent', timeout: 10000,
      description: [...new Set(opens.map(who))].slice(0, 4).join(', '),
      actionProps: { children: translate('Aktivitas'), onPress: () => { location.hash = 'activity'; } },
    });
  }
  if (closes.length > 3) {
    const net = closes.reduce((a, it) => a + (it.pnlUsd || 0), 0);
    toast(translate('{n} posisi ditutup · total {pnl}', { n: closes.length, pnl: signed(net) }), {
      variant: net >= 0 ? 'success' : 'danger', timeout: 15000,
      description: closes.map((it) => `${pairOf(it)} ${signed(it.pnlUsd)}`).slice(0, 4).join(' · '),
      actionProps: { children: translate('Posisi'), onPress: () => { location.hash = 'positions'; } },
    });
  }
  const shown = [...(opens.length > 3 ? [] : opens), ...(closes.length > 3 ? [] : closes)];
  for (const it of shown) {
    const go = preview ? null : () => { location.hash = linkOf(it); };
    const close = it.kind === 'close';
    let key = null;
    key = toast(titleOf(it), {
      variant: close ? (breakEven(it) ? 'default' : netResult(it) >= 0 ? 'success' : 'danger') : 'accent',
      timeout: close ? 15000 : 10000,
      description: close ? closeDesc(it) : descOf(it),
      actionProps: go ? { children: translate('Lihat'), onPress: () => { go(); if (key) toast.close(key); } } : undefined,
    });
  }
  if (desktop && document.hidden && canDesktop() && Notification.permission === 'granted') {
    const it = items[items.length - 1];
    const many = items.length > 1;
    const title = !many ? titleOf(it)
      : closes.length && !opens.length ? translate('{n} posisi ditutup · total {pnl}', { n: closes.length, pnl: signed(closes.reduce((a, x) => a + (x.pnlUsd || 0), 0)) })
        : translate('{n} kejadian baru', { n: items.length });
    const n = new Notification(title, {
      body: many ? items.map(titleOf).slice(0, 4).join('\n') : it.kind === 'close' ? closeDesc(it) : descOf(it),
      tag: `quiver-feed-${it.id}`,
    });
    n.onclick = () => { window.focus(); location.hash = many ? (opens.length ? 'activity' : 'positions') : linkOf(it); n.close(); };
  }
}

// ---- poller: mounted ONCE in App --------------------------------------
// Keeps running while the tab is hidden (less often) — that is exactly when sound and
// desktop notifications are useful. After being switched off then on again, the starting point
// is fetched again so actions during the off period are not sounded later.
export function useTargetAlerts() {
  const p = useAlertPrefs();
  const last = useRef(null);          // id of the last action already announced
  const lastClosed = useRef(0);       // the last close time already announced
  useEffect(() => {
    if (!p.enabled) return undefined;
    last.current = null;
    let alive = true, timer = null;
    const tick = async () => {
      try {
        const first = last.current == null;
        const r = await get(first ? '/api/feed' : `/api/feed?after=${last.current}&closedAfter=${lastClosed.current}`);
        if (!alive || r.error) return;
        if (!first && r.items?.length) announce(r.items, prefs);
        last.current = Math.max(last.current ?? 0, r.lastId ?? 0);
        lastClosed.current = Math.max(lastClosed.current, r.lastClosed ?? 0, ...(r.items || []).map((it) => (it.kind === 'close' ? it.ts : 0)));
      } catch { /* network down: retry on the next round */ }
      finally { if (alive) timer = setTimeout(tick, document.hidden ? 8000 : 4000); }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [p.enabled]);
}

// ---- bell button + its settings ----------------------------------------
export function AlertBell({ placement = 'top', variant = 'outline', iconClass = 'size-3.5' }) {
  const { t } = useI18n();
  const p = useAlertPrefs();
  const [perm, setPerm] = useState(() => (canDesktop() ? Notification.permission : 'unsupported'));
  const setDesktop = async (on) => {
    if (on && perm !== 'granted') {
      const r = await Notification.requestPermission();
      setPerm(r);
      if (r !== 'granted') return;
    }
    setAlertPrefs({ desktop: on });
  };
  const desktopHint = perm === 'unsupported' ? 'Butuh dasbor lewat HTTPS atau localhost.'
    : perm === 'denied' ? 'Diblokir browser — izinkan notifikasi dari pengaturan situs.'
      : 'Muncul saat tab ini sedang tidak dibuka.';
  // Sample alerts, per kind, so the sound and toast shape of each event can be
  // tried individually: open (chime), close in profit and close at a loss (cashout).
  const EXAMPLE = { target: '0x0000000000000000000000000000000000000000', targetLabel: t('Contoh target'), symbol0: 'PEPE', symbol1: 'USDG', venue: 'v4', fee: 10000 };
  const sample = (kindName) => announce([
    kindName === 'open' ? { ...EXAMPLE, kind: 'open', id: 0, valueUsd: 1250, verdict: null }
      : kindName === 'profit' ? { ...EXAMPLE, kind: 'close', id: 'c0', mirrored: true, costUsd: 1250, outUsd: 1318.75, pnlUsd: 68.75, pnlPct: 5.5, ageHours: 6.2 }
        : { ...EXAMPLE, kind: 'close', id: 'c1', mirrored: false, costUsd: 1250, outUsd: 1102.5, pnlUsd: -147.5, pnlPct: -11.8, ageHours: 0.7 },
  ], { sound: true, desktop: false, preview: true });
  const Icon = p.enabled ? Bell : BellOff;
  return (
    <Popover>
      <Button size="sm" variant={variant} isIconOnly aria-label={t('Peringatan target')}>
        <Icon className={iconClass} />
      </Button>
      <Popover.Content placement={placement} className="w-72 max-w-[calc(100vw-2rem)]">
        <Popover.Dialog className="flex flex-col gap-3 p-3">
          <div>
            <Popover.Heading className="text-sm font-medium">{t('Peringatan target')}</Popover.Heading>
            <p className="mt-0.5 text-xs text-muted">{t('Toast dan bunyi saat wallet target membuka posisi LP, dan saat posisi salinan ditutup — lengkap dengan PnL-nya. Bunyi buka dan tutup berbeda.')}</p>
          </div>
          <Toggle label="Aktif" value={p.enabled} onChange={(v) => setAlertPrefs({ enabled: v })} />
          <Toggle label="Bunyi" value={p.sound} isDisabled={!p.enabled} onChange={(v) => setAlertPrefs({ sound: v })} />
          <Toggle label="Notifikasi desktop" desc={desktopHint} value={p.desktop && perm === 'granted'}
            isDisabled={!p.enabled || perm === 'unsupported' || perm === 'denied'} onChange={setDesktop} />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">{t('Coba peringatan')}</span>
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" className="col-span-2 w-full" onPress={() => sample('open')}>{t('Buka posisi')}</Button>
              <Button size="sm" variant="outline" className="w-full text-success" onPress={() => sample('profit')}>{t('Tutup untung')}</Button>
              <Button size="sm" variant="outline" className="w-full text-danger" onPress={() => sample('loss')}>{t('Tutup rugi')}</Button>
            </div>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
