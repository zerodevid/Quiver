'use strict';
const { ensureChain } = require('./networks');
// Rute halaman Pengaturan: wallet bot, endpoint RPC (termasuk yang memakai API key),
// gas, notifikasi, mesin, dan token akses dasbor.
//
// Aturan keamanan yang dipegang di sini:
//  - Kunci privat mentah TIDAK PERNAH dikirim balik ke browser — hanya alamatnya, atau
//    (lewat /wallet/export, digembok token dashboard yang diketik ulang) keystore V3
//    terenkripsi password yang diisi saat itu juga, tidak pernah disimpan di server.
//  - Kunci lama tidak pernah dihapus diam-diam: dipindah ke berkas cadangan bertanggal.
//  - URL/header RPC yang mengandung API key selalu disamarkan di respons; untuk
//    endpoint yang tidak diubah, browser cukup mengirim id-nya dan rahasianya tetap
//    di server.
//  - Wallet tidak bisa diganti selagi mode LIVE — mengganti kunci di tengah eksekusi
//    bisa meninggalkan posisi yang tidak tercatat.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns').promises;
const { ethers } = require('ethers');
const { RpcPool } = require('./rpc');
const { TOPIC } = require('./chain');
const { writeCfg, envName, privateKeyFromEnv } = require('./env');

const MASK = '••••';

// Penjaga SSRF untuk URL RPC yang diketik pengguna. URL RPC sah boleh menunjuk
// node yang di-host sendiri di loopback/jaringan privat, jadi keduanya DIBIARKAN;
// yang ditutup adalah rentang link-local (169.254.0.0/16 & fe80::/10) tempat layanan
// metadata cloud tinggal — target SSRF paling berharga. Layanan metadata sendiri
// hanya melayani HTTP, dan URL RPC wajib https, jadi ini lapis pertahanan tambahan.
function isLinkLocal(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ip.startsWith('169.254.');
  if (v === 6) { const s = ip.toLowerCase(); return s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('::ffff:169.254.'); }
  return false;
}
async function assertSafeRpcUrl(rawUrl) {
  let host;
  try { host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, ''); } catch { throw new Error('URL tidak valid'); }
  // Nama host metadata cloud yang lazim — tutup lebih dulu sebelum resolusi DNS.
  if (/(^|\.)metadata\.(google|goog)\b/i.test(host) || host === 'metadata') throw new Error('host tidak diizinkan');
  if (net.isIP(host)) { if (isLinkLocal(host)) throw new Error('alamat link-local tidak diizinkan'); return; }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); } catch { return; } // resolusi gagal: biarkan pemanggil yang menangani
  if (addrs.some((a) => isLinkLocal(a.address))) throw new Error('host mengarah ke alamat link-local');
}

function maskUrl(u) {
  try {
    const url = new URL(u);
    // segmen path yang tampak seperti kunci (panjang & acak) disamarkan
    url.pathname = url.pathname.split('/').map((seg) =>
      (seg.length >= 16 && /^[A-Za-z0-9_\-]+$/.test(seg) ? seg.slice(0, 4) + MASK : seg)).join('/');
    for (const [k, v] of url.searchParams) if (v) url.searchParams.set(k, v.slice(0, 3) + MASK);
    if (url.password) url.password = MASK;
    return decodeURI(url.toString());
  } catch { return MASK; }
}
function hasSecret(e) {
  if (e.headers && Object.keys(e.headers).length) return true;
  try {
    const url = new URL(e.url);
    if (url.search || url.password) return true;
    return url.pathname.split('/').some((seg) => seg.length >= 16 && /^[A-Za-z0-9_\-]+$/.test(seg));
  } catch { return false; }
}
function maskHeaders(h) {
  if (!h) return null;
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = String(v).slice(0, 4) + MASK;
  return out;
}

