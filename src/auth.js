'use strict';
// User accounts for multi-user mode: password login, invite-only registration and
// server-side sessions. Tables live in db.js (users, sessions, invites, audit).
//
// Secrets are never stored in the clear: passwords are scrypt hashes, session ids and
// invite codes are stored as SHA-256 digests (they are 256-bit random, so a plain
// digest is enough and lets us look them up by value).
//
// Hashing runs on the libuv thread pool (async scrypt), never on the event loop: every
// account's engines share this process, and a flood of sign-in attempts must not stall them.
// At most HASH_PARALLEL hashes run at once and HASH_QUEUE more may wait; beyond that a request
// is refused right away ('busy').
const crypto = require('node:crypto');

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
// 'token' is what the audit log shows for the shared access token.
const RESERVED = new Set(['token']);
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const HASH_PARALLEL = 4;
const HASH_QUEUE = 32;
// Retyped-password checks (key export, backups, password change): a stolen session must not
// become a free password oracle.
const RETYPE_MAX_FAILS = 5;
const RETYPE_WINDOW_MS = 15 * 60_000;
// A fixed dummy hash so a login for an unknown username costs the same as a real one.
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let running = 0;
const waiting = [];
function scrypt(password, salt, len) {
  if (running >= HASH_PARALLEL && waiting.length >= HASH_QUEUE) {
    return Promise.reject(new AuthError('busy', 'server is busy, try again shortly'));
  }
  const go = () => new Promise((resolve, reject) => {
    running++;
    crypto.scrypt(password, salt, len, (err, dk) => {
      running--;
      if (waiting.length) waiting.shift()();
      if (err) reject(err); else resolve(dk);
    });
  });
  if (running < HASH_PARALLEL) return go();
  return new Promise((resolve) => waiting.push(resolve)).then(go);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [alg, saltHex, dkHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !dkHex) return false;
  const want = Buffer.from(dkHex, 'hex');
  const got = await scrypt(String(password).slice(0, MAX_PASSWORD), Buffer.from(saltHex, 'hex'), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function checkPasswordShape(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) throw new AuthError('password', `password must be at least ${MIN_PASSWORD} characters`);
  if (p.length > MAX_PASSWORD) throw new AuthError('password', `password must be at most ${MAX_PASSWORD} characters`);
  return p;
}

class Auth {
  constructor(store) {
    this.store = store;
    this.retypeFails = new Map();            // userId -> { n, until }
  }

  userCount() { return this.store.get('SELECT COUNT(*) n FROM users').n; }
  hasUsers() { return this.userCount() > 0; }

  // `legacy` = signed in with the shared access token rather than an account.
  publicUser(u) { return u ? { id: u.id, username: u.username, role: u.role, status: u.status, legacy: !!u.legacy } : null; }
  userById(id) { return this.store.get('SELECT * FROM users WHERE id=?', id) || null; }

  // The first account is the superadmin and needs no invite; everyone after needs one.
  // The invite is checked BEFORE the username, so without a valid code nobody can probe
  // which usernames exist. Everything is re-checked synchronously right before the insert:
  // two concurrent sign-ups cannot both spend one invite or take one username.
  async register({ username, password, invite }) {
    username = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username) || RESERVED.has(username)) throw new AuthError('username', 'username must be 3-32 chars: a-z 0-9 _ . -');
    const pw = checkPasswordShape(password);
    const inviteOk = () => {
      if (!this.hasUsers()) return null;
      const inv = this.store.get('SELECT * FROM invites WHERE code_hash=?', sha(invite || ''));
      if (!inv || inv.used_by || inv.expires_at < Date.now()) throw new AuthError('invite', 'invite code is invalid or expired');
      return inv;
    };
    const free = () => { if (this.store.get('SELECT 1 FROM users WHERE username=?', username)) throw new AuthError('taken', 'username already taken'); };
    inviteOk();
    free();
    const hash = await hashPassword(pw);
    const first = !this.hasUsers();
    const inv = inviteOk();
    free();
    const r = this.store.run('INSERT INTO users(username, pass_hash, role, status, created_at) VALUES(?,?,?,?,?)',
      username, hash, first ? 'superadmin' : 'user', 'active', Date.now());
    const id = Number(r.lastInsertRowid);
    if (inv) this.store.run('UPDATE invites SET used_by=?, used_at=? WHERE code_hash=? AND used_by IS NULL', id, Date.now(), inv.code_hash);
    return this.userById(id);
  }

  // Returns the user on success. A suspended account fails the same way as a wrong
  // password so the response does not reveal which usernames exist.
  async login(username, password) {
    const u = this.store.get('SELECT * FROM users WHERE username=?', String(username || '').trim().toLowerCase());
    // Always run a scrypt so timing does not reveal whether the username exists.
    const ok = await verifyPassword(String(password || ''), u ? u.pass_hash : DUMMY_HASH);
    return u && ok && u.status === 'active' ? u : null;
  }

  // A retyped password for a sensitive action by a signed-in user. Locked for a while after
  // RETYPE_MAX_FAILS wrong attempts. Returns null or an AuthError code ('wrong' | 'locked').
  async confirmPassword(userId, password) {
    const now = Date.now();
    const f = this.retypeFails.get(userId);
    if (f && f.until > now && f.n >= RETYPE_MAX_FAILS) return 'locked';
    const u = this.userById(userId);
    const ok = !!u && await verifyPassword(String(password || ''), u.pass_hash);
    if (ok) { this.retypeFails.delete(userId); return null; }
    this.retypeFails.set(userId, { n: (f && f.until > now ? f.n : 0) + 1, until: now + RETYPE_WINDOW_MS });
    return 'wrong';
  }

  // Changing the password signs out every other session of that account.
  async changePassword(userId, current, next, keepSid = null) {
    const bad = await this.confirmPassword(userId, current);
    if (bad) throw new AuthError(bad, bad === 'locked' ? 'too many wrong attempts' : 'current password is wrong');
    const pw = checkPasswordShape(next);
    const hash = await hashPassword(pw);
    this.store.run('UPDATE users SET pass_hash=? WHERE id=?', hash, userId);
    this.store.run('DELETE FROM sessions WHERE user_id=? AND id_hash<>?', userId, keepSid ? sha(keepSid) : '');
  }

  // Superadmin reset: a random temporary password, returned once; all sessions end.
  async resetPassword(userId) {
    const u = this.userById(userId);
    if (!u) throw new AuthError('missing', 'user not found');
    if (u.role === 'superadmin') throw new AuthError('forbidden', 'the superadmin changes its own password');
    const temp = crypto.randomBytes(9).toString('base64url');
    this.store.run('UPDATE users SET pass_hash=? WHERE id=?', await hashPassword(temp), userId);
    this.destroyUserSessions(userId);
    this.retypeFails.delete(userId);
    return temp;
  }

  createSession(userId, ttlMs = SESSION_TTL_MS) {
    const sid = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.store.run('DELETE FROM sessions WHERE expires_at < ?', now);
    this.store.run('INSERT INTO sessions(id_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)', sha(sid), userId, now, now + ttlMs);
    return sid;
  }
  userBySession(sid) {
    if (!sid) return null;
    const s = this.store.get('SELECT * FROM sessions WHERE id_hash=?', sha(sid));
    if (!s || s.expires_at < Date.now()) return null;
    const u = this.userById(s.user_id);
    return u && u.status === 'active' ? u : null;
  }
  destroySession(sid) { if (sid) this.store.run('DELETE FROM sessions WHERE id_hash=?', sha(sid)); }
  destroyUserSessions(userId) { this.store.run('DELETE FROM sessions WHERE user_id=?', userId); }

  // The plain code is returned once, only its digest is kept.
  createInvite(createdBy, ttlMs = INVITE_TTL_MS) {
    const code = crypto.randomBytes(16).toString('hex');
    this.store.run('INSERT INTO invites(code_hash, created_by, created_at, expires_at) VALUES(?,?,?,?)', sha(code), createdBy, Date.now(), Date.now() + ttlMs);
    return code;
  }
  listInvites() {
    return this.store.all('SELECT rowid id, created_by, created_at, expires_at, used_by, used_at FROM invites ORDER BY created_at DESC, rowid DESC');
  }
  revokeInvite(id) { return this.store.run('DELETE FROM invites WHERE rowid=? AND used_by IS NULL', id).changes > 0; }

  audit({ user = null, username = null, ip = null, action, detail = null, ok = true }) {
    this.store.run('INSERT INTO audit(ts, user_id, username, ip, action, detail, ok) VALUES(?,?,?,?,?,?,?)',
      Date.now(), user?.id ?? null, (user ? (user.legacy ? 'token' : user.username) : username) ?? null,
      ip, String(action).slice(0, 80), detail == null ? null : String(detail).slice(0, 300), ok ? 1 : 0);
  }
  listAudit({ limit = 200, userId = null } = {}) {
    const n = Math.min(1000, Math.max(1, Number(limit) || 200));
    return userId == null
      ? this.store.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', n)
      : this.store.all('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?', Number(userId), n);
  }
  pruneAudit(days = 365) { this.store.run('DELETE FROM audit WHERE ts < ?', Date.now() - days * 86400_000); }

  listUsers() { return this.store.all('SELECT id, username, role, status, created_at FROM users ORDER BY id'); }
  setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) throw new AuthError('status', 'bad status');
    const u = this.userById(id);
    if (!u) throw new AuthError('missing', 'user not found');
    if (u.role === 'superadmin') throw new AuthError('forbidden', 'cannot suspend a superadmin');
    this.store.run('UPDATE users SET status=? WHERE id=?', status, id);
    if (status === 'suspended') this.destroyUserSessions(id);
  }
}

module.exports = { Auth, AuthError, hashPassword, verifyPassword, SESSION_TTL_MS, MIN_PASSWORD };
