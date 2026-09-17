// Peringatan ala terminal trading: toast di dasbor, bunyi singkat, dan notifikasi
// desktop kalau tab ini sedang tidak dilihat. Dua kejadian: target membuka posisi
// (bot menyalin) dan posisi salinan ditutup — yang kedua selalu membawa PnL-nya,
// dan bunyinya beda supaya tanpa melihat layar pun tahu itu buka atau tutup.
//
// Preferensinya per browser (localStorage), bukan di config server: bunyi dan izin
// notifikasi memang milik perangkat — laptop di meja boleh berbunyi, HP jangan.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popover, toast } from '@heroui/react';
import { Bell, BellOff } from 'lucide-react';
import { get } from '../api';
import { usd, pct, age, short } from '../fmt';
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
// Nada-nada pendek disintesis lewat WebAudio — tanpa berkas audio yang perlu diunduh.
// Tiga suara: chime (buka: dua nada sine naik), cashout (tutup untung: tiga nada
// triangle naik cepat, "ka-ching") dan loss (tutup rugi: dua nada rendah turun).
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

// Tutup posisi: untung = tiga nada triangle naik cepat lalu nada panjang di atas;
// rugi = dua nada rendah menurun, lebih lambat. Timbre (triangle) beda dari chime
// buka (sine) supaya bisa dibedakan tanpa melihat layar.
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

// ---- judul tab: "(3) Quiver · $1.234,56 · +$56,78" -------------------------
// Satu tempat yang menulis document.title: judul dasar (total portofolio & PnL,
// diperbarui App tiap poll) dan awalan jumlah peringatan yang belum dilihat selama
// tab tidak dilihat. Kalau ditulis terpisah, angka yang berubah saat tab
// tersembunyi menghapus awalan "(3)"-nya, atau sebaliknya.
// Tab sempit cuma memuat belasan huruf, jadi judul yang panjang digulir pelan
// (satu huruf tiap ~0,4 detik) seperti papan berjalan: angka dan nama merek
// bergantian lewat. Awalan "(3)" tidak ikut bergulir.
let unseen = 0, baseTitle = 'Quiver', shift = 0, ticker = null;
const renderTitle = () => {
  let body = baseTitle;
  if (ticker) { const s = baseTitle + ' · '; body = s.slice(shift) + s.slice(0, shift); }
  document.title = unseen ? `(${unseen}) ${body}` : body;
};
export function setBaseTitle(title) {
  if (title === baseTitle) return;
  baseTitle = title;
  // hanya bergulir kalau ada yang perlu digulir (judul polos "Quiver" diam)
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

// ---- menampilkan satu kelompok peringatan ----------------------------------
const who = (it) => it.targetLabel || short(it.target);
const pairOf = (it) => `${it.symbol0 || short(it.token0)}/${it.symbol1 || short(it.token1)}`;
const titleOf = (it) => (it.kind === 'close' ? closeTitle(it)
  : translate(it.adding ? '{who} menambah likuiditas {pair}' : '{who} membuka posisi {pair}', { who: who(it), pair: pairOf(it) }));
// Judul tutup langsung memuat PnL-nya: "PEPE/USDG ditutup · +$12,34 (+5,6%)".
const signed = (v) => (v >= 0 ? '+' : '') + usd(v);
const closeTitle = (it) => translate(it.pnlUsd >= 0 ? '{pair} ditutup · untung {pnl}' : '{pair} ditutup · rugi {pnl}',
  { pair: pairOf(it), pnl: `${signed(it.pnlUsd)}${it.pnlPct != null ? ` (${pct(it.pnlPct)})` : ''}` });
const closeDesc = (it) => [
  translate('hasil {out} · modal {cost}', { out: usd(it.outUsd), cost: usd(it.costUsd) }),
  it.ageHours != null && translate('dipegang {d}', { d: age(it.ageHours) }),
  it.mirrored ? translate('ikut target keluar{who}', { who: it.target ? ` (${who(it)})` : '' }) : translate('keluar mandiri / manual'),
].filter(Boolean).join(' · ');

// Posisi yang ditutup manual dari dasbor sudah diberi toast oleh alur tutupnya
// sendiri; umpan tidak perlu mengulanginya beberapa detik kemudian.
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
  it.venue && `Uniswap ${String(it.venue).replace('pool', '').toUpperCase()}${it.fee != null ? ` · ${it.fee / 10000}%` : ''}`,
  verdictOf(it),
].filter(Boolean).join(' · ');

const linkOf = (it) => (it.positionId ? `positions/${it.positionId}` : `targets/${it.target}`);

function announce(all, { sound, desktop, preview = false }) {
  const items = all.filter((it) => !(it.kind === 'close' && mutedClose.has(Number(it.positionId))));
  if (!items.length) return;
  const opens = items.filter((it) => it.kind !== 'close');
  const closes = items.filter((it) => it.kind === 'close');
  if (sound) {
    // Buka dan tutup dalam satu putaran: bunyikan berurutan, bukan tumpang tindih.
    if (opens.length) chime();
    if (closes.length) {
      const net = closes.reduce((a, it) => a + (it.pnlUsd || 0), 0);
      if (opens.length) setTimeout(() => cashout(net), 750); else cashout(net);
    }
  }
  bumpTitle(items.length);
  // Banjir aksi (mis. satu target membuka banyak posisi sekaligus) jadi satu ringkasan.
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
      variant: close ? (it.pnlUsd >= 0 ? 'success' : 'danger') : 'accent',
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

// ---- poller: dipasang SEKALI di App --------------------------------------
// Tetap berjalan saat tab tersembunyi (lebih jarang) — justru saat itulah bunyi dan
// notifikasi desktop berguna. Usai dimatikan lalu dinyalakan lagi, titik awalnya
// diambil ulang supaya aksi selama mati tidak dibunyikan belakangan.
export function useTargetAlerts() {
  const p = useAlertPrefs();
  const last = useRef(null);          // id aksi terakhir yang sudah diumumkan
  const lastClosed = useRef(0);       // waktu tutup terakhir yang sudah diumumkan
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
  // Contoh peringatan, per jenis, supaya bunyi dan bentuk toast tiap kejadian bisa
  // dicoba sendiri-sendiri: buka (chime), tutup untung dan tutup rugi (cashout).
  const CONTOH = { target: '0x0000000000000000000000000000000000000000', targetLabel: t('Contoh target'), symbol0: 'PEPE', symbol1: 'USDG', venue: 'v4', fee: 10000 };
  const sample = (jenis) => announce([
    jenis === 'open' ? { ...CONTOH, kind: 'open', id: 0, valueUsd: 1250, verdict: null }
      : jenis === 'profit' ? { ...CONTOH, kind: 'close', id: 'c0', mirrored: true, costUsd: 1250, outUsd: 1318.75, pnlUsd: 68.75, pnlPct: 5.5, ageHours: 6.2 }
        : { ...CONTOH, kind: 'close', id: 'c1', mirrored: false, costUsd: 1250, outUsd: 1102.5, pnlUsd: -147.5, pnlPct: -11.8, ageHours: 0.7 },
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
            <div className="grid grid-cols-3 gap-1.5">
              <Button size="sm" variant="outline" onPress={() => sample('open')}>{t('Buka')}</Button>
              <Button size="sm" variant="outline" className="text-success" onPress={() => sample('profit')}>{t('Tutup untung')}</Button>
              <Button size="sm" variant="outline" className="text-danger" onPress={() => sample('loss')}>{t('Tutup rugi')}</Button>
            </div>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
