// Peringatan "target membuka posisi" ala terminal trading: toast di dasbor, bunyi
// singkat, dan notifikasi desktop kalau tab ini sedang tidak dilihat.
//
// Preferensinya per browser (localStorage), bukan di config server: bunyi dan izin
// notifikasi memang milik perangkat — laptop di meja boleh berbunyi, HP jangan.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popover, toast } from '@heroui/react';
import { Bell, BellOff } from 'lucide-react';
import { get } from '../api';
import { usd, short } from '../fmt';
import { useI18n, reason as reasonText, translate } from '../i18n';
import { Toggle } from './ui';

// ---- preferensi -----------------------------------------------------------
const KEY = 'quiver.alerts';
const DEF = { enabled: true, sound: true, desktop: false };
const load = () => {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEF }; }
};
let prefs = load();
const subs = new Set();
export function setAlertPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* mode privat: cukup di memori */ }
  subs.forEach((f) => f());
}
export const useAlertPrefs = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => prefs);

// ---- bunyi ----------------------------------------------------------------
// Dua nada pendek disintesis lewat WebAudio — tanpa berkas audio yang perlu diunduh.
// Browser baru mengizinkan audio setelah ada interaksi pengguna, jadi konteksnya
// dibuka pada klik/ketikan pertama di halaman; sebelum itu bunyi diam-diam gagal.
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

// Alarm: tiga nada persegi menurun, lebih kasar dan lebih lama dari chime — untuk
// hal yang butuh tindakan (uang tersangkut), bukan sekadar kabar.
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

// ---- judul tab: "(3) Quiver" selama tab tidak dilihat ----------------------
let unseen = 0, baseTitle = null;
export function bumpTitle(n) {
  if (!document.hidden) return;
  if (!unseen) baseTitle = document.title;
  unseen += n;
  document.title = `(${unseen}) ${baseTitle}`;
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unseen) { unseen = 0; document.title = baseTitle; }
  });
}

export const canDesktop = () => typeof Notification !== 'undefined' && window.isSecureContext;

// ---- menampilkan satu kelompok peringatan ----------------------------------
const who = (it) => it.targetLabel || short(it.target);
const pairOf = (it) => `${it.symbol0 || short(it.token0)}/${it.symbol1 || short(it.token1)}`;
const titleOf = (it) => translate(it.adding ? '{who} menambah likuiditas {pair}' : '{who} membuka posisi {pair}', { who: who(it), pair: pairOf(it) });
const verdictOf = (it) => (
  it.verdict === 'copy' ? translate('Disalin bot')
    : it.verdict === 'dry' ? translate('Simulasi — tidak dikirim')
      : it.verdict === 'skip' ? translate('Dilewati: {r}', { r: reasonText(it.reason) })
        : it.verdict === 'error' ? translate('Gagal disalin: {r}', { r: reasonText(it.reason) })
          : translate('Bot sedang memproses…'));
const descOf = (it) => [
  it.valueUsd != null && usd(it.valueUsd),
  it.venue && `Uniswap ${String(it.venue).replace('pool', '').toUpperCase()}${it.fee != null ? ` · ${it.fee / 10000}%` : ''}`,
  verdictOf(it),
].filter(Boolean).join(' · ');

function announce(items, { sound, desktop, preview = false }) {
  if (!items.length) return;
  if (sound) chime();
  bumpTitle(items.length);
  // Banjir aksi (mis. satu target membuka banyak posisi sekaligus) jadi satu ringkasan.
  const shown = items.length > 3 ? [] : items;
  if (items.length > 3) {
    toast(translate('{n} posisi baru dari target', { n: items.length }), {
      variant: 'accent', timeout: 10000,
      description: [...new Set(items.map(who))].slice(0, 4).join(', '),
      actionProps: { children: translate('Aktivitas'), onPress: () => { location.hash = 'activity'; } },
    });
  }
  for (const it of shown) {
    const go = preview ? null : () => { location.hash = it.positionId ? `positions/${it.positionId}` : `targets/${it.target}`; };
    let key = null;
    key = toast(titleOf(it), {
      variant: 'accent', timeout: 10000, description: descOf(it),
      actionProps: go ? { children: translate('Lihat'), onPress: () => { go(); if (key) toast.close(key); } } : undefined,
    });
  }
  if (desktop && document.hidden && canDesktop() && Notification.permission === 'granted') {
    const it = items[items.length - 1];
    const n = new Notification(items.length > 1 ? translate('{n} posisi baru dari target', { n: items.length }) : titleOf(it), {
      body: items.length > 1 ? items.map(titleOf).slice(0, 4).join('\n') : descOf(it),
      tag: `quiver-target-${it.id}`,
    });
    n.onclick = () => { window.focus(); location.hash = items.length > 1 ? 'activity' : `targets/${it.target}`; n.close(); };
  }
}

// ---- poller: dipasang SEKALI di App --------------------------------------
// Tetap berjalan saat tab tersembunyi (lebih jarang) — justru saat itulah bunyi dan
// notifikasi desktop berguna. Usai dimatikan lalu dinyalakan lagi, titik awalnya
// diambil ulang supaya aksi selama mati tidak dibunyikan belakangan.
export function useTargetAlerts() {
  const p = useAlertPrefs();
  const last = useRef(null);
  useEffect(() => {
    if (!p.enabled) return undefined;
    last.current = null;
    let alive = true, timer = null;
    const tick = async () => {
      try {
        const first = last.current == null;
        const r = await get(first ? '/api/feed' : `/api/feed?after=${last.current}`);
        if (!alive || r.error) return;
        if (!first && r.items?.length) announce(r.items, prefs);
        last.current = Math.max(last.current ?? 0, r.lastId ?? 0);
      } catch { /* jaringan putus: coba lagi di putaran berikutnya */ }
      finally { if (alive) timer = setTimeout(tick, document.hidden ? 8000 : 4000); }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [p.enabled]);
}

// ---- tombol lonceng + pengaturannya ----------------------------------------
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
  const sample = () => announce([{
    id: 0, target: '0x0000000000000000000000000000000000000000', targetLabel: t('Contoh target'),
    symbol0: 'PEPE', symbol1: 'USDG', venue: 'v4', fee: 10000, valueUsd: 1250, verdict: null,
  }], { sound: true, desktop: false, preview: true });
  const Icon = p.enabled ? Bell : BellOff;
  return (
    <Popover>
      <Button size="sm" variant={variant} isIconOnly aria-label={t('Peringatan target')}>
        <Icon className={iconClass} />
      </Button>
      <Popover.Content placement={placement} className="w-72">
        <Popover.Dialog className="flex flex-col gap-3 p-3">
          <div>
            <Popover.Heading className="text-sm font-medium">{t('Peringatan target')}</Popover.Heading>
            <p className="mt-0.5 text-xs text-muted">{t('Toast dan bunyi saat wallet target membuka atau menambah posisi LP.')}</p>
          </div>
          <Toggle label="Aktif" value={p.enabled} onChange={(v) => setAlertPrefs({ enabled: v })} />
          <Toggle label="Bunyi" value={p.sound} isDisabled={!p.enabled} onChange={(v) => setAlertPrefs({ sound: v })} />
          <Toggle label="Notifikasi desktop" desc={desktopHint} value={p.desktop && perm === 'granted'}
            isDisabled={!p.enabled || perm === 'unsupported' || perm === 'denied'} onChange={setDesktop} />
          <Button size="sm" variant="outline" onPress={sample}>{t('Coba peringatan')}</Button>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
