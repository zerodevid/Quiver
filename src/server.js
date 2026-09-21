'use strict';
const { ensureChain } = require('./networks');
// API HTTP + penyaji dashboard.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { rulesFor, DEFAULTS, validateRules } = require('./policy');
const { scoutWallet } = require('./scout');
const { WalletResearch, summarize } = require('./wallet');
const { createSettingsRoutes } = require('./settings');
const { Manual } = require('./manual');
const { Compound } = require('./compound');
const { Holdings } = require('./holdings');
const { Icons } = require('./icons');
const { Market, TF } = require('./market');
const { Positions } = require('./positions');
const { Costs, swapCostOf } = require('./costs');
const { writeCfg } = require('./env');
const shareCard = require('./share-card');
const chartCard = require('./chart-card');
const portfolioCard = require('./portfolio-card');
const { breakEven } = require('./breakeven.mjs');


// Harga token spekulatif dalam aset kuotasi — salinan rumus web/src/fmt.js, dipakai
// kartu grafik (rentang posisi, harga masuk/keluar) supaya angkanya sama dengan dasbor.
const tickPriceOf = (tick, dec0, dec1, quoteSide) => {
  if (tick == null) return null;
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
};
const sqrtPriceOf = (sqrtX96, dec0, dec1, quoteSide) => {
  if (!sqrtX96) return null;
  const r = Number(sqrtX96) / 2 ** 96;
  const p1per0 = r * r * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
};

const crypto = require('node:crypto');

// Halaman masuk: dirender server, mandiri (tanpa Tabler — 400 KB CSS untuk satu
// form), dan mengikuti bahasa desain dasbor React: Inter, kartu datar bergaris,
// tema terang/gelap. Tema dibaca dari localStorage 'lpcopy-theme' (kunci yang sama
// dengan dasbor) sebelum gambar pertama supaya tidak berkedip; kalau belum ada,
// ikut preferensi sistem. Logo = salinan transparan public/logo.svg (diletakkan inline
// supaya tidak ada permintaan tambahan sebelum kartu tampil).
const LOGIN_MARK = `<svg width="198" height="36" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 48" role="img" aria-label="QUIVER"><g fill="currentColor" fill-rule="evenodd"><path d="M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0ZM43 11L51 3L73 24L51 46L43 38L56 24Z"/><path d="M99 9C88 9 82 15 82 24S88 39 99 39C102 39 105 38 107 37L113 43L118 38L112 32C114 30 115 27 115 24C115 15 109 9 99 9ZM99 15C105 15 108 18 108 24S105 33 99 33S89 30 89 24S93 15 99 15Z M120 10H127V27C127 31 130 33 134 33S141 31 141 27V10H148V27C148 35 143 39 134 39S120 35 120 27Z M154 10H161V38H154Z M166 10H174L183 31L192 10H200L187 38H179Z M204 10H229V16H211V21H227V27H211V32H229V38H204Z M234 10H250C258 10 262 14 262 20C262 24 260 27 256 28L264 38H255L248 29H241V38H234ZM241 16V23H249C253 23 255 22 255 20S253 16 249 16Z"/></g></svg>`;

const LOGIN_CSS = `
@font-face{font-family:Inter;src:url(/fonts/inter-var-latin.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light;--bg:oklch(.975 .003 286);--surface:#fff;--fg:oklch(.2 .006 286);--muted:oklch(.5 .006 286);--border:oklch(.885 .004 286);--field-border:oklch(.7 .005 286);--accent:oklch(.55 .175 257);--accent-fg:#fff;--danger:oklch(.545 .185 27);--gold:#B8892A}
:root.dark{color-scheme:dark;--bg:oklch(.165 .005 286);--surface:oklch(.215 .006 286);--fg:oklch(.94 .004 286);--muted:oklch(.66 .006 286);--border:oklch(.29 .006 286);--field-border:oklch(.45 .006 286);--accent:oklch(.68 .16 256);--accent-fg:oklch(.15 .02 256);--danger:oklch(.71 .175 22);--gold:#D9AE45}
*{box-sizing:border-box}
html{font-size:15px;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:1.5rem 1rem;background:var(--bg);color:var(--fg);font:400 1rem/1.5 Inter,ui-sans-serif,system-ui,sans-serif;font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:
 radial-gradient(60rem 30rem at 50% -10%,color-mix(in oklab,var(--gold) 9%,transparent),transparent 70%),
 linear-gradient(color-mix(in oklab,var(--fg) 4%,transparent) 1px,transparent 1px) 0 0/100% 2.5rem,
 linear-gradient(90deg,color-mix(in oklab,var(--fg) 4%,transparent) 1px,transparent 1px) 0 0/2.5rem 100%;
 mask-image:radial-gradient(40rem 28rem at 50% 40%,#000 20%,transparent 100%);-webkit-mask-image:radial-gradient(40rem 28rem at 50% 40%,#000 20%,transparent 100%)}
.card{width:100%;max-width:22.5rem;background:var(--surface);border:1px solid var(--border);border-radius:.75rem;padding:2rem 1.75rem 1.5rem;box-shadow:0 1px 2px rgb(0 0 0/.04),0 12px 40px -12px rgb(0 0 0/.12);animation:in .35s cubic-bezier(.2,.7,.2,1) both}
.dark .card{box-shadow:0 1px 0 rgb(255 255 255/.03) inset,0 20px 50px -20px rgb(0 0 0/.6)}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
.brand{display:flex;flex-direction:column;align-items:center;gap:.875rem;text-align:center;margin-bottom:1.5rem}
.brand svg{display:block;max-width:100%;height:auto}
.brand h1{margin:0;font-size:1.25rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.brand p{margin:.25rem 0 0;color:var(--muted);font-size:.8125rem;line-height:1.45;text-wrap:balance}
label{display:block;font-size:.8125rem;font-weight:500;margin-bottom:.375rem}
.field{position:relative}
input{width:100%;height:2.625rem;padding:0 2.75rem 0 .875rem;border:1px solid var(--field-border);border-radius:.375rem;background:transparent;color:var(--fg);font:inherit;font-size:.9375rem;letter-spacing:.04em;transition:border-color .12s,box-shadow .12s}
input::placeholder{letter-spacing:0;color:var(--muted);opacity:.7}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 22%,transparent)}
input[aria-invalid=true]{border-color:var(--danger)}
input[aria-invalid=true]:focus{box-shadow:0 0 0 3px color-mix(in oklab,var(--danger) 22%,transparent)}
.eye{position:absolute;right:.375rem;top:50%;transform:translateY(-50%);width:2rem;height:2rem;display:grid;place-items:center;border:0;border-radius:.25rem;background:transparent;color:var(--muted);cursor:pointer;transition:background .12s,color .12s}
.eye:hover{background:color-mix(in oklab,var(--fg) 6%,transparent);color:var(--fg)}
.eye:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.eye svg{width:1.0625rem;height:1.0625rem}
.eye .off{display:none}.eye[aria-pressed=true] .on{display:none}.eye[aria-pressed=true] .off{display:block}
.err{display:flex;align-items:flex-start;gap:.5rem;margin:0 0 1rem;padding:.625rem .75rem;border:1px solid color-mix(in oklab,var(--danger) 28%,transparent);border-radius:.5rem;background:color-mix(in oklab,var(--danger) 7%,var(--surface));color:var(--fg);font-size:.8125rem;line-height:1.4}
.err svg{flex:none;width:1rem;height:1rem;margin-top:.1rem;color:var(--danger)}
.err b{font-weight:600}
button[type=submit]{width:100%;height:2.625rem;margin-top:1.25rem;border:0;border-radius:.375rem;background:var(--accent);color:var(--accent-fg);font:inherit;font-size:.9375rem;font-weight:600;letter-spacing:-.005em;cursor:pointer;transition:filter .12s,transform .08s}
button[type=submit]:hover{filter:brightness(1.06)}
button[type=submit]:active{transform:translateY(1px)}
button[type=submit]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin:1.25rem 0 0;padding-top:1rem;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:center;gap:.5rem;color:var(--muted);font-size:.75rem;text-align:center}
.foot svg{width:.875rem;height:.875rem;flex:none}
`;

const LOGIN_PAGE = (err) => `<!doctype html><html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quiver — masuk</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>try{var t=localStorage.getItem('lpcopy-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}</script>
<style>${LOGIN_CSS}</style></head>
<body>
<main class="card">
  <div class="brand">
    ${LOGIN_MARK}
    <div><p>Dasbor ini bisa memindahkan dana. Masukkan token akses untuk melanjutkan.</p></div>
  </div>
  ${err ? `<div class="err" role="alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><div><b>Token salah.</b> Periksa kembali lalu coba lagi.</div></div>` : ''}
  <form method="POST" action="/login">
    <label for="token">Token akses</label>
    <div class="field">
      <input id="token" type="password" name="token" placeholder="••••••••••••" autofocus required autocomplete="current-password" spellcheck="false" autocapitalize="off"${err ? ' aria-invalid="true"' : ''}>
      <button type="button" class="eye" aria-label="Tampilkan token" aria-pressed="false" onclick="var i=document.getElementById('token'),s=i.type==='password';i.type=s?'text':'password';this.setAttribute('aria-pressed',s);this.setAttribute('aria-label',s?'Sembunyikan token':'Tampilkan token');i.focus()">
        <svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a18 18 0 0 1-2.2 3.2M6.6 6.6C3.6 8.6 2 12 2 12s3.5 8 10 8c1.7 0 3.2-.4 4.5-1.1M3 3l18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
      </button>
    </div>
    <button type="submit">Masuk</button>
  </form>
  <p class="foot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Sesi tersimpan 30 hari di peramban ini.</p>
