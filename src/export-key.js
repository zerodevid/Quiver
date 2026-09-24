'use strict';
// Alat offline: buka keystore V3 terenkripsi (hasil unduhan tombol "Ekspor wallet" di
// dasbor) jadi kunci privat mentah, buat diimpor ke wallet yang tidak menerima format
// keystore JSON (mis. OKX Wallet — cuma terima kunci privat/frasa pemulihan).
//
// Sengaja TIDAK ada di jalur dasbor: kunci privat mentah cuma pernah muncul di terminal
// lokal ini, tidak pernah lewat jaringan. Jalankan: npm run export-key -- <keystore.json>
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { ethers } = require('ethers');

// Prompt password tanpa menggemakan ketikan ke layar (readline biasa menampilkan apa
// yang diketik; di sini _writeToOutput dibungkam kecuali untuk prompt & baris baru).
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const outWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (s === question || s === '\n' || s === '\r\n') outWrite(s); };
    rl.question(question, (v) => { rl.history = rl.history.slice(1); rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}

function openSolana(j, pass) {
  const crypto = require('node:crypto');
  const bs58 = require('bs58');
  const c = j.crypto || {};
  if (c.cipher !== 'aes-256-gcm' || c.kdf !== 'pbkdf2') throw new Error('format keystore tidak dikenal');
  const key = crypto.pbkdf2Sync(pass, Buffer.from(c.kdfparams.salt, 'hex'), c.kdfparams.iterations, 32, c.kdfparams.hash || 'sha256');
  const ct = Buffer.from(c.ciphertext, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'hex'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  let secret;
  try { secret = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); } catch { throw new Error('password salah atau berkas rusak'); }
  const enc = (bs58.default || bs58).encode;
  return { address: enc(secret.subarray(32)), privateKey: enc(secret) };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('pakai: npm run export-key -- <path-ke-keystore.json>');
    process.exit(1);
  }
  const p = path.resolve(file);
  if (!fs.existsSync(p)) { console.error(`berkas tidak ditemukan: ${p}`); process.exit(1); }
  const json = fs.readFileSync(p, 'utf8');

  const pass = process.env.QUIVER_KEYSTORE_PASSWORD || await askHidden('Password keystore: ');
  console.log('membuka keystore… (butuh beberapa detik, KDF sengaja lambat)');
  let wallet;
  try {
    let j = null;
    try { j = JSON.parse(json); } catch { /* biar ethers yang melapor */ }
    // Keystore Solana dari dasbor (PBKDF2 + AES-GCM, lihat settings.js) → kunci base58
    // yang diterima Phantom/Solflare.
    wallet = j?.format === 'quiver-solana-keystore' ? openSolana(j, pass) : await ethers.Wallet.fromEncryptedJson(json, pass);
  } catch (e) {
    console.error(`gagal membuka: ${e.shortMessage || e.message}`);
    process.exit(1);
  }

  console.log('\n=== JANGAN discreenshot / disalin ke aplikasi catatan ===');
  console.log(`Alamat       : ${wallet.address}`);
  console.log(`Kunci privat : ${wallet.privateKey}`);
  console.log('===========================================================');
  console.log('\nSetelah dipakai (mis. diimpor ke OKX Wallet), bersihkan jejaknya:');
  console.log('  - Terminal.app: Cmd+K (atau `history -d $(history 1)` di shell ini)');
  console.log('  - Jangan biarkan baris di atas nangkring di scrollback lama.');
}

main();
