'use strict';
// Multi-chain config: one config.json, one process, many chains.
//
// Config shape:
//   {
//     "wallet": {...}, "server": {...}, "telegram": {...}, "db": {...}, "notify": {...},   <- global
//     "chains": {
//       "robinhood": { "enabled": true, "chain": {endpoints…}, "targets": [], "rules": {}, "mode": {}, "gas": {}, "prices": {}, "loop": {}, "scout": {}, "risk": {}, "swap": {} },
//       "bsc":       { ... }
//     }
//   }
//
// An old config (a single chain, those fields at the top level) is normalised automatically on
// load: its contents are moved to chains.robinhood — no manual migration is needed on each
// PM2 instance.
//
// The engine, server, and Telegram bot do not read `chains` directly. Each one
// receives a per-chain "view" (chainView): a Proxy object that reads/writes per-chain fields
// to chains.<name> and other fields to the parent config. So existing code
// (`cfg.rules`, `cfg.mode.dry_run = …`, `cfg.chain.endpoints`) keeps working as
// it is, and writeCfg(view) still writes the complete parent config.
const { NETWORKS, build } = require('./networks');

const PER_CHAIN = ['chain', 'targets', 'rules', 'mode', 'gas', 'prices', 'loop', 'scout', 'risk', 'swap'];
const PRIMARY = 'robinhood';

// Default BSC block: simulation, no targets, public RPC. Tested 2026-09-19 from the VPS:
//   - bsc.rpc.blxrbdn.com (bloXroute) & rpc-bsc.48.club: getLogs max 5000 blocks, batch OK,
//     old history readable — the backbone of scanning
//   - bsc-rpc.publicnode.com: fast eth_call, getLogs only a few recent blocks
//   - bsc-dataseed.bnbchain.org (official): eth_call/send tx, getLogs always "limit exceeded"
// Alchemy (bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}) can be added from the
// Settings page after the BNB network is enabled for that app in the Alchemy dashboard.
function bscTemplate() {
  return {
    enabled: true,
    chain: {
      endpoints: [
        { url: 'https://bsc.rpc.blxrbdn.com', max_batch: 20, max_log_blocks: 5000, catatan: 'bloXroute publik: getLogs maks 5000 blok, riwayat lama terbaca' },
        { url: 'https://rpc-bsc.48.club', max_batch: 20, max_log_blocks: 5000, catatan: '48Club publik: getLogs maks 5000 blok' },
        { url: 'https://bsc-rpc.publicnode.com', max_batch: 20, no_logs: true, catatan: 'publicnode: eth_call cepat; getLogs ditolak di luar blok terbaru' },
        { url: 'https://bsc-dataseed.bnbchain.org', max_batch: 20, no_logs: true, catatan: 'resmi BNB Chain: eth_call & siaran tx; getLogs selalu limit exceeded' },
      ],
      max_inflight: 3,
      dns_over_https: false,
    },
    targets: [],
    rules: {
      filters: { quote_whitelist: [], venues: ['v4', 'v3', 'pancakev3'] },
    },
    mode: { dry_run: true, paused: false },
    // ~0.75 seconds per block: 1500 blocks ≈ 19 minutes per catch-up chunk; 3 second poll
    // adopt_blocks: the wallet position scan window at start (~2 days); follow-up
    // scans only cover new blocks. Without this limit = the whole history, 24 thousand
    // 5000-block getLogs calls on BSC.
    loop: { poll_ms: 3000, max_block_span: 1500, sync_seconds: 30, equity_seconds: 300, stale_action_seconds: 300, adopt_blocks: 250_000 },
    // BSC gas ~0.1–1 gwei; reserve 0.005 BNB. legacyGasPricing (networks.js) makes
    // tip = gas price, so priority_wei here is not used on BSC.
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 5_000_000_000_000_000, max_fee_gwei: 20, topup_max_usd: 25 },
    // BNB price is automatic from the PancakeSwap v3 USDT/WBNB pool (networks.js); eth_usd = fallback.
    prices: { eth_usd: 750, auto_eth_price: true },
    scout: { blocks: 120_000 },
    risk: { max_daily_drawdown_pct: 0 },
    swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 },
    catatan: 'Blok BSC dibuat otomatis: mode simulasi, belum ada target. Tambah target lewat dasbor/Telegram (pilih chain BSC), lalu matikan simulasi kalau sudah yakin.',
  };
}

