'use strict';
// API HTTP + penyaji dashboard.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { rulesFor, DEFAULTS } = require('./policy');
const { scoutWallet } = require('./scout');
const { WalletResearch, summarize } = require('./wallet');
const { createSettingsRoutes } = require('./settings');
const { QUOTES } = require('./chain');

// Sisi mana dari pool yang merupakan aset kuotasi (0 atau 1); null kalau tidak dikenal.
// Menentukan arah harga yang ditampilkan: selalu "harga token spekulatif dalam kuotasi".
const quoteSideOf = (t0, t1) => (QUOTES[(t0 || '').toLowerCase()] ? 0 : QUOTES[(t1 || '').toLowerCase()] ? 1 : null);

const crypto = require('node:crypto');

const LOGIN_PAGE = (err) => `<!doctype html><html lang="id" data-bs-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lpcopy — masuk</title><link rel="stylesheet" href="/vendor/tabler.min.css"></head>
<body class="d-flex align-items-center py-4" style="min-height:100vh">
<div class="container container-tight py-4">
  <div class="card card-md"><div class="card-body">
    <h2 class="h2 text-center mb-1"><span class="text-primary">lp</span>copy</h2>
    <p class="text-secondary text-center mb-4">Dasbor ini bisa memindahkan dana. Masukkan token akses.</p>
    ${err ? '<div class="alert alert-danger">Token salah.</div>' : ''}
    <form method="POST" action="/login">
      <div class="mb-3"><input type="password" name="token" class="form-control" placeholder="token akses" autofocus autocomplete="current-password"></div>
      <button type="submit" class="btn btn-primary w-100">Masuk</button>
    </form>
  </div></div>
</div></body></html>`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };

