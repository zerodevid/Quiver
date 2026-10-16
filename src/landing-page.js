'use strict';
// Landing page: what a signed-out visitor sees at / on a server with accounts.
//
// Rendered by the server as one string, like the sign-in and setup pages: no React, no build,
// no second request except the shared font and the brand tiles that are already public
// (MINI_PUBLIC in server.js). Same design language and colour tokens as the dashboard: Inter,
// flat bordered surfaces, one accent, the light/dark choice from localStorage 'lpcopy-theme'.
//
// Bilingual: English by default, Indonesian with ?lang=id. The choice is kept in the same
// localStorage key as the dashboard and the setup wizard ('lpcopy-lang'); a visitor who picked
// Indonesian before is sent to ?lang=id by the head script before the page paints.
//
// The hero shows real dashboard screenshots (web/public/landing-overview-<lang>-<theme>.webp),
// captured from the masked demo data (demo/privacy.mjs: pseudonymous addresses, scaled amounts);
// the one matching the page language and theme is shown.
//
// The client script avoids template literals and backslashes so it reads as-is inside this
// Node template literal (no ${…} to escape, except the values injected on purpose).
//
// Fees mirror the open-LP plan (flat per action, paid in the chain's native coin). Change them
// here, in the calculator constants in the client script, and in the fee code together.

const ARROW_PATH = 'M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0Z';
const CHEV_PATH = 'M43 11L51 3L73 24L51 46L43 38L56 24Z';
const WORD_PATH = 'M99 9C88 9 82 15 82 24S88 39 99 39C102 39 105 38 107 37L113 43L118 38L112 32C114 30 115 27 115 24C115 15 109 9 99 9ZM99 15C105 15 108 18 108 24S105 33 99 33S89 30 89 24S93 15 99 15Z M120 10H127V27C127 31 130 33 134 33S141 31 141 27V10H148V27C148 35 143 39 134 39S120 35 120 27Z M154 10H161V38H154Z M166 10H174L183 31L192 10H200L187 38H179Z M204 10H229V16H211V21H227V27H211V32H229V38H204Z M234 10H250C258 10 262 14 262 20C262 24 260 27 256 28L264 38H255L248 29H241V38H234ZM241 16V23H249C253 23 255 22 255 20S253 16 249 16Z';
const LOGO = (h = 22) => `<svg height="${h}" viewBox="0 0 264 48" role="img" aria-label="Quiver"><g fill="currentColor" fill-rule="evenodd"><path class="q-arrow" d="${ARROW_PATH}"/><path class="q-chev" d="${CHEV_PATH}"/><path d="${WORD_PATH}"/></g></svg>`;

// The dashboard's splash (web/index.html #splash): the arrow glides in, the chevron follows, the
// name rises, then the arrow keeps being "drawn" while the page loads. Same markup and motion.
const SPLASH = `<div id="splash" aria-hidden="true">
  <div class="sp-logo">
    <svg class="sp-mark" viewBox="0 0 73 48"><path class="sp-arrow" d="${ARROW_PATH}"/><path class="sp-chev" d="${CHEV_PATH}"/></svg>
    <svg class="sp-word" viewBox="82 0 182 48"><path fill-rule="evenodd" d="${WORD_PATH}"/></svg>
  </div>
  <div class="sp-bar"><span></span></div>
</div>`;

