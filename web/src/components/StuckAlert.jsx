// LOUD alert: leftover memecoin whose sale was rejected after a position exit.
//
// Not a toast that disappears by itself — the money is still stuck in the wallet until
// the route improves or the user decides something. So it shows as a red banner
// above ALL pages while the queue is not empty, sounds an alarm (not an ordinary
// chime) when a new item appears, and offers buttons for the three ways out:
// retry the sale, sell manually via Swap, or change the loss limit in Rules.
import { useEffect, useRef, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { Siren, X } from 'lucide-react';
import { post } from '../api';
import { useStatus } from '../App';
import { useI18n } from '../i18n';
import { num, short, ago } from '../fmt';
import { ask, TradeLinks } from './ui';
import { useAlertPrefs, alarm, bumpTitle, canDesktop } from './TargetAlerts';

const KEY = 'quiver.stuck-seen';
// posId null = leftover swept from the wallet, not from any position.
const keyOf = (it) => `${it.posId ?? 'w'}:${it.token}`;
// Already sounded in this tab? Stored per tab session so reloading the page does not
// repeat the alarm for the same thing, but a new tab (tomorrow) is still notified.
const seen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
const remember = (set) => { try { sessionStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* abaikan */ } };

const lossPct = (why) => { const m = /rugi\s+([\d.,]+)%/.exec(why || ''); return m ? m[1] : null; };
const capPct = (why) => { const m = /batas\s+([\d.,]+)%/.exec(why || ''); return m ? m[1] : null; };

export default function StuckAlert() {
  const { t } = useI18n();
  const { status, reload } = useStatus();
  const prefs = useAlertPrefs();
  const list = status?.leftovers || [];
  const [busy, setBusy] = useState(null);   // key of the item being sold, or '*' for all
  const [, tick] = useState(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Every second: the countdown to the next attempt must really tick,
  // and "since 12 min ago" moves along without waiting for a poll.
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!list.length) return;
    const done = seen();
    const fresh = list.filter((it) => !done.has(keyOf(it)));
    if (!fresh.length) return;
    fresh.forEach((it) => done.add(keyOf(it)));
    remember(done);
    const p = prefsRef.current;
    if (p.enabled && p.sound) alarm();
    bumpTitle(fresh.length);
    for (const it of fresh) {
      toast.danger(t('{a} {s} belum terjual — posisi #{id}', { a: num(it.amountNum, 0), s: it.symbol || short(it.token), id: it.posId }), {
        timeout: 15000, description: it.why,
      });
    }
    if (p.enabled && p.desktop && document.hidden && canDesktop() && Notification.permission === 'granted') {
      const it = fresh[0];
      const n = new Notification(t('Sisa belum terjual: {s}', { s: it.symbol || short(it.token) }), { body: it.why || '', tag: `quiver-stuck-${keyOf(it)}` });
      n.onclick = () => { window.focus(); location.hash = 'swap'; n.close(); };
    }
  }, [list.map(keyOf).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.length) return null;

  // Without an argument: the whole queue. With an item: that row only.
  const attempt = async (it = null) => {
    setBusy(it ? keyOf(it) : '*');
    const r = await post('/api/leftovers/retry', it ? { posId: it.posId ?? null, token: it.token } : {});
    setBusy(null);
    if (r.error) toast.danger(r.error, { timeout: 12000 });
    else if (it) toast.success(t('{s} terjual', { s: it.symbol || short(it.token) }));
    else toast.success(t('Terjual — antrean kosong'));
    reload();
  };
  const discard = async (it) => {
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
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-danger">{t('{n} token menunggu dijual', { n: list.length })}</span>
            <Button size="sm" variant="outline" onPress={() => attempt()} isPending={busy === '*'}>{t('Jual semua sekarang')}</Button>
          </div>
        )}
        {list.map((it) => {
          const loss = it.lastLossBps != null ? num(it.lastLossBps / 100, 1) : lossPct(it.why), limit = capPct(it.why);
          // Seconds to the next automatic attempt. 0 = it is already due,
          // so the next tick (every 1 s on the server) will pick it up again.
          const leftover = Math.max(0, Math.ceil(((it.next || 0) - Date.now()) / 1000));
          const running = busy === keyOf(it) || busy === '*';
          return (
            <div key={keyOf(it)} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 border-t border-danger/20 pt-3 first:border-t-0 first:pt-0">
              <span className="flex size-8 shrink-0 animate-pulse items-center justify-center rounded-full bg-danger text-white">
                <Siren className="size-4" />
              </span>
              <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
                <div className="font-semibold text-danger">
                  {t('{a} {s} belum terjual', { a: num(it.amountNum, 0), s: it.symbol || short(it.token) })}
                  <span className="font-normal">
                    {' · '}
                    {it.posId == null ? t('sisa di wallet') : t('posisi #{id}', { id: it.posId })}
                  </span>
                </div>
                <div className="text-foreground/80">
                  {loss
                    ? t('Rute jualnya rugi {a}%, di atas batas {b}% — bot menolak menjual.', { a: loss, b: limit || '?' })
                    : it.why}
                  {' '}
                  <span className="text-muted">
                    {running || leftover === 0
                      ? t('Sedang dieksekusi…')
                      : t('Eksekusi otomatis berikutnya dalam {d} dtk', { d: leftover })}
                    {t(' — sudah {n}×{w}; dijual otomatis begitu lolos batas.', {
                      n: num(it.tries || 0), w: it.since ? ` ${t('sejak {a}', { a: ago(it.since) })}` : '',
                    })}
                  </span>
                </div>
              </div>
              <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-2 sm:col-span-1">
                <Button size="sm" variant="danger" onPress={() => attempt(it)} isPending={running}>
                  {t('Jual sekarang')}{!running && leftover > 0 ? ` · ${leftover}s` : ''}
                </Button>
                <Button size="sm" variant="outline" onPress={() => { location.hash = 'swap'; }}>{t('Jual manual')}</Button>
                <Button size="sm" variant="outline" onPress={() => { location.hash = 'rules'; }}>{t('Ubah batas rugi')}</Button>
                <TradeLinks token={it.token} />
                <Button size="sm" variant="ghost" isIconOnly aria-label={t('Keluarkan dari antrean')} onPress={() => discard(it)} className="text-muted">
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
