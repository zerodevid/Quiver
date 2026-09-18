'use strict';
// Config multi-chain: satu config.json, satu proses, banyak chain.
//
// Bentuk config:
//   {
//     "wallet": {...}, "server": {...}, "telegram": {...}, "db": {...}, "notify": {...},   <- global
//     "chains": {
//       "robinhood": { "enabled": true, "chain": {endpoints…}, "targets": [], "rules": {}, "mode": {}, "gas": {}, "prices": {}, "loop": {}, "scout": {}, "risk": {}, "swap": {} },
//       "bsc":       { ... }
//     }
//   }
//
// Config lama (satu chain, kolom-kolom itu di tingkat atas) dinormalkan otomatis saat
// dimuat: isinya dipindah ke chains.robinhood — tidak perlu migrasi manual di tiap
// instance PM2.
//
// Mesin, server, dan bot Telegram tidak membaca `chains` langsung. Masing-masing
// menerima "tampilan" per chain (chainView): objek Proxy yang membaca/menulis kolom
// per-chain ke chains.<nama> dan kolom lain ke config induk. Jadi kode yang sudah ada
// (`cfg.rules`, `cfg.mode.dry_run = …`, `cfg.chain.endpoints`) tetap berjalan apa
// adanya, dan writeCfg(view) tetap menulis config induk yang utuh.
const { NETWORKS } = require('./networks');

const PER_CHAIN = ['chain', 'targets', 'rules', 'mode', 'gas', 'prices', 'loop', 'scout', 'risk', 'swap'];
const PRIMARY = 'robinhood';

// Blok BSC bawaan: simulasi, tanpa target, RPC publik. Diuji 2026-09-19 dari VPS:
//   - bsc.rpc.blxrbdn.com (bloXroute) & rpc-bsc.48.club: getLogs maks 5000 blok, batch OK,
//     riwayat lama terbaca — tulang punggung pemindaian
//   - bsc-rpc.publicnode.com: eth_call cepat, getLogs hanya beberapa blok terakhir
//   - bsc-dataseed.bnbchain.org (resmi): eth_call/kirim tx, getLogs selalu "limit exceeded"
// Alchemy (bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}) bisa ditambah dari halaman
// Pengaturan setelah jaringan BNB diaktifkan untuk app itu di dasbor Alchemy.
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
    // ~0,75 detik per blok: 1500 blok ≈ 19 menit per potongan pengejaran; poll 3 detik
    // adopt_blocks: jendela pindai posisi wallet saat mulai (~2 hari); pemindaian
    // lanjutan hanya blok baru. Tanpa batas ini = seluruh riwayat, 24 ribu panggilan
    // getLogs 5000-blok di BSC.
    loop: { poll_ms: 3000, max_block_span: 1500, sync_seconds: 30, equity_seconds: 300, stale_action_seconds: 300, adopt_blocks: 250_000 },
    // Gas BSC ~0,1–1 gwei; cadangan 0,005 BNB. legacyGasPricing (networks.js) membuat
    // tip = harga gas, jadi priority_wei di sini tidak dipakai di BSC.
    gas: { price_multiplier: 1.2, priority_wei: 1_000_000_000, max_gas_limit: 4_000_000, native_reserve_wei: 5_000_000_000_000_000, max_fee_gwei: 20, topup_max_usd: 25 },
    // Harga BNB otomatis dari pool PancakeSwap v3 USDT/WBNB (networks.js); eth_usd = cadangan.
    prices: { eth_usd: 750, auto_eth_price: true },
    scout: { blocks: 120_000 },
    risk: { max_daily_drawdown_pct: 0 },
    swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 },
    catatan: 'Blok BSC dibuat otomatis: mode simulasi, belum ada target. Tambah target lewat dasbor/Telegram (pilih chain BSC), lalu matikan simulasi kalau sudah yakin.',
  };
}

// Config lama -> bentuk chains. Mengubah objek di tempat; mengembalikan daftar
// catatan (untuk log) tentang apa yang dinormalkan.
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

// Tampilan per chain. Kunci per-chain dibaca/ditulis ke cfg.chains[key], sisanya ke
// cfg. `network` = nama chain-nya. JSON.stringify(view) = config induk (untuk writeCfg).
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

module.exports = { PER_CHAIN, PRIMARY, normalizeCfg, chainView, enabledChains, bscTemplate };
