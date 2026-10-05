// The GMGN security dot in the positions list: a small circle beside the pair
// name, without text. A full column for this would widen the table for a figure
// that rarely changes; but "this token is a honeypot" is not something that may only
// be seen after opening the detail page. Its colour answers one question —
// safe or not — and the whole reason appears when the cursor touches it.
//
// The thresholds are not this file's: gmgnSignals() in poolHealth.mjs is the same one
// used by the Pool health panel, so the green dot in the list never
// sits beside a red warning on the detail page of the same token.
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, ShieldAlert, ShieldQuestion, ShieldX } from 'lucide-react';
import { usePoll } from '../hooks';
import { useI18n } from '../i18n';
import { num, price } from '../fmt';
import { gmgnSignals } from '../poolHealth.mjs';
import { canonAddr } from '../chain';

const Ctx = createContext(null);

// One call for the whole list, not one per row. Sparse: the GMGN security
// profile is stored for 5 minutes on the server, and its OpenAPI quota is shared three ways
// with other instances on the same IP.
export function GmgnProvider({ tokens, children }) {
  const list = useMemo(() => [...new Set((tokens || [])
    .filter(Boolean).map((a) => canonAddr(a)))].sort().slice(0, 25), [tokens]);
  const { data } = usePoll(list.length ? `/api/gmgn/tokens?addresses=${list.join(',')}` : null, 180000);
  // Without a GMGN API key this whole feature does not exist — not a grey dot on every
  // row that never changes colour.
  const value = data?.enabled ? (data.tokens || {}) : null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// A shield, not a dot: this row already holds the in-range/out-of-range dot, and two
// small coloured circles in one row with different meanings is a misreading
// waiting to happen. Its shape itself says "this is about security".
const TONE = {
  risk: [ShieldX, 'text-danger', 'Bahaya menurut GMGN'],
  warn: [ShieldAlert, 'text-warning', 'Perlu waspada menurut GMGN'],
  ok: [ShieldCheck, 'text-success', 'Tidak ada tanda bahaya pada yang diperiksa GMGN'],
  unknown: [ShieldQuestion, 'text-muted/70', 'GMGN belum punya cukup data untuk token ini'],
};

// The GMGN profile of a single token from the same context — for panels that have room
// to show the figures, not just the shield.
export function useGmgn(token) {
  const map = useContext(Ctx);
  if (!map || !token) return null;
  const g = map[canonAddr(token)];
  return g && !g.error ? g : null;
}

export function GmgnDot({ token, className = '' }) {
  const map = useContext(Ctx);
  const { t } = useI18n();
  if (!map) return null;
  const g = token ? map[canonAddr(token)] : null;
  if (!g) return null;
  const { level, signals } = g.error ? { level: 'unknown', signals: [] } : gmgnSignals(g);
  const [Icon, color, heading] = TONE[level];
  // Tooltip content: the same sentences as the Pool health panel, one per line.
  // Figures are inserted as there (percent rounded, USD values given a $).
  const content = signals.map((s) => t(s.key, Object.fromEntries(Object.entries(s.values)
    .map(([k, v]) => [k, k === 'usd' ? '$' + price(Number(v)) : Number.isFinite(Number(v)) ? num(Number(v), 2) : v]))));
  const sec = g.security || {};
  // A green dot without an explanation just moves the question: checked for what?
  const checked = level === 'ok' ? [
    sec.honeypot === false ? t('honeypot: tidak') : null,
    Number.isFinite(sec.buyTaxPct) || Number.isFinite(sec.sellTaxPct)
      ? t('pajak beli/jual {b}/{s}%', { b: num(sec.buyTaxPct || 0, 1), s: num(sec.sellTaxPct || 0, 1) }) : null,
    sec.openSource === true ? t('kontrak terverifikasi') : null,
    sec.ownerRenounced === true ? t('owner sudah dilepas') : null,
  ].filter(Boolean) : [];
  const head = `GMGN — ${t(heading)}${g.symbol ? ` · ${g.symbol}` : ''}`;
  const kaki = level === 'unknown'
    ? t('Kolom keamanan yang dipakai penilaian belum terisi di GMGN. Belum dinilai bukan berarti aman.')
    : t('Penilaian dari data GMGN, bukan audit kontrak.');
  const item = [...content, ...checked];
  // Description for screen readers & browsers without the JS overlay: one flat text.
  const datar = [head, ...item.map((x) => `• ${x}`), kaki].join('\n');
  return (
    <Hover className={`${color} ${className}`} label={datar} content={
      <>
        <p className="font-medium">{head}</p>
        {item.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {item.map((x, i) => <li key={i} className="flex gap-1.5"><span aria-hidden>•</span><span>{x}</span></li>)}
          </ul>
        )}
        <p className="mt-1.5 text-muted">{kaki}</p>
      </>
    }>
      <Icon size={13} role="img" aria-label={datar} />
    </Hover>
  );
}

// Our own tooltip, not the browser's built-in `title`. The reason is timing: the browser holds
// back a title for ~1–1.5 seconds, and the whole content of this indicator LIVES in its
// tooltip — the shield itself is only a colour. Waiting a second and a half to learn why
// a token is flagged red feels like a stuck page.
//
// Drawn via a portal into <body> with position:fixed: the shield sits inside a
// horizontally scrollable table, and a box drawn inside a scroll container
// would be clipped at its edge.
function Hover({ children, content, label, className = '' }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setBox({ x: r.left + r.width / 2, atas: r.top, bawah: r.bottom });
  };
  return (
    <span ref={ref} className={`inline-flex shrink-0 cursor-help items-center ${className}`}
      tabIndex={0} aria-label={label}
      onMouseEnter={open} onMouseLeave={() => setBox(null)}
      onFocus={open} onBlur={() => setBox(null)}>
      {children}
      {box && createPortal(
        // Above the shield if it fits, below it if it is near the screen edge; the left
        // and right ends are kept inside the viewport so nothing is clipped.
        <div role="tooltip" style={{
          position: 'fixed', zIndex: 9999, left: Math.min(Math.max(box.x, 170), window.innerWidth - 170),
          ...(box.atas > 190 ? { top: box.atas - 8, transform: 'translate(-50%, -100%)' } : { top: box.bawah + 8, transform: 'translateX(-50%)' }),
        }} className="pointer-events-none max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-foreground shadow-lg">
          {content}
        </div>, document.body)}
    </span>
  );
}
