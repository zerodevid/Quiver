// Kartu bagikan (share card) — gambar PnL siap tempel ke X/Telegram, seperti yang
// dipunyai Based bot atau GMGN. Gambarnya digambar SERVER (src/share-card.js, rute
// GET /api/share/card) supaya dasbor dan bot Telegram mengirim kartu yang persis
// sama; komponen ini cuma dialognya: pratinjau, sakelar sembunyikan nominal, lalu
// salin / unduh / kirim ke Telegram / bagikan (Web Share, kalau browsernya bisa
// mengirim berkas).
//
// Sebuah kartu = { kind, id?, day?, text, name }:
//   positionCard(p)  kind 'position' — satu posisi LP
//   totalCard(d)     kind 'total'    — seluruh portofolio
//   dailyCard(d)     kind 'daily'    — satu hari di kalender PnL
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, toast } from '@heroui/react';
import { Share2, Copy, Download, Send } from 'lucide-react';
import { Toggle, Segmented } from './ui';
import { get, post } from '../api';
import { useI18n } from '../i18n';
import { usd, pct } from '../fmt';

// Ukuran & tema: kuncinya sama dengan SIZES/THEMES di src/share-card.js (server yang
// menggambar; yang tidak dikenal jatuh ke bawaan).
const SIZES = [['wide', 'Lebar', 1200 / 630], ['square', 'Persegi', 1], ['story', 'Story', 1080 / 1920]];
const THEMES = [['dark', 'Grafit'], ['midnight', 'Malam'], ['sunset', 'Senja'], ['neon', 'Neon'], ['gold', 'Emas'], ['light', 'Terang'], ['pixel', 'Piksel']];
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
// Pilihan terakhir diingat di browser ini.
const remember = (key, fallback, valid) => { try { const v = localStorage.getItem(key); return valid.includes(v) ? v : fallback; } catch { return fallback; } };
const keep = (key, v) => { try { localStorage.setItem(key, v); } catch { /* abaikan */ } };

export const positionCard = (p) => ({
  kind: 'position', id: p.id,
  name: `${p.symbol0}-${p.symbol1}-${(p.pnlPct ?? 0).toFixed(1)}pct`,
  text: `${p.symbol0 || '?'} / ${p.symbol1 || '?'} ${p.pnlPct == null ? '' : pct(p.pnlPct, 2)} · Quiver`,
});
export const totalCard = ({ pnl }) => ({ kind: 'total', name: 'total-pnl', text: `Total PnL ${usd(pnl)} · Quiver` });
export const dailyCard = ({ day, pnl }) => ({ kind: 'daily', day, name: `pnl-${day}`, text: `PnL ${day}: ${usd(pnl)} · Quiver` });