// Menguji sebuah endpoint dan menyarankan bendera yang cocok untuknya. `chain` =
// profil chain yang diharapkan (pools.js Chain): chain id, alamat kontrak untuk uji.
async function probeRpc({ url, headers }, chain) {
  chain = ensureChain(chain);
  const { ADDR, CHAIN_ID } = chain;
  try { await assertSafeRpcUrl(url); } catch (e) { return { url: maskUrl(url), usable: false, summary: e.message }; }
  const pool = new RpcPool([{ url, headers, max_batch: 10 }], () => {}, { max_inflight: 1 });
  const hex = (n) => '0x' + n.toString(16);
  const t = async (fn) => {
    const t0 = Date.now();
    try { const v = await fn(); return { ok: true, ms: Date.now() - t0, v }; }
    catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 140) }; }
  };
  const out = { url: maskUrl(url) };
  out.chainId = await t(async () => parseInt(await pool.call('eth_chainId'), 16));
  if (!out.chainId.ok) return { ...out, usable: false, summary: 'Tidak bisa dihubungi' };
  if (out.chainId.v !== CHAIN_ID) return { ...out, usable: false, summary: `Chain salah (${out.chainId.v}, harusnya ${CHAIN_ID})` };
  out.block = await t(() => pool.blockNumber());
  if (!out.block.ok) return { ...out, usable: false, summary: 'eth_blockNumber ditolak' };
  const head = out.block.v;
  out.call = await t(() => pool.ethCall(ADDR.posmV4, '0x95d89b41'));
  out.logsSmall = await t(() => pool.call('eth_getLogs', [{ address: ADDR.poolManager, topics: [TOPIC.modifyLiquidity], fromBlock: hex(head - 1000), toBlock: hex(head) }], { timeoutMs: 20_000 }));
  // query terfilter alamat pada rentang besar — pola yang dipakai riset wallet
  const pad = '0x' + '0'.repeat(24) + ADDR.usdg.slice(2);
  out.logsLarge = await t(() => pool.call('eth_getLogs', [{ address: ADDR.posmV4, topics: [TOPIC.transfer, null, pad], fromBlock: hex(head - 900_000), toBlock: hex(head) }], { timeoutMs: 20_000 }));
  const slot = '0x' + '0'.repeat(63) + '6';
  out.archive = await t(() => pool.call('eth_call', [{ to: ADDR.poolManager, data: '0x1e2eaeaf' + slot.slice(2) }, hex(head - 50_000)], { timeoutMs: 20_000 }));

  const suggest = {
    no_logs: !out.logsSmall.ok,
    max_log_blocks: out.logsSmall.ok && !out.logsLarge.ok ? 3000 : 0,
    archive: !!out.archive.ok,
  };
  const parts = [`${out.block.ms} ms`];
  parts.push(out.call.ok ? 'eth_call ✓' : 'eth_call ✗');
  parts.push(!out.logsSmall.ok ? 'getLogs ✗' : out.logsLarge.ok ? 'getLogs rentang besar ✓' : 'getLogs hanya rentang kecil');
  parts.push(out.archive.ok ? 'arsip ✓' : 'bukan arsip');
  return { ...out, usable: out.call.ok, suggest, summary: parts.join(' · ') };
}

