// Share card — a PnL image ready to paste into X/Telegram, like the ones
// Based bot or GMGN have. The image is drawn by the SERVER (src/share-card.js, route
// GET /api/share/card) so the dashboard and the Telegram bot send exactly the same
// card; this component is only the dialog: preview, hide-amounts switch, then
// copy / download / send to Telegram / share (Web Share, if the browser can
// share files).
//
// A card = { kind, id?, day?, text, name }:
//   positionCard(p)  kind 'position' — a single LP position
//   totalCard(d)     kind 'total'    — the whole portfolio
//   dailyCard(d)     kind 'daily'    — a single day in the PnL calendar
//   monthCard(d)     kind 'month'    — one month of the PnL calendar as a grid
// The whole-portfolio card has a third layout, timeline: cumulative PnL of the window as a
// stepped line with coin logos (its video is TimelineReplay).
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, toast } from '@heroui/react';
import { Share2, Copy, Download, Send } from 'lucide-react';
import { Toggle, Segmented } from './ui';
import ShareReplay from './ShareReplay';
import MonthReplay from './MonthReplay';
import TimelineReplay from './TimelineReplay';
import { get, post } from '../api';
import { authHeaders } from '../telegram';
import { useI18n } from '../i18n';
import { usd, pct } from '../fmt';
import { useFx } from '../currency';

// Size & theme: the keys are the same as SIZES/THEMES in src/share-card.js (the server
// draws; unknown ones fall back to the default).
const SIZES = [['wide', 'Lebar', 1200 / 630], ['square', 'Persegi', 1], ['story', 'Story', 1080 / 1920]];
// Layout: spotlight = one big figure + large mascot; classic = stat tiles + chart strip.
// timeline (whole-portfolio card only) = cumulative PnL line with coin logos and callouts.
const LAYOUTS = [['spotlight', 'Sorot'], ['classic', 'Klasik'], ['timeline', 'Jejak']];
// Timeframe of the whole-portfolio card.
const RANGES = [['all', 'Semua'], ['24h', '24j'], ['7d', '7h'], ['30d', '30h']];
const THEMES = [['dark', 'Grafit'], ['midnight', 'Malam'], ['sunset', 'Senja'], ['neon', 'Neon'], ['gold', 'Emas'], ['light', 'Terang'], ['pixel', 'Piksel'], ['hell', 'Neraka']];
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
// The last choice is remembered in this browser.
const remember = (key, fallback, valid) => { try { const v = localStorage.getItem(key); return valid.includes(v) ? v : fallback; } catch { return fallback; } };
const keep = (key, v) => { try { localStorage.setItem(key, v); } catch { /* abaikan */ } };

export const positionCard = (p) => ({
  kind: 'position', id: p.id,
  name: `${p.symbol0}-${p.symbol1}-${(p.pnlPct ?? 0).toFixed(1)}pct`,
  text: `${p.symbol0 || '?'} / ${p.symbol1 || '?'} ${p.pnlPct == null ? '' : pct(p.pnlPct, 2)} · Quiver`,
});
export const totalCard = ({ pnl, net }) => ({ kind: 'total', name: 'total-pnl', text: `${net ? 'Net PnL' : 'Total PnL'} ${usd(pnl)} · Quiver` });
export const dailyCard = ({ day, pnl }) => ({ kind: 'daily', day, name: `pnl-${day}`, text: `PnL ${day}: ${usd(pnl)} · Quiver` });
export const monthCard = ({ month, pnl }) => ({ kind: 'month', month, name: `pnl-${month}`, text: `PnL ${month}: ${usd(pnl)} · Quiver` });

