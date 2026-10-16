'use strict';
// Telegram deep-link login broker.
//
// The dashboard asks for a code, opens t.me/<bot>?start=login_<code>, the user taps Start, the hub
// bot shows which browser asked (device, IP, a 6-digit match code also shown on the login page)
// and waits for "Yes, it's me"; only then is the code authorized against their Telegram identity,
// and the dashboard polls with a browser-only secret to collect the session.
//
// Two tokens on purpose: the `code` travels through Telegram (could be seen) and only authorizes;
// the `poll` secret never leaves the browser and is what redeems the session. The confirmation
// step stops a phished link (someone else's code) from silently signing the attacker's browser
// into the victim's account, and the first Telegram user to open a code owns it, so a forwarded
// link cannot be confirmed by anyone else.
//
// Codes live in memory only (a restart simply asks the user to try again) and are bounded: a few
// per IP and a global cap, so hammering the public start endpoint cannot grow the map.
const crypto = require('node:crypto');

const TTL_MS = 2 * 60_000;
const MAX_PER_IP = 5;       // live codes per requesting IP; the oldest is dropped beyond this
const MAX_PENDING = 2000;   // live codes overall; new requests are refused beyond this

// Constant-time compare of two secrets of any length (hashed first, so lengths always match).
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// "Chrome · macOS" from a User-Agent, for the confirmation. Order matters: Edge, Opera and
// Samsung Internet also say "Chrome"; Chrome also says "Safari".
function describeUserAgent(ua) {
  ua = String(ua || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

// `botUsername()`: the hub bot's @name, or null while it is not connected.
// `onboard(from, chatId)`: find-or-create the account for a Telegram user ({ ok, user, created,
// address, name } or { error }). `now`: clock, for tests.
function createLoginBroker({ botUsername, onboard, now = () => Date.now() }) {
  const pending = new Map();  // code -> { poll, exp, status, match, device, ip, tgId, userId, name, created }
  const sweep = () => { const t = now(); for (const [k, v] of pending) if (v.exp < t) pending.delete(k); };
  const get = (code) => { sweep(); return pending.get(String(code)); };
  const UNKNOWN = { error: 'Kode login tidak dikenal atau sudah kedaluwarsa.' };

  return {
    TTL: TTL_MS,
    onboard,
    size: () => { sweep(); return pending.size; },

    // `ua`, `ip`: the requesting browser, shown in the bot's confirmation.
    request({ ua = '', ip = '' } = {}) {
      sweep();
      const username = botUsername();
      if (!username) return { error: 'Login Telegram belum siap: bot belum tersambung.' };
      ip = String(ip || '').slice(0, 64);
      const mine = [...pending].filter(([, p]) => p.ip === ip && p.status === 'pending');
      for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_PER_IP + 1))) pending.delete(k);
      if (pending.size >= MAX_PENDING) return { error: 'Terlalu banyak permintaan login. Coba lagi sebentar lagi.' };
      const code = crypto.randomBytes(8).toString('hex');
      const poll = crypto.randomBytes(32).toString('hex');
      // Six digits, grouped "482 913" so both sides are easy to compare at a glance.
      const match = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0').replace(/^(\d{3})/, '$1 ');
      pending.set(code, { poll, exp: now() + TTL_MS, status: 'pending', match, device: describeUserAgent(ua), ip });
      return { code, poll, match, url: `https://t.me/${username}?start=login_${code}`, ttlMs: TTL_MS };
    },

    // The bot received /start login_<code>: bind the code to that Telegram user and return what to
    // show in the confirmation.
    describe(code, from) {
      const p = get(code);
      if (!p) return UNKNOWN;
      if (p.status !== 'pending') return { error: 'Kode login sudah dipakai.' };
      if (p.tgId && p.tgId !== String(from.id)) return { error: 'Kode login ini sudah dibuka akun Telegram lain.' };
      p.tgId = String(from.id);
      return { device: p.device, ip: p.ip, match: p.match };
    },

    // "Not me": the browser that asked gets an error instead of a session.
    deny(code, from) {
      const p = get(code);
      if (!p || p.status !== 'pending' || p.tgId !== String(from.id)) return UNKNOWN;
      p.status = 'denied';
      return { ok: true };
    },

    // "Yes, it's me": onboard, then mark the login so the dashboard poll can collect the session.
    authorize(code, from, chatId = null) {
      const p = get(code);
      if (!p) return UNKNOWN;
      if (p.status !== 'pending') return { error: 'Kode login sudah dipakai.' };
      if (p.tgId !== String(from.id)) return { error: 'Kode login ini milik akun Telegram lain.' };
      const r = onboard(from, chatId);
      if (r.error) return r;
      Object.assign(p, { status: 'ok', userId: r.user.id, name: r.name, created: r.created });
      return { ok: true, user: r.user, name: r.name, created: r.created, address: r.address };
    },

    // The dashboard poll. Consumes the code once it is settled (session handed out or denied).
    claim(poll) {
      sweep();
      if (!poll) return { error: 'expired' };
      for (const [code, p] of pending) {
        if (!sameSecret(p.poll, poll)) continue;
        if (p.status === 'ok') { pending.delete(code); return { userId: p.userId, name: p.name, created: p.created }; }
        if (p.status === 'denied') { pending.delete(code); return { error: 'Login ditolak di Telegram.' }; }
        return { pending: true };
      }
      return { error: 'expired' };
    },
  };
}

module.exports = { createLoginBroker, describeUserAgent, TTL_MS, MAX_PER_IP, MAX_PENDING };