// Default Solana block: OFF (enabled:false) until a proper RPC is filled in.
// The official public endpoint (api.mainnet-beta) serves the getProgramAccounts used to
// enumerate DLMM positions, but is hard rate-limited (429 per method); publicnode refuses
// getProgramAccounts (410) and some other calls (403). For real use put a keyed RPC
// FIRST in the endpoint list, e.g.
//   { "url": "https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}" }  (HELIUS_KEY in .env)
// Not in the template: a ${VAR} missing from .env triggers a warning on every start.
// Solana default rules: venues meteora/orca/raydium, quotes USDC/USDT/SOL.
function solanaTemplate() {
  return {
    enabled: false,
    chain: {
      endpoints: [
        { url: 'https://api.mainnet-beta.solana.com', catatan: 'resmi: getProgramAccounts OK tapi 429 cepat; cadangan' },
        { url: 'https://solana-rpc.publicnode.com', no_gpa: true, no_history: true, catatan: 'publicnode: cepat untuk baca akun; getProgramAccounts ditolak (410), riwayat tanda tangan kosong untuk wallet yang tidak baru aktif' },
      ],
    },
    targets: [],
    rules: {
      filters: { quote_whitelist: [], venues: ['meteora', 'orca', 'raydium'], max_fee_bps: 100000 },
      sizing: { mode: 'fixed_quote', fixed_quote_usd: 10, fixed_quote_eth: 0.1, min_quote_usd: 5, max_quote_per_position_usd: 25, max_total_exposure_usd: 100, daily_budget_usd: 100 },
      swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 },
    },
    mode: { dry_run: true, paused: false },
    // poll 4 s: each round = 1 getSignaturesForAddress per target; positions are re-listed
    // only when the target has new signatures (or every 10 minutes).
    loop: { poll_ms: 4000, sync_seconds: 30, equity_seconds: 300, stale_action_seconds: 180 },
    // 0.15 SOL reserve: DLMM position account rent (~0.057 SOL, refunded on close) + ATA +
    // fees. The compute price (priority fee) is clamped to min/max microLamports per CU.
    gas: { native_reserve_lamports: 150_000_000, min_cu_price_micro: 10_000, max_cu_price_micro: 2_000_000, price_multiplier: 1.2, jupiter_max_priority_lamports: 2_000_000, topup_max_usd: 25 },
    prices: { eth_usd: 150, auto_eth_price: true },
    scout: {},
    risk: { max_daily_drawdown_pct: 0 },
    swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 },
    catatan: 'Blok Solana dibuat otomatis dalam keadaan MATI. Tambah RPC berkunci di urutan pertama (mis. https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}, HELIUS_KEY di .env), isi LPCOPY_SOLANA_PRIVATE_KEY di .env, set enabled:true, tambah target, lalu matikan simulasi kalau sudah yakin.',
  };
}