// Share dialog. `card` null = closed.
export function ShareDialog({ card, onClose }) {
  const { t, locale: lang } = useI18n();
  const open = !!card;
  const [hide, setHide] = useState(false);
  const [size, setSize] = useState(() => remember('quiver-share-size', 'wide', SIZES.map(([k]) => k)));
  const [theme, setTheme] = useState(() => remember('quiver-share-theme', 'dark', THEMES.map(([k]) => k)));
  const [layout, setLayout] = useState(() => remember('quiver-share-layout', 'spotlight', LAYOUTS.map(([k]) => k)));
  // Amounts in dollars or in the Settings currency (Display → second currency). Without a
  // currency/rate there is nothing to choose: dollars.
  const fx = useFx();
  const [range, setRange] = useState(() => remember('quiver-share-range', 'all', RANGES.map(([k]) => k)));
  const [coins, setCoins] = useState(() => remember('quiver-share-coins', '0', ['0', '1']) === '1');   // top gainers/losers with coin logos
  const [curPick, setCurPick] = useState(() => remember('quiver-share-cur', 'usd', ['usd', 'fx']));
  const cur = fx ? curPick : 'usd';
  const [blob, setBlob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);         // why the last card could not be drawn
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tg, setTg] = useState(null);           // { ready, chats } — is the Telegram bot ready?
  const [mode, setMode] = useState('image');    // 'image' | 'video' (positions and calendar months)
  const last = useRef(null);                    // last card, still shown while the close animation runs
  if (card) last.current = card;
  const c = card || last.current;
  // Timeline is only drawn for the whole-portfolio card; any other card falls back to spotlight.
  const lay = layout === 'timeline' && c?.kind !== 'total' ? 'spotlight' : layout;
  const hasVideo = c?.kind === 'position' || c?.kind === 'month' || c?.kind === 'total';
  const video = mode === 'video' && hasVideo;

  // Hide amounts is remembered: once hidden, it usually always is.
  useEffect(() => { try { setHide(localStorage.getItem('quiver-share-hide') === '1'); } catch { /* abaikan */ } }, []);
  const toggleHide = (v) => { setHide(v); try { localStorage.setItem('quiver-share-hide', v ? '1' : '0'); } catch { /* abaikan */ } };

  const pickSize = (v) => { setSize(v); keep('quiver-share-size', v); };
  const pickTheme = (v) => { setTheme(v); keep('quiver-share-theme', v); };
  const pickLayout = (v) => { setLayout(v); keep('quiver-share-layout', v); };
  const pickRange = (v) => { setRange(v); keep('quiver-share-range', v); };
  const pickCoins = (v) => { setCoins(v); keep('quiver-share-coins', v ? '1' : '0'); };
  const pickCur = (v) => { setCurPick(v); keep('quiver-share-cur', v); };

  // The image is requested again when the card, language, size, theme, layout changes, or amounts are hidden.
  useEffect(() => {
    if (!card) { setBlob(null); setErr(null); return; }
    let alive = true;
    // A newer choice cancels the request still running, so the server does not keep drawing
    // cards nobody will see; a card that takes too long ends as an error, not an endless spinner.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(t('Server terlalu lama menggambar kartu'))), 45_000);
    setLoading(true); setErr(null);
    const q = new URLSearchParams({ kind: card.kind, ...(card.id != null ? { id: card.id } : {}), ...(card.day ? { day: card.day } : {}), ...(card.month ? { month: card.month } : {}), hide: hide ? '1' : '0', lang, tz: tzName(), size, theme, layout: lay, cur, ...(card.kind === 'total' ? { range, coins: coins ? '1' : '0' } : {}) });
    fetch(`/api/share/card?${q}`, { credentials: 'same-origin', headers: authHeaders(), signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
        return r.blob();
      })
      .then((b) => { if (alive) setBlob(b); })
      .catch((e) => {
        if (!alive) return;
        const msg = String(ctl.signal.reason?.message || e?.message || e);
        setBlob(null); setErr(msg);   // never leave an older card up to be shared by mistake
        toast.danger(t('Kartu gagal digambar'), { description: msg });
      })
      .finally(() => { clearTimeout(timer); if (alive) setLoading(false); });
    return () => { alive = false; clearTimeout(timer); ctl.abort(); };
  }, [card, hide, lang, size, theme, lay, cur, range, coins, t]);

  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  useEffect(() => {
    if (!open || tg) return;
    get('/api/share/telegram').then((r) => setTg(r?.error ? { ready: false } : r)).catch(() => setTg({ ready: false }));
  }, [open, tg]);

  const canShare = typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare;
  const name = c ? `quiver-${c.name}-${lay}-${size}-${theme}.png`.replace(/[^A-Za-z0-9.+-]+/g, '-').replace(/-+/g, '-') : 'quiver.png';
  const ratio = SIZES.find(([k]) => k === size)?.[2] || 1200 / 630;

  const run = async (kind) => {
    if (!blob || !c) return;
    setBusy(kind);
    try {
      if (kind === 'copy') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast.success(t('Gambar disalin'), { description: t('Tempel langsung ke X, Telegram, atau Discord.') });
      } else if (kind === 'download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } else if (kind === 'telegram') {
        // The server redraws from the same data, then sends it to each chat.
        const j = await post('/api/share/telegram', { kind: c.kind, id: c.id, day: c.day, month: c.month, hide, lang, tz: tzName(), size, theme, layout: lay, cur, ...(c.kind === 'total' ? { range, coins } : {}) });
        if (j.error) throw new Error(j.error);
        toast.success(t('Terkirim ke Telegram'), { description: j.failed ? t('{n} chat gagal: {e}', { n: j.failed, e: j.lastErr }) : t('{n} chat', { n: j.sent }) });
      } else if (kind === 'share') {
        const file = new File([blob], name, { type: 'image/png' });
        if (!navigator.canShare({ files: [file] })) throw new Error(t('Browser ini tidak bisa membagikan gambar.'));
        await navigator.share({ files: [file], title: 'Quiver', text: c.text });
      }
    } catch (e) {
      // Cancelling from the share sheet is not a failure.
      if (e?.name !== 'AbortError') {
        const title = { copy: 'Gambar gagal disalin', download: 'Gambar gagal diunduh', telegram: 'Gagal mengirim ke Telegram', share: 'Gagal membagikan' }[kind];
        toast.danger(t(title), { description: String(e?.message || e) });
      }
    } finally {
      setBusy(null);
    }
  };
  // Action buttons: on narrow screens fill the width (two per row), on wide screens
  // sized to their content.
  const act = (kind) => ({ isPending: busy === kind, isDisabled: !blob || busy != null, onPress: () => run(kind), className: 'grow sm:grow-0' });

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t('Bagikan')}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {hasVideo && (
                <div className="mb-3">
                  <Segmented size="sm" aria="Format" value={mode} onChange={setMode} options={[['image', 'Gambar'], ['video', 'Video']]} />
                </div>
              )}
              {video ? <>
                {c.kind === 'total' ? <TimelineReplay range={range} hide={hide} theme={theme} fx={cur === 'fx' ? fx : null} />
                  : c.kind === 'month' ? <MonthReplay month={c.month} hide={hide} theme={theme} fx={cur === 'fx' ? fx : null} /> : <ShareReplay id={c.id} hide={hide} name={c.name} theme={theme} fx={cur === 'fx' ? fx : null} />}
                {/* The video has two looks: standard, or the Hell theme. Picking Standard leaves another image theme as it is. */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Segmented size="sm" aria="Tema video" value={theme === 'hell' ? 'hell' : 'dark'} onChange={(v) => { if (v === 'hell') pickTheme('hell'); else if (theme === 'hell') pickTheme('dark'); }} options={[['dark', 'Standar'], ['hell', 'Neraka']]} />
                  {/* The portfolio video is the PnL timeline of the chosen period. */}
                  {c.kind === 'total' && <Segmented size="sm" aria="Periode kartu" value={range} onChange={pickRange} options={RANGES.map(([k, label]) => [k, label])} />}
                </div>
              </> : <>
              {/* The preview follows the chosen size ratio; the story is capped in height so the dialog does not tower. */}
              <div className="flex justify-center overflow-hidden rounded-lg border border-border bg-[#0E1015]">
                <div className={`relative w-full transition-opacity ${loading ? 'opacity-60' : ''}`} style={{ aspectRatio: ratio, maxHeight: '60vh' }}>
                  {url
                    ? <img src={url} alt={c?.text || ''} className="block h-full w-full object-contain" />
                    : err
                      ? <div className="flex h-full items-center justify-center p-6 text-center text-xs text-warning">{t('Kartu gagal digambar')}: {t(err)}</div>
                      : <div className="flex h-full items-center justify-center text-xs text-muted">{t('Menggambar kartu…')}</div>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* The month card has a single composition: the calendar grid. */}
                {c?.kind !== 'month' && <Segmented size="sm" aria="Gaya kartu" value={lay} onChange={pickLayout} options={LAYOUTS.filter(([k]) => k !== 'timeline' || c?.kind === 'total').map(([k, label]) => [k, label])} />}
                <Segmented size="sm" aria="Ukuran kartu" value={size} onChange={pickSize} options={SIZES.map(([k, label]) => [k, label])} />
                <Segmented size="sm" aria="Tema kartu" value={theme} onChange={pickTheme} options={THEMES.map(([k, label]) => [k, label])} />
              </div>
              {/* Timeframe and coin attribution only exist for the whole-portfolio card. */}
              {c?.kind === 'total' && !video && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{t('Periode')}</span>
                  <Segmented size="sm" aria="Periode kartu" value={range} onChange={pickRange} options={RANGES.map(([k, label]) => [k, label])} />
                </div>
              )}
              </>}
              {c?.kind === 'total' && !video && lay !== 'timeline' && (
                <div className="mt-3">
                  <Toggle label="Tampilkan coin penggerak" desc="Coin dengan untung dan rugi terbesar di periode ini, lengkap dengan logonya." value={coins} onChange={pickCoins} />
                </div>
              )}
              {fx && !hide && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{t('Nominal dalam')}</span>
                  <Segmented size="sm" aria="Mata uang nominal" value={cur} onChange={pickCur} options={[['usd', 'USD'], ['fx', fx.currency]]} />
                </div>
              )}
              <div className="mt-3">
                <Toggle label="Sembunyikan nominal dolar" desc="Hanya persentase yang tampil; harga token tetap ditampilkan." value={hide} onChange={toggleHide} />
              </div>
            </Modal.Body>
            {!video && <Modal.Footer className="flex-wrap gap-2">
              {typeof ClipboardItem !== 'undefined' && (
                <Button variant="outline" {...act('copy')}><Copy className="size-4" />{t('Salin gambar')}</Button>
              )}
              <Button variant="outline" {...act('download')}><Download className="size-4" />{t('Unduh PNG')}</Button>
              {tg?.ready && (
                <Button variant={canShare ? 'outline' : 'primary'} {...act('telegram')}><Send className="size-4" />{t('Kirim ke Telegram')}</Button>
              )}
              {canShare && (
                <Button variant="primary" {...act('share')}><Share2 className="size-4" />{t('Bagikan')}</Button>
              )}
            </Modal.Footer>}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// "Share" button that opens the dialog for a single card.
export default function ShareButton({ card, label = 'Bagikan', iconOnly = false, variant = 'outline', size = 'sm', isDisabled }) {
  const { t } = useI18n();
  // The card is snapshotted when the button is pressed: the next poll does not replace the preview.
  const [snap, setSnap] = useState(null);
  return (
    <>
      <Button size={size} variant={variant} isDisabled={isDisabled} isIconOnly={iconOnly} aria-label={t(label)} onPress={() => setSnap(card)}>
        <Share2 className="size-4" />{!iconOnly && t(label)}
      </Button>
      <ShareDialog card={snap} onClose={() => setSnap(null)} />
    </>
  );
}
