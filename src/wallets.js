'use strict';
// The saved wallets of one key file. The active key lives at `p`; every wallet the account used
// before is kept beside it as `p.bak-<stamp>` — the backups the replace/detach buttons always
// made — so switching back is just swapping files. A wallet's recovery phrase, when it has one,
// travels with its key as `<file>.mnemonic`. Wallets dropped from the list are renamed to
// `p.removed-<stamp>`, never deleted. Names live in `p.names.json`, keyed by address so they
// survive switches.
const fs = require('node:fs');
const path = require('node:path');
const { readSecret } = require('./keyfile');

const BAK = '.bak-';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const moveMnemonic = (from, to) => { if (fs.existsSync(`${from}.mnemonic`)) fs.renameSync(`${from}.mnemonic`, `${to}.mnemonic`); };

// Moves the active key (and its mnemonic) aside as a saved wallet. Returns the backup path.
function backup(p) {
  if (!fs.existsSync(p)) return null;
  let bak = `${p}${BAK}${stamp()}`;
  while (fs.existsSync(bak)) bak += '0';
  fs.renameSync(p, bak);
  moveMnemonic(p, bak);
  return bak;
}

// Saved (inactive) key files: [{ id, file }], newest first. `id` is the stamp, safe in a
// Telegram callback (no colons).
function savedFiles(p) {
  const dir = path.dirname(p), base = path.basename(p) + BAK;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(base) && !f.endsWith('.mnemonic'))
    .map((f) => ({ id: f.slice(base.length), file: path.join(dir, f) }))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

const namesPath = (p) => `${p}.names.json`;
function names(p) {
  try { return JSON.parse(fs.readFileSync(namesPath(p), 'utf8')) || {}; } catch { return {}; }
}
function setName(p, address, name) {
  const all = names(p);
  const n = String(name || '').trim().slice(0, 24);
  if (n) all[address] = n; else delete all[address];
  fs.writeFileSync(namesPath(p), JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Every wallet of the key file: the active one first, then saved ones newest first, one entry per
// address (repeated backups of the same key collapse into the newest). `addrOf(secret)` turns a
// key into its address; a file that cannot be read (wrong master key, corrupt) is skipped.
function list(p, addrOf) {
  const nm = names(p);
  const out = [], seen = new Set();
  const add = (id, file, active) => {
    let address;
    try { address = addrOf(readSecret(file).trim()); } catch { return; }
    if (!address || seen.has(address)) return;
    seen.add(address);
    out.push({ id, address, active, name: nm[address] || null, hasMnemonic: fs.existsSync(`${file}.mnemonic`) });
  };
  if (fs.existsSync(p)) add('active', p, true);
  for (const s of savedFiles(p)) add(s.id, s.file, false);
  return out;
}

// Makes the saved wallet `id` the active one; the current key is saved aside first.
function activate(p, id) {
  const s = savedFiles(p).find((x) => x.id === String(id));
  if (!s) throw new Error('Wallet tidak ditemukan.');
  backup(p);
  fs.renameSync(s.file, p);
  moveMnemonic(s.file, p);
}

// Drops a saved wallet from the list (renamed, not deleted), with every older copy of the same
// key, so an earlier backup does not pop up in its place. The active wallet cannot be dropped.
function forget(p, id, addrOf) {
  const all = savedFiles(p);
  const s = all.find((x) => x.id === String(id));
  if (!s) throw new Error('Wallet tidak ditemukan.');
  const addr = (f) => { try { return addrOf(readSecret(f).trim()); } catch { return null; } };
  const target = addr(s.file);
  for (const x of all) {
    if (x !== s && (!target || addr(x.file) !== target)) continue;
    const to = `${p}.removed-${x.id}`;
    fs.renameSync(x.file, to);
    moveMnemonic(x.file, to);
  }
}

module.exports = { backup, savedFiles, list, activate, forget, names, setName };
