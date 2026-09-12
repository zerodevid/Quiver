// Peringatan KERAS: memecoin sisa yang ditolak dijual setelah keluar posisi.
//
// Bukan toast yang hilang sendiri — uangnya masih tersangkut di wallet sampai
// rutenya membaik atau pengguna memutuskan sesuatu. Jadi tampil sebagai pita merah
// di atas SEMUA halaman selama antreannya belum kosong, dibunyikan alarm (bukan
// chime biasa) saat item baru muncul, dan diberi tombol untuk tiga jalan keluarnya:
// coba jual lagi, jual manual lewat Swap, atau ubah batas rugi di Aturan.
import { useEffect, useRef, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Siren, X } from 'lucide-react';
import { post } from '../api';
import { useStatus } from '../App';
import { useI18n } from '../i18n';
import { num, short, ago } from '../fmt';
import { ask } from './ui';
import { useAlertPrefs, alarm, bumpTitle, canDesktop } from './TargetAlerts';

const KEY = 'quiver.stuck-seen';
// posId null = sisa yang disapu dari wallet, bukan dari posisi mana pun.
const keyOf = (it) => `${it.posId ?? 'w'}:${it.token}`;
// Sudah dibunyikan di tab ini? Disimpan per sesi tab supaya muat ulang halaman tidak
// mengulang alarm untuk hal yang sama, tapi tab baru (besok) tetap diberi tahu.
const seen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
const remember = (set) => { try { sessionStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* abaikan */ } };

const lossPct = (why) => { const m = /rugi\s+([\d.,]+)%/.exec(why || ''); return m ? m[1] : null; };
const capPct = (why) => { const m = /batas\s+([\d.,]+)%/.exec(why || ''); return m ? m[1] : null; };

export default function StuckAlert() {
  const { t } = useI18n();
  const { status, reload } = useStatus();
  const prefs = useAlertPrefs();
  const list = status?.leftovers || [];
  const [busy, setBusy] = useState(null);   // kunci item yang sedang dijual, atau '*' untuk semua
  const [, tick] = useState(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Tiap detik: hitung mundur ke percobaan berikutnya harus benar-benar berdetak,
  // dan "sejak 12 mnt lalu" ikut bergerak tanpa menunggu poll.
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!list.length) return;
    const done = seen();
    const baru = list.filter((it) => !done.has(keyOf(it)));
    if (!baru.length) return;
    baru.forEach((it) => done.add(keyOf(it)));
    remember(done);
    const p = prefsRef.current;
    if (p.enabled && p.sound) alarm();
    bumpTitle(baru.length);
    for (const it of baru) {
      toast.danger(t('{a} {s} belum terjual — posisi #{id}', { a: num(it.amountNum, 0), s: it.symbol || short(it.token), id: it.posId }), {
        timeout: 15000, description: it.why,
      });
    }
    if (p.enabled && p.desktop && document.hidden && canDesktop() && Notification.permission === 'granted') {
      const it = baru[0];
      const n = new Notification(t('Sisa belum terjual: {s}', { s: it.symbol || short(it.token) }), { body: it.why || '', tag: `quiver-stuck-${keyOf(it)}` });
      n.onclick = () => { window.focus(); location.hash = 'swap'; n.close(); };
    }
  }, [list.map(keyOf).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.length) return null;

  // Tanpa argumen: seluruh antrean. Dengan item: baris itu saja.
  const coba = async (it = null) => {
    setBusy(it ? keyOf(it) : '*');
    const r = await post('/api/leftovers/retry', it ? { posId: it.posId ?? null, token: it.token } : {});
    setBusy(null);
    if (r.error) toast.danger(r.error, { timeout: 12000 });
    else if (it) toast.success(t('{s} terjual', { s: it.symbol || short(it.token) }));
    else toast.success(t('Terjual — antrean kosong'));
    reload();
  };
  const buang = async (it) => {
    if (!(await ask({
      title: t('Keluarkan dari antrean?'), danger: true, confirm: t('Ya, keluarkan'),
      body: t('Tokennya tetap di wallet dan tidak akan dicoba jual otomatis lagi. Kamu masih bisa menjualnya kapan saja lewat halaman Swap.'),
    }))) return;
    await post('/api/leftovers/drop', { posId: it.posId, token: it.token });
    reload();
  };

  return (
    <div role="alert" className="border-b-2 border-danger bg-danger/10">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-2 px-4 py-3 sm:px-6 lg:px-8">
        {list.length > 1 && (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-danger">{t('{n} token menunggu dijual', { n: list.length })}</span>
            <Button size="sm" variant="outline" onPress={() => coba()} isPending={busy === '*'}>{t('Jual semua sekarang')}</Button>
          </div>
        )}
        {list.map((it) => {
          const rugi = it.lastLossBps != null ? num(it.lastLossBps / 100, 1) : lossPct(it.why), batas = capPct(it.why);
          // Detik ke percobaan otomatis berikutnya. 0 = jatuh temponya sudah lewat,
          // jadi tick berikutnya (tiap 1 dtk di server) akan mengutip ulang.
          const sisa = Math.max(0, Math.ceil(((it.next || 0) - Date.now()) / 1000));
          const jalan = busy === keyOf(it) || busy === '*';
          return (
            <div key={keyOf(it)} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="flex size-8 shrink-0 animate-pulse items-center justify-center rounded-full bg-danger text-white">
                <Siren className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-64 text-sm">
                <div className="font-semibold text-danger">
                  {t('{a} {s} belum terjual', { a: num(it.amountNum, 0), s: it.symbol || short(it.token) })}
                  <span className="font-normal">
                    {' · '}
                    {it.posId == null ? t('sisa di wallet') : t('posisi #{id}', { id: it.posId })}
                  </span>
                </div>
                <div className="text-foreground/80">
                  {rugi
                    ? t('Rute jualnya rugi {a}%, di atas batas {b}% — bot menolak menjual.', { a: rugi, b: batas || '?' })
                    : it.why}
                  {' '}
                  <span className="text-muted">
                    {jalan || sisa === 0
                      ? t('Sedang dieksekusi…')
                      : t('Eksekusi otomatis berikutnya dalam {d} dtk', { d: sisa })}
                    {t(' — sudah {n}×{w}; dijual otomatis begitu lolos batas.', {
                      n: num(it.tries || 0), w: it.since ? ` ${t('sejak {a}', { a: ago(it.since) })}` : '',
                    })}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="danger" onPress={() => coba(it)} isPending={jalan}>
                  {t('Jual sekarang')}{!jalan && sisa > 0 ? ` · ${sisa}s` : ''}
                </Button>
                <Button size="sm" variant="outline" onPress={() => { location.hash = 'swap'; }}>{t('Jual manual')}</Button>
                <Button size="sm" variant="outline" onPress={() => { location.hash = 'rules'; }}>{t('Ubah batas rugi')}</Button>
                <Button size="sm" variant="ghost" isIconOnly aria-label={t('Keluarkan dari antrean')} onPress={() => buang(it)} className="text-muted">
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
