// Membuka keystore Solana hasil ekspor Quiver (POST /api/settings/wallet/export di chain
// Solana) sepenuhnya di peramban: PBKDF2-SHA256 → AES-256-GCM lewat WebCrypto. Isinya
// kunci rahasia 64 byte (format solana-keygen); hasilnya base58, bentuk yang diterima
// Phantom/Solflare untuk "Import private key".
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

const hex = (s) => new Uint8Array(String(s).match(/../g).map((h) => parseInt(h, 16)));

export const isSolanaKeystore = (j) => j?.format === 'quiver-solana-keystore';

export async function openSolanaKeystore(j, password) {
  const c = j.crypto || {};
  if (c.cipher !== 'aes-256-gcm' || c.kdf !== 'pbkdf2' || c.kdfparams?.hash !== 'sha256') throw new Error('format keystore tidak dikenal');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hex(c.kdfparams.salt), iterations: c.kdfparams.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(c.iv) }, key, hex(c.ciphertext))); }
  catch { throw new Error('password salah atau berkas rusak'); }
  if (plain.length !== 64) throw new Error('isi keystore bukan kunci Solana');
  const address = base58(plain.slice(32));
  if (j.address && j.address !== address) throw new Error('alamat di berkas tidak cocok dengan kuncinya');
  return { address, pk: base58(plain) };
}