// `engines`: semua mesin di proses ini (wallet yang sama dipakai semua chain — ganti
// kunci harus me-reset dompet tiap mesin). `chain` = profil chain tampilan ini.
function createSettingsRoutes({ engine, engines = [engine], store, cfg, cfgPath, rpc, chain, log, readBody, telegram, sessionCookie, market = null }) {
  chain = ensureChain(chain || engine?.chain);
  // Lewat writeCfg: nilai dari .env tidak boleh ikut tertulis ke config.json.
  const saveCfg = () => writeCfg(cfgPath, cfg);
  const resetWallets = () => { for (const e of engines) e.exec.resetWallet(); };
  // Kolom yang diatur .env akan ditimpa lagi saat restart — mengubahnya dari dasbor
  // cuma menipu, jadi ditolak dengan petunjuk di mana mengubahnya.
  const lockedByEnv = (dotted) => {
    const n = envName(cfg, dotted);
    return n ? { error: `Diatur lewat ${n} di .env — ubah di berkas itu lalu restart.` } : null;
  };
  const exec = engine.exec;

  const backupKey = (p) => {
    if (!fs.existsSync(p)) return null;
    const bak = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, bak);
    return bak;
  };
  const writeKey = (pk) => {
    const p = exec.keyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const bak = backupKey(p);
    fs.writeFileSync(p, pk, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    resetWallets();
    const addr = exec.address();
    if (addr) store.setState('wallet_address', addr);
    log(`kunci wallet diganti -> ${addr}${bak ? ` (kunci lama dicadangkan: ${path.basename(bak)})` : ''}`);
    return { address: addr, backup: bak ? path.basename(bak) : null };
  };
  const refuseIfLive = () => {
    if (privateKeyFromEnv()) return { error: 'Kunci wallet diatur lewat LPCOPY_PRIVATE_KEY di .env — ganti atau hapus di berkas itu lalu restart.' };
    // Kunci diganti di tengah entry/keluar/penjualan: transaksi berikutnya (mint, jual token
    // zap) ditandatangani wallet LAIN yang tidak memegang tokennya.
    // (Mode LIVE sudah wajib mati, tapi entry yang dimulai sebelum mode dimatikan tetap
    // berjalan sampai selesai.)
    if ((engine.activeEntries || 0) > 0 || engine.exiting?.size > 0 || engine.selling?.size > 0 || engine.compound?.running) return { error: 'Bot sedang memproses transaksi (masuk/keluar/jual sisa) — tunggu sampai selesai, lalu coba lagi.' };
    return !engine.dryRun() ? { error: 'Matikan mode LIVE dulu sebelum mengganti wallet.' } : null;
  };

  const rpcView = () => {
    // Urutan rpc.eps selalu sama dengan cfg.chain.endpoints (dibuat dari daftar yang
    // sama), jadi dicocokkan per indeks — mencocokkan per URL salah kalau dua endpoint
    // memakai URL yang sama dengan header berbeda.
    const all = rpc.stats();
    return (cfg.chain.endpoints || []).map((e, id) => {
      const st = all[id] && all[id].url === e.url ? all[id] : {};
      return {
        id, url: maskUrl(e.url), host: (() => { try { return new URL(e.url).hostname; } catch { return '?'; } })(),
        secret: hasSecret(e), headers: maskHeaders(e.headers),
        no_logs: !!e.no_logs, max_log_blocks: e.max_log_blocks || 0, archive: !!e.archive,
        max_batch: e.max_batch || 40, note: e.catatan || '',
        calls: st.calls || 0, errors: st.errors || 0, lastMs: st.lastMs || 0, cooling: !!st.cooling,
      };
    });
  };

  // Token bot Telegram = kendali penuh atas bot itu; ia tidak pernah dikirim utuh
  // ke peramban, sama seperti kunci privat dan API key RPC.
  const tgView = () => {
    const t = cfg.telegram || {};
    const pair = telegram?.pairCode && Date.now() < telegram.pairCode.exp
      ? { code: telegram.pairCode.code, expiresInSec: Math.round((telegram.pairCode.exp - Date.now()) / 1000) } : null;
    return {
      hasToken: !!t.bot_token,
      fromEnv: envName(cfg, 'telegram.bot_token'),
      token: t.bot_token ? `${String(t.bot_token).split(':')[0]}:${MASK}` : '',
      username: telegram?.me?.username || null,
      running: !!telegram?.me,
      chat_ids: (t.chat_ids || []).map(String),
      notify: { penting: true, error: true, warn: true, info: false, ...(t.notify || {}) },
      pair,
    };
  };

  // API key GMGN = akses OpenAPI atas nama akun itu; seperti token Telegram, tidak
  // pernah dikirim utuh ke peramban.
  const gmgnView = () => {
    const k = cfg.gmgn?.api_key || '';
    return { hasKey: !!k, fromEnv: envName(cfg, 'gmgn.api_key'), key: k ? `${String(k).slice(0, 6)}${MASK}` : '' };
  };

  const num = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} harus di antara ${lo} dan ${hi}`);
    return n;
  };

  // Sama seperti GET /api/overview: kas + posisi + sisa + fee belum diklaim. Dipakai
  // di kartu status breaker drawdown supaya angkanya konsisten dengan Ringkasan.
  const equityNow = async () => {
    const cash = await engine.freshCash();
    const s = engine.positions.summary(engine.ethUsd);
    return (cash?.usd || 0) + s.exposureUsd + (s.leftoverUsd || 0) + s.feeUsd;
  };

  return {
    'GET /api/settings': async () => {
      const addr = exec.address();
      const p = exec.keyPath();
      let perms = null;
      try { perms = (fs.statSync(p).mode & 0o777).toString(8); } catch { perms = null; }
      let balances = null;
      const { ADDR } = chain;
      if (addr) {
        try {
          const b = await exec.balances([ADDR.native, ADDR.usdg, ADDR.weth]);
          balances = {
            eth: Number(b.get(ADDR.native) || 0n) / 1e18,
            usdg: Number(b.get(ADDR.usdg) || 0n) / 10 ** chain.usdgDecimals,
            weth: Number(b.get(ADDR.weth) || 0n) / 1e18,
            symbols: { eth: chain.nativeSymbol, usdg: chain.usdgSymbol, weth: chain.wethSymbol },
          };
        } catch { balances = null; }
      }
      const backups = fs.existsSync(path.dirname(p))
        ? fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + '.bak-')).length : 0;
      return {
        chain: { key: chain.network, label: chain.label, chainId: chain.CHAIN_ID, nativeSymbol: chain.nativeSymbol, verified: chain.verified,
          venues: ['v4', ...chain.venues.map((v) => v.key)] },
        wallet: {
          address: addr, keyFile: cfg.wallet?.key_file || '~/.lpcopy/key',
          hasKey: privateKeyFromEnv() || fs.existsSync(p), perms, balances, backups,
          // Kunci dari .env mengalahkan berkas kunci; tombol ganti/lepas tidak berlaku.
          fromEnv: privateKeyFromEnv() ? 'LPCOPY_PRIVATE_KEY' : null,
        },
        mode: { dry_run: engine.dryRun(), paused: engine.paused() },
        risk: {
          max_daily_drawdown_pct: cfg.risk?.max_daily_drawdown_pct ?? 0,
          status: { ...engine.drawdownStatus(), equityUsd: await equityNow() },
        },
        rpc: rpcView(),
        gas: {
          price_multiplier: cfg.gas?.price_multiplier ?? 1.5,
          priority_gwei: (cfg.gas?.priority_wei ?? 10_000_000) / 1e9,
          max_gas_limit: cfg.gas?.max_gas_limit ?? 4_000_000,
          max_fee_gwei: cfg.gas?.max_fee_gwei ?? 10,
          reserve_eth: (cfg.gas?.native_reserve_wei ?? 2e15) / 1e18,
        },
        notify: { ntfy_topic: cfg.notify?.ntfy_topic || '', fromEnv: envName(cfg, 'notify.ntfy_topic') },
        authFromEnv: envName(cfg, 'server.auth_token'),
        telegram: tgView(),
        gmgn: gmgnView(),
        loop: {
          poll_ms: cfg.loop?.poll_ms ?? 1500, max_block_span: cfg.loop?.max_block_span ?? 1500,
          sync_seconds: cfg.loop?.sync_seconds ?? 30,
        },
        prices: { eth_usd: cfg.prices?.eth_usd ?? 2500, auto_eth_price: cfg.prices?.auto_eth_price !== false },
      };
    },

    // ---- wallet ----
    'POST /api/settings/wallet/generate': async (req) => {
      const b = await readBody(req);
      const live = refuseIfLive(); if (live) return live;
      if (fs.existsSync(exec.keyPath()) && !b.replace) return { error: 'Sudah ada kunci. Centang "ganti kunci yang ada" untuk menggantinya (kunci lama dicadangkan).' };
      const w = ethers.Wallet.createRandom();
      const res = writeKey(w.privateKey);
      // frasa pemulihan disimpan di server berdampingan dengan kunci, tidak dikirim ke browser
      fs.writeFileSync(exec.keyPath() + '.mnemonic', w.mnemonic.phrase, { mode: 0o600 });
      return { ok: true, ...res, mnemonicFile: path.basename(exec.keyPath()) + '.mnemonic' };
    },
    'POST /api/settings/wallet/import': async (req) => {
      const b = await readBody(req);
      const live = refuseIfLive(); if (live) return live;
      let pk = String(b.privateKey || '').trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return { error: 'Kunci privat harus 64 karakter hex (boleh diawali 0x).' };
      if (!pk.startsWith('0x')) pk = '0x' + pk;
      try { new ethers.Wallet(pk); } catch { return { error: 'Kunci privat tidak valid.' }; }
      if (fs.existsSync(exec.keyPath()) && !b.replace) return { error: 'Sudah ada kunci. Centang "ganti kunci yang ada" untuk menggantinya (kunci lama dicadangkan).' };
      return { ok: true, ...writeKey(pk) };
    },
    'POST /api/settings/wallet/remove': async (req) => {
      const b = await readBody(req);
      const live = refuseIfLive(); if (live) return live;
      const addr = exec.address();
      if (!addr) return { error: 'Tidak ada wallet terpasang.' };
      if (String(b.confirm || '').toLowerCase() !== addr) return { error: 'Ketik alamat wallet persis untuk konfirmasi.' };
      const bak = backupKey(exec.keyPath());
      resetWallets();
      store.setState('wallet_address', '');
      log(`kunci wallet dilepas (dicadangkan: ${bak ? path.basename(bak) : '-'})`);
      return { ok: true, backup: bak ? path.basename(bak) : null };
    },

    // Ekspor wallet sebagai keystore V3 terenkripsi (format sama dengan geth/MetaMask),
    // bukan kunci privat mentah — walau responsnya kesadap atau nyangkut di cache/log,
    // isinya tak berguna tanpa password yang diketik saat itu juga (tidak disimpan).
    // Digembok token dashboard yang diketik ulang: cookie sesi HttpOnly tidak bisa
    // dibaca lewat XSS, jadi ini lapis kedua yang nyata, bukan formalitas.
    'POST /api/settings/wallet/export': async (req) => {
      const b = await readBody(req);
      const TOKEN = cfg.server?.auth_token || null;
      if (!TOKEN) return { error: 'Setel token dashboard dulu di tab Keamanan sebelum bisa mengekspor wallet.' };
      const supplied = Buffer.from(String(b.token || ''));
      const real = Buffer.from(TOKEN);
      if (supplied.length !== real.length || !crypto.timingSafeEqual(supplied, real)) return { error: 'Token salah.' };
      const addr = exec.address();
      if (!addr) return { error: 'Tidak ada wallet terpasang.' };
      const pass = String(b.password || '');
      if (pass.length < 8) return { error: 'Password keystore minimal 8 karakter.' };
      let w;
      try { w = exec.loadWallet(); } catch (e) { return { error: e.message }; }
      const keystore = await w.encrypt(pass);
      log(`wallet ${addr} diekspor sebagai keystore terenkripsi`);
      return { ok: true, address: addr, keystore: JSON.parse(keystore) };
    },

    // ---- mode ----
    'POST /api/settings/live': async (req) => {
      const b = await readBody(req);
      if (b.live) {
        if (!exec.address()) return { error: 'Pasang wallet dulu sebelum menyalakan LIVE.' };
        if (String(b.confirm || '') !== 'LIVE') return { error: 'Ketik LIVE untuk konfirmasi.' };
      }
      cfg.mode = cfg.mode || {};
      cfg.mode.dry_run = !b.live;
      saveCfg();
      log(`mode diubah ke ${b.live ? 'LIVE' : 'SIMULASI'} dari halaman Pengaturan`);
      return { ok: true, dry_run: cfg.mode.dry_run };
    },

    // ---- risiko ----
    'POST /api/settings/risk': async (req) => {
      const b = await readBody(req);
      try {
        cfg.risk = { ...(cfg.risk || {}), max_daily_drawdown_pct: num(b.max_daily_drawdown_pct, 0, 100, 'Batas drawdown harian') };
      } catch (e) { return { error: e.message }; }
      saveCfg();
      log(`batas drawdown harian diubah ke ${cfg.risk.max_daily_drawdown_pct}% dari halaman Pengaturan`);
      return { ok: true, max_daily_drawdown_pct: cfg.risk.max_daily_drawdown_pct };
    },

    // ---- RPC ----
    'POST /api/settings/rpc/test': async (req) => {
      const b = await readBody(req);
      let url = b.url, headers = b.headers || null;
      if (b.id != null && !url) {                     // uji endpoint yang sudah tersimpan
        const e = cfg.chain.endpoints[Number(b.id)];
        if (!e) return { error: 'endpoint tidak ada' };
        url = e.url; headers = e.headers || null;
      }
      if (!/^https:\/\/.+/i.test(String(url || ''))) return { error: 'URL harus diawali https://' };
      return probeRpc({ url, headers }, chain);
    },
    'POST /api/settings/rpc': async (req) => {
      const b = await readBody(req);
      const list = Array.isArray(b.endpoints) ? b.endpoints : null;
      if (!list || !list.length) return { error: 'Minimal satu endpoint.' };
      const cur = cfg.chain.endpoints || [];
      const next = [];
      for (const e of list) {
        const base = e.id != null && cur[Number(e.id)] ? cur[Number(e.id)] : null;
        const url = e.url ? String(e.url).trim() : base?.url;
        if (!/^https:\/\/.+/i.test(url || '')) return { error: `URL tidak valid: ${e.url || '(kosong)'}` };
        // Endpoint yang tak diubah (kirim id saja, tanpa url) tak perlu dicek ulang.
        if (e.url) { try { await assertSafeRpcUrl(url); } catch (err) { return { error: `URL ditolak: ${err.message}` }; } }
        let headers = base?.headers || null;
        if (e.headers === null) headers = null;                       // dihapus
        else if (e.headers && typeof e.headers === 'object') headers = Object.keys(e.headers).length ? e.headers : null;
        const out = { url, max_batch: num(e.max_batch ?? base?.max_batch ?? 40, 1, 200, 'max_batch') };
        if (headers) out.headers = headers;
        if (e.no_logs) out.no_logs = true;
        if (Number(e.max_log_blocks) > 0) out.max_log_blocks = num(e.max_log_blocks, 1, 100_000_000, 'max_log_blocks');
        if (e.archive) out.archive = true;
        if (base?.catatan && !e.url) out.catatan = base.catatan;
        next.push(out);
      }
      // Riset wallet butuh getLogs rentang besar. Di chain yang endpoint publiknya
      // semua membatasi rentang (BSC), ini peringatan — pemindaian tetap jalan per
      // potongan, hanya lebih lambat.
      const warning = next.some((e) => !e.no_logs && !e.max_log_blocks) ? null
        : 'Tidak ada endpoint yang sanggup getLogs rentang besar (tanpa batas blok) — riset wallet akan berjalan per potongan dan lebih lambat.';
      cfg.chain.endpoints = next;
      saveCfg();
      rpc.reconfigure(next);
      log(`daftar RPC ${chain.label} diperbarui (${next.length} endpoint)`);
      return { ok: true, rpc: rpcView(), warning };
    },

    // ---- gas / notifikasi / mesin ----
    'POST /api/settings/gas': async (req) => {
      const b = await readBody(req);
      try {
        cfg.gas = {
          ...(cfg.gas || {}),
          price_multiplier: num(b.price_multiplier, 1, 5, 'Pengali harga gas'),
          priority_wei: Math.round(num(b.priority_gwei, 0, 100, 'Priority fee') * 1e9),
          max_gas_limit: Math.round(num(b.max_gas_limit, 100_000, 30_000_000, 'Batas gas')),
          max_fee_gwei: num(b.max_fee_gwei ?? cfg.gas?.max_fee_gwei ?? 10, 0.01, 10_000, 'Batas harga gas'),
          native_reserve_wei: Math.round(num(b.reserve_eth, 0, 10, 'Cadangan ETH') * 1e18),
        };
      } catch (e) { return { error: e.message }; }
      saveCfg();
      return { ok: true };
    },
    'POST /api/settings/notify': async (req) => {
      const b = await readBody(req);
      const locked = lockedByEnv('notify.ntfy_topic'); if (locked) return locked;
      const t = String(b.ntfy_topic || '').trim();
      if (t && !/^[A-Za-z0-9_\-]{4,64}$/.test(t)) return { error: 'Topik ntfy: 4–64 karakter huruf/angka/-/_' };
      cfg.notify = { ...(cfg.notify || {}), ntfy_topic: t || null };
      saveCfg();
      return { ok: true };
    },
    'POST /api/settings/notify/test': async () => {
      if (!cfg.notify?.ntfy_topic) return { error: 'Isi topik ntfy dulu.' };
      const r = await fetch(`https://ntfy.sh/${cfg.notify.ntfy_topic}`, { method: 'POST', body: 'Quiver: uji notifikasi dari halaman Pengaturan' })
        .then((x) => x.status).catch((e) => e.message);
      return r === 200 ? { ok: true } : { error: `ntfy membalas ${r}` };
    },
    // ---- OpenAPI GMGN ----
    'POST /api/settings/gmgn': async (req) => {
      const b = await readBody(req);
      const locked = lockedByEnv('gmgn.api_key'); if (locked) return locked;
      const v = String(b.api_key || '').trim();
      if (v && !/^[A-Za-z0-9_\-.:]{8,256}$/.test(v)) return { error: 'API key GMGN tidak dikenali bentuknya.' };
      cfg.gmgn = { ...(cfg.gmgn || {}), api_key: v || null };
      saveCfg();
      return { ok: true, gmgn: gmgnView() };
    },
    // Uji key: minta lilin 1 jam token native chain ini. Sukses = key diterima dan
    // chain ini didukung; galat dikembalikan apa adanya supaya jelas sebabnya.
    'POST /api/settings/gmgn/test': async () => {
      if (!cfg.gmgn?.api_key) return { error: 'Isi API key dulu.' };
      if (!market) return { error: 'Modul pasar belum siap.' };
      try {
        const to = Math.floor(Date.now() / 1000);
        const r = await market.gmgn('/v1/market/token_kline', { address: String(chain.ADDR.weth).toLowerCase(), resolution: '1h', from: (to - 6 * 3600) * 1000, to: to * 1000 });
        if (r?.error) return { error: r.error };
        const n = (r?.list || []).length;
        return { ok: true, candles: n, summary: n ? `API key diterima — ${n} lilin ${chain.wethSymbol} diterima dari GMGN` : 'API key diterima, tetapi GMGN tidak mengembalikan lilin untuk chain ini' };
      } catch (e) { return { error: e.message }; }
    },
    'POST /api/settings/loop': async (req) => {
      const b = await readBody(req);
      try {
        cfg.loop = {
          ...(cfg.loop || {}),
          poll_ms: Math.round(num(b.poll_ms, 500, 60_000, 'Interval pindai')),
          max_block_span: Math.round(num(b.max_block_span, 100, 3000, 'Rentang blok per pindai')),
          sync_seconds: Math.round(num(b.sync_seconds, 10, 600, 'Interval sinkron posisi')),
        };
        cfg.prices = { ...(cfg.prices || {}), eth_usd: num(b.eth_usd, 100, 100_000, 'Harga ETH cadangan'), auto_eth_price: !!b.auto_eth_price };
      } catch (e) { return { error: e.message }; }
      saveCfg();
      return { ok: true, restartNeeded: true };
    },

    // ---- bot Telegram ----
    'POST /api/settings/telegram': async (req) => {
      const b = await readBody(req);
      const t = { ...(cfg.telegram || {}) };
      if (b.bot_token !== undefined) {
        const locked = lockedByEnv('telegram.bot_token'); if (locked) return locked;
        const v = String(b.bot_token || '').trim();
        if (v === '') t.bot_token = null;
        else if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(v)) return { error: 'Token bot tidak berbentuk benar (contoh: 123456789:AAH…).' };
        else t.bot_token = v;
      }
      if (Array.isArray(b.chat_ids)) t.chat_ids = [...new Set(b.chat_ids.map((x) => String(x).trim()).filter((x) => /^-?\d+$/.test(x)))];
      if (b.notify && typeof b.notify === 'object') {
        t.notify = { ...(t.notify || {}) };
        for (const k of ['penting', 'error', 'warn', 'info']) if (k in b.notify) t.notify[k] = !!b.notify[k];
      }
      const tokenChanged = b.bot_token !== undefined && t.bot_token !== (cfg.telegram?.bot_token || null);
      cfg.telegram = t;
      saveCfg();
      log('pengaturan Telegram diperbarui');
      // Token baru langsung dipakai — tanpa restart proses, sama seperti daftar RPC.
      // Tanpa ini bot diam saja setelah token disimpan dan tidak ada petunjuk kenapa.
      if (tokenChanged && telegram) {
        const r = await telegram.restart();
        if (t.bot_token && r?.error) return { error: `Token tersimpan, tapi Telegram menolaknya: ${r.error}`, telegram: tgView() };
      }
      return { ok: true, telegram: tgView() };
    },
    'POST /api/settings/telegram/pair': async () => {
      if (!cfg.telegram?.bot_token) return { error: 'Isi token bot dulu.' };
      if (!telegram) return { error: 'Bot Telegram tidak aktif di proses ini.' };
      const code = telegram.newPairCode();
      log('kode sambung Telegram dibuat');
      return { ok: true, code, expiresInSec: 900, username: telegram.me?.username || null };
    },
    'POST /api/settings/telegram/test': async () => {
      if (!telegram) return { error: 'Bot Telegram tidak aktif di proses ini.' };
      const ids = (cfg.telegram?.chat_ids || []).map(String);
      if (!ids.length) return { error: 'Belum ada chat yang tersambung.' };
      const errs = [];
      for (const c of ids) {
        try { await telegram.send(c, 'Quiver: uji notifikasi dari halaman Pengaturan.'); }
        catch (e) { errs.push(`${c}: ${e.message}`); }
      }
      return errs.length ? { error: errs.join(' · ') } : { ok: true, sent: ids.length };
    },

    // ---- token akses ----
    'POST /api/settings/token/rotate': async (req, url, res) => {
      const locked = lockedByEnv('server.auth_token'); if (locked) return locked;
      const tok = crypto.randomBytes(18).toString('base64url');
      cfg.server = { ...(cfg.server || {}), auth_token: tok };
      saveCfg();
      log('token akses dasbor diganti');
      res.__setCookie = sessionCookie(req, tok);
      return { ok: true, token: tok };
    },
  };
}

module.exports = { createSettingsRoutes, maskUrl, probeRpc };