</main></body></html>`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Header keamanan untuk respons dokumen. Dasbor ini bisa menyalakan LIVE dan menutup
// posisi, jadi ia tidak boleh bisa di-frame situs lain (clickjacking): frame-ancestors
// 'none' adalah versi modern X-Frame-Options; keduanya dipasang demi peramban lama.
// nosniff mencegah MIME-sniffing. CSP di sini sengaja hanya membatasi frame-ancestors
// supaya tidak mematahkan skrip/gaya inline aplikasi & halaman masuk.
const SEC_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff' };

function createServer({ engine, store, cfg, cfgPath, chain, rpc, log, telegram, nets = null }) {
  chain = ensureChain(chain || engine?.chain);
  const pub = path.join(__dirname, '..', 'public');
  const { QUOTES } = chain;
  // Sisi mana dari pool yang merupakan aset kuotasi (0 atau 1); null kalau tidak dikenal.
  // Menentukan arah harga yang ditampilkan: selalu "harga token spekulatif dalam kuotasi".
  const quoteSideOf = (t0, t1) => (QUOTES[(t0 || '').toLowerCase()] ? 0 : QUOTES[(t1 || '').toLowerCase()] ? 1 : null);
  // Semua mesin di proses ini (satu per chain, wallet yang sama) — untuk ganti kunci.
  const engines = nets ? Object.values(nets).map((n) => n.engine) : [engine];
  // Daftar chain untuk pemilih di dasbor/Telegram.
  // Kas per chain ikut dilaporkan (USDG/USDT + native + wrapped, dalam USD) — dibaca
  // dari cache mesin tiap chain; freshCash hanya membaca ulang kalau ada tx yang baru masuk.
  const chainList = async () => Promise.all((nets ? Object.values(nets) : [{ key: chain.network, label: chain.label, chain, engine }]).map(async (n) => {
    let cash = null;
    try { cash = n.engine.freshCash ? await n.engine.freshCash() : n.engine.cash; } catch { cash = n.engine.cash || null; }
    return {
      key: n.key || n.chain.network, label: n.label || n.chain.label, chainId: n.chain.CHAIN_ID, nativeSymbol: n.chain.nativeSymbol,
      stableSymbol: n.chain.usdgSymbol,
      dryRun: n.engine.dryRun(), paused: n.engine.paused(), verified: n.chain.verified, head: n.engine.head, cursor: n.engine.cursor,
      targets: n.engine.watcher.enabledSet().size, current: n.chain.network === chain.network,
      cash: cash ? { usd: cash.usd, native: (cash.eth || 0) + (cash.weth || 0), stable: cash.usdg || 0, ts: cash.ts } : null,
    };
  }));
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
  const market = new Market({ log, chain, gmgnKey: () => cfg.gmgn?.api_key || null });
  // Ongkos jalan tiap posisi (gas + selisih swap) — dihitung sekali untuk semua
  // posisi lalu di-cache sampai ada transaksi baru.
  const costs = new Costs(store, chain.network);
  // Ongkos satu posisi dalam bentuk yang dipakai dasbor & Telegram: gas + selisih
  // swap, dipisah saat membuka dan saat menutup, plus porsinya terhadap modal —
  // "seberapa besar effort-nya" baru berarti kalau dibandingkan dengan modalnya.
  const costOf = (id, costUsd = null) => {
    const { hashes, ...c } = costs.of(id, engine.ethUsd);
    return { ...c, pctOfCost: costUsd > 0 ? (c.totalUsd / costUsd) * 100 : null };
  };

  // Antrean memecoin sisa yang belum terjual, dengan simbol & desimal supaya dasbor
  // bisa menulis "688 rb DRIPPYPIGEON". Ikut di /api/overview: peringatannya
  // harus tampil di SEMUA halaman, bukan cuma kalau kebetulan membuka Posisi.
  const leftoverRows = () => {
    const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
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
    const pairs = mk?.pairs || [];
    const asBase = pairs.find((p) => p.priceUsd && p.base.address === a);
    if (asBase) return asBase.priceUsd;
    // Token yang hanya muncul sebagai sisi kuotasi pool: harga USD base dibagi harga
    // base dalam token ini (priceNative) = harga token ini.
    const asQuote = pairs.find((p) => p.priceUsd && p.priceNative && p.quote.address === a);
    return asQuote ? asQuote.priceUsd / asQuote.priceNative : null;
  };

  // Portofolio satu wallet, dengan cache: token bersaldo + nilai USD-nya. Dipakai
  // panel "Isi wallet" dan ringkasan saldo di daftar target — keduanya dipoll, dan
  // tiap hitungan berarti puluhan eth_call + DexScreener.
  const holdingsOf = async (addr, { refresh = false, maxAge = 60_000 } = {}) => {
    const hit = holdingsCache.get(addr);
    if (hit && !refresh && Date.now() - hit.ts < maxAge) return hit.data;
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
    // Totalnya ikut disimpan: daftar target harus bisa menunjukkan kas tiap wallet
    // segera setelah bot dinyalakan ulang, tanpa menunggu pindai chain lebih dulu.
    store.setState(`held_usd:${addr}`, JSON.stringify({ usd: totalUsd, ts: data.ts }));
    return data;
  };

  // Uang target: kas di wallet + nilai posisi LP yang masih terbuka. Wallet yang
  // sisanya tinggal beberapa puluh dolar biasanya sudah berhenti nge-LP — daftar
  // target memakai angka ini untuk menandainya, tanpa perlu membuka satu per satu.
  const CASH_TTL_MS = 10 * 60_000;
  let cashBusy = null;
  const cashOf = (addr) => {
    const hit = holdingsCache.get(addr);
    if (hit) return { usd: hit.data.totalUsd, ts: hit.data.ts };
    try {
      const s = JSON.parse(store.getState(`held_usd:${addr}`, 'null'));
      return s && Number.isFinite(s.usd) ? { usd: s.usd, ts: s.ts || null } : null;
    } catch { return null; }
  };
  // Satu wallet per panggilan, yang paling basi lebih dulu: /api/targets dipoll tiap
  // 15 detik dan satu pindai portofolio memakan puluhan eth_call — menyegarkan semua
  // target sekaligus akan kena 429 dan menyeret seluruh dasbor.
  const sweepTargetCash = (addrs) => {
    if (cashBusy) return;
    const stale = addrs.map((a) => ({ a, c: cashOf(a) })).filter((x) => Date.now() - (x.c?.ts || 0) > CASH_TTL_MS);
    if (!stale.length) return;
    stale.sort((x, y) => (x.c?.ts || 0) - (y.c?.ts || 0));
    cashBusy = stale[0].a;
    holdingsOf(cashBusy, { refresh: true })
      .catch((e) => log(`saldo target ${cashBusy}: ${e.message}`))
      .finally(() => { cashBusy = null; });
  };

  // Satu pintu untuk semua pemindaian wallet: tombol di dasbor, pembaruan otomatis
  // saat halaman dibuka, dan pembaruan saat target terdeteksi beraksi. Satu wallet
  // hanya boleh punya satu pekerjaan berjalan.
  //   mode 'full'    — bangun ulang semua posisi di jendela `blocks`
  //   mode 'refresh' — hanya blok sejak pindai terakhir + posisi yang masih terbuka
  const startWalletJob = (addr, { mode = 'full', blocks = 900_000, reason = null, force = false } = {}) => {
    if (walletJobs.get(addr)?.status === 'jalan') return walletJobs.get(addr);
    const job = { status: 'jalan', mode, reason, phase: 'mulai', progress: 0, done: 0, total: 0, startedAt: Date.now(), error: null };
    walletJobs.set(addr, job);
    const onProgress = (p) => {
      job.phase = p.phase; job.done = p.scanned; job.total = p.total;
      job.progress = p.total ? Math.round((p.scanned / p.total) * 100) : 0;
    };
    const run = mode === 'refresh'
      ? research.refresh(addr, { ethUsd: engine.ethUsd, onProgress })
      : research.scan(addr, { blocks, ethUsd: engine.ethUsd, onProgress, force });
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
      if (!store.get('SELECT 1 FROM wallets WHERE chain=? AND address=?', chain.network, target)) continue;
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

  // HTTPS? Di balik Cloudflare/reverse-proxy koneksi ke Node bisa HTTP, tapi
  // protokol asli ke peramban ada di X-Forwarded-Proto. Dipakai untuk menandai
  // cookie sesi `Secure`: token ini bisa memindahkan dana, jadi tidak boleh ikut
  // terkirim di koneksi HTTP polos.
  const isHttps = (req) => !!req.socket?.encrypted
    || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  // Satu-satunya tempat string cookie sesi dibentuk — dipakai halaman /login dan
  // rotasi token (lewat sessionCookie yang dioper ke rute Pengaturan).
  const sessionCookie = (req, token) =>
    `lpcopy_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps(req) ? '; Secure' : ''}`;
  // Tombol keluar: cookie yang sama dikosongkan dan langsung kedaluwarsa.
  const clearCookie = (req) => `lpcopy_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
  // IP klien untuk rem laju login: di balik Cloudflare IP asli ada di header, bukan
  // di soket (yang selalu Cloudflare/loopback).
  const clientIp = (req) => req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || '?';
  // Rem laju login: 10 gagal per IP menutup /login 5 menit. Token 144-bit acak sudah
  // tak realistis ditebak, ini cuma menutup celah kalau dasbor terekspos.
  const loginHits = new Map();
  const loginBlocked = (ip) => { const e = loginHits.get(ip); return !!e && e.until > Date.now() && e.n >= 10; };
  const loginFail = (ip) => {
    const now = Date.now(); const e = loginHits.get(ip);
    loginHits.set(ip, { n: (e && e.until > now ? e.n : 0) + 1, until: now + 5 * 60_000 });
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
  const icons = new Icons({ store, chain, dir: dbPath ? path.join(path.dirname(dbPath), 'icons') : path.join(require('node:os').tmpdir(), 'lpcopy-icons'), log });
  if (dbPath) {
    const warmIcons = () => { try { const n = icons.warm(); if (n) log(`logo: mengambil ${n} logo token dari GeckoTerminal`); } catch (e) { log(`logo: ${e.message}`); } };
    setTimeout(warmIcons, 15_000).unref?.();
    setInterval(warmIcons, 30 * 60_000).unref?.();
  }

  // Pool hasil pindai yang benar-benar bisa dimasuki: berpasangan aset kuotasi,
  // berlikuiditas, dan fee-nya bisa dinilai di muka.
  const bisaDimasuki = (p) => p.quoteSide != null && p.kosong !== true && !p.dynamicFee;

  // Menang/kalah dinilai dari hasil − modal − selisih swap (slippage buka & tutup):
  // slippage adalah harga yang benar-benar hilang di posisi itu, jadi minus karena
  // slippage tetap kalah. Gas TIDAK ikut — posisi yang hasilnya = modal dan cuma
  // membayar gas bukan kalah, melainkan impas. Di bawah satu sen dianggap impas.
  const FLAT = 0.01;
  const hasilBersih = (p) => p.pnl - (costs.of(p.id, engine.ethUsd).slipUsd || 0);

  // Hasil posisi KITA per sumber: target yang disalin, atau '' untuk posisi manual /
  // di luar bot. Terealisasi = posisi tertutup (out − modal); berjalan = PnL live
  // posisi terbuka (sudah termasuk fee yang pernah diklaim). Dipakai halaman Target
  // dan kartu "per sumber" di Overview supaya angkanya sama persis.
  const pnlByTarget = (closed) => {
    const eth = engine.ethUsd;
    const k = (q) => (chain.isEthLike(q) ? eth : 1);
    closed ??= store.all("SELECT target, cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed' AND closed_ts IS NOT NULL", chain.network)
      .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
    const live = new Map(engine.positions.live.map((p) => [p.id, p]));
    const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
    const by = new Map();
    const grp = (t) => {
      const key = t || '';
      if (!by.has(key)) by.set(key, { target: key || null, label: key ? labels.get(key) || null : null, open: 0, value: 0, upnl: 0, closed: 0, wins: 0, losses: 0, realized: 0 });
      return by.get(key);
    };
    for (const r of store.all("SELECT id, target, cost_quote, quote_symbol FROM positions WHERE chain=? AND status='open'", chain.network)) {
      const l = live.get(r.id);
      if (l?.empty) continue;
      const g = grp(r.target);
      g.open++;
      g.value += l ? (l.valueUsd || 0) + (l.feeUsd || 0) : (r.cost_quote || 0) * k(r.quote_symbol);
      g.upnl += l?.pnlUsd || 0;
    }
    for (const p of closed) {
      const g = grp(p.target);
      const h = hasilBersih(p);
      g.closed++; g.realized += p.pnl; if (h > FLAT) g.wins++; else if (h < -FLAT) g.losses++;
    }
    return by;
  };

  // Posisi bot, posisi wallet hasil riset, dan gerakan target yang cocok dengan satu
  // syarat SQL (mis. "token0=? OR token1=?" atau "pool_ref=?") — bahan halaman
  // detail token dan detail pool, supaya keduanya menghitung PnL dengan cara sama.
  const lpRows = async (cond, args) => {
    const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
    const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
    const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
    const kOf = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);

    // Label wallet: dipakai kolom sumber posisi bot (wallet target yang disalin),
    // kolom wallet posisi riset, dan kolom target di gerakan target.
    const labels = new Map(store.all('SELECT address,label FROM wallets WHERE chain=?', chain.network).map((w) => [w.address, w.label]));
    for (const t of store.all('SELECT address,label FROM targets WHERE chain=?', chain.network)) if (t.label) labels.set(t.address, t.label);

    // Posisi bot. Yang terbuka dari hasil sinkron terakhir (nilai & PnL kini).
    // targetLabel ditempel di salinan barisnya, bukan di objek live milik engine.
    const live = new Map(engine.positions.live.map((p) => [p.id, p]));
    const mine = store.all(`SELECT * FROM positions WHERE chain=? AND (${cond}) AND status IN ('open','closed')
      ORDER BY COALESCE(closed_ts, opened_ts) DESC LIMIT 200`, chain.network, ...args);
    const open = [], closed = [];
    for (const r of mine) {
      if (r.status === 'open') {
        const l = live.get(r.id);
        if (l?.empty) continue;
        const targetLabel = labels.get(r.target) || null;
        open.push(l ? { ...l, targetLabel } : {
          ...r, targetLabel, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
          quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), curTick: null, inRange: null,
          costUsd: (r.cost_quote || 0) * kOf(r.quote_symbol), valueUsd: (r.cost_quote || 0) * kOf(r.quote_symbol), feeUsd: 0, pnlUsd: 0, pnlPct: 0,
          ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        });
      } else {
        const cost = (r.cost_quote || 0) * kOf(r.quote_symbol), out = (r.out_quote || 0) * kOf(r.quote_symbol);
        closed.push({ ...r, targetLabel: labels.get(r.target) || null, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
          quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), exitSqrt: r.exit_sqrt || null,
          costUsd: cost, outUsd: out, pnlUsd: out - cost, pnlPct: cost > 0 ? ((out - cost) / cost) * 100 : null,
          ageHours: ((r.closed_ts || Date.now()) - (r.opened_ts || Date.now())) / 3600000 });
      }
    }

    // Posisi wallet hasil riset (target maupun wallet lain yang pernah dipindai).
    const targets = new Set(store.all('SELECT address FROM targets WHERE chain=?', chain.network).map((t) => t.address));
    // liquidity & returned_q ikut dibaca karena penilaian ulang di bawah memerlukannya:
    // tanpa liquidity posisi v3 tak bisa dinilai, dan tanpa returned_q penarikan yang
    // sudah masuk kantong hilang dari PnL-nya.
    const wallets = store.all(`SELECT wallet, venue, token_id, pool_ref, token0, token1, fee, tick_lower, tick_upper, status,
        opened_ts, closed_ts, liquidity, invested_q, returned_q, live_value_q, live_fee_q, fees_q, pnl_q, incomplete
      FROM wpositions WHERE chain=? AND (${cond}) ORDER BY COALESCE(closed_ts, opened_ts) DESC LIMIT 300`, chain.network, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
        quoteSide: quoteSideOf(r.token0, r.token1), walletLabel: labels.get(r.wallet) || null, isTarget: targets.has(r.wallet),
        ageHours: r.opened_ts ? ((r.closed_ts || Date.now()) - r.opened_ts) / 3600000 : null }));
    // Harga pool saat masuk/keluar tiap posisi, dari kejadian yang tersimpan waktu
    // pindai — dipakai laci riwayat posisi wallet (sama seperti /api/wallet).
    if (wallets.length) {
      const want = new Set(wallets.map((r) => `${r.wallet}:${r.token_id}`));
      const owners = [...new Set(wallets.map((r) => r.wallet))];
      const firstLast = new Map();
      for (const e of store.all(`SELECT wallet, token_id, sqrt_price FROM wevents WHERE chain=? AND wallet IN (${owners.map(() => '?').join(',')}) ORDER BY block`, chain.network, ...owners)) {
        const k = `${e.wallet}:${e.token_id}`;
        if (!e.sqrt_price || !want.has(k)) continue;
        const cur = firstLast.get(k);
        if (!cur) firstLast.set(k, { entry: e.sqrt_price, exit: e.sqrt_price }); else cur.exit = e.sqrt_price;
      }
      for (const r of wallets) {
        const fl = firstLast.get(`${r.wallet}:${r.token_id}`);
        r.entrySqrt = fl?.entry || null;
        r.exitSqrt = r.status === 'closed' ? (fl?.exit || null) : null;
      }
    }
    // Posisi wallet yang masih terbuka dinilai ulang di harga sekarang. Angka tersimpan
    // berasal dari pemindaian terakhir wallet itu — tanpa ini, tabel riset dan tabel
    // posisi bot di halaman yang sama bisa menunjukkan arah PnL yang berlawanan untuk
    // pool dan rentang yang sama, hanya karena keduanya diukur di waktu yang berbeda.
    try { await research.refreshOpen(wallets, engine.ethUsd); }
    catch (e) { log(`nilai posisi riset terbuka: ${e.message}`); }
    for (const r of wallets) {
      r.pnlPct = r.invested_q > 0 ? (r.pnl_q / r.invested_q) * 100 : null;
      r.dprPct = r.invested_q > 0 && r.ageHours > 0 ? (r.pnl_q / r.invested_q) * (24 / r.ageHours) * 100 : null;
    }

    // Gerakan target, dengan keputusan bot atasnya.
    const activity = store.all(`SELECT a.id, a.ts, a.target, a.venue, a.kind, a.token_id, a.pool_ref, a.token0, a.token1, a.fee,
        a.value_quote, a.quote_symbol, d.verdict, d.reason, d.position_id
      FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE a.chain=? AND (${cond.replace(/\b(token0|token1|pool_ref)\b/g, 'a.$1')}) ORDER BY a.ts DESC, a.id DESC LIMIT 100`, chain.network, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), targetLabel: labels.get(r.target) || null }));

    return { open, closed, wallets, activity };
  };

  // Pool yang sedang dibuka LP manualnya (penjaga klik ganda, lihat POST /api/manual/lp/open).
  const manualOpening = new Set();
  const routes = {
    'GET /api/overview': async () => {
      // Kas dibaca ulang kalau ada tx yang masuk blok sejak bacaan terakhir (lihat
      // Engine.freshCash) — dipanggil SEBELUM summary supaya nilai token sisa yang
      // ikut disegarkan di sana terpakai.
      const cash = await engine.freshCash();
      const s = engine.positions.summary(engine.ethUsd);
      const eq = store.all('SELECT ts,total_quote,realized_quote,fees_quote,open_positions FROM equity WHERE chain=? ORDER BY ts DESC LIMIT 500', chain.network).reverse();
      const dec = store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND d.verdict IN ('copy','dry')", chain.network)?.n || 0;
      const tot = {
        actions: store.get('SELECT COUNT(*) n FROM actions WHERE chain=?', chain.network)?.n || 0,
        copied: store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND d.verdict='copy'", chain.network)?.n || 0,
        would: dec,
        skipped: store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND d.verdict='skip'", chain.network)?.n || 0,
        errors: store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND d.verdict='error'", chain.network)?.n || 0,
      };
      const skipTop = store.all("SELECT d.reason, COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND d.verdict='skip' GROUP BY d.reason ORDER BY n DESC LIMIT 6", chain.network);
      // Total portofolio & PnL sekarang — angka yang sama dengan /api/portfolio, tapi
      // tanpa kurva/kalender, jadi cukup murah untuk ikut dipoll tiap 5 detik (judul tab).
      const value = (cash?.usd || 0) + s.exposureUsd + (s.leftoverUsd || 0) + s.feeUsd;
      const pnl = s.realizedUsd + s.unrealizedUsd;
      const capital = engine.capital?.summary?.() || null;
      const wallet = engine.positions.lastSync ? { value, pnl, netPnl: capital && cash ? value - capital.capitalUsd : null } : null;
      return {
        // auth: gerbang token menyala → dasbor menampilkan tombol keluar.
        mode: { dry_run: engine.dryRun(), paused: engine.paused(), wallet: engine.exec.address(), auth: !!tokenNow(), drawdown: engine.drawdownStatus() },
        wallet,
        chain: {
          head: engine.head, cursor: engine.cursor, lag: engine.head - engine.cursor, ethUsd: engine.ethUsd, headSpread: engine.headSpread,
          // identitas chain tampilan ini — dasbor memakainya untuk label, simbol, dan tautan penjelajah
          key: chain.network, label: chain.label, chainId: chain.CHAIN_ID, nativeSymbol: chain.nativeSymbol,
          usdgSymbol: chain.usdgSymbol, wethSymbol: chain.wethSymbol, verified: chain.verified,
          explorer: chain.explorer, dexscreener: chain.dexscreener, geckoterminal: chain.geckoterminal, gmgn: chain.gmgn, uniswap: chain.uniswap,
          venues: ['v4', ...chain.venues.map((v) => v.key)],
        },
        stats: { ...engine.stats, uptimeSec: Math.round((Date.now() - engine.stats.startedAt) / 1000), lastError: engine.lastError },
        totals: tot,
        summary: s, equity: eq, decisionsTotal: dec, skipReasons: skipTop,
        // sisa jatah salin (anggaran harian, eksposur, slot posisi, kas siap pakai)
        room: engine.copyRoom ? engine.copyRoom(cash) : null,
        rpc: rpc.stats(),
        unsupportedSenders: [...engine.watcher.unsupported.entries()].map(([a, n]) => ({ address: a, n })),
        lastSync: engine.positions.lastSync,
        leftovers: leftoverRows(), leftoverRetrySec: engine.leftoverRetrySec ? engine.leftoverRetrySec() : 5,
      };
    },
    // Portofolio milik kita: total sekarang, kurva pertumbuhan, PnL per hari, dan
    // kinerja per sumber (target yang disalin / manual). Terpisah dari /api/overview
    // karena overview dipoll tiap 5 detik — data ini cukup tiap setengah menit.
    'GET /api/portfolio': async (req, url) => {
      const SPAN = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: 0 };
      const range = url.searchParams.get('range') in SPAN ? url.searchParams.get('range') : '7d';
      const now = Date.now();
      const from = SPAN[range] ? now - SPAN[range] : 0;
      const eth = engine.ethUsd;
      const k = (q) => (chain.isEthLike(q) ? eth : 1);
      const cash = await engine.freshCash();      // sebelum summary, lihat /api/overview
      const s = engine.positions.summary(eth);
      const lo = s.leftoverUsd || 0;
      const value = (cash?.usd || 0) + s.exposureUsd + lo + s.feeUsd;
      const pnl = s.realizedUsd + s.unrealizedUsd;

      const rows = store.all(`SELECT ts, wallet_quote AS cash, positions_quote AS pos, fees_quote AS fee,
        total_quote AS total, pnl_quote AS pnl, open_positions AS n FROM equity WHERE chain=? AND ts >= ? ORDER BY ts`, chain.network, from);
      // Titik "sekarang" supaya ujung grafik sama dengan angka di kartu, bukan
      // tertinggal sampai 5 menit di belakangnya.
      if (engine.positions.lastSync) {
        rows.push({ ts: now, cash: cash ? cash.usd : null, pos: s.exposureUsd + lo, fee: s.feeUsd, total: value, pnl, n: s.openCount, live: true });
      }
      // Titik terakhir SEBELUM jendela: patokan "berubah berapa dalam rentang ini".
      const baseline = from ? store.get('SELECT ts, pnl_quote AS pnl, total_quote AS total, wallet_quote AS cash FROM equity WHERE chain=? AND ts < ? ORDER BY ts DESC LIMIT 1', chain.network, from) || null : null;
      // PnL bersih wallet = total − modal(t); modal(t) = baseline + setoran − penarikan
      // sampai t (lihat capital.js). Titik ekuitas tanpa kas (NULL) tidak punya total
      // yang sah, jadi bersihnya juga tidak dihitung.
      const capital = engine.capital?.summary?.() || null;
      if (capital) {
        const deps = engine.capital.rows();
        const capAt = (ts) => capital.baselineUsd + deps.filter((d) => d.ts <= ts).reduce((a, d) => a + (d.kind === 'deposit' ? d.usd : -d.usd), 0);
        // Titik "sekarang" pun tanpa kas tidak sah: sesaat setelah restart kas belum
        // terbaca, total = posisi saja, dan ujung grafik anjlok sebesar seluruh kas.
        for (const r of rows) r.net = r.cash == null ? null : r.total - capAt(r.ts);
        if (baseline) baseline.net = baseline.cash == null ? null : baseline.total - capAt(baseline.ts);
      }
      // Tertinggi/terendah/drawdown dari SEMUA titik, sebelum dijarangkan: titik yang
      // dibuang penjarangan bisa saja puncak atau lembahnya (drawdown 7 hari terbaca
      // $70.96 padahal $73.63).
      const extremes = {};
      const keep = new Set();   // indeks titik penting yang tidak boleh dibuang penjarangan
      for (const [key, pick] of [['pnl', (r) => r.pnl], ['net', (r) => r.net], ['value', (r) => (r.cash == null ? null : r.total)]]) {
        let hi = -Infinity, lo2 = Infinity, peak = -Infinity, dd = 0, n = 0;
        let iHi = -1, iLo = -1, iPeak = -1, iDdPeak = -1, iDdTrough = -1;
        rows.forEach((r, i) => {
          const v = pick(r);
          if (v == null) return;
          n++;
          if (v > hi) { hi = v; iHi = i; }
          if (v < lo2) { lo2 = v; iLo = i; }
          if (v > peak) { peak = v; iPeak = i; }
          if (peak - v > dd) { dd = peak - v; iDdPeak = iPeak; iDdTrough = i; }
        });
        if (!n) continue;
        for (const i of [iHi, iLo, iDdPeak, iDdTrough]) if (i >= 0) keep.add(i);
        // ts puncak/lembah supaya grafik bisa menandai titik yang sama dengan angkanya
        extremes[key] = { hi, lo: lo2, dd, hiTs: rows[iHi].ts, loTs: rows[iLo].ts,
          ddPeakTs: iDdPeak >= 0 ? rows[iDdPeak].ts : null, ddTroughTs: iDdTrough >= 0 ? rows[iDdTrough].ts : null };
      }

      // Satu titik tiap 5 menit = 8.640 titik per 30 hari, jauh lebih rapat daripada
      // piksel grafiknya. Ambil titik terakhir tiap ember; titik pertama, titik
      // "sekarang", dan puncak/lembah di atas tetap ikut — tanpa itu lonjakan yang
      // menjadi "Tertinggi" atau dasar drawdown bisa hilang dari garisnya.
      const MAX = 360;
      let series = rows;
      if (rows.length > MAX + 1) {
        const step = rows.length / MAX;
        const idx = new Set([0, ...keep]);
        for (let i = 1; i <= MAX; i++) idx.add(Math.min(rows.length - 1, Math.floor(i * step) - 1));
        series = [...idx].sort((a, b) => a - b).map((i) => rows[i]);
      }

      const gasSince = (ts) => {
        const g = store.all('SELECT gas_used, gas_price FROM txs WHERE chain=? AND ts >= ? AND gas_used IS NOT NULL AND gas_price IS NOT NULL', chain.network, ts);
        const eth = g.reduce((a, t) => a + (Number(t.gas_used) * Number(BigInt(t.gas_price))) / 1e18, 0);
        return { gasUsd: eth * (engine.ethUsd || 0), gasTxCount: g.length };
      };

      // Posisi tertutup: bahan kalender (dikelompokkan per hari di browser, pakai
      // zona waktu pengguna) dan statistik menang/kalah.
      const closed = store.all("SELECT id, target, opened_ts, closed_ts, cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed' AND closed_ts IS NOT NULL ORDER BY closed_ts", chain.network)
        .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
      const pnls = closed.map((p) => p.pnl);
      // Impas (hasil = modal setelah slippage, selisihnya cuma gas) bukan kalah:
      // kalau ikut dihitung sebagai kalah, win rate jatuh padahal posisi yang
      // benar-benar rugi cuma segelintir. Win rate = menang / (menang + kalah).
      const hasil = closed.map(hasilBersih);
      const wins = hasil.filter((x) => x > FLAT).length;
      const losses = hasil.filter((x) => x < -FLAT).length;
      const holds = closed.filter((p) => p.opened_ts).map((p) => (p.closed_ts - p.opened_ts) / 3600000);

      // Per sumber: target yang disalin, atau '' untuk posisi manual / di luar bot.
      const by = pnlByTarget(closed);

      return {
        range, from, series, baseline, extremes,
        now: {
          value, cash, positionsUsd: s.exposureUsd, feeUsd: s.feeUsd, costUsd: s.costUsd,
          // memecoin sisa dari posisi yang sudah tutup, belum dijual, di harga kini
          leftoverUsd: lo,
          pnl, realizedUsd: s.realizedUsd, unrealizedUsd: s.unrealizedUsd,
          // Modal bersih ≈ yang pernah disetor: nilai sekarang dikurangi seluruh laba.
          // Tanpa saldo kas (mode tanpa wallet) tidak bisa dihitung.
          capital: cash ? value - pnl : null,
          openCount: s.openCount, inRange: s.inRange,
          // Modal nyata (baseline + setoran − penarikan) dan PnL bersih terhadapnya —
          // memuat biaya zap, gas, dan swap ETH↔USDG yang tidak ada di PnL per-posisi.
          capitalNet: capital && cash ? capital.capitalUsd : null,
          netPnl: capital && cash ? value - capital.capitalUsd : null,
          // Gas semua transaksi bot (yang gagal pun bayar gas) sejak modal mulai dicatat —
          // biaya terbesar yang ada di PnL bersih tapi tidak di PnL posisi. Dinilai di
          // harga ETH sekarang, sama seperti daftar transaksi.
          ...gasSince(capital?.baselineTs ?? 0),
        },
        capital: capital ? { ...capital, deposits: engine.capital.rows().map((d) => ({
          ts: d.ts, kind: d.kind, symbol: d.symbol, amount: Number(d.amount) / (d.symbol === chain.usdgSymbol ? 10 ** chain.usdgDecimals : 1e18), usd: d.usd, ethUsd: d.eth_usd, txHash: d.tx_hash, counterparty: d.counterparty,
        })) } : null,
        stats: {
          closedCount: closed.length, wins, losses, flat: closed.length - wins - losses,
          winRatePct: wins + losses ? (wins / (wins + losses)) * 100 : null,
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
      const closed = store.all("SELECT * FROM positions WHERE chain=? AND status='closed' ORDER BY closed_ts DESC LIMIT 100", chain.network);
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
      // Daftarnya dari basis data, angkanya dari sinkron terakhir. Dulu daftarnya
      // langsung hasil sinkron (tiap 30 detik): sesudah restart tabel kosong sampai
      // sinkron pertama selesai, posisi yang baru dimint baru muncul ~30 detik
      // kemudian, dan yang baru ditutup masih tampil. Posisi yang belum tersinkron
      // tampil dulu dengan angka modal, bertanda `syncing`.
      const live = new Map(engine.positions.live.map((p) => [p.id, p]));
      const k = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);
      const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
      const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
      // Asal tiap baris: wallet target yang disalin, dan — kalau wallet itu pernah
      // diriset — nasib posisi aslinya. Salinan kita masuk beberapa blok setelah
      // target dan keluar atas keputusan sendiri, jadi hasilnya hampir tidak pernah
      // sama; menaruh kedua angka berdampingan membuat selisihnya terbaca, bukan
      // ditebak dari dua halaman berbeda.
      const tLabel = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      const origin = (r) => {
        if (!r.target) return { targetLabel: null, mirror: null };
        const w = r.mirror_of
          ? store.get('SELECT * FROM wpositions WHERE chain=? AND wallet=? AND venue=? AND token_id=?', chain.network, r.target, r.venue, r.mirror_of)
          : null;
        // Nilai di wpositions SUDAH dalam USD (lihat WalletResearch.persist) — sisi
        // kuotasi ETH tidak boleh dikalikan harga ETH lagi: dulu target ber-kuotasi WETH
        // tampil bermodal $75 juta di kolom asal.
        return {
          targetLabel: tLabel.get(r.target) || null,
          mirror: !w ? null : {
            tokenId: w.token_id, status: w.status,
            costUsd: w.invested_q || 0,
            pnlUsd: w.pnl_q || 0,
            pnlPct: w.invested_q > 0 ? (w.pnl_q / w.invested_q) * 100 : null,
            openedTs: w.opened_ts, closedTs: w.closed_ts,
            // Posisi target yang masih terbuka bernilai sebesar pemindaian terakhir
            // wallet itu, bukan harga sekarang — UI harus mengatakannya.
            stale: w.status === 'open',
          },
        };
      };
      for (const r of closed) {
        r.symbol0 = toks.get(r.token0)?.symbol || null;
        r.symbol1 = toks.get(r.token1)?.symbol || null;
        const costUsd = (r.cost_quote || 0) * k(r.quote_symbol);
        const outUsd = (r.out_quote || 0) * k(r.quote_symbol);
        Object.assign(r, origin(r), {
          costUsd, outUsd, pnlUsd: outUsd - costUsd,
          pnlPct: costUsd > 0 ? ((outUsd - costUsd) / costUsd) * 100 : null,
          cost: costOf(r.id, costUsd),
        });
      }
      const positions = store.all("SELECT * FROM positions WHERE chain=? AND status='open' ORDER BY opened_ts", chain.network).map((r) => live.get(r.id) || {
        ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
        quoteSide: quoteSideOf(r.token0, r.token1), entrySqrt: Positions.entrySqrtOf(r), curTick: null, inRange: null,
        costUsd: (r.cost_quote || 0) * k(r.quote_symbol), valueUsd: (r.cost_quote || 0) * k(r.quote_symbol),
        feeUsd: 0, pnlUsd: 0, pnlPct: 0, ilUsd: null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        syncing: true,
      });
      // takeover_ts dibaca dari basis data, bukan hasil sinkron (bisa berumur 30 detik):
      // tombol ambil alih/kembalikan harus langsung berganti.
      const takeover = new Map(store.all("SELECT id, takeover_ts FROM positions WHERE chain=? AND status='open'", chain.network).map((r) => [r.id, r.takeover_ts]));
      return {
        positions: positions.map((p) => ({
          ...p, takeover_ts: takeover.get(p.id) ?? null, compound: compound.status(p), ...origin(p),
          cost: costOf(p.id, p.costUsd),
        })),
        closed, syncedAt: engine.positions.lastSync,
      };
    },
    // Tombol "Perbarui" di tabel posisi. Poll biasa cuma mengulang hasil sinkron
    // terakhir — yang berumur sampai 30 detik — jadi tombol yang hanya memuat ulang
    // halaman akan mengembalikan angka yang sama persis dan berbohong soal
    // kesegarannya. Di sini chain benar-benar dibaca lagi dulu, baru daftarnya
    // dikirim. Yang dibalas cuma waktu sinkronnya: daftarnya diambil pemanggil lewat
    // GET seperti biasa, supaya cuma ada satu jalan data ke tabel.
    'POST /api/positions/sync': async () => {
      // Kas dan nilai token sisa ikut dibaca ulang: tombol ini menjanjikan angka segar
      // untuk seluruh halaman, termasuk kartu total portofolio.
      const books = engine.refreshCash().then(() => engine.positions.refreshLeftovers(engine.ethUsd, engine.exec.address())).catch(() => null);
      try { await Promise.all([engine.positions.resync(engine.ethUsd), books]); }
      catch (e) { return { error: e.message, syncedAt: engine.positions.lastSync }; }
      return { ok: true, syncedAt: engine.positions.lastSync };
    },
    // Satu posisi untuk halaman detail. Yang terbuka diambil dari hasil sinkron terakhir
    // (nilai, fee, harga kini); yang sudah ditutup — atau baru dibuka dan belum
    // tersinkron — dari basis data, dihias secukupnya supaya bentuknya sama.
    'GET /api/position': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE chain=? AND id=?', chain.network, id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      // Baris yang sudah 'closed' di DB adalah kebenaran: hasil sinkron terakhir masih
      // memuat posisi itu (nilai basi) sampai sinkron berikutnya, ~30 detik setelah tutup.
      const live = row.status === 'closed' ? null : engine.positions.live.find((p) => p.id === id);
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
      const k = chain.isEthLike(row.quote_symbol) ? engine.ethUsd : 1;
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
      // hasil tarik sebagian yang sudah di wallet selagi posisi masih terbuka
      pos.withdrawnUsd = row.status === 'closed' ? 0 : (row.out_quote || 0) * k;
      pos.compound = compound.status(row);
      pos.outUsd = outUsd;
      pos.quoteKind = chain.isEthLike(row.quote_symbol) ? 'eth' : 'usd';
      pos.targetLabel = row.target ? (store.get('SELECT label FROM targets WHERE chain=? AND address=?', chain.network, row.target)?.label || null) : null;
      pos.target = row.target; pos.mirror_of = row.mirror_of; pos.takeover_ts = row.takeover_ts ?? null;
      // Token spekulatif = yang bukan aset kuotasi; dasar harga di grafik.
      pos.baseToken = pos.quoteSide === 0 ? row.token1 : pos.quoteSide === 1 ? row.token0 : row.token0;
      pos.cost = costOf(id, costUsd);
      return { position: pos, ethUsd: engine.ethUsd, syncedAt: engine.positions.lastSync };
    },
    // Riwayat satu posisi bot untuk laci detail: setiap transaksi yang menyentuhnya
    // (swap zap, mint, tambah, kurangi, tutup, jual sisa) dengan jumlah token dan nilai,
    // plus catatan bot — keputusan atas aksi target yang memicunya dan baris log yang
    // menyebut posisi ini.
    'GET /api/position/history': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE chain=? AND id=?', chain.network, id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
      const isEth = chain.isEthLike(row.quote_symbol);
      const k = isEth ? engine.ethUsd : 1;
      const parse = (d) => { try { return JSON.parse(d || '{}') || {}; } catch { return {}; } };
      const gasUsd = (t) => (t.gas_used && t.gas_price ? (Number(t.gas_used) * Number(BigInt(t.gas_price))) / 1e18 * engine.ethUsd : null);
      // Transaksi yang menyentuh posisi ini: hash buka/tutup, yang mencatat nomor posisi
      // di detailnya (tutup, jual sisa, tambah), keputusan yang menaut ke posisi ini, dan
      // zap di pool yang sama selama posisi hidup (zap tidak menyimpan nomor posisi —
      // nomornya baru ada setelah mint sukses).
      const lo = (row.opened_ts || 0) - 15 * 60_000, hi = (row.closed_ts || Date.now()) + 60_000;
      const txs = store.all(`
        SELECT * FROM txs WHERE chain = ? AND (hash IN (?, ?)
           OR json_extract(detail, '$.position') = ?
           OR json_extract(detail, '$.recorded') = ?
           OR (kind = 'increase' AND (json_extract(detail, '$.plan.positionId') = ? OR json_extract(detail, '$.plan.tokenId') = ?))
           OR EXISTS (SELECT 1 FROM json_each(txs.detail, '$.positionSales') sale WHERE json_extract(sale.value, '$.position') = ?)
           OR hash IN (SELECT tx_hash FROM decisions WHERE position_id = ? AND tx_hash IS NOT NULL)
           OR (json_extract(detail, '$.pool') = ? AND ts BETWEEN ? AND ? AND kind IN ('zap_swap', 'mint', 'increase')))
        ORDER BY ts`, chain.network, row.tx_open, row.tx_close, id, id, id, row.token_id, id, id, row.pool_ref, lo, hi);
      // Pool yang sama bisa dimasuki dua posisi berurutan (lp2 #6 dan #7 berselang 90
      // detik): mint tetangga dan zap-nya ikut tersaring lewat jendela pool. Mint/tambah
      // hanya milik posisi ini kalau memang tertaut ke nomornya. Zap: mint yang dibukukan
      // sejak `zapped.hashes` menyebut hash zap-nya persis; mint lama tanpa catatan itu
      // memakai taksiran — zap milik mint/tambah pertama yang menyusulnya di pool itu.
      // Zap yang tidak disebut mint mana pun dan tidak disusul mint kita (entry batal)
      // bukan riwayat posisi ini.
      const decByTx = new Map(store.all(`
        SELECT d.tx_hash, d.verdict, d.reason, a.kind AS action_kind, a.value_quote, a.quote_symbol
        FROM decisions d JOIN actions a ON a.id = d.action_id
        WHERE d.position_id = ? AND d.tx_hash IS NOT NULL`, id).map((d) => [d.tx_hash, d]));
      const mine = (t) => {
        if (t.hash === row.tx_open || t.hash === row.tx_close || decByTx.has(t.hash)) return true;
        const d = parse(t.detail);
        return d.position === id || d.recorded === id || !!d.positionSales?.some((s) => s.position === id)
          || (t.kind === 'increase' && (d.plan?.positionId === id || String(d.plan?.tokenId ?? '') === String(row.token_id)));
      };
      const entries = store.all(`SELECT hash, ts, kind, detail FROM txs
        WHERE chain=? AND json_extract(detail, '$.pool') = ? AND ts >= ? AND kind IN ('mint', 'increase') AND status != 'gagal' ORDER BY ts`, chain.network, row.pool_ref, lo);
      const zapHashes = new Set(entries.filter(mine).flatMap((e) => parse(e.detail).zapped?.hashes || []));
      const zapMine = (z) => {
        if (zapHashes.has(z.hash)) return true;
        const owner = entries.find((e) => e.ts >= z.ts);
        return !!owner && mine(owner) && !parse(owner.detail).zapped;
      };
      for (let i = txs.length - 1; i >= 0; i--) {
        const t = txs[i];
        if (mine(t) || (t.kind === 'zap_swap' && zapMine(t))) continue;
        txs.splice(i, 1);
      }
      const seen = new Set();
      const events = txs.filter((t) => !seen.has(t.hash) && seen.add(t.hash)).map((t) => {
        const d = parse(t.detail);
        const sw = swapCostOf(d);
        const dec = decByTx.get(t.hash);
        const sale = d.positionSales?.find((s) => s.position === id);
        const ev = {
          hash: t.hash, ts: t.ts, kind: t.kind, status: t.status, error: t.error, gasUsd: gasUsd(t),
          swap: d.tokenIn ? { tokenIn: d.tokenIn, tokenOut: d.tokenOut, symbolIn: d.symbolIn, symbolOut: d.symbolOut, amountIn: d.amountIn, amountOut: d.amountOut } : null,
          saleDeltaUsd: sale ? (sale.gotQuote - sale.closeQuote) * k : null,
          dex: d.dex || d.via || null, usdIn: d.usdIn ?? null, usdOut: d.usdOut ?? null,
          // Ongkos swap baris ini: rugi rute (kutipan masuk → kutipan keluar) plus
          // geseran harga saat eksekusi (kutipan keluar → yang benar-benar diterima).
          slipUsd: sw.route + sw.exec || null,
          slipBps: d.slipBps ?? null,
          amount0: null, amount1: null, valueUsd: null, feesUsd: null,
          reason: dec?.reason || null, verdict: dec?.verdict || null,
          // Nilai aksi target yang ditiru — konteks "kenapa sebesar ini".
          targetUsd: dec?.value_quote > 0 ? dec.value_quote * (chain.isEthLike(dec.quote_symbol) ? engine.ethUsd : 1) : null,
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
        // tarik sebagian: hasilnya dicatat sendiri, terpisah dari tutup
        if (t.kind === 'decrease' && d.decreaseProceeds) {
          ev.amount0 = d.decreaseProceeds.amount0; ev.amount1 = d.decreaseProceeds.amount1; ev.valueUsd = d.decreaseProceeds.quote * k;
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
      // Posisi terbuka: PnL-nya dari sinkron live (angka yang sama dengan tabel),
      // beserta pecahannya — nilai LP vs modal, IL vs sekadar memegang token, fee —
      // supaya laci bisa menjelaskan KENAPA minus/plus, bukan cuma angkanya.
      const live = row.status === 'closed' ? null : engine.positions.live.find((p) => p.id === id);
      const open = live ? {
        pnlUsd: live.pnlUsd, valueUsd: live.valueUsd, feeUsd: live.feeUsd, claimedUsd: live.claimedUsd,
        withdrawnUsd: live.withdrawnUsd, ilUsd: live.ilUsd, inRange: live.inRange, valueStale: !!live.valueStale,
        entryPrice: Positions.entrySqrtOf(row), curSqrt: live.curSqrt, quoteSide: live.quoteSide, dec0: live.dec0, dec1: live.dec1,
      } : null;
      return {
        position: {
          id: row.id, venue: row.venue, token_id: row.token_id, pool_ref: row.pool_ref, status: row.status,
          token0: row.token0, token1: row.token1,
          symbol0: toks.get(row.token0)?.symbol || '?', symbol1: toks.get(row.token1)?.symbol || '?',
          dec0: toks.get(row.token0)?.decimals ?? 18, dec1: toks.get(row.token1)?.decimals ?? 18,
          opened_ts: row.opened_ts, closed_ts: row.closed_ts, target: row.target, mirror_of: row.mirror_of,
          targetLabel: row.target ? (store.get('SELECT label FROM targets WHERE chain=? AND address=?', chain.network, row.target)?.label || null) : null,
          cost: costOf(id, costUsd),
          closeUsd: events.find((e) => e.hash === row.tx_close)?.valueUsd ?? null,
          swapDeltaUsd: events.some((e) => e.saleDeltaUsd != null) ? events.reduce((sum, e) => sum + (e.saleDeltaUsd || 0), 0) : null,
          costUsd, outUsd, feesUsd: (row.fees_quote || 0) * k,
          pnlUsd: outUsd != null ? outUsd - costUsd : (open?.pnlUsd ?? null),
          open,
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
      // src=gmgn: lilin dari OpenAPI GMGN (butuh API key + alamat token); kalau
      // GMGN gagal (key kosong/ditolak/limit tanpa cadangan), jatuh ke GeckoTerminal
      // dan UI diberi tahu lewat ohlcv.fallback supaya tidak diam-diam.
      const wantGmgn = url.searchParams.get('src') === 'gmgn' && /^0x[0-9a-f]{40}$/.test(token);
      const gt = () => market.candles(pool, tf, { limit, token: /^0x[0-9a-f]{40}$/.test(token) ? token : null, before, currency });
      const [pair, ohlcv] = await Promise.all([
        url.searchParams.get('pair') === '0' ? null : market.pair(pool),
        wantGmgn
          ? market.candlesGmgn(token, tf, { limit, before }).then(async (r) => (r?.error ? { ...(await gt()), fallback: r.error } : r))
          : gt(),
      ]);
      return { pair, ohlcv, tfs: Object.keys(TF), gmgn: market.gmgnEnabled() };
    },
    // Transaksi swap terakhir di pool (GeckoTerminal) — pita "running trade" di
    // bawah grafik. Wallet yang dikenal diberi nama: target yang disalin, atau bot.
    'GET /api/trades': async (req, url) => {
      const pool = String(url.searchParams.get('pool') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(pool)) return { error: 'pool tidak valid' };
      const token = String(url.searchParams.get('token') || '').toLowerCase();
      const r = await market.trades(pool, { token: /^0x[0-9a-f]{40}$/.test(token) ? token : null, limit: Number(url.searchParams.get('limit') || 80) });
      if (!r?.trades) return r;
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null]));
      const me = String(engine.exec.address() || '').toLowerCase();
      return {
        ...r,
        trades: r.trades.map((x) => ({ ...x, target: labels.has(x.wallet), label: labels.get(x.wallet) || null, mine: !!me && x.wallet === me })),
      };
    },
    // Nama wallet untuk pita transaksi yang diambil browser langsung dari
    // GeckoTerminal: wallet target yang disalin dan wallet bot sendiri.
    'GET /api/trade-labels': () => ({
      me: String(engine.exec.address() || '').toLowerCase() || null,
      targets: Object.fromEntries(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null])),
    }),
    // ---- OpenAPI GMGN (butuh API key; tanpa key semua menjawab { enabled: false }) ----
    // Profil token: info + keamanan kontrak — kartu "Menurut GMGN" dan sinyal
    // tambahan di kesehatan pool.
    'GET /api/gmgn/token': async (req, url) => {
      const a = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat token tidak valid' };
      return market.gmgnToken(a);
    },
    // Pemegang / trader teratas, dengan nama wallet yang dikenal bot.
    'GET /api/gmgn/wallets': async (req, url) => {
      const a = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat token tidak valid' };
      const kind = url.searchParams.get('kind') === 'traders' ? 'traders' : 'holders';
      const orderBy = ['amount_percentage', 'profit', 'unrealized_profit', 'buy_volume_cur', 'sell_volume_cur'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : null;
      const r = await market.gmgnWallets(a, { kind, limit: Number(url.searchParams.get('limit') || 50), orderBy });
      if (!r?.rows) return r;
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null]));
      const me = String(engine.exec.address() || '').toLowerCase();
      return { ...r, rows: r.rows.map((x) => ({ ...x, target: labels.has(x.address), label: labels.get(x.address) || null, mine: !!me && x.address === me })) };
    },
    // Statistik trading satu wallet (target / wallet riset) menurut GMGN.
    'GET /api/gmgn/wallet': async (req, url) => {
      const a = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat wallet tidak valid' };
      return market.gmgnWallet(a, { period: url.searchParams.get('period') || '7d' });
    },
    'GET /api/pool-depth': async (req, url) => {
      const ref = String(url.searchParams.get('ref') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(ref)) return { error: 'pool tidak valid' };
      return market.memo(`depth:${ref}`, 30000, () => require('./pool-depth').poolDepth({ rpc, chain, store, engine }, ref));
    },
    'GET /api/holders': async (req, url) => require('./holders').alchemyHolders(chain, market, cfg, url.searchParams.get('token')),
    // Harga pool langsung dari chain (slot0) untuk grafik realtime. Lilin GeckoTerminal
    // tertinggal hingga semenit; harga ini yang menggerakkan lilin terakhir di UI.
    // Disimpan 2,5 detik per pool: banyak tab yang membuka pool sama berbagi satu
    // eth_call, dan RPC yang dipakai bot tidak ikut terkuras.
    'GET /api/price': async (req, url) => {
      const ref = String(url.searchParams.get('pool') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(ref)) return { error: 'pool tidak valid' };
      return market.memo(`slot0:${ref}`, 2500, async () => {
        const slot = ref.length === 66 ? (await chain.slot0V4Many([ref]))[0] : await chain.slot0V3(ref);
        if (slot?.sqrtPriceX96 == null || BigInt(slot.sqrtPriceX96) === 0n) return { error: 'harga pool tidak terbaca' };
        return { pool: ref, tick: slot.tick ?? null, sqrt: slot.sqrtPriceX96.toString(), ts: Date.now() };
      });
    },
    // Detail satu token: metadata, semua pool-nya (DexScreener), posisi bot yang
    // memakainya, posisi wallet yang pernah diriset, dan gerakan target di token itu.
    'GET /api/token': async (req, url) => {
      const a = String(url.searchParams.get('a') || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'alamat token tidak valid' };
      const market$ = market.token(a).catch((e) => ({ error: e.message }));
      let meta = QUOTES[a] ? { address: a, symbol: QUOTES[a].symbol, name: a === chain.ADDR.native ? chain.nativeSymbol : null, decimals: QUOTES[a].decimals } : null;
      meta = store.get('SELECT address,symbol,name,decimals FROM tokens WHERE chain=? AND address=?', chain.network, a) || meta;
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
      let pool = store.get(`SELECT ${cols} FROM pools WHERE chain=? AND pool_ref=?`, chain.network, ref)
        || store.get(`SELECT ${cols} FROM positions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref)
        || store.get(`SELECT ${cols} FROM wpositions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref)
        || store.get(`SELECT ${cols} FROM actions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref);
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
      const rows = store.all('SELECT * FROM targets WHERE chain=? ORDER BY added_ts', chain.network);
      const ours = pnlByTarget();
      for (const r of rows) {
        // hasil posisi kita yang disalin dari wallet ini (USD)
        const o = ours.get(r.address);
        r.ours = o ? { open: o.open, value: o.value, upnl: o.upnl, closed: o.closed, wins: o.wins, losses: o.losses, realized: o.realized } : null;
        r.rulesResolved = rulesFor(cfg.rules, r.rules);
        r.rulesOwn = r.rules ? JSON.parse(r.rules) : null;
        const st = store.get('SELECT COUNT(*) n, MAX(ts) last FROM actions WHERE chain=? AND target=?', chain.network, r.address);
        r.actions = st?.n || 0; r.lastActionTs = st?.last || null;
        r.copied = store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND a.target=? AND d.verdict IN ('copy','dry')", chain.network, r.address)?.n || 0;
        const p = store.get("SELECT COUNT(*) n, COALESCE(SUM(cost_quote),0) cost FROM positions WHERE chain=? AND target=? AND status='open'", chain.network, r.address);
        r.openPositions = p?.n || 0; r.openCostQuote = p?.cost || 0;
        // Ringkasan riset wallet yang sudah tersimpan (dari halaman Wallet) — tanpa memanggil chain.
        const w = store.get('SELECT stats, last_scan_ts, positions_n FROM wallets WHERE chain=? AND address=?', chain.network, r.address);
        if (w) { try { r.research = { ...JSON.parse(w.stats || '{}'), lastScanTs: w.last_scan_ts, positionsN: w.positions_n }; } catch { r.research = null; } }
        // Uang DIA sendiri: kas di wallet + nilai posisi LP yang masih terbuka
        // (termasuk fee yang belum diklaim). Wallet yang tinggal beberapa puluh
        // dolar praktis sudah berhenti nge-LP — itu yang dibaca kolom "Saldo dia".
        const lp = store.get("SELECT COUNT(*) n, COALESCE(SUM(live_value_q),0) v, COALESCE(SUM(live_fee_q),0) f FROM wpositions WHERE chain=? AND wallet=? AND status='open'", chain.network, r.address);
        const cash = cashOf(r.address);
        r.balance = {
          cashUsd: cash?.usd ?? null, cashTs: cash?.ts ?? null,
          // Belum pernah diriset: LP-nya tidak diketahui (bukan nol) — jangan
          // sampai wallet yang belum dipindai terbaca seolah modalnya habis.
          lpUsd: w ? (lp?.v || 0) + (lp?.f || 0) : null, lpOpenN: lp?.n || 0, lpTs: w?.last_scan_ts || null,
        };
      }
      // Kas dibaca dari chain di latar, satu wallet tiap panggilan; baris memakai
      // angka tersimpan sampai gilirannya tiba.
      sweepTargetCash(rows.map((r) => r.address));
      return { targets: rows, defaults: DEFAULTS, globalRules: rulesFor(cfg.rules) };
    },
    'POST /api/targets': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase().trim();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      const v = validateRules(b.rules || null);
      if (v.error) return { error: v.error };
      store.run('INSERT OR IGNORE INTO targets(chain,address,label,enabled,added_ts,rules,notes) VALUES(?,?,?,?,?,?,?)',
        chain.network, addr, b.label || null, b.enabled === false ? 0 : 1, Date.now(), v.rules ? JSON.stringify(v.rules) : null, b.notes || null);
      return { ok: true };
    },
    'POST /api/targets/toggle': async (req) => {
      const b = await readBody(req);
      store.run('UPDATE targets SET enabled=? WHERE chain=? AND address=?', b.enabled ? 1 : 0, chain.network, String(b.address).toLowerCase());
      return { ok: true };
    },
    'POST /api/targets/rules': async (req) => {
      const b = await readBody(req);
      const v = validateRules(b.rules || null);
      if (v.error) return { error: v.error };
      store.run('UPDATE targets SET rules=?, label=COALESCE(?,label) WHERE chain=? AND address=?',
        v.rules ? JSON.stringify(v.rules) : null, b.label ?? null, chain.network, String(b.address).toLowerCase());
      return { ok: true };
    },
    'POST /api/targets/label': async (req) => {
      const b = await readBody(req);
      const addr = String(b.address || '').toLowerCase();
      const label = String(b.label ?? '').trim().slice(0, 60) || null;
      const r = store.run('UPDATE targets SET label=? WHERE chain=? AND address=?', label, chain.network, addr);
      if (!r.changes) return { error: 'target tidak ditemukan' };
      return { ok: true, label };
    },
    'POST /api/targets/delete': async (req) => {
      const b = await readBody(req);
      store.run('DELETE FROM targets WHERE chain=? AND address=?', chain.network, String(b.address).toLowerCase());
      return { ok: true };
    },
    // Gambar & indikator grafik lanjutan (garis tren, fibonacci, dst) per pool —
    // disimpan di server supaya tetap ada saat halaman dibuka lagi, bukan cuma di
    // localStorage browser yang dipakai orang itu saja.
    'GET /api/chart/overlays': (req, url) => {
      const ref = String(url.searchParams.get('pool') || '').trim().toLowerCase();
      if (!ref) return { error: 'pool tidak valid' };
      const raw = store.getState(`chart_overlays:${ref}`);
      return { data: raw ? JSON.parse(raw) : null };
    },
    'POST /api/chart/overlays': async (req) => {
      const b = await readBody(req);
      const ref = String(b.pool || '').trim().toLowerCase();
      if (!ref) return { error: 'pool tidak valid' };
      store.setState(`chart_overlays:${ref}`, JSON.stringify(b.data || {}));
      return { ok: true };
    },
    'GET /api/activity': (req, url) => {
      const limit = Math.min(300, Number(url.searchParams.get('limit') || 120));
      const rows = store.all(`
        SELECT a.*, d.verdict, d.reason, d.tx_hash AS decision_tx, d.plan
        FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
        WHERE a.chain=? ORDER BY a.ts DESC, a.id DESC LIMIT ?`, chain.network, limit);
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      const mirrors = manual.openMirrorKeys();
      for (const r of rows) {
        r.targetLabel = labels.get(r.target) || null;
        r.symbol0 = toks.get(r.token0)?.symbol || null;
        r.symbol1 = toks.get(r.token1)?.symbol || null;
        r.dec0 = toks.get(r.token0)?.decimals ?? 18;
        r.dec1 = toks.get(r.token1)?.decimals ?? 18;
        r.quoteSide = quoteSideOf(r.token0, r.token1);
        // Buka/tambah posisi yang gagal atau dilewati dan belum punya cermin: tombol
        // "Ikuti" (status posisi target di chain baru diperiksa saat pratinjau).
        r.followable = Manual.followable(r, mirrors);
      }
      return { activity: rows };
    },
    // Ikuti manual aksi target yang gagal/dilewati. `plan` = pratinjau (tanpa transaksi)
    // untuk modal konfirmasi; POST tanpa /plan mengirim transaksinya. Keluarnya tetap
    // otomatis — lihat Manual.follow.
    'POST /api/activity/follow/plan': async (req) => {
      const b = await readBody(req);
      try { return await manual.planFollow({ actionId: Number(b.actionId), usd: b.usd }); }
      catch (e) { return { error: e.message }; }
    },
    'POST /api/activity/follow': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const lockKey = `follow:${Number(b.actionId)}`;
      if (manualOpening.has(lockKey)) return { error: 'aksi ini sedang diikuti — tunggu hasilnya' };
      manualOpening.add(lockKey);
      try {
        const r = await manual.follow({ actionId: Number(b.actionId), usd: b.usd });
        return { ok: true, tx: r.txHash, positionId: r.positionId, note: r.note, lateMs: r.lateMs };
      } catch (e) {
        log(`ikuti manual aksi #${b.actionId}: ${e.message}`);
        return { error: e.message };
      } finally { manualOpening.delete(lockKey); }
    },
    // Umpan untuk peringatan di dasbor (toast + suara): "target membuka posisi"
    // dan "posisi salinan ditutup" (dengan PnL-nya). Dipoll tiap beberapa detik,
    // jadi sengaja ringan: panggilan pertama (tanpa `after`) cuma mengembalikan
    // titik awal — id aksi terakhir dan waktu tutup terakhir — supaya membuka
    // dasbor tidak memutar ulang semua riwayat. Aksi lama yang baru tercatat —
    // backfill setelah mesin mati — disaring lewat umurnya, bukan id-nya.
    'GET /api/feed': (req, url) => {
      const lastId = store.get('SELECT COALESCE(MAX(id),0) AS id FROM actions WHERE chain=?', chain.network)?.id || 0;
      const lastClosed = store.get("SELECT COALESCE(MAX(closed_ts),0) AS ts FROM positions WHERE chain=? AND status='closed'", chain.network)?.ts || 0;
      const raw = url.searchParams.get('after');
      if (raw == null || !Number.isFinite(Number(raw))) return { lastId, lastClosed, items: [] };
      const rows = store.all(`
        SELECT a.id, a.ts, a.target, a.venue, a.token_id, a.token0, a.token1, a.fee, a.tick_lower, a.tick_upper,
               a.value_quote, a.quote_symbol, d.verdict, d.reason, d.position_id,
               EXISTS(SELECT 1 FROM actions b WHERE b.target = a.target AND b.token_id = a.token_id
                      AND b.kind = 'increase' AND b.id < a.id) AS adding
        FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
        WHERE a.chain=? AND a.id > ? AND a.kind = 'increase' AND a.ts > ?
          AND a.target IN (SELECT address FROM targets WHERE chain=? AND enabled = 1)
        ORDER BY a.id LIMIT 20`, chain.network, Number(raw), Date.now() - 15 * 60_000, chain.network);
      const toks = new Map(store.all('SELECT address,symbol FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t.symbol]));
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      const items = rows.map((r) => ({
        kind: 'open', id: r.id, ts: r.ts, target: r.target, targetLabel: labels.get(r.target) || null,
        venue: r.venue, fee: r.fee, adding: !!r.adding,
        token0: r.token0, token1: r.token1, symbol0: toks.get(r.token0) || null, symbol1: toks.get(r.token1) || null,
        valueUsd: r.value_quote == null ? null
          : r.value_quote * (chain.isEthLike(r.quote_symbol) ? engine.ethUsd : 1),
        verdict: r.verdict || null, reason: r.reason || null, positionId: r.position_id || null,
      }));
      // Posisi salinan yang tertutup penuh sejak `closedAfter` (waktu tutup, ms) —
      // ikut-keluar target, keluar mandiri, maupun ditutup manual. PnL-nya sudah
      // final di baris posisi (hasil − modal, sudah termasuk fee yang diklaim).
      const rawC = url.searchParams.get('closedAfter');
      if (rawC != null && Number.isFinite(Number(rawC))) {
        const closed = store.all(`
          SELECT p.id, p.closed_ts, p.opened_ts, p.venue, p.fee, p.token_id, p.token0, p.token1, p.target, p.mirror_of,
                 p.cost_quote, p.out_quote, p.quote_symbol, p.tx_close,
                 EXISTS(SELECT 1 FROM decisions d JOIN actions a ON a.id = d.action_id
                        WHERE d.position_id = p.id AND d.verdict = 'copy'
                          AND a.kind IN ('decrease','transfer_out') AND d.ts >= p.closed_ts - 600000) AS mirrored
          FROM positions p
          WHERE p.chain=? AND p.status = 'closed' AND p.closed_ts > ? AND p.closed_ts > ?
          ORDER BY p.closed_ts LIMIT 20`, chain.network, Number(rawC), Date.now() - 15 * 60_000);
        for (const r of closed) {
          const k = chain.isEthLike(r.quote_symbol) ? engine.ethUsd : 1;
          const costUsd = (r.cost_quote || 0) * k, outUsd = (r.out_quote || 0) * k;
          items.push({
            kind: 'close', id: `c${r.id}`, ts: r.closed_ts, positionId: r.id, tokenId: r.token_id,
            target: r.target, targetLabel: r.target ? labels.get(r.target) || null : null, mirrorOf: r.mirror_of,
            venue: r.venue, fee: r.fee, mirrored: !!r.mirrored, txHash: r.tx_close,
            token0: r.token0, token1: r.token1, symbol0: toks.get(r.token0) || null, symbol1: toks.get(r.token1) || null,
            costUsd, outUsd, pnlUsd: outUsd - costUsd,
            pnlPct: costUsd > 0 ? ((outUsd - costUsd) / costUsd) * 100 : null,
            slipUsd: costs.of(r.id, engine.ethUsd).slipUsd || 0,
            ageHours: r.opened_ts ? (r.closed_ts - r.opened_ts) / 3600000 : null,
          });
        }
      }
      return { lastId, lastClosed, items };
    },
    'GET /api/rules': () => ({ rules: rulesFor(cfg.rules), defaults: DEFAULTS, raw: cfg.rules || {} }),
    'POST /api/rules': async (req) => {
      const b = await readBody(req);
      const v = validateRules(b.rules || {});
      if (v.error) return { error: v.error };
      cfg.rules = v.rules || {};
      saveCfg();
      return { ok: true, rules: rulesFor(cfg.rules) };
    },
    'POST /api/mode': async (req) => {
      const b = await readBody(req);
      if (typeof b.dry_run === 'boolean') {
        // Menyalakan LIVE lewat pintu ini harus sama ketatnya dengan halaman Pengaturan
        // (/api/settings/live): butuh wallet dan konfirmasi tertulis. Kembali ke simulasi bebas.
        if (b.dry_run === false && !engine.exec.address()) return { error: 'Pasang wallet dulu sebelum menyalakan LIVE.' };
        if (b.dry_run === false && String(b.confirm || '') !== 'LIVE') return { error: 'Ketik LIVE untuk konfirmasi.' };
        cfg.mode = cfg.mode || {}; cfg.mode.dry_run = b.dry_run; saveCfg();
      }
      if (typeof b.paused === 'boolean') { if (engine.setPaused) engine.setPaused(b.paused); else store.setState('paused', b.paused ? '1' : '0'); }
      return { ok: true, mode: { dry_run: engine.dryRun(), paused: engine.paused() } };
    },
    'GET /api/logs': () => ({ logs: store.all('SELECT * FROM logs ORDER BY ts DESC LIMIT 200') }),
    'GET /api/txs': () => ({ txs: store.all('SELECT * FROM txs WHERE chain=? ORDER BY ts DESC LIMIT 100', chain.network) }),
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
      // force: bangun ulang juga posisi tertutup yang sudah tersimpan (setelah perbaikan rumus)
      const job = startWalletJob(addr, { mode, blocks: Number(b.blocks || 900_000), reason: 'manual', force: b.force === true });
      return { ok: true, status: job.status };
    },

    'GET /api/wallet': async (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      const w = store.get('SELECT * FROM wallets WHERE chain=? AND address=?', chain.network, addr);
      // Sudah pernah dipindai tapi basi -> perbarui di latar; halaman tetap langsung
      // menampilkan data tersimpan dan melihat progresnya lewat `job`.
      if (w) maybeRefresh(addr, w, 'basi');
      const job = walletJobs.get(addr);
      const jobOut = job ? {
        status: job.status, mode: job.mode, reason: job.reason, phase: job.phase, progress: job.progress,
        done: job.done, total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error,
      } : null;
      if (!w) return { found: false, job: jobOut };

      const rows = store.all('SELECT * FROM wpositions WHERE chain=? AND wallet=? ORDER BY COALESCE(closed_ts, opened_ts) DESC', chain.network, addr);
      // Harga pool saat posisi dibuka dan saat ditutup — sudah tersimpan per kejadian
      // waktu pemindaian (dibaca dari node arsip), jadi tidak perlu panggil chain lagi.
      const ev = store.all('SELECT token_id, block, sqrt_price FROM wevents WHERE chain=? AND wallet=? ORDER BY token_id, block', chain.network, addr);
      const firstLast = new Map();
      for (const e of ev) {
        if (!e.sqrt_price) continue;
        const cur = firstLast.get(e.token_id);
        if (!cur) firstLast.set(e.token_id, { entry: e.sqrt_price, exit: e.sqrt_price });
        else cur.exit = e.sqrt_price;
      }
      const toks = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
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
        isTarget: !!store.get('SELECT 1 FROM targets WHERE chain=? AND address=?', chain.network, addr),
        job: jobOut,
      };
    },

    'GET /api/wallet/events': (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      const id = String(url.searchParams.get('token_id') || '');
      return { events: store.all('SELECT * FROM wevents WHERE chain=? AND wallet=? AND token_id=? ORDER BY block', chain.network, addr, id) };
    },

    // Isi wallet (portofolio) — token yang dipegang + nilai USD-nya. Untuk wallet
    // mana pun, bukan hanya milik bot; dipakai halaman detail target.
    'GET /api/wallet/holdings': async (req, url) => {
      const addr = String(url.searchParams.get('address') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return { error: 'alamat tidak valid' };
      return holdingsOf(addr, { refresh: url.searchParams.get('refresh') === '1' });
    },

    // Pencarian global (Cmd/Ctrl+K di dasbor): satu kotak, lompat ke target, token,
    // pool, atau wallet yang pernah diriset — semuanya sudah ada di DB lokal, jadi
    // tidak perlu memanggil chain/DexScreener untuk sekadar melompat halaman.
    'GET /api/search': async (req, url) => {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) return { results: [] };
      const like = `%${q}%`;
      const results = [];
      for (const r of store.all(
        "SELECT address,label FROM targets WHERE chain=? AND (LOWER(COALESCE(label,'')) LIKE ? OR address LIKE ?) ORDER BY added_ts DESC LIMIT 6", chain.network, like, like))
        results.push({ type: 'target', address: r.address, label: r.label });
      for (const r of store.all(
        "SELECT address,symbol,name FROM tokens WHERE chain=? AND (LOWER(COALESCE(symbol,'')) LIKE ? OR LOWER(COALESCE(name,'')) LIKE ? OR address LIKE ?) ORDER BY seen_ts DESC LIMIT 6", chain.network, like, like, like))
        results.push({ type: 'token', address: r.address, symbol: r.symbol, name: r.name });
      for (const r of store.all(
        "SELECT address,label FROM wallets WHERE chain=? AND (LOWER(COALESCE(label,'')) LIKE ? OR address LIKE ?) ORDER BY last_scan_ts DESC LIMIT 6", chain.network, like, like))
        results.push({ type: 'wallet', address: r.address, label: r.label });
      for (const p of await manual.pools({ q, limit: 6 }))
        results.push({ type: 'pool', poolRef: p.poolRef, pair: p.pair, symbol0: p.symbol0, symbol1: p.symbol1 });
      return { results };
    },
    // Wallet yang juga tersimpan sebagai target dipinjamkan nama targetnya bila
    // wallet itu sendiri belum diberi label — supaya daftar riset tidak menampilkan
    // alamat telanjang untuk wallet yang sudah kita kenal.
    'GET /api/wallets': () => {
      const tLabel = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      return {
        wallets: store.all('SELECT address,label,scanned_to,last_scan_ts,positions_n,stats FROM wallets WHERE chain=? ORDER BY last_scan_ts DESC LIMIT 50', chain.network)
          .map((w) => {
            const label = w.label || tLabel.get(w.address) || null;
            try { return { ...w, label, isTarget: tLabel.has(w.address), stats: JSON.parse(w.stats || '{}') }; } catch { return { ...w, label, isTarget: tLabel.has(w.address), stats: {} }; }
          }),
      };
    },

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
      // Klik ganda (dasbor lambat merespons, tombol Telegram ditekan dua kali) dulu membuka
      // DUA posisi — rencana kedua dibuat sebelum posisi pertama tercatat.
      const lockKey = String(b.poolRef || '').toLowerCase();
      if (manualOpening.has(lockKey)) return { error: 'pembukaan LP di pool ini masih diproses — tunggu hasilnya' };
      manualOpening.add(lockKey);
      try {
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
      } finally { manualOpening.delete(lockKey); }
    },
    // ?usd=1: sertakan harga & nilai USD tiap token bersaldo (dasbor). Bot Telegram
    // memanggil tanpa itu supaya tidak ikut menunggu DexScreener.
    'GET /api/manual/tokens': async (req, url) => {
      // Satu balanceOf yang gagal (RPC 429) menggagalkan seluruh daftar — sekali
      // coba lagi setelah jeda sebelum menyerah.
      const tokens = await manual.held().catch(async (e) => {
        log(`daftar token: ${e.message} — coba lagi`);
        await new Promise((r) => setTimeout(r, 1500));
        return manual.held();
      });
      if (url.searchParams.get('usd') === '1') {
        await Promise.all(tokens.map(async (x) => {
          x.priceUsd = x.amount > 0 || x.isQuote ? await usdPrice(x.address) : null;
          x.usd = x.priceUsd != null ? x.amount * x.priceUsd : null;
        }));
      }
      return { tokens };
    },
    // Harga USD untuk daftar alamat, TANPA membaca saldo lagi. Dasbor dulu memanggil
    // /tokens?usd=1 yang membaca ulang semua saldo; kalau satu eth_call kena 429,
    // seluruh harga hilang dan semua baris tampil "—".
    'POST /api/manual/prices': async (req) => {
      const b = await readBody(req);
      const list = [...new Set((Array.isArray(b.addresses) ? b.addresses : [])
        .map((x) => String(x || '').toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x)))].slice(0, 100);
      const prices = {};
      await Promise.all(list.map(async (a) => { prices[a] = await usdPrice(a).catch(() => null); }));
      return { prices };
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
      swaps: store.all("SELECT hash, ts, status, error, detail, gas_used, gas_price FROM txs WHERE chain=? AND kind='swap_manual' ORDER BY ts DESC LIMIT 8", chain.network)
        .map((r) => {
          let d = {}; try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* abaikan */ }
          // Biaya gas dalam USD memakai kurs ETH sekarang — cukup untuk riwayat singkat.
          const gasUsd = r.gas_used && r.gas_price && engine.ethUsd
            ? (Number(r.gas_used) * Number(BigInt(r.gas_price))) / 1e18 * engine.ethUsd : null;
          return { hash: r.hash, ts: r.ts, status: r.status, error: r.error, detail: d, gasUsd };
        }),
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
      const tgt = store.get('SELECT label FROM targets WHERE chain=? AND address=?', chain.network, a);
      const riset = store.get('SELECT address FROM wallets WHERE chain=? AND address=?', chain.network, a);
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
    // Kartu bagikan (share card). Datanya dirakit dari rute yang sama dengan yang
    // dipakai dasbor, lalu digambar di server (src/share-card.js) supaya dasbor dan
    // bot Telegram mengirim gambar yang persis sama.
    //   kind=position&id=…  | kind=total | kind=daily&day=YYYY-MM-DD
    //   hide=1 menyembunyikan nominal dolar; lang=id|en; tz=zona waktu IANA pembaca
    //   (hari di kalender dihitung menurut zona itu, sama seperti di browser).
    'GET /api/share/telegram': () => ({
      ready: !!(telegram?.token() && telegram.chats().length), chats: telegram ? telegram.chats().length : 0,
    }),
    'POST /api/share/telegram': async (req) => {
      if (!telegram?.token()) return { error: 'bot Telegram belum dipasang' };
      const chats = telegram.chats();
      if (!chats.length) return { error: 'belum ada chat Telegram yang dipasangkan' };
      const b = await readBody(req);
      const card = await shareCardOf(b);
      if (card.error) return card;
      let sent = 0, lastErr = null;
      for (const c of chats) {
        try { await telegram.sendPhoto(c, card.png, card.caption); sent++; } catch (e) { lastErr = e.message; }
      }
      if (!sent) return { error: lastErr || 'gagal mengirim' };
      return { sent, failed: chats.length - sent, lastErr };
    },
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
      const pos = store.get('SELECT * FROM positions WHERE chain=? AND id=?', chain.network, Number(url.searchParams.get('id')));
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
    // Kendali manual posisi cermin (lihat Manual.takeover). GET …/handback memeriksa posisi
    // target di chain untuk modal konfirmasi "kembalikan".
    'POST /api/positions/takeover': async (req) => {
      const b = await readBody(req);
      try { return await manual.takeover(b.id); } catch (e) { return { error: e.message }; }
    },
    'GET /api/positions/handback': async (req, url) => manual.handBackInfo(url.searchParams.get('id')),
    'POST /api/positions/handback': async (req) => {
      const b = await readBody(req);
      try { return await manual.handBack(b.id); } catch (e) { return { error: e.message }; }
    },
    'POST /api/positions/close': async (req) => {
      const b = await readBody(req);
      const pos = store.get("SELECT * FROM positions WHERE chain=? AND id=? AND status='open'", chain.network, Number(b.id));
      if (!pos) return { error: 'posisi tidak ditemukan' };
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        const r = await engine.executeExit({ venue: pos.venue, action: 'burn', full: true, liquidity: pos.liquidity, tokenId: pos.token_id }, pos);
        store.log('info', `tutup manual: ${r.note}`);
        // Hasil dibaca dari baris yang baru ditutup, dengan konversi yang sama seperti
        // GET /api/position, supaya angka di notifikasi cocok dengan halaman detail.
        const row = store.get('SELECT out_quote, cost_quote, quote_symbol FROM positions WHERE chain=? AND id=?', chain.network, pos.id);
        const k = chain.isEthLike(row?.quote_symbol) ? engine.ethUsd : 1;
        const outUsd = row?.out_quote != null ? row.out_quote * k : null;
        const pnlUsd = outUsd != null && row.cost_quote != null ? outUsd - row.cost_quote * k : null;
        return { ok: true, tx: r.txHash, outUsd, pnlUsd, sold: r.sold || null };
      } catch (e) {
        store.log('error', `tutup manual #${pos.id} gagal: ${e.message}`);
        return { error: e.message };
      }
    },
  };

  Object.assign(routes, createSettingsRoutes({ engine, engines, store, cfg, cfgPath, rpc, chain, log, readBody, telegram, sessionCookie, market }));
  routes['GET /api/chains'] = async () => ({ chains: await chainList(), current: chain.network });
  // Pemilih chain: cookie lpcopy_chain dibaca pintu depan (index.js) untuk memilih
  // server chain mana yang menjawab permintaan berikutnya. Cookie ini bukan rahasia.
  routes['POST /api/chain/select'] = async (req, url, res) => {
    const b = await readBody(req);
    const want = String(b.chain || '').toLowerCase();
    const ok = nets ? !!nets[want] : want === chain.network;
    if (!ok) return { error: 'chain tidak dikenal atau tidak aktif' };
    res.__setCookie = `lpcopy_chain=${want}; Path=/; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;
    return { ok: true, chain: want };
  };

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

  // Merakit data satu kartu bagikan lalu menggambarnya. Dipakai rute PNG, rute kirim
  // Telegram, dan tombol "Bagikan" di bot. Mengembalikan { png, caption } atau { error }.
  const dayKeyIn = (ts, timeZone) => {
    try { return new Date(ts).toLocaleDateString('en-CA', { timeZone }); } catch { return new Date(ts).toLocaleDateString('en-CA'); }
  };
  const shareCardOf = async ({ kind, id, day, hide = false, lang = 'id', tz, size, theme } = {}) => {
    const timeZone = tz || cfg.telegram?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const opts = { hideAmounts: !!hide, lang, timeZone, size: shareCard.sizeKey(size), theme: shareCard.themeKey(theme), chain: { key: chain.network, label: chain.label } };
    let data;
    if (kind === 'position') {
      const d = await callApi('GET', '/api/position', {}, { id });
      if (d.error) return { error: d.error };
      data = d.position;
      // Logo pasangan: aset kuotasi dari berkas dasbor, sisanya dari cache GeckoTerminal.
      const local = chain.network === 'robinhood' ? { [chain.ADDR.usdg]: 'usdg.png', [chain.ADDR.weth]: 'weth.png' } : {};
      const iconOf = (a) => {
        const k = String(a || '').toLowerCase();
        // Di VPS hanya web/dist yang ada (Vite menyalin public/tokens ke sana); saat
        // pengembangan tanpa build, web/public.
        if (local[k]) {
          for (const dir of ['dist', 'public']) {
            try { return { buf: fs.readFileSync(path.join(__dirname, '..', 'web', dir, 'tokens', local[k])), ctype: 'image/png' }; } catch { /* coba berikutnya */ }
          }
          return null;
        }
        return icons.read(k);
      };
      opts.icons = { token0: iconOf(data.token0), token1: iconOf(data.token1) };
      // Grafik harga di latar angka: lilin seumur posisi (+ sedikit konteks sebelum
      // masuk), rentang LP, dan titik masuk/keluar. Sumbernya sama dengan kartu grafik.
      // Gagal atau lambat (GeckoTerminal) → kartu tetap jadi, tanpa grafik.
      opts.chart = await positionSpark(data).catch(() => null);
    } else if (kind === 'total' || kind === 'daily') {
      const [pf, pos] = await Promise.all([callApi('GET', '/api/portfolio', {}, { range: 'all' }), callApi('GET', '/api/positions')]);
      const all = [...(pos.positions || []), ...(pos.closed || [])];
      if (kind === 'total') {
        if (!pf.now) return { error: 'portofolio belum terbaca' };
        data = { now: pf.now, stats: pf.stats, since: all.reduce((a, x) => (x.opened_ts && (!a || x.opened_ts < a) ? x.opened_ts : a), null) };
        // Kurva PnL bersih sepanjang riwayat (tampilan yang sama dengan grafik portofolio).
        const pts = portfolioCard.prepare(pf, 'net').pts;
        if (pts.length >= 2) opts.chart = { kind: 'line', pts: pts.map((x) => [x.t, x.v]), zero: true };
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { error: 'tanggal tidak valid' };
        const daily = {}, counts = {};
        for (const [ts, v] of pf.closed || []) { const k = dayKeyIn(ts, timeZone); daily[k] = (daily[k] || 0) + v; counts[k] = (counts[k] || 0) + 1; }
        if (daily[day] == null) return { error: 'tidak ada posisi yang ditutup pada hari itu' };
        const kq = (q) => (chain.isEthLike(q) ? engine.ethUsd || 0 : 1);
        data = {
          day, total: daily[day], count: counts[day],
          rows: (pos.closed || []).filter((c) => c.closed_ts && dayKeyIn(c.closed_ts, timeZone) === day)
            .map((c) => ({ symbol0: c.symbol0, symbol1: c.symbol1, cost: (c.cost_quote || 0) * kq(c.quote_symbol), pnl: ((c.out_quote || 0) - (c.cost_quote || 0)) * kq(c.quote_symbol) })),
          monthTotal: Object.entries(daily).filter(([k]) => k.startsWith(day.slice(0, 7))).reduce((a, [, v]) => a + v, 0),
        };
        // Batang PnL tiap hari di bulan itu; hari yang dibagikan ditonjolkan.
        const [y, m] = day.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
        opts.chart = { kind: 'bars', bars: Array.from({ length: dim }, (_, i) => { const k = `${day.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`; return { v: daily[k] || 0, on: k === day }; }) };
      }
    } else return { error: `jenis kartu tidak dikenal: ${kind}` };
    return { png: shareCard.render(kind, data, opts), caption: shareCard.caption(kind, data, lang) };
  };
  // Lilin untuk grafik latar kartu posisi. Jendelanya menutupi umur posisi (minimal
  // 10 menit) + 30% konteks sebelum masuk, dalam ≤ 120 lilin; posisi tertutup hanya
  // diberi beberapa lilin setelah keluar — bukan 6 jam seperti kartu grafik, supaya
  // penanda masuk/keluarnya tidak terdesak ke tepi kiri.
  const positionSpark = async (p) => {
    if (!p.pool_ref) return null;
    const closed = p.status === 'closed';
    const end = closed && p.closed_ts ? p.closed_ts : Date.now();
    const spanS = Math.max(600, (end - (p.opened_ts || end)) / 1000) * 1.3;
    const frames = Object.entries(TF).sort((a, b) => a[1][2] - b[1][2]);
    const [tf, [, , secs]] = frames.find(([, f]) => spanS / f[2] <= 120) || frames[frames.length - 1];
    const after = closed ? 3 : 0;
    const limit = Math.max(30, Math.min(140, Math.ceil(spanS / secs) + after + 2));
    const oh = await market.candles(p.pool_ref, tf, {
      limit, currency: 'token', token: /^0x[0-9a-f]{40}$/.test(String(p.baseToken || '')) ? p.baseToken : null,
      before: closed && p.closed_ts ? p.closed_ts + after * secs * 1000 : null,
    });
    const candles = oh?.candles || [];
    if (oh?.error || candles.length < 2) return null;
    const at = (tick) => (tick == null ? null : tickPriceOf(tick, p.dec0, p.dec1, p.quoteSide));
    const a = at(p.tick_lower), b = at(p.tick_upper);
    const marks = [];
    const entry = sqrtPriceOf(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
    if (p.opened_ts && entry != null) marks.push({ t: p.opened_ts, v: entry });
    const exit = closed ? sqrtPriceOf(p.exitSqrt, p.dec0, p.dec1, p.quoteSide) : null;
    if (closed && p.closed_ts && exit != null) marks.push({ t: p.closed_ts, v: exit });
    return { kind: 'line', pts: candles.map((c) => [c.t, Number(c.c)]), band: a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : null, marks };
  };

  // Grafik satu posisi sebagai gambar: lilin + indikator + pita rentang + garis BEP.
  // Dipakai tombol "Grafik" di bot Telegram (dan rute PNG di bawah) — isinya sengaja
  // sama dengan yang digambar dasbor, termasuk rumus BEP (src/breakeven.mjs).
  // `span` = lebar jendela dalam jam (0 = otomatis: seumur posisi + konteks sebelum
  // masuk). Jumlah lilin dibatasi 60–400: di bawah itu tidak ada konteks, di atas itu
  // satu lilin tinggal sepiksel di gambar selebar 1200.
  const CHART_MIN = 60, CHART_MAX = 400;
  const chartCardOf = async ({ id, tf = '1h', mask = chartCard.DEFAULT_MASK, span = 0, lang = 'id', tz } = {}) => {
    const d = await callApi('GET', '/api/position', {}, { id });
    if (d.error) return { error: d.error };
    const p = d.position;
    if (!p.pool_ref) return { error: 'posisi ini tidak punya pool' };
    const frame = TF[tf] ? tf : '1h';
    const secs = TF[frame][2];
    const closed = p.status === 'closed';
    const end = closed && p.closed_ts ? p.closed_ts : Date.now();
    let limit;
    if (Number(span) > 0) limit = Math.round((Number(span) * 3600) / secs);
    else limit = Math.ceil((p.opened_ts ? (end - p.opened_ts) / 1000 : 0) / secs) + 40;
    limit = Math.max(CHART_MIN, Math.min(CHART_MAX, limit));
    // Posisi tertutup dilihat di sekitar masa hidupnya, bukan sampai hari ini.
    // `patient`: gambar ini diminta lewat tombol, bukan dipoll — lebih baik menunggu
    // sedikit lebih lama daripada membalas galat yang percobaan keduanya pasti lolos.
    const oh = await market.candles(p.pool_ref, frame, {
      limit, currency: 'token', token: /^0x[0-9a-f]{40}$/.test(String(p.baseToken || '')) ? p.baseToken : null,
      before: closed && p.closed_ts ? p.closed_ts + 6 * 3600_000 : null, patient: true,
    }).catch((e) => ({ error: e.message }));
    if (oh?.error) {
      return { error: /abort|timeout|timed out|fetch failed|HTTP 5\d\d/i.test(String(oh.error))
        ? 'harga belum terambil dari GeckoTerminal — coba lagi sebentar' : oh.error };
    }
    const candles = oh?.candles || [];
    if (!candles.length) return { error: 'lilin harga belum tersedia untuk pool ini' };
    const at = (tick) => (tick == null ? null : tickPriceOf(tick, p.dec0, p.dec1, p.quoteSide));
    const a = at(p.tick_lower), b = at(p.tick_upper);
    const lo = a != null && b != null ? Math.min(a, b) : null;
    const hi = a != null && b != null ? Math.max(a, b) : null;
    const last = candles[candles.length - 1];
    const now = sqrtPriceOf(p.curSqrt, p.dec0, p.dec1, p.quoteSide) ?? Number(last.c);
    const first = candles[0];
    // BEP dihitung untuk posisi terbuka mana pun (bukan hanya yang di luar rentang):
    // di gambar, garisnya justru berguna SEBELUM harga keluar rentang.
    const bep = closed ? null : breakEven(p, { all: true });
    const data = {
      positionId: p.id, tokenId: p.token_id, venue: String(p.venue || '').toUpperCase(), fee: p.fee,
      pair: `${p.symbol0 || '?'}/${p.symbol1 || '?'}`,
      quoteSymbol: p.quoteSide === 0 ? p.symbol0 : p.symbol1,
      tf: frame, secs: oh.secs, candles, mask: Number(mask) || 0, span: Number(span) || 0,
      lo, hi, now, entry: sqrtPriceOf(p.entrySqrt, p.dec0, p.dec1, p.quoteSide),
      exit: closed ? sqrtPriceOf(p.exitSqrt, p.dec0, p.dec1, p.quoteSide) : null,
      closed, inRange: closed ? null : p.inRange ?? null,
      // Kapan posisinya dibuka/ditutup — digambar sebagai garis tegak di lilinnya.
      openedTs: p.opened_ts || null, closedTs: closed ? p.closed_ts || null : null,
      ageHours: p.ageHours ?? ((closed && p.closed_ts ? p.closed_ts : Date.now()) - (p.opened_ts || Date.now())) / 3600000,
      change: Number(first.o) > 0 ? ((Number(last.c) - Number(first.o)) / Number(first.o)) * 100 : null,
      pnlUsd: p.pnlUsd, pnlPct: p.pnlPct, costUsd: p.costUsd, feeUsd: closed ? null : p.feeUsd,
      bepPrice: bep?.price ?? null, bepNote: bep?.reason || null,
      cost: p.cost || null, at: Date.now(),
      // Lilin dari cadangan (GeckoTerminal membatasi panggilan): umurnya ikut dicetak.
      staleAt: oh.stale ? oh.staleAt || oh.fetchedAt || null : null,
    };
    const opts = { lang, timeZone: tz || cfg.telegram?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    return { png: chartCard.render(data, opts), caption: chartCard.caption(data, lang), tf: frame, mask: data.mask, span: data.span, candles: candles.length };
  };

  // Grafik pertumbuhan portofolio sebagai gambar (src/portfolio-card.js), dari
  // /api/portfolio yang sama dengan halaman Ringkasan. Dipakai tombol "Grafik
  // portofolio" di bot Telegram dan rute PNG di bawah.
  const portfolioCardOf = async ({ range = '7d', view = 'net', lang = 'id', tz } = {}) => {
    const r = portfolioCard.RANGES.includes(range) ? range : '7d';
    const pf = await callApi('GET', '/api/portfolio', {}, { range: r });
    if (pf.error) return { error: pf.error };
    const data = portfolioCard.prepare(pf, view);
    if (data.pts.length < 2) return { error: 'belum ada riwayat portofolio — grafik terisi setelah bot membuka posisi (dicatat tiap 5 menit)' };
    const opts = { lang, timeZone: tz || cfg.telegram?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    return { png: portfolioCard.render(data, opts), caption: portfolioCard.caption(data, lang), range: r, view: data.view, points: data.pts.length };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;

    // ---- gerbang token ----
    const TOKEN = tokenNow();
    if (TOKEN) {
      if (url.pathname === '/login' && req.method === 'POST') {
        const ip = clientIp(req);
        if (loginBlocked(ip)) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '300', ...SEC_HEADERS });
          return res.end(LOGIN_PAGE(true));
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        return req.on('end', () => {
          const tok = decodeURIComponent((body.split('token=')[1] || '').split('&')[0].replace(/\+/g, ' '));
          if (safeEq(tok, TOKEN)) {
            loginHits.delete(ip);
            res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(req, TOKEN) });
            return res.end();
          }
          loginFail(ip);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS });
          res.end(LOGIN_PAGE(true));
        });
      }
      // Keluar: hapus cookie sesi lalu kembali ke halaman masuk. Cookie SameSite=Lax
      // tidak ikut POST lintas situs, jadi tak ada yang bisa mengeluarkan orang lain.
      if (url.pathname === '/logout' && req.method === 'POST') {
        res.writeHead(302, { location: '/', 'set-cookie': clearCookie(req), 'cache-control': 'no-store' });
        return res.end();
      }
      // Aset vendor, font, dan favicon boleh lewat supaya halaman masuk bisa tampil rapi.
      const isPublicAsset = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/fonts/') || url.pathname === '/favicon.svg';
      if (!isPublicAsset && !authed(req)) {
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"tidak berwenang"}');
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', ...SEC_HEADERS });
        return res.end(LOGIN_PAGE(false));
      }
    }
    // Logo token: satu-satunya rute /api yang membalas gambar, bukan JSON.
  // Kartu bagikan: satu-satunya rute /api lain yang membalas gambar.
    if (key === 'GET /api/share/card') {
      const q = Object.fromEntries(url.searchParams);
      const card = await shareCardOf({ ...q, hide: q.hide === '1' }).catch((e) => ({ error: e.message }));
      if (card.error) return json(res, 400, { error: card.error });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' });
      return res.end(card.png);
    }
    if (key === 'GET /api/portfolio/chart.png') {
      const q = Object.fromEntries(url.searchParams);
      const card = await portfolioCardOf(q).catch((e) => ({ error: e.message }));
      if (card.error) return json(res, 400, { error: card.error });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' });
      return res.end(card.png);
    }
    if (key === 'GET /api/position/chart.png') {
      const q = Object.fromEntries(url.searchParams);
      const card = await chartCardOf({ ...q, mask: Number(q.mask ?? chartCard.DEFAULT_MASK), span: Number(q.span) || 0 }).catch((e) => ({ error: e.message }));
      if (card.error) return json(res, 400, { error: card.error });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' });
      return res.end(card.png);
    }
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
      // CSRF: permintaan yang mengubah sesuatu harus datang dari halaman dasbor sendiri.
      // Peramban modern selalu mengirim Origin (dan Sec-Fetch-Site) pada POST; asal lain
      // ditolak. Tanpa header (curl, skrip, bot Telegram lewat callApi) tetap lewat —
      // gerbang tokennya yang menjaga.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        let host = null;
        try { host = origin ? new URL(origin).host : null; } catch { host = '(rusak)'; }
        if ((host && host !== req.headers.host) || site === 'cross-site') return json(res, 403, { error: 'permintaan lintas situs ditolak' });
      }
      // Detail kesalahan tak terduga hanya ke log; ke klien pesan generik supaya
      // path filesystem / detail RPC tidak bocor. Kesalahan yang memang perlu
      // ditampilkan sudah dikembalikan tiap rute sebagai {error} dengan status 200.
      try { return json(res, 200, await routes[key](req, url, res)); }
      catch (e) { log(`api ${key}: ${e.message}`); return json(res, 500, { error: 'kesalahan server' }); }
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
      // Dokumen HTML dijaga dari clickjacking; aset statis tidak perlu.
      ...(path.extname(file) === '.html' ? SEC_HEADERS : {}),
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
  server.shareCard = shareCardOf;
  server.chartCard = chartCardOf;
  server.portfolioCard = portfolioCardOf;
  return server;
}

module.exports = { createServer };