// Defaults for the Uniswap-only chains added 2026-10-08. Public RPCs tested from the VPS
// side on 2026-10-08 (eth_getLogs probes): the limits below are what each one served.
//   - publicnode: getLogs up to 5000+ blocks but only recent history (old ranges need a token),
//     except Polygon where it also serves old ranges
//   - mainnet.base.org: 500-block getLogs, old history readable
//   - arb1.arbitrum.io / mainnet.optimism.io / api.avax.network: 10000-block getLogs (5000 on
//     Avalanche is the safe size), old history readable
// Ethereum has no free archive getLogs endpoint, so history older than a few days needs an
// Alchemy key (added from Settings once the network is enabled for the app).
const EP = (url, extra = {}) => ({ url, max_batch: 20, ...extra });
const CHAIN_DEFAULTS = {
  ethereum: {
    endpoints: [EP('https://ethereum-rpc.publicnode.com', { max_log_blocks: 5000, catatan: 'publicnode: getLogs 5000 blok, hanya riwayat terbaru' })],
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 10_000_000_000_000_000, max_fee_gwei: 60, topup_max_usd: 25 },
    ethUsd: 2570,
    // publicnode serves getLogs only ~1.5 days back (probed 2026-10-10: 10000 blocks ok, ~14000 refused);
    // the default 2-day scan windows ended in "Archive requests require a personal token".
    historyBlocks: 7200,
  },
  base: {
    endpoints: [
      EP('https://base-rpc.publicnode.com', { max_log_blocks: 5000, catatan: 'publicnode: getLogs 5000 blok, hanya riwayat terbaru' }),
      EP('https://mainnet.base.org', { max_log_blocks: 500, catatan: 'resmi Base: getLogs maks 500 blok, riwayat lama terbaca' }),
    ],
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 2_000_000_000_000_000, max_fee_gwei: 5, topup_max_usd: 25 },
    ethUsd: 2570,
  },
  arbitrum: {
    endpoints: [EP('https://arb1.arbitrum.io/rpc', { max_log_blocks: 10000, catatan: 'resmi Arbitrum: getLogs 10000 blok, riwayat lama terbaca' })],
    gas: { price_multiplier: 1.3, priority_wei: 0, max_gas_limit: 20_000_000, native_reserve_wei: 2_000_000_000_000_000, max_fee_gwei: 5, topup_max_usd: 25 },
    ethUsd: 2570,
  },
  optimism: {
    endpoints: [
      EP('https://mainnet.optimism.io', { max_log_blocks: 10000, catatan: 'resmi Optimism: getLogs 10000 blok, riwayat lama terbaca' }),
      EP('https://optimism-rpc.publicnode.com', { max_log_blocks: 5000, catatan: 'publicnode: getLogs 5000 blok, hanya riwayat terbaru' }),
    ],
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 2_000_000_000_000_000, max_fee_gwei: 5, topup_max_usd: 25 },
    ethUsd: 2570,
  },
  polygon: {
    endpoints: [EP('https://polygon-bor-rpc.publicnode.com', { max_log_blocks: 5000, catatan: 'publicnode: getLogs 5000 blok, riwayat lama terbaca' })],
    // Polygon enforces a ~25 gwei minimum priority fee.
    gas: { price_multiplier: 1.3, priority_wei: 30_000_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 5_000_000_000_000_000_000, max_fee_gwei: 500, topup_max_usd: 25 },
    ethUsd: 0.1,
  },
  avalanche: {
    endpoints: [
      EP('https://api.avax.network/ext/bc/C/rpc', { max_log_blocks: 5000, catatan: 'resmi Avalanche: getLogs 5000 blok, riwayat lama terbaca' }),
      EP('https://avalanche-c-chain-rpc.publicnode.com', { max_log_blocks: 5000, catatan: 'publicnode: getLogs 5000 blok, hanya riwayat terbaru' }),
    ],
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 200_000_000_000_000_000, max_fee_gwei: 60, topup_max_usd: 25 },
    ethUsd: 11,
  },
};

// Default block for a Uniswap-only chain: simulation, no targets, the public RPCs above.
// Loop timing is derived from the block time: ~20 minutes of blocks per catch-up chunk
// (capped at 4500 blocks so one getLogs fits every endpoint), wallet adoption and scout
// windows of ~2 days (capped at 300k blocks).
function uniswapTemplate(key) {
  const d = CHAIN_DEFAULTS[key];
  const { label, blockMs, nativeSymbol } = build(key);
  const span = Math.max(50, Math.min(4500, Math.round(1_200_000 / blockMs)));
  const twoDays = Math.min(300_000, Math.round(172_800_000 / blockMs), d.historyBlocks ?? Infinity);
  return {
    enabled: false,
    chain: { endpoints: d.endpoints.map((e) => ({ ...e })), max_inflight: 3, dns_over_https: false },
    targets: [],
    rules: { filters: { quote_whitelist: [], venues: ['v4', 'v3'] } },
    mode: { dry_run: true, paused: false },
    loop: { poll_ms: Math.max(3000, blockMs), max_block_span: span, sync_seconds: 30, equity_seconds: 300, stale_action_seconds: 300, adopt_blocks: twoDays },
    gas: { ...d.gas },
    // Native price is automatic from the Uniswap v3 USDC/wrapped-native pools (networks.js); eth_usd = fallback.
    prices: { eth_usd: d.ethUsd, auto_eth_price: true },
    scout: { blocks: twoDays },
    risk: { max_daily_drawdown_pct: 0 },
    swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 },
    catatan: `Blok ${label} dibuat otomatis: nonaktif, mode simulasi, belum ada target. Aktifkan lewat Pengaturan (harga cadangan ${nativeSymbol} dan RPC bisa disesuaikan), tambah target, lalu matikan simulasi kalau sudah yakin.`,
  };
}