// Lucide line icons (24px grid, stroke inherits the text colour), as in the dashboard.
const ICON = {
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15.7 9.3A6 6 0 1 1 9.3 15.7"/><path d="M9 7v4l2 1"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  external: '<path d="M7 17 17 7M7 7h10v10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
// Brand marks for the community links (Simple Icons, CC0), filled with the text colour.
const BRAND = {
  telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  discord: 'M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z',
};
const brand = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${BRAND[name]}"/></svg>`;
// Community links come from config.json (landing.links). Each key has its icon and its copy in
// COPY.community; a key that is missing or not an https:/mailto: URL is left out, so the section
// and the footer row only show what has been set.
const LINK_KEYS = ['telegramChannel', 'telegramGroup', 'x', 'discord', 'email'];
const LINK_ICON = { telegramChannel: () => brand('telegram'), telegramGroup: () => brand('telegram'), x: () => brand('x'), discord: () => brand('discord'), email: () => icon('mail') };
const safeLinks = (links) => LINK_KEYS
  .map((k) => [k, String(links?.[k] || '').trim()])
  .map(([k, v]) => [k, k === 'email' && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(v) ? `mailto:${v}` : v])
  .filter(([, v]) => /^(https:\/\/[^\s<>"]+|mailto:[^\s<>"]+)$/i.test(v));
const icon = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LANGS = ['en', 'id'];
const DEFAULT_LANG = 'en';

// Language-neutral data.
const FEATURE_ICONS = ['close', 'target', 'coins', 'plus', 'chart', 'calendar', 'send', 'search'];
const NOTIF_ICONS = ['plus', 'close', 'coins', 'target'];
// Share-card themes in deck order (web/public/share-<theme>-<lang>.webp, rendered by src/share-card.js
// from illustrative positions).
const SHARE_THEMES = ['hell', 'gold', 'midnight', 'neon', 'sunset', 'pixel', 'light', 'dark'];
const FEE_PRICES = ['$0.20', '$0.20', null, null]; // null = free (src/billing.js: open and close only)
// The route-finder card: one real quote set, 4,803 CUCK -> USDG on Robinhood Chain, 2026-10-16
// (dashboard Swap page; the Uniswap row is the CUCK/USDG 4% pool, i.e. what a single-pool zapper
// gets). [tile in web/public, name, response ms, USDG out]; no output = that aggregator gave no
// quote. Listed in the engine's DEFAULT_ORDER (src/swaprouter.js). 0x, 1inch and OpenOcean stay
// out until they have API keys and quote live (their tiles in web/public are ready). 0x, 1inch and OpenOcean are left
// out until they have API keys and quote live (tiles zerox/1inch/openocean.png are ready).
const ROUTES = [
  ['kyberswap.png', 'Kyber', 52, 1.268997],
  ['okx.png', 'OKX', 94, 1.266687],
  ['lifi.png', 'LI.FI', 749, 1.265218],
  ['uniswap.png', 'Uniswap', 180, 1.182677],
];
// Final display rank: best output first, aggregators without a quote last (stable).
const routeRank = (() => {
  const idx = ROUTES.map((r, i) => i).sort((a, b) => (ROUTES[b][3] || 0) - (ROUTES[a][3] || 0) || a - b);
  const rank = []; idx.forEach((i, r) => { rank[i] = r; }); return rank;
})();
const bestRoute = routeRank.indexOf(0);
const CHAINS = [
  ['robinhood-chain.jpg', 'Robinhood Chain'],
  ['bnb-chain.png', 'BNB Chain'],
  ['solana.svg', 'Solana'],
  ['base-chain.png', 'Base'],
  ['ethereum-chain.png', 'Ethereum'],
  ['arbitrum-chain.png', 'Arbitrum'],
  ['uniswap.png', 'Uniswap v3 · v4'],
  ['meteora.png', 'Meteora DLMM · DAMM v2'],
];

// All visible copy. Figures in the replica use the language's number format (3,650 vs 3.650).
const COPY = {
  en: {
    locale: 'en-US',
    title: 'Quiver — Concentrated liquidity management',
    description: 'Open, maintain, and close concentrated liquidity positions on Uniswap and Meteora: out-of-range exits, take profit and stop loss, fee compounding, and Telegram alerts.',
    nav: ['Features', 'Automation', 'Pricing', 'FAQ'],
    signIn: 'Sign in', signUp: 'Sign up', createAccount: 'Create account', explore: 'Explore features',
    themeLabel: 'Toggle light/dark theme', langLabel: 'Language', menuLabel: 'Menu', themeShort: 'Theme',
    kicker: 'Robinhood Chain, BNB Chain, Solana, and more EVM chains',
    h1: 'Your liquidity, <span>on autopilot.</span>',
    lead: 'Quiver opens, maintains, and closes your LP positions on Uniswap and Meteora. Exits when price leaves your range, take profit and stop loss, and fee compounding all run automatically on your rules.',
    inviteOnly: 'Sign-up is currently invite-only.',
    app: {
      alt: 'Quiver dashboard overview: portfolio value, net PnL, fees earned, win rate, portfolio growth chart and composition',
      note: 'The real Quiver dashboard. Data shown is illustrative.',
    },
    logos: 'Supported chains and venues',
    features: {
      k: 'Features', h: 'One place for the whole life of an LP position.',
      p: 'From picking a pool to measuring net results, the active LP workflow lives in one dashboard and keeps running without you watching it.',
      items: [
        ['Exit when out of range', 'Close a position once price has stayed outside its range for the minutes you set, or moved too far from it, so capital does not sit idle.'],
        ['Take profit and stop loss', 'Exit on a PnL target or loss limit, or after a maximum position age. The engine watches around the clock and acts without waiting for you.'],
        ['Claim and compound fees', 'Claim fees any time or add them back to the position on a schedule. No platform fee.'],
        ['Manual LP on one screen', 'Search for a pool or paste its address, pick a range and liquidity shape (spot, curve, bid-ask). The swap into the pair is done for you.'],
        ['Monitoring and pool data', 'Candles per position, distance to the range edges, liquidity depth, and the full history of every position.'],
        ['Net PnL', 'A calendar and equity curve measured net of gas and slippage, not just gross fees.'],
        ['Telegram and mini app', 'An alert for every action, a daily summary, and the full dashboard right inside Telegram.'],
        ['Pool and wallet research', 'Pools that are active right now, and the track record of other LP wallets before you jump in.'],
      ],
    },
    automation: {
      k: 'Automation', h: 'Set the rules once. The engine applies them around the clock.',
      p: 'Your exit rules apply to every open position. Quiver watches price and PnL and acts when a rule is met, including while you are offline.',
      ticks: ['Range and liquidity shape (spot, curve, bid-ask) are set when you open', 'Swaps to the right ratio happen automatically', 'Every action is logged with an explorer link'],
      card: 'Position rules', example: 'example',
      rules: [['Range', '±6% around price'], ['Liquidity shape', 'Curve'], ['Out of range', 'Close after 30 min'], ['Take profit', '+8% PnL'], ['Stop loss', '−5% PnL'], ['Compound fees', 'Every 6 hours']],
    },
    routing: {
      k: 'Best swap route', h: 'Every swap goes the best way, not just through your pool.',
      p: 'A zapper that only swaps inside the pool you LP in pays that pool\'s fee and its thin depth. Quiver asks several aggregators at once and takes the route with the most output, across pools and DEXes.',
      ticks: ['Aggregators quoted in parallel: Kyber, OKX, LI.FI, and Uniswap on-chain', 'Multi-hop routes, for example through a deeper pool with a lower fee', 'Each route is simulated on-chain before sending; if one fails, the next takes over'],
      card: 'Route finder', where: 'Robinhood Chain',
      swap: 'Sell 4,803 CUCK for USDG',
      scanning: 'Quoting {0} aggregators…', done: '{0} routes found', noQuote: 'no quote', best: 'Best', single: 'single pool, 4% fee', replay: 'Run again',
      sum: ['Single-pool zapper', 'Quiver, via Kyber'],
      gain: '+7.3% more USDG',
      note: 'Measured on chain on 16 Oct 2026. On deep pairs such as ETH/USDG the gap is usually below 0.1%; it grows on small tokens with high-fee or thin pools.',
    },
    alerts: {
      k: 'Alerts', h: 'Know about every action without opening the dashboard.',
      p: 'The Telegram bot reports every position opened and closed and every fee harvest, plus a daily summary. The mini app opens the full dashboard inside Telegram.',
      items: [['Position opened', 'WETH / USDG · $1,200 · 3,412–3,896', '09:14'], ['Out of range for 30 min', 'WETH / USDG · position closed', '11:02'], ['Fees compounded', '+$4.10 added to the position', '15:00'], ['Take profit hit', '+8.2% · position closed', '18:47']],
    },
    steps: {
      k: 'Getting started', h: 'Three steps to your first position.',
      items: [['Create an account', 'Sign up with a username and password. Every account gets its own wallet, engine, and data.'], ['Fund the wallet', 'Send the native coin and a stablecoin to your account wallet on the chain you want to use.'], ['Open a position', 'Pick a pool and set the range and exit rules. Quiver runs the rest and reports on Telegram.']],
    },
    pricing: {
      k: 'Pricing', h: 'Pay per action. No subscription.',
      p: 'A flat fee per transaction, paid in the chain\'s native coin. Nothing is taken from your profit or your LP fees.',
      ticks: ['No monthly fee or minimum deposit', 'Swaps, claiming fees, adding liquidity, and compounding are free', 'Your LP fees stay 100% yours'],
      referral: '<b>Referrals:</b> earn 25% of the open and close fees of the accounts you invite.',
      card: 'Fee schedule', per: 'per transaction', free: 'Free',
      rows: [['Open a position', ''], ['Close a position', 'manual, TP/SL, or out of range'], ['Swap', ''], ['Claim fees, add liquidity, compound', '']],
      calcH: 'Estimated monthly cost', calcSub: 'Network gas not included.',
      sliders: ['Positions opened and closed'],
      month: 'Per month', perPos: 'per position',
    },
    calendar: {
      k: 'PnL calendar', h: 'Every day of the month, at a glance.',
      p: 'Realized PnL for each day, net of gas and slippage, with the number of positions closed. Green and red days and the monthly total sit side by side, and one click turns a day into a share card.',
      ticks: ['Days follow your own time zone', 'Monthly total and green/red day count', 'Share a day as a card, or the whole month as a card or a replay video'],
      alt: 'Quiver PnL calendar for September 2026 with realized PnL per day', note: 'The real Quiver calendar, with an illustrative month.',
    },
    share: {
      k: 'Share cards', h: 'Show off your PnL, in your style.',
      p: 'Turn any position, day, month, or your whole portfolio into a card ready for X or Telegram. Pick a theme and a size, or hide the amounts and share only the percentage.',
      ticks: ['8 themes, from Graphite to Hell', 'Wide, square, and story sizes', 'Amounts can be hidden, or shown in your own currency'],
      themes: { hell: 'Hell', gold: 'Gold', midnight: 'Midnight', neon: 'Neon', sunset: 'Sunset', pixel: 'Pixel', light: 'Light', dark: 'Graphite' },
      deck: 'Share card themes', next: 'Next card', alt: 'Quiver PnL share card, {0} theme',
    },
    soon: { tag: 'Coming soon', h: 'LP copy trading', p: 'Follow the positions of LP wallets you choose, with your own size and rules. Being prepared for every account.' },
    security: {
      k: 'Security', h: 'A separate wallet for every account.',
      items: [['Encrypted keys', 'Each account\'s private key is stored encrypted on the server and never shown in the dashboard.'], ['Export any time', 'Retrieve your private key after re-entering your password, and import it into any wallet.'], ['Verifiable on-chain', 'Every transaction has an explorer link, and PnL is computed from on-chain data after gas.']],
    },
    faq: {
      k: 'FAQ', h: 'Common questions',
      items: [
        ['Does Quiver hold my funds?', 'Yes, this is a custodial service: each account has its own wallet whose key is stored encrypted on the server, so the engine can close positions and compound fees without you being online. You can export the private key any time after re-entering your password.'],
        ['How are fees paid?', 'In the native coin of the chain where the action happens (for example ETH or BNB), deducted when the action runs. Network gas is paid separately as usual.'],
        ['Is LP always profitable?', 'No. Trading fees can be outweighed by impermanent loss, especially on new, volatile tokens. Quiver helps you manage the risk with ranges, TP/SL, and pool data, but the decisions and the risk remain yours.'],
        ['What about copy trading?', 'Copying the positions of other LP wallets is being prepared for every account. For now, regular accounts focus on manual LP with full automation.'],
        ['How do I sign up?', 'Sign-up currently requires an invite code. Ask the operator for a code, then open the Sign up page. Open registration is coming soon.'],
      ],
    },
    community: {
      k: 'Community', h: 'Talk to us and other LPs.',
      p: 'Announcements, help with your positions, and ideas for what we build next.',
      items: {
        telegramChannel: ['Telegram channel', 'Announcements, releases, and status updates'],
        telegramGroup: ['Telegram group', 'Ask questions and share setups with other LPs'],
        x: ['X', 'Product news and PnL cards from the community'],
        discord: ['Discord', 'Community chat and support'],
        email: ['Email', 'Support, partnerships, and account issues'],
      },
    },
    final: { h: 'Start managing your LP positions with Quiver.', p: 'Create an account, fund the wallet, and open your first position in minutes.' },
    footerNav: ['Features', 'Pricing', 'FAQ', 'Sign in'],
    risk: 'Providing liquidity carries risk, including impermanent loss, smart contract failure, and tokens losing their value. Quiver is a tool, not financial advice. Only use funds you can afford to put at risk.',
  },
  id: {
    locale: 'id-ID',
    title: 'Quiver — Manajemen LP terkonsentrasi',
    description: 'Buka, jaga, dan tutup posisi likuiditas terkonsentrasi di Uniswap dan Meteora: keluar otomatis saat di luar rentang, take profit dan stop loss, compound fee, dan notifikasi Telegram.',
    nav: ['Fitur', 'Otomasi', 'Biaya', 'FAQ'],
    signIn: 'Masuk', signUp: 'Daftar', createAccount: 'Buat akun', explore: 'Pelajari fitur',
    themeLabel: 'Ganti tema terang/gelap', langLabel: 'Bahasa', menuLabel: 'Menu', themeShort: 'Tema',
    kicker: 'Robinhood Chain, BNB Chain, Solana, dan chain EVM lain',
    h1: 'Likuiditas Anda, <span>berjalan otomatis.</span>',
    lead: 'Quiver membuka, menjaga, dan menutup posisi LP Anda di Uniswap dan Meteora. Keluar saat harga meninggalkan rentang, take profit dan stop loss, serta compound fee berjalan otomatis sesuai aturan Anda.',
    inviteOnly: 'Pendaftaran saat ini memakai kode undangan.',
    app: {
      alt: 'Ringkasan dasbor Quiver: nilai portofolio, PnL bersih, fee terkumpul, win rate, grafik pertumbuhan dan komposisi portofolio',
      note: 'Dasbor Quiver yang sebenarnya. Data yang tampil bersifat ilustrasi.',
    },
    logos: 'Chain dan venue yang didukung',
    features: {
      k: 'Fitur', h: 'Satu tempat untuk seluruh siklus posisi LP.',
      p: 'Dari memilih pool sampai menghitung hasil bersih, alur kerja LP aktif ada di satu dasbor dan berjalan tanpa Anda harus terus memantau.',
      items: [
        ['Keluar saat di luar rentang', 'Posisi ditutup begitu harga berada di luar rentang selama menit yang Anda tetapkan, atau sudah terlalu jauh, supaya modal tidak menganggur.'],
        ['Take profit dan stop loss', 'Keluar saat target PnL atau batas rugi tercapai, atau setelah umur posisi maksimum. Mesin memantau 24 jam dan mengeksekusi tanpa menunggu Anda.'],
        ['Klaim dan compound fee', 'Klaim fee kapan saja atau tambahkan kembali ke posisi secara terjadwal. Tanpa biaya platform.'],
        ['LP manual dalam satu layar', 'Cari pool atau tempel alamatnya, pilih rentang dan bentuk likuiditas (spot, curve, bid-ask). Swap ke pasangan dilakukan otomatis.'],
        ['Monitor dan data pool', 'Candle per posisi, jarak ke batas rentang, kedalaman likuiditas, dan riwayat setiap posisi.'],
        ['PnL bersih', 'Kalender dan kurva ekuitas yang dihitung bersih setelah gas dan slippage, bukan sekadar fee kotor.'],
        ['Telegram dan mini app', 'Notifikasi setiap aksi, ringkasan harian, dan dasbor lengkap langsung dari Telegram.'],
        ['Riset pool dan wallet', 'Daftar pool yang sedang aktif dan analisis riwayat wallet LP lain sebelum Anda masuk.'],
      ],
    },
    automation: {
      k: 'Otomasi', h: 'Tetapkan aturan sekali. Mesin menjalankannya 24 jam.',
      p: 'Aturan exit Anda berlaku untuk setiap posisi yang terbuka. Quiver memantau harga dan PnL, lalu bertindak saat syaratnya terpenuhi, termasuk ketika Anda sedang offline.',
      ticks: ['Rentang dan bentuk likuiditas (spot, curve, bid-ask) dipilih saat membuka posisi', 'Swap ke rasio yang tepat dilakukan otomatis', 'Setiap aksi dicatat dengan tautan explorer'],
      card: 'Aturan posisi', example: 'contoh',
      rules: [['Rentang', '±6% dari harga'], ['Bentuk likuiditas', 'Curve'], ['Di luar rentang', 'Tutup setelah 30 menit'], ['Take profit', '+8% PnL'], ['Stop loss', '−5% PnL'], ['Compound fee', 'Setiap 6 jam']],
    },
    routing: {
      k: 'Rute swap terbaik', h: 'Setiap swap lewat jalur terbaik, bukan hanya pool Anda.',
      p: 'Zapper yang hanya swap di dalam pool tempat Anda LP ikut menanggung fee dan likuiditas tipis pool itu. Quiver bertanya ke beberapa agregator sekaligus dan memilih rute dengan hasil terbanyak, lintas pool dan DEX.',
      ticks: ['Agregator di-quote paralel: Kyber, OKX, LI.FI, dan Uniswap on-chain', 'Rute multi-hop, misalnya lewat pool yang lebih dalam dengan fee lebih rendah', 'Setiap rute disimulasikan on-chain sebelum dikirim; jika satu gagal, berikutnya mengambil alih'],
      card: 'Pencari rute', where: 'Robinhood Chain',
      swap: 'Jual 4.803 CUCK ke USDG',
      scanning: 'Meminta quote ke {0} agregator…', done: '{0} rute ditemukan', noQuote: 'tanpa quote', best: 'Terbaik', single: 'satu pool, fee 4%', replay: 'Ulangi',
      sum: ['Zapper satu pool', 'Quiver, lewat Kyber'],
      gain: '+7,3% USDG lebih banyak',
      note: 'Diukur on-chain pada 16 Okt 2026. Di pair dalam seperti ETH/USDG selisihnya biasanya di bawah 0,1%; makin besar di token kecil dengan pool ber-fee tinggi atau tipis.',
    },
    alerts: {
      k: 'Notifikasi', h: 'Tahu setiap aksi, tanpa membuka dasbor.',
      p: 'Bot Telegram mengirim kabar untuk setiap posisi yang dibuka dan ditutup serta setiap panen fee, beserta ringkasan harian. Mini app membuka dasbor lengkap langsung di Telegram.',
      items: [['Posisi dibuka', 'WETH / USDG · $1.200 · 3.412–3.896', '09.14'], ['Di luar rentang 30 menit', 'WETH / USDG · posisi ditutup', '11.02'], ['Fee di-compound', '+$4,10 ditambahkan ke posisi', '15.00'], ['Take profit tercapai', '+8,2% · posisi ditutup', '18.47']],
    },
    steps: {
      k: 'Memulai', h: 'Tiga langkah menuju posisi pertama.',
      items: [['Buat akun', 'Daftar dengan nama pengguna dan kata sandi. Setiap akun mendapat wallet, mesin, dan data yang terpisah.'], ['Isi wallet', 'Kirim koin native dan stablecoin ke alamat wallet akun Anda di chain yang ingin dipakai.'], ['Buka posisi', 'Pilih pool, atur rentang dan aturan exit. Quiver menjalankan sisanya dan melapor lewat Telegram.']],
    },
    pricing: {
      k: 'Biaya', h: 'Bayar per aksi. Tanpa langganan.',
      p: 'Biaya tetap per transaksi, dibayar dengan koin native chain. Tidak ada potongan dari profit maupun fee LP Anda.',
      ticks: ['Tanpa biaya bulanan atau minimum deposit', 'Swap, klaim fee, tambah likuiditas, dan compound gratis', 'Fee LP sepenuhnya milik Anda'],
      referral: '<b>Referral:</b> 25% dari biaya buka dan tutup posisi akun yang Anda undang.',
      card: 'Daftar biaya', per: 'per transaksi', free: 'Gratis',
      rows: [['Buka posisi', ''], ['Tutup posisi', 'manual, TP/SL, atau di luar rentang'], ['Swap', ''], ['Klaim fee, tambah likuiditas, compound', '']],
      calcH: 'Perkiraan biaya bulanan', calcSub: 'Gas jaringan tidak termasuk.',
      sliders: ['Posisi dibuka dan ditutup'],
      month: 'Per bulan', perPos: 'per posisi',
    },
    calendar: {
      k: 'Kalender PnL', h: 'Setiap hari dalam sebulan, sekilas.',
      p: 'PnL terealisasi per hari, bersih setelah gas dan slippage, beserta jumlah posisi yang ditutup. Hari hijau, hari merah, dan total bulanan terlihat berdampingan, dan satu klik menjadikan sebuah hari kartu share.',
      ticks: ['Hari mengikuti zona waktu Anda', 'Total bulanan dan jumlah hari hijau/merah', 'Bagikan satu hari sebagai kartu, atau sebulan penuh sebagai kartu maupun video replay'],
      alt: 'Kalender PnL Quiver bulan September 2026 dengan PnL terealisasi per hari', note: 'Kalender Quiver yang sebenarnya, dengan bulan ilustrasi.',
    },
    share: {
      k: 'Kartu share', h: 'Pamerkan PnL Anda, dengan gaya Anda.',
      p: 'Ubah posisi, hari, bulan, atau seluruh portofolio menjadi kartu siap kirim ke X atau Telegram. Pilih tema dan ukuran, atau sembunyikan nominal dan bagikan persentasenya saja.',
      ticks: ['8 tema, dari Grafit sampai Neraka', 'Ukuran lebar, persegi, dan story', 'Nominal bisa disembunyikan, atau ditampilkan dalam mata uang Anda'],
      themes: { hell: 'Neraka', gold: 'Emas', midnight: 'Malam', neon: 'Neon', sunset: 'Senja', pixel: 'Piksel', light: 'Terang', dark: 'Grafit' },
      deck: 'Tema kartu share', next: 'Kartu berikutnya', alt: 'Kartu share PnL Quiver, tema {0}',
    },
    soon: { tag: 'Segera hadir', h: 'Copy trading LP', p: 'Ikuti posisi wallet LP pilihan dengan ukuran dan aturan Anda sendiri. Sedang disiapkan untuk semua akun.' },
    security: {
      k: 'Keamanan', h: 'Wallet terpisah untuk setiap akun.',
      items: [['Kunci terenkripsi', 'Kunci privat setiap akun disimpan terenkripsi di server dan tidak pernah ditampilkan di dasbor.'], ['Ekspor kapan saja', 'Ambil kunci privat Anda setelah memasukkan ulang kata sandi, lalu impor ke wallet mana pun.'], ['Dapat diverifikasi on-chain', 'Setiap transaksi memiliki tautan explorer, dan PnL dihitung dari data on-chain setelah gas.']],
    },
    faq: {
      k: 'FAQ', h: 'Pertanyaan umum',
      items: [
        ['Apakah Quiver memegang dana saya?', 'Ya, ini layanan kustodian: setiap akun punya wallet sendiri yang kuncinya disimpan terenkripsi di server, supaya mesin bisa menutup posisi dan compound fee tanpa Anda harus online. Anda bisa mengekspor kunci privat kapan saja setelah memasukkan ulang kata sandi.'],
        ['Biaya dibayar pakai apa?', 'Koin native chain tempat transaksi terjadi (misalnya ETH atau BNB), dipotong saat aksi berjalan. Gas jaringan tetap dibayar terpisah seperti biasa.'],
        ['Apakah LP pasti untung?', 'Tidak. Fee trading bisa kalah oleh impermanent loss, terutama di token baru yang volatil. Quiver membantu mengelola risiko dengan rentang, TP/SL, dan data pool, tapi keputusan dan risikonya tetap di tangan Anda.'],
        ['Bagaimana dengan copy trading?', 'Fitur menyalin posisi wallet LP lain sedang disiapkan untuk semua akun. Untuk sekarang, akun reguler fokus ke LP manual dengan otomatisasi penuh.'],
        ['Bagaimana cara mendaftar?', 'Saat ini pendaftaran memakai kode undangan. Minta kode ke pengelola, lalu buka halaman Daftar. Pendaftaran terbuka untuk umum akan segera dibuka.'],
      ],
    },
    community: {
      k: 'Komunitas', h: 'Ngobrol dengan kami dan LP lain.',
      p: 'Pengumuman, bantuan untuk posisi Anda, dan ide untuk fitur berikutnya.',
      items: {
        telegramChannel: ['Channel Telegram', 'Pengumuman, rilis, dan status layanan'],
        telegramGroup: ['Grup Telegram', 'Tanya jawab dan berbagi setup dengan LP lain'],
        x: ['X', 'Kabar produk dan kartu PnL dari komunitas'],
        discord: ['Discord', 'Obrolan komunitas dan bantuan'],
        email: ['Email', 'Bantuan, kerja sama, dan masalah akun'],
      },
    },
    final: { h: 'Mulai kelola posisi LP Anda dengan Quiver.', p: 'Buat akun, isi wallet, dan buka posisi pertama dalam beberapa menit.' },
    footerNav: ['Fitur', 'Biaya', 'FAQ', 'Masuk'],
    risk: 'Menyediakan likuiditas mengandung risiko, termasuk impermanent loss, kegagalan smart contract, dan token yang kehilangan nilai. Quiver adalah alat bantu, bukan nasihat keuangan. Gunakan hanya dana yang siap Anda tanggung risikonya.',
  },
};

const CSS = `
:root{color-scheme:light;--bg:#fff;--bg2:oklch(.982 .002 286);--surface:#fff;--sunken:oklch(.975 .002 286);--fg:oklch(.18 .006 286);--fg2:oklch(.37 .006 286);--muted:oklch(.52 .006 286);--border:oklch(.91 .003 286);--border2:oklch(.86 .004 286);--accent:oklch(.55 .175 257);--ok:oklch(.55 .125 150);--warn:oklch(.6 .12 62);--danger:oklch(.545 .185 27);--gold:#B8892A;--bin:oklch(.6 .01 286 / .16);--bin-on:oklch(.55 .175 257 / .78);--shadow:0 1px 1px rgb(0 0 0/.03),0 8px 24px -6px rgb(0 0 0/.08),0 40px 80px -30px rgb(0 0 0/.18)}
:root.dark{color-scheme:dark;--bg:oklch(.155 .004 286);--bg2:oklch(.175 .004 286);--surface:oklch(.195 .005 286);--sunken:oklch(.175 .004 286);--fg:oklch(.96 .003 286);--fg2:oklch(.8 .005 286);--muted:oklch(.66 .006 286);--border:oklch(.27 .005 286);--border2:oklch(.33 .006 286);--accent:oklch(.68 .16 256);--ok:oklch(.76 .15 152);--warn:oklch(.79 .13 70);--danger:oklch(.71 .175 22);--gold:#D9AE45;--bin:oklch(.7 .01 286 / .14);--bin-on:oklch(.68 .16 256 / .8);--shadow:0 0 0 1px rgb(255 255 255/.02),0 40px 80px -30px rgb(0 0 0/.7)}
@font-face{font-family:Inter;src:url(/fonts/inter-var-latin.woff2) format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
html{font-size:15px;-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:4.5rem}
body{margin:0;background:var(--bg);color:var(--fg);font:400 1rem/1.6 Inter,ui-sans-serif,system-ui,sans-serif;font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
.num{font-variant-numeric:tabular-nums}
.wrap{width:100%;max-width:74rem;margin:0 auto;padding:0 1rem}
@media (min-width:640px){.wrap{padding:0 2rem}}
.ic{width:1.0625rem;height:1.0625rem;flex:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:.25rem}

/* nav */
.nav{position:sticky;top:0;z-index:10;background:color-mix(in oklab,var(--bg) 88%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid transparent;transition:border-color .2s}
.nav.scrolled{border-bottom-color:var(--border)}
.nav .wrap{display:flex;align-items:center;gap:2.25rem;height:3.75rem}
.nav .logo{display:flex;color:var(--fg)}
.nav .links{display:none;gap:1.75rem;font-size:.875rem;color:var(--muted)}
.nav .links a{transition:color .15s}.nav .links a:hover{color:var(--fg)}
@media (min-width:860px){.nav .links{display:flex}}
.nav .right{margin-left:auto;display:flex;align-items:center;gap:.375rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;height:2.25rem;padding:0 .9375rem;border-radius:.375rem;border:1px solid transparent;font:inherit;font-size:.875rem;font-weight:550;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.btn.primary{background:var(--fg);color:var(--bg)}
.btn.primary:hover{background:color-mix(in oklab,var(--fg) 85%,var(--bg))}
.btn.ghost{color:var(--fg2)}
.btn.ghost:hover{background:var(--sunken);color:var(--fg)}
.btn.outline{border-color:var(--border2);background:transparent;color:var(--fg)}
.btn.outline:hover{background:var(--sunken)}
.btn.lg{height:2.75rem;padding:0 1.25rem;font-size:.9375rem}
.btn .ic{width:1rem;height:1rem}
.theme{width:2.25rem;padding:0;color:var(--muted)}
.theme .moon{display:none}.dark .theme .moon{display:block}.dark .theme .sun{display:none}
.lang{display:inline-flex;height:2.25rem;align-items:center;padding:0 .25rem;font-size:.75rem;font-weight:600;letter-spacing:.02em}
.lang a{padding:.25rem .375rem;border-radius:.25rem;color:var(--muted);transition:color .15s,background .15s}
.lang a:hover{color:var(--fg)}
.lang a[aria-current]{color:var(--fg);background:var(--sunken)}
@media (max-width:480px){.nav .wrap{gap:.75rem}.nav .theme{display:none}.nav .signin{display:none}}

/* hero */
.hero{padding:4.5rem 0 0;text-align:center}
@media (min-width:960px){.hero{padding:6.5rem 0 0}}
.kicker{display:inline-flex;align-items:center;gap:.5rem;font-size:.8125rem;color:var(--muted)}
.kicker{padding:.3125rem .875rem .3125rem .375rem;border:1px solid var(--border);border-radius:99rem;background:var(--surface)}
.stack{display:inline-flex}
.stack img{width:1.375rem;height:1.375rem;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px var(--surface);background:var(--surface)}
.stack img+img{margin-left:-.375rem}
@media (max-width:520px){.kicker{flex-direction:column;gap:.5rem;padding:0;border:0;background:none}}
h1{margin:1.25rem auto 0;max-width:52rem;font-size:clamp(2.25rem,6vw,4rem);line-height:1.06;letter-spacing:-.04em;font-weight:650;text-wrap:balance}
h1 span{color:var(--muted)}
.lead{margin:1.375rem auto 0;max-width:38rem;font-size:1.125rem;line-height:1.6;color:var(--fg2);text-wrap:pretty}
.cta{display:flex;flex-wrap:wrap;justify-content:center;gap:.625rem;margin-top:2.25rem}
.fine{margin:1rem 0 0;font-size:.8125rem;color:var(--muted)}

/* dashboard screenshot */
.stage{position:relative;margin-top:4rem;padding-bottom:4.5rem;isolation:isolate}
.stage::before{content:"";position:absolute;inset:7rem 0 0;z-index:-1;background:var(--bg2);border-top:1px solid var(--border)}
.shot{max-width:72rem;margin:0 auto;border:1px solid var(--border2);border-radius:.75rem;box-shadow:var(--shadow);overflow:hidden;background:var(--surface)}
.shot img{display:block;width:100%;height:auto}
.shot .on-dark{display:none}.dark .shot .on-dark{display:block}.dark .shot .on-light{display:none}
.stage-note{margin:1rem 0 0;text-align:center;font-size:.75rem;color:var(--muted)}

/* logos */
.logos{padding:2.5rem 0;border-bottom:1px solid var(--border)}
.logos .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:1rem 2rem}
.logos .lbl{flex-basis:100%;text-align:center;font-size:.8125rem;color:var(--muted);margin-bottom:.25rem}
.logo-i{display:inline-flex;align-items:center;gap:.5rem;font-size:.875rem;font-weight:550;color:var(--fg2)}
.logo-i img{width:1.375rem;height:1.375rem;border-radius:.3125rem;object-fit:cover}

/* sections */
section{padding:6rem 0}
@media (max-width:640px){section{padding:4.5rem 0}}
.sh{max-width:40rem;margin-bottom:3rem}
.sh .k{font-size:.8125rem;font-weight:550;color:var(--accent)}
h2{margin:.625rem 0 0;font-size:clamp(1.75rem,3.6vw,2.5rem);line-height:1.12;letter-spacing:-.035em;font-weight:650;text-wrap:balance}
.sh p{margin:1rem 0 0;color:var(--fg2);font-size:1.0625rem;text-wrap:pretty}
.feats{display:grid;gap:2.5rem 2rem;grid-template-columns:1fr}
@media (min-width:640px){.feats{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1000px){.feats{grid-template-columns:repeat(4,1fr)}}
.feat .ic{width:1.25rem;height:1.25rem;color:var(--fg)}
.feat h3{margin:.875rem 0 0;font-size:.9688rem;font-weight:600;letter-spacing:-.01em}
.feat p{margin:.375rem 0 0;font-size:.875rem;color:var(--muted);line-height:1.6}

.band2{background:var(--bg2);border-block:1px solid var(--border)}
.duo{display:grid;gap:3rem;align-items:center}
@media (min-width:960px){.duo{grid-template-columns:1fr 1fr;gap:5rem}.duo .first{order:-1}}
.duo .sh{margin-bottom:0}
.ticks{list-style:none;margin:1.75rem 0 0;padding:0;display:grid;gap:.75rem;font-size:.9375rem;color:var(--fg2)}
.ticks li{display:flex;gap:.625rem;align-items:flex-start}
.ticks .ic{color:var(--ok);margin-top:.2rem;width:1rem;height:1rem}
.card{background:var(--surface);border:1px solid var(--border2);border-radius:.75rem;box-shadow:var(--shadow);overflow:hidden}
.card-h{display:flex;align-items:center;justify-content:space-between;padding:.875rem 1.25rem;border-bottom:1px solid var(--border);font-size:.875rem;font-weight:600}
.card-h span{font-weight:400;font-size:.75rem;color:var(--muted)}
.kv{display:flex;justify-content:space-between;gap:1rem;padding:.8125rem 1.25rem;border-top:1px solid var(--border);font-size:.875rem}
.card-h+.kv{border-top:0}
.kv span{color:var(--muted)}
.kv b{font-weight:550;text-align:right}
.notif{display:flex;align-items:flex-start;gap:.75rem;padding:.875rem 1.25rem;border-top:1px solid var(--border);font-size:.8438rem}
.card-h+.notif{border-top:0}
.notif .li{width:1.75rem;height:1.75rem;flex:none}
.notif .li .ic{width:.875rem;height:.875rem}
.notif b{display:block;font-weight:550}
.notif span{color:var(--muted);font-size:.8125rem}
.notif time{margin-left:auto;color:var(--muted);font-size:.75rem;white-space:nowrap}

/* route finder: aggregators quoted in parallel, best one picked (animated once in view) */
.rf-bar{height:2px;background:var(--border);overflow:hidden}
.rf-bar i{display:block;height:100%;width:100%;background:var(--accent);transform-origin:left;transform:scaleX(1);opacity:0;transition:opacity .4s}
.rf[data-s="scan"] .rf-bar i{opacity:1;animation:rf-fill 1.9s cubic-bezier(.4,0,.2,1) both}
@keyframes rf-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.rf-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.125rem 1rem;padding:.875rem 1.25rem .375rem;font-size:.875rem}
.rf-top b{font-weight:550}
.rf-st{font-size:.75rem;color:var(--muted);white-space:nowrap}
.ags{display:flex;flex-direction:column;gap:.375rem;padding:.375rem 1.25rem 0}
.ag{display:flex;align-items:center;gap:.75rem;padding:.4375rem .75rem;border:1px solid var(--border);border-radius:.5rem;background:var(--surface);transition:border-color .3s,background-color .3s,opacity .3s}
.ag img{width:1.5rem;height:1.5rem;border-radius:.375rem;flex:none}
.ag .nm{min-width:0}
.ag .nm b{display:flex;align-items:center;gap:.5rem;font-size:.8438rem;font-weight:550}
.ag .nm span{display:block;font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag em{font-style:normal;font-size:.6875rem;font-weight:600;color:var(--accent);background:color-mix(in oklab,var(--accent) 12%,transparent);padding:.0625rem .4375rem;border-radius:1rem;opacity:0;transition:opacity .3s}
.ag .q{margin-left:auto;position:relative;font-size:.9063rem;font-weight:600;min-width:4.5rem;text-align:right}
.ag .v{transition:opacity .3s}
.ag .sk{position:absolute;right:0;top:50%;width:3.75rem;height:.625rem;margin-top:-.3125rem;border-radius:.25rem;background:linear-gradient(90deg,var(--sunken),var(--border2),var(--sunken)) 0/200% 100%;opacity:0;transition:opacity .2s}
.ag.got .sk{transition:none;opacity:0!important;animation:none!important}
.ag.na{opacity:.55}.ag.na .v{color:var(--muted);font-weight:400}
.ag.best{border-color:var(--accent);background:color-mix(in oklab,var(--accent) 6%,var(--surface))}
.ag.best em{opacity:1}
.rf:is([data-s="idle"],[data-s="scan"]) .ag:not(.got) :is(.v,.nm span){opacity:0}
.rf[data-s="idle"] .ag .sk{opacity:1}
.rf[data-s="scan"] .ag:not(.got) .sk{opacity:1;animation:rf-sk 1.1s linear infinite}
.rf:is([data-s="idle"],[data-s="scan"]) .ag:not(.got){opacity:1}
.rf:not([data-s="done"]) .ag.best{border-color:var(--border);background:var(--surface)}
.rf:not([data-s="done"]) .ag.best em{opacity:0}
@keyframes rf-sk{from{background-position:200% 0}to{background-position:-200% 0}}
.rf-sum{display:flex;align-items:flex-end;gap:1.25rem;margin:.875rem 1.25rem 0;padding-top:.875rem;border-top:1px solid var(--border);transition:opacity .4s,transform .4s}
.rf-sum div{display:flex;flex-direction:column;font-size:.75rem;color:var(--muted)}
.rf-sum b{font-size:1rem;font-weight:600;color:var(--muted)}
.rf-sum div+div b{color:var(--fg)}
.rf-sum em{margin-left:auto;font-style:normal;font-size:.875rem;font-weight:600;color:var(--ok);white-space:nowrap}
.rf:not([data-s="done"]) .rf-sum{opacity:0;transform:translateY(.25rem)}
.rf-again{display:flex;align-items:center;gap:.3125rem;margin:.5rem 0 0;padding:0;border:0;background:none;font:inherit;font-weight:550;color:var(--accent);cursor:pointer}
.rf-again:hover{text-decoration:underline}
.rf-again[hidden]{display:none}
.rf-again .ic{width:.75rem;height:.75rem}
@media (max-width:420px){.rf-sum{flex-wrap:wrap}.rf-sum em{margin-left:0;width:100%}}
.rt-note{margin:.625rem 0 0;padding:0 1.25rem 1.125rem;font-size:.75rem;color:var(--muted)}

/* PnL calendar screenshot (already carries its own panel border) */
.calshot{min-width:0}
.calshot img{display:block;width:100%;height:auto;border-radius:.625rem;box-shadow:var(--shadow)}
.calshot .on-dark{display:none}.dark .calshot .on-dark{display:block}.dark .calshot .on-light{display:none}
.calshot p{margin:.75rem 0 0;text-align:center;font-size:.75rem;color:var(--muted)}

/* share-card deck: the cards stacked and fanned up-right; the top one leaves to the back */
.deck{position:relative;width:100%;max-width:34rem;justify-self:center;aspect-ratio:1200/630;margin:2.5rem 2.5rem 0 0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.deck img{position:absolute;inset:0;width:100%;height:100%;border-radius:.875rem;box-shadow:0 1px 2px rgb(0 0 0/.08),0 18px 40px -16px rgb(0 0 0/.45);transform-origin:50% 100%;transition:transform .6s cubic-bezier(.22,1,.36,1),opacity .45s ease,filter .6s ease;user-select:none;-webkit-user-drag:none}
.deck img[data-i="0"]{z-index:8;transform:none}
.deck img[data-i="1"]{z-index:7;transform:translate(4%,-7%) rotate(3deg) scale(.95);filter:brightness(.92)}
.deck img[data-i="2"]{z-index:6;transform:translate(8%,-14%) rotate(6deg) scale(.9);filter:brightness(.82)}
.deck img[data-i="3"]{z-index:5;transform:translate(11%,-19%) rotate(8deg) scale(.86);filter:brightness(.72);opacity:.9}
.deck img:not([data-i="0"]):not([data-i="1"]):not([data-i="2"]):not([data-i="3"]){z-index:1;transform:translate(11%,-19%) rotate(8deg) scale(.86);opacity:0}
.deck img.out{z-index:9;transform:translate(-18%,8%) rotate(-10deg) scale(.96);opacity:0;transition:transform .45s ease-in,opacity .45s ease-in}
.deck:hover img[data-i="0"]:not(.out){transform:translateY(-4px)}
.themes{display:flex;flex-wrap:wrap;gap:.375rem;margin-top:1.75rem}
.themes button{height:1.875rem;padding:0 .75rem;border:1px solid var(--border2);border-radius:99rem;background:var(--surface);color:var(--fg2);font:inherit;font-size:.8125rem;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.themes button:hover{border-color:color-mix(in oklab,var(--fg) 30%,var(--border2));color:var(--fg)}
.themes button[aria-pressed=true]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
#share{overflow-x:clip}
@media (max-width:640px){.deck{margin-right:1.75rem}}

.steps{display:grid;gap:2rem;counter-reset:s}
@media (min-width:860px){.steps{grid-template-columns:repeat(3,1fr);gap:2.5rem}}
.step{padding-top:1.25rem;border-top:1px solid var(--border2);counter-increment:s}
.step::before{content:counter(s,decimal-leading-zero);font-size:.8125rem;font-weight:550;color:var(--muted);font-variant-numeric:tabular-nums}
.step h3{margin:.625rem 0 0;font-size:1.0625rem;font-weight:600;letter-spacing:-.015em}
.step p{margin:.375rem 0 0;font-size:.9063rem;color:var(--muted)}

.pricing{display:grid;gap:2.5rem;align-items:start}
@media (min-width:960px){.pricing{grid-template-columns:1fr 1fr;gap:5rem}}
.pricing .sh{margin-bottom:0}
.row{display:flex;align-items:baseline;gap:1rem;padding:.875rem 1.25rem;border-top:1px solid var(--border)}
.card-h+.row{border-top:0}
.row .a{font-size:.9063rem}
.row .n{font-size:.75rem;color:var(--muted)}
.row .p{margin-left:auto;font-size:.9375rem;font-weight:600}
.row .p.free{color:var(--ok)}
.calc{padding:1.25rem;border-top:1px solid var(--border);background:var(--sunken)}
.calc h3{margin:0 0 .125rem;font-size:.875rem;font-weight:600}
.calc .sub{margin:0;font-size:.8125rem;color:var(--muted)}
.sls{display:grid;gap:.875rem 1.5rem;margin-top:1rem}
@media (min-width:520px){.sls{grid-template-columns:1fr 1fr}}
.sl{display:grid;grid-template-columns:1fr auto;gap:.375rem;font-size:.8125rem}
.sl output{font-weight:600;font-variant-numeric:tabular-nums}
.sl input{grid-column:1/-1;width:100%;margin:0;accent-color:var(--accent)}
.total{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-top:1.125rem;padding-top:1rem;border-top:1px solid var(--border)}
.total span{font-size:.8125rem;color:var(--muted)}
.total b{font-size:1.75rem;font-weight:650;letter-spacing:-.03em}
.total small{margin-left:.5rem;font-size:.75rem;color:var(--muted);font-weight:400;letter-spacing:0}
.ref{margin:1.5rem 0 0;font-size:.9063rem;color:var(--fg2)}
.ref b{color:var(--fg);font-weight:600}

.soon{display:grid;gap:1rem;align-items:center;padding:1.75rem 0;border-block:1px solid var(--border)}
@media (min-width:860px){.soon{grid-template-columns:auto 1fr;gap:2rem}}
.soon .tag{font-size:.75rem;font-weight:550;padding:.1875rem .625rem;border:1px solid var(--border2);border-radius:99rem;color:var(--muted);justify-self:start}
.soon h3{margin:0;font-size:1.0625rem;font-weight:600}
.soon p{margin:.25rem 0 0;font-size:.9063rem;color:var(--muted)}

.sec{display:grid;gap:2rem}
@media (min-width:860px){.sec{grid-template-columns:repeat(3,1fr);gap:2.5rem}}
.sec .ic{width:1.25rem;height:1.25rem}
.sec h3{margin:.875rem 0 0;font-size:.9688rem;font-weight:600}
.sec p{margin:.375rem 0 0;font-size:.875rem;color:var(--muted)}

.faqw{display:grid;gap:1rem}
@media (min-width:960px){.faqw{grid-template-columns:1fr 1.6fr;gap:5rem}}
details{border-bottom:1px solid var(--border)}
details:first-of-type{border-top:1px solid var(--border)}
summary{display:flex;align-items:center;gap:1rem;padding:1.125rem 0;cursor:pointer;list-style:none;font-weight:550;font-size:.9688rem}
summary::-webkit-details-marker{display:none}
summary::after{content:"";margin-left:auto;flex:none;width:.5rem;height:.5rem;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-2px) rotate(45deg);transition:transform .2s}
details[open] summary::after{transform:translateY(2px) rotate(-135deg)}
details p{margin:0 0 1.25rem;color:var(--muted);font-size:.9063rem}

.comm{display:grid;gap:.75rem;grid-template-columns:1fr}
@media (min-width:640px){.comm{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1000px){.comm{grid-template-columns:repeat(var(--n,3),1fr)}}
.comm a{display:flex;align-items:flex-start;gap:.875rem;padding:1.125rem 1.25rem;border:1px solid var(--border2);border-radius:.75rem;background:var(--surface);transition:border-color .15s,transform .15s,box-shadow .15s}
.comm a:hover{border-color:color-mix(in oklab,var(--fg) 30%,var(--border2));transform:translateY(-2px);box-shadow:0 10px 24px -14px rgb(0 0 0/.25)}
.comm .ib{width:2.25rem;height:2.25rem;flex:none;display:grid;place-items:center;border-radius:.5rem;background:var(--sunken);border:1px solid var(--border);color:var(--fg)}
.comm .ib .ic{width:1.125rem;height:1.125rem}
.comm b{display:block;font-size:.9375rem;font-weight:600}
.comm span{display:block;margin-top:.125rem;font-size:.8438rem;color:var(--muted);line-height:1.45}
.comm .go{margin-left:auto;width:1rem;height:1rem;color:var(--muted);flex:none}
.social{display:flex;gap:.25rem}
.social a{width:2rem;height:2rem;display:grid;place-items:center;border-radius:.375rem;color:var(--muted);transition:color .15s,background .15s}
.social a:hover{color:var(--fg);background:var(--sunken)}
.social .ic{width:1rem;height:1rem}

.final{padding:6rem 0;text-align:center}
.final h2{margin:0 auto;max-width:36rem}
.final p{margin:1rem auto 0;max-width:30rem;color:var(--fg2)}

footer{border-top:1px solid var(--border);padding:2rem 0 2.5rem;font-size:.8125rem;color:var(--muted)}
footer .wrap{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center}
footer .logo{color:var(--fg);display:flex}
footer .risk{flex-basis:100%;margin:0;font-size:.75rem;line-height:1.55;max-width:56rem}
footer nav{margin-left:auto;display:flex;gap:1.25rem}
footer nav a:hover{color:var(--fg)}

/* splash — shown on every page load (html.splash, set by the head script). html.wait holds the
   page content back; it is lifted mid-flight, while html.splash stays until the logo has landed. */
#splash{display:none}
.splash #splash{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:var(--bg);color:var(--fg);transition:opacity .35s ease,visibility 0s linear .35s,background-color .4s ease}
#splash[data-state=leaving]{opacity:0;visibility:hidden}
#splash[data-state=flying]{background-color:transparent;pointer-events:none}
#splash[data-state=flying] .sp-bar{opacity:0;transition:opacity .2s ease}
#splash .sp-logo{display:flex;align-items:center;gap:7.5px;transform-origin:center;transition:transform .62s cubic-bezier(.22,1,.36,1)}
#splash svg{display:block;fill:currentColor;overflow:visible}
#splash .sp-mark{width:61px;height:40px}
#splash .sp-word{width:152px;height:40px}
#splash .sp-arrow{animation:sp-in .55s cubic-bezier(.2,.8,.2,1) both,sp-shoot 1.6s ease-in-out .9s infinite}
#splash .sp-chev{animation:sp-pop .45s cubic-bezier(.2,.8,.2,1) .22s both,sp-pulse 1.6s ease-in-out .9s infinite}
#splash .sp-word{animation:sp-rise .5s ease .38s both}
#splash .sp-bar{position:relative;width:120px;height:2px;overflow:hidden;border-radius:2px;background:color-mix(in oklab,var(--fg) 13%,transparent)}
#splash .sp-bar span{position:absolute;inset:0 auto 0 0;width:40%;border-radius:2px;background:currentColor;animation:sp-bar 1.1s ease-in-out infinite}
@keyframes sp-in{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}
@keyframes sp-pop{from{opacity:0;transform:translateX(-6px) scale(.85)}to{opacity:1;transform:none}}
@keyframes sp-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes sp-shoot{0%,100%{transform:none}35%{transform:translateX(-4px)}55%{transform:translateX(5px)}}
@keyframes sp-pulse{0%,45%,100%{opacity:1}60%{opacity:.45}}
@keyframes sp-bar{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
/* while the splash is up the page waits; then the hero comes in, top to bottom */
.wait .hero .wrap>*,.wait .stage{opacity:0}
.enter .hero .wrap>*,.enter .stage{animation:sp-rise .6s cubic-bezier(.2,.8,.2,1) both}
.enter .hero .wrap>:nth-child(2){animation-delay:.06s}.enter .hero .wrap>:nth-child(3){animation-delay:.12s}
.enter .hero .wrap>:nth-child(4){animation-delay:.18s}.enter .hero .wrap>:nth-child(5){animation-delay:.22s}
.enter .stage{animation-delay:.3s;animation-duration:.8s}
/* the header logo welcomes with one arrow shot after the splash lands on it */
.q-arrow,.q-chev{transform-box:fill-box}
.arrive .q-arrow{animation:sp-shoot .7s ease-in-out}
.arrive .q-chev{animation:sp-pulse .7s ease-in-out}

/* phone */
.burger{display:none;width:2.25rem;padding:0}
.burger .shut,.nav.open .burger .open{display:none}.nav.open .burger .shut{display:block}
.mnav{border-top:1px solid var(--border);background:var(--bg)}
.nav .mnav .wrap{display:flex;flex-direction:column;align-items:stretch;gap:0;height:auto;padding-top:.25rem;padding-bottom:1rem}
.mnav[hidden]{display:none}
.mnav .wrap>a{padding:.8125rem 0;border-bottom:1px solid var(--border);font-size:1rem;font-weight:550;color:var(--fg)}
.mrow{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:1rem}
.mrow .btn{height:2.75rem}
.btn.outline .sun,.btn.outline .moon{width:1rem;height:1rem}
.mrow .moon,.dark .mrow .sun{display:none}.dark .mrow .moon{display:block}
@media (max-width:859px){
  .burger{display:inline-flex}
  .nav .theme,.nav .signin{display:none}
  .nav.open{border-bottom-color:var(--border)}
}
@media (max-width:640px){
  section{padding:3.75rem 0}
  .sh{margin-bottom:2rem}
  .hero{padding-top:2.75rem}
  .lead{font-size:1.0625rem}
  .cta .btn{flex:1 1 9rem}
  .stage{margin-top:2.75rem;padding-bottom:3rem}
  .stage::before{inset:4rem 0 0}
  /* the full dashboard is unreadable at phone width: show its working area (summary cards and
     growth chart) larger, fading out on the right */
  .shot{aspect-ratio:1.3;-webkit-mask-image:linear-gradient(90deg,#000 86%,transparent);mask-image:linear-gradient(90deg,#000 86%,transparent)}
  .shot img{width:175%;max-width:none;margin-left:-26.25%}
  .logos{padding:2rem 0}
  .logos .wrap{gap:.875rem 1.5rem}
  /* features and security: icon beside the text, so eight items don't become a long column */
  .feats{gap:1.5rem}
  .feat,.sec>div{display:grid;grid-template-columns:2.5rem 1fr;column-gap:.875rem;align-items:start}
  .feat .ic,.sec .ic{grid-row:span 2;width:2.5rem;height:2.5rem;padding:.625rem;border:1px solid var(--border);border-radius:.625rem;background:var(--sunken)}
  .feat h3,.sec h3{margin:.125rem 0 0}
  .sec{gap:1.5rem}
  .deck{width:calc(100% - 2.75rem);margin:2rem auto 0 0}
  .duo{gap:2.25rem}
  .final{padding:4rem 0}
  footer .wrap{gap:1rem 1.5rem}
  footer nav{margin-left:0;flex-basis:100%;flex-wrap:wrap;gap:.75rem 1.25rem}
}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}#splash .sp-bar span{width:100%;opacity:.5}}
`;

// `register`: whether /register is reachable (the sign-up link is hidden otherwise).
// `lang`: 'en' | 'id'; anything else falls back to English.
// `links`: config.json landing.links ({ telegramChannel, telegramGroup, x, discord, email }).
const LANDING_PAGE = ({ register = true, lang = DEFAULT_LANG, links = {} } = {}) => {
  if (!LANGS.includes(lang)) lang = DEFAULT_LANG;
  const community = safeLinks(links);
  const ext = (href) => (href.startsWith('mailto:') ? '' : ' target="_blank" rel="noopener"');
  const c = COPY[lang]; const a = c.app;
  const fmt4 = (v) => new Intl.NumberFormat(c.locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(v);
  // Same-page anchors keep the language; links to other pages don't need it.
  const signup = (cls) => (register ? `<a class="btn primary ${cls}" href="/register">${c.createAccount} ${icon('arrow')}</a>` : '');
  const logo = ([img, name]) => `<span class="logo-i"><img src="/${img}" alt="" width="22" height="22" loading="lazy">${esc(name)}</span>`;
  const sh = (s) => `<div class="k">${s.k}</div><h2>${s.h}</h2>${s.p ? `<p>${s.p}</p>` : ''}`;
  const ticks = (list) => `<ul class="ticks">${list.map((t) => `<li>${icon('check')}${t}</li>`).join('')}</ul>`;
  const SECTIONS = ['fitur', 'otomasi', 'biaya', 'faq'];
  return `<!doctype html><html lang="${lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${c.title}</title>
<meta name="description" content="${esc(c.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" hreflang="en" href="/?lang=en"><link rel="alternate" hreflang="id" href="/?lang=id">
<script>(function(){
  var q=new URLSearchParams(location.search).get('lang');
  try{
    if(q==='en'||q==='id')localStorage.setItem('lpcopy-lang',q);
    else if(localStorage.getItem('lpcopy-lang')==='id'&&'${lang}'!=='id'){location.replace('/?lang=id'+location.hash);return}
    document.documentElement.classList.add('splash','wait');
    var t=localStorage.getItem('lpcopy-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark');
  }catch(e){}
})()</script>
<style>${CSS}</style></head>
<body>
${SPLASH}
<header class="nav" id="nav"><div class="wrap">
  <a class="logo" href="/?lang=${lang}" aria-label="Quiver">${LOGO(19)}</a>
  <nav class="links" aria-label="${c.nav.join(', ')}">${c.nav.map((l, i) => `<a href="#${SECTIONS[i]}">${l}</a>`).join('')}</nav>
  <div class="right">
    <span class="lang" role="group" aria-label="${c.langLabel}">${LANGS.map((l) => `<a href="/?lang=${l}" hreflang="${l}"${l === lang ? ' aria-current="true"' : ''}>${l.toUpperCase()}</a>`).join('')}</span>
    <button class="btn ghost theme" id="theme" type="button" aria-label="${c.themeLabel}">${icon('sun', 'ic sun')}${icon('moon', 'ic moon')}</button>
    <a class="btn ghost signin" href="/login">${c.signIn}</a>
    ${register ? `<a class="btn primary" href="/register">${c.signUp}</a>` : ''}
    <button class="btn ghost burger" id="burger" type="button" aria-label="${c.menuLabel}" aria-expanded="false" aria-controls="mnav">${icon('menu', 'ic open')}${icon('close', 'ic shut')}</button>
  </div>
</div>
<div class="mnav" id="mnav" hidden><div class="wrap">
  ${c.nav.map((l, i) => `<a href="#${SECTIONS[i]}">${l}</a>`).join('')}
  <div class="mrow"><a class="btn outline" href="/login">${c.signIn}</a><button class="btn outline" id="theme2" type="button">${icon('sun', 'ic sun')}${icon('moon', 'ic moon')}${c.themeShort}</button></div>
</div></div></header>

<main>
<div class="hero"><div class="wrap">
  <span class="kicker"><span class="stack" aria-hidden="true">${CHAINS.slice(0, 6).map(([img]) => `<img src="/${img}" alt="" width="20" height="20">`).join('')}</span>${c.kicker}</span>
  <h1>${c.h1}</h1>
  <p class="lead">${c.lead}</p>
  <div class="cta">${signup('lg')}<a class="btn outline lg" href="#fitur">${c.explore}</a></div>
  ${register ? `<p class="fine">${c.inviteOnly}</p>` : ''}
</div>

<div class="stage"><div class="wrap">
  <div class="shot">
    <img class="on-light" src="/landing-overview-${lang}-light.webp" alt="${a.alt}" width="2880" height="1270">
    <img class="on-dark" src="/landing-overview-${lang}-dark.webp" alt="${a.alt}" width="2880" height="1270" loading="lazy">
  </div>
  <p class="stage-note">${a.note}</p>
</div></div>
</div>

<div class="logos"><div class="wrap">
  <span class="lbl">${c.logos}</span>
  ${CHAINS.map(logo).join('')}
</div></div>

<section id="fitur"><div class="wrap">
  <div class="sh">${sh(c.features)}</div>
  <div class="feats">${c.features.items.map(([t, d], i) => `<div class="feat">${icon(FEATURE_ICONS[i])}<h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
</div></section>

<section id="otomasi" class="band2"><div class="wrap duo">
  <div class="sh">${sh(c.automation)}${ticks(c.automation.ticks)}</div>
  <div class="card">
    <div class="card-h">${c.automation.card} <span>${c.automation.example}</span></div>
    ${c.automation.rules.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('')}
  </div>
</div></section>

<section id="rute"><div class="wrap duo">
  <div class="sh">${sh(c.routing)}${ticks(c.routing.ticks)}</div>
  <div class="card first rf" id="rf" data-s="done">
    <div class="card-h">${c.routing.card} <span>${c.routing.where}</span></div>
    <div class="rf-bar"><i></i></div>
    <div class="rf-top"><b>${c.routing.swap}</b><span class="rf-st" id="rf-st" data-scan="${esc(c.routing.scanning.replace('{0}', ROUTES.length))}">${c.routing.done.replace('{0}', ROUTES.filter((r) => r[3]).length).replace('{1}', ROUTES.length)}</span></div>
    <div class="ags">${ROUTES.map(([img, name, ms, out], i) => `<div class="ag${out ? '' : ' na'}${i === bestRoute ? ' best' : ''}" data-i="${i}" data-ms="${ms || ''}" data-out="${out || ''}" style="order:${routeRank[i]}">
      <img src="/${img}" alt="" width="24" height="24" loading="lazy"><div class="nm"><b>${name}${i === bestRoute ? `<em>${c.routing.best}</em>` : ''}</b><span>${ms ? `${ms} ms` : c.routing.noQuote}${img === 'uniswap.png' ? ` · ${c.routing.single}` : ''}</span></div>
      <span class="q num"><i class="sk"></i><span class="v">${out ? fmt4(out) : '—'}</span></span>
    </div>`).join('')}</div>
    <div class="rf-sum"><div><span>${c.routing.sum[0]}</span><b class="num">${fmt4(ROUTES.find((r) => r[0] === 'uniswap.png')[3])}</b></div><div><span>${c.routing.sum[1]}</span><b class="num">${fmt4(ROUTES[bestRoute][3])}</b></div><em>${c.routing.gain}</em></div>
    <p class="rt-note">${c.routing.note}<button type="button" class="rf-again" id="rf-again" hidden>${icon('refresh')}${c.routing.replay}</button></p>
  </div>
</div></section>

<section class="band2"><div class="wrap duo">
  <div class="sh">${sh(c.alerts)}</div>
  <div class="card first">
    <div class="card-h">Quiver Bot <span>Telegram</span></div>
    ${c.alerts.items.map(([t, d, time], i) => `<div class="notif"><span class="li">${icon(NOTIF_ICONS[i])}</span><div><b>${t}</b><span>${d}</span></div><time>${time}</time></div>`).join('')}
  </div>
</div></section>

<section id="kalender"><div class="wrap duo">
  <div class="sh">${sh(c.calendar)}${ticks(c.calendar.ticks)}</div>
  <div class="calshot first">
    <img class="on-light" src="/landing-calendar-${lang}-light.webp" alt="${c.calendar.alt}" width="1396" height="920" loading="lazy" decoding="async">
    <img class="on-dark" src="/landing-calendar-${lang}-dark.webp" alt="${c.calendar.alt}" width="1396" height="920" loading="lazy" decoding="async">
    <p>${c.calendar.note}</p>
  </div>
</div></section>

<section id="share" class="band2"><div class="wrap duo">
  <div class="sh">${sh(c.share)}${ticks(c.share.ticks)}
    <div class="themes" role="group" aria-label="${c.share.deck}">${SHARE_THEMES.map((t, i) => `<button type="button" data-theme="${t}" aria-pressed="${i === 0}">${c.share.themes[t]}</button>`).join('')}</div>
  </div>
  <div class="deck first" id="deck" role="button" tabindex="0" aria-label="${c.share.next}">${SHARE_THEMES.map((t, i) => `<img src="/share-${t}-${lang}.webp" alt="${c.share.alt.replace('{0}', c.share.themes[t])}" width="1200" height="630" data-theme="${t}" data-i="${i}" loading="lazy" decoding="async" draggable="false">`).join('')}</div>
</div></section>

<section><div class="wrap">
  <div class="sh">${sh(c.steps)}</div>
  <div class="steps">${c.steps.items.map(([t, d]) => `<div class="step"><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
</div></section>

<section id="biaya" class="band2"><div class="wrap pricing">
  <div class="sh">${sh(c.pricing)}${ticks(c.pricing.ticks)}<p class="ref">${c.pricing.referral}</p></div>
  <div class="card">
    <div class="card-h">${c.pricing.card} <span>${c.pricing.per}</span></div>
    ${c.pricing.rows.map(([label, note], i) => {
      const price = FEE_PRICES[i];
      return `<div class="row"><span class="a">${label}</span>${note ? `<span class="n">${note}</span>` : ''}<span class="p num${price ? '' : ' free'}">${price || c.pricing.free}</span></div>`;
    }).join('')}
    <div class="calc">
      <h3>${c.pricing.calcH}</h3><p class="sub">${c.pricing.calcSub}</p>
      <div class="sls">${[['pos', 100, 20]].map(([k, max, v], i) => `<div class="sl"><label for="c-${k}">${c.pricing.sliders[i]}</label><output id="o-${k}">${v}</output><input type="range" id="c-${k}" min="0" max="${max}" value="${v}"></div>`).join('')}</div>
      <div class="total"><span>${c.pricing.month}</span><b class="num"><span id="total"></span><small id="per"></small></b></div>
    </div>
  </div>
</div></section>

<div class="wrap"><div class="soon">
  <span class="tag">${c.soon.tag}</span>
  <div><h3>${c.soon.h}</h3><p>${c.soon.p}</p></div>
</div></div>

<section><div class="wrap">
  <div class="sh">${sh(c.security)}</div>
  <div class="sec">${c.security.items.map(([t, d], i) => `<div>${icon(['lock', 'key', 'eye'][i])}<h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
</div></section>

<section id="faq" class="band2"><div class="wrap faqw">
  <div class="sh">${sh(c.faq)}</div>
  <div>${c.faq.items.map(([q, ans]) => `<details><summary>${q}</summary><p>${ans}</p></details>`).join('')}</div>
</div></section>

${community.length ? `<section id="komunitas"><div class="wrap">
  <div class="sh">${sh(c.community)}</div>
  <div class="comm" style="--n:${community.length === 4 ? 2 : Math.min(community.length, 3)}">${community.map(([k, href]) => `<a href="${esc(href)}"${ext(href)}><span class="ib">${LINK_ICON[k]()}</span><div><b>${c.community.items[k][0]}</b><span>${c.community.items[k][1]}</span></div>${icon('external', 'ic go')}</a>`).join('')}</div>
</div></section>
` : ''}<div class="final"><div class="wrap">
  <h2>${c.final.h}</h2>
  <p>${c.final.p}</p>
  <div class="cta">${signup('lg')}<a class="btn outline lg" href="/login">${c.signIn}</a></div>
</div></div>
</main>

<footer><div class="wrap">
  <a class="logo" href="/?lang=${lang}" aria-label="Quiver">${LOGO(15)}</a>
  <span>© ${new Date().getFullYear()} Quiver</span>
  ${community.length ? `<span class="social">${community.map(([k, href]) => `<a href="${esc(href)}"${ext(href)} aria-label="${c.community.items[k][0]}" title="${c.community.items[k][0]}">${LINK_ICON[k]()}</a>`).join('')}</span>` : ''}
  <nav aria-label="Footer">${c.footerNav.map((l, i) => `<a href="${['#fitur', '#biaya', '#faq', '/login'][i]}">${l}</a>`).join('')}</nav>
  <p class="risk">${c.risk}</p>
</div></footer>

<script>
(function(){
  var $=function(s){return document.querySelector(s)};
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fmt2=new Intl.NumberFormat('${c.locale}',{minimumFractionDigits:2,maximumFractionDigits:2});

  // Splash: same exit as the dashboard (web/src/splash.js) — the logo settles, then flies and
  // shrinks onto the header logo while the background fades; the header arrow then shoots once.
  (function(){
    var root=document.documentElement,el=document.getElementById('splash');
    if(!root.classList.contains('splash')||!el){if(el)el.remove();root.classList.remove('splash','wait');return}
    var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
    var enter=function(){if(!root.classList.contains('wait'))return;root.classList.add('enter');root.classList.remove('wait');setTimeout(function(){root.classList.remove('enter')},1400)};
    var done=false;
    var finish=function(target){
      if(done)return;done=true;enter();
      if(target){target.style.visibility='';var a=target.closest('a');if(a){a.classList.add('arrive');setTimeout(function(){a.classList.remove('arrive')},900)}}
      el.remove();root.classList.remove('splash');
    };
    var fly=function(){
      var logo=el.querySelector('.sp-logo'),target=document.querySelector('#nav .logo svg');
      if(!logo||!target||reduce||document.hidden)return false;
      Array.prototype.forEach.call(logo.querySelectorAll('svg, path'),function(n){
        var cs=getComputedStyle(n),tf=cs.transform;
        n.style.animation='none';n.style.transform=tf==='none'?'':tf;n.style.opacity=cs.opacity;
        n.getBoundingClientRect();n.style.transition='transform .25s ease, opacity .25s ease';n.style.transform='';n.style.opacity='1';
      });
      var a=logo.getBoundingClientRect(),b=target.getBoundingClientRect();
      var scale=b.width/a.width,dx=b.left+b.width/2-(a.left+a.width/2),dy=b.top+b.height/2-(a.top+a.height/2);
      target.style.visibility='hidden';
      el.dataset.state='flying';
      logo.style.transform='translate('+dx+'px,'+dy+'px) scale('+scale+')';
      setTimeout(enter,360);
      logo.addEventListener('transitionend',function(e){if(e.target===logo&&e.propertyName==='transform')finish(target)});
      setTimeout(function(){finish(target)},1000);
      return true;
    };
    var closing=false;
    var close=function(){
      if(closing)return;closing=true;
      setTimeout(function(){
        if(fly())return;
        el.dataset.state='leaving';
        setTimeout(function(){finish(null)},400);
      },Math.max(0,1500-performance.now()));
    };
    if(document.readyState==='complete')close();else window.addEventListener('load',close);
    setTimeout(close,5000);
  })();

  var nav=$('#nav');
  function onScroll(){nav.classList.toggle('scrolled',window.scrollY>8)}
  onScroll();window.addEventListener('scroll',onScroll,{passive:true});
  var toggleTheme=function(){
    var d=document.documentElement.classList.toggle('dark');
    try{localStorage.setItem('lpcopy-theme',d?'dark':'light')}catch(e){}
  };
  $('#theme').addEventListener('click',toggleTheme);
  $('#theme2').addEventListener('click',toggleTheme);

  // Phone menu: the section links, sign-in and theme live in a panel under the bar.
  (function(){
    var btn=$('#burger'),panel=$('#mnav');
    var set=function(open){btn.setAttribute('aria-expanded',open);panel.hidden=!open;nav.classList.toggle('open',open)};
    btn.addEventListener('click',function(){set(panel.hidden)});
    Array.prototype.forEach.call(panel.querySelectorAll('a'),function(a){a.addEventListener('click',function(){set(false)})});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)});
    window.addEventListener('resize',function(){if(innerWidth>=860)set(false)});
  })();

  // Share-card deck: click (or Enter/Space) sends the top card to the back; the theme chips bring
  // one to the front; it also turns on its own every few seconds while on screen.
  (function(){
    var deck=$('#deck');if(!deck)return;
    var cards=Array.prototype.slice.call(deck.querySelectorAll('img')),chips=Array.prototype.slice.call(document.querySelectorAll('.themes button'));
    var order=cards.slice(),busy=false,timer=0,visible=false;
    var layout=function(){order.forEach(function(c,i){c.setAttribute('data-i',i)});var top=order[0].getAttribute('data-theme');chips.forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-theme')===top)})};
    var next=function(){
      if(busy)return;busy=true;var top=order[0];top.classList.add('out');
      setTimeout(function(){order.push(order.shift());top.classList.remove('out');layout();busy=false},430);
    };
    var bring=function(theme){
      var i=order.findIndex(function(c){return c.getAttribute('data-theme')===theme});
      if(i<=0)return;order=order.slice(i).concat(order.slice(0,i));layout();
    };
    var auto=function(){clearInterval(timer);if(!reduce&&visible)timer=setInterval(next,3200)};
    deck.addEventListener('click',function(){next();auto()});
    deck.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();next();auto()}});
    deck.addEventListener('mouseenter',function(){clearInterval(timer)});
    deck.addEventListener('mouseleave',auto);
    chips.forEach(function(b){b.addEventListener('click',function(){bring(b.getAttribute('data-theme'));auto()})});
    if('IntersectionObserver' in window)new IntersectionObserver(function(es){visible=es[0].isIntersecting;auto()}).observe(deck);
  })();

  // Route finder: once in view, every aggregator "quotes" in step with its measured response time,
  // the rows re-sort by output (FLIP), then the best one and the comparison are revealed.
  (function(){
    var rf=$('#rf');if(!rf||reduce||!('IntersectionObserver' in window))return;
    var rows=Array.prototype.slice.call(rf.querySelectorAll('.ag')),st=$('#rf-st'),doneText=st.textContent,timers=[];
    var rank=rows.map(function(r){return r.style.order});
    var flip=function(apply){
      var a=rows.map(function(r){return r.getBoundingClientRect().top});
      apply();
      rows.forEach(function(r,i){
        var d=a[i]-r.getBoundingClientRect().top;if(!d)return;
        r.style.transition='none';r.style.transform='translateY('+d+'px)';r.getBoundingClientRect();
        r.style.transition='transform .5s cubic-bezier(.2,.7,.2,1), border-color .3s, background-color .3s, opacity .3s';r.style.transform='';
      });
    };
    var at=function(ms,fn){timers.push(setTimeout(fn,ms))};
    // Waiting state (engine order, values hidden) until the card is scrolled into view.
    var reset=function(){rf.setAttribute('data-s','idle');flip(function(){rows.forEach(function(r,i){r.classList.remove('got');r.style.order=i})})};
    var run=function(){
      timers.forEach(clearTimeout);timers=[];
      reset();rf.getBoundingClientRect();
      rf.setAttribute('data-s','scan');st.textContent=st.getAttribute('data-scan');
      rows.forEach(function(r){var ms=+r.getAttribute('data-ms');at(ms?380+ms*2:1250,function(){r.classList.add('got')})});
      at(2100,function(){rf.setAttribute('data-s','sort');flip(function(){rows.forEach(function(r,i){r.style.order=rank[i]})})});
      at(2700,function(){rf.setAttribute('data-s','done');st.textContent=doneText});
    };
    reset();$('#rf-again').hidden=false;
    var seen=false;
    new IntersectionObserver(function(es){if(es[0].isIntersecting&&!seen){seen=true;run()}},{threshold:.45}).observe(rf);
    $('#rf-again').addEventListener('click',run);
  })();

  // Fee calculator (same numbers as the fee table; an open and its close counted together).
  var F={pos:.40},PER=${JSON.stringify(c.pricing.perPos)};
  var calc=function(){
    var sum=0,n=0;
    Object.keys(F).forEach(function(k){var v=+$('#c-'+k).value;$('#o-'+k).textContent=v;sum+=v*F[k];if(k==='pos')n=v});
    $('#total').textContent='$'+fmt2.format(sum);
    $('#per').textContent=n?'≈ $'+fmt2.format(sum/n)+' '+PER:'';
  };
  Object.keys(F).forEach(function(k){$('#c-'+k).addEventListener('input',calc)});calc();
})();
</script>
</body></html>`;
};

module.exports = { LANDING_PAGE };