function createServer({ engine, store, cfg, cfgPath, chain, rpc, log }) {
  const pub = path.join(__dirname, '..', 'public');
  const scoutJobs = new Map();
  const walletJobs = new Map();
  const research = new WalletResearch({ rpc, store, chain, log });

  // Gerbang token. Dasbor ini bisa menyalakan mode LIVE dan menutup posisi, jadi ia
  // tidak boleh terbuka begitu saja begitu diekspos ke internet. Token disimpan di
  // config; kalau kosong, gerbangnya mati (aman untuk 127.0.0.1 saja).
  const tokenNow = () => cfg.server?.auth_token || null;
  const authed = (req) => {
    const TOKEN = tokenNow();
    if (!TOKEN) return true;
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ') && safeEq(h.slice(7), TOKEN)) return true;
    const ck = (req.headers.cookie || '').split(';').map((x) => x.trim());
    const c = ck.find((x) => x.startsWith('lpcopy_token='));
    return !!c && safeEq(decodeURIComponent(c.slice(13)), TOKEN);
  };
  const safeEq = (a, b) => {
    const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };

  const json = (res, code, body) => {
    const s = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (res.__setCookie) h['set-cookie'] = res.__setCookie;
    res.writeHead(code, h);
    res.end(s);
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
  const saveCfg = () => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const routes = {
    'GET /api/overview': () => {
      const s = engine.positions.summary(engine.ethUsd);
      const eq = store.all('SELECT ts,total_quote,realized_quote,fees_quote,open_positions FROM equity ORDER BY ts DESC LIMIT 500').reverse();
      const dec = store.get("SELECT COUNT(*) n FROM decisions WHERE verdict IN ('copy','dry')")?.n || 0;
      const tot = {
        actions: store.get('SELECT COUNT(*) n FROM actions')?.n || 0,
        copied: store.get("SELECT COUNT(*) n FROM decisions WHERE verdict='copy'")?.n || 0,
        would: dec,
        skipped: store.get("SELECT COUNT(*) n FROM decisions WHERE verdict='skip'")?.n || 0,
        errors: store.get("SELECT COUNT(*) n FROM decisions WHERE verdict='error'")?.n || 0,
      };
      const skipTop = store.all("SELECT reason, COUNT(*) n FROM decisions WHERE verdict='skip' GROUP BY reason ORDER BY n DESC LIMIT 6");
      return {
        mode: { dry_run: engine.dryRun(), paused: engine.paused(), wallet: engine.exec.address() },
        chain: { head: engine.head, cursor: engine.cursor, lag: engine.head - engine.cursor, ethUsd: engine.ethUsd, headSpread: engine.headSpread },
        stats: { ...engine.stats, uptimeSec: Math.round((Date.now() - engine.stats.startedAt) / 1000), lastError: engine.lastError },
        totals: tot,
        summary: s, equity: eq, decisionsTotal: dec, skipReasons: skipTop,
        rpc: rpc.stats(),
        unsupportedSenders: [...engine.watcher.unsupported.entries()].map(([a, n]) => ({ address: a, n })),
        lastSync: engine.positions.lastSync,
      };
    },
    'GET /api/positions': () => ({ positions: engine.positions.live, closed: store.all("SELECT * FROM positions WHERE status='closed' ORDER BY closed_ts DESC LIMIT 100") }),
    'GET /api/targets': () => {
      const rows = store.all('SELECT * FROM targets ORDER BY added_ts');
      for (const r of rows) {
        r.rulesResolved = rulesFor(cfg.rules, r.rules);
        r.rulesOwn = r.rules ? JSON.parse(r.rules) : null;
        const st = store.get('SELECT COUNT(*) n, MAX(ts) last FROM actions WHERE target=?', r.address);
        r.actions = st?.n || 0; r.lastActionTs = st?.last || null;
        r.copied = store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.target=? AND d.verdict IN ('copy','dry')", r.address)?.n || 0;
        const p = store.get("SELECT COUNT(*) n, COALESCE(SUM(cost_quote),0) cost FROM positions WHERE target=? AND status='open'", r.address);
        r.openPositions = p?.n || 0; r.openCostQuote = p?.cost || 0;
        // Ringkasan riset wallet yang sudah tersimpan (dari halaman Wallet) — tanpa memanggil chain.
        const w = store.get('SELECT stats, last_scan_ts, positions_n FROM wallets WHERE address=?', r.address);
        if (w) { try { r.research = { ...JSON.parse(w.stats || '{}'), lastScanTs: w.last_scan_ts, positionsN: w.positions_n }; } catch { r.research = null; } }
      }
      return { targets: rows, defaults: DEFAULTS, globalRules: rulesFor(cfg.rules) };
    },
    'POST /api/targets': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase().trim();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      store.run('INSERT OR IGNORE INTO targets(address,label,enabled,added_ts,rules,notes) VALUES(?,?,?,?,?,?)',
        addr, b.label || null, b.enabled === false ? 0 : 1, Date.now(), b.rules ? JSON.stringify(b.rules) : null, b.notes || null);
      return { ok: true };
    },
    'POST /api/targets/toggle': async (req) => {
      const b = await readBody(req);
      store.run('UPDATE targets SET enabled=? WHERE address=?', b.enabled ? 1 : 0, String(b.address).toLowerCase());
      return { ok: true };
    },
    'POST /api/targets/rules': async (req) => {
      const b = await readBody(req);
      store.run('UPDATE targets SET rules=?, label=COALESCE(?,label) WHERE address=?',
        b.rules ? JSON.stringify(b.rules) : null, b.label ?? null, String(b.address).toLowerCase());
      return { ok: true };
    },
    'POST /api/targets/label': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase();
      const label = String(b.label ?? '').trim().slice(0, 60) || null;
      const r = store.run('UPDATE targets SET label=? WHERE address=?', label, addr);
      if (!r.changes) return { error: 'target tidak ditemukan' };
      return { ok: true, label };
    },
    'POST /api/targets/delete': async (req) => {
      const b = await readBody(req);
      store.run('DELETE FROM targets WHERE address=?', String(b.address).toLowerCase());
      return { ok: true };
    },
    'GET /api/activity': (req, url) => {
      const limit = Math.min(300, Number(url.searchParams.get('limit') || 120));
      const rows = store.all(`
        SELECT a.*, d.verdict, d.reason, d.tx_hash AS decision_tx, d.plan
        FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
        ORDER BY a.ts DESC, a.id DESC LIMIT ?`, limit);
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      const labels = new Map(store.all('SELECT address,label FROM targets').map((t) => [t.address, t.label]));
      for (const r of rows) {
        r.targetLabel = labels.get(r.target) || null;
        r.symbol0 = toks.get(r.token0)?.symbol || null;
        r.symbol1 = toks.get(r.token1)?.symbol || null;
        r.dec0 = toks.get(r.token0)?.decimals ?? 18;
        r.dec1 = toks.get(r.token1)?.decimals ?? 18;
        r.quoteSide = quoteSideOf(r.token0, r.token1);
      }
      return { activity: rows };
    },
    'GET /api/rules': () => ({ rules: rulesFor(cfg.rules), defaults: DEFAULTS, raw: cfg.rules || {} }),
    'POST /api/rules': async (req) => {
      const b = await readBody(req);
      cfg.rules = b.rules || {};
      saveCfg();
      return { ok: true, rules: rulesFor(cfg.rules) };
    },
    'POST /api/mode': async (req) => {
      const b = await readBody(req);
      if (typeof b.dry_run === 'boolean') { cfg.mode = cfg.mode || {}; cfg.mode.dry_run = b.dry_run; saveCfg(); }
      if (typeof b.paused === 'boolean') store.setState('paused', b.paused ? '1' : '0');
      return { ok: true, mode: { dry_run: engine.dryRun(), paused: engine.paused() } };
    },
    'GET /api/logs': () => ({ logs: store.all('SELECT * FROM logs ORDER BY ts DESC LIMIT 200') }),
    'GET /api/txs': () => ({ txs: store.all('SELECT * FROM txs ORDER BY ts DESC LIMIT 100') }),
    'POST /api/scout': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      if (scoutJobs.get(addr)?.status === 'jalan') return { ok: true, status: 'jalan' };
      const job = { status: 'jalan', progress: 0, startedAt: Date.now(), result: null, error: null };
      scoutJobs.set(addr, job);
      const blocks = Number(b.blocks || cfg.scout?.blocks || 900_000);
      scoutWallet(rpc, chain, addr, {
        blocks, ethUsd: engine.ethUsd,
        onProgress: (p) => { job.progress = Math.round((p.scanned / p.total) * 100); },
      }).then((r) => { job.result = r; job.status = 'selesai'; })
        .catch((e) => { job.error = e.message; job.status = 'gagal'; });
      return { ok: true, status: 'jalan' };
    },
    'GET /api/scout': (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      const j = scoutJobs.get(addr);
      if (!j) return { status: 'kosong' };
      return { status: j.status, progress: j.progress, error: j.error, result: j.result };
    },
    // ---- riset wallet ----
    'POST /api/wallet/scan': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase().trim();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      if (walletJobs.get(addr)?.status === 'jalan') return { ok: true, status: 'jalan' };
      const job = { status: 'jalan', phase: 'mulai', progress: 0, done: 0, total: 0, startedAt: Date.now(), error: null };
      walletJobs.set(addr, job);
      const blocks = Number(b.blocks || 900_000);
      research.scan(addr, {
        blocks, ethUsd: engine.ethUsd,
        onProgress: (p) => {
          job.phase = p.phase; job.done = p.scanned; job.total = p.total;
          job.progress = p.total ? Math.round((p.scanned / p.total) * 100) : 0;
        },
      }).then(() => { job.status = 'selesai'; job.finishedAt = Date.now(); })
        .catch((e) => { job.error = e.message; job.status = 'gagal'; log(`riset wallet ${addr}: ${e.message}`); });
      return { ok: true, status: 'jalan' };
    },

    'GET /api/wallet': async (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      const job = walletJobs.get(addr);
      const w = store.get('SELECT * FROM wallets WHERE address=?', addr);
      const jobOut = job ? {
        status: job.status, phase: job.phase, progress: job.progress, done: job.done, total: job.total,
        startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error,
      } : null;
      if (!w) return { found: false, job: jobOut };

      const rows = store.all('SELECT * FROM wpositions WHERE wallet=? ORDER BY COALESCE(closed_ts, opened_ts) DESC', addr);
      // Harga pool saat posisi dibuka dan saat ditutup — sudah tersimpan per kejadian
      // waktu pemindaian (dibaca dari node arsip), jadi tidak perlu panggil chain lagi.
      const ev = store.all('SELECT token_id, block, sqrt_price FROM wevents WHERE wallet=? ORDER BY token_id, block', addr);
      const firstLast = new Map();
      for (const e of ev) {
        if (!e.sqrt_price) continue;
        const cur = firstLast.get(e.token_id);
        if (!cur) firstLast.set(e.token_id, { entry: e.sqrt_price, exit: e.sqrt_price });
        else cur.exit = e.sqrt_price;
      }
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      const hours = (a, b) => (a && b ? (b - a) / 3600000 : null);
      const deco = (r) => ({
        ...r,
        symbol0: toks.get(r.token0)?.symbol || '?',
        symbol1: toks.get(r.token1)?.symbol || '?',
        // Desimal diperlukan tampilan untuk mengubah tick menjadi harga sebenarnya.
        dec0: toks.get(r.token0)?.decimals ?? 18,
        dec1: toks.get(r.token1)?.decimals ?? 18,
        quoteSide: quoteSideOf(r.token0, r.token1),
        entrySqrt: firstLast.get(r.token_id)?.entry || null,
        exitSqrt: r.status === 'closed' ? (firstLast.get(r.token_id)?.exit || null) : null,
        ageHours: hours(r.opened_ts, r.closed_ts || Date.now()),
        // DPR = laba harian sebagai persen modal, cara LP Agent membandingkan posisi
        // dengan umur yang sangat berbeda.
        dprPct: (r.invested_q > 0 && hours(r.opened_ts, r.closed_ts || Date.now()) > 0)
          ? (r.pnl_q / r.invested_q) * (24 / hours(r.opened_ts, r.closed_ts || Date.now())) * 100 : null,
        pnlPct: r.invested_q > 0 ? (r.pnl_q / r.invested_q) * 100 : null,
        // Posisi terbuka: fee yang relevan adalah yang BELUM diklaim; posisi tertutup:
        // fee yang sudah benar-benar ditarik.
        feeShown: r.status === 'open' ? (r.live_fee_q || 0) : (r.fees_q || 0),
        feePct: r.invested_q > 0
          ? ((r.status === 'open' ? (r.live_fee_q || 0) : (r.fees_q || 0)) / r.invested_q) * 100 : null,
      });
      const open = rows.filter((r) => r.status === 'open').map(deco);
      const closed = rows.filter((r) => r.status === 'closed').map(deco);

      // Tick harga sekarang untuk posisi yang masih berjalan — satu batch, hanya
      // untuk pool yang unik, supaya tampilan bisa menunjukkan posisi harga di rentang.
      const poolIds = [...new Set(open.map((r) => r.pool_ref).filter(Boolean))];
      if (poolIds.length) {
        try {
          const slots = await chain.slot0V4Many(poolIds);
          const byPool = new Map(poolIds.map((id, i) => [id, slots[i]]));
          for (const r of open) r.curTick = byPool.get(r.pool_ref)?.tick ?? null;
        } catch { /* harga kini tidak terbaca: bar tetap tampil tanpa penanda */ }
      }

      // profit harian untuk kalender
      const daily = {};
      for (const r of closed) {
        if (!r.closed_ts) continue;
        const d = new Date(r.closed_ts).toISOString().slice(0, 10);
        daily[d] = (daily[d] || 0) + (r.pnl_q || 0);
      }
      let stats = {};
      try { stats = JSON.parse(w.stats || '{}'); } catch { stats = {}; }
      return {
        found: true, address: addr, label: w.label,
        scannedFrom: w.first_block, scannedTo: w.scanned_to, lastScanTs: w.last_scan_ts,
        stats, open, closed, daily,
        isTarget: !!store.get('SELECT 1 FROM targets WHERE address=?', addr),
        job: jobOut,
      };
    },

    'GET /api/wallet/events': (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      const id = String(url.searchParams.get('token_id') || '');
      return { events: store.all('SELECT * FROM wevents WHERE wallet=? AND token_id=? ORDER BY block', addr, id) };
    },

    'GET /api/wallets': () => ({
      wallets: store.all('SELECT address,label,scanned_to,last_scan_ts,positions_n,stats FROM wallets ORDER BY last_scan_ts DESC LIMIT 50')
        .map((w) => { try { return { ...w, stats: JSON.parse(w.stats || '{}') }; } catch { return { ...w, stats: {} }; } }),
    }),

    'POST /api/positions/close': async (req) => {
      const b = await readBody(req);
      const pos = store.get("SELECT * FROM positions WHERE id=? AND status='open'", Number(b.id));
      if (!pos) return { error: 'posisi tidak ditemukan' };
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        const r = await engine.executeExit({ venue: pos.venue, action: 'burn', full: true, liquidity: pos.liquidity, tokenId: pos.token_id }, pos);
        return { ok: true, tx: r.txHash };
      } catch (e) { return { error: e.message }; }
    },
  };

  Object.assign(routes, createSettingsRoutes({ engine, store, cfg, cfgPath, rpc, log, readBody }));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;

    // ---- gerbang token ----
    const TOKEN = tokenNow();
    if (TOKEN) {
      if (url.pathname === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        return req.on('end', () => {
          const tok = decodeURIComponent((body.split('token=')[1] || '').split('&')[0].replace(/\+/g, ' '));
          if (safeEq(tok, TOKEN)) {
            res.writeHead(302, {
              location: '/',
              'set-cookie': `lpcopy_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            });
            return res.end();
          }
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(LOGIN_PAGE(true));
        });
      }
      // Aset vendor boleh lewat supaya halaman login bisa tampil rapi.
      const isVendor = url.pathname.startsWith('/vendor/');
      if (!isVendor && !authed(req)) {
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"tidak berwenang"}');
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' });
        return res.end(LOGIN_PAGE(false));
      }
    }
    if (routes[key]) {
      try { return json(res, 200, await routes[key](req, url, res)); }
      catch (e) { log(`api ${key}: ${e.message}`); return json(res, 500, { error: e.message }); }
    }
    if (req.method !== 'GET') return json(res, 404, { error: 'tidak ada' });

    // Tampilan: hasil build React (web/dist) kalau ada; kalau belum dibuild, pakai
    // tampilan lama di public/. /vendor/* selalu dari public/ (dipakai halaman masuk).
    const dist = path.join(__dirname, '..', 'web', 'dist');
    const useDist = fs.existsSync(path.join(dist, 'index.html'));
    const isVendor = url.pathname.startsWith('/vendor/');
    const root = isVendor || !useDist ? pub : dist;
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    let file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(404); return res.end('tidak ada'); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // aplikasi satu halaman: rute tanpa ekstensi dijawab index.html
      if (useDist && !path.extname(p)) file = path.join(dist, 'index.html');
      else { res.writeHead(404); return res.end('tidak ada'); }
    }
    // Cache: Cloudflare menyimpan .js/.css sendiri kalau origin tidak melarang.
    //  - index.html: jangan pernah di-cache (ia yang menunjuk ke berkas versi terbaru)
    //  - /assets/* hasil Vite: nama mengandung hash isi -> aman di-cache selamanya
    //  - vendor & font: tidak pernah berubah
    const immutable = isVendor || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/');
    const headers = {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // private: browser boleh menyimpan, CDN (Cloudflare) tidak — berkas ini ada di balik gerbang token.
      'cache-control': immutable ? `${isVendor ? 'public' : 'private'}, max-age=31536000, immutable` : 'private, no-store, max-age=0',
    };
    if (!useDist && path.extname(file) === '.html') {
      const ver = Math.floor(fs.statSync(path.join(pub, 'app.js')).mtimeMs).toString(36);
      const html = fs.readFileSync(file, 'utf8').replace(/src="\/app\.js(\?v=[^"]*)?"/, `src="/app.js?v=${ver}"`);
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return server;
}

module.exports = { createServer };