// Default config block for any chain except Robinhood (which is the primary and always exists).
function chainTemplate(key) {
  if (key === 'bsc') return bscTemplate();
  if (key === 'solana') return solanaTemplate();
  if (CHAIN_DEFAULTS[key]) return uniswapTemplate(key);
  return null;
}

// Old config -> chains shape. Mutates the object in place; returns a list of
// notes (for the log) about what was normalised.
function normalizeCfg(cfg) {
  const notes = [];
  if (!cfg.chains || typeof cfg.chains !== 'object') {
    cfg.chains = { [PRIMARY]: {} };
    for (const k of PER_CHAIN) {
      if (cfg[k] !== undefined) { cfg.chains[PRIMARY][k] = cfg[k]; delete cfg[k]; }
    }
    cfg.chains[PRIMARY].enabled = true;
    notes.push(`config satu-chain dipindah ke chains.${PRIMARY}`);
  }
  for (const k of PER_CHAIN) if (cfg[k] !== undefined) { delete cfg[k]; notes.push(`kolom ${k} di tingkat atas dibuang (sudah per chain)`); }
  if (!cfg.chains.bsc) { cfg.chains.bsc = bscTemplate(); notes.push('blok chains.bsc dibuat (simulasi, tanpa target)'); }
  if (!cfg.chains.solana) { cfg.chains.solana = solanaTemplate(); notes.push('blok chains.solana dibuat (MATI, simulasi, tanpa target)'); }
  // Newer chains are created disabled: no extra engine (RAM, RPC) until someone enables them.
  for (const key of Object.keys(CHAIN_DEFAULTS)) {
    if (!cfg.chains[key]) { cfg.chains[key] = uniswapTemplate(key); notes.push(`blok chains.${key} dibuat (nonaktif, simulasi, tanpa target)`); }
  }
  for (const [key, c] of Object.entries(cfg.chains)) {
    if (!NETWORKS[key]) throw new Error(`config.chains.${key}: jaringan tidak dikenal (yang ada: ${Object.keys(NETWORKS).join(', ')})`);
    c.chain = c.chain && typeof c.chain === 'object' ? c.chain : { endpoints: [] };
    c.chain.endpoints = Array.isArray(c.chain.endpoints) ? c.chain.endpoints : [];
    c.targets = Array.isArray(c.targets) ? c.targets : [];
    for (const k of ['rules', 'mode', 'gas', 'prices', 'loop', 'scout', 'risk', 'swap']) if (!c[k] || typeof c[k] !== 'object') c[k] = {};
    if (c.enabled === undefined) c.enabled = true;
  }
  return notes;
}

// Per-chain view. Per-chain keys are read/written to cfg.chains[key], the rest to
// cfg. `network` = the chain's name. JSON.stringify(view) = the parent config (for writeCfg).
function chainView(cfg, key) {
  if (!cfg.chains?.[key]) throw new Error(`chains.${key} tidak ada di config`);
  const per = new Set(PER_CHAIN);
  return new Proxy(cfg, {
    get(t, p) {
      if (p === 'network') return key;
      if (p === 'chainBlock') return t.chains[key];
      if (typeof p === 'string' && per.has(p)) return t.chains[key][p];
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === 'string' && per.has(p)) t.chains[key][p] = v; else t[p] = v;
      return true;
    },
    has(t, p) { return (typeof p === 'string' && per.has(p)) ? p in t.chains[key] : p in t; },
    deleteProperty(t, p) {
      if (typeof p === 'string' && per.has(p)) delete t.chains[key][p]; else delete t[p];
      return true;
    },
  });
}

function enabledChains(cfg) {
  return Object.keys(cfg.chains || {}).filter((k) => cfg.chains[k]?.enabled !== false);
}

module.exports = { PER_CHAIN, PRIMARY, normalizeCfg, chainView, enabledChains, bscTemplate, solanaTemplate, chainTemplate };
