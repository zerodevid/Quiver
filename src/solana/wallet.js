'use strict';
// Kunci wallet Solana. Terpisah dari kunci EVM (ed25519, bukan secp256k1): satu kunci
// privat EVM tidak bisa dipakai di Solana dan sebaliknya.
//
// Sumber, urutan prioritas:
//   LPCOPY_SOLANA_PRIVATE_KEY      (.env / lingkungan)
//   wallet.solana_key_file         (config; bawaan ~/.lpcopy/solana-key)
// Bentuk yang diterima: base58 64-byte (ekspor Phantom/Solflare) atau larik JSON
// [n,n,…] 64 angka (berkas solana-keygen).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const DEFAULT_FILE = '~/.lpcopy/solana-key';
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function parseSecret(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let bytes;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('kunci Solana: larik JSON tidak sah');
    bytes = Uint8Array.from(arr);
  } else {
    bytes = bs58.decode(s);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`kunci Solana harus 64 byte (atau seed 32 byte), bukan ${bytes.length}`);
}

function keyFileOf(cfg) { return expand(cfg?.wallet?.solana_key_file || DEFAULT_FILE); }

function loadKeypair(cfg, env = process.env) {
  if (env.LPCOPY_SOLANA_PRIVATE_KEY) return parseSecret(env.LPCOPY_SOLANA_PRIVATE_KEY);
  const p = keyFileOf(cfg);
  if (!p || !fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  if ((st.mode & 0o077) !== 0) throw new Error(`izin ${p} terlalu longgar — jalankan: chmod 600 ${p}`);
  return parseSecret(fs.readFileSync(p, 'utf8'));
}

// Simpan kunci baru (dari halaman Pengaturan / Telegram): base58, izin 600.
function saveKeypair(cfg, kp) {
  const p = keyFileOf(cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, bs58.encode(kp.secretKey), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* abaikan */ }
  return p;
}

const solanaKeyFromEnv = () => !!process.env.LPCOPY_SOLANA_PRIVATE_KEY;

// Password-encrypted keystore (Solana has no standard one): the 64-byte secret key under
// PBKDF2-SHA256 (600k iterations) → AES-256-GCM. The same format the Settings export writes
// and the dashboard's offline opener / `npm run export-key` read.
function encryptKeystore(kp, password) {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iterations = 600_000;
  const key = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(kp.secretKey)), c.final(), c.getAuthTag()]);
  const address = kp.publicKey.toBase58();
  return {
    format: 'quiver-solana-keystore', version: 1, address,
    crypto: { cipher: 'aes-256-gcm', kdf: 'pbkdf2', kdfparams: { hash: 'sha256', iterations, salt: salt.toString('hex') }, iv: iv.toString('hex'), ciphertext: ct.toString('hex') },
  };
}

function decryptKeystore(j, password) {
  const crypto = require('node:crypto');
  const c = j?.crypto || {};
  if (j?.format !== 'quiver-solana-keystore' || c.cipher !== 'aes-256-gcm' || c.kdf !== 'pbkdf2') throw new Error('format keystore Solana tidak dikenal');
  const key = crypto.pbkdf2Sync(String(password), Buffer.from(c.kdfparams.salt, 'hex'), c.kdfparams.iterations, 32, c.kdfparams.hash || 'sha256');
  const ct = Buffer.from(c.ciphertext, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'hex'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  let secret;
  try { secret = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); } catch { throw new Error('password salah atau keystore rusak'); }
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

module.exports = { parseSecret, loadKeypair, saveKeypair, keyFileOf, solanaKeyFromEnv, encryptKeystore, decryptKeystore, DEFAULT_FILE };
