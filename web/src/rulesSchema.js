// Skema form aturan — sumber tunggal untuk halaman Aturan dan aturan per-target.
// `when` menentukan kapan sebuah field relevan; field yang tidak relevan disembunyikan.
export const SCHEMA = [
  { group: 'Ukuran posisi', icon: 'ti-ruler', fields: [
    { path: 'sizing.mode', label: 'Cara menentukan ukuran', type: 'select', options: [
      ['mirror', 'Sama persis dengan target'], ['pct', 'Persen dari target'],
      ['multiplier', 'Kelipatan dari target'], ['fixed_quote', 'Nominal tetap']],
      help: 'mirror = likuiditas identik; pct/multiplier = skala; nominal tetap = modal sama tiap posisi' },
    { path: 'sizing.pct', label: 'Persen dari target (%)', type: 'number', step: 1, when: (r) => r.sizing.mode === 'pct' },
    { path: 'sizing.multiplier', label: 'Kelipatan', type: 'number', step: 0.1, when: (r) => r.sizing.mode === 'multiplier' },
    { path: 'sizing.fixed_quote_usd', label: 'Nominal tetap (USD)', type: 'number', step: 5, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi USDG' },
    { path: 'sizing.fixed_quote_eth', label: 'Nominal tetap (ETH)', type: 'number', step: 0.005, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi ETH/WETH' },
    { path: 'sizing.min_quote_usd', label: 'Minimum per posisi (USD)', type: 'number', step: 1 },
    { path: 'sizing.max_quote_per_position_usd', label: 'Maksimum per posisi (USD)', type: 'number', step: 10 },
    { path: 'sizing.max_total_exposure_usd', label: 'Batas eksposur total (USD)', type: 'number', step: 50 },
    { path: 'sizing.daily_budget_usd', label: 'Anggaran per hari (USD)', type: 'number', step: 50 },
  ] },
  { group: 'Rentang harga', icon: 'ti-arrows-horizontal', fields: [
    { path: 'range.mode', label: 'Cara menentukan rentang', type: 'select', options: [
      ['exact', 'Sama persis dengan target'], ['recenter', 'Lebar sama, dipusatkan harga kini'],
      ['scale', 'Lebar dikali faktor'], ['width_pct', 'Lebar tetap ±%'], ['full', 'Full range']] },
    { path: 'range.scale', label: 'Faktor lebar', type: 'number', step: 0.1, when: (r) => r.range.mode === 'scale' },
    { path: 'range.width_pct', label: 'Lebar ±%', type: 'number', step: 1, when: (r) => r.range.mode === 'width_pct' },
    { path: 'range.min_width_ticks', label: 'Lebar minimum (tick)', type: 'number', step: 10, when: (r) => r.range.mode !== 'full' },
  ] },
  { group: 'Posisi satu sisi', icon: 'ti-arrow-bar-to-right', fields: [
    { path: 'onesided.policy', label: 'Kalau rentang di luar harga kini', type: 'select', options: [
      ['copy', 'Tetap salin (jadi limit order)'], ['skip', 'Lewati'], ['recenter', 'Geser ke harga kini']],
      help: 'Rentang yang seluruhnya di atas/bawah harga = posisi satu token saja' },
    { path: 'onesided.max_quote_usd', label: 'Batas nominal satu sisi (USD)', type: 'number', step: 10, when: (r) => r.onesided.policy !== 'skip' },
  ] },
  { group: 'Auto-swap', icon: 'ti-refresh', fields: [
    { path: 'swap.enabled', label: 'Tukar otomatis kalau token kurang', type: 'bool' },
    { path: 'swap.max_slippage_bps', label: 'Slippage maksimum (bps)', type: 'number', step: 10, when: (r) => r.swap.enabled },
    { path: 'swap.max_price_impact_bps', label: 'Dampak harga maksimum (bps)', type: 'number', step: 10, when: (r) => r.swap.enabled },
  ] },
  { group: 'Keluar', icon: 'ti-door-exit', fields: [
    { path: 'exit.follow_target', label: 'Ikut keluar saat target keluar', type: 'bool' },
    { path: 'exit.follow_partial', label: 'Ikut menarik sebagian (proporsional)', type: 'bool', when: (r) => r.exit.follow_target },
    { path: 'exit.out_of_range_minutes', label: 'Tutup kalau di luar rentang selama (menit, 0=mati)', type: 'number', step: 5 },
    { path: 'exit.stop_loss_pct', label: 'Stop loss (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.take_profit_pct', label: 'Take profit (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.max_age_hours', label: 'Umur maksimum (jam, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.sell_leftover', label: 'Jual memecoin sisa setelah keluar', type: 'bool',
      help: 'Token yang diterima saat menutup posisi dijual balik ke USDG/ETH lewat agregator Kyber' },
    { path: 'exit.sell_max_loss_bps', label: 'Batas rugi jual sisa (bps)', type: 'number', step: 100, when: (r) => r.exit.sell_leftover,
      help: 'Fee pool + dampak harga. Di atas batas ini token disimpan dan dicoba lagi nanti' },
  ] },
  { group: 'Saringan', icon: 'ti-filter', fields: [
    { path: 'filters.allow_hooks', label: 'Izinkan pool v4 dengan hook', type: 'bool', help: 'Hook bisa memblokir penarikan — default: tolak' },
    { path: 'filters.min_target_quote_usd', label: 'Abaikan posisi target di bawah (USD)', type: 'number', step: 5 },
    { path: 'filters.max_open_positions', label: 'Maksimum posisi terbuka', type: 'number', step: 1 },
    { path: 'filters.cooldown_seconds', label: 'Jeda antar salinan di pool sama (detik)', type: 'number', step: 5 },
    { path: 'filters.quote_whitelist', label: 'Aset kuotasi diizinkan', type: 'list' },
    { path: 'filters.venues', label: 'Venue diizinkan', type: 'list' },
    { path: 'filters.token_blacklist', label: 'Daftar hitam token (alamat, pisah koma)', type: 'list' },
    { path: 'filters.token_whitelist', label: 'Daftar putih token (kosong = semua)', type: 'list' },
  ] },
];
