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

module.exports = { parseSecret, loadKeypair, saveKeypair, keyFileOf, solanaKeyFromEnv, DEFAULT_FILE };
