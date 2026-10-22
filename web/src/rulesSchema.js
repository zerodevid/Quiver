// Rules form schema — the single source for the Rules page and the per-target rules.
// `when` decides when a field is relevant; irrelevant fields are hidden.
import { isSolana } from './chain';
export const SCHEMA = [
  { group: 'Ukuran posisi', icon: 'ti-ruler', fields: [
    { path: 'sizing.mode', label: 'Cara menentukan ukuran', type: 'select', options: [
      ['mirror', 'Sama persis dengan target'], ['pct', 'Persen dari target'],
      ['multiplier', 'Kelipatan dari target'], ['fixed_quote', 'Nominal tetap'], ['equity', 'Porsi equity target']],
      help: 'mirror = likuiditas identik; pct/multiplier = skala; nominal tetap = modal sama tiap posisi; porsi equity = % equity yang sama dengan target' },
    { path: 'sizing.pct', label: 'Persen dari target (%)', type: 'number', step: 1, when: (r) => r.sizing.mode === 'pct' || r.sizing.mode === 'equity',
      help: 'Di mode porsi equity: dipakai kalau equity target/kita tidak terbaca' },
    { path: 'sizing.multiplier', label: 'Kelipatan', type: 'number', step: 0.1, when: (r) => r.sizing.mode === 'multiplier' },
    { path: 'sizing.equity_mult', label: 'Pengali porsi equity', type: 'number', step: 0.1, when: (r) => r.sizing.mode === 'equity',
      help: 'Target masuk 20% equity-nya, pengali 0,5 → kita masuk 10% equity kita' },
    { path: 'sizing.equity_max_pct', label: 'Batas porsi equity (%)', type: 'number', step: 5, when: (r) => r.sizing.mode === 'equity',
      help: 'Porsi target dibatasi angka ini — equity target sering terbaca lebih kecil (memecoin & wallet lain tidak terhitung)' },
    { path: 'sizing.equity_min_pct', label: 'Minimum porsi equity (%)', type: 'number', step: 1, when: (r) => r.sizing.mode === 'equity',
      help: 'Porsi kita tidak turun di bawah angka ini (menang atas batas porsi). 0 = mati, disarankan' },
    { path: 'sizing.equity_target_usd', label: 'Equity target manual (USD)', type: 'number', step: 100, when: (r) => r.sizing.mode === 'equity',
      help: 'Isi per target kalau equity-nya terbaca terlalu kecil (memecoin, CEX, wallet lain). 0 = baca otomatis dari chain' },
    { path: 'sizing.equity_our_basis', label: 'Dasar equity kita', type: 'select', options: [['total', 'Total (kas + posisi)'], ['cash', 'Kas saja']], when: (r) => r.sizing.mode === 'equity',
      help: 'Total = sama dengan grafik equity (disarankan). Kas saja: ukuran mengecil sendiri saat modal makin terpakai' },
    { path: 'sizing.equity_fallback', label: 'Kalau equity tidak terbaca', type: 'select', options: [['pct', 'Pakai persen dari target'], ['skip', 'Lewati entri']], when: (r) => r.sizing.mode === 'equity',
      help: 'Persen dari target tidak melihat ukuran equity kita. Lewati entri lebih aman untuk LIVE' },
    { path: 'sizing.fixed_quote_usd', label: 'Nominal tetap (USD)', type: 'number', step: 5, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi USDG' },
    { path: 'sizing.fixed_quote_eth', label: 'Nominal tetap (ETH)', type: 'number', step: 0.005, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi ETH/WETH' },
    { path: 'sizing.min_quote_usd', label: 'Minimum per posisi (USD)', type: 'number', step: 1 },
    { path: 'sizing.force_min', label: 'Paksa masuk kalau di bawah minimum', type: 'bool',
      help: 'Mati = posisi dilewati; nyala = ukurannya dinaikkan ke nominal paksa' },
    { path: 'sizing.force_min_usd', label: 'Nominal paksa (USD)', type: 'number', step: 5, when: (r) => r.sizing.force_min },
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
    { path: 'range.align', label: 'Pembulatan tick', type: 'select', options: [
      ['nearest', 'Ke yang terdekat'], ['down', 'Ke bawah'], ['up', 'Ke atas']],
      help: 'Tick harus kelipatan tickSpacing pool; ini menentukan arah pembulatannya', when: (r) => r.range.mode !== 'exact' },
    { path: 'range.dlmm_strategy', label: 'Bentuk likuiditas DLMM (Meteora)', type: 'select', options: [
      ['mirror', 'Ikuti bentuk target'], ['spot', 'Spot (rata)'], ['curve', 'Curve (menumpuk di tengah)'], ['bidask', 'Bid-Ask (menumpuk di tepi)']],
      when: () => isSolana() },
    { path: 'range.follow_rebalance', label: 'Ikut geser rentang (rebalance) target', type: 'select', options: [
      ['out_of_range', 'Hanya kalau cermin sudah di luar rentang'], ['always', 'Setiap kali target menggeser'], ['off', 'Jangan ikut']],
      when: () => isSolana() },
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
    { path: 'exit.follow_claim', label: 'Ikut klaim fee saat target memanen fee', type: 'bool' },
    { path: 'exit.out_of_range_minutes', label: 'Tutup kalau di luar rentang selama (menit, 0=mati)', type: 'number', step: 5 },
    { path: 'exit.out_of_range_pct', label: 'Tutup kalau harga lebih dari (%) di luar rentang (0=mati)', type: 'number', step: 5 },
    { path: 'exit.reenter_within_pct', label: 'Buka lagi kalau harga kembali ≤ (%) dari rentang (0=mati)', type: 'number', step: 5, when: (r) => r.exit.out_of_range_pct > 0 },
    { path: 'exit.stop_loss_pct', label: 'Stop loss (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.take_profit_pct', label: 'Take profit (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.max_age_hours', label: 'Umur maksimum (jam, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.sell_leftover', label: 'Jual memecoin sisa setelah keluar', type: 'bool',
      help: 'Token yang diterima saat menutup posisi dijual balik ke USDG/ETH lewat agregator swap yang aktif' },
    { path: 'exit.sell_max_loss_bps', label: 'Batas rugi jual sisa (bps)', type: 'number', step: 100, when: (r) => r.exit.sell_leftover,
      help: 'Fee pool + dampak harga. Di atas batas ini token disimpan dan dikutip ulang terus sampai lolos' },
    { path: 'exit.leftover_retry_sec', label: 'Cek ulang sisa tiap (detik)', type: 'number', step: 1, when: (r) => r.exit.sell_leftover,
      help: 'Satu kutipan per token per interval; swap hanya dikirim kalau ruginya sudah di bawah batas. Minimal 1 — terlalu rapat bisa kena batas laju agregator yang juga dipakai zap' },
  ] },
  { group: 'Saringan', icon: 'ti-filter', fields: [
    { path: 'filters.allow_hooks', label: 'Izinkan semua hook (termasuk yang berisiko)', type: 'bool', help: 'Mati (disarankan): pool dengan hook pajak swap atau anti-bot tetap diikuti; yang ditolak hanya hook yang bisa menahan atau memotong penarikan. Nyala: semua hook diikuti tanpa dicek.' },
    { path: 'filters.hook_whitelist', label: 'Hook dipercaya (alamat, pisah koma)', type: 'list', when: (r) => !r.filters.allow_hooks,
      help: 'Hook v4 berisiko yang tetap boleh dimasuki — hanya isi alamat hook yang kodenya sudah kamu cek' },
    { path: 'filters.allow_no_quote', label: 'Salin pool tanpa USDG/ETH', type: 'bool', help: 'Mati: pool dua memecoin (tanpa aset kuotasi) dilewati. Nyala: ikut disalin; nilai dolarnya dihitung lewat harga DexScreener, jadi hanya sedekat harga itu.' },
    { path: 'filters.min_target_quote_usd', label: 'Abaikan posisi target di bawah (USD)', type: 'number', step: 5 },
    { path: 'filters.max_open_positions', label: 'Maksimum posisi terbuka', type: 'number', step: 1 },
    { path: 'filters.cooldown_seconds', label: 'Jeda antar salinan di pool sama (detik)', type: 'number', step: 5 },
    { path: 'filters.min_pool_age_minutes', label: 'Umur pool minimum (menit)', type: 'number', step: 5, help: 'Pool yang baru dibuat sering jebakan; 0 = mati' },
    { path: 'filters.min_liquidity_usd', label: 'Likuiditas pool minimum (USD)', type: 'number', step: 1000, help: 'Pool tipis sulit ditutup tanpa rugi; 0 = mati' },
    { path: 'filters.min_volume24h_usd', label: 'Volume 24 jam minimum (USD)', type: 'number', step: 1000, help: 'Tanpa volume tidak ada fee, seberapa pun betulnya rentangnya; 0 = mati' },
    { path: 'filters.max_fee_bps', label: 'Batas fee pool', type: 'number', step: 1000, help: 'Dalam satuan fee Uniswap: 3000 = 0,3%, 100000 = 10%' },
    { path: 'filters.quote_whitelist', label: 'Aset kuotasi diizinkan', type: 'list' },
    { path: 'filters.venues', label: 'Venue diizinkan', type: 'list' },
    { path: 'filters.token_blacklist', label: 'Daftar hitam token (alamat, pisah koma)', type: 'list' },
    { path: 'filters.token_whitelist', label: 'Daftar putih token (kosong = semua)', type: 'list' },
  ] },
];


// ---- Anti rug & scam ----------------------------------------------------------------------
// A section that gathers every guard against bait-and-dump pools. Fields from other groups are
// shown again here through `dup`: it copies the original definition (label, help, options) and
// only adds a recommendation. The form reads and writes by `path`, so a duplicate is the SAME stored
// value as the original — editing it in either place changes both.
const findField = (path) => SCHEMA.flatMap((g) => g.fields).find((f) => f.path === path);
const dup = (path, extra) => ({ ...findField(path), ...extra });
const evm = () => !isSolana();

export const ANTI_RUG_GUIDE = {
  intro: 'Penipu memakai pola yang berulang: token baru dibuat, uang pancingan dipasang supaya pool tampak ramai dan "dipercaya", lalu pembuatnya menjual semua token ke likuiditas yang ikut masuk. Bagian ini mengumpulkan semua penjaga untuk pola itu di satu tempat. Kolom yang sama juga ada di bagian lain dan nilainya satu: mengubah di sini berarti mengubah di sana.',
  patterns: [
    ['Bid satu sisi di bawah harga', 'Kamu memasang USDG di bawah harga. Pembuat menjual seluruh token ke dalamnya, jadi USDG-mu berubah menjadi token yang nilainya jatuh ke nol.'],
    ['Pabrik token', 'Satu dompet membuat banyak token berturut-turut dan mengulang jebakan yang sama di tiap token, sering dengan dompet "pemimpin" yang ditiru bot lain.'],
    ['Supply terkumpul di satu dompet', 'Harga dan market cap hanyalah harga terakhir di satu pool tipis dikali supply. Kalau satu dompet memegang mayoritas, satu penjualan menjatuhkannya.'],
    ['Pool baru sekali', 'Jebakan jalan di menit-menit pertama, sebelum ada riwayat atau pengawasan.'],
  ],
  steps: [
    'Pilih preset di bawah (Seimbang atau Ketat), lalu sesuaikan kolomnya.',
    'Mulai dengan modal per posisi dan anggaran harian kecil sampai targetnya terbukti.',
    'Setiap kali rugi karena satu token, cari pembuatnya di explorer (pengirim transaksi cetak pertama) dan masukkan ke daftar hitam pembuat.',
  ],
  limits: [
    'Tidak ada filter yang menjamin aman. Dump bisa terjadi dalam satu blok, lebih cepat dari stop loss.',
    'Pengecekan pembuat dan pemegang token hanya untuk jaringan EVM dan memakai Alchemy. Kalau datanya tidak terbaca, entri tetap diteruskan.',
    'Filter yang terlalu ketat melewatkan entri yang sah. Mulai dari Seimbang, naikkan kalau masih kena.',
  ],
};

// A preset only writes the anti-rug filters; sizing and budgets are left to the user.
export const ANTI_RUG_PRESETS = [
  { id: 'off', label: 'Mati', desc: 'Semua penjaga di bagian ini dimatikan, perilaku seperti sebelum ada bagian ini.', values: {
    'filters.min_pool_age_minutes': 0, 'onesided.policy': 'copy', 'filters.max_deployer_tokens': 0, 'filters.max_top_holder_pct': 0,
    'filters.min_liquidity_usd': 0, 'filters.min_volume24h_usd': 0, 'filters.allow_hooks': false, 'filters.allow_no_quote': false } },
  { id: 'balanced', label: 'Seimbang', desc: 'Menolak jebakan yang paling jelas dan tetap menerima sebagian pool baru.', values: {
    'filters.min_pool_age_minutes': 30, 'onesided.policy': 'copy', 'onesided.max_quote_usd': 50, 'filters.max_deployer_tokens': 5, 'filters.deployer_window_hours': 6,
    'filters.max_top_holder_pct': 60, 'filters.min_liquidity_usd': 5000, 'filters.min_volume24h_usd': 10000, 'filters.allow_hooks': false, 'filters.allow_no_quote': false } },
  { id: 'strict', label: 'Ketat', desc: 'Disarankan untuk target yang sering masuk ke token baru. Lebih banyak entri sah ikut terlewat.', values: {
    'filters.min_pool_age_minutes': 60, 'onesided.policy': 'skip', 'filters.max_deployer_tokens': 3, 'filters.deployer_window_hours': 6,
    'filters.max_top_holder_pct': 40, 'filters.min_liquidity_usd': 10000, 'filters.min_volume24h_usd': 20000, 'filters.allow_hooks': false, 'filters.allow_no_quote': false } },
];

SCHEMA.push({ group: 'Anti rug & scam', icon: 'ti-shield-exclamation', guide: ANTI_RUG_GUIDE, presets: ANTI_RUG_PRESETS, fields: [
  dup('filters.min_pool_age_minutes', {
    rec: { value: 60, label: '60 menit' },
    why: 'Jebakan paling sering jalan di menit-menit pertama: pool yang jadi sasaran dalam satu kasus berumur sekitar 2 menit saat target masuk. Di data kita juga, pool di bawah 1 jam adalah penyebab rugi, bukan volumenya. Harga yang dibayar: kamu melewatkan fee di jam pertama pool.' }),
  dup('onesided.policy', {
    rec: { value: 'skip', label: 'Lewati' },
    why: 'Bentuk jebakannya adalah USDG satu sisi di bawah harga: kalau harga dijatuhkan melewati rentang, semua USDG berubah jadi token yang jatuh. Dengan Lewati, bid seperti ini tidak pernah disalin. Kalau tetap mau Salin, batasi nominalnya di kolom di bawah.' }),
  dup('onesided.max_quote_usd', {
    rec: { value: 25, label: '$25' },
    why: 'Membatasi kerugian per jebakan satu sisi. Hanya berlaku kalau kebijakan di atas bukan Lewati.' }),
  { path: 'filters.max_deployer_tokens', label: 'Maks. token baru per pembuat', type: 'number', step: 1, when: evm,
    help: 'Lewati token dari pembuat yang sudah mencetak sebanyak ini ke dompetnya dalam jendela waktu di bawah (pabrik token); 0 = mati',
    rec: { value: 3, label: '3 token' },
    why: 'Pembuat yang sah jarang mencetak lebih dari 1-2 token dalam beberapa jam; pabrik jebakan mencetak belasan (kasus yang kita periksa: 9 dalam 6 jam). Yang dihitung hanya cetakan langsung ke dompet pembuat, jadi launchpad yang mencetak lewat kontrak pabrik tidak ikut terblokir.' },
  { path: 'filters.deployer_window_hours', label: 'Jendela waktu pembuat (jam)', type: 'number', step: 1, when: (r) => evm() && r.filters.max_deployer_tokens > 0,
    rec: { value: 6, label: '6 jam' },
    why: 'Cukup panjang untuk menangkap pabrik yang mencetak token tiap 7-15 menit, cukup pendek supaya pembuat sah yang aktif sepanjang minggu tidak terhitung.' },
  { path: 'filters.max_top_holder_pct', label: 'Maks. supply satu dompet (%)', type: 'number', step: 5, when: evm,
    help: 'Lewati token yang satu dompetnya (bukan pool/burn) memegang lebih dari ini. Token baru sering masih dipegang pembuatnya; 0 = mati',
    rec: { value: 40, label: '40%' },
    why: 'Satu dompet dengan 40% atau lebih bisa menjatuhkan harga sendirian. Di kasus yang kita periksa, pembuat memegang hampir 100% saat posisi disalin, lalu satu dompet lain mengambil 64,6%. Efek samping: token yang baru diluncurkan dan masih dipegang pembuatnya juga terlewat, dan pengecekan token lama bisa menambah beberapa detik.' },
  { path: 'filters.deployer_blacklist', label: 'Daftar hitam pembuat token (alamat, pisah koma)', type: 'list', when: evm,
    help: 'Token yang dicetak dari dompet ini tidak diikuti, berapa pun umurnya',
    rec: { label: 'Isi pembuat dari rug yang sudah terbukti' },
    why: 'Pabrik token terus membuat token baru, jadi daftar hitam token tidak berguna melawannya; daftar hitam pembuat tetap menolak semua token berikutnya. Cari pembuatnya di explorer: pengirim transaksi cetak pertama token.' },
  dup('filters.token_blacklist', {
    rec: { label: 'Isi token yang sudah terbukti rug' },
    why: 'Mencegah salinan ulang token yang sudah kamu ketahui buruk. Hanya menolak token itu saja, bukan token baru dari pembuat yang sama.' }),
  dup('filters.min_liquidity_usd', {
    rec: { value: 10000, label: '$10.000' },
    why: 'Pool tipis sulit ditutup tanpa rugi dan harganya mudah digerakkan beberapa ribu dolar. Catatan: pool yang belum terindeks DexScreener tidak terkena filter ini, jadi pasangkan dengan umur pool.' }),
  dup('filters.min_volume24h_usd', {
    rec: { value: 20000, label: '$20.000' },
    why: 'Volume yang nyata menandakan pool dipakai orang lain. Volume bisa dipalsukan dengan wash trading, jadi ini pelengkap, bukan pengganti umur pool.' }),
  dup('filters.allow_hooks', {
    rec: { value: false, label: 'Mati' },
    why: 'Hook v4 bisa menahan atau memotong penarikan. Dengan Mati, pool berhook berisiko ditolak dan hook pajak biasa tetap diikuti.' }),
  dup('filters.allow_no_quote', {
    rec: { value: false, label: 'Mati' },
    why: 'Pool dua memecoin tidak punya jalan keluar ke USDG/ETH, nilainya dihitung lewat harga DexScreener yang bisa dimanipulasi, dan kamu tidak punya aset stabil untuk keluar.' }),
  dup('sizing.max_quote_per_position_usd', {
    rec: { value: 100, label: '$100' },
    why: 'Batas atas kerugian satu jebakan. Mulai kecil sampai targetnya terbukti, lalu naikkan.' }),
  dup('sizing.daily_budget_usd', {
    rec: { value: 300, label: '$300 (sekitar 3 kali batas per posisi)' },
    why: 'Pabrik jebakan mengulang pola tiap beberapa menit. Anggaran harian membatasi total uang yang bisa terjebak dalam satu hari walau filter lain lolos.' }),
] });

export const RULE_HELP = {
  "sizing.mode": "Tentukan modal awal salinan: likuiditas sama, persentase, kelipatan, atau nominal tetap. Hasilnya tetap dibatasi batas per posisi, eksposur, anggaran harian, dan saldo.",
  "sizing.pct": "50 berarti menyalin 50% likuiditas target; 100 berarti sama dengan target, sebelum batas modal diterapkan.",
  "sizing.multiplier": "0,5 berarti setengah likuiditas target; 2 berarti dua kali lipat, sebelum batas modal diterapkan.",
  "sizing.min_quote_usd": "Jika nilai salinan setelah pembatasan lebih kecil dari angka ini, posisi dilewati. Ini bukan modal yang otomatis ditambahkan.",
  "sizing.force_min": "Kalau ukuran hasil hitung lebih kecil dari minimum, posisi tidak dilewati melainkan dinaikkan ke nominal paksa. Batas per posisi, eksposur, anggaran harian, dan saldo tetap berlaku.",
  "sizing.force_min_usd": "Nominal yang dipakai saat paksa masuk aktif. Contoh: 10% dari target $250 = $25, minimum $100, nominal paksa $100 → posisi dibuka $100. Kalau nominal ini tidak muat di batas yang tersisa, posisi tetap dilewati.",
  "sizing.max_quote_per_position_usd": "Modal maksimum untuk satu posisi salinan. Ukuran yang lebih besar diperkecil agar sesuai batas. Nilai 0 tidak berarti tanpa batas.",
  "sizing.max_total_exposure_usd": "Batas modal gabungan posisi terbuka. Sisa jatah dihitung setelah dikurangi eksposur yang sudah terbuka. Nilai 0 menghentikan penambahan modal.",
  "sizing.daily_budget_usd": "Batas modal masuk per hari. Jika jatah habis, salinan baru dilewati; ini bukan batas kerugian harian.",
  "range.mode": "Pilih rentang harga tempat likuiditas bekerja: ikuti target, pusatkan ulang, ubah lebar, gunakan persentase, atau seluruh rentang. Posisi di luar rentang hanya berisi satu token.",
  "range.scale": "Mengalikan lebar rentang target dengan faktor ini, dengan titik tengah target tetap. 2 berarti dua kali lebih lebar.",
  "range.width_pct": "Lebar dihitung dari harga kini dalam tick logaritmik lalu dibulatkan ke tick pool. Batas harga akhir dapat berbeda dari persentase sederhana.",
  "range.follow_rebalance": "Meteora DLMM: target (biasanya bot otomasi) memindah likuiditas posisi yang sama ke bin baru supaya tetap di sekitar harga. Ikut = cermin ditutup lalu dibuka lagi di rentang baru target dengan hasil penutupannya (token meme ikut disetor lagi, tidak dijual). Hanya kalau di luar rentang = cermin dipindah begitu harga sudah keluar dari rentangnya — hemat biaya transaksi bila target menggeser setiap beberapa menit. Butuh 'Ikut keluar saat target keluar' aktif.",
  "range.dlmm_strategy": "Cara likuiditas disebar ke bin di posisi Meteora DLMM. Ikuti bentuk target = dibaca dari isi bin posisi target (spot, curve, atau bid-ask); kalau tidak terbaca jelas, dipakai spot. Orca dan Raydium tidak punya pilihan bentuk.",
  "range.min_width_ticks": "Memperlebar rentang yang lebih sempit dari jumlah tick ini. Tick adalah langkah harga Uniswap, bukan persen. 0 = tanpa lebar minimum.",
  "onesided.max_quote_usd": "Batas modal untuk posisi yang hanya berisi satu token. Batas per posisi dan sisa anggaran tetap berlaku.",
  "swap.enabled": "Mengizinkan pertukaran token untuk menyiapkan aset posisi saat saldo token kurang. Pertukaran mengikuti batas slippage dan dampak harga.",
  "swap.max_slippage_bps": "Selisih harga yang diizinkan saat eksekusi dibanding kutipan. 100 bps = 1%; 50 bps = 0,5%.",
  "swap.max_price_impact_bps": "Batas perubahan harga yang disebabkan ukuran swap itu sendiri. 100 bps = 1%. Berbeda dari slippage saat eksekusi.",
  "exit.follow_target": "Bot ikut menutup salinan ketika target keluar dari posisi. Aturan keluar mandiri di bawah tetap terpisah.",
  "exit.follow_partial": "Saat target menarik sebagian likuiditas, bot menarik bagian yang sebanding dari salinannya.",
  "exit.follow_claim": "Saat target mengklaim fee posisinya, bot ikut mengklaim fee salinannya. Fee dijual ke aset kuotasi hanya kalau panen otomatis posisi itu mode klaim + jual. Tiap klaim membayar gas — bawaannya mati.",
  "exit.out_of_range_minutes": "Tutup posisi setelah terus berada di luar rentang selama durasi ini. Penghitung direset ketika kembali masuk rentang. 0 = nonaktif.",
  "exit.out_of_range_pct": "Tutup posisi begitu harga lebih jauh dari persentase ini di luar rentang — jarak ke tepi terdekat, angka yang sama dengan \"di luar · 61% di atas\" di daftar posisi. Modal tidak menganggur di posisi yang jauh dari harga. Berlaku juga saat masuk: entry target yang rentangnya sejauh ini ditunda, bukan disalin. Dua sinkron berturut-turut (~1 menit) sebelum ditutup. 0 = nonaktif.",
  "exit.reenter_within_pct": "Cermin yang ditunda atau ditutup karena jauh dibuka lagi begitu harga kembali sedekat ini dari rentang, selama posisi target masih terbuka. Ukurannya dihitung ulang dari likuiditas target saat itu. Harus lebih kecil dari ambang tutup supaya tidak buka-tutup di satu harga. 0 = nonaktif.",
  "exit.stop_loss_pct": "Memicu penutupan ketika PnL posisi mencapai persentase rugi ini. Isi angka positif, misalnya 10 untuk rugi 10%. Harga eksekusi akhir bisa berbeda. 0 = nonaktif.",
  "exit.take_profit_pct": "Memicu penutupan ketika PnL posisi mencapai persentase untung ini. Harga eksekusi akhir bisa berbeda. 0 = nonaktif.",
  "exit.max_age_hours": "Tutup posisi setelah umur posisi mencapai jumlah jam ini, terlepas dari laba atau rugi. 0 = nonaktif.",
  "filters.min_liquidity_usd": "Lewati pool yang likuiditasnya (TVL menurut DexScreener) lebih kecil dari angka ini. Pool tipis menggeser harga saat kita masuk dan saat keluar, dan sisa tokennya susah dijual. Pool yang belum terindeks DexScreener tidak punya angka ini dan tetap dilewatkan — saringan ini menolak pool yang terbukti tipis, bukan pool yang belum dikenal. 0 = nonaktif.",
  "filters.min_volume24h_usd": "Lewati pool yang volume swap 24 jamnya lebih kecil dari angka ini. Fee LP lahir dari volume: pool sepi membayar mendekati nol berapa pun modalnya, sementara risiko tokennya tetap penuh. Angkanya sumber yang sama dengan kolom Volume 24 jam di daftar posisi. Pool yang belum terindeks DexScreener tetap dilewatkan. 0 = nonaktif.",
  "filters.min_target_quote_usd": "Lewati posisi target yang nilainya lebih kecil dari angka ini, sebelum ukuran salinan dihitung.",
  "filters.max_open_positions": "Batasi jumlah posisi bot yang boleh terbuka bersamaan.",
  "filters.cooldown_seconds": "Jeda sebelum menyalin lagi di pool yang sama, untuk menghindari salinan yang terlalu rapat.",
  "filters.quote_whitelist": "Pisahkan dengan koma, misalnya USDG, ETH, WETH. Kosong berarti semua aset kuotasi yang dikenali bot.",
  "filters.venues": "Pisahkan dengan koma: v3, v4. Gunakan huruf kecil. Daftar kosong tidak mengizinkan venue mana pun.",
  "filters.token_blacklist": "Alamat token yang selalu ditolak. Pisahkan alamat dengan koma. Daftar hitam mengalahkan daftar putih.",
  "filters.token_whitelist": "Hanya izinkan alamat token dalam daftar ini. Pisahkan dengan koma. Kosong berarti tidak membatasi token melalui daftar putih."
};