// Dialog bagikan. `card` null = tertutup.
export function ShareDialog({ card, onClose }) {
  const { t, locale: lang } = useI18n();
  const open = !!card;
  const [hide, setHide] = useState(false);
  const [size, setSize] = useState(() => remember('quiver-share-size', 'wide', SIZES.map(([k]) => k)));
  const [theme, setTheme] = useState(() => remember('quiver-share-theme', 'dark', THEMES.map(([k]) => k)));
  const [blob, setBlob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tg, setTg] = useState(null);           // { ready, chats } — bot Telegram siap?
  const last = useRef(null);                    // kartu terakhir, tetap tampil saat animasi menutup
  if (card) last.current = card;
  const c = card || last.current;

  // Sembunyikan nominal diingat: kalau sekali disembunyikan, biasanya selalu.
  useEffect(() => { try { setHide(localStorage.getItem('quiver-share-hide') === '1'); } catch { /* abaikan */ } }, []);
  const toggleHide = (v) => { setHide(v); try { localStorage.setItem('quiver-share-hide', v ? '1' : '0'); } catch { /* abaikan */ } };

  const pickSize = (v) => { setSize(v); keep('quiver-share-size', v); };
  const pickTheme = (v) => { setTheme(v); keep('quiver-share-theme', v); };

  // Gambar diminta ulang saat kartu, bahasa, ukuran, tema berganti, atau nominal disembunyikan.
  useEffect(() => {
    if (!card) { setBlob(null); return; }
    let alive = true;
    setLoading(true);
    const q = new URLSearchParams({ kind: card.kind, ...(card.id != null ? { id: card.id } : {}), ...(card.day ? { day: card.day } : {}), hide: hide ? '1' : '0', lang, tz: tzName(), size, theme });
    fetch(`/api/share/card?${q}`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
        return r.blob();
      })
      .then((b) => { if (alive) setBlob(b); })
      .catch((e) => { if (alive) toast.danger(t('Kartu gagal digambar'), { description: String(e?.message || e) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [card, hide, lang, size, theme, t]);

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
  const name = c ? `quiver-${c.name}-${size}-${theme}.png`.replace(/[^A-Za-z0-9.+-]+/g, '-').replace(/-+/g, '-') : 'quiver.png';
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
        // Server menggambar ulang dari data yang sama, lalu mengirimnya ke tiap chat.
        const j = await post('/api/share/telegram', { kind: c.kind, id: c.id, day: c.day, hide, lang, tz: tzName(), size, theme });
        if (j.error) throw new Error(j.error);
        toast.success(t('Terkirim ke Telegram'), { description: j.failed ? t('{n} chat gagal: {e}', { n: j.failed, e: j.lastErr }) : t('{n} chat', { n: j.sent }) });
      } else if (kind === 'share') {
        const file = new File([blob], name, { type: 'image/png' });
        if (!navigator.canShare({ files: [file] })) throw new Error(t('Browser ini tidak bisa membagikan gambar.'));
        await navigator.share({ files: [file], title: 'Quiver', text: c.text });
      }
    } catch (e) {
      // Batal dari lembar bagikan bukan kegagalan.
      if (e?.name !== 'AbortError') {
        const title = { copy: 'Gambar gagal disalin', download: 'Gambar gagal diunduh', telegram: 'Gagal mengirim ke Telegram', share: 'Gagal membagikan' }[kind];
        toast.danger(t(title), { description: String(e?.message || e) });
      }
    } finally {
      setBusy(null);
    }
  };
  // Tombol aksi: di layar sempit memenuhi lebar (dua per baris), di layar lebar
  // sebesar isinya.
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
              {/* Pratinjau mengikuti rasio ukuran yang dipilih; story dibatasi tingginya supaya dialog tidak menjulang. */}
              <div className="flex justify-center overflow-hidden rounded-lg border border-border bg-[#0E1015]">
                <div className={`relative w-full transition-opacity ${loading ? 'opacity-60' : ''}`} style={{ aspectRatio: ratio, maxHeight: '60vh' }}>
                  {url
                    ? <img src={url} alt={c?.text || ''} className="block h-full w-full object-contain" />
                    : <div className="flex h-full items-center justify-center text-xs text-muted">{t('Menggambar kartu…')}</div>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Segmented size="sm" aria="Ukuran kartu" value={size} onChange={pickSize} options={SIZES.map(([k, label]) => [k, label])} />
                <Segmented size="sm" aria="Tema kartu" value={theme} onChange={pickTheme} options={THEMES.map(([k, label]) => [k, label])} />
              </div>
              <div className="mt-3">
                <Toggle label="Sembunyikan nominal dolar" desc="Hanya persentase yang tampil; harga token tetap ditampilkan." value={hide} onChange={toggleHide} />
              </div>
            </Modal.Body>
            <Modal.Footer className="flex-wrap gap-2">
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
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// Tombol "Bagikan" yang membuka dialog untuk satu kartu.
export default function ShareButton({ card, label = 'Bagikan', iconOnly = false, variant = 'outline', size = 'sm', isDisabled }) {
  const { t } = useI18n();
  // Kartu dipotret saat tombol ditekan: poll berikutnya tidak mengganti pratinjau.
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
