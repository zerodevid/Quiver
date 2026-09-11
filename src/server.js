'use strict';
// API HTTP + penyaji dashboard.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { rulesFor, DEFAULTS } = require('./policy');
const { scoutWallet } = require('./scout');
const { WalletResearch, summarize } = require('./wallet');
const { createSettingsRoutes } = require('./settings');
const { Manual } = require('./manual');
const { Icons } = require('./icons');
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

function createServer({ engine, store, cfg, cfgPath, chain, rpc, log, telegram }) {
  const pub = path.join(__dirname, '..', 'public');
  const scoutJobs = new Map();
  const poolScanJobs = new Map();
  const walletJobs = new Map();
  const research = new WalletResearch({ rpc, store, chain, log });
  const manual = new Manual({ engine, store, chain, rpc, log });

  // Satu pintu untuk semua pemindaian wallet: tombol di dasbor, pembaruan otomatis
  // saat halaman dibuka, dan pembaruan saat target terdeteksi beraksi. Satu wallet
  // hanya boleh punya satu pekerjaan berjalan.
  //   mode 'full'    — bangun ulang semua posisi di jendela `blocks`
  //   mode 'refresh' — hanya blok sejak pindai terakhir + posisi yang masih terbuka
  const startWalletJob = (addr, { mode = 'full', blocks = 900_000, reason = null } = {}) => {
    if (walletJobs.get(addr)?.status === 'jalan') return walletJobs.get(addr);
    const job = { status: 'jalan', mode, reason, phase: 'mulai', progress: 0, done: 0, total: 0, startedAt: Date.now(), error: null };
    walletJobs.set(addr, job);
    const onProgress = (p) => {
      job.phase = p.phase; job.done = p.scanned; job.total = p.total;
      job.progress = p.total ? Math.round((p.scanned / p.total) * 100) : 0;
    };
    const run = mode === 'refresh'
      ? research.refresh(addr, { ethUsd: engine.ethUsd, onProgress })
      : research.scan(addr, { blocks, ethUsd: engine.ethUsd, onProgress });
    if (reason !== 'manual') log(`riset ${addr}: pembaruan ${mode} dimulai (${reason})`);
    run.then((r) => {
      job.status = 'selesai'; job.finishedAt = Date.now();
      if (reason !== 'manual') log(`riset ${addr}: selesai ${((job.finishedAt - job.startedAt) / 1000).toFixed(0)} dtk, ${r?.positions?.length ?? 0} posisi dibaca`);
    })
      .catch((e) => { job.error = e.message; job.status = 'gagal'; job.finishedAt = Date.now(); log(`riset wallet ${addr}: ${e.message}`); });
    return job;
  };

  // Riset dianggap basi setelah 5 menit; membukanya memicu pembaruan lanjutan di
  // latar. Pembaruan yang GAGAL tidak diulang terus-menerus tiap poll — tunggu dulu.
  const STALE_MS = 5 * 60_000;
  const RETRY_AFTER_FAIL_MS = 2 * 60_000;
  const maybeRefresh = (addr, w, reason) => {
    const job = walletJobs.get(addr);
    if (job?.status === 'jalan') return;
    if (job?.status === 'gagal' && Date.now() - (job.finishedAt || 0) < RETRY_AFTER_FAIL_MS) return;
    if (w && Date.now() - (w.last_scan_ts || 0) < STALE_MS) return;
    startWalletJob(addr, { mode: 'refresh', reason });
  };

  // Target yang baru beraksi: perbarui risetnya ~20 detik kemudian (satu aksi
  // rebalance biasanya berupa beberapa event beruntun — cukup satu pembaruan).
  // Hanya untuk wallet yang sudah pernah dipindai; pindai pertama tetap manual.
  const pendingRefresh = new Map();
  engine.onFreshActions = (acts) => {
    for (const target of new Set(acts.map((a) => a.target))) {
      if (pendingRefresh.has(target)) continue;
      if (!store.get('SELECT 1 FROM wallets WHERE address=?', target)) continue;
      pendingRefresh.set(target, setTimeout(() => {
        pendingRefresh.delete(target);
        const job = walletJobs.get(target);
        if (job?.status === 'jalan') return;
        startWalletJob(target, { mode: 'refresh', reason: 'aksi' });
      }, 20_000));
    }
  };

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
  // Permintaan dari dalam proses (bot Telegram) membawa badannya langsung di
  // req.__body — tidak ada stream yang bisa dibaca. Lihat callApi di bawah.
  const readBody = (req) => (req.__body ? Promise.resolve(req.__body) : new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  }));
  const saveCfg = () => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // Logo token dari GeckoTerminal, disimpan di sebelah database. Pemanasan pertama
  // ditunda sebentar supaya tidak berebut jaringan dengan sinkronisasi awal mesin.
  // Tanpa path database (tes) tidak ada tempat menyimpan, jadi tidak ada pemanasan.
  const dbPath = cfg.db?.path;
  const icons = new Icons({ store, dir: dbPath ? path.join(path.dirname(dbPath), 'icons') : path.join(require('node:os').tmpdir(), 'lpcopy-icons'), log });
  if (dbPath) {
    const warmIcons = () => { try { const n = icons.warm(); if (n) log(`logo: mengambil ${n} logo token dari GeckoTerminal`); } catch (e) { log(`logo: ${e.message}`); } };
    setTimeout(warmIcons, 15_000).unref?.();
    setInterval(warmIcons, 30 * 60_000).unref?.();
  }

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
    // Portofolio milik kita: total sekarang, kurva pertumbuhan, PnL per hari, dan
    // kinerja per sumber (target yang disalin / manual). Terpisah dari /api/overview
    // karena overview dipoll tiap 5 detik — data ini cukup tiap setengah menit.
    'GET /api/portfolio': (req, url) => {
      const SPAN = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: 0 };
      const range = url.searchParams.get('range') in SPAN ? url.searchParams.get('range') : '7d';
      const now = Date.now();
      const from = SPAN[range] ? now - SPAN[range] : 0;
      const eth = engine.ethUsd;
      const k = (q) => (q === 'ETH' ? eth : 1);
      const s = engine.positions.summary(eth);
      const cash = engine.cash;
      const value = (cash?.usd || 0) + s.exposureUsd + s.feeUsd;
      const pnl = s.realizedUsd + s.unrealizedUsd;

      // Satu titik tiap 5 menit = 8.640 titik per 30 hari, jauh lebih rapat daripada
      // piksel grafiknya. Ambil titik terakhir tiap ember; titik pertama tetap ikut.
      const rows = store.all(`SELECT ts, wallet_quote AS cash, positions_quote AS pos, fees_quote AS fee,
        total_quote AS total, pnl_quote AS pnl, open_positions AS n FROM equity WHERE ts >= ? ORDER BY ts`, from);
      const MAX = 360;
      let series = rows;
      if (rows.length > MAX) {
        const step = rows.length / MAX;
        series = [rows[0]];
        for (let i = 1; i <= MAX; i++) series.push(rows[Math.min(rows.length - 1, Math.floor(i * step) - 1)]);
      }
      // Titik "sekarang" supaya ujung grafik sama dengan angka di kartu, bukan
      // tertinggal sampai 5 menit di belakangnya.
      if (engine.positions.lastSync) {
        series = [...series, { ts: now, cash: cash ? cash.usd : null, pos: s.exposureUsd, fee: s.feeUsd, total: value, pnl, n: s.openCount, live: true }];
      }
      // Titik terakhir SEBELUM jendela: patokan "berubah berapa dalam rentang ini".
      const baseline = from ? store.get('SELECT ts, pnl_quote AS pnl, total_quote AS total, wallet_quote AS cash FROM equity WHERE ts < ? ORDER BY ts DESC LIMIT 1', from) || null : null;

      // Posisi tertutup: bahan kalender (dikelompokkan per hari di browser, pakai
      // zona waktu pengguna) dan statistik menang/kalah.
      const closed = store.all("SELECT target, opened_ts, closed_ts, cost_quote, out_quote, quote_symbol FROM positions WHERE status='closed' AND closed_ts IS NOT NULL ORDER BY closed_ts")
        .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
      const pnls = closed.map((p) => p.pnl);
      const wins = pnls.filter((x) => x > 0).length;
      const holds = closed.filter((p) => p.opened_ts).map((p) => (p.closed_ts - p.opened_ts) / 3600000);

      // Per sumber: target yang disalin, atau '' untuk posisi manual / di luar bot.
      const live = new Map(engine.positions.live.map((p) => [p.id, p]));
      const labels = new Map(store.all('SELECT address,label FROM targets').map((t) => [t.address, t.label]));
      const by = new Map();
      const grp = (t) => {
        const key = t || '';
        if (!by.has(key)) by.set(key, { target: key || null, label: key ? labels.get(key) || null : null, open: 0, value: 0, upnl: 0, closed: 0, wins: 0, realized: 0 });
        return by.get(key);
      };
      for (const r of store.all("SELECT id, target, cost_quote, quote_symbol FROM positions WHERE status='open'")) {
        const l = live.get(r.id);
        if (l?.empty) continue;
        const g = grp(r.target);
        g.open++;
        g.value += l ? (l.valueUsd || 0) + (l.feeUsd || 0) : (r.cost_quote || 0) * k(r.quote_symbol);
        g.upnl += l?.pnlUsd || 0;
      }
      for (const p of closed) {
        const g = grp(p.target);
        g.closed++; g.realized += p.pnl; if (p.pnl > 0) g.wins++;
      }

      return {
        range, from, series, baseline,
        now: {
          value, cash, positionsUsd: s.exposureUsd, feeUsd: s.feeUsd, costUsd: s.costUsd,
          pnl, realizedUsd: s.realizedUsd, unrealizedUsd: s.unrealizedUsd,
          // Modal bersih ≈ yang pernah disetor: nilai sekarang dikurangi seluruh laba.
          // Tanpa saldo kas (mode tanpa wallet) tidak bisa dihitung.
          capital: cash ? value - pnl : null,
          openCount: s.openCount, inRange: s.inRange,
        },
        stats: {
          closedCount: closed.length, wins, losses: closed.length - wins,
          winRatePct: closed.length ? (wins / closed.length) * 100 : null,
          avgPnl: closed.length ? pnls.reduce((a, b) => a + b, 0) / closed.length : null,
          best: closed.length ? Math.max(...pnls) : null,
          worst: closed.length ? Math.min(...pnls) : null,
          avgHoldHours: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
        },
        closed: closed.map((p) => [p.closed_ts, p.pnl]),
        byTarget: [...by.values()].sort((a, b) => (b.realized + b.upnl) - (a.realized + a.upnl)),
      };
    },
    'GET /api/positions': () => {
      // Posisi tertutup cuma menyimpan alamat token; tanpa simbol, tabelnya hanya
      // deretan nomor NFT yang tidak bisa dikenali.
      const closed = store.all("SELECT * FROM positions WHERE status='closed' ORDER BY closed_ts DESC LIMIT 100");
      const toks = new Map(store.all('SELECT address,symbol FROM tokens').map((t) => [t.address, t.symbol]));
      for (const r of closed) {
        r.symbol0 = toks.get(r.token0) || null;
        r.symbol1 = toks.get(r.token1) || null;
      }
      return { positions: engine.positions.live, closed };
    },
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
      const mode = b.mode === 'refresh' ? 'refresh' : 'full';
      const job = startWalletJob(addr, { mode, blocks: Number(b.blocks || 900_000), reason: 'manual' });
      return { ok: true, status: job.status };
    },

    'GET /api/wallet': async (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      const w = store.get('SELECT * FROM wallets WHERE address=?', addr);
      // Sudah pernah dipindai tapi basi -> perbarui di latar; halaman tetap langsung
      // menampilkan data tersimpan dan melihat progresnya lewat `job`.
      if (w) maybeRefresh(addr, w, 'basi');
      const job = walletJobs.get(addr);
      const jobOut = job ? {
        status: job.status, mode: job.mode, reason: job.reason, phase: job.phase, progress: job.progress,
        done: job.done, total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error,
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
      // pool_ref v4 adalah poolId (32 byte, dibaca dari storage PoolManager); pool_ref
      // v3 adalah ALAMAT kontrak pool-nya. Dulu semuanya dilempar ke jalur v4, yang
      // untuk v3 menghasilkan tick ngawur — penanda "harga kini" jadi salah tempat.
      const byPool = new Map();
      const idV4 = [...new Set(open.filter((r) => r.venue !== 'v3').map((r) => r.pool_ref).filter(Boolean))];
      if (idV4.length) {
        try {
          const slots = await chain.slot0V4Many(idV4);
          idV4.forEach((id, i) => byPool.set(id, slots[i]));
        } catch { /* harga kini tidak terbaca: bar tetap tampil tanpa penanda */ }
      }
      for (const a of [...new Set(open.filter((r) => r.venue === 'v3').map((r) => r.pool_ref).filter(Boolean))]) {
        try { byPool.set(a, await chain.slot0V3(a)); } catch { /* sama */ }
      }
      for (const r of open) r.curTick = byPool.get(r.pool_ref)?.tick ?? null;

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

    // ---- LP manual & swap manual ----
    // Rencana TIDAK pernah dikirim balik lalu dieksekusi apa adanya: /open menyusun
    // ulang rencananya dari masukan yang sama, di harga terkini, sehingga semua
    // pemeriksaan (batas, hook, kas) berjalan lagi tepat sebelum transaksi dibuat.
    'GET /api/manual/pools': async (req, url) => ({
      pools: await manual.pools({
        q: url.searchParams.get('q') || '',
        limit: Math.min(100, Number(url.searchParams.get('limit') || 40)),
        withPrice: url.searchParams.get('price') === '1',
      }),
    }),
    // Pindai pool dari alamat token. Dijadikan pekerjaan latar seperti scout: satu
    // pemindaian rentang penuh makan belasan detik, terlalu lama untuk satu balasan HTTP.
    'POST /api/manual/pools/scan': async (req) => {
      const b = await readBody(req);
      const token = String(b.token || '').toLowerCase().trim();
      if (!/^0x[0-9a-f]{40}$/.test(token)) return { error: 'alamat token harus 0x diikuti 40 karakter hex' };
      if (poolScanJobs.get(token)?.status === 'jalan') return { ok: true, status: 'jalan' };
      const job = { status: 'jalan', progress: 0, startedAt: Date.now(), pools: null, error: null };
      poolScanJobs.set(token, job);
      manual.scanPools(token, {
        onProgress: (p) => { job.progress = p.total ? Math.round((p.done / p.total) * 100) : 0; },
      }).then((pools) => { job.pools = pools; job.status = 'selesai'; job.finishedAt = Date.now(); })
        .catch((e) => { job.error = e.message; job.status = 'gagal'; job.finishedAt = Date.now(); });
      return { ok: true, status: 'jalan' };
    },
    'GET /api/manual/pools/scan': (req, url) => {
      const token = String(url.searchParams.get('token') || '').toLowerCase();
      const j = poolScanJobs.get(token);
      if (!j) return { status: 'kosong' };
      const out = { status: j.status, progress: j.progress, error: j.error };
      if (!j.pools) return out;
      // Hasil mentah bisa ratusan pool dan hampir semuanya sampah: dibuat lalu
      // ditinggalkan tanpa likuiditas, atau dipasangkan token yang bukan uang.
      // Yang ditampilkan hanya yang benar-benar bisa dimasuki; sisanya dihitung saja.
      const bisa = j.pools.filter((p) => p.quoteSide != null && p.kosong !== true && !p.dynamicFee);
      const semua = url.searchParams.get('all') === '1';
      const list = semua ? j.pools : (bisa.length ? bisa : j.pools.filter((p) => p.quoteSide != null));
      return { ...out, pools: list, total: j.pools.length, hidden: j.pools.length - list.length };
    },

    'POST /api/manual/lp/plan': async (req) => {
      const b = await readBody(req);
      return manual.planLp({
        poolRef: String(b.poolRef || ''), usd: Number(b.usd),
        widthPct: b.widthPct != null ? Number(b.widthPct) : 25,
        lowerPct: b.lowerPct != null ? Number(b.lowerPct) : null,
        upperPct: b.upperPct != null ? Number(b.upperPct) : null,
        tickLower: b.tickLower != null ? Math.round(Number(b.tickLower)) : null,
        tickUpper: b.tickUpper != null ? Math.round(Number(b.tickUpper)) : null,
        full: !!b.full,
      });
    },
    'POST /api/manual/lp/open': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const d = await manual.planLp({
        poolRef: String(b.poolRef || ''), usd: Number(b.usd),
        widthPct: b.widthPct != null ? Number(b.widthPct) : 25,
        lowerPct: b.lowerPct != null ? Number(b.lowerPct) : null,
        upperPct: b.upperPct != null ? Number(b.upperPct) : null,
        tickLower: b.tickLower != null ? Math.round(Number(b.tickLower)) : null,
        tickUpper: b.tickUpper != null ? Math.round(Number(b.tickUpper)) : null,
        full: !!b.full,
      });
      if (d.error) return d;
      try {
        const r = await manual.openLp(d.plan);
        return { ok: true, tx: r.txHash, positionId: r.positionId, note: r.note };
      } catch (e) {
        log(`LP manual: ${e.message}`);
        return { error: e.message };
      }
    },
    'GET /api/manual/tokens': async () => ({ tokens: await manual.held() }),
    // Saldo untuk langkah "Nominal" — tampil sebelum pratinjau pertama selesai dihitung.
    'GET /api/manual/saldo': async (req, url) => {
      try { return await manual.saldo(String(url.searchParams.get('poolRef') || '') || null); }
      catch (e) { return { error: e.message }; }
    },

    // Alamat yang ditempel pengguna: token (untuk dipasangi LP) atau wallet (untuk
    // diriset / dijadikan target)? Wallet LP besar sering berupa KONTRAK (smart
    // wallet, Safe), jadi "punya kode" saja belum berarti token — yang menentukan
    // adalah symbol() dan decimals() yang menjawab. Metadata token baru disimpan
    // hanya kalau memang token, supaya tabel tokens tidak kemasukan alamat wallet.
    'GET /api/address': async (req, url) => {
      const a = String(url.searchParams.get('a') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat harus 0x diikuti 40 karakter hex' };
      const tgt = store.get('SELECT label FROM targets WHERE address=?', a);
      const riset = store.get('SELECT address FROM wallets WHERE address=?', a);
      const base = { address: a, isTarget: !!tgt, targetLabel: tgt?.label || null, researched: !!riset };
      const code = await rpc.call('eth_getCode', [a, 'latest']);
      if (!code || code === '0x') return { ...base, kind: 'wallet' };
      const [sym, dec] = await rpc.ethCallMany([{ to: a, data: '0x95d89b41' }, { to: a, data: '0x313ce567' }]);
      const d = dec && dec.length >= 66 ? Number(BigInt(dec.slice(0, 66))) : null;
      if (!sym || sym === '0x' || d == null || d > 36) return { ...base, kind: 'contract' };
      const t = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
      return { ...base, kind: 'token', symbol: t?.symbol || '?', name: t?.name || '', decimals: t?.decimals ?? d };
    },
    'POST /api/manual/swap/quote': async (req) => {
      const b = await readBody(req);
      try {
        const raw = await manual.amountRaw(b.tokenIn, b.amount);
        if (raw <= 0n) return { error: 'jumlah nol — saldonya kosong?' };
        return { ...(await manual.quoteSwap({ tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountRaw: raw })), amountRaw: raw.toString() };
      } catch (e) { return { error: e.message }; }
    },
    'POST /api/manual/swap': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        const raw = await manual.amountRaw(b.tokenIn, b.amount);
        if (raw <= 0n) return { error: 'jumlah nol — saldonya kosong?' };
        const r = await manual.doSwap({ tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountRaw: raw });
        return { ok: true, tx: r.txHash, note: r.note, dex: r.dex };
      } catch (e) {
        log(`swap manual: ${e.message}`);
        return { error: e.message };
      }
    },

    // ---- sisa memecoin yang belum terjual setelah keluar posisi ----
    'GET /api/leftovers': () => {
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      return {
        leftovers: engine.leftovers().map((it) => ({
          ...it,
          symbol: toks.get(String(it.token).toLowerCase())?.symbol || null,
          decimals: toks.get(String(it.token).toLowerCase())?.decimals ?? 18,
        })),
      };
    },
    'POST /api/leftovers/retry': async () => {
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const list = engine.leftovers();
      if (!list.length) return { ok: true, tried: 0 };
      // Jadwal tunggu dilewati: ini permintaan manual, bukan percobaan otomatis.
      engine.saveLeftovers(list.map((x) => ({ ...x, next: 0 })));
      const errs = [];
      for (const item of engine.leftovers()) {
        try { await engine.sellToken(item); } catch (e) { errs.push(e.message); }
      }
      return { ok: true, tried: list.length, error: errs.length ? errs.join(' · ') : null };
    },
    'POST /api/leftovers/drop': async (req) => {
      const b = await readBody(req);
      const before = engine.leftovers().length;
      engine.dropLeftover({ posId: Number(b.posId), token: String(b.token || '').toLowerCase() });
      return engine.leftovers().length < before ? { ok: true } : { error: 'tidak ada di antrean' };
    },

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

  Object.assign(routes, createSettingsRoutes({ engine, store, cfg, cfgPath, rpc, log, readBody, telegram }));

  // Pintu yang sama untuk pemanggil di dalam proses (bot Telegram). Sengaja lewat
  // tabel rute yang persis dipakai browser: apa pun yang bisa dilakukan dasbor bisa
  // dilakukan bot, dan validasi/penjagaannya cuma ditulis sekali. Gerbang token
  // dilewati karena pemanggilnya sudah berada di dalam proses — Telegram punya
  // gerbangnya sendiri (daftar chat yang diizinkan).
  const callApi = async (method, pathname, body = {}, query = {}) => {
    const key = `${method} ${pathname}`;
    if (!routes[key]) throw new Error(`rute ${key} tidak ada`);
    const url = new URL(`http://x${pathname}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    return routes[key]({ __body: body, headers: {} }, url, {});
  };

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
    // Logo token: satu-satunya rute /api yang membalas gambar, bukan JSON.
    if (key === 'GET /api/icon') {
      const img = await icons.get(url.searchParams.get('a'), { wait: 6000 }).catch(() => null);
      if (!img) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, {
        'content-type': img.ctype,
        'content-length': img.buf.length,
        'cache-control': 'private, max-age=604800',
        // gambar dari pihak ketiga, disajikan di origin yang memegang cookie login
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      return res.end(img.buf);
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
  server.api = callApi;
  return server;
}

module.exports = { createServer };
