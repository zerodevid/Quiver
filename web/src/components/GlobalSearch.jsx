// Pencarian global: Cmd/Ctrl+K (atau "/" saat tidak sedang mengetik) membuka satu
// kotak yang melompat langsung ke target, token, pool, atau wallet yang pernah
// diriset — tanpa harus mengeklik lewat tabel. Hasilnya dari /api/search (DB lokal).
import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { Search, User, Coins, Waves, Wallet as WalletIcon } from 'lucide-react';
import { get } from '../api';
import { short } from '../fmt';
import { useI18n } from '../i18n';

// Tombol pemicu ditaruh di dua tempat (sidebar desktop, header HP) tapi modalnya cuma
// satu instance (<SearchModal/>, dipasang sekali di App.jsx) — pola yang sama dengan
// ask()/ConfirmHost: setter modul dipakai lintas komponen tanpa mengangkat state ke atas.
let openSetter = null;
export const openSearch = () => openSetter?.();

export function SearchTrigger({ compact }) {
  const { t } = useI18n();
  if (compact) {
    return (
      <Button size="sm" variant="ghost" isIconOnly aria-label={t('Cari')} onPress={openSearch}>
        <Search className="size-4" />
      </Button>
    );
  }
  return (
    <button type="button" onClick={openSearch} aria-label={t('Cari')}
      className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-default/40 px-2.5 text-xs text-muted transition-colors hover:text-foreground">
      <Search className="size-3.5 shrink-0" /><span className="flex-1 text-left">{t('Cari…')}</span>
      <kbd className="rounded border border-border bg-surface px-1 font-sans text-[0.625rem]">⌘K</kbd>
    </button>
  );
}

const ICONS = { target: User, token: Coins, pool: Waves, wallet: WalletIcon };
const LABELS = { target: 'Target', token: 'Token', pool: 'Pool', wallet: 'Wallet' };

function toRow(r) {
  if (r.type === 'target') return { ...r, title: r.label || short(r.address), sub: r.address, href: `#targets/${r.address}` };
  if (r.type === 'wallet') return { ...r, title: r.label || short(r.address), sub: r.address, href: `#wallet/${r.address}` };
  if (r.type === 'token') return { ...r, title: r.symbol || short(r.address), sub: r.name || r.address, href: `#token/${r.address}` };
  return { ...r, title: r.pair, sub: short(r.poolRef), href: `#pool/${r.poolRef}` };
}

export default function SearchModal() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => { openSetter = () => setOpen(true); return () => { openSetter = null; }; }, []);

  // Cmd/Ctrl+K di mana saja; "/" hanya kalau fokus sedang tidak di kotak isian —
  // supaya tidak mencuri karakter "/" dari label, alamat, atau pencarian lain.
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.key === '/' && !open) {
        const el = document.activeElement;
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) { e.preventDefault(); setOpen(true); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) { setQ(''); setRows([]); setSel(0); return; }
    const h = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(h);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) { setRows([]); setBusy(false); return; }
    const mine = ++seq.current;
    setBusy(true);
    const h = setTimeout(() => {
      get(`/api/search?q=${encodeURIComponent(query)}`).then((r) => {
        if (mine !== seq.current) return;
        setRows((r.results || []).map(toRow));
        setSel(0);
        setBusy(false);
      });
    }, 200);
    return () => clearTimeout(h);
  }, [q, open]);

  const go = (row) => { if (!row) return; location.hash = row.href; setOpen(false); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
  };

  return (
    <Modal isOpen={open} onOpenChange={setOpen}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="lg" placement="center" scroll="inside">
          <Modal.Dialog>
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Search className="size-4 shrink-0 text-muted" />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
                placeholder={t('Cari target, token, pool, atau wallet — alamat atau simbol…')}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted" />
            </div>
            <Modal.Body className="max-h-[60vh] p-0!">
              {!q.trim() ? (
                <div className="px-4 py-8 text-center text-sm text-muted">{t('Ketik untuk mencari…')}</div>
              ) : busy ? (
                <div className="px-4 py-8 text-center text-sm text-muted">{t('Mencari…')}</div>
              ) : !rows.length ? (
                <div className="px-4 py-8 text-center text-sm text-muted">{t('Tidak ada hasil untuk "{q}"', { q: q.trim() })}</div>
              ) : (
                <ul>
                  {rows.map((r, i) => {
                    const Icon = ICONS[r.type] || Search;
                    return (
                      <li key={r.type + r.href}>
                        <a href={r.href} onMouseEnter={() => setSel(i)} onClick={(e) => { e.preventDefault(); go(r); }}
                          className={`flex items-center gap-3 px-4 py-2.5 text-sm ${i === sel ? 'bg-default' : ''}`}>
                          <Icon className="size-4 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{r.title}</span>
                            <span className="mono block truncate text-xs text-muted">{r.sub}</span>
                          </span>
                          <span className="shrink-0 text-[0.6875rem] text-muted">{t(LABELS[r.type])}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
