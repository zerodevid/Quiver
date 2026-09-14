// Glosarium Belajar LP. `term` memakai istilah yang sama dengan label dasbor supaya
// pengguna bisa mencocokkannya; `quiver` menjelaskan di mana istilah itu muncul di
// aplikasi; `chapter` menunjuk bab yang membahasnya lebih dalam.

export const groups = [
  ['price', ['Harga & pasangan', 'Price & pairs']],
  ['range', ['Range & likuiditas', 'Range & liquidity']],
  ['result', ['Hasil & ukuran', 'Results & metrics']],
  ['execution', ['Eksekusi & risiko', 'Execution & risk']],
];

export const glossary = [
  {
    group: 'price', chapter: 'start',
    term: ['Base', 'Base'],
    def: ['Token yang dihargai dalam sebuah pasangan. Pada TOKEN/USDG, base adalah TOKEN.', 'The token being priced in a pair. In TOKEN/USDG, the base is TOKEN.'],
  },
  {
    group: 'price', chapter: 'start',
    term: ['Quote', 'Quote'],
    def: ['Token yang menjadi satuan harga. Pada TOKEN/USDG, harga 100 berarti 100 USDG untuk 1 TOKEN.', 'The token prices are expressed in. In TOKEN/USDG, a price of 100 means 100 USDG per TOKEN.'],
    quiver: ['Pool ber-quote WETH menampilkan harga dalam WETH; nilai dolarnya ikut bergantung pada harga WETH.', 'WETH-quoted pools show prices in WETH; their dollar value also depends on WETH’s price.'],
  },
  {
    group: 'price', chapter: 'indicators',
    term: ['Harga entry', 'Entry price'],
    def: ['Harga pool saat posisi dibuka. Persentase entry mengukur perubahan harga, bukan PnL.', 'The pool price when the position opened. Entry percentage measures price change, not PnL.'],
  },
  {
    group: 'price', chapter: 'risk',
    term: ['Depeg', 'Depeg'],
    def: ['Kondisi ketika stablecoin kehilangan patokan terhadap aset acuannya, misalnya USDG di bawah 1 dolar.', 'When a stablecoin loses its peg to its reference asset, for example USDG trading below one dollar.'],
  },
  {
    group: 'range', chapter: 'range',
    term: ['Range', 'Range'],
    def: ['Rentang harga tempat likuiditas posisi bekerja. Di luar rentang, posisi berisi satu token dan tidak mendapat fee swap baru.', 'The price interval where a position’s liquidity works. Outside it, the position holds one token and earns no new swap fees.'],
  },
  {
    group: 'range', chapter: 'range',
    term: ['In range / out of range', 'In range / out of range'],
    def: ['In range: harga berada di antara batas bawah dan atas, sehingga posisi bisa menerima fee. Out of range: harga di luar batas.', 'In range: price is between the bounds, so the position can earn fees. Out of range: price is outside them.'],
    quiver: ['Status sinkron dari chain menjadi acuan, bukan harga tampilan yang dibulatkan.', 'Synchronized onchain status is authoritative, not a rounded displayed price.'],
  },
  {
    group: 'range', chapter: 'range',
    term: ['Tick', 'Tick'],
    def: ['Titik harga diskret di pool Uniswap. Batas range selalu dibulatkan ke tick yang diizinkan oleh tick spacing pool.', 'Discrete price points in a Uniswap pool. Range bounds are rounded to ticks allowed by the pool’s tick spacing.'],
  },
  {
    group: 'range', chapter: 'range',
    term: ['Full range', 'Full range'],
    def: ['Posisi yang aktif di hampir semua harga. Jarang keluar range, tetapi fee per modal lebih kecil dan tetap menanggung penurunan token.', 'A position active at nearly every price. It rarely leaves range, but earns less fee per capital and still bears token declines.'],
  },
  {
    group: 'range', chapter: 'fees',
    term: ['Likuiditas aktif', 'Active liquidity'],
    def: ['Likuiditas yang benar-benar tersedia pada harga saat ini. Pangsa kamu terhadap likuiditas ini menentukan bagian fee dari setiap swap.', 'Liquidity available at the current price. Your share of it determines your portion of each swap’s fee.'],
  },
  {
    group: 'range', chapter: 'scenarios',
    term: ['Range order', 'Range order'],
    def: ['Range satu sisi di atas atau di bawah harga untuk menjual atau membeli base bertahap. Konversinya bisa berbalik jika harga kembali sebelum likuiditas ditarik.', 'A one-sided range above or below price to sell or buy base gradually. The conversion reverses if price returns before liquidity is withdrawn.'],
  },
  {
    group: 'range', chapter: 'indicators',
    term: ['TVL', 'TVL'],
    def: ['Total nilai aset di pool. TVL tidak menunjukkan berapa likuiditas yang aktif di range kamu.', 'Total asset value in a pool. TVL does not show how much liquidity is active in your range.'],
  },
  {
    group: 'result', chapter: 'pnl',
    term: ['PnL', 'PnL'],
    def: ['Hasil posisi dibanding modal: nilai LP + fee belum diklaim + fee yang pernah diklaim + penarikan sebagian − modal.', 'Position result versus capital: LP value + unclaimed fees + claimed fees + partial withdrawals − capital.'],
    quiver: ['PnL target adalah hasil wallet target, bukan modalmu.', 'Target PnL belongs to the target wallet, not your capital.'],
  },
  {
    group: 'result', chapter: 'pnl',
    term: ['Impermanent loss (IL)', 'Impermanent loss (IL)'],
    def: ['Selisih pokok LP dengan nilai jika jumlah token awal di-hold pada harga yang sama, sebelum fee.', 'The difference between LP principal and holding the original token quantities at the same price, before fees.'],
  },
  {
    group: 'result', chapter: 'pnl',
    term: ['BEP', 'Break-even price (BEP)'],
    def: ['Perkiraan harga ketika nilai LP, fee, dan hasil yang sudah ada sama dengan modal. Tidak memasukkan fee mendatang, gas, atau slippage.', 'The estimated price where LP value, fees, and existing proceeds equal capital. Excludes future fees, gas, and slippage.'],
    quiver: ['Ditampilkan sebagai garis kuning putus-putus bila tersedia; bisa kosong jika tidak tercapai dari harga saja.', 'Shown as a yellow dashed line when available; it may be empty when unattainable from price alone.'],
  },
  {
    group: 'result', chapter: 'fees',
    term: ['Fee tier', 'Fee tier'],
    def: ['Tarif yang dibayar swap ke pool, misalnya 0,3% atau 1%. Bukan imbal hasil harian untuk LP.', 'The rate swaps pay to the pool, such as 0.3% or 1%. Not a daily return for LPs.'],
  },
  {
    group: 'result', chapter: 'fees',
    term: ['Fee belum diklaim', 'Unclaimed fees'],
    def: ['Fee yang sudah dihasilkan posisi tetapi belum dipindahkan ke wallet. Tetap menjadi milikmu walau posisi keluar range.', 'Fees earned by the position but not yet moved to the wallet. They stay yours even when the position is out of range.'],
  },
  {
    group: 'result', chapter: 'fees',
    term: ['Compound', 'Compound'],
    def: ['Memasukkan fee kembali ke posisi. Menambah modal yang terpapar dan memerlukan gas serta penyeimbangan token.', 'Reinvesting fees into the position. It increases exposed capital and costs gas and token balancing.'],
  },
  {
    group: 'result', chapter: 'indicators',
    term: ['Volume 24 jam', '24h volume'],
    def: ['Nilai swap di pool selama 24 jam terakhir. Konteks aktivitas masa lalu, bukan perkiraan fee mendatang.', 'Swap value in the pool over the past 24 hours. Past activity context, not a forecast of future fees.'],
  },
  {
    group: 'execution', chapter: 'fees',
    term: ['Rebalance', 'Rebalance'],
    def: ['Memindahkan range: menarik likuiditas, menukar token, lalu menyetor ulang. Seluruh rangkaian punya biaya.', 'Moving a range: withdraw, swap, and deposit again. The whole sequence has costs.'],
  },
  {
    group: 'execution', chapter: 'risk',
    term: ['Slippage', 'Slippage'],
    def: ['Selisih antara harga yang diharapkan dan harga eksekusi, terutama pada pool tipis atau transaksi besar.', 'The gap between expected and executed price, especially in thin pools or large trades.'],
  },
  {
    group: 'execution', chapter: 'fees',
    term: ['Gas', 'Gas'],
    def: ['Biaya jaringan untuk setiap transaksi, termasuk buka, claim, compound, dan tutup posisi.', 'Network cost of each transaction, including opening, claiming, compounding, and closing.'],
  },
  {
    group: 'execution', chapter: 'risk',
    term: ['Hook (v4)', 'Hook (v4)'],
    def: ['Kontrak tambahan pada pool Uniswap v4 yang dapat mengubah perilaku swap, fee, atau likuiditas.', 'An extra contract on a Uniswap v4 pool that can change swap, fee, or liquidity behavior.'],
  },
  {
    group: 'execution', chapter: 'risk',
    term: ['Latensi copy', 'Copy latency'],
    def: ['Jeda antara transaksi target dan salinan bot. Harga, ukuran, dan biaya dapat berubah selama jeda itu.', 'The delay between a target’s transaction and the bot’s copy. Price, size, and costs can change during it.'],
  },
  {
    group: 'execution', chapter: 'risk',
    term: ['Stop-loss', 'Stop-loss'],
    def: ['Aturan aplikasi untuk menutup posisi pada ambang kerugian. Bergantung pada pembacaan harga, RPC, dan transaksi yang berhasil. Batas bawah range bukan stop-loss.', 'An app rule that closes a position at a loss threshold. It depends on price reads, RPC, and successful transactions. A lower range bound is not a stop-loss.'],
  },
  {
    group: 'execution', chapter: 'indicators',
    term: ['Last synced', 'Last synced'],
    def: ['Waktu terakhir server membaca chain. Angka yang lebih tua dapat tertinggal dari harga, fee, dan status range.', 'When the server last read the chain. Older figures can lag price, fees, and range status.'],
  },
];
