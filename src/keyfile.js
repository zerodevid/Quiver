'use strict';
// Wallet key files, optionally encrypted at rest. Multi-user accounts store their keys
// encrypted under LPCOPY_MASTER_KEY (.env); the superadmin's legacy key file stays plain
// so existing deployments keep working unchanged.
//
// Encrypted format (one line): quiver-enc:v1:<iv hex>:<tag hex>:<ciphertext hex>,
// AES-256-GCM with a key derived from the master secret via SHA-256.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIX = 'quiver-enc:v1:';

function masterKey(env = process.env) {
  const m = env.LPCOPY_MASTER_KEY;
  if (!m || String(m).length < 32) return null;
  return crypto.createHash('sha256').update(String(m)).digest();
}

function encryptSecret(plain, env = process.env) {
  const key = masterKey(env);
  if (!key) throw new Error('LPCOPY_MASTER_KEY belum diisi di .env (min. 32 karakter) — kunci wallet akun tidak bisa disimpan');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

function decryptSecret(text, env = process.env) {
  const s = String(text || '').trim();
  if (!s.startsWith(PREFIX)) return s;                 // plain key file
  const key = masterKey(env);
  if (!key) throw new Error('kunci wallet terenkripsi, tapi LPCOPY_MASTER_KEY tidak ada di .env');
  const [ivHex, tagHex, ctHex] = s.slice(PREFIX.length).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  try { return Buffer.concat([d.update(Buffer.from(ctHex, 'hex')), d.final()]).toString('utf8'); }
  catch { throw new Error('kunci wallet tidak bisa dibuka — LPCOPY_MASTER_KEY berbeda dari saat kunci disimpan'); }
}

// Reads a key file (refusing loose permissions) and returns its plain contents.
function readSecret(p) {
  const st = fs.statSync(p);
  if ((st.mode & 0o077) !== 0) throw new Error(`izin ${p} terlalu longgar — jalankan: chmod 600 ${p}`);
  return decryptSecret(fs.readFileSync(p, 'utf8'));
}

// Writes a key file with mode 600, encrypted when asked.
function writeSecret(p, plain, { encrypt = false } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, encrypt ? encryptSecret(plain) : plain, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

const isEncrypted = (text) => String(text || '').trim().startsWith(PREFIX);

module.exports = { readSecret, writeSecret, encryptSecret, decryptSecret, isEncrypted, masterKey };
