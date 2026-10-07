'use strict';
const { ensureChain, normAddr, addrHint } = require('./networks');
// HTTP API + dashboard server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { rulesFor, DEFAULTS, validateRules } = require('./policy');
const { scoutWallet } = require('./scout');
const { WalletResearch, summarize } = require('./wallet');
const { createSettingsRoutes } = require('./settings');
const { Manual, ladderLayers } = require('./manual');
const { Compound } = require('./compound');
const { Holdings } = require('./holdings');
const { Icons } = require('./icons');
const { Market, TF } = require('./market');
const { Fx, currencyOf } = require('./fx');
const { Positions } = require('./positions');
const { Costs, swapCostOf } = require('./costs');
const { writeCfg } = require('./env');
const shareCard = require('./share-card');
const chartCard = require('./chart-card');
const portfolioCard = require('./portfolio-card');
const { breakEven } = require('./breakeven.mjs');
const { swapHistory } = require('./swaplog');


// Speculative token price in the quote asset — a copy of the formula in web/src/fmt.js, used by the
// chart card (position range, entry/exit price) so its figures match the dashboard.
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

// Sign-in page: server-rendered, standalone (without Tabler — 400 KB of CSS for one
// form), and following the React dashboard's design language: Inter, flat bordered cards,
// light/dark theme. The theme is read from localStorage 'lpcopy-theme' (the same key
// as the dashboard) before the first paint so it does not flicker; if absent,
// it follows the system preference. Logo = a transparent copy of public/logo.svg (placed inline
// so there is no extra request before the card shows).
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

// Security headers for document responses. This dashboard can switch on LIVE and close
// positions, so it must not be frameable by other sites (clickjacking): frame-ancestors
// 'none' is the modern version of X-Frame-Options; both are set for old browsers.
// nosniff prevents MIME sniffing. The CSP here deliberately only restricts frame-ancestors
// so as not to break the app's and sign-in page's inline scripts/styles.
const SEC_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff' };
// The mini app page is opened INSIDE Telegram. On Telegram Web it lives in an <iframe>
// owned by web.telegram.org, so `frame-ancestors 'none'` would shut it down before it could
// show; on a phone its webview is the top-level page and this header has no effect. Only
// Telegram may frame it — other sites are still refused, and x-frame-options is deliberately
// left out because DENY overrides any allow list.
const TG_SEC_HEADERS = {
  'content-security-policy': 'frame-ancestors https://web.telegram.org https://*.telegram.org https://*.t.me',
  'x-content-type-options': 'nosniff',
};
// Files that must be loadable BEFORE there is a session: the mini app page and its
// build chunks (the 'mini' entry in vite.config.js — its name always starts with mini-), plus the
// modulepreload patch that Vite slips into EVERY entry. There are no secrets in
// them: the data stays behind the gate, this is only the page skeleton.
const MINI_PUBLIC = /^\/(?:mini|assets\/(?:mini|modulepreload-polyfill)-[A-Za-z0-9_.-]+\.(?:js|css))$/;

// Verify the initData of a Telegram Mini App. Telegram signs it with the
// bot_token, so only a server holding that token can prove that
// this data really came from Telegram and has not been altered:
//   secret = HMAC-SHA256(key: "WebAppData", msg: bot_token)
//   hash   = HMAC-SHA256(key: secret, msg: all other fields, "k=v" sorted, joined by \n)
//
// About `signature` (an Ed25519 signature for third parties, present since Bot API 8.0):
// Telegram's documentation says "all fields received except hash", so it IS
// counted — leaving it out makes every new client get rejected. Old clients do not
// send it at all. Some libraries wrongly left it out, so if the
// first computation misses we try once more without `signature`: both are an
// HMAC with bot_token, so accepting either does not loosen anything.
function checkInitData(initData, botToken, { maxAgeSec = 86400, now = Date.now() } = {}) {
  let q;
  try { q = new URLSearchParams(String(initData || '')); } catch { return { error: 'initData tidak terbaca' }; }
  const hash = q.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { error: 'initData tanpa tanda tangan' };
  q.delete('hash');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
  const requested = Buffer.from(hash.toLowerCase(), 'hex');
  const match = (column) => {
    const data = column.map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const calc = Buffer.from(crypto.createHmac('sha256', secret).update(data).digest('hex'), 'hex');
    return calc.length === requested.length && crypto.timingSafeEqual(calc, requested);
  };
  const column = [...q.entries()];
  let look = 'baku';
  if (!match(column)) {
    const without = column.filter(([k]) => k !== 'signature');
    if (without.length === column.length || !match(without)) {
      // Only the field names are recorded — the contents are user identity.
      return { error: 'tanda tangan initData tidak cocok', column: column.map(([k]) => k) };
    }
    look = 'tanpa signature';
  }
  // Age: initData can be reused while still inside this window. A forward tolerance of
  // 5 minutes for a server clock that is slightly off.
  const authDate = Number(q.get('auth_date') || 0);
  const ageSec = now / 1000 - authDate;
  if (!authDate || ageSec > maxAgeSec || ageSec < -300) return { error: 'initData kedaluwarsa — tutup lalu buka lagi mini app-nya' };
  let user = null;
  try { user = JSON.parse(q.get('user') || 'null'); } catch { /* not JSON */ }
  if (!user || user.id == null) return { error: 'initData tanpa pengguna' };
  return { user, authDate, look };
}

