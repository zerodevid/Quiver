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
const { Compound } = require('./compound');
const { Holdings } = require('./holdings');
const { Icons } = require('./icons');
const { Market, TF } = require('./market');
const { Positions } = require('./positions');
const { QUOTES, ADDR: { native: ADDR_NATIVE } } = require('./chain');
const { writeCfg } = require('./env');

// Sisi mana dari pool yang merupakan aset kuotasi (0 atau 1); null kalau tidak dikenal.
// Menentukan arah harga yang ditampilkan: selalu "harga token spekulatif dalam kuotasi".
const quoteSideOf = (t0, t1) => (QUOTES[(t0 || '').toLowerCase()] ? 0 : QUOTES[(t1 || '').toLowerCase()] ? 1 : null);

const crypto = require('node:crypto');

const LOGIN_PAGE = (err) => `<!doctype html><html lang="id" data-bs-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quiver — masuk</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/vendor/tabler.min.css"></head>
<body class="d-flex align-items-center py-4" style="min-height:100vh">
<div class="container container-tight py-4">
  <div class="card card-md"><div class="card-body">
    <h2 class="h2 text-center mb-1"><img src="/favicon.svg" alt="" width="28" height="28" class="me-2 align-text-bottom">Quiver</h2>
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
  const compound = engine.compound || new Compound(engine);
  const holdings = new Holdings({ rpc, store, chain, log });
  // Portofolio per wallet di-cache sebentar: halaman detail target di-poll, dan
  // tiap hitungan berarti puluhan eth_call + DexScreener.
  const holdingsCache = new Map();
  const market = new Market({ log });

  // Antrean memecoin sisa yang belum terjual, dengan simbol & desimal supaya dasbor
  // bisa menulis "688 rb DRIPPYPIGEON". Ikut di /api/overview: peringatannya
  // harus tampil di SEMUA halaman, bukan cuma kalau kebetulan membuka Posisi.
  const leftoverRows = () => {
    const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
    return engine.leftovers().map((it) => {
      const t = toks.get(String(it.token).toLowerCase());
      return { ...it, symbol: t?.symbol || null, decimals: t?.decimals ?? 18, amountNum: Number(it.amount || 0) / 10 ** (t?.decimals ?? 18) };
    });
  };
  // Kunci satu item antrean dari body permintaan. posId BOLEH kosong: sisa yang
  // disapu dari wallet tidak berasal dari posisi mana pun, dan Number(undefined)
  // jadi NaN yang tidak akan pernah cocok dengan null di antrean.
  const leftoverKey = (b) => ({
    posId: b?.posId == null || b.posId === '' ? null : Number(b.posId),
    token: String(b?.token || '').toLowerCase(),
  });
  const sameLeftover = (x, k) => (x.posId ?? null) === k.posId && String(x.token).toLowerCase() === k.token;

  // Token atau bukan? Wallet LP besar sering berupa KONTRAK (smart wallet, Safe),
  // jadi "punya kode" saja belum berarti token — yang menentukan adalah symbol() dan
  // decimals() yang menjawab. Metadata disimpan (chain.tokens) hanya kalau memang
  // token, supaya tabel tokens tidak kemasukan alamat wallet.
  const probeToken = async (a) => {
    const code = await rpc.call('eth_getCode', [a, 'latest']);
    if (!code || code === '0x') return { kind: 'wallet' };
    const [sym, dec] = await rpc.ethCallMany([{ to: a, data: '0x95d89b41' }, { to: a, data: '0x313ce567' }]);
    const d = dec && dec.length >= 66 ? Number(BigInt(dec.slice(0, 66))) : null;
    if (!sym || sym === '0x' || d == null || d > 36) return { kind: 'contract' };
    const t = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
    return { kind: 'token', symbol: t?.symbol || '?', name: t?.name || '', decimals: t?.decimals ?? d };
  };

  // Harga USD per token untuk daftar saldo swap. Aset kuotasi dari harga ETH mesin;
  // token lain dari pool DexScreener berlikuiditas terbesar (di-cache 30 detik).
  // Dibatasi waktunya: halaman tidak boleh menunggu DexScreener yang lambat.
  const usdPrice = async (a) => {
    if (QUOTES[a]) return QUOTES[a].kind === 'usd' ? 1 : engine.ethUsd || null;
    const mk = await Promise.race([market.token(a), new Promise((r) => setTimeout(() => r(null), 3000))]).catch(() => null);
    return mk?.pairs?.find((p) => p.priceUsd && (p.base.address === a))?.priceUsd ?? null;
  };

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
  // Lewat writeCfg: nilai dari .env tidak boleh ikut tertulis ke config.json.
  const saveCfg = () => writeCfg(cfgPath, cfg);

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

  // Pool hasil pindai yang benar-benar bisa dimasuki: berpasangan aset kuotasi,
  // berlikuiditas, dan fee-nya bisa dinilai di muka.
  const bisaDimasuki = (p) => p.quoteSide != null && p.kosong !== true && !p.dynamicFee;

  // Hasil posisi KITA per sumber: target yang disalin, atau '' untuk posisi manual /
  // di luar bot. Terealisasi = posisi tertutup (out − modal); berjalan = PnL live
  // posisi terbuka (sudah termasuk fee yang pernah diklaim). Dipakai halaman Target
  // dan kartu "per sumber" di Overview supaya angkanya sama persis.
  const pnlByTarget = (closed) => {
    const eth = engine.ethUsd;
    const k = (q) => (q === 'ETH' ? eth : 1);
    closed ??= store.all("SELECT target, cost_quote, out_quote, quote_symbol FROM positions WHERE status='closed' AND closed_ts IS NOT NULL")
      .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
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
    return by;
  };

  // Posisi bot, posisi wallet hasil riset, dan gerakan target yang cocok dengan satu
  // syarat SQL (mis. "token0=? OR token1=?" atau "pool_ref=?") — bahan halaman
  // detail token dan detail pool, supaya keduanya menghitung PnL dengan cara sama.
  const lpRows = async (cond, args) => {
    const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
    const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
    const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
    const kOf = (q) => (q === 'ETH' || q === 'WETH' ? engine.ethUsd : 1);

    // Posisi bot. Yang terbuka dari hasil sinkron terakhir (nilai & PnL kini).
    const live = new Map(engine.positions.live.map((p) => [p.id, p]));
    const mine = store.all(`SELECT * FROM positions WHERE (${cond}) AND status IN ('open','closed')
      ORDER BY COALESCE(closed_ts, opened_ts) DESC LIMIT 200`, ...args);
    const open = [], closed = [];
    for (const r of mine) {
      if (r.status === 'open') {
        const l = live.get(r.id);
        if (l?.empty) continue;
        open.push(l || {
          ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
          quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), curTick: null, inRange: null,
          costUsd: (r.cost_quote || 0) * kOf(r.quote_symbol), valueUsd: (r.cost_quote || 0) * kOf(r.quote_symbol), feeUsd: 0, pnlUsd: 0, pnlPct: 0,
          ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        });
      } else {
        const cost = (r.cost_quote || 0) * kOf(r.quote_symbol), out = (r.out_quote || 0) * kOf(r.quote_symbol);
        closed.push({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
          quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), exitSqrt: r.exit_sqrt || null,
          costUsd: cost, outUsd: out, pnlUsd: out - cost, pnlPct: cost > 0 ? ((out - cost) / cost) * 100 : null,
          ageHours: ((r.closed_ts || Date.now()) - (r.opened_ts || Date.now())) / 3600000 });
      }
    }

    // Posisi wallet hasil riset (target maupun wallet lain yang pernah dipindai).
    const labels = new Map(store.all('SELECT address,label FROM wallets').map((w) => [w.address, w.label]));
    for (const t of store.all('SELECT address,label FROM targets')) if (t.label) labels.set(t.address, t.label);
    const targets = new Set(store.all('SELECT address FROM targets').map((t) => t.address));
    // liquidity & returned_q ikut dibaca karena penilaian ulang di bawah memerlukannya:
    // tanpa liquidity posisi v3 tak bisa dinilai, dan tanpa returned_q penarikan yang
    // sudah masuk kantong hilang dari PnL-nya.
    const wallets = store.all(`SELECT wallet, venue, token_id, pool_ref, token0, token1, fee, tick_lower, tick_upper, status,
        opened_ts, closed_ts, liquidity, invested_q, returned_q, live_value_q, live_fee_q, fees_q, pnl_q
      FROM wpositions WHERE ${cond} ORDER BY COALESCE(closed_ts, opened_ts) DESC LIMIT 300`, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
        quoteSide: quoteSideOf(r.token0, r.token1), walletLabel: labels.get(r.wallet) || null, isTarget: targets.has(r.wallet) }));
    // Posisi wallet yang masih terbuka dinilai ulang di harga sekarang. Angka tersimpan
    // berasal dari pemindaian terakhir wallet itu — tanpa ini, tabel riset dan tabel
    // posisi bot di halaman yang sama bisa menunjukkan arah PnL yang berlawanan untuk
    // pool dan rentang yang sama, hanya karena keduanya diukur di waktu yang berbeda.
    try { await research.refreshOpen(wallets, engine.ethUsd); }
    catch (e) { log(`nilai posisi riset terbuka: ${e.message}`); }
    for (const r of wallets) r.pnlPct = r.invested_q > 0 ? (r.pnl_q / r.invested_q) * 100 : null;

    // Gerakan target, dengan keputusan bot atasnya.
    const activity = store.all(`SELECT a.id, a.ts, a.target, a.venue, a.kind, a.token_id, a.pool_ref, a.token0, a.token1, a.fee,
        a.value_quote, a.quote_symbol, d.verdict, d.reason, d.position_id
      FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE ${cond.replace(/\b(token0|token1|pool_ref)\b/g, 'a.$1')} ORDER BY a.ts DESC, a.id DESC LIMIT 100`, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), targetLabel: labels.get(r.target) || null }));

    return { open, closed, wallets, activity };
  };

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
        leftovers: leftoverRows(), leftoverRetrySec: engine.leftoverRetrySec ? engine.leftoverRetrySec() : 5,
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
      const lo = s.leftoverUsd || 0;
      const value = (cash?.usd || 0) + s.exposureUsd + lo + s.feeUsd;
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
        series = [...series, { ts: now, cash: cash ? cash.usd : null, pos: s.exposureUsd + lo, fee: s.feeUsd, total: value, pnl, n: s.openCount, live: true }];
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
      const by = pnlByTarget(closed);

      return {
        range, from, series, baseline,
        now: {
          value, cash, positionsUsd: s.exposureUsd, feeUsd: s.feeUsd, costUsd: s.costUsd,
          // memecoin sisa dari posisi yang sudah tutup, belum dijual, di harga kini
          leftoverUsd: lo,
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
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      for (const r of closed) {
        r.symbol0 = toks.get(r.token0)?.symbol || null;
        r.symbol1 = toks.get(r.token1)?.symbol || null;
      }
      // Daftarnya dari basis data, angkanya dari sinkron terakhir. Dulu daftarnya
      // langsung hasil sinkron (tiap 30 detik): sesudah restart tabel kosong sampai
      // sinkron pertama selesai, posisi yang baru dimint baru muncul ~30 detik
      // kemudian, dan yang baru ditutup masih tampil. Posisi yang belum tersinkron
      // tampil dulu dengan angka modal, bertanda `syncing`.
      const live = new Map(engine.positions.live.map((p) => [p.id, p]));
      const k = (q) => (q === 'ETH' || q === 'WETH' ? engine.ethUsd : 1);
      const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
      const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
      const positions = store.all("SELECT * FROM positions WHERE status='open' ORDER BY opened_ts").map((r) => live.get(r.id) || {
        ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
        quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), curTick: null, inRange: null,
        costUsd: (r.cost_quote || 0) * k(r.quote_symbol), valueUsd: (r.cost_quote || 0) * k(r.quote_symbol),
        feeUsd: 0, pnlUsd: 0, pnlPct: 0, ilUsd: null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        syncing: true,
      });
      return { positions: positions.map((p) => ({ ...p, compound: compound.status(p) })), closed, syncedAt: engine.positions.lastSync };
    },
    // Satu posisi untuk halaman detail. Yang terbuka diambil dari hasil sinkron terakhir
    // (nilai, fee, harga kini); yang sudah ditutup — atau baru dibuka dan belum
    // tersinkron — dari basis data, dihias secukupnya supaya bentuknya sama.
    'GET /api/position': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE id=?', id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      // Baris yang sudah 'closed' di DB adalah kebenaran: hasil sinkron terakhir masih
      // memuat posisi itu (nilai basi) sampai sinkron berikutnya, ~30 detik setelah tutup.
      const live = row.status === 'closed' ? null : engine.positions.live.find((p) => p.id === id);
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      const k = row.quote_symbol === 'ETH' || row.quote_symbol === 'WETH' ? engine.ethUsd : 1;
      const costUsd = (row.cost_quote || 0) * k;
      const outUsd = row.status === 'closed' ? (row.out_quote || 0) * k : null;
      const pos = live ? { ...live } : {
        ...row,
        symbol0: toks.get(row.token0)?.symbol || '?', symbol1: toks.get(row.token1)?.symbol || '?',
        dec0: toks.get(row.token0)?.decimals ?? 18, dec1: toks.get(row.token1)?.decimals ?? 18,
        quoteSide: quoteSideOf(row.token0, row.token1),
        entrySqrt: Positions.entrySqrtOf(row),
        curTick: null, curSqrt: null, inRange: null,
        amount0: row.status === 'closed' ? row.out0 : null, amount1: row.status === 'closed' ? row.out1 : null,
        fee0: null, fee1: null,
        costUsd, valueUsd: outUsd ?? costUsd, feeUsd: 0,
        pnlUsd: outUsd != null ? outUsd - costUsd : 0,
        pnlPct: outUsd != null && costUsd > 0 ? ((outUsd - costUsd) / costUsd) * 100 : 0,
        ageHours: ((row.closed_ts || Date.now()) - (row.opened_ts || Date.now())) / 3600000,
        empty: row.status === 'closed',
      };
      // Baru dimint, belum ikut sinkron: angka nilai/fee/PnL di bawah masih taksiran
      // dari modal — halaman detail menandainya, bukan menyajikannya sebagai kabar pasti.
      pos.syncing = row.status !== 'closed' && !live;
      pos.exitSqrt = row.exit_sqrt || null;
      pos.claimedUsd = (row.claimed_quote || 0) * k;
      pos.compound = compound.status(row);
      pos.outUsd = outUsd;
      pos.quoteKind = row.quote_symbol === 'ETH' || row.quote_symbol === 'WETH' ? 'eth' : 'usd';
      pos.targetLabel = row.target ? (store.get('SELECT label FROM targets WHERE address=?', row.target)?.label || null) : null;
      // Token spekulatif = yang bukan aset kuotasi; dasar harga di grafik.
      pos.baseToken = pos.quoteSide === 0 ? row.token1 : pos.quoteSide === 1 ? row.token0 : row.token0;
      return { position: pos, ethUsd: engine.ethUsd, syncedAt: engine.positions.lastSync };
    },
    // Riwayat satu posisi bot untuk laci detail: setiap transaksi yang menyentuhnya
    // (swap zap, mint, tambah, kurangi, tutup, jual sisa) dengan jumlah token dan nilai,
    // plus catatan bot — keputusan atas aksi target yang memicunya dan baris log yang
    // menyebut posisi ini.
    'GET /api/position/history': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE id=?', id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens').map((t) => [t.address, t]));
      const isEth = row.quote_symbol === 'ETH' || row.quote_symbol === 'WETH';
      const k = isEth ? engine.ethUsd : 1;
      const parse = (d) => { try { return JSON.parse(d || '{}') || {}; } catch { return {}; } };
      const gasUsd = (t) => (t.gas_used && t.gas_price ? (Number(t.gas_used) * Number(BigInt(t.gas_price))) / 1e18 * engine.ethUsd : null);
      // Transaksi yang menyentuh posisi ini: hash buka/tutup, yang mencatat nomor posisi
      // di detailnya (tutup, jual sisa), keputusan yang menaut ke posisi ini, dan
      // swap/mint di pool yang sama selama posisi hidup (zap tidak menyimpan nomor posisi —
      // nomornya baru ada setelah mint sukses).
      const lo = (row.opened_ts || 0) - 15 * 60_000, hi = (row.closed_ts || Date.now()) + 60_000;
      const txs = store.all(`
        SELECT * FROM txs WHERE hash IN (?, ?)
           OR json_extract(detail, '$.position') = ?
           OR EXISTS (SELECT 1 FROM json_each(txs.detail, '$.positionSales') sale WHERE json_extract(sale.value, '$.position') = ?)
           OR hash IN (SELECT tx_hash FROM decisions WHERE position_id = ? AND tx_hash IS NOT NULL)
           OR (json_extract(detail, '$.pool') = ? AND ts BETWEEN ? AND ? AND kind IN ('zap_swap', 'mint', 'increase', 'bridge_swap'))
        ORDER BY ts`, row.tx_open, row.tx_close, id, id, id, row.pool_ref, lo, hi);
      const decByTx = new Map(store.all(`
        SELECT d.tx_hash, d.verdict, d.reason, a.kind AS action_kind, a.value_quote, a.quote_symbol
        FROM decisions d JOIN actions a ON a.id = d.action_id
        WHERE d.position_id = ? AND d.tx_hash IS NOT NULL`, id).map((d) => [d.tx_hash, d]));
      const seen = new Set();
      const events = txs.filter((t) => !seen.has(t.hash) && seen.add(t.hash)).map((t) => {
        const d = parse(t.detail);
        const dec = decByTx.get(t.hash);
        const sale = d.positionSales?.find((s) => s.position === id);
        const ev = {
          hash: t.hash, ts: t.ts, kind: t.kind, status: t.status, error: t.error, gasUsd: gasUsd(t),
          swap: d.tokenIn ? { tokenIn: d.tokenIn, tokenOut: d.tokenOut, symbolIn: d.symbolIn, symbolOut: d.symbolOut, amountIn: d.amountIn, amountOut: d.amountOut } : null,
          saleDeltaUsd: sale ? (sale.gotQuote - sale.closeQuote) * k : null,
          dex: d.dex || d.via || null, usdIn: d.usdIn ?? null, usdOut: d.usdOut ?? null,
          amount0: null, amount1: null, valueUsd: null, feesUsd: null,
          reason: dec?.reason || null, verdict: dec?.verdict || null,
          // Nilai aksi target yang ditiru — konteks "kenapa sebesar ini".
          targetUsd: dec?.value_quote > 0 ? dec.value_quote * (dec.quote_symbol === 'ETH' || dec.quote_symbol === 'WETH' ? engine.ethUsd : 1) : null,
        };
        if (t.hash === row.tx_open) { ev.amount0 = row.cost0; ev.amount1 = row.cost1; ev.valueUsd = (row.cost_quote || 0) * k; ev.kind = ev.kind === 'increase' ? 'increase' : 'mint'; }
        if (t.kind === 'claim_fees') {
          const claim = store.get('SELECT * FROM fee_claims WHERE tx_hash=?', t.hash);
          if (claim) {
            ev.amount0 = claim.amount0; ev.amount1 = claim.amount1;
            ev.valueUsd = claim.value_quote * k; ev.feesUsd = ev.valueUsd;
          }
        }
        if (t.kind === 'compound') {
          const run = store.get('SELECT reinvested_quote FROM compound_runs WHERE tx_hash=?', t.hash);
          if (run) ev.valueUsd = run.reinvested_quote * k;
        }
        if (t.hash === row.tx_close) {
          ev.amount0 = d.closeProceeds?.amount0 ?? row.out0; ev.amount1 = d.closeProceeds?.amount1 ?? row.out1; ev.valueUsd = d.closeProceeds?.quote != null ? d.closeProceeds.quote * k : null; ev.feesUsd = (row.fees_quote || 0) * k;
          if (ev.kind !== 'decrease') ev.kind = 'burn';
        }
        return ev;
      });
      // Posisi yang diadopsi dari wallet (bukan dibuka bot) tidak punya tx di tabel:
      // kejadian buka/tutupnya disusun dari baris posisi supaya riwayatnya tidak kosong.
      if (row.opened_ts && !events.some((e) => e.kind === 'mint' || (row.tx_open && e.hash === row.tx_open))) {
        events.unshift({ hash: row.tx_open, ts: row.opened_ts, kind: 'mint', status: row.tx_open ? 'sukses' : null, synthetic: true,
          amount0: row.cost0, amount1: row.cost1, valueUsd: (row.cost_quote || 0) * k, gasUsd: null });
      }
      if (row.status === 'closed' && row.closed_ts && !events.some((e) => e.kind === 'burn' || (row.tx_close && e.hash === row.tx_close))) {
        events.push({ hash: row.tx_close, ts: row.closed_ts, kind: 'burn', status: row.tx_close ? 'sukses' : null, synthetic: true,
          amount0: row.out0, amount1: row.out1, valueUsd: null, feesUsd: (row.fees_quote || 0) * k, gasUsd: null });
      }
      events.sort((a, b) => a.ts - b.ts);

      // Catatan bot: keputusan yang menaut ke posisi ini (termasuk yang tanpa tx,
      // mis. simulasi/lewat) + baris log yang menyebut "#<id>" (bukan #<id>0 dst.).
      const notes = store.all(`
        SELECT d.ts, d.verdict, d.reason, a.kind AS action_kind, a.target
        FROM decisions d JOIN actions a ON a.id = d.action_id WHERE d.position_id = ? ORDER BY d.ts`, id)
        .map((d) => ({ ts: d.ts, kind: 'keputusan', level: d.verdict === 'error' ? 'error' : 'info', verdict: d.verdict, actionKind: d.action_kind, target: d.target, msg: d.reason || '' }));
      const re = new RegExp(`#${id}(?!\\d)`);
      for (const l of store.all('SELECT ts, level, msg FROM logs WHERE msg LIKE ? ORDER BY ts DESC LIMIT 400', `%#${id}%`)) {
        if (re.test(l.msg)) notes.push({ ts: l.ts, kind: 'log', level: l.level, msg: l.msg });
      }
      notes.sort((a, b) => a.ts - b.ts);

      const costUsd = (row.cost_quote || 0) * k;
      const outUsd = row.status === 'closed' ? (row.out_quote || 0) * k : null;
      return {
        position: {
          id: row.id, venue: row.venue, token_id: row.token_id, pool_ref: row.pool_ref, status: row.status,
          token0: row.token0, token1: row.token1,
          symbol0: toks.get(row.token0)?.symbol || '?', symbol1: toks.get(row.token1)?.symbol || '?',
          dec0: toks.get(row.token0)?.decimals ?? 18, dec1: toks.get(row.token1)?.decimals ?? 18,
          opened_ts: row.opened_ts, closed_ts: row.closed_ts, target: row.target, mirror_of: row.mirror_of,
          targetLabel: row.target ? (store.get('SELECT label FROM targets WHERE address=?', row.target)?.label || null) : null,
          closeUsd: events.find((e) => e.hash === row.tx_close)?.valueUsd ?? null,
          swapDeltaUsd: events.some((e) => e.saleDeltaUsd != null) ? events.reduce((sum, e) => sum + (e.saleDeltaUsd || 0), 0) : null,
          costUsd, outUsd, feesUsd: (row.fees_quote || 0) * k,
          pnlUsd: outUsd != null ? outUsd - costUsd : null,
          leftToken: row.left_token || null, leftAmount: row.left_amount || '0', leftUsd: (row.left_quote || 0) * k,
          leftSymbol: row.left_token ? (toks.get(row.left_token)?.symbol || null) : null,
          leftDec: row.left_token ? (toks.get(row.left_token)?.decimals ?? 18) : 18,
        },
        events, notes, ethUsd: engine.ethUsd,
      };
    },
    // Statistik pool (DexScreener) dan lilin harga (GeckoTerminal) untuk halaman detail.
    'GET /api/market': async (req, url) => {
      const pool = String(url.searchParams.get('pool') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(pool)) return { error: 'pool tidak valid' };
      const tf = TF[url.searchParams.get('tf')] ? url.searchParams.get('tf') : '1h';
      const token = String(url.searchParams.get('token') || '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') || 300);
      const before = Number(url.searchParams.get('before')) || null;
      // Halaman token memakai harga USD; halaman posisi memakai harga dalam aset
      // kuotasi pool supaya sejajar dengan rentang tick.
      const currency = url.searchParams.get('currency') === 'usd' ? 'usd' : 'token';
      const [pair, ohlcv] = await Promise.all([
        url.searchParams.get('pair') === '0' ? null : market.pair(pool),
        market.candles(pool, tf, { limit, token: /^0x[0-9a-f]{40}$/.test(token) ? token : null, before, currency }),
      ]);
      return { pair, ohlcv, tfs: Object.keys(TF) };
    },
    // Detail satu token: metadata, semua pool-nya (DexScreener), posisi bot yang
    // memakainya, posisi wallet yang pernah diriset, dan gerakan target di token itu.
    'GET /api/token': async (req, url) => {
      const a = String(url.searchParams.get('a') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat token tidak valid' };
      const market$ = market.token(a).catch((e) => ({ error: e.message }));
      let meta = QUOTES[a] ? { address: a, symbol: QUOTES[a].symbol, name: a === ADDR_NATIVE ? 'Ether' : null, decimals: QUOTES[a].decimals } : null;
      meta = store.get('SELECT address,symbol,name,decimals FROM tokens WHERE address=?', a) || meta;
      const mk = await market$;
      // Belum pernah terlihat di chain: baca metadatanya hanya kalau DexScreener
      // mengenalnya sebagai token — alamat wallet tidak boleh masuk tabel tokens.
      if (!meta && mk?.pairs?.length) meta = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
      if (!meta) {
        const hit = mk?.pairs?.[0];
        const side = hit?.base.address === a ? hit.base : hit?.quote.address === a ? hit.quote : null;
        if (!side) return { error: 'token tidak dikenal — belum pernah terlihat di chain maupun DexScreener' };
        meta = { address: a, symbol: side.symbol, name: side.name, decimals: null };
      }

      const rows = await lpRows('token0=? OR token1=?', [a, a]);
      // Saldo wallet bot untuk token ini (kalau wallet terpasang).
      let balance = null;
      if (engine.exec.address() && meta.decimals != null) {
        try {
          const raw = (await engine.exec.balances([a])).get(a) || 0n;
          balance = { raw: raw.toString(), amount: Number(raw) / 10 ** meta.decimals };
        } catch { /* saldo tidak terbaca: bagian itu disembunyikan */ }
      }

      return {
        token: { ...meta, isQuote: !!QUOTES[a] },
        market: mk, balance, ...rows, ethUsd: engine.ethUsd,
      };
    },
    // Detail satu pool (pasangan) — padanan halaman pair DexScreener: token-tokennya,
    // harga kini dari chain, posisi bot di pool ini beserta PnL, posisi wallet yang
    // diriset, dan gerakan target. Pool yang belum pernah tersentuh bot/riset tetap
    // bisa dibuka selama DexScreener mengenalnya.
    'GET /api/pool': async (req, url) => {
      const ref = String(url.searchParams.get('ref') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(ref)) return { error: 'pool tidak valid' };
      const cols = 'pool_ref, venue, token0, token1, fee, tick_spacing, hooks';
      let pool = store.get(`SELECT ${cols} FROM pools WHERE pool_ref=?`, ref)
        || store.get(`SELECT ${cols} FROM positions WHERE pool_ref=? LIMIT 1`, ref)
        || store.get(`SELECT ${cols} FROM wpositions WHERE pool_ref=? LIMIT 1`, ref)
        || store.get(`SELECT ${cols} FROM actions WHERE pool_ref=? LIMIT 1`, ref);
      if (!pool) {
        const pr = await market.pair(ref);
        if (!pr || pr.error) return { error: 'pool tidak dikenal — belum tersentuh bot/riset dan belum terindeks DexScreener' };
        // DexScreener memakai urutan dasar/kuotasi; Uniswap mengurutkan menurut alamat.
        const [t0, t1] = [pr.base.address, pr.quote.address].sort();
        pool = { pool_ref: ref, venue: ref.length === 42 ? 'v3' : 'v4', token0: t0, token1: t1, fee: null, tick_spacing: null, hooks: null };
      }
      const [m0, m1] = await chain.tokens([pool.token0, pool.token1]).catch(() => [QUOTES[pool.token0], QUOTES[pool.token1]]);
      const quoteSide = quoteSideOf(pool.token0, pool.token1);
      // Harga kini: v4 = poolId (32 byte) dibaca dari PoolManager, v3 = alamat pool.
      let slot = null;
      try { slot = ref.length === 66 ? (await chain.slot0V4Many([ref]))[0] : await chain.slot0V3(ref); } catch { /* tanpa harga kini */ }
      const rows = await lpRows('pool_ref=?', [ref]);
      // Rentang posisi riset yang masih terbuka digambar terhadap harga kini. Yang
      // sudah membawa tick dari penilaian ulang dibiarkan — itu tick yang dipakai
      // menghitung nilainya, jadi bar dan angkanya bercerita tentang saat yang sama.
      for (const w of rows.wallets) if (w.status === 'open') w.curTick ??= slot?.tick ?? null;
      return {
        pool: {
          ...pool, venue: String(pool.venue || '').replace('pool', ''),
          symbol0: QUOTES[pool.token0]?.symbol || m0?.symbol || '?', symbol1: QUOTES[pool.token1]?.symbol || m1?.symbol || '?',
          dec0: QUOTES[pool.token0]?.decimals ?? m0?.decimals ?? 18, dec1: QUOTES[pool.token1]?.decimals ?? m1?.decimals ?? 18,
          quoteSide, baseToken: quoteSide === 0 ? pool.token1 : pool.token0,
          curTick: slot?.tick ?? null, curSqrt: slot?.sqrtPriceX96 != null ? slot.sqrtPriceX96.toString() : null,
        },
        ...rows, ethUsd: engine.ethUsd,
      };
    },
    'GET /api/targets': () => {
      const rows = store.all('SELECT * FROM targets ORDER BY added_ts');
      const ours = pnlByTarget();
      for (const r of rows) {
        // hasil posisi kita yang disalin dari wallet ini (USD)
        const o = ours.get(r.address);
        r.ours = o ? { open: o.open, value: o.value, upnl: o.upnl, closed: o.closed, wins: o.wins, realized: o.realized } : null;
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
    // Umpan untuk peringatan "target membuka posisi" di dasbor (toast + suara).
    // Dipoll tiap beberapa detik, jadi sengaja ringan: panggilan pertama (tanpa
    // `after`) cuma mengembalikan id terakhir sebagai titik awal, supaya membuka
    // dasbor tidak memutar ulang semua riwayat. Aksi lama yang baru tercatat —
    // backfill setelah mesin mati — disaring lewat umurnya, bukan id-nya.
    'GET /api/feed': (req, url) => {
      const lastId = store.get('SELECT COALESCE(MAX(id),0) AS id FROM actions')?.id || 0;
      const raw = url.searchParams.get('after');
      if (raw == null || !Number.isFinite(Number(raw))) return { lastId, items: [] };
      const rows = store.all(`
        SELECT a.id, a.ts, a.target, a.venue, a.token_id, a.token0, a.token1, a.fee, a.tick_lower, a.tick_upper,
               a.value_quote, a.quote_symbol, d.verdict, d.reason, d.position_id,
               EXISTS(SELECT 1 FROM actions b WHERE b.target = a.target AND b.token_id = a.token_id
                      AND b.kind = 'increase' AND b.id < a.id) AS adding
        FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
        WHERE a.id > ? AND a.kind = 'increase' AND a.ts > ?
        ORDER BY a.id LIMIT 20`, Number(raw), Date.now() - 15 * 60_000);
      const toks = new Map(store.all('SELECT address,symbol FROM tokens').map((t) => [t.address, t.symbol]));
      const labels = new Map(store.all('SELECT address,label FROM targets').map((t) => [t.address, t.label]));
      const items = rows.map((r) => ({
        id: r.id, ts: r.ts, target: r.target, targetLabel: labels.get(r.target) || null,
        venue: r.venue, fee: r.fee, adding: !!r.adding,
        token0: r.token0, token1: r.token1, symbol0: toks.get(r.token0) || null, symbol1: toks.get(r.token1) || null,
        valueUsd: r.value_quote == null ? null
          : r.value_quote * (r.quote_symbol === 'ETH' || r.quote_symbol === 'WETH' ? engine.ethUsd : 1),
        verdict: r.verdict || null, reason: r.reason || null, positionId: r.position_id || null,
      }));
      return { lastId, items };
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
      // Token hasil tutup posisi yang masih dipegang dinilai ulang di harga pool
      // SEKARANG tiap kali halaman dibuka — angkanya hidup sampai tokennya dijual.
      for (const r of rows) { r.dec0 = toks.get(r.token0)?.decimals ?? 18; r.dec1 = toks.get(r.token1)?.decimals ?? 18; }
      try { await research.proceeds.refreshHeld(rows, engine.ethUsd); } catch { /* pakai nilai tersimpan */ }
      // Posisi yang masih berjalan dinilai di harga pool SEKARANG. Halaman ini memicu
      // pindai ulang hanya kalau risetnya sudah basi 5 menit, dan pindai itu berjalan
      // di latar — tanpa penilaian ulang di sini, nilai & fee yang tampil bisa jauh
      // lebih tua daripada halamannya sendiri.
      try { await research.refreshOpen(rows, engine.ethUsd); } catch { /* pakai nilai tersimpan */ }
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
        // Posisi tertutup: bagian PnL yang sudah jadi uang vs token yang masih dipegang.
        realizedPnl: r.status === 'closed' && r.realized_q != null ? r.realized_q - (r.invested_q || 0) : null,
        heldUnrealized: r.status === 'closed' && r.held_tok && r.held_tok !== '0' ? (r.unrealized_q || 0) : 0,
        heldTok: r.status === 'closed' && r.held_tok && r.held_tok !== '0'
          ? Number(BigInt(r.held_tok)) / 10 ** (quoteSideOf(r.token0, r.token1) === 0 ? (toks.get(r.token1)?.decimals ?? 18) : (toks.get(r.token0)?.decimals ?? 18)) : 0,
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
      // Baris yang sudah dinilai ulang membawa tick-nya sendiri; yang dibaca di sini
      // tinggal sisanya (pool yang gagal dibaca, atau posisi yang penilaiannya dilewat).
      const byPool = new Map();
      const need = open.filter((r) => r.curTick == null && r.pool_ref);
      const idV4 = [...new Set(need.filter((r) => r.venue !== 'v3').map((r) => r.pool_ref))];
      if (idV4.length) {
        try {
          const slots = await chain.slot0V4Many(idV4);
          idV4.forEach((id, i) => byPool.set(id, slots[i]));
        } catch { /* harga kini tidak terbaca: bar tetap tampil tanpa penanda */ }
      }
      for (const a of [...new Set(need.filter((r) => r.venue === 'v3').map((r) => r.pool_ref))]) {
        try { byPool.set(a, await chain.slot0V3(a)); } catch { /* sama */ }
      }
      for (const r of need) r.curTick = byPool.get(r.pool_ref)?.tick ?? null;

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

    // Isi wallet (portofolio) — token yang dipegang + nilai USD-nya. Untuk wallet
    // mana pun, bukan hanya milik bot; dipakai halaman detail target.
    'GET /api/wallet/holdings': async (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      const hit = holdingsCache.get(addr);
      if (hit && url.searchParams.get('refresh') !== '1' && Date.now() - hit.ts < 60_000) return hit.data;
      const tokens = await holdings.of(addr);
      await Promise.all(tokens.map(async (x) => {
        x.priceUsd = x.amount > 0 ? await usdPrice(x.address) : null;
        x.usd = x.priceUsd != null ? x.amount * x.priceUsd : null;
      }));
      const totalUsd = tokens.reduce((a, x) => a + (x.usd || 0), 0);
      for (const x of tokens) x.sharePct = totalUsd > 0 && x.usd != null ? (x.usd / totalUsd) * 100 : null;
      // Bernilai dulu (besar ke kecil), lalu yang harganya tidak ditemukan.
      tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
      const data = { address: addr, tokens, totalUsd, unpricedN: tokens.filter((x) => x.amount > 0 && x.usd == null).length, ts: Date.now() };
      holdingsCache.set(addr, { ts: data.ts, data });
      return data;
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
      }).then(async (pools) => {
        if (!pools.some(bisaDimasuki)) job.lainnya = await manual.pasarLain(token);
        job.pools = pools; job.status = 'selesai'; job.finishedAt = Date.now();
      })
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
      const bisa = j.pools.filter(bisaDimasuki);
      const semua = url.searchParams.get('all') === '1';
      const list = semua ? j.pools : (bisa.length ? bisa : j.pools.filter((p) => p.quoteSide != null));
      return { ...out, pools: list, total: j.pools.length, hidden: j.pools.length - list.length, lainnya: j.lainnya || null };
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
    // ?usd=1: sertakan harga & nilai USD tiap token bersaldo (dasbor). Bot Telegram
    // memanggil tanpa itu supaya tidak ikut menunggu DexScreener.
    'GET /api/manual/tokens': async (req, url) => {
      const tokens = await manual.held();
      if (url.searchParams.get('usd') === '1') {
        await Promise.all(tokens.map(async (x) => {
          x.priceUsd = x.amount > 0 || x.isQuote ? await usdPrice(x.address) : null;
          x.usd = x.priceUsd != null ? x.amount * x.priceUsd : null;
        }));
      }
      return { tokens };
    },
    // Token yang ditempel lewat alamat di halaman Swap. Diperiksa dulu bahwa itu
    // memang token ERC-20 — alamat wallet/kontrak lain ditolak.
    'POST /api/manual/tokens/add': async (req) => {
      const b = await readBody(req);
      const a = String(b.address || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat harus 0x diikuti 40 karakter hex' };
      if (QUOTES[a]) return { ok: true, token: { address: a, symbol: QUOTES[a].symbol } };
      try {
        const t = await probeToken(a);
        if (t.kind !== 'token') return { error: t.kind === 'wallet' ? 'itu alamat wallet, bukan token' : 'kontrak ini bukan token ERC-20' };
        manual.addCustomToken(a);
        return { ok: true, token: { address: a, symbol: t.symbol, name: t.name, decimals: t.decimals } };
      } catch (e) { return { error: e.message }; }
    },
    'POST /api/manual/tokens/remove': async (req) => {
      const b = await readBody(req);
      manual.removeCustomToken(String(b.address || ''));
      return { ok: true };
    },
    // Riwayat swap manual terakhir, untuk panel di sebelah kartu swap.
    'GET /api/manual/swaps': () => ({
      swaps: store.all("SELECT hash, ts, status, error, detail FROM txs WHERE kind='swap_manual' ORDER BY ts DESC LIMIT 8")
        .map((r) => { let d = {}; try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* abaikan */ } return { ...r, detail: d }; }),
    }),
    // Saldo untuk langkah "Nominal" — tampil sebelum pratinjau pertama selesai dihitung.
    'GET /api/manual/saldo': async (req, url) => {
      try { return await manual.saldo(String(url.searchParams.get('poolRef') || '') || null); }
      catch (e) { return { error: e.message }; }
    },

    // Alamat yang ditempel pengguna: token (untuk dipasangi LP) atau wallet (untuk
    // diriset / dijadikan target)? Lihat probeToken.
    'GET /api/address': async (req, url) => {
      const a = String(url.searchParams.get('a') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat harus 0x diikuti 40 karakter hex' };
      const tgt = store.get('SELECT label FROM targets WHERE address=?', a);
      const riset = store.get('SELECT address FROM wallets WHERE address=?', a);
      const base = { address: a, isTarget: !!tgt, targetLabel: tgt?.label || null, researched: !!riset };
      return { ...base, ...(await probeToken(a)) };
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
    'GET /api/leftovers': () => ({ leftovers: leftoverRows() }),
    // Tanpa body: seluruh antrean. Dengan {posId, token}: satu item saja — tombol
    // "jual sekarang" di pita peringatan menembak barisnya sendiri, bukan semuanya.
    'POST /api/leftovers/retry': async (req) => {
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const b = await readBody(req).catch(() => ({}));
      const sel = leftoverKey(b);
      const list = sel.token ? engine.leftovers().filter((x) => sameLeftover(x, sel)) : engine.leftovers();
      if (!list.length) return { ok: true, tried: 0 };
      // Jadwal tunggu dilewati: ini permintaan manual, bukan percobaan otomatis.
      const pilih = new Set(list.map((x) => `${x.posId ?? ''}:${x.token}`));
      engine.saveLeftovers(engine.leftovers().map((x) => (pilih.has(`${x.posId ?? ''}:${x.token}`) ? { ...x, next: 0 } : x)));
      const errs = [];
      for (const item of list) {
        try { await engine.sellToken(item); } catch (e) { errs.push(e.message); }
      }
      return { ok: true, tried: list.length, error: errs.length ? errs.join(' · ') : null };
    },
    // Memasukkan sisa yang sudah telanjur duduk di wallet ke antrean yang sama.
    // Tidak mengirim transaksi apa pun — cuma mengutip dan mengantre.
    'POST /api/leftovers/sweep': async (req) => {
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const b = await readBody(req).catch(() => ({}));
      const min = Number(b?.minUsd);
      try { return { ok: true, ...(await engine.sweepWallet({ minUsd: Number.isFinite(min) && min >= 0 ? min : 0.5 })) }; }
      catch (e) { log(`sapu wallet: ${e.message}`); return { error: e.message }; }
    },
    'POST /api/leftovers/drop': async (req) => {
      const b = await readBody(req);
      const before = engine.leftovers().length;
      engine.dropLeftover(leftoverKey(b));
      return engine.leftovers().length < before ? { ok: true } : { error: 'tidak ada di antrean' };
    },

    'GET /api/positions/compound': (req, url) => {
      const pos = store.get('SELECT * FROM positions WHERE id=?', Number(url.searchParams.get('id')));
      return pos ? { compound: compound.status(pos) } : { error: 'posisi tidak ditemukan' };
    },
    'POST /api/positions/compound': async (req) => {
      const b = await readBody(req);
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || id <= 0) return { error: 'ID posisi tidak valid' };
      try { return { ok: true, compound: compound.configure(id, b) }; }
      catch (e) { return { error: e.message }; }
    },
    'POST /api/positions/claim': async (req) => {
      const b = await readBody(req);
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || id <= 0) return { error: 'ID posisi tidak valid' };
      try { return await engine.claimFees(id); }
      catch (e) { return { error: e.message }; }
    },
    'POST /api/positions/close': async (req) => {
      const b = await readBody(req);
      const pos = store.get("SELECT * FROM positions WHERE id=? AND status='open'", Number(b.id));
      if (!pos) return { error: 'posisi tidak ditemukan' };
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        const r = await engine.executeExit({ venue: pos.venue, action: 'burn', full: true, liquidity: pos.liquidity, tokenId: pos.token_id }, pos);
        store.log('info', `tutup manual: ${r.note}`);
        // Hasil dibaca dari baris yang baru ditutup, dengan konversi yang sama seperti
        // GET /api/position, supaya angka di notifikasi cocok dengan halaman detail.
        const row = store.get('SELECT out_quote, cost_quote, quote_symbol FROM positions WHERE id=?', pos.id);
        const k = row?.quote_symbol === 'ETH' || row?.quote_symbol === 'WETH' ? engine.ethUsd : 1;
        const outUsd = row?.out_quote != null ? row.out_quote * k : null;
        const pnlUsd = outUsd != null && row.cost_quote != null ? outUsd - row.cost_quote * k : null;
        return { ok: true, tx: r.txHash, outUsd, pnlUsd, sold: r.sold || null };
      } catch (e) {
        store.log('error', `tutup manual #${pos.id} gagal: ${e.message}`);
        return { error: e.message };
      }
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
      // Aset vendor dan favicon boleh lewat supaya halaman login bisa tampil rapi.
      const isVendor = url.pathname.startsWith('/vendor/') || url.pathname === '/favicon.svg';
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
    // tampilan lama di public/. /vendor/* dan favicon selalu dari public/ (dipakai
    // halaman masuk juga).
    const dist = path.join(__dirname, '..', 'web', 'dist');
    const useDist = fs.existsSync(path.join(dist, 'index.html'));
    const isVendor = url.pathname.startsWith('/vendor/') || url.pathname === '/favicon.svg';
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
    const immutable = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/');
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
