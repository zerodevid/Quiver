'use strict';
const { ensureChain, NETWORKS, build, isSolana } = require('./networks');
const { enabledChains, chainTemplate } = require('./multichain');
// Settings page routes: the bot wallet, RPC endpoints (including ones using an API key),
// gas, notifications, engine, and the dashboard access token.
//
// Security rules held here:
//  - The raw private key is NEVER sent back to the browser — only its address, or
//    (via /wallet/export, locked by the dashboard token retyped) a password-encrypted V3
//    keystore filled in right then, never stored on the server.
//  - An old key is never silently deleted: it is moved to a dated backup file.
//  - RPC URLs/headers containing an API key are always masked in responses; for
//    an unchanged endpoint, the browser only sends its id and the secret stays
//    on the server.
//  - The wallet cannot be changed while in LIVE mode — swapping the key in the middle of execution
//    can leave an unrecorded position.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns').promises;
const { ethers } = require('ethers');
const { RpcPool } = require('./rpc');
const { TOPIC } = require('./chain');
const { writeCfg, envName, privateKeyFromEnv } = require('./env');
const { CURRENCIES, currencyOf } = require('./fx');
const { createBackup, parseBackup, stageRestore } = require('./backup');

const MASK = '••••';

// SSRF guard for RPC URLs typed by the user. A legitimate RPC URL may point at
// a self-hosted node on loopback/a private network, so both are ALLOWED;
// what is closed off is the link-local range (169.254.0.0/16 & fe80::/10) where cloud
// metadata services live — the most valuable SSRF target. The metadata service itself
// only serves HTTP, and RPC URLs must be https, so this is an extra layer of defence.
function isLinkLocal(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ip.startsWith('169.254.');
  if (v === 6) { const s = ip.toLowerCase(); return s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('::ffff:169.254.'); }
  return false;
}
async function assertSafeRpcUrl(rawUrl) {
  let host;
  try { host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, ''); } catch { throw new Error('URL tidak valid'); }
  // Common cloud metadata host names — block first before DNS resolution.
  if (/(^|\.)metadata\.(google|goog)\b/i.test(host) || host === 'metadata') throw new Error('host tidak diizinkan');
  if (net.isIP(host)) { if (isLinkLocal(host)) throw new Error('alamat link-local tidak diizinkan'); return; }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); } catch { return; } // resolution failed: let the caller handle it
  if (addrs.some((a) => isLinkLocal(a.address))) throw new Error('host mengarah ke alamat link-local');
}