function createServer({ engine, store, cfg, cfgPath, chain, rpc, log, telegram, nets = null }) {
  chain = ensureChain(chain || engine?.chain);
  const pub = path.join(__dirname, '..', 'public');
  const { QUOTES } = chain;
  // Which side of the pool is the quote asset (0 or 1); null if unknown.
  // Determines the direction of the displayed price: always "speculative token price in quote".
  const quoteSideOf = (t0, t1) => chain.quoteSideOf(t0, t1)?.side ?? null;
  // Addresses in this chain's canonical form: EVM lower-cased (the whole EVM DB stores
  // lower case), Solana left as is (base58 is case-sensitive). isAddr: a valid account/token
  // address; isRef: a valid pool reference (EVM: v3 address or 32-byte v4 poolId; Solana: address).
  const SOL = chain.kind === 'solana';
  const canon = (x) => (SOL ? String(x ?? '').trim() : String(x ?? '').trim().toLowerCase());
  const isAddr = (x) => (SOL ? !!normAddr(chain.network, x) : /^0x[0-9a-f]{40}$/.test(String(x ?? '')));
  const isRef = (x) => (SOL ? !!normAddr(chain.network, x) : /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(String(x ?? '')));
  // Symbol & decimals of every token ever seen, from the `tokens` table, PLUS
  // the chain's quote assets. Native (0x0) is not an ERC-20: symbol()/decimals() cannot be
  // called, so Chain#tokens never stores its row — without this addition
  // every ETH-sided v4 pool shows "? / OFY" on the dashboard. The row is deliberately NOT
  // written to the table: what scans balances (engine/holdings/manual) takes its address
  // list from there and would call balanceOf on the zero address.
  const tokenMeta = () => {
    const m = new Map(store.all('SELECT address,symbol,decimals FROM tokens WHERE chain=?', chain.network).map((t) => [t.address, t]));
    for (const [a, q] of Object.entries(QUOTES)) {
      if (!m.get(a)?.symbol) m.set(a, { address: a, symbol: q.symbol, decimals: m.get(a)?.decimals ?? q.decimals });
    }
    return m;
  };
  // All engines in this process (one per chain, the same wallet) — for changing the key.
  const engines = nets ? Object.values(nets).map((n) => n.engine) : [engine];
  // List of chains for the picker on the dashboard/Telegram.
  // Cash per chain is reported too (USDG/USDT + native + wrapped, in USD) — read
  // from each chain's engine cache; freshCash only re-reads if a new tx has landed.
  const chainList = async () => Promise.all((nets ? Object.values(nets) : [{ key: chain.network, label: chain.label, chain, engine }]).map(async (n) => {
    let cash = null;
    try { cash = n.engine.freshCash ? await n.engine.freshCash() : n.engine.cash; } catch { cash = n.engine.cash || null; }
    return {
      key: n.key || n.chain.network, kind: n.chain.kind || 'evm', label: n.label || n.chain.label, chainId: n.chain.CHAIN_ID, nativeSymbol: n.chain.nativeSymbol,
      stableSymbol: n.chain.usdgSymbol,
      dryRun: n.engine.dryRun(), paused: n.engine.paused(), verified: n.chain.verified, head: n.engine.head, cursor: n.engine.cursor,
      targets: n.engine.watcher.enabledSet().size, current: n.chain.network === chain.network,
      cash: cash ? { usd: cash.usd, native: (cash.eth || 0) + (cash.weth || 0), stable: cash.usdg || 0, ts: cash.ts } : null,
    };
  }));
  const scoutJobs = new Map();
  const poolScanJobs = new Map();
  const walletJobs = new Map();
  // Wallet research: EVM from event logs (wallet.js), Solana from the transaction history +
  // Meteora/Orca/Raydium program events (solana/research.js) — same tables & shape.
  const research = chain.kind === 'solana'
    ? new (require('./solana/research').SolanaWalletResearch)({ rpc, store, chain, log })
    : new WalletResearch({ rpc, store, chain, log });
  // Manual LP/swap: Solana through the venue adapters + Jupiter (solana/manual.js), same routes.
  const manual = chain.kind === 'solana'
    ? new (require('./solana/manual').SolanaManual)({ engine, store, chain, rpc, log })
    : new Manual({ engine, store, chain, rpc, log });
  const compound = engine.compound || new Compound(engine);
  // Wallet holdings: EVM through eth_call + DexScreener, Solana through token accounts + Jupiter prices.
  const holdings = chain.kind === 'solana'
    ? new (require('./solana/holdings').SolanaHoldings)({ rpc, chain })
    : new Holdings({ rpc, store, chain, log });
  // A wallet's portfolio is cached briefly: the target detail page is polled, and
  // each computation means dozens of eth_calls + DexScreener.
  const holdingsCache = new Map();
  const market = new Market({ log, chain, gmgnKey: () => cfg.gmgn?.api_key || null });
  // The engine uses the same instance for the liquidity/volume filters: one 30-second
  // memo is shared, so a pool being viewed on the dashboard is not pulled
  // twice when entry evaluates it.
  if (engine && !engine.market) engine.market = market;
  // Secondary currency rate (the small annotation beside the dollar figure, see fx.js).
  const fx = new Fx({ store, log });
  // Running cost of each position (gas + swap difference) — computed once for all
  // positions then cached until a new transaction arrives.
  const costs = new Costs(store, chain.network);
  // The cost of one position in the shape used by the dashboard & Telegram: gas + swap
  // difference, split between opening and closing, plus its share of capital —
  // "how big the effort is" only means something compared against its capital.
  const costOf = (id, costUsd = null) => {
    const { hashes, ...c } = costs.of(id, engine.ethUsd);
    return { ...c, pctOfCost: costUsd > 0 ? (c.totalUsd / costUsd) * 100 : null };
  };

  // The origin of a position: the target copied, its original position, and — as far as
  // observed — how much THEY put in and withdrew from that position. Two sources, deliberately
  // separated because their age differs:
  //  - `watch`: from actions the watcher really saw (principal only, valued at the
  //    price at the event). Always present and always fresh, but only contains what
  //    happened after that wallet started being followed.
  //  - `mirror`: the wallet research result (wpositions) — full PnL including fees and sold
  //    leftover tokens, but only exists after the wallet has been scanned and can be stale.
  // Used by the Telegram cards (entry & close) and the history table: "who do we copy, how
  // much did they enter, how much did we enter" must not need two pages to answer.
  const originOf = (row, { watch = false } = {}) => {
    if (!row?.target) return { targetLabel: null, mirror: null, watch: null };
    const targetLabel = store.get('SELECT label FROM targets WHERE chain=? AND address=?', chain.network, row.target)?.label || null;
    const w = row.mirror_of
      ? store.get('SELECT * FROM wpositions WHERE chain=? AND wallet=? AND venue=? AND token_id=?', chain.network, row.target, row.venue, row.mirror_of)
      : null;
    const out = {
      targetLabel,
      target: row.target,
      tokenId: row.mirror_of || null,
      // Values in wpositions are ALREADY in USD (see WalletResearch.persist) — an ETH quote
      // side must not be multiplied by the ETH price again: a WETH-quoted target used to
      // show capital of $75 million in the origin column.
      mirror: !w ? null : {
        tokenId: w.token_id, status: w.status,
        costUsd: w.invested_q || 0,
        pnlUsd: w.pnl_q || 0,
        pnlPct: w.invested_q > 0 ? (w.pnl_q / w.invested_q) * 100 : null,
        openedTs: w.opened_ts, closedTs: w.closed_ts,
        // A target position still open is worth as of that wallet's last
        // scan, not the current price — the UI must say so.
        stale: w.status === 'open',
      },
      watch: null,
    };
    if (!watch || !row.mirror_of) return out;
    const acts = store.all(`SELECT ts, kind, liquidity, value_quote, quote_symbol, tick_lower, tick_upper
      FROM actions WHERE chain=? AND target=? AND venue=? AND token_id=? ORDER BY ts, id`,
    chain.network, row.target, row.venue, row.mirror_of);
    if (!acts.length) return out;
    let inUsd = 0, outUsd = 0, claims = 0, net = 0n;
    for (const a of acts) {
      const v = (a.value_quote || 0) * (chain.isEthLike(a.quote_symbol) ? engine.ethUsd : 1);
      if (a.kind === 'increase') inUsd += v;
      else if (a.kind === 'decrease') outUsd += v;
      else if (a.kind === 'claim') claims++;
      try { net += BigInt(a.liquidity || 0); } catch { /* action without an L delta */ }
    }
    const first = acts[0], last = acts[acts.length - 1];
    out.watch = {
      inUsd, outUsd, claims, events: acts.length,
      // Withdrawn − deposited: PRINCIPAL only. Fees they harvested separately are not
      // counted (an 'claim' action has no value), so this figure is a floor, not a certain
      // profit — whatever shows it must say so.
      pnlUsd: outUsd > 0 && inUsd > 0 ? outUsd - inUsd : null,
      pnlPct: outUsd > 0 && inUsd > 0 ? ((outUsd - inUsd) / inUsd) * 100 : null,
      open: net > 0n,
      openedTs: first.ts, lastTs: last.ts,
      heldSec: last.ts > first.ts ? (last.ts - first.ts) / 1000 : null,
      tickLower: first.tick_lower, tickUpper: first.tick_upper,
    };
    return out;
  };

  // The reverse of originOf: from one position of the TARGET WALLET, what we did
  // about it. The wallet research drawer shows someone else's position thoroughly —
  // principal, fee, every on-chain event — but is silent on the one thing that
  // really is ours: whether we copied that position, and if not, why.
  // The answer used to be scattered across the Positions and Activity pages; here
  // it is gathered into one:
  //  - `positions`: our copy (positions.mirror_of = that target's token_id),
  //  - `decisions`: the engine's decisions on each target action in that position — this is
  //    the "why it was not followed" reason already written as it is by policy/engine,
  //  - the rest (not a target, target disabled, target added later)
  //    is sent raw so the view composes the sentence, in its own language.
  const copyOf = (target, tokenId, venue = null) => {
    const t = store.get('SELECT label, enabled, added_ts FROM targets WHERE chain=? AND address=?', chain.network, target);
    const k = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);
    const live = new Map(engine.positions.live.map((p) => [p.id, p]));
    const rows = store.all(
      `SELECT * FROM positions WHERE chain=? AND target=? AND mirror_of=?${venue ? ' AND venue=?' : ''} ORDER BY id`,
      ...[chain.network, target, String(tokenId), ...(venue ? [venue] : [])]);
    const positions = rows.map((r) => {
      const l = live.get(r.id);
      const costUsd = (r.cost_quote || 0) * k(r.quote_symbol);
      const outUsd = (r.out_quote || 0) * k(r.quote_symbol);
      const base = {
        id: r.id, status: r.status, venue: r.venue, tokenId: r.token_id,
        openedTs: r.opened_ts, closedTs: r.closed_ts, takeoverTs: r.takeover_ts ?? null,
        txOpen: r.tx_open, txClose: r.tx_close, costUsd,
      };
      if (r.status === 'closed') return { ...base, outUsd, feeUsd: (r.fees_quote || 0) * k(r.quote_symbol), pnlUsd: outUsd - costUsd, pnlPct: costUsd > 0 ? ((outUsd - costUsd) / costUsd) * 100 : null };
      if (r.status !== 'open') return base;
      // An open position not yet touched by a sync (freshly minted, or the engine just
      // came up) only has its capital; flagged `syncing` so the view does not
      // present zero PnL as news.
      if (!l) return { ...base, syncing: true };
      return { ...base, valueUsd: l.valueUsd, feeUsd: l.feeUsd, pnlUsd: l.pnlUsd, pnlPct: l.pnlPct, inRange: l.inRange };
    });
    const decisions = store.all(
      `SELECT a.id AS action_id, a.ts, a.kind, a.value_quote, a.quote_symbol, a.tx_hash,
              d.verdict, d.reason, d.position_id
       FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
       WHERE a.chain=? AND a.target=? AND a.token_id=?${venue ? ' AND a.venue=?' : ''}
       ORDER BY a.ts, a.id`,
      ...[chain.network, target, String(tokenId), ...(venue ? [venue] : [])])
      .map((r) => ({
        actionId: r.action_id, ts: r.ts, kind: r.kind, txHash: r.tx_hash,
        verdict: r.verdict || null, reason: r.reason || null, positionId: r.position_id || null,
        valueUsd: r.value_quote == null ? null : r.value_quote * k(r.quote_symbol),
      }));
    return {
      isTarget: !!t, label: t?.label || null, enabled: t ? !!t.enabled : false,
      addedTs: t?.added_ts ?? null, positions, decisions,
    };
  };

  // The queue of leftover memecoins not yet sold, with symbol & decimals so the dashboard
  // can write "688k DRIPPYPIGEON". Included in /api/overview: the warning
  // must show on ALL pages, not just when one happens to open Positions.
  const leftoverRows = () => {
    const toks = tokenMeta();
    return engine.leftovers().map((it) => {
      const t = toks.get(canon(it.token));
      return { ...it, symbol: t?.symbol || null, decimals: t?.decimals ?? 18, amountNum: Number(it.amount || 0) / 10 ** (t?.decimals ?? 18) };
    });
  };
  // The key of one queue item from the request body. posId MAY be empty: leftovers
  // swept from the wallet do not come from any position, and Number(undefined)
  // becomes NaN, which would never match the null in the queue.
  const leftoverKey = (b) => ({
    posId: b?.posId == null || b.posId === '' ? null : Number(b.posId),
    token: canon(b?.token || ''),
  });
  const sameLeftover = (x, k) => (x.posId ?? null) === k.posId && canon(x.token) === k.token;

  // A token or not? A large LP wallet is often a CONTRACT (smart wallet, Safe),
  // so "has code" does not yet mean a token — what decides is whether symbol() and
  // decimals() answer. The metadata is stored (chain.tokens) only if it really is a
  // token, so the tokens table does not get wallet addresses in it.
  const probeToken = async (a) => {
    if (SOL) {
      // Solana: a mint account = a token; anything else is taken as a wallet.
      const t = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
      return t ? { kind: 'token', symbol: t.symbol || '?', name: t.name || '', decimals: t.decimals } : { kind: 'wallet' };
    }
    const code = await rpc.call('eth_getCode', [a, 'latest']);
    if (!code || code === '0x') return { kind: 'wallet' };
    const [sym, dec] = await rpc.ethCallMany([{ to: a, data: '0x95d89b41' }, { to: a, data: '0x313ce567' }]);
    const d = dec && dec.length >= 66 ? Number(BigInt(dec.slice(0, 66))) : null;
    if (!sym || sym === '0x' || d == null || d > 36) return { kind: 'contract' };
    const t = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
    return { kind: 'token', symbol: t?.symbol || '?', name: t?.name || '', decimals: t?.decimals ?? d };
  };

  // USD price per token for the swap balance list. Quote assets from the engine's ETH price;
  // other tokens from the DexScreener pool with the largest liquidity (cached 30 seconds).
  // Time-bounded: the page must not wait for a slow DexScreener.
  const usdPrice = async (a) => {
    if (QUOTES[a]) return QUOTES[a].kind === 'usd' ? 1 : engine.ethUsd || null;
    const mk = await Promise.race([market.token(a), new Promise((r) => setTimeout(() => r(null), 3000))]).catch(() => null);
    const pairs = mk?.pairs || [];
    const asBase = pairs.find((p) => p.priceUsd && p.base.address === a);
    if (asBase) return asBase.priceUsd;
    // A token that only appears as a pool's quote side: the base's USD price divided by the
    // base's price in this token (priceNative) = this token's price.
    const asQuote = pairs.find((p) => p.priceUsd && p.priceNative && p.quote.address === a);
    return asQuote ? asQuote.priceUsd / asQuote.priceNative : null;
  };

  // The portfolio of one wallet, with a cache: tokens with a balance + their USD value. Used by the
  // "Wallet contents" panel and the balance summary in the target list — both are polled, and
  // each computation means dozens of eth_calls + DexScreener.
  const holdingsOf = async (addr, { refresh = false, maxAge = 60_000 } = {}) => {
    const hit = holdingsCache.get(addr);
    if (hit && !refresh && Date.now() - hit.ts < maxAge) return hit.data;
    const tokens = await holdings.of(addr);
    const batch = holdings.prices ? await holdings.prices(tokens.map((x) => x.address)) : null;
    await Promise.all(tokens.map(async (x) => {
      x.priceUsd = x.amount > 0 ? (batch ? batch.get(x.address) ?? null : await usdPrice(x.address)) : null;
      x.usd = x.priceUsd != null ? x.amount * x.priceUsd : null;
    }));
    const totalUsd = tokens.reduce((a, x) => a + (x.usd || 0), 0);
    for (const x of tokens) x.sharePct = totalUsd > 0 && x.usd != null ? (x.usd / totalUsd) * 100 : null;
    // Valued first (large to small), then those whose price was not found.
    tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
    const data = { address: addr, tokens, totalUsd, unpricedN: tokens.filter((x) => x.amount > 0 && x.usd == null).length, ts: Date.now() };
    holdingsCache.set(addr, { ts: data.ts, data });
    // The total is stored too: the target list must be able to show each wallet's cash
    // right after the bot is restarted, without waiting for a chain scan first.
    store.setState(`held_usd:${addr}`, JSON.stringify({ usd: totalUsd, ts: data.ts }));
    return data;
  };

  // The target's money: cash in the wallet + the value of LP positions still open. A wallet whose
  // remainder is only a few tens of dollars has usually stopped LPing — the target
  // list uses this figure to flag it, without having to open each one.
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
  // One wallet per call, the stalest first: /api/targets is polled every
  // 15 seconds and a portfolio scan costs dozens of eth_calls — refreshing all
  // targets at once would hit 429 and drag down the whole dashboard.
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

  // A single door for all wallet scans: the dashboard button, the automatic update
  // when the page is opened, and the update when a target is detected acting. A wallet
  // may only have one job running.
  //   mode 'full'    — rebuild all positions in the `blocks` window
  //   mode 'refresh' — only blocks since the last scan + positions still open
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

  // Research is considered stale after 5 minutes; opening it triggers an incremental update in
  // the background. A FAILED update is not repeated continuously on every poll — wait first.
  const STALE_MS = 5 * 60_000;
  const RETRY_AFTER_FAIL_MS = 2 * 60_000;
  const maybeRefresh = (addr, w, reason) => {
    const job = walletJobs.get(addr);
    if (job?.status === 'jalan') return;
    if (job?.status === 'gagal' && Date.now() - (job.finishedAt || 0) < RETRY_AFTER_FAIL_MS) return;
    if (w && Date.now() - (w.last_scan_ts || 0) < STALE_MS) return;
    startWalletJob(addr, { mode: 'refresh', reason });
  };

  // A target that just acted: update its research ~20 seconds later (a single
  // rebalance action is usually several consecutive events — one update is enough).
  // Only for wallets that have been scanned before; the first scan stays manual.
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

  // Equity sizing needs the target's research (its open LP). An entry never waits for it: the
  // engine asks here, the first scan / refresh runs in the background, and the entry that asked
  // follows the equity fallback. Failed jobs are not retried on every entry (see maybeRefresh).
  engine.onResearchNeeded = (addr, mode) => {
    try {
      if (mode === 'refresh') return maybeRefresh(addr, store.get('SELECT last_scan_ts FROM wallets WHERE chain=? AND address=?', chain.network, addr), 'equity');
      const job = walletJobs.get(addr);
      if (job?.status === 'jalan') return;
      if (job?.status === 'gagal' && Date.now() - (job.finishedAt || 0) < RETRY_AFTER_FAIL_MS) return;
      startWalletJob(addr, { mode: 'full', reason: 'equity' });
    } catch (e) { log(`riset ${addr}: ${e.message}`); }
  };

  // Token gate. This dashboard can switch on LIVE mode and close positions, so it
  // must not be simply open once exposed to the internet. The token is stored in
  // the config; if empty, the gate is off (safe for 127.0.0.1 only).
  // Telegram mini app session. The /mini page exchanges initData for a short-lived
  // random ticket and uses it as a Bearer. Deliberately NOT the dashboard token itself:
  // on Telegram Web our page is inside someone else's iframe, so SameSite=Lax
  // cookies are not sent and the page is forced to hold something itself —
  // and what it holds must not be a key usable forever.
  const miniSessions = new Map();                  // ticket -> { exp, userId, name }
  const MINI_TTL = 12 * 3600_000;
  const miniNew = (user) => {
    const now = Date.now();
    for (const [k, v] of miniSessions) if (v.exp <= now) miniSessions.delete(k);
    const t = crypto.randomBytes(32).toString('hex');
    miniSessions.set(t, { exp: now + MINI_TTL, userId: String(user.id), name: user.username || user.first_name || null });
    return t;
  };
  const miniOk = (t) => { const s = miniSessions.get(t); return !!s && s.exp > Date.now(); };

  const tokenNow = () => cfg.server?.auth_token || null;
  const authed = (req) => {
    const TOKEN = tokenNow();
    if (!TOKEN) return true;
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
      const t = h.slice(7);
      if (safeEq(t, TOKEN)) return true;
      if (miniOk(t)) return true;                  // mini app ticket: the same rights, short lifetime
    }
    const ck = (req.headers.cookie || '').split(';').map((x) => x.trim());
    const c = ck.find((x) => x.startsWith('lpcopy_token='));
    return !!c && safeEq(decodeURIComponent(c.slice(13)), TOKEN);
  };
  const safeEq = (a, b) => {
    const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };

  // HTTPS? Behind Cloudflare/a reverse proxy the connection to Node can be HTTP, but the
  // original protocol to the browser is in X-Forwarded-Proto. Used to mark the
  // session cookie `Secure`: this token can move funds, so it must not be
  // sent over a plain HTTP connection.
  const isHttps = (req) => !!req.socket?.encrypted
    || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  // The only place the session cookie string is built — used by the /login page and
  // token rotation (via the sessionCookie passed to the Settings route).
  const sessionCookie = (req, token) =>
    `lpcopy_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps(req) ? '; Secure' : ''}`;
  // Logout button: the same cookie is emptied and expires immediately.
  const clearCookie = (req) => `lpcopy_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
  // Client IP for the login rate limit: behind Cloudflare the real IP is in a header, not
  // on the socket (which is always Cloudflare/loopback).
  const clientIp = (req) => req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || '?';
  // Login rate limit: 10 failures per IP close /login for 5 minutes. A 144-bit random token is already
  // unrealistic to guess, this only closes a gap if the dashboard is exposed.
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
  // Requests from inside the process (the Telegram bot) carry their body directly in
  // req.__body — there is no stream to read. See callApi below.
  const readBody = (req) => (req.__body ? Promise.resolve(req.__body) : new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  }));
  // Via writeCfg: values from .env must not get written to config.json.
  const saveCfg = () => writeCfg(cfgPath, cfg);

  // Token logos from GeckoTerminal, stored beside the database. The first warm-up
  // is delayed briefly so it does not fight the engine's initial sync for the network.
  // Without a database path (tests) there is nowhere to store, so no warm-up.
  const dbPath = cfg.db?.path;
  const icons = new Icons({ store, chain, dir: dbPath ? path.join(path.dirname(dbPath), 'icons') : path.join(require('node:os').tmpdir(), 'lpcopy-icons'), log });
  if (dbPath) {
    const warmIcons = () => { try { const n = icons.warm(); if (n) log(`logo: mengambil ${n} logo token dari GeckoTerminal`); } catch (e) { log(`logo: ${e.message}`); } };
    setTimeout(warmIcons, 15_000).unref?.();
    setInterval(warmIcons, 30 * 60_000).unref?.();
  }

  // Scanned pools that can really be entered: paired with a quote asset,
  // with liquidity, and whose fee can be valued up front.
  const enterable = (p) => p.quoteSide != null && p.kosong !== true && !p.dynamicFee;

  // Win/lose is judged from proceeds − capital − swap difference (open & close slippage):
  // slippage is the price that really vanished in that position, so a minus because of
  // slippage is still a loss. Gas is NOT included — a position whose result = capital and only
  // pays gas is not a loss, but break-even. Under one cent counts as break-even.
  const FLAT = 0.01;
  const netResult = (p) => p.pnl - (costs.of(p.id, engine.ethUsd).slipUsd || 0);

  // The result of OUR positions per source: the target copied, or '' for a manual position /
  // one outside the bot. Realized = closed positions (out − capital); running = the live PnL
  // of open positions (already including fees ever claimed). Used by the Target page
  // and the "per source" card in Overview so the figures are exactly the same.
  const pnlByTarget = (closed) => {
    const eth = engine.ethUsd;
    const k = (q) => (chain.isEthLike(q) ? eth : 1);
    closed ??= store.all("SELECT id, target, cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed' AND closed_ts IS NOT NULL", chain.network)
      .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
    const live = new Map(engine.positions.live.map((p) => [p.id, p]));
    const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
    const by = new Map();
    const grp = (t) => {
      const key = t || '';
      if (!by.has(key)) by.set(key, { target: key || null, label: key ? labels.get(key) || null : null, open: 0, value: 0, upnl: 0, closed: 0, wins: 0, losses: 0, realized: 0, costUsd: 0 });
      return by.get(key);
    };
    // Gas + swap slippage paid for each position (open and closed) that position PnL leaves out
    // (leftover-sale slippage is already inside it), so the per-source result is on the same
    // net basis as the wallet's net PnL.
    const outsideCost = (id) => { const c = costs.of(id, eth); return (c.gasUsd || 0) + (c.outsideSlipUsd || 0); };
    for (const r of store.all("SELECT id, target, cost_quote, quote_symbol FROM positions WHERE chain=? AND status='open'", chain.network)) {
      const l = live.get(r.id);
      if (l?.empty) continue;
      const g = grp(r.target);
      g.costUsd += outsideCost(r.id);
      g.open++;
      g.value += l ? (l.valueUsd || 0) + (l.feeUsd || 0) : (r.cost_quote || 0) * k(r.quote_symbol);
      g.upnl += l?.pnlUsd || 0;
    }
    for (const p of closed) {
      const g = grp(p.target);
      const h = netResult(p);
      g.costUsd += outsideCost(p.id);
      g.closed++; g.realized += p.pnl; if (h > FLAT) g.wins++; else if (h < -FLAT) g.losses++;
    }
    // Copy attempts that never became a position (reverted mint, orphan zap): the cost has no
    // position row, so it is shown per target — which target is expensive to copy.
    for (const [target, f] of costs.failed(eth)) {
      if (!target) continue;
      const g = grp(target);
      g.failedUsd = f.totalUsd; g.failedAttempts = f.attempts;
    }
    // Net result of the source: position results minus every cost paid to get them.
    for (const g of by.values()) g.net = g.realized + g.upnl - g.costUsd - (g.failedUsd || 0);
    return by;
  };

  // Bot positions, researched wallet positions, and target moves matching one
  // SQL condition (e.g. "token0=? OR token1=?" or "pool_ref=?") — the material for the token
  // detail and pool detail pages, so both compute PnL the same way.
  const lpRows = async (cond, args) => {
    const toks = tokenMeta();
    const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
    const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
    const kOf = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);

    // Wallet label: used by the bot position source column (the target wallet copied),
    // the research position wallet column, and the target column in target moves.
    const labels = new Map(store.all('SELECT address,label FROM wallets WHERE chain=?', chain.network).map((w) => [w.address, w.label]));
    for (const t of store.all('SELECT address,label FROM targets WHERE chain=?', chain.network)) if (t.label) labels.set(t.address, t.label);

    // Bot positions. Open ones from the last sync result (current value & PnL).
    // targetLabel is attached to the copy of its row, not to the engine's live object.
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

    // Researched wallet positions (targets and other wallets that have been scanned).
    const targets = new Set(store.all('SELECT address FROM targets WHERE chain=?', chain.network).map((t) => t.address));
    // liquidity & returned_q are also read because the re-valuation below needs them:
    // without liquidity a v3 position cannot be valued, and without returned_q a withdrawal
    // that is already in the pocket vanishes from its PnL.
    const wallets = store.all(`SELECT wallet, venue, token_id, pool_ref, token0, token1, fee, tick_lower, tick_upper, status,
        opened_ts, closed_ts, liquidity, invested_q, returned_q, live_value_q, live_fee_q, fees_q, pnl_q, incomplete
      FROM wpositions WHERE chain=? AND (${cond}) ORDER BY COALESCE(closed_ts, opened_ts) DESC LIMIT 300`, chain.network, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), dec0: dec(r.token0), dec1: dec(r.token1),
        quoteSide: quoteSideOf(r.token0, r.token1), walletLabel: labels.get(r.wallet) || null, isTarget: targets.has(r.wallet),
        ageHours: r.opened_ts ? ((r.closed_ts || Date.now()) - r.opened_ts) / 3600000 : null }));
    // Pool price at the entry/exit of each position, from events stored at scan
    // time — used by the wallet position history drawer (the same as /api/wallet).
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
    // Still-open wallet positions are re-valued at the current price. The stored figures
    // come from that wallet's last scan — without this, the research table and the bot
    // position table on the same page can show opposite PnL directions for the same
    // pool and range, merely because the two were measured at different times.
    try { await research.refreshOpen(wallets, engine.ethUsd); }
    catch (e) { log(`nilai posisi riset terbuka: ${e.message}`); }
    for (const r of wallets) {
      r.pnlPct = r.invested_q > 0 ? (r.pnl_q / r.invested_q) * 100 : null;
      r.dprPct = r.invested_q > 0 && r.ageHours > 0 ? (r.pnl_q / r.invested_q) * (24 / r.ageHours) * 100 : null;
    }

    // Target moves, with the bot's decisions on them.
    const activity = store.all(`SELECT a.id, a.ts, a.target, a.venue, a.kind, a.token_id, a.pool_ref, a.token0, a.token1, a.fee,
        a.value_quote, a.quote_symbol, d.verdict, d.reason, d.position_id
      FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE a.chain=? AND (${cond.replace(/\b(token0|token1|pool_ref)\b/g, 'a.$1')}) ORDER BY a.ts DESC, a.id DESC LIMIT 100`, chain.network, ...args)
      .map((r) => ({ ...r, symbol0: sym(r.token0), symbol1: sym(r.token1), targetLabel: labels.get(r.target) || null }));

    return { open, closed, wallets, activity };
  };

  // Pools whose manual LP is being opened (double-click guard, see POST /api/manual/lp/open).
  const manualOpening = new Set();
  const ladderJobs = new Map();
  const ladderBody = (b) => ({
    poolRef: String(b.poolRef || ''), usd: Number(b.usd),
    topPct: b.topPct != null ? Number(b.topPct) : 0, bottomPct: Number(b.bottomPct),
    layers: Number(b.layers), method: String(b.method || 'linear'),
  });
  // Wallet capital for net PnL: the virtual balance in simulation (paper.js), else the tracked deposits.
  const capitalOf = () => (engine.paper?.on?.() ? engine.paper.capital() : engine.capital?.summary?.() || null);
  const capitalRows = () => (engine.paper?.on?.() ? [] : engine.capital.rows());
  const routes = {
    'GET /api/overview': async () => {
      // Cash is re-read if a tx has landed in a block since the last read (see
      // Engine.freshCash) — called BEFORE summary so the leftover token value that
      // is refreshed there gets used.
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
      // Portfolio total & PnL now — the same figures as /api/portfolio, but
      // without the curve/calendar, so it is cheap enough to be polled every 5 seconds (the tab title).
      const value = (cash?.usd || 0) + s.exposureUsd + (s.leftoverUsd || 0) + s.feeUsd;
      const pnl = s.realizedUsd + s.unrealizedUsd;
      const capital = capitalOf();
      const wallet = engine.positions.lastSync ? { value, pnl, netPnl: capital && cash ? value - capital.capitalUsd : null } : null;
      return {
        // auth: the token gate is on → the dashboard shows a logout button.
        mode: { dry_run: engine.dryRun(), paused: engine.paused(), wallet: engine.exec.address(), auth: !!tokenNow(), drawdown: engine.drawdownStatus(), sim: engine.paper?.status?.() ?? null },
        wallet,
        chain: {
          head: engine.head, cursor: engine.cursor, lag: engine.head - engine.cursor, ethUsd: engine.ethUsd, headSpread: engine.headSpread,
          // "Lagging" alone is not enough to judge health: `head` is only
          // updated INSIDE the tick, so a stuck tick freezes head AND the cursor
          // together — lag stays 0 while the bot has been blind for hours. The age of the
          // last SUCCESSFUL scan is the honest figure.
          lastScan: engine.lastScanAt || null, stuckSec: Math.round((engine.tickStuckMs?.() || 0) / 1000),
          // identity of this view's chain — the dashboard uses it for labels, symbols, and explorer links
          key: chain.network, kind: chain.kind || 'evm', label: chain.label, chainId: chain.CHAIN_ID, nativeSymbol: chain.nativeSymbol,
          usdgSymbol: chain.usdgSymbol, wethSymbol: chain.wethSymbol, verified: chain.verified,
          explorer: chain.explorer, dexscreener: chain.dexscreener, geckoterminal: chain.geckoterminal, gmgn: chain.gmgn, uniswap: chain.uniswap,
          venues: [...(SOL ? [] : ['v4']), ...chain.venues.map((v) => v.key)],
        },
        stats: { ...engine.stats, uptimeSec: Math.round((Date.now() - engine.stats.startedAt) / 1000), lastError: engine.lastError },
        totals: tot,
        summary: s, equity: eq, decisionsTotal: dec, skipReasons: skipTop,
        // remaining copy quota (daily budget, exposure, position slots, ready-to-use cash)
        room: engine.copyRoom ? engine.copyRoom(cash) : null,
        rpc: rpc.stats(),
        unsupportedSenders: [...engine.watcher.unsupported.entries()].map(([a, n]) => ({ address: a, n })),
        lastSync: engine.positions.lastSync,
        // Secondary currency: the dashboard attaches it small beside the dollar figures.
        // Included here so all pages get the rate from the poll that already exists.
        fx: fx.view(currencyOf(cfg)),
        // Default value redaction (Settings → Display): every new dashboard tab and mini
        // app starts redacted; the eye icon only opens it for that tab.
        hideValues: !!cfg.display?.hide_values,
        leftovers: leftoverRows(), leftoverRetrySec: engine.leftoverRetrySec ? engine.leftoverRetrySec() : 5,
      };
    },
    // Our portfolio: current total, growth curve, PnL per day, and
    // performance per source (target copied / manual). Separate from /api/overview
    // because overview is polled every 5 seconds — this data is enough every half minute.
    'GET /api/portfolio': async (req, url) => {
      const SPAN = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: 0 };
      const range = url.searchParams.get('range') in SPAN ? url.searchParams.get('range') : '7d';
      const now = Date.now();
      const from = SPAN[range] ? now - SPAN[range] : 0;
      const eth = engine.ethUsd;
      const k = (q) => (chain.isEthLike(q) ? eth : 1);
      const cash = await engine.freshCash();      // before summary, see /api/overview
      const s = engine.positions.summary(eth);
      const lo = s.leftoverUsd || 0;
      const value = (cash?.usd || 0) + s.exposureUsd + lo + s.feeUsd;
      const pnl = s.realizedUsd + s.unrealizedUsd;

      const rows = store.all(`SELECT ts, wallet_quote AS cash, positions_quote AS pos, fees_quote AS fee,
        total_quote AS total, pnl_quote AS pnl, open_positions AS n FROM equity WHERE chain=? AND ts >= ? ORDER BY ts`, chain.network, from);
      // The "now" point so the end of the chart matches the figure on the card, not
      // lagging up to 5 minutes behind it.
      if (engine.positions.lastSync) {
        rows.push({ ts: now, cash: cash ? cash.usd : null, pos: s.exposureUsd + lo, fee: s.feeUsd, total: value, pnl, n: s.openCount, live: true });
      }
      // The last point BEFORE the window: the reference for "how much it changed in this range".
      const baseline = from ? store.get('SELECT ts, pnl_quote AS pnl, total_quote AS total, wallet_quote AS cash FROM equity WHERE chain=? AND ts < ? ORDER BY ts DESC LIMIT 1', chain.network, from) || null : null;
      // Wallet net PnL = total − capital(t); capital(t) = baseline + deposits − withdrawals
      // up to t (see capital.js). An equity point without cash (NULL) has no legitimate
      // total, so its net is not computed either.
      const capital = capitalOf();
      if (capital) {
        const deps = capitalRows();
        const capAt = (ts) => capital.baselineUsd + deps.filter((d) => d.ts <= ts).reduce((a, d) => a + (d.kind === 'deposit' ? d.usd : -d.usd), 0);
        // The "now" point without cash is also not legitimate: right after a restart cash is not yet
        // read, total = positions only, and the chart end plunges by the whole cash amount.
        for (const r of rows) r.net = r.cash == null ? null : r.total - capAt(r.ts);
        if (baseline) baseline.net = baseline.cash == null ? null : baseline.total - capAt(baseline.ts);
      }
      // High/low/drawdown from ALL points, before thinning: a point dropped by thinning
      // may be the peak or the trough (a 7-day drawdown read
      // $70.96 when it was $73.63).
      const extremes = {};
      const keep = new Set();   // indexes of important points that thinning must not drop
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
        // ts of the peak/trough so the chart can mark the same point as its figure
        extremes[key] = { hi, lo: lo2, dd, hiTs: rows[iHi].ts, loTs: rows[iLo].ts,
          ddPeakTs: iDdPeak >= 0 ? rows[iDdPeak].ts : null, ddTroughTs: iDdTrough >= 0 ? rows[iDdTrough].ts : null };
      }

      // One point every 5 minutes = 8,640 points per 30 days, far denser than the chart's
      // pixels. Take the last point of each bucket; the first point, the "now" point,
      // and the peak/trough above still come along — without that a spike
      // that becomes the "High" or the drawdown base could vanish from its line.
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

      // Closed positions: the material for the calendar (grouped per day in the browser, using the
      // user's time zone) and win/lose statistics.
      const closed = store.all("SELECT id, target, opened_ts, closed_ts, cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed' AND closed_ts IS NOT NULL ORDER BY closed_ts", chain.network)
        .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
      const pnls = closed.map((p) => p.pnl);
      // Break-even (proceeds = capital after slippage, the difference is only gas) is not a loss:
      // if counted as a loss, the win rate drops although the positions that
      // really lost are only a handful. Win rate = wins / (wins + losses).
      const outcome = closed.map(netResult);
      const wins = outcome.filter((x) => x > FLAT).length;
      const losses = outcome.filter((x) => x < -FLAT).length;
      const holds = closed.filter((p) => p.opened_ts).map((p) => (p.closed_ts - p.opened_ts) / 3600000);

      // Per source: the target copied, or '' for a manual position / one outside the bot.
      const by = pnlByTarget(closed);

      return {
        range, from, series, baseline, extremes,
        now: {
          value, cash, positionsUsd: s.exposureUsd, feeUsd: s.feeUsd, costUsd: s.costUsd,
          // leftover memecoin from positions that have closed, not yet sold, at the current price
          leftoverUsd: lo,
          pnl, realizedUsd: s.realizedUsd, unrealizedUsd: s.unrealizedUsd,
          // Net capital ≈ what was ever deposited: the current value minus all profit.
          // Without a cash balance (wallet-less mode) it cannot be computed.
          capital: cash ? value - pnl : null,
          openCount: s.openCount, inRange: s.inRange,
          // Real capital (baseline + deposits − withdrawals) and the net PnL against it —
          // includes zap, gas, and ETH↔USDG swap costs that are not in per-position PnL.
          capitalNet: capital && cash ? capital.capitalUsd : null,
          netPnl: capital && cash ? value - capital.capitalUsd : null,
          // Gas of all bot transactions (failed ones pay gas too) since capital started being recorded —
          // the largest cost that is in net PnL but not in position PnL. Valued at the
          // current ETH price, the same as the transaction list.
          ...gasSince(capital?.baselineTs ?? 0),
          // Measured swap slippage over the same window (quote in − quote out − execution shift).
          slipUsd: costs.slipSince(capital?.baselineTs ?? 0).slipUsd,
          // Gas + swap slippage of copy attempts that never became a position, all targets.
          failedCopyUsd: [...costs.failed(engine.ethUsd).values()].reduce((a, f) => a + f.totalUsd, 0),
        },
        capital: capital ? { ...capital, deposits: capitalRows().map((d) => ({
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
        byTarget: [...by.values()].sort((a, b) => b.net - a.net),
      };
    },
    'GET /api/positions': () => {
      // A closed position only stores the token address; without a symbol, the table is just
      // a row of NFT numbers that cannot be recognised.
      const closed = store.all("SELECT * FROM positions WHERE chain=? AND status='closed' ORDER BY closed_ts DESC LIMIT 100", chain.network);
      const toks = tokenMeta();
      // The list from the database, the figures from the last sync. The list used to come
      // straight from the sync result (every 30 seconds): after a restart the table is empty until the
      // first sync finishes, a freshly minted position appeared only ~30 seconds
      // later, and a freshly closed one was still shown. A position not yet synced
      // shows first with its capital figure, flagged `syncing`.
      const live = new Map(engine.positions.live.map((p) => [p.id, p]));
      const k = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);
      const sym = (x) => toks.get(x)?.symbol || QUOTES[x]?.symbol || '?';
      const dec = (x) => toks.get(x)?.decimals ?? QUOTES[x]?.decimals ?? 18;
      // The origin of each row: the target wallet copied, and — if that wallet was ever
      // researched — the fate of its original position. Our copy enters a few blocks after
      // the target and exits on its own decision, so the results almost never
      // match; putting the two figures side by side makes the difference readable, not
      // guessed from two different pages.
      const origin = (r) => { const { targetLabel, mirror } = originOf(r); return { targetLabel, mirror }; };
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
      // takeover_ts is read from the database, not the sync result (can be 30 seconds old):
      // the take over/hand back button must switch immediately.
      const takeover = new Map(store.all("SELECT id, takeover_ts FROM positions WHERE chain=? AND status='open'", chain.network).map((r) => [r.id, r.takeover_ts]));
      return {
        positions: positions.map((p) => ({
          ...p, takeover_ts: takeover.get(p.id) ?? null, compound: compound.status(p), ...origin(p),
          cost: costOf(p.id, p.costUsd),
        })),
        closed, syncedAt: engine.positions.lastSync,
      };
    },
    // The "Refresh" button on the positions table. An ordinary poll only repeats the last sync
    // result — up to 30 seconds old — so a button that only reloads the
    // page would return exactly the same figures and lie about their
    // freshness. Here the chain is really read again first, then the list is
    // sent. What is replied is only the sync time: the caller gets the list via
    // GET as usual, so there is only one data path to the table.
    'POST /api/positions/sync': async () => {
      // Cash and leftover token value are also re-read: this button promises fresh figures
      // for the whole page, including the portfolio total card.
      const books = engine.refreshCash().then(() => engine.positions.refreshLeftovers(engine.ethUsd, engine.exec.address())).catch(() => null);
      try { await Promise.all([engine.positions.resync(engine.ethUsd), books]); }
      catch (e) { return { error: e.message, syncedAt: engine.positions.lastSync }; }
      return { ok: true, syncedAt: engine.positions.lastSync };
    },
    // One position for the detail page. An open one is taken from the last sync result
    // (value, fee, current price); one already closed — or freshly opened and not yet
    // synced — from the database, dressed up just enough to have the same shape.
    'GET /api/position': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE chain=? AND id=?', chain.network, id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      // A row already 'closed' in the DB is the truth: the last sync result still
      // contains that position (a stale value) until the next sync, ~30 seconds after the close.
      const live = row.status === 'closed' ? null : engine.positions.live.find((p) => p.id === id);
      const toks = tokenMeta();
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
      // Freshly minted, not yet in a sync: the value/fee/PnL figures below are still estimates
      // from capital — the detail page flags them, not presenting them as certain news.
      pos.syncing = row.status !== 'closed' && !live;
      pos.exitSqrt = row.exit_sqrt || null;
      pos.claimedUsd = (row.claimed_quote || 0) * k;
      // partial withdrawal proceeds already in the wallet while the position is still open
      pos.withdrawnUsd = row.status === 'closed' ? 0 : (row.out_quote || 0) * k;
      pos.compound = compound.status(row);
      pos.outUsd = outUsd;
      pos.quoteKind = chain.isEthLike(row.quote_symbol) ? 'eth' : 'usd';
      // Position origin: who is being copied, which position is theirs, and how much they
      // put in/withdrew there. The Telegram entry & close cards put it beside
      // our own figures.
      pos.origin = originOf(row, { watch: true });
      pos.targetLabel = pos.origin.targetLabel;
      pos.target = row.target; pos.mirror_of = row.mirror_of; pos.takeover_ts = row.takeover_ts ?? null;
      // Speculative token = the one that is not a quote asset; the price base in the chart.
      pos.baseToken = pos.quoteSide === 0 ? row.token1 : pos.quoteSide === 1 ? row.token0 : row.token0;
      pos.cost = costOf(id, costUsd);
      return { position: pos, ethUsd: engine.ethUsd, syncedAt: engine.positions.lastSync };
    },
    // History of one bot position for the detail drawer: every transaction that touched it
    // (zap swap, mint, add, decrease, close, leftover sale) with token amounts and values,
    // plus the bot's notes — the decision on the target action that triggered it and the log lines that
    // mention this position.
    'GET /api/position/history': (req, url) => {
      const id = Number(url.searchParams.get('id'));
      const row = store.get('SELECT * FROM positions WHERE chain=? AND id=?', chain.network, id);
      if (!row) return { error: 'posisi tidak ditemukan' };
      const toks = tokenMeta();
      const isEth = chain.isEthLike(row.quote_symbol);
      const k = isEth ? engine.ethUsd : 1;
      const parse = (d) => { try { return JSON.parse(d || '{}') || {}; } catch { return {}; } };
      const gasUsd = (t) => (t.gas_used && t.gas_price ? (Number(t.gas_used) * Number(BigInt(t.gas_price))) / 1e18 * engine.ethUsd : null);
      // Transactions that touched this position: the open/close hash, those that recorded the position number
      // in their detail (close, leftover sale, add), decisions linked to this position, and
      // the zap in the same pool during the position's life (a zap does not store the position number —
      // the number only exists after a successful mint).
      const lo = (row.opened_ts || 0) - 15 * 60_000, hi = (row.closed_ts || Date.now()) + 60_000;
      const txs = store.all(`
        SELECT * FROM txs WHERE chain = ? AND (hash IN (?, ?)
           OR json_extract(detail, '$.position') = ?
           OR json_extract(detail, '$.recorded') = ?
           OR (kind = 'increase' AND (json_extract(detail, '$.plan.positionId') = ? OR json_extract(detail, '$.plan.tokenId') = ?))
           OR EXISTS (SELECT 1 FROM json_each(txs.detail, '$.positionSales') sale WHERE json_extract(sale.value, '$.position') = ?)
           OR EXISTS (SELECT 1 FROM json_each(txs.detail, '$.feeSales') sale WHERE json_extract(sale.value, '$.position') = ?)
           OR hash IN (SELECT tx_hash FROM decisions WHERE position_id = ? AND tx_hash IS NOT NULL)
           OR (json_extract(detail, '$.pool') = ? AND ts BETWEEN ? AND ? AND kind IN ('zap_swap', 'mint', 'increase')))
        ORDER BY ts`, chain.network, row.tx_open, row.tx_close, id, id, id, row.token_id, id, id, id, row.pool_ref, lo, hi);
      // The same pool can be entered by two consecutive positions (lp2 #6 and #7, 90 seconds
      // apart): the neighbour's mint and its zap get filtered in via the pool window. A mint/add
      // only belongs to this position if it is really linked to its number. Zap: a mint booked
      // since `zapped.hashes` names its zap hash exactly; an old mint without that record
      // uses an estimate — the zap belongs to the first mint/add that follows it in that pool.
      // A zap that no mint names and that is not followed by our mint (a cancelled entry)
      // is not this position's history.
      const decByTx = new Map(store.all(`
        SELECT d.tx_hash, d.verdict, d.reason, a.kind AS action_kind, a.value_quote, a.quote_symbol
        FROM decisions d JOIN actions a ON a.id = d.action_id
        WHERE d.position_id = ? AND d.tx_hash IS NOT NULL`, id).map((d) => [d.tx_hash, d]));
      const mine = (t) => {
        if (t.hash === row.tx_open || t.hash === row.tx_close || decByTx.has(t.hash)) return true;
        const d = parse(t.detail);
        return d.position === id || d.recorded === id || !!d.positionSales?.some((s) => s.position === id)
          || !!d.feeSales?.some((s) => s.position === id)
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
        // A sale of this position's leftover (gotQuote vs the close estimate) or of its claimed fee
        // memecoin (gotQuote vs the claim estimate): the proceeds replaced an estimate in its PnL.
        const sale = d.positionSales?.find((s) => s.position === id);
        const feeSale = d.feeSales?.find((s) => s.position === id);
        const ev = {
          hash: t.hash, ts: t.ts, kind: t.kind, status: t.status, error: t.error, gasUsd: gasUsd(t),
          swap: d.tokenIn ? { tokenIn: d.tokenIn, tokenOut: d.tokenOut, symbolIn: d.symbolIn, symbolOut: d.symbolOut, amountIn: d.amountIn, amountOut: d.amountOut } : null,
          saleDeltaUsd: sale ? (sale.gotQuote - sale.closeQuote) * k : feeSale ? (feeSale.gotQuote - feeSale.estQuote) * k : null,
          feeSaleUsd: feeSale ? feeSale.gotQuote * k : null,
          dex: d.dex || d.via || null, usdIn: d.usdIn ?? null, usdOut: d.usdOut ?? null,
          // The swap cost of this row: route loss (quote in → quote out) plus
          // the price shift at execution (quote out → what was actually received).
          slipUsd: sw.route + sw.exec || null,
          slipBps: d.slipBps ?? null,
          amount0: null, amount1: null, valueUsd: null, feesUsd: null,
          reason: dec?.reason || null, verdict: dec?.verdict || null,
          // The value of the copied target action — the context of "why this size".
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
        // partial withdrawal: its result is recorded separately, apart from the close
        if (t.kind === 'decrease' && d.decreaseProceeds) {
          ev.amount0 = d.decreaseProceeds.amount0; ev.amount1 = d.decreaseProceeds.amount1; ev.valueUsd = d.decreaseProceeds.quote * k;
        }
        if (t.hash === row.tx_close) {
          ev.amount0 = d.closeProceeds?.amount0 ?? row.out0; ev.amount1 = d.closeProceeds?.amount1 ?? row.out1; ev.valueUsd = d.closeProceeds?.quote != null ? d.closeProceeds.quote * k : null; ev.feesUsd = (row.fees_quote || 0) * k;
          if (ev.kind !== 'decrease') ev.kind = 'burn';
        }
        return ev;
      });
      // A position adopted from the wallet (not opened by the bot) has no tx in the table:
      // its open/close events are composed from the position row so its history is not empty.
      if (row.opened_ts && !events.some((e) => e.kind === 'mint' || (row.tx_open && e.hash === row.tx_open))) {
        events.unshift({ hash: row.tx_open, ts: row.opened_ts, kind: 'mint', status: row.tx_open ? 'sukses' : null, synthetic: true,
          amount0: row.cost0, amount1: row.cost1, valueUsd: (row.cost_quote || 0) * k, gasUsd: null });
      }
      if (row.status === 'closed' && row.closed_ts && !events.some((e) => e.kind === 'burn' || (row.tx_close && e.hash === row.tx_close))) {
        events.push({ hash: row.tx_close, ts: row.closed_ts, kind: 'burn', status: row.tx_close ? 'sukses' : null, synthetic: true,
          amount0: row.out0, amount1: row.out1, valueUsd: null, feesUsd: (row.fees_quote || 0) * k, gasUsd: null });
      }
      events.sort((a, b) => a.ts - b.ts);

      // Bot notes: decisions linked to this position (including ones without a tx,
      // e.g. simulation/skipped) + log lines that mention "#<id>" (not #<id>0 etc.).
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
      // Target side: the original position being copied and how THEY ended up there.
      // This drawer used to only tell about us; "we lost $41, how did the one
      // we copy do?" had to be answered on another page.
      const origin = originOf(row, { watch: true });
      // An open position: its PnL from the live sync (the same figure as the table),
      // along with its breakdown — LP value vs capital, IL vs simply holding the tokens, fee —
      // so the drawer can explain WHY minus/plus, not just the figure.
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
          takeover_ts: row.takeover_ts ?? null,
          origin, targetLabel: origin.targetLabel,
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
    // Pool stats (DexScreener) and price candles (GeckoTerminal) for the detail page.
    'GET /api/market': async (req, url) => {
      const pool = canon(url.searchParams.get('pool') || '');
      if (!isRef(pool)) return { error: 'pool tidak valid' };
      const tf = TF[url.searchParams.get('tf')] ? url.searchParams.get('tf') : '1h';
      const token = canon(url.searchParams.get('token') || '');
      const limit = Number(url.searchParams.get('limit') || 300);
      const before = Number(url.searchParams.get('before')) || null;
      // The token page uses the USD price; the position page uses the price in the pool's
      // quote asset so it is aligned with the tick range.
      const currency = url.searchParams.get('currency') === 'usd' ? 'usd' : 'token';
      // src=gmgn: candles from the GMGN OpenAPI (needs an API key + token address); if
      // GMGN fails (key empty/rejected/limit with no fallback), it falls back to GeckoTerminal
      // and the UI is told via ohlcv.fallback so it is not silent.
      const wantGmgn = url.searchParams.get('src') === 'gmgn' && isAddr(token);
      const gt = () => market.candles(pool, tf, { limit, token: isAddr(token) ? token : null, before, currency });
      const [pair, ohlcv] = await Promise.all([
        url.searchParams.get('pair') === '0' ? null : market.pair(pool),
        wantGmgn
          ? market.candlesGmgn(token, tf, { limit, before }).then(async (r) => (r?.error ? { ...(await gt()), fallback: r.error } : r))
          : gt(),
      ]);
      return { pair, ohlcv, tfs: Object.keys(TF), gmgn: market.gmgnEnabled() };
    },
    // Latest swap transactions in the pool (GeckoTerminal) — the "running trade" tape
    // below the chart. Known wallets are given names: the target copied, or the bot.
    'GET /api/trades': async (req, url) => {
      const pool = canon(url.searchParams.get('pool') || '');
      if (!isRef(pool)) return { error: 'pool tidak valid' };
      const token = canon(url.searchParams.get('token') || '');
      const r = await market.trades(pool, { token: isAddr(token) ? token : null, limit: Number(url.searchParams.get('limit') || 80) });
      if (!r?.trades) return r;
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null]));
      const me = canon(engine.exec.address() || '');
      return {
        ...r,
        trades: r.trades.map((x) => ({ ...x, target: labels.has(x.wallet), label: labels.get(x.wallet) || null, mine: !!me && x.wallet === me })),
      };
    },
    // Wallet names for the trade tape fetched by the browser directly from
    // GeckoTerminal: the target wallets copied and the bot's own wallet.
    'GET /api/trade-labels': () => ({
      me: canon(engine.exec.address() || '') || null,
      targets: Object.fromEntries(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null])),
    }),
    // ---- GMGN OpenAPI (needs an API key; without a key all answer { enabled: false }) ----
    // Token profile: info + contract security — the "Per GMGN" card and extra signals
    // in pool health.
    'GET /api/gmgn/token': async (req, url) => {
      const a = canon(url.searchParams.get('address') || '');
      if (!isAddr(a)) return { error: 'alamat token tidak valid' };
      return market.gmgnToken(a);
    },
    // Multi-token version for the indicator dots in the positions list: only the blocks
    // used by the rating (security/stat/dev), not the whole profile. Stored 5 minutes
    // — contract security does not change every minute, and a positions list with
    // ten tokens means twenty GMGN calls if not held back.
    'GET /api/gmgn/tokens': async (req, url) => {
      if (!market.gmgnEnabled()) return { enabled: false, tokens: {} };
      const list = [...new Set(String(url.searchParams.get('addresses') || '').split(',')
        .map((x) => canon(x)).filter((a) => isAddr(a)))].slice(0, 25);
      const rs = await Promise.all(list.map((a) => market.memo(`gmgn-lite:${a}`, 300_000, async () => {
        const g = await market.gmgnToken(a);
        if (!g || g.error || g.enabled === false) return { error: g?.error || 'tidak tersedia' };
        return { address: a, symbol: g.symbol || null, security: g.security || null, stat: g.stat || null,
          dev: g.dev ? { status: g.dev.status } : null, links: { gmgn: g.links?.gmgn || null }, fetchedAt: g.fetchedAt || Date.now() };
      }).catch(() => ({ error: 'tidak tersedia' }))));
      return { enabled: true, tokens: Object.fromEntries(list.map((a, i) => [a, rs[i]])), ts: Date.now() };
    },
    // Top holders / traders, with the wallet names the bot knows.
    'GET /api/gmgn/wallets': async (req, url) => {
      const a = canon(url.searchParams.get('address') || '');
      if (!isAddr(a)) return { error: 'alamat token tidak valid' };
      const kind = url.searchParams.get('kind') === 'traders' ? 'traders' : 'holders';
      const orderBy = ['amount_percentage', 'profit', 'unrealized_profit', 'buy_volume_cur', 'sell_volume_cur'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : null;
      const r = await market.gmgnWallets(a, { kind, limit: Number(url.searchParams.get('limit') || 50), orderBy });
      if (!r?.rows) return r;
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label || null]));
      const me = canon(engine.exec.address() || '');
      return { ...r, rows: r.rows.map((x) => ({ ...x, target: labels.has(x.address), label: labels.get(x.address) || null, mine: !!me && x.address === me })) };
    },
    // Trading statistics of one wallet (target / research wallet) per GMGN.
    'GET /api/gmgn/wallet': async (req, url) => {
      const a = canon(url.searchParams.get('address') || '');
      if (!isAddr(a)) return { error: 'alamat wallet tidak valid' };
      return market.gmgnWallet(a, { period: url.searchParams.get('period') || '7d' });
    },
    'GET /api/pool-depth': async (req, url) => {
      const ref = canon(url.searchParams.get('ref') || '');
      if (!isRef(ref)) return { error: 'pool tidak valid' };
      return market.memo(`depth:${ref}`, 30000, () => (SOL
        ? require('./solana/pool-depth').poolDepthSol({ rpc, chain, store, engine }, ref)
        : require('./pool-depth').poolDepth({ rpc, chain, store, engine }, ref)));
    },
    'GET /api/holders': async (req, url) => (SOL
      ? require('./solana/holders').solanaHolders({ rpc, chain }, canon(url.searchParams.get('token') || ''))
      : require('./holders').alchemyHolders(chain, market, cfg, url.searchParams.get('token'))),
    // Pool price straight from the chain (slot0) for the realtime chart. GeckoTerminal candles
    // lag by up to a minute; this price is what moves the last candle in the UI.
    // Stored 2.5 seconds per pool: many tabs opening the same pool share one
    // eth_call, and the RPC used by the bot is not drained.
    'GET /api/price': async (req, url) => {
      const ref = canon(url.searchParams.get('pool') || '');
      if (!isRef(ref)) return { error: 'pool tidak valid' };
      return market.memo(`slot0:${ref}`, 2500, async () => {
        const slot = ref.length === 66 ? (await chain.slot0V4Many([ref]))[0] : await chain.slot0V3(ref);
        if (slot?.sqrtPriceX96 == null || BigInt(slot.sqrtPriceX96) === 0n) return { error: 'harga pool tidak terbaca' };
        return { pool: ref, tick: slot.tick ?? null, sqrt: slot.sqrtPriceX96.toString(), ts: Date.now() };
      });
    },
    // Prices of many pools at once for the Monitor page: one eth_call batch for
    // all the pools being watched, not one /api/price per card every 3 seconds
    // (10 positions = 200 eth_calls/minute to the RPC that the bot also uses). Memoised per
    // set of pools; a pool that fails to read is answered null, not failing everything.
    'GET /api/prices': async (req, url) => {
      const pools = [...new Set(canon(url.searchParams.get('pools') || '').split(',').filter((p) => isRef(p)))].sort().slice(0, 40);
      if (!pools.length) return { prices: {}, ts: Date.now() };
      return market.memo(`slot0many:${pools.join(',')}`, 2500, async () => {
        // EVM: v4 poolId (66 chars) vs v3 pool address (42). Solana: everything through slot0V3
        // (SolanaChain maps it to that pool's venue adapter).
        const v4 = SOL ? [] : pools.filter((p) => p.length === 66), v3 = SOL ? pools : pools.filter((p) => p.length === 42);
        const [s4, s3] = await Promise.all([
          v4.length ? chain.slot0V4Many(v4).catch(() => v4.map(() => null)) : [],
          Promise.all(v3.map((p) => chain.slot0V3(p).catch(() => null))),
        ]);
        const ts = Date.now();
        const prices = {};
        v4.forEach((p, i) => { const s = s4[i]; prices[p] = s?.sqrtPriceX96 > 0n ? { tick: s.tick ?? null, sqrt: s.sqrtPriceX96.toString() } : null; });
        v3.forEach((p, i) => { const s = s3[i]; prices[p] = s?.sqrtPriceX96 > 0n ? { tick: s.tick ?? null, sqrt: s.sqrtPriceX96.toString() } : null; });
        return { prices, ts };
      });
    },
    // Material for the "automatic exit triggers" panel on the Monitor page: the exit rules that
    // REALLY apply to each open position (per-target rules override the
    // global ones — exactly the function the engine uses in exitTriggers) and the engine's
    // "since when out of range" recorder. Computed here, not re-guessed in the
    // browser, so the progress bars to the threshold use the same figures as what will
    // close the position.
    'GET /api/monitor': () => {
      const rows = engine.positions.live.map((p) => {
        const e = engine.rulesFrom(p.target).exit || {};
        const oorSince = p.inRange === false ? Number(store.getState(`oor:${p.id}`, 0)) || null : null;
        const far = p.inRange === false && p.curTick != null && p.tick_lower != null
          ? require('./v3math').distanceFromRangePct(p.curTick, p.tick_lower, p.tick_upper) : 0;
        return {
          id: p.id,
          exit: {
            stop_loss_pct: Math.abs(Number(e.stop_loss_pct) || 0), take_profit_pct: Number(e.take_profit_pct) || 0,
            max_age_hours: Number(e.max_age_hours) || 0, out_of_range_minutes: Number(e.out_of_range_minutes) || 0,
            out_of_range_pct: Number(e.out_of_range_pct) || 0, follow_target: !!e.follow_target,
          },
          oorSince, farPct: far, farStreak: engine.positions.farStreak?.get(p.id) || 0,
          // standalone rules are not evaluated from stale figures (see exitTriggers)
          stale: !!(p.valueStale || p.liqStale),
        };
      });
      // History of each pool being watched: all positions that EVER existed in that pool
      // and have closed — count, realized PnL, win/lose (the same break-even rule
      // as the Summary page). The Monitor card adds it to the open positions' PnL
      // as "since the start": a pool that looks profitable now may well
      // have lost three times before.
      const refs = [...new Set(engine.positions.live.map((p) => canon(p.pool_ref || '')).filter(Boolean))];
      const k = (q) => (chain.isEthLike(q) ? engine.ethUsd : 1);
      const pools = {};
      for (const ref of refs) {
        const cl = store.all("SELECT id, opened_ts, closed_ts, cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed' AND lower(pool_ref)=?", chain.network, ref)
          .map((p) => ({ ...p, pnl: ((p.out_quote || 0) - (p.cost_quote || 0)) * k(p.quote_symbol) }));
        const outcome = cl.map(netResult);
        pools[ref] = {
          closedCount: cl.length,
          realizedUsd: cl.reduce((a, p) => a + p.pnl, 0),
          costUsd: cl.reduce((a, p) => a + (p.cost_quote || 0) * k(p.quote_symbol), 0),
          wins: outcome.filter((x) => x > FLAT).length, losses: outcome.filter((x) => x < -FLAT).length,
          firstTs: cl.length ? Math.min(...cl.map((p) => p.opened_ts || p.closed_ts)) : null,
          lastClosedTs: cl.length ? Math.max(...cl.map((p) => p.closed_ts || 0)) : null,
        };
      }
      return { positions: Object.fromEntries(rows.map((r) => [r.id, r])), pools, syncedAt: engine.positions.lastSync, paused: engine.paused(), dryRun: engine.dryRun() };
    },
    // DexScreener statistics for all watched pools at once (Δ price chips,
    // volume, liquidity on the Monitor card). market.pair() is already memoised per pool,
    // so this just merges; a pool that fails is answered null.
    'GET /api/monitor/market': async (req, url) => {
      const pools = [...new Set(canon(url.searchParams.get('pools') || '').split(',').filter((p) => isRef(p)))].slice(0, 40);
      const rs = await Promise.all(pools.map((p) => market.pair(p).catch(() => null)));
      return { pairs: Object.fromEntries(pools.map((p, i) => [p, rs[i] && !rs[i].error ? rs[i] : null])), ts: Date.now() };
    },
    // Detail of one token: metadata, all its pools (DexScreener), the bot positions
    // that use it, researched wallet positions, and target moves in that token.
    'GET /api/token': async (req, url) => {
      const a = canon(url.searchParams.get('a') || '');
      if (!isAddr(a)) return { error: 'alamat token tidak valid' };
      const market$ = market.token(a).catch((e) => ({ error: e.message }));
      let meta = QUOTES[a] ? { address: a, symbol: QUOTES[a].symbol, name: a === chain.ADDR.native ? chain.nativeSymbol : null, decimals: QUOTES[a].decimals } : null;
      meta = store.get('SELECT address,symbol,name,decimals FROM tokens WHERE chain=? AND address=?', chain.network, a) || meta;
      const mk = await market$;
      // Never seen on chain: read the metadata only if DexScreener
      // knows it as a token — a wallet address must not enter the tokens table.
      if (!meta && mk?.pairs?.length) meta = await chain.tokens([a]).then((x) => x[0]).catch(() => null);
      if (!meta) {
        const hit = mk?.pairs?.[0];
        const side = hit?.base.address === a ? hit.base : hit?.quote.address === a ? hit.quote : null;
        if (!side) return { error: 'token tidak dikenal — belum pernah terlihat di chain maupun DexScreener' };
        meta = { address: a, symbol: side.symbol, name: side.name, decimals: null };
      }

      const rows = await lpRows('token0=? OR token1=?', [a, a]);
      // The bot wallet's balance for this token (if a wallet is installed).
      let balance = null;
      if (engine.exec.address() && meta.decimals != null) {
        try {
          const raw = (await engine.exec.balances([a])).get(a) || 0n;
          balance = { raw: raw.toString(), amount: Number(raw) / 10 ** meta.decimals };
        } catch { /* balance unreadable: hide that part */ }
      }

      return {
        token: { ...meta, isQuote: !!QUOTES[a] },
        market: mk, balance, ...rows, ethUsd: engine.ethUsd,
      };
    },
    // Detail of one pool (pair) — the equivalent of a DexScreener pair page: its tokens,
    // current price from the chain, bot positions in this pool with PnL, researched
    // wallet positions, and target moves. A pool never touched by the bot/research can still
    // be opened as long as DexScreener knows it.
    'GET /api/pool': async (req, url) => {
      const ref = canon(url.searchParams.get('ref') || '');
      if (!isRef(ref)) return { error: 'pool tidak valid' };
      const cols = 'pool_ref, venue, token0, token1, fee, tick_spacing, hooks';
      // A pools row may exist but not yet hold its token pair (e.g. written by the
      // pool age checker). The first row that HAS token0/token1 is used —
      // otherwise the page could only write "?/?" although other tables know.
      const cands = [
        store.get(`SELECT ${cols} FROM pools WHERE chain=? AND pool_ref=?`, chain.network, ref),
        store.get(`SELECT ${cols} FROM positions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref),
        store.get(`SELECT ${cols} FROM wpositions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref),
        store.get(`SELECT ${cols} FROM actions WHERE chain=? AND pool_ref=? LIMIT 1`, chain.network, ref),
      ].filter(Boolean);
      let pool = cands.find((p) => p.token0 && p.token1) || cands[0];
      // The remaining fields (fee/tick_spacing/hooks/venue) are patched from another row that has them.
      if (pool) for (const k of ['venue', 'fee', 'tick_spacing', 'hooks']) {
        if (pool[k] == null) pool[k] = cands.find((p) => p[k] != null)?.[k] ?? null;
      }
      if (!pool) {
        const pr = await market.pair(ref);
        if (!pr || pr.error) return { error: 'pool tidak dikenal — belum tersentuh bot/riset dan belum terindeks DexScreener' };
        // DexScreener uses base/quote order; Uniswap orders by address.
        const [t0, t1] = [pr.base.address, pr.quote.address].map((a) => canon(a || '')).sort();
        pool = { pool_ref: ref, venue: SOL ? (await chain.venueOfPool(ref).catch(() => null)) || 'solana' : ref.length === 42 ? 'v3' : 'v4', token0: t0, token1: t1, fee: null, tick_spacing: null, hooks: null };
      }
      // Addresses in canonical form: an old table may store them checksummed,
      // while QUOTES and the token cache are keyed lowercase (EVM).
      pool.token0 = pool.token0 ? canon(pool.token0) : null;
      pool.token1 = pool.token1 ? canon(pool.token1) : null;
      // chain.tokens() drops empty and duplicate addresses, so the result is matched
      // by address — not by order.
      const metas = await chain.tokens([pool.token0, pool.token1]).catch(() => []);
      const byAddr = new Map(metas.filter(Boolean).map((m) => [canon(m.address), m]));
      const m0 = byAddr.get(pool.token0) || QUOTES[pool.token0];
      const m1 = byAddr.get(pool.token1) || QUOTES[pool.token1];
      const quoteSide = quoteSideOf(pool.token0, pool.token1);
      // Current price: v4 = poolId (32 bytes) read from the PoolManager, v3 = pool address.
      let slot = null;
      try { slot = ref.length === 66 ? (await chain.slot0V4Many([ref]))[0] : await chain.slot0V3(ref); } catch { /* no current price */ }
      const rows = await lpRows('pool_ref=?', [ref]);
      // The range of a researched position still open is drawn against the current price. One that
      // already carries a tick from re-valuation is left alone — that is the tick used to
      // compute its value, so the bar and its figure tell about the same moment.
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
        // the result of our positions copied from this wallet (USD)
        const o = ours.get(r.address);
        r.ours = o ? { open: o.open, value: o.value, upnl: o.upnl, closed: o.closed, wins: o.wins, losses: o.losses, realized: o.realized, costUsd: o.costUsd, net: o.net, failedUsd: o.failedUsd ?? 0, failedAttempts: o.failedAttempts ?? 0 } : null;
        r.rulesResolved = rulesFor(cfg.rules, r.rules);
        r.rulesOwn = r.rules ? JSON.parse(r.rules) : null;
        const st = store.get('SELECT COUNT(*) n, MAX(ts) last FROM actions WHERE chain=? AND target=?', chain.network, r.address);
        r.actions = st?.n || 0; r.lastActionTs = st?.last || null;
        r.copied = store.get("SELECT COUNT(*) n FROM decisions d JOIN actions a ON a.id=d.action_id WHERE a.chain=? AND a.target=? AND d.verdict IN ('copy','dry')", chain.network, r.address)?.n || 0;
        const p = store.get("SELECT COUNT(*) n, COALESCE(SUM(cost_quote),0) cost FROM positions WHERE chain=? AND target=? AND status='open'", chain.network, r.address);
        r.openPositions = p?.n || 0; r.openCostQuote = p?.cost || 0;
        // Summary of the wallet research already stored (from the Wallet page) — without calling the chain.
        const w = store.get('SELECT stats, last_scan_ts, positions_n FROM wallets WHERE chain=? AND address=?', chain.network, r.address);
        if (w) { try { r.research = { ...JSON.parse(w.stats || '{}'), lastScanTs: w.last_scan_ts, positionsN: w.positions_n }; } catch { r.research = null; } }
        // THEIR own money: cash in the wallet + the value of LP positions still open
        // (including unclaimed fees). A wallet with only a few tens of
        // dollars left has practically stopped LPing — that is what the "Their balance" column reads.
        const lp = store.get("SELECT COUNT(*) n, COALESCE(SUM(live_value_q),0) v, COALESCE(SUM(live_fee_q),0) f FROM wpositions WHERE chain=? AND wallet=? AND status='open'", chain.network, r.address);
        const cash = cashOf(r.address);
        r.balance = {
          cashUsd: cash?.usd ?? null, cashTs: cash?.ts ?? null,
          // Never researched: its LP is unknown (not zero) — a wallet that has not been
          // scanned must not read as if its capital were gone.
          lpUsd: w ? (lp?.v || 0) + (lp?.f || 0) : null, lpOpenN: lp?.n || 0, lpTs: w?.last_scan_ts || null,
        };
      }
      // Cash is read from the chain in the background, one wallet per call; the row uses the
      // stored figure until its turn comes.
      sweepTargetCash(rows.map((r) => r.address));
      return { targets: rows, defaults: DEFAULTS, globalRules: rulesFor(cfg.rules) };
    },
    'POST /api/targets': async (req) => {
      const b = await readBody(req);
      const addr = canon(b.address || '');
      if (!isAddr(addr)) return { error: 'alamat tidak valid' };
      const v = validateRules(b.rules || null);
      if (v.error) return { error: v.error };
      store.run('INSERT OR IGNORE INTO targets(chain,address,label,enabled,added_ts,rules,notes) VALUES(?,?,?,?,?,?,?)',
        chain.network, addr, b.label || null, b.enabled === false ? 0 : 1, Date.now(), v.rules ? JSON.stringify(v.rules) : null, b.notes || null);
      return { ok: true };
    },
    'POST /api/targets/toggle': async (req) => {
      const b = await readBody(req);
      store.run('UPDATE targets SET enabled=? WHERE chain=? AND address=?', b.enabled ? 1 : 0, chain.network, canon(b.address));
      return { ok: true };
    },
    'POST /api/targets/rules': async (req) => {
      const b = await readBody(req);
      const v = validateRules(b.rules || null);
      if (v.error) return { error: v.error };
      store.run('UPDATE targets SET rules=?, label=COALESCE(?,label) WHERE chain=? AND address=?',
        v.rules ? JSON.stringify(v.rules) : null, b.label ?? null, chain.network, canon(b.address));
      return { ok: true };
    },
    'POST /api/targets/label': async (req) => {
      const b = await readBody(req);
      const addr = canon(b.address || '');
      const label = String(b.label ?? '').trim().slice(0, 60) || null;
      const r = store.run('UPDATE targets SET label=? WHERE chain=? AND address=?', label, chain.network, addr);
      if (!r.changes) return { error: 'target tidak ditemukan' };
      return { ok: true, label };
    },
    'POST /api/targets/delete': async (req) => {
      const b = await readBody(req);
      store.run('DELETE FROM targets WHERE chain=? AND address=?', chain.network, canon(b.address));
      return { ok: true };
    },
    // Drawings & indicators of the advanced chart (trend line, fibonacci, etc.) per pool —
    // stored on the server so they are still there when the page is opened again, not just in
    // the localStorage of the browser that one person used.
    'GET /api/chart/overlays': (req, url) => {
      const ref = canon(url.searchParams.get('pool') || '');
      if (!ref) return { error: 'pool tidak valid' };
      const raw = store.getState(`chart_overlays:${ref}`);
      return { data: raw ? JSON.parse(raw) : null };
    },
    'POST /api/chart/overlays': async (req) => {
      const b = await readBody(req);
      const ref = canon(b.pool || '');
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
      const toks = tokenMeta();
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      const mirrors = manual.openMirrorKeys();
      for (const r of rows) {
        r.targetLabel = labels.get(r.target) || null;
        r.symbol0 = toks.get(r.token0)?.symbol || null;
        r.symbol1 = toks.get(r.token1)?.symbol || null;
        r.dec0 = toks.get(r.token0)?.decimals ?? 18;
        r.dec1 = toks.get(r.token1)?.decimals ?? 18;
        r.quoteSide = quoteSideOf(r.token0, r.token1);
        // Open/add position that failed or was skipped and has no mirror yet: the
        // "Follow" button (the target position's status on chain is only checked at preview).
        r.followable = Manual.followable(r, mirrors);
      }
      return { activity: rows };
    },
    // Manually follow a failed/skipped target action. `plan` = preview (no transaction)
    // for the confirmation modal; a POST without /plan sends the transaction. Its exit is still
    // automatic — see Manual.follow.
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
    // Feed for dashboard alerts (toast + sound): "target opens a position"
    // and "copy position closed" (with its PnL). Polled every few seconds,
    // so deliberately light: the first call (without `after`) only returns the
    // starting point — the last action id and the last close time — so opening the
    // dashboard does not replay all history. Old actions that were only recorded —
    // backfill after the engine was down — are filtered by their age, not their id.
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
      const toks = tokenMeta();
      const labels = new Map(store.all('SELECT address,label FROM targets WHERE chain=?', chain.network).map((t) => [t.address, t.label]));
      const items = rows.map((r) => ({
        kind: 'open', id: r.id, ts: r.ts, target: r.target, targetLabel: labels.get(r.target) || null,
        venue: r.venue, fee: r.fee, adding: !!r.adding,
        token0: r.token0, token1: r.token1, symbol0: toks.get(r.token0)?.symbol || null, symbol1: toks.get(r.token1)?.symbol || null,
        valueUsd: r.value_quote == null ? null
          : r.value_quote * (chain.isEthLike(r.quote_symbol) ? engine.ethUsd : 1),
        verdict: r.verdict || null, reason: r.reason || null, positionId: r.position_id || null,
      }));
      // Copy positions fully closed since `closedAfter` (close time, ms) —
      // the target's follow-out exit, a standalone exit, or closed manually. Its PnL is already
      // final in the position row (proceeds − capital, including claimed fees).
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
            token0: r.token0, token1: r.token1, symbol0: toks.get(r.token0)?.symbol || null, symbol1: toks.get(r.token1)?.symbol || null,
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
        // Switching LIVE on through this door must be as strict as the Settings page
        // (/api/settings/live): needs a wallet and a written confirmation. Going back to simulation is free.
        if (b.dry_run === false && !engine.exec.address()) return { error: 'Pasang wallet dulu sebelum menyalakan LIVE.' };
        if (b.dry_run === false && String(b.confirm || '') !== 'LIVE') return { error: 'Ketik LIVE untuk konfirmasi.' };
        cfg.mode = cfg.mode || {}; cfg.mode.dry_run = b.dry_run; saveCfg();
        engine.paper?.settle?.();   // LIVE on: simulated positions are set aside, not mixed with real ones
      }
      if (typeof b.paused === 'boolean') { if (engine.setPaused) engine.setPaused(b.paused); else store.setState('paused', b.paused ? '1' : '0'); }
      return { ok: true, mode: { dry_run: engine.dryRun(), paused: engine.paused() } };
    },
    'GET /api/logs': () => ({ logs: store.all('SELECT * FROM logs ORDER BY ts DESC LIMIT 200') }),
    'GET /api/txs': () => ({ txs: store.all('SELECT * FROM txs WHERE chain=? ORDER BY ts DESC LIMIT 100', chain.network) }),
    'POST /api/scout': async (req) => {
      const b = await readBody(req);
      const addr = canon(b.address || '');
      if (!isAddr(addr)) return { error: 'alamat tidak valid' };
      if (scoutJobs.get(addr)?.status === 'jalan') return { ok: true, status: 'jalan' };
      const job = { status: 'jalan', progress: 0, startedAt: Date.now(), result: null, error: null };
      scoutJobs.set(addr, job);
      const blocks = Number(b.blocks || cfg.scout?.blocks || 900_000);
      const onProgress = (p) => { job.progress = Math.round((p.scanned / p.total) * 100); };
      (SOL
        ? require('./solana/scout').scoutWalletSol(rpc, chain, addr, { ethUsd: engine.ethUsd, store, onProgress })
        : scoutWallet(rpc, chain, addr, { blocks, ethUsd: engine.ethUsd, onProgress })
      ).then((r) => { job.result = r; job.status = 'selesai'; })
        .catch((e) => { job.error = e.message; job.status = 'gagal'; });
      return { ok: true, status: 'jalan' };
    },
    'GET /api/scout': (req, url) => {
      const addr = canon(url.searchParams.get('address') || '');
      const j = scoutJobs.get(addr);
      if (!j) return { status: 'kosong' };
      return { status: j.status, progress: j.progress, error: j.error, result: j.result };
    },
    // ---- wallet research ----
    'POST /api/wallet/scan': async (req) => {
      const b = await readBody(req);
      const addr = canon(b.address || '');
      if (!isAddr(addr)) return { error: 'alamat tidak valid' };
      const mode = b.mode === 'refresh' ? 'refresh' : 'full';
      // force: also rebuild closed positions already stored (after a formula fix)
      const job = startWalletJob(addr, { mode, blocks: Number(b.blocks || 900_000), reason: 'manual', force: b.force === true });
      return { ok: true, status: job.status };
    },

    'GET /api/wallet': async (req, url) => {
      const addr = canon(url.searchParams.get('address') || '');
      if (!isAddr(addr)) return { error: 'alamat tidak valid' };
      const w = store.get('SELECT * FROM wallets WHERE chain=? AND address=?', chain.network, addr);
      // Scanned before but stale -> update in the background; the page still immediately
      // shows stored data and sees the progress via `job`.
      if (w) maybeRefresh(addr, w, 'basi');
      const job = walletJobs.get(addr);
      const jobOut = job ? {
        status: job.status, mode: job.mode, reason: job.reason, phase: job.phase, progress: job.progress,
        done: job.done, total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error,
      } : null;
      if (!w) return { found: false, job: jobOut };

      const rows = store.all('SELECT * FROM wpositions WHERE chain=? AND wallet=? ORDER BY COALESCE(closed_ts, opened_ts) DESC', chain.network, addr);
      // Pool price when the position opened and when it closed — already stored per event at
      // scan time (read from an archive node), so no need to call the chain again.
      const ev = store.all('SELECT token_id, block, sqrt_price FROM wevents WHERE chain=? AND wallet=? ORDER BY token_id, block', chain.network, addr);
      const firstLast = new Map();
      for (const e of ev) {
        if (!e.sqrt_price) continue;
        const cur = firstLast.get(e.token_id);
        if (!cur) firstLast.set(e.token_id, { entry: e.sqrt_price, exit: e.sqrt_price });
        else cur.exit = e.sqrt_price;
      }
      const toks = tokenMeta();
      // Tokens from closing a position that are still held are re-valued at the pool price
      // NOW every time the page is opened — the figure is live until the token is sold.
      for (const r of rows) { r.dec0 = toks.get(r.token0)?.decimals ?? 18; r.dec1 = toks.get(r.token1)?.decimals ?? 18; }
      try { await research.proceeds.refreshHeld(rows, engine.ethUsd); } catch { /* pakai nilai tersimpan */ }
      // Positions still running are valued at the pool price NOW. This page triggers a
      // rescan only if the research is 5 minutes stale, and that scan runs
      // in the background — without re-valuation here, the value & fee shown can be far
      // older than the page itself.
      try { await research.refreshOpen(rows, engine.ethUsd); } catch { /* pakai nilai tersimpan */ }
      const hours = (a, b) => (a && b ? (b - a) / 3600000 : null);
      const deco = (r) => ({
        ...r,
        symbol0: toks.get(r.token0)?.symbol || '?',
        symbol1: toks.get(r.token1)?.symbol || '?',
        // The view needs decimals to turn a tick into the real price.
        dec0: toks.get(r.token0)?.decimals ?? 18,
        dec1: toks.get(r.token1)?.decimals ?? 18,
        quoteSide: quoteSideOf(r.token0, r.token1),
        entrySqrt: firstLast.get(r.token_id)?.entry || null,
        exitSqrt: r.status === 'closed' ? (firstLast.get(r.token_id)?.exit || null) : null,
        ageHours: hours(r.opened_ts, r.closed_ts || Date.now()),
        // DPR = daily profit as a percent of capital, the way LP Agent compares positions
        // of very different ages.
        dprPct: (r.invested_q > 0 && hours(r.opened_ts, r.closed_ts || Date.now()) > 0)
          ? (r.pnl_q / r.invested_q) * (24 / hours(r.opened_ts, r.closed_ts || Date.now())) * 100 : null,
        pnlPct: r.invested_q > 0 ? (r.pnl_q / r.invested_q) * 100 : null,
        // Closed position: the part of PnL that has become money vs tokens still held.
        realizedPnl: r.status === 'closed' && r.realized_q != null && r.invested_q != null ? r.realized_q - r.invested_q : null,
        heldUnrealized: r.status === 'closed' && r.held_tok && r.held_tok !== '0' ? (r.unrealized_q || 0) : 0,
        heldTok: r.status === 'closed' && r.held_tok && r.held_tok !== '0'
          ? Number(BigInt(r.held_tok)) / 10 ** (quoteSideOf(r.token0, r.token1) === 0 ? (toks.get(r.token1)?.decimals ?? 18) : (toks.get(r.token0)?.decimals ?? 18)) : 0,
        // Open position: the relevant fee is the one NOT yet claimed; closed position:
        // the fee that was really withdrawn.
        feeShown: r.status === 'open' ? (r.live_fee_q || 0) : (r.fees_q || 0),
        feePct: r.invested_q > 0
          ? ((r.status === 'open' ? (r.live_fee_q || 0) : (r.fees_q || 0)) / r.invested_q) * 100 : null,
      });
      const open = rows.filter((r) => r.status === 'open').map(deco);
      const closed = rows.filter((r) => r.status === 'closed').map(deco);

      // Current price tick for positions still running — one batch, only
      // for unique pools, so the view can show the price position in the range.
      // a v4 pool_ref is a poolId (32 bytes, read from PoolManager storage); a v3 pool_ref
      // is the pool contract ADDRESS. It used to all be thrown into the v4 path, which
      // for v3 produced a nonsense tick — the "current price" marker ended up in the wrong place.
      // A row already re-valued carries its own tick; what is read here
      // is only the rest (pools that failed to read, or positions whose valuation was skipped).
      const byPool = new Map();
      const need = open.filter((r) => r.curTick == null && r.pool_ref);
      const idV4 = [...new Set(need.filter((r) => r.venue !== 'v3').map((r) => r.pool_ref))];
      if (idV4.length) {
        try {
          const slots = await chain.slot0V4Many(idV4);
          idV4.forEach((id, i) => byPool.set(id, slots[i]));
        } catch { /* current price unreadable: the bar still renders without the marker */ }
      }
      for (const a of [...new Set(need.filter((r) => r.venue === 'v3').map((r) => r.pool_ref))]) {
        try { byPool.set(a, await chain.slot0V3(a)); } catch { /* sama */ }
      }
      for (const r of need) r.curTick = byPool.get(r.pool_ref)?.tick ?? null;

      // daily profit for the calendar
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

    // On-chain events of one wallet position + what WE did about it (copyOf):
    // the research drawer is opened precisely to assess one target position, and the first
    // question after seeing the result is always "do we follow or not, why".
    'GET /api/wallet/events': (req, url) => {
      const addr = canon(url.searchParams.get('address') || '');
      const id = String(url.searchParams.get('token_id') || '');
      const venue = String(url.searchParams.get('venue') || '') || null;
      return {
        events: store.all('SELECT * FROM wevents WHERE chain=? AND wallet=? AND token_id=? ORDER BY block', chain.network, addr, id),
        copy: copyOf(addr, id, venue),
      };
    },

    // Wallet contents (portfolio) — the tokens held + their USD value. For any
    // wallet, not just the bot's; used by the target detail page.
    'GET /api/wallet/holdings': async (req, url) => {
      const addr = canon(url.searchParams.get('address') || '');
      if (!isAddr(addr)) return { error: 'alamat tidak valid' };
      return holdingsOf(addr, { refresh: url.searchParams.get('refresh') === '1' });
    },

    // Global search (Cmd/Ctrl+K on the dashboard): one box, jump to a target, token,
    // pool, or researched wallet — all already in the local DB, so there is
    // no need to call the chain/DexScreener just to jump pages.
    'GET /api/search': async (req, url) => {
      // SQLite LIKE is case-insensitive (ASCII): lower case matches labels/symbols,
      // and still matches base58 Solana addresses.
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
    // A wallet that is also stored as a target is lent its target's name if
    // the wallet itself has not been given a label — so the research list does not show
    // a bare address for a wallet we already know.
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

    // ---- manual LP & manual swap ----
    // The plan is NEVER sent back and then executed as it is: /open rebuilds
    // the plan from the same input, at the current price, so all
    // checks (limits, hook, cash) run again right before the transaction is built.
    'GET /api/manual/pools': async (req, url) => ({
      pools: await manual.pools({
        q: url.searchParams.get('q') || '',
        limit: Math.min(100, Number(url.searchParams.get('limit') || 40)),
        withPrice: url.searchParams.get('price') === '1',
      }),
    }),
    // Scan pools from a token address. Made a background job like scout: a single
    // full-range scan takes a dozen seconds, too long for one HTTP reply.
    'POST /api/manual/pools/scan': async (req) => {
      const b = await readBody(req);
      const token = canon(b.token || '');
      if (!isAddr(token)) return { error: `alamat token tidak valid — ${addrHint(chain.network)}` };
      if (poolScanJobs.get(token)?.status === 'jalan') return { ok: true, status: 'jalan' };
      const job = { status: 'jalan', progress: 0, startedAt: Date.now(), pools: null, error: null };
      poolScanJobs.set(token, job);
      manual.scanPools(token, {
        onProgress: (p) => { job.progress = p.total ? Math.round((p.done / p.total) * 100) : 0; },
      }).then(async (pools) => {
        if (!pools.some(enterable)) job.others = await manual.otherMarket(token);
        job.pools = pools; job.status = 'selesai'; job.finishedAt = Date.now();
      })
        .catch((e) => { job.error = e.message; job.status = 'gagal'; job.finishedAt = Date.now(); });
      return { ok: true, status: 'jalan' };
    },
    'GET /api/manual/pools/scan': (req, url) => {
      const token = canon(url.searchParams.get('token') || '');
      const j = poolScanJobs.get(token);
      if (!j) return { status: 'kosong' };
      const out = { status: j.status, progress: j.progress, error: j.error };
      if (!j.pools) return out;
      // The raw result can be hundreds of pools and almost all are junk: created then
      // abandoned without liquidity, or paired with a token that is not money.
      // Only those that can really be entered are shown; the rest are just counted.
      const can = j.pools.filter(enterable);
      const every = url.searchParams.get('all') === '1';
      const list = every ? j.pools : (can.length ? can : j.pools.filter((p) => p.quoteSide != null));
      return { ...out, pools: list, total: j.pools.length, hidden: j.pools.length - list.length, others: j.others || null };
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
        full: !!b.full, strategy: b.strategy || null,
      });
    },
    // Layered entry: one budget over several adjacent ranges below the price (see manual.ladderLayers).
    'POST /api/manual/ladder/plan': async (req) => {
      const b = await readBody(req);
      return manual.planLadder(ladderBody(b));
    },
    // Opening takes one transaction per layer, longer than a proxy waits for a reply, so it
    // runs as a job: this returns a job id and the dashboard polls GET /api/manual/ladder/job.
    'POST /api/manual/ladder/open': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const lockKey = canon(b.poolRef || '');
      if (manualOpening.has(lockKey)) return { error: 'pembukaan LP di pool ini masih diproses — tunggu hasilnya' };
      const args = ladderBody(b);
      const spec = ladderLayers(args);
      if (spec.error) return spec;
      manualOpening.add(lockKey);
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const job = { status: 'running', done: 0, total: spec.layers.length, opened: [], error: null };
      ladderJobs.set(id, job);
      // keep the last few jobs only
      for (const k of [...ladderJobs.keys()].slice(0, Math.max(0, ladderJobs.size - 20))) ladderJobs.delete(k);
      manual.openLadder(args, (p) => { job.done = p.done; })
        .then((r) => { job.opened = r.opened; job.error = r.error || null; job.status = r.error ? 'error' : 'done'; })
        .catch((e) => { log(`LP berlayer: ${e.message}`); job.error = e.message; job.status = 'error'; })
        .finally(() => manualOpening.delete(lockKey));
      return { job: id, total: job.total };
    },
    'GET /api/manual/ladder/job': async (req, url) => {
      const j = ladderJobs.get(url.searchParams.get('id') || '');
      return j ? { ...j } : { error: 'job tidak ditemukan' };
    },
    'POST /api/manual/lp/open': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      // A double click (the dashboard slow to respond, a Telegram button pressed twice) used to open
      // TWO positions — the second plan was built before the first position was recorded.
      const lockKey = canon(b.poolRef || '');
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
          full: !!b.full, strategy: b.strategy || null,
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
    // ?usd=1: include the USD price & value of each token with a balance (the dashboard). The Telegram bot
    // calls without it so it does not wait for DexScreener.
    'GET /api/manual/tokens': async (req, url) => {
      // A single balanceOf failing (RPC 429) fails the whole list — one
      // retry after a pause before giving up.
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
    // USD prices for a list of addresses, WITHOUT re-reading balances. The dashboard used to call
    // /tokens?usd=1 which re-reads all balances; if a single eth_call hit 429,
    // all prices vanished and every row showed "—".
    'POST /api/manual/prices': async (req) => {
      const b = await readBody(req);
      const list = [...new Set((Array.isArray(b.addresses) ? b.addresses : [])
        .map((x) => canon(x || '')).filter((x) => isAddr(x)))].slice(0, 100);
      const prices = {};
      await Promise.all(list.map(async (a) => { prices[a] = await usdPrice(a).catch(() => null); }));
      return { prices };
    },
    // A token pasted by address on the Swap page. It is first checked that it
    // really is an ERC-20 token — a wallet/other contract address is rejected.
    'POST /api/manual/tokens/add': async (req) => {
      const b = await readBody(req);
      const a = canon(b.address || '');
      if (!isAddr(a)) return { error: `alamat tidak valid — ${addrHint(chain.network)}` };
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
    // History of the latest manual swaps, for the panel beside the swap card.
    // All txs that exchange assets (manual, LP-opening zap, leftover sale, selling back a zap that
    // did not become an LP, fee sale, bridge, gas top-up, WETH) + fee claims & compounds. See swaplog.js.
    'GET /api/manual/swaps': (req, url) => ({
      swaps: swapHistory({ store, chain, ethUsd: engine.ethUsd,
        limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40)),
        ...(url.searchParams.get('kinds') ? { kinds: url.searchParams.get('kinds').split(',') } : {}) }),
    }),
    // Balance for the "Amount" step — shows before the first preview finishes computing.
    'GET /api/manual/saldo': async (req, url) => {
      try { return await manual.saldo(String(url.searchParams.get('poolRef') || '') || null); }
      catch (e) { return { error: e.message }; }
    },

    // An address pasted by the user: a token (to be given an LP) or a wallet (to be
    // researched / made a target)? See probeToken.
    'GET /api/address': async (req, url) => {
      const a = canon(url.searchParams.get('a') || '');
      if (!isAddr(a)) return { error: `alamat tidak valid — ${addrHint(chain.network)}` };
      const tgt = store.get('SELECT label FROM targets WHERE chain=? AND address=?', chain.network, a);
      const study = store.get('SELECT address FROM wallets WHERE chain=? AND address=?', chain.network, a);
      const base = { address: a, isTarget: !!tgt, targetLabel: tgt?.label || null, researched: !!study };
      return { ...base, ...(await probeToken(a)) };
    },
    'POST /api/manual/swap/quote': async (req) => {
      const b = await readBody(req);
      try {
        // Above the balance: still quoted, flagged `insufficient` (the page disables the
        // button). POST /api/manual/swap keeps rejecting it via amountRaw.
        const { raw, maxVal, dec, symbol } = await manual.amountInfo(b.tokenIn, b.amount);
        if (raw <= 0n) return { error: 'jumlah nol — saldonya kosong?' };
        const q = await manual.quoteSwap({ tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountRaw: raw.toString(), aggregator: b.aggregator || 'auto' });
        const insufficient = raw > maxVal ? { balance: Number(maxVal) / 10 ** dec, symbol } : null;
        return { ...q, amountRaw: raw.toString(), insufficient };
      } catch (e) { return { error: e.message }; }
    },
    'POST /api/manual/swap': async (req) => {
      const b = await readBody(req);
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        const raw = await manual.amountRaw(b.tokenIn, b.amount);
        if (raw <= 0n) return { error: 'jumlah nol — saldonya kosong?' };
        const r = await manual.doSwap({ tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountRaw: raw, aggregator: b.aggregator || 'auto' });
        return { ok: true, tx: r.txHash, note: r.note, dex: r.dex };
      } catch (e) {
        log(`swap manual: ${e.message}`);
        return { error: e.message };
      }
    },

    // ---- leftover memecoins not yet sold after leaving a position ----
    // Share card. The data is assembled from the same routes the dashboard
    // uses, then drawn on the server (src/share-card.js) so the dashboard and the
    // Telegram bot send exactly the same image.
    //   kind=position&id=…  | kind=total | kind=daily&day=YYYY-MM-DD
    //   hide=1 hides the dollar amounts; lang=id|en; tz=the reader's IANA time zone
    //   (the calendar day is computed in that zone, the same as in the browser).
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
    // Without a body: the whole queue. With {posId, token}: one item only — the
    // "sell now" button in the alert banner fires its own row, not all of them.
    'POST /api/leftovers/retry': async (req) => {
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      const b = await readBody(req).catch(() => ({}));
      const sel = leftoverKey(b);
      const list = sel.token ? engine.leftovers().filter((x) => sameLeftover(x, sel)) : engine.leftovers();
      if (!list.length) return { ok: true, tried: 0 };
      // The wait schedule is skipped: this is a manual request, not an automatic attempt.
      const choose = new Set(list.map((x) => `${x.posId ?? ''}:${x.token}`));
      engine.saveLeftovers(engine.leftovers().map((x) => (choose.has(`${x.posId ?? ''}:${x.token}`) ? { ...x, next: 0 } : x)));
      const errs = [];
      for (const item of list) {
        try { await engine.sellToken(item); } catch (e) { errs.push(e.message); }
      }
      return { ok: true, tried: list.length, error: errs.length ? errs.join(' · ') : null };
    },
    // Put leftovers that have already sat in the wallet into the same queue.
    // Sends no transaction — only quotes and queues.
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
      // `sell`: sell the fee's memecoin side to the pool's quote asset after the claim. If not
      // sent = follow the position's harvest setting (default: sell nothing).
      try { return await engine.claimFees(id, { sell: b.sell == null ? null : !!b.sell }); }
      catch (e) { return { error: e.message }; }
    },
    // Manual control of a mirror position (see Manual.takeover). GET …/handback checks the
    // target position on chain for the "hand back" confirmation modal.
    'POST /api/positions/takeover': async (req) => {
      const b = await readBody(req);
      try { return await manual.takeover(b.id); } catch (e) { return { error: e.message }; }
    },
    'GET /api/positions/handback': async (req, url) => manual.handBackInfo(url.searchParams.get('id')),
    'POST /api/positions/handback': async (req) => {
      const b = await readBody(req);
      try { return await manual.handBack(b.id); } catch (e) { return { error: e.message }; }
    },
    // force: force close — the waiting compound/claim guards are skipped and the liquidity
    // is re-read from the chain (see engine.executeExit). A position already empty on
    // chain is booked via closeEmptyPosition, not sent a burn that is certain to revert.
    'POST /api/positions/close': async (req) => {
      const b = await readBody(req);
      const force = b.force === true;
      const pos = store.get("SELECT * FROM positions WHERE chain=? AND id=? AND status='open'", chain.network, Number(b.id));
      if (!pos) return { error: 'posisi tidak ditemukan' };
      // A virtual position (simulation with a balance) is closed in the books at the current price.
      if (engine.paper?.on?.() && require('./paper').isSim(pos)) {
        try {
          const r = await engine.paper.close(pos, { full: true, liquidity: pos.liquidity });
          store.log('info', `tutup manual: ${r.note}`);
          return { ok: true, tx: null, outUsd: r.outUsd, pnlUsd: r.outUsd - r.costUsd, sold: null };
        } catch (e) { return { error: e.message }; }
      }
      if (engine.dryRun() || !engine.exec.address()) return { error: 'mode simulasi: tidak mengirim transaksi' };
      try {
        let r;
        if (force && await engine.chainLiquidity(pos) === 0n) {
          r = await engine.closeEmptyPosition(pos);
          if (!r) {
            const still = store.get("SELECT status FROM positions WHERE chain=? AND id=?", chain.network, pos.id)?.status === 'open';
            if (still) return { error: 'likuiditas sudah nol di chain tetapi hasilnya belum bisa dibukukan — dicoba lagi otomatis' };
            r = { txHash: null, note: `posisi #${pos.id} kosong di chain, dibukukan tertutup` };
          }
        } else {
          r = await engine.executeExit({ venue: pos.venue, action: 'burn', full: true, liquidity: pos.liquidity, tokenId: pos.token_id }, pos, { force });
        }
        store.log('info', `tutup ${force ? 'paksa' : 'manual'}: ${r.note}`);
        // The result is read from the row just closed, with the same conversion as
        // GET /api/position, so the figures in the notification match the detail page.
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

  Object.assign(routes, createSettingsRoutes({ engine, engines, store, cfg, cfgPath, rpc, chain, log, readBody, telegram, sessionCookie, market, fx }));
  routes['GET /api/chains'] = async () => ({ chains: await chainList(), current: chain.network });
  // Chain picker: the lpcopy_chain cookie is read by the front door (index.js) to choose
  // which chain's server answers the next requests. This cookie is not a secret.
  routes['POST /api/chain/select'] = async (req, url, res) => {
    const b = await readBody(req);
    const want = String(b.chain || '').toLowerCase();
    const ok = nets ? !!nets[want] : want === chain.network;
    if (!ok) return { error: 'chain tidak dikenal atau tidak aktif' };
    res.__setCookie = `lpcopy_chain=${want}; Path=/; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;
    return { ok: true, chain: want };
  };


  // The same door for callers inside the process (the Telegram bot). Deliberately through the
  // route table exactly as the browser uses: whatever the dashboard can do can be
  // done by the bot, and its validation/guards are only written once. The token gate
  // is bypassed because the caller is already inside the process — Telegram has
  // its own gate (the list of allowed chats).
  const callApi = async (method, pathname, body = {}, query = {}) => {
    const key = `${method} ${pathname}`;
    if (!routes[key]) throw new Error(`rute ${key} tidak ada`);
    const url = new URL(`http://x${pathname}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    return routes[key]({ __body: body, headers: {} }, url, {});
  };

  // Assemble the data of one share card then draw it. Used by the PNG route, the Telegram
  // send route, and the "Share" button in the bot. Returns { png, caption } or { error }.
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
      // Pair logo: the quote asset from the dashboard files, the rest from the GeckoTerminal cache.
      const local = chain.network === 'robinhood' ? { [chain.ADDR.usdg]: 'usdg.png', [chain.ADDR.weth]: 'weth.png' } : {};
      const iconOf = (a) => {
        const k = canon(a || '');
        // On the VPS only web/dist exists (Vite copies public/tokens there); during
        // development without a build, web/public.
        if (local[k]) {
          for (const dir of ['dist', 'public']) {
            try { return { buf: fs.readFileSync(path.join(__dirname, '..', 'web', dir, 'tokens', local[k])), ctype: 'image/png' }; } catch { /* coba berikutnya */ }
          }
          return null;
        }
        return icons.read(k);
      };
      opts.icons = { token0: iconOf(data.token0), token1: iconOf(data.token1) };
      // Price chart behind the figure: candles the age of the position (+ a little context before
      // entry), LP range, and entry/exit points. The same source as the chart card.
      // Failed or slow (GeckoTerminal) → the card is still produced, without the chart.
      opts.chart = await positionSpark(data).catch(() => null);
    } else if (kind === 'total' || kind === 'daily') {
      const [pf, pos] = await Promise.all([callApi('GET', '/api/portfolio', {}, { range: 'all' }), callApi('GET', '/api/positions')]);
      const all = [...(pos.positions || []), ...(pos.closed || [])];
      if (kind === 'total') {
        if (!pf.now) return { error: 'portofolio belum terbaca' };
        data = { now: pf.now, stats: pf.stats, since: all.reduce((a, x) => (x.opened_ts && (!a || x.opened_ts < a) ? x.opened_ts : a), null) };
        // Net PnL curve over the whole history (the same view as the portfolio chart).
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
        // PnL bars for each day of that month; the day shared is highlighted.
        const [y, m] = day.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
        opts.chart = { kind: 'bars', bars: Array.from({ length: dim }, (_, i) => { const k = `${day.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`; return { v: daily[k] || 0, on: k === day }; }) };
      }
    } else return { error: `jenis kartu tidak dikenal: ${kind}` };
    return { png: shareCard.render(kind, data, opts), caption: shareCard.caption(kind, data, lang) };
  };
  // Candles for the position card's background chart. The window covers the position's age (minimum
  // 10 minutes) + 30% context before entry, within ≤ 120 candles; a closed position is only
  // given a few candles after exit — not 6 hours like the chart card, so the
  // entry/exit markers are not squeezed to the left edge.
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
      limit, currency: 'token', token: isAddr(String(p.baseToken || '')) ? p.baseToken : null,
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

  // One position's chart as an image: candles + indicators + range band + BEP line.
  // Used by the "Chart" button in the Telegram bot (and the PNG route below) — its contents are deliberately
  // the same as what the dashboard draws, including the BEP formula (src/breakeven.mjs).
  // `span` = window width in hours (0 = automatic: the position's age + context before
  // entry). The candle count is limited to 60–400: below that there is no context, above that
  // one candle shrinks to a pixel in a 1200-wide image.
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
    // A closed position is viewed around its lifetime, not up to today.
    // `patient`: this image was requested via a button, not polled — better to wait a
    // bit longer than reply with an error when the second attempt would certainly have passed.
    const oh = await market.candles(p.pool_ref, frame, {
      limit, currency: 'token', token: isAddr(String(p.baseToken || '')) ? p.baseToken : null,
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
    // BEP is computed for any open position (not only one out of range):
    // in the image, its line is useful precisely BEFORE the price leaves the range.
    const bep = closed ? null : breakEven(p, { all: true });
    const data = {
      positionId: p.id, tokenId: p.token_id, venue: String(p.venue || '').toUpperCase(), fee: p.fee,
      pair: `${p.symbol0 || '?'}/${p.symbol1 || '?'}`,
      quoteSymbol: p.quoteSide === 0 ? p.symbol0 : p.symbol1,
      tf: frame, secs: oh.secs, candles, mask: Number(mask) || 0, span: Number(span) || 0,
      lo, hi, now, entry: sqrtPriceOf(p.entrySqrt, p.dec0, p.dec1, p.quoteSide),
      exit: closed ? sqrtPriceOf(p.exitSqrt, p.dec0, p.dec1, p.quoteSide) : null,
      closed, inRange: closed ? null : p.inRange ?? null,
      // When the position opened/closed — drawn as a vertical line on its candle.
      openedTs: p.opened_ts || null, closedTs: closed ? p.closed_ts || null : null,
      ageHours: p.ageHours ?? ((closed && p.closed_ts ? p.closed_ts : Date.now()) - (p.opened_ts || Date.now())) / 3600000,
      change: Number(first.o) > 0 ? ((Number(last.c) - Number(first.o)) / Number(first.o)) * 100 : null,
      pnlUsd: p.pnlUsd, pnlPct: p.pnlPct, costUsd: p.costUsd, feeUsd: closed ? null : p.feeUsd,
      bepPrice: bep?.price ?? null, bepNote: bep?.reason || null,
      cost: p.cost || null, at: Date.now(),
      // Candles from the fallback (GeckoTerminal is rate limiting): their age is printed too.
      staleAt: oh.stale ? oh.staleAt || oh.fetchedAt || null : null,
    };
    const opts = { lang, timeZone: tz || cfg.telegram?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    return { png: chartCard.render(data, opts), caption: chartCard.caption(data, lang), tf: frame, mask: data.mask, span: data.span, candles: candles.length };
  };

  // Portfolio growth chart as an image (src/portfolio-card.js), from the
  // same /api/portfolio as the Summary page. Used by the "Portfolio chart"
  // button in the Telegram bot and the PNG route below.
  const portfolioCardOf = async ({ range = '7d', view = 'net', lang = 'id', tz } = {}) => {
    const r = portfolioCard.RANGES.includes(range) ? range : '7d';
    const pf = await callApi('GET', '/api/portfolio', {}, { range: r });
    if (pf.error) return { error: pf.error };
    const data = portfolioCard.prepare(pf, view);
    if (data.pts.length < 2) return { error: 'Belum ada riwayat portofolio. Grafiknya terisi setelah bot membuka posisi pertama — nilai portofolio dicatat tiap 5 menit.' };
    const opts = { lang, timeZone: tz || cfg.telegram?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    return { png: portfolioCard.render(data, opts), caption: portfolioCard.caption(data, lang), range: r, view: data.view, points: data.pts.length };
  };

  // Telegram mini app entry: initData is exchanged for a session ticket. The only
  // route that may be called before there is a session — its guard is in Telegram's
  // signature (needs bot_token) PLUS the requirement that the chat is already connected, the same rule
  // as the bot: one not in telegram.chat_ids cannot read anything.
  const tgAuth = async (req, res) => {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '300', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'terlalu banyak percobaan — tunggu beberapa menit' }));
    }
    const b = await readBody(req).catch(() => ({}));
    const botToken = cfg.telegram?.bot_token || null;
    if (!botToken) return json(res, 200, { error: 'bot Telegram belum disetel di server ini' });
    const r = checkInitData(b.initData, botToken);
    if (r.error) {
      loginFail(ip);
      log(`mini app: ${r.error}${r.column ? ` (kolom: ${r.column.join(',')})` : ''}`);
      return json(res, 200, { error: r.error });
    }
    const chats = (cfg.telegram?.chat_ids || []).map(String);
    if (!chats.includes(String(r.user.id))) {
      loginFail(ip);
      log(`mini app: ditolak — chat ${r.user.id} belum tersambung`);
      return json(res, 200, { error: 'Akun Telegram ini belum tersambung ke Quiver. Kirim /start <kode> ke bot dulu.' });
    }
    loginHits.delete(ip);
    const TOKEN = tokenNow();
    // The cookie is also set so the "Open full dashboard" button inside the mini app does not
    // land on the sign-in page (works in a phone webview; in the Telegram Web iframe third-party
    // cookies can be blocked — there the ticket is what works).
    if (TOKEN) res.__setCookie = sessionCookie(req, TOKEN);
    log(`mini app: ${r.user.username ? '@' + r.user.username : r.user.id} masuk${r.look === 'baku' ? '' : ` (tanda tangan ${r.look})`}`);
    return json(res, 200, {
      ok: true,
      token: TOKEN ? miniNew(r.user) : null,
      user: { id: r.user.id, name: r.user.username || r.user.first_name || null },
      chain: { key: chain.network, label: chain.label, explorer: chain.explorer },
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;

    // The Telegram mini app exchanges initData for a ticket here — before the gate, because
    // at that point there is no session at all.
    if (key === 'POST /api/tg/auth') return tgAuth(req, res);

    // ---- token gate ----
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
      // Logout: delete the session cookie then go back to the sign-in page. A SameSite=Lax cookie
      // is not sent on a cross-site POST, so no one can log someone else out.
      if (url.pathname === '/logout' && req.method === 'POST') {
        res.writeHead(302, { location: '/', 'set-cookie': clearCookie(req), 'cache-control': 'no-store' });
        return res.end();
      }
      // Vendor assets, fonts, and the favicon may pass so the sign-in page can display properly.
      const isPublicAsset = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/fonts/') || url.pathname === '/favicon.svg'
        || MINI_PUBLIC.test(url.pathname)   // mini app: its page & chunks are loaded before there is a ticket
        // Token icon in the mini app: <img> cannot carry an Authorization header, so the
        // ticket rides in the query. Only for this image route — a ticket in the URL does not
        // open other routes, and it is not the dashboard token that it carries.
        || (url.pathname === '/api/icon' && miniOk(url.searchParams.get('t') || ''));
      if (!isPublicAsset && !authed(req)) {
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"tidak berwenang"}');
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', ...SEC_HEADERS });
        return res.end(LOGIN_PAGE(false));
      }
    }
    // Token logo: the only /api route that replies with an image, not JSON.
  // Share card: the only other /api route that replies with an image.
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
        // an image from a third party, served on the origin that holds the login cookie
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      return res.end(img.buf);
    }
    if (routes[key]) {
      // CSRF: a request that changes something must come from the dashboard's own page.
      // Modern browsers always send Origin (and Sec-Fetch-Site) on a POST; other origins
      // are refused. Without a header (curl, scripts, the Telegram bot via callApi) it still passes —
      // the token gate guards it.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        let host = null;
        try { host = origin ? new URL(origin).host : null; } catch { host = '(rusak)'; }
        if ((host && host !== req.headers.host) || site === 'cross-site') return json(res, 403, { error: 'permintaan lintas situs ditolak' });
      }
      // The details of an unexpected error go only to the log; the client gets a generic message so
      // filesystem paths / RPC details do not leak. Errors that really need to
      // be shown are already returned by each route as {error} with status 200.
      try { return json(res, 200, await routes[key](req, url, res)); }
      catch (e) { log(`api ${key}: ${e.message}`); return json(res, 500, { error: 'kesalahan server' }); }
    }
    if (req.method !== 'GET') return json(res, 404, { error: 'tidak ada' });

    // The view: the React build result (web/dist) if present; if not yet built, use the
    // old view in public/. /vendor/* and the favicon always come from public/ (used by the
    // sign-in page too).
    const dist = path.join(__dirname, '..', 'web', 'dist');
    const useDist = fs.existsSync(path.join(dist, 'index.html'));
    const isVendor = url.pathname.startsWith('/vendor/') || url.pathname === '/favicon.svg';
    const root = isVendor || !useDist ? pub : dist;
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/mini' || p === '/mini/') p = '/mini.html';    // second entry of the Vite build
    let file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(404); return res.end('tidak ada'); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // single-page app: a route without an extension is answered with index.html
      if (useDist && !path.extname(p)) file = path.join(dist, 'index.html');
      else { res.writeHead(404); return res.end('tidak ada'); }
    }
    // Cache: Cloudflare stores .js/.css itself unless the origin forbids it.
    //  - index.html: never cache (it points to the latest versioned files)
    //  - /assets/* Vite output: the name contains a content hash -> safe to cache forever
    //  - vendor & fonts: never change
    const immutable = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/');
    const headers = {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // private: the browser may store, the CDN (Cloudflare) may not — this file is behind the token gate.
      'cache-control': immutable ? `${isVendor ? 'public' : 'private'}, max-age=31536000, immutable` : 'private, no-store, max-age=0',
      // HTML documents are guarded against clickjacking; static assets need not be.
      ...(path.extname(file) === '.html' ? (path.basename(file) === 'mini.html' ? TG_SEC_HEADERS : SEC_HEADERS) : {}),
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

module.exports = { createServer, checkInitData };
