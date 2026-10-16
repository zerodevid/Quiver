// Telegram mini app session. The /mini page runs the very same dashboard as /, only signed in
// differently: Telegram's initData is exchanged at /api/tg/auth for a short-lived ticket, and
// that ticket rides as a Bearer on every request (api.js). Not a cookie: on Telegram Web the page
// sits in an iframe owned by web.telegram.org, where SameSite=Lax cookies are never sent.
//
// On the plain dashboard none of this is active: miniTicket() stays null and every helper
// below is a no-op.

// Telegram's SDK must come from telegram.org (it reads initData and the theme from the launch
// URL and wires the native buttons), so it is loaded here on /mini only, never on the dashboard.
// It must run before the app touches location.hash, where Telegram passes initData.
export let tg = null;
export const loadSdk = () => new Promise((resolve) => {
  const s = document.createElement('script');
  s.src = 'https://telegram.org/js/telegram-web-app.js';
  s.onload = () => { tg = window.Telegram?.WebApp || null; resolve(tg); };
  s.onerror = () => resolve(null);
  document.head.appendChild(s);
});

const TICKET_KEY = 'quiver-mini-ticket';
let ticket = null;
let mini = false;

export const isMini = () => mini;
export const miniTicket = () => ticket;

// Fetch headers that carry the ticket (empty outside the mini app).
export const authHeaders = () => (ticket ? { authorization: `Bearer ${ticket}` } : {});
// <img> and other plain URLs cannot carry a header; the server accepts the ticket in the query
// for /api/icon only, so this is used for token icons alone.
export const withTicket = (url) => (ticket && url ? `${url}${url.includes('?') ? '&' : '?'}t=${ticket}` : url);

// A 401 means the ticket expired (12 h) or the server restarted and forgot it: drop it so the
// reload signs in again with initData instead of looping on the dead ticket.
export const dropTicket = () => {
  ticket = null;
  try { sessionStorage.removeItem(TICKET_KEY); } catch { /* storage blocked */ }
};

// Sign in from initData. A ticket from earlier in this Telegram session is reused, so a page
// reload (chain switch, settings save) does not ask the server again. Returns null on success,
// otherwise the message to show.
export async function signIn() {
  mini = true;
  try { ticket = sessionStorage.getItem(TICKET_KEY) || null; } catch { /* storage blocked */ }
  if (ticket) return null;
  const initData = tg?.initData || '';
  if (!initData) return 'Halaman ini dibuka dari dalam Telegram. Buka bot Quiver lalu tekan tombol Mini app di menunya.';
  let r;
  try {
    const res = await fetch('/api/tg/auth', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }),
    });
    r = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  } catch (e) {
    return `Server tidak terjangkau: ${e.message}`;
  }
  if (r.error) return r.error;
  ticket = r.token || null;   // null = the server has no token gate, nothing to carry
  try { if (ticket) sessionStorage.setItem(TICKET_KEY, ticket); } catch { /* storage blocked */ }
  return null;
}

// Links open in the phone's browser through Telegram; window.open inside its webview is
// either blocked or replaces the mini app.
export const openLink = (url) => {
  if (tg?.openLink && /^https?:/i.test(url)) { tg.openLink(url); return true; }
  return false;
};

// Telegram chrome around the page: its header and background follow the dashboard theme so the
// seam is invisible (hex — setHeaderColor does not take oklch), and its built-in back button
// walks the hash history whenever a page other than Summary is open.
const BG = { light: '#f7f7f7', dark: '#0c0c0e' };
export function paintChrome(theme) {
  try {
    tg?.setHeaderColor?.(BG[theme] || BG.light);
    tg?.setBackgroundColor?.(BG[theme] || BG.light);
  } catch { /* older client: keep its own colours */ }
}
// Outside links (explorer, DexScreener, …) go to the phone's browser through Telegram;
// a plain target=_blank inside its webview is blocked or replaces the mini app.
export function wireLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin === location.origin) return;
    if (openLink(url.href)) e.preventDefault();
  });
}
export function wireBackButton() {
  const bb = tg?.BackButton;
  if (!bb) return;
  const sync = () => {
    const page = location.hash.replace(/^#/, '').split(/[/?]/)[0];
    if (page && page !== 'overview') bb.show(); else bb.hide();
  };
  bb.onClick(() => { if (history.length > 1) history.back(); else location.hash = '#overview'; });
  window.addEventListener('hashchange', sync);
  sync();
}