function maskUrl(u) {
  try {
    const url = new URL(u);
    // path segments that look like a key (long & random) are masked
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

// Test an endpoint and suggest the flags that fit it. `chain` =
// the expected chain profile (pools.js Chain): chain id, contract addresses for the test.
async function probeRpc({ url, headers }, chain) {
  if (chain?.kind === 'solana') {
    try { await assertSafeRpcUrl(url); } catch (e) { return { url: maskUrl(url), usable: false, summary: e.message }; }
    const r = await require('./solana/rpc').probeSolanaRpc({ url, headers });
    return { ...r, url: maskUrl(url) };
  }
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
  // an address-filtered query over a large range — the pattern used by wallet research
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

// `engines`: all engines in this process (the same wallet is used by all chains — changing
// the key must reset each engine's wallet). `chain` = the chain profile of this view.
// `restart`: called after a config/database restore. Defaults to the orderly-stop path
// of index.js (SIGINT) — pm2/systemd starts it again and boot swaps the files.
function createSettingsRoutes({ engine, engines: enginesInit = [engine], nets = null, chainControl = null, store, cfg, cfgPath, rpc, chain, log, readBody, telegram, sessionCookie, market = null, fx = null,
  restart = () => process.kill(process.pid, 'SIGINT') }) {
  chain = ensureChain(chain || engine?.chain);
  // Live list: chains can be switched on and off while the bot runs.
  const liveEngines = () => (nets ? Object.values(nets).map((n) => n.engine).filter(Boolean) : enginesInit);
  // Via writeCfg: values from .env must not get written to config.json.
  const saveCfg = () => writeCfg(cfgPath, cfg);
  // Every known network with its on/off switch. `running` = an engine exists in this process,
  // `ready` = it finished warming up (first sync done).
  const chainsView = () => {
    return Object.keys(NETWORKS).map((key) => {
      const p = build(key);
      const block = cfg.chains?.[key];
      return {
        key, label: p.label, chainId: p.chainId, nativeSymbol: p.nativeSymbol,
        stable: p.QUOTES[p.ADDR.usdg]?.symbol, venues: [...(isSolana(key) ? [] : ['v4']), ...p.venues.map((v) => v.key)],  // v4 is scanned on every EVM chain
        enabled: !!block && block.enabled !== false, running: !!nets?.[key] || liveEngines().some((e) => e?.chain?.network === key),
        ready: nets ? !!nets[key]?.ready : true, primary: !!chainControl && chainControl.primaryKey === key,
        endpoints: (block?.chain?.endpoints || []).length, dryRun: block?.mode?.dry_run !== false,
        targets: (block?.targets || []).length, current: key === chain.network,
      };
    });
  };
  const resetWallets = () => { for (const e of liveEngines()) e.exec.resetWallet(); };
  // Fields governed by .env would be overwritten again on restart — changing them from the dashboard
  // would just mislead, so it is refused with a hint of where to change them.
  const lockedByEnv = (dotted) => {
    const n = envName(cfg, dotted);
    return n ? { error: `Diatur lewat ${n} di .env — ubah di berkas itu lalu restart.` } : null;
  };
  const exec = engine.exec;
  // Solana: a separate ed25519 key (~/.lpcopy/solana-key, LPCOPY_SOLANA_PRIVATE_KEY) —
  // created/imported/detached through the same routes, in the Solana key form.
  const SOL = chain.kind === 'solana';
  const sol = SOL ? require('./solana/wallet') : null;
  const keyFromEnv = () => (SOL ? sol.solanaKeyFromEnv() : privateKeyFromEnv());
  const keyEnvName = SOL ? 'LPCOPY_SOLANA_PRIVATE_KEY' : 'LPCOPY_PRIVATE_KEY';
  const walletStateKey = SOL ? `wallet_address:${chain.network}` : 'wallet_address';

  const backupKey = (p) => {
    if (!fs.existsSync(p)) return null;
    const bak = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, bak);
    return bak;
  };
  // The EVM and Solana engines of this process (either may be absent): a backup carries
  // whichever keys are installed, a restore writes each to its own key file.
  const evmEngine = () => liveEngines().find((e) => e.chain?.kind !== 'solana') || null;
  const solEngine = () => liveEngines().find((e) => e.chain?.kind === 'solana') || null;
  const writeKey = (pk) => {
    const p = exec.keyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const bak = backupKey(p);
    fs.writeFileSync(p, pk, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    resetWallets();
    const addr = exec.address();
    if (addr) store.setState(walletStateKey, addr);
    log(`kunci wallet diganti -> ${addr}${bak ? ` (kunci lama dicadangkan: ${path.basename(bak)})` : ''}`);
    return { address: addr, backup: bak ? path.basename(bak) : null };
  };
  const refuseIfLive = () => {
    if (keyFromEnv()) return { error: `Kunci wallet diatur lewat ${keyEnvName} di .env — ganti atau hapus di berkas itu lalu restart.` };
    // The key is changed in the middle of an entry/exit/sale: the next transaction (mint, sale of the zap
    // token) is signed by ANOTHER wallet that does not hold the token.
    // (LIVE mode is already required to be off, but an entry started before the mode was switched off still
    // runs to completion.)
    if ((engine.activeEntries || 0) > 0 || engine.exiting?.size > 0 || engine.selling?.size > 0 || engine.compound?.running) return { error: 'Bot sedang memproses transaksi (masuk/keluar/jual sisa) — tunggu sampai selesai, lalu coba lagi.' };
    return !engine.dryRun() ? { error: 'Matikan mode LIVE dulu sebelum mengganti wallet.' } : null;
  };

  // The dashboard token RETYPED, not a session cookie: an HttpOnly cookie cannot be
  // read via XSS, so this is a real second layer for actions that carry secrets out.
  const retypedToken = (b, noToken) => {
    const TOKEN = cfg.server?.auth_token || null;
    if (!TOKEN) return { error: noToken };
    const supplied = Buffer.from(String(b.token || ''));
    const real = Buffer.from(TOKEN);
    if (supplied.length !== real.length || !crypto.timingSafeEqual(supplied, real)) return { error: 'Token salah.' };
    return null;
  };
  // A backup file contains the database (can be several MB) — it passes the 1 MB readBody limit.
  const readBackupBody = (req) => (req.__body ? Promise.resolve(req.__body) : new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 256 * 1024 * 1024) { req.destroy(); reject(new Error('Berkas cadangan terlalu besar.')); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Berkas cadangan bukan JSON yang valid.')); } });
    req.on('error', reject);
  }));
  const busyNow = () => (liveEngines().some((e) => (e.activeEntries || 0) > 0 || e.exiting?.size > 0 || e.selling?.size > 0 || e.compound?.running)
    ? { error: 'Bot sedang memproses transaksi (masuk/keluar/jual sisa) — tunggu sampai selesai, lalu coba lagi.' } : null);

  // ---- swap aggregators (swaprouter.js) ----
  // Secrets never go back to the browser whole: only whether they are set, a masked prefix,
  // and which .env variable supplies them (those cannot be edited here).
  const AGG_FIELDS = { jupiter: [], raydium: [], dflow: ['api_key'], kyber: [], okx: ['api_key', 'secret_key', 'passphrase', 'project_id'], lifi: ['api_key'], zerox: ['api_key'], oneinch: ['api_key'], openocean: ['api_key'] };
  const router = () => (chain.kind === 'solana' ? chain.router : engine.kyber);
  const aggView = () => {
    const r = router();
    if (!r?.byId) return null;
    return {
      mode: r.mode(), order: r.order(),
      items: r.order().map((id) => {
        const a = r.byId.get(id);
        const st = cfg.aggregators?.[id] || {};
        return {
          id, label: a.label, enabled: st.enabled !== false, needsKey: !!a.needsKey, keyOptional: id === 'lifi',
          supported: a.supportsChain(), active: a.enabled(), blocker: a.blocker(),
          fields: (AGG_FIELDS[id] || []).map((f) => ({
            name: f, set: !!st[f], masked: st[f] ? `${String(st[f]).slice(0, 4)}${MASK}` : '',
            fromEnv: envName(cfg, `aggregators.${id}.${f}`),
          })),
        };
      }),
    };
  };
  // Quote caches and rate-limit cooldowns belong to the old settings: drop them in every
  // chain's router so a new key or switch takes effect on the next swap.
  const resetAggregators = () => {
    for (const e of liveEngines()) e.chain?.router?.setConfig?.(cfg);
    for (const e of liveEngines()) for (const a of e.kyber?.adapters || []) { a.cache?.clear?.(); if ('cooldownUntil' in a) a.cooldownUntil = 0; a.warned?.clear?.(); }
  };

  // Solana: every aggregator quotes `usd` worth of USDC → SOL (prices from Jupiter).
  const solanaAggregatorTest = async (r, ch, usd, onlyId) => {
    const inMint = ch.ADDR.usdg, outMint = ch.ADDR.native;
    const amountIn = BigInt(Math.round(usd * 10 ** ch.usdgDecimals));
    const rows = await Promise.all((onlyId ? [onlyId] : r.order()).map(async (id) => {
      const a = r.byId.get(id);
      if (!a) return { id, error: 'tidak dikenal' };
      if (!a.enabled()) return { id, label: a.label, skipped: a.blocker() };
      const t0 = Date.now();
      const q = await a.quote(inMint, outMint, amountIn).catch((e) => ({ error: e.message }));
      const ms = Date.now() - t0;
      if (!q || q.error) return { id, label: a.label, ms, error: q?.error || 'tidak ada rute' };
      const dex = [...new Set((q.routePlan || []).map((p) => p.swapInfo?.label).filter(Boolean))].join(' → ');
      return { id, label: a.label, ms, amountOut: Number(q.outAmount) / 10 ** 9, dex };
    }));
    const best = rows.filter((x) => x.amountOut > 0).sort((x, y) => y.amountOut - x.amountOut)[0];
    return { ok: true, usd, symbolIn: ch.usdgSymbol, symbolOut: ch.nativeSymbol, rows, best: best?.id || null };
  };

  const rpcView = () => {
    // The order of rpc.eps is always the same as cfg.chain.endpoints (built from the same
    // list), so they are matched by index — matching by URL is wrong if two endpoints
    // use the same URL with different headers.
    const all = rpc.stats();
    return (cfg.chain.endpoints || []).map((e, id) => {
      const st = all[id] && all[id].url === e.url ? all[id] : {};
      return {
        id, url: maskUrl(e.url), host: (() => { try { return new URL(e.url).hostname; } catch { return '?'; } })(),
        secret: hasSecret(e), headers: maskHeaders(e.headers),
        no_logs: !!e.no_logs, max_log_blocks: e.max_log_blocks || 0, archive: !!e.archive,
        // Solana endpoint flags (src/solana/rpc.js)
        no_gpa: !!e.no_gpa, no_history: !!e.no_history,
        max_batch: e.max_batch || 40, note: e.catatan || '',
        calls: st.calls || 0, errors: st.errors || 0, lastMs: st.lastMs || 0, cooling: !!st.cooling,
      };
    });
  };

  // A Telegram bot token = full control of that bot; it is never sent whole
  // to the browser, the same as the private key and RPC API keys.
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

  // A GMGN API key = OpenAPI access on behalf of that account; like the Telegram token, it is
  // never sent whole to the browser.
  const gmgnView = () => {
    const k = cfg.gmgn?.api_key || '';
    return { hasKey: !!k, fromEnv: envName(cfg, 'gmgn.api_key'), key: k ? `${String(k).slice(0, 6)}${MASK}` : '' };
  };

  const num = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} harus di antara ${lo} dan ${hi}`);
    return n;
  };

  // The same as GET /api/overview: cash + positions + leftovers + unclaimed fees. Used
  // in the drawdown breaker status card so its figure is consistent with the Summary.
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
      if (addr && SOL) {
        try {
          const b = await exec.balances();
          balances = {
            eth: Number(b.get('SOL') || 0n) / 1e9,
            usdg: (Number(b.get(ADDR.usdg) || 0n) + Number(b.get(ADDR.usdt) || 0n)) / 1e6,
            weth: Number(b.get(ADDR.weth) || 0n) / 1e9,
            symbols: { eth: 'SOL', usdg: 'USDC+USDT', weth: 'wSOL' },
          };
        } catch { balances = null; }
      } else if (addr) {
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
          venues: [...(SOL ? [] : ['v4']), ...chain.venues.map((v) => v.key)] },
        wallet: {
          address: addr, keyFile: SOL ? (cfg.wallet?.solana_key_file || sol.DEFAULT_FILE) : (cfg.wallet?.key_file || '~/.lpcopy/key'),
          hasKey: keyFromEnv() || fs.existsSync(p), perms, balances, backups,
          // A key from .env beats the key file; the replace/detach buttons do not apply.
          fromEnv: keyFromEnv() ? keyEnvName : null,
          kind: SOL ? 'solana' : 'evm',
        },
        mode: {
          dry_run: engine.dryRun(), paused: engine.paused(),
          // Simulation with a virtual balance (paper.js): the configured balance and how it is doing.
          sim: engine.paper ? { balance_usd: Number(cfg.mode?.sim_balance_usd) || 0, friction_pct: engine.paper.frictionPct(), status: engine.paper.status() } : null,
        },
        risk: {
          max_daily_drawdown_pct: cfg.risk?.max_daily_drawdown_pct ?? 0,
          status: { ...engine.drawdownStatus(), equityUsd: await equityNow() },
        },
        rpc: rpcView(),
        // The RPC answer cache that is already final — displayed under the endpoint list
        // so it is visible how many unnecessary calls were not sent at all.
        rpcCache: rpc.cacheStats ? rpc.cacheStats() : null,
        gas: SOL ? {
          // Solana: priority price (microLamports per CU) = 75th percentile of recent fees ×
          // multiplier, clamped to min/max; a SOL reserve for fees & account rent.
          price_multiplier: cfg.gas?.price_multiplier ?? 1.2,
          min_cu_price_micro: cfg.gas?.min_cu_price_micro ?? 10_000,
          max_cu_price_micro: cfg.gas?.max_cu_price_micro ?? 2_000_000,
          jupiter_max_priority_sol: (cfg.gas?.jupiter_max_priority_lamports ?? 2_000_000) / 1e9,
          reserve_sol: (cfg.gas?.native_reserve_lamports ?? 150_000_000) / 1e9,
          topup_max_usd: cfg.gas?.topup_max_usd ?? 25,
        } : {
          price_multiplier: cfg.gas?.price_multiplier ?? 1.5,
          priority_gwei: (cfg.gas?.priority_wei ?? 10_000_000) / 1e9,
          max_gas_limit: cfg.gas?.max_gas_limit ?? 4_000_000,
          max_fee_gwei: cfg.gas?.max_fee_gwei ?? 10,
          reserve_eth: (cfg.gas?.native_reserve_wei ?? 2e15) / 1e18,
        },
        chains: chainsView(),
        notify: { ntfy_topic: cfg.notify?.ntfy_topic || '', fromEnv: envName(cfg, 'notify.ntfy_topic') },
        authFromEnv: envName(cfg, 'server.auth_token'),
        telegram: tgView(),
        gmgn: gmgnView(),
        aggregators: aggView(),
        loop: {
          poll_ms: cfg.loop?.poll_ms ?? 1500, max_block_span: cfg.loop?.max_block_span ?? 1500,
          sync_seconds: cfg.loop?.sync_seconds ?? 30,
        },
        prices: { eth_usd: cfg.prices?.eth_usd ?? 2500, auto_eth_price: cfg.prices?.auto_eth_price !== false },
        display: {
          currency: currencyOf(cfg),
          hide_values: !!cfg.display?.hide_values,
          currencies: Object.entries(CURRENCIES).map(([code, name]) => ({ code, name })),
          fx: fx ? fx.view(currencyOf(cfg)) : null,
        },
      };
    },

    // ---- wallet ----
    'POST /api/settings/wallet/generate': async (req) => {
      const b = await readBody(req);
      const live = refuseIfLive(); if (live) return live;
      if (fs.existsSync(exec.keyPath()) && !b.replace) return { error: 'Sudah ada kunci. Centang "ganti kunci yang ada" untuk menggantinya (kunci lama dicadangkan).' };
      if (SOL) {
        // A Solana key has no recovery phrase: its file is its own backup
        // (base58 — importable into Phantom/Solflare).
        const kp = require('@solana/web3.js').Keypair.generate();
        return { ok: true, ...writeKey(require('bs58').default.encode(kp.secretKey)) };
      }
      const w = ethers.Wallet.createRandom();
      const res = writeKey(w.privateKey);
      // the recovery phrase is stored on the server beside the key, not sent to the browser
      fs.writeFileSync(exec.keyPath() + '.mnemonic', w.mnemonic.phrase, { mode: 0o600 });
      return { ok: true, ...res, mnemonicFile: path.basename(exec.keyPath()) + '.mnemonic' };
    },
    'POST /api/settings/wallet/import': async (req) => {
      const b = await readBody(req);
      const live = refuseIfLive(); if (live) return live;
      let pk = String(b.privateKey || '').trim();
      if (SOL) {
        let kp;
        try { kp = sol.parseSecret(pk); } catch (e) { return { error: `Kunci Solana tidak valid: ${e.message}` }; }
        if (!kp) return { error: 'Kunci Solana kosong.' };
        if (fs.existsSync(exec.keyPath()) && !b.replace) return { error: 'Sudah ada kunci. Centang "ganti kunci yang ada" untuk menggantinya (kunci lama dicadangkan).' };
        return { ok: true, ...writeKey(require('bs58').default.encode(kp.secretKey)) };
      }
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
      const typed = SOL ? String(b.confirm || '').trim() : String(b.confirm || '').toLowerCase();
      if (typed !== addr) return { error: 'Ketik alamat wallet persis untuk konfirmasi.' };
      const bak = backupKey(exec.keyPath());
      resetWallets();
      store.setState(walletStateKey, '');
      log(`kunci wallet dilepas (dicadangkan: ${bak ? path.basename(bak) : '-'})`);
      return { ok: true, backup: bak ? path.basename(bak) : null };
    },

    // Export the wallet as an encrypted V3 keystore (the same format as geth/MetaMask),
    // not the raw private key — even if the response is eavesdropped or stuck in a cache/log,
    // its contents are useless without the password typed right then (not stored).
    // Locked by the dashboard token retyped: an HttpOnly session cookie cannot be
    // read via XSS, so this is a real second layer, not a formality.
    'POST /api/settings/wallet/export': async (req) => {
      const b = await readBody(req);
      const bad = retypedToken(b, 'Setel token dashboard dulu di tab Keamanan sebelum bisa mengekspor wallet.'); if (bad) return bad;
      const addr = exec.address();
      if (!addr) return { error: 'Tidak ada wallet terpasang.' };
      const pass = String(b.password || '');
      if (pass.length < 8) return { error: 'Password keystore minimal 8 karakter.' };
      // Solana has no standard keystore format: see solana/wallet.js encryptKeystore — it can be
      // opened in the browser (WebCrypto) through "Open keystore (offline)" on this page.
      if (SOL) {
        let kp;
        try { kp = exec.loadWallet(); } catch (e) { return { error: e.message }; }
        log(`wallet ${addr} diekspor sebagai keystore terenkripsi`);
        return { ok: true, address: addr, keystore: sol.encryptKeystore(kp, pass) };
      }
      let w;
      try { w = exec.loadWallet(); } catch (e) { return { error: e.message }; }
      const keystore = await w.encrypt(pass);
      log(`wallet ${addr} diekspor sebagai keystore terenkripsi`);
      return { ok: true, address: addr, keystore: JSON.parse(keystore) };
    },

    // ---- backup & restore (see backup.js) ----
    'POST /api/settings/backup': async (req) => {
      const b = await readBody(req);
      const bad = retypedToken(b, 'Setel token dashboard dulu di tab Keamanan sebelum bisa membuat cadangan.'); if (bad) return bad;
      const parts = { config: !!b.parts?.config, db: !!b.parts?.db, wallet: !!b.parts?.wallet };
      if (!parts.config && !parts.db && !parts.wallet) return { error: 'Pilih minimal satu bagian untuk dicadangkan.' };
      let wallet = null, solanaKeypair = null;
      if (parts.wallet) {
        const ev = evmEngine(), se = solEngine();
        if (!ev?.exec.address() && !se?.exec.address()) return { error: 'Tidak ada wallet terpasang.' };
        if (String(b.password || '').length < 8) return { error: 'Password keystore minimal 8 karakter.' };
        try {
          if (ev?.exec.address()) wallet = ev.exec.loadWallet();
          if (se?.exec.address()) solanaKeypair = se.exec.loadWallet();
        } catch (e) { return { error: e.message }; }
      }
      const dbPath = cfg.db?.path;
      if (parts.db && !dbPath) return { error: 'Lokasi basis data tidak diketahui.' };
      try {
        const backup = await createBackup({
          parts, cfgPath, db: store.db, dbPath, wallet, solanaKeypair, password: String(b.password || ''),
          meta: {
            instance: path.basename(path.dirname(path.resolve(cfgPath))),
            chains: liveEngines().map((e) => e.chain?.network).filter(Boolean),
            address: evmEngine()?.exec.address() || null,
            solanaAddress: solEngine()?.exec.address() || null,
          },
        });
        log(`cadangan dibuat: ${Object.keys(backup.parts).join(', ')}${backup.parts.db ? ` (basis data ${(backup.parts.db.bytes / 1e6).toFixed(1)} MB)` : ''}`);
        return { ok: true, backup };
      } catch (e) { return { error: `Gagal membuat cadangan: ${e.message}` }; }
    },
    // Restore: the wallet is installed right away; config & database are put aside as a
    // pending file then the bot is restarted (via the orderly-stop path) so they are swapped at
    // boot. Simulation mode is required — the old database does not know about positions opened after it.
    'POST /api/settings/restore': async (req) => {
      let b;
      try { b = await readBackupBody(req); } catch (e) { return { error: e.message }; }
      const bad = retypedToken(b, 'Setel token dashboard dulu di tab Keamanan sebelum bisa memulihkan cadangan.'); if (bad) return bad;
      let backup;
      try { backup = parseBackup(b.backup); } catch (e) { return { error: e.message }; }
      const parts = { config: !!b.parts?.config, db: !!b.parts?.db, wallet: !!b.parts?.wallet };
      const inFile = (k) => (k === 'wallet' ? !!(backup.parts.wallet || backup.parts.solanaWallet) : !!backup.parts[k]);
      for (const k of Object.keys(parts)) if (parts[k] && !inFile(k)) return { error: `Berkas cadangan tidak berisi bagian ${k}.` };
      if (!parts.config && !parts.db && !parts.wallet) return { error: 'Pilih minimal satu bagian untuk dipulihkan.' };
      if (liveEngines().some((e) => !e.dryRun())) return { error: 'Matikan mode LIVE dulu sebelum memulihkan cadangan.' };
      const busy = busyNow(); if (busy) return busy;
      const dbPath = cfg.db?.path;
      if (parts.db && !dbPath) return { error: 'Lokasi basis data tidak diketahui.' };

      // Wallet first: the only part that can fail because of input (a wrong password),
      // and its failure must not leave a half-finished pending config/db.
      let walletRes = null, solanaRes = null;
      if (parts.wallet) {
        const live = refuseIfLive(); if (live) return live;
        // Both keys are decrypted before either is written: a wrong password changes nothing.
        let w = null, kp = null;
        if (backup.parts.wallet) {
          try { w = await ethers.Wallet.fromEncryptedJson(JSON.stringify(backup.parts.wallet.keystore), String(b.password || '')); }
          catch { return { error: 'Password keystore salah, atau keystore di berkas cadangan rusak.' }; }
        }
        if (backup.parts.solanaWallet) {
          const solW = require('./solana/wallet');
          try { kp = solW.decryptKeystore(backup.parts.solanaWallet.keystore, String(b.password || '')); }
          catch { return { error: 'Password keystore salah, atau keystore Solana di berkas cadangan rusak.' }; }
        }
        const putKey = (p, content) => {
          fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
          const bak = backupKey(p);
          fs.writeFileSync(p, content, { mode: 0o600 });
          fs.chmodSync(p, 0o600);
          return bak ? path.basename(bak) : null;
        };
        if (w && !privateKeyFromEnv()) {
          const ev = evmEngine();
          const cur = ev?.exec.address() || null;
          const p = ev ? ev.exec.keyPath() : String(cfg.wallet?.key_file || '~/.lpcopy/key').replace(/^~/, os.homedir());
          walletRes = w.address.toLowerCase() === cur ? { address: cur, unchanged: true } : { address: w.address.toLowerCase(), backup: putKey(p, w.privateKey) };
        }
        if (kp && !require('./solana/wallet').solanaKeyFromEnv()) {
          const se = solEngine();
          const addr = kp.publicKey.toBase58();
          const cur = se?.exec.address() || null;
          const p = se ? se.exec.keyPath() : require('./solana/wallet').keyFileOf(cfg);
          solanaRes = addr === cur ? { address: cur, unchanged: true } : { address: addr, backup: putKey(p, (require('bs58').default || require('bs58')).encode(kp.secretKey)) };
        }
        resetWallets();
        for (const e of liveEngines()) { const a = e.exec.address(); if (a) store.setState(e.chain?.kind === 'solana' ? `wallet_address:${e.chain.network}` : 'wallet_address', a); }
      }
      let staged = [];
      try { staged = await stageRestore({ backup, parts, cfgPath, dbPath }); }
      catch (e) { return { error: e.message, wallet: walletRes }; }
      log(`pemulihan dari cadangan ${backup.createdAt}: ${[...(walletRes ? ['wallet'] : []), ...(solanaRes ? ['wallet Solana'] : []), ...staged].join(', ')}${staged.length ? ' — bot dinyalakan ulang' : ''}`);
      if (staged.length) setTimeout(restart, 1500).unref?.();
      return { ok: true, wallet: walletRes, solanaWallet: solanaRes, staged, restarting: staged.length > 0 };
    },

    // ---- swap aggregators ----
    // { mode?, order?, id?, enabled?, keys?: { field: value } } — value '' clears the field.
    'POST /api/settings/aggregators': async (req) => {
      const b = await readBody(req);
      const r = router();
      if (!r?.byId) return { error: 'Router swap belum siap.' };
      const agg = cfg.aggregators = { ...(cfg.aggregators || {}) };
      if (b.mode != null) {
        if (!['best', 'order'].includes(b.mode)) return { error: 'Mode agregator harus best atau order.' };
        agg.mode = b.mode;
      }
      if (b.order != null) {
        if (!Array.isArray(b.order) || b.order.some((id) => !r.byId.has(id)) || new Set(b.order).size !== b.order.length) return { error: 'Urutan agregator tidak valid.' };
        agg.order = [...b.order];
      }
      if (b.id != null) {
        if (!r.byId.has(b.id)) return { error: 'Agregator tidak dikenal.' };
        const cur = { ...(agg[b.id] || {}) };
        if (b.enabled != null) cur.enabled = !!b.enabled;
        for (const [f, v] of Object.entries(b.keys || {})) {
          if (!(AGG_FIELDS[b.id] || []).includes(f)) return { error: `Kolom ${f} tidak dikenal untuk ${b.id}.` };
          const locked = lockedByEnv(`aggregators.${b.id}.${f}`); if (locked) return locked;
          const val = String(v ?? '').trim();
          if (val.length > 512) return { error: 'Nilai terlalu panjang.' };
          if (val) cur[f] = val; else delete cur[f];
        }
        agg[b.id] = cur;
      }
      saveCfg();
      resetAggregators();
      log(`agregator swap diubah${b.id ? `: ${b.id}` : ''}${b.mode ? ` · mode ${b.mode}` : ''}`);
      return { ok: true, aggregators: aggView() };
    },
    // Live comparison: every aggregator quotes the same sale (10 USDG → native coin by
    // default) — the numbers the best-route mode would compare. Inactive ones say why.
    'POST /api/settings/aggregators/test': async (req) => {
      const b = await readBody(req);
      const r = router();
      if (!r?.byId) return { error: 'Router swap belum siap.' };
      const usd = Math.min(1000, Math.max(1, Number(b.usd) || 10));
      if (chain.kind === 'solana') return solanaAggregatorTest(r, chain, usd, b.id);
      const amountIn = BigInt(Math.round(usd * 10 ** chain.usdgDecimals));
      const ids = b.id ? [b.id] : r.order();
      resetAggregators();
      const rows = await Promise.all(ids.map(async (id) => {
        const a = r.byId.get(id);
        if (!a) return { id, error: 'tidak dikenal' };
        if (!a.enabled()) return { id, label: a.label, skipped: a.blocker() };
        const t0 = Date.now();
        const q = await a.quote(chain.ADDR.usdg, chain.ADDR.native, amountIn).catch((e) => ({ error: e.message }));
        const ms = Date.now() - t0;
        if (!q || q.error) return { id, label: a.label, ms, error: q?.error || 'tidak ada rute / API menolak (lihat log)' };
        return { id, label: a.label, ms, amountOut: Number(q.amountOut) / 1e18, dex: q.dex, usdOut: q.usdOut ?? null };
      }));
      const best = rows.filter((x) => x.amountOut > 0).sort((x, y) => y.amountOut - x.amountOut)[0];
      return { ok: true, usd, symbolIn: chain.usdgSymbol, symbolOut: chain.nativeSymbol, rows, best: best?.id || null };
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
      engine.paper?.settle();     // LIVE on: the simulated positions are set aside, not mixed with real ones
      log(`mode diubah ke ${b.live ? 'LIVE' : 'SIMULASI'} dari halaman Pengaturan`);
      return { ok: true, dry_run: cfg.mode.dry_run };
    },

    // ---- simulation balance (paper trading) ----
    // balance_usd > 0 turns the simulation into a paper-trading book: open follows open, close
    // follows close, with a virtual cash balance and profit. 0 = the plain simulation (decisions
    // are only recorded). `reset` starts the book over from the balance.
    'POST /api/settings/sim': async (req) => {
      const b = await readBody(req);
      let balance, friction;
      try {
        balance = b.balance_usd == null ? (Number(cfg.mode?.sim_balance_usd) || 0) : num(b.balance_usd, 0, 100_000_000, 'Saldo simulasi');
        friction = b.friction_pct == null ? null : num(b.friction_pct, 0, 10, 'Biaya simulasi');
      } catch (e) { return { error: e.message }; }
      cfg.mode = cfg.mode || {};
      cfg.mode.sim_balance_usd = balance;
      if (friction != null) cfg.mode.sim_friction_pct = friction;
      saveCfg();
      if (!engine.paper) return { error: 'engine ini belum mendukung simulasi dengan saldo' };
      let retired = 0;
      if (b.reset) retired = engine.paper.reset();
      else if (engine.paper.on()) engine.paper.ensureSince();
      retired += engine.paper.settle();
      log(`saldo simulasi diatur ke $${balance}${b.reset ? ' (diulang dari awal)' : ''} dari halaman Pengaturan`);
      return { ok: true, balance_usd: balance, retired, status: engine.paper.status() };
    },

    // ---- risk ----
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
      if (b.id != null && !url) {                     // test an already-stored endpoint
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
        // An unchanged endpoint (only the id sent, without url) does not need re-checking.
        if (e.url) { try { await assertSafeRpcUrl(url); } catch (err) { return { error: `URL ditolak: ${err.message}` }; } }
        let headers = base?.headers || null;
        if (e.headers === null) headers = null;                       // removed
        else if (e.headers && typeof e.headers === 'object') headers = Object.keys(e.headers).length ? e.headers : null;
        const out = { url, max_batch: num(e.max_batch ?? base?.max_batch ?? 40, 1, 200, 'max_batch') };
        if (headers) out.headers = headers;
        if (e.no_logs) out.no_logs = true;
        if (Number(e.max_log_blocks) > 0) out.max_log_blocks = num(e.max_log_blocks, 1, 100_000_000, 'max_log_blocks');
        if (e.archive) out.archive = true;
        // Solana flags: sent by the dashboard after a test, otherwise kept from the stored endpoint.
        for (const f of ['no_gpa', 'no_history', 'no_send', 'no_indexed']) {
          const v = e[f] ?? base?.[f];
          if (v) out[f] = true;
        }
        if (base?.catatan && !e.url) out.catatan = base.catatan;
        next.push(out);
      }
      // Wallet research needs getLogs over a large range. On a chain whose public endpoints
      // all limit the range (BSC), this is a warning — scanning still runs in
      // chunks, only slower.
      const warning = chain.kind === 'solana' || next.some((e) => !e.no_logs && !e.max_log_blocks) ? null
        : 'Tidak ada endpoint yang sanggup getLogs rentang besar (tanpa batas blok) — riset wallet akan berjalan per potongan dan lebih lambat.';
      cfg.chain.endpoints = next;
      saveCfg();
      rpc.reconfigure(next);
      log(`daftar RPC ${chain.label} diperbarui (${next.length} endpoint)`);
      return { ok: true, rpc: rpcView(), warning };
    },

    // ---- gas / notifications / engine ----
    'POST /api/settings/gas': async (req) => {
      const b = await readBody(req);
      try {
        if (SOL) {
          const lo = Math.round(num(b.min_cu_price_micro, 0, 50_000_000, 'Harga prioritas minimum'));
          const hi = Math.round(num(b.max_cu_price_micro, 1, 50_000_000, 'Harga prioritas maksimum'));
          if (hi < lo) throw new Error('Harga prioritas maksimum harus ≥ minimum');
          cfg.gas = {
            ...(cfg.gas || {}),
            price_multiplier: num(b.price_multiplier, 0.5, 10, 'Pengali harga prioritas'),
            min_cu_price_micro: lo, max_cu_price_micro: hi,
            jupiter_max_priority_lamports: Math.round(num(b.jupiter_max_priority_sol, 0, 0.1, 'Batas prioritas Jupiter') * 1e9),
            native_reserve_lamports: Math.round(num(b.reserve_sol, 0.01, 100, 'Cadangan SOL') * 1e9),
            topup_max_usd: num(b.topup_max_usd, 0, 1000, 'Isi ulang SOL maksimum'),
          };
          saveCfg();
          return { ok: true };
        }
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
    // ---- display: secondary currency ----
    // Only an annotation on the dashboard. The engine, budget limits, and all calculations stay
    // in dollars — changing the choice here touches not a single bot decision.
    // Partial: only the fields sent are changed — the redaction switch must not
    // erase the currency choice, and vice versa.
    'POST /api/settings/display': async (req) => {
      const b = await readBody(req);
      if ('hide_values' in b) {
        cfg.display = { ...(cfg.display || {}), hide_values: !!b.hide_values };
        if (!('currency' in b)) { saveCfg(); return { ok: true, hide_values: cfg.display.hide_values }; }
      }
      const code = String(b.currency || '').trim().toUpperCase();
      if (code && !CURRENCIES[code]) return { error: 'Mata uang itu tidak ada di daftar.' };
      cfg.display = { ...(cfg.display || {}), currency: code || null };
      saveCfg();
      // The rate is pulled now if it does not exist yet, so the figure is visible right away on
      // this page — not only appearing a few seconds later.
      if (code && fx) await fx.refresh().catch(() => {});
      return { ok: true, fx: code && fx ? fx.view(code) : null };
    },
    'POST /api/settings/display/refresh': async () => {
      if (!fx) return { error: 'Kurs belum tersedia.' };
      await fx.refresh(true).catch(() => {});
      const v = fx.view(currencyOf(cfg));
      if (!v) return { error: 'Pilih mata uang dulu.' };
      return v.rate ? { ok: true, fx: v } : { error: fx.error || 'Kurs gagal diambil.' };
    },

    // ---- GMGN OpenAPI ----
    'POST /api/settings/gmgn': async (req) => {
      const b = await readBody(req);
      const locked = lockedByEnv('gmgn.api_key'); if (locked) return locked;
      const v = String(b.api_key || '').trim();
      if (v && !/^[A-Za-z0-9_\-.:]{8,256}$/.test(v)) return { error: 'API key GMGN tidak dikenali bentuknya.' };
      cfg.gmgn = { ...(cfg.gmgn || {}), api_key: v || null };
      saveCfg();
      return { ok: true, gmgn: gmgnView() };
    },
    // Test the key: ask for 1-hour candles of this chain's native token. Success = the key is accepted and
    // this chain is supported; an error is returned as it is so the cause is clear.
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
    'GET /api/settings/chains': async () => ({ chains: chainsView() }),
    // Switch a chain on or off. With a chainControl (the running bot) it takes effect right away:
    // switching on builds the engine and warms it up in the background, switching off waits for
    // in-flight work. Without one (tests, CLI) it is saved and applies on the next start.
    'POST /api/settings/chains': async (req) => {
      const b = await readBody(req);
      const key = String(b.key || '');
      if (!NETWORKS[key]) return { error: 'Chain tidak dikenal' };
      const want = !!b.enabled;
      const was = cfg.chains[key]?.enabled !== false && !!cfg.chains[key];
      if (want) {
        if (!cfg.chains[key]) cfg.chains[key] = chainTemplate(key) || {};
        if (!(cfg.chains[key].chain?.endpoints || []).length) return { error: `${build(key).label}: belum ada endpoint RPC` };
      } else if (cfg.chains[key]) {
        if (enabledChains(cfg).filter((k) => k !== key).length === 0) return { error: 'Minimal satu chain harus tetap aktif' };
      }
      if (!want && chainControl) {
        const r = await chainControl.stop(key);
        if (r.error) return r;
      }
      if (cfg.chains[key]) cfg.chains[key].enabled = want;
      saveCfg();
      if (want && chainControl) {
        const r = await chainControl.start(key);
        if (r.error) { cfg.chains[key].enabled = was; saveCfg(); return r; }
      }
      log(`chain ${key}: ${want ? 'dinyalakan' : 'dimatikan'} dari Pengaturan${chainControl ? '' : ' (berlaku setelah restart)'}`);
      return { ok: true, restartNeeded: !chainControl, chains: chainsView() };
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
        cfg.prices = { ...(cfg.prices || {}), eth_usd: num(b.eth_usd, 0.0001, 1_000_000, 'Harga ETH cadangan'), auto_eth_price: !!b.auto_eth_price };
      } catch (e) { return { error: e.message }; }
      saveCfg();
      return { ok: true, restartNeeded: true };
    },

    // ---- Telegram bot ----
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
      // A new token is used right away — without a process restart, the same as the RPC list.
      // Without this the bot stays silent after the token is saved and there is no hint why.
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

    // ---- access token ----
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

module.exports = { createSettingsRoutes, maskUrl, probeRpc, hasSecret };
