// Naskah video — semua teks & narasi per bahasa, satu tempat untuk disunting.
// Tiap adegan: [kicker, subtitle di layar, narasi (VO)]. Subtitle pendek & bisa
// dibaca sambil lalu; narasi lebih bercerita. Durasi adegan mengikuti narasinya.
export const AUTHOR = process.env.QAUTHOR || '';   // mis. "Zero Dev · github.com/zerodev"

export const COPY = {
  en: {
    introEyebrow: 'Copy-LP engine · Robinhood Chain',
    introHead: ['Copy the best liquidity providers. Automatically.'],
    introLead: 'Quiver mirrors Uniswap v3 and v4 LP positions from any wallet you choose — with your own risk rules.',
    introChips: ['Real-time mirroring', 'Risk rules per wallet', 'Simulation & live modes', 'Telegram bot'],
    introVo: 'This is Quiver — a copy-LP engine for Robinhood Chain. It watches the wallets you choose, and mirrors their Uniswap liquidity positions automatically, under your own risk rules.',

    ch1: ['01', 'Overview', 'The whole portfolio, one screen'],
    overview: ['Overview', 'Portfolio value, net PnL, fees and win rate at a glance.',
      'The overview shows the whole portfolio at a glance: total value, net profit after gas, fees earned, and the win rate across closed positions.'],
    growth: ['Portfolio growth', 'Net vs. cumulative PnL, highs and drawdown, over any range.',
      'The growth chart tracks net PnL over time, marking the high and the maximum drawdown. You can switch ranges, or compare cumulative against net PnL to see exactly what gas cost you.'],
    source: ['Performance by source', 'A PnL calendar, and results for every copied wallet.',
      'Below, a calendar of realised PnL by day, and a breakdown of results per copied wallet — so you always know which target is actually making money. Wallet identities are censored in this video.'],
    drill: ['Position detail', 'Price action, range and on-chain history of one position.',
      'Any position opens into its own page: the live price against the range, entry point, fees, and every on-chain event behind it.'],

    ch2: ['02', 'Positions', 'Open and closed — every one explained'],
    positions: ['Positions', 'Each mirrored LP position with its range, fees and live PnL.',
      'The positions page lists every mirrored position — open ones with their live range status, and closed ones with realised PnL.'],
    history: ['Position history', 'Mints, fee claims and exits, each linked to its transaction.',
      'Clicking a closed position opens its history: the mint, fee claims and the exit, each linked to its transaction.'],

    ch3: ['03', 'Decision log', 'Nothing happens silently'],
    activity: ['Activity', 'Every target move is copied, simulated or skipped — with a reason.',
      'The activity log records every move the targets make, and what the engine decided: copied, simulated, or skipped — always with the reason, like a budget limit or a token filter.'],

    ch4: ['04', 'Copy engine', 'Pick who to follow, set the rules'],
    targets: ['Targets', 'Follow many wallets, switch each on or off, compare their PnL with ours.',
      'Targets are the wallets being followed. Each one can be switched on or off, given its own rules, and compared: their PnL next to what we actually made copying them.'],
    rules: ['Risk rules', 'Position size, daily budget, range width, token filters and cooldowns.',
      'The rules define the risk: how big each position is, the daily budget, how wide the range may be, which tokens to avoid, and cooldowns between entries.'],

    ch5: ['05', 'Wallet research', 'Vet a wallet before you copy it'],
    research: ['Research', 'Win rate, fees and full LP history of any wallet, from chain.',
      'Before following a wallet, you can research it: win rate, fees earned and its full LP history, computed straight from the chain.'],

    ch6: ['06', 'Daily use', 'Manual control, when you want it'],
    manual: ['Manual LP', 'Pick a pool and an amount — the position preview is computed live.',
      'For manual trades, pick a pool and an amount, and the position preview is computed live.'],
    polish: ['Details', 'Dark and light themes · English and Bahasa Indonesia.',
      'And the details: a dark and a light theme, and the whole dashboard in English or Bahasa Indonesia.'],

    outroTag: 'Copy-LP engine · Robinhood Chain',
    specs: [['Engine', 'Node.js · ethers v6 · Uniswap v3 / v4'], ['Dashboard', 'React 19 · HeroUI · Tailwind CSS v4'], ['Charts', 'Recharts · lightweight-charts'], ['Operations', 'pm2 on a VPS · Telegram bot · ntfy alerts']],
    outroExtra: 'Simulation mode by default — live mode only when you turn it on.',
    outroVo: 'Quiver runs on Node.js with ethers, a React dashboard, and a Telegram bot — self-hosted, in simulation mode until you decide to go live.',
    note: 'Wallet addresses and target names are censored in this video.',
  },
  id: {
    introEyebrow: 'Mesin copy-LP · Robinhood Chain',
    introHead: ['Ikuti penyedia likuiditas terbaik. Secara otomatis.'],
    introLead: 'Quiver mencermin posisi LP Uniswap v3 dan v4 dari wallet mana pun yang kamu pilih — dengan aturan risikomu sendiri.',
    introChips: ['Cermin real-time', 'Aturan risiko per wallet', 'Mode simulasi & live', 'Bot Telegram'],
    introVo: 'Ini Quiver, mesin copy LP untuk Robinhood Chain. Ia memantau wallet yang kamu pilih, lalu mencermin posisi likuiditas Uniswap mereka secara otomatis, sesuai aturan risikomu sendiri.',

    ch1: ['01', 'Ringkasan', 'Seluruh portofolio, satu layar'],
    overview: ['Ringkasan', 'Nilai portofolio, PnL bersih, fee dan win rate dalam satu layar.',
      'Halaman ringkasan menampilkan seluruh portofolio: total nilai, laba bersih setelah gas, fee yang didapat, dan win rate dari posisi yang sudah ditutup.'],
    growth: ['Pertumbuhan portofolio', 'PnL bersih vs kumulatif, puncak dan drawdown, di rentang mana pun.',
      'Grafik pertumbuhan melacak PnL bersih dari waktu ke waktu, menandai puncak dan drawdown terbesar. Rentangnya bisa diganti, atau bandingkan PnL kumulatif dengan PnL bersih untuk melihat berapa yang termakan gas.'],
    source: ['Kinerja per sumber', 'Kalender PnL, dan hasil tiap wallet yang dicopy.',
      'Di bawahnya, kalender PnL harian dan rincian hasil per wallet yang dicopy, jadi selalu jelas target mana yang benar-benar menghasilkan. Identitas wallet di video ini disensor.'],
    drill: ['Detail posisi', 'Pergerakan harga, rentang, dan riwayat on-chain satu posisi.',
      'Setiap posisi punya halamannya sendiri: harga langsung terhadap rentang, titik masuk, fee, dan semua kejadian on-chain di baliknya.'],

    ch2: ['02', 'Posisi', 'Terbuka dan tertutup, semuanya terjelaskan'],
    positions: ['Posisi', 'Setiap posisi LP hasil cermin dengan rentang, fee dan PnL langsung.',
      'Halaman posisi memuat semua posisi hasil cermin: yang terbuka dengan status rentangnya, dan yang tertutup dengan PnL terealisasi.'],
    history: ['Riwayat posisi', 'Mint, klaim fee dan penutupan, masing-masing tertaut ke transaksinya.',
      'Klik posisi tertutup untuk membuka riwayatnya: mint, klaim fee, dan penutupan, masing-masing tertaut ke transaksinya.'],

    ch3: ['03', 'Log keputusan', 'Tidak ada yang terjadi diam-diam'],
    activity: ['Aktivitas', 'Setiap gerakan target disalin, disimulasikan atau dilewati, dengan alasan.',
      'Log aktivitas mencatat setiap gerakan target dan keputusan mesinnya: disalin, disimulasikan, atau dilewati, selalu dengan alasan, misalnya batas anggaran atau filter token.'],

    ch4: ['04', 'Mesin copy', 'Pilih siapa yang diikuti, tetapkan aturannya'],
    targets: ['Target', 'Ikuti banyak wallet, nyalakan atau matikan, bandingkan PnL-nya dengan kita.',
      'Target adalah wallet yang diikuti. Masing-masing bisa dinyalakan atau dimatikan, diberi aturan sendiri, dan dibandingkan: PnL mereka di samping hasil kita saat mengcopy-nya.'],
    rules: ['Aturan risiko', 'Ukuran posisi, anggaran harian, lebar rentang, filter token dan cooldown.',
      'Aturan menentukan risikonya: seberapa besar tiap posisi, anggaran harian, seberapa lebar rentang, token mana yang dihindari, dan jeda antar entri.'],

    ch5: ['05', 'Riset wallet', 'Periksa wallet sebelum dicopy'],
    research: ['Riset', 'Win rate, fee dan riwayat LP lengkap wallet mana pun, dari chain.',
      'Sebelum mengikuti sebuah wallet, kamu bisa merisetnya: win rate, fee yang didapat, dan riwayat LP lengkapnya, dihitung langsung dari chain.'],

    ch6: ['06', 'Pemakaian harian', 'Kendali manual, kapan pun dibutuhkan'],
    manual: ['LP manual', 'Pilih pool dan nominal, pratinjau posisi dihitung langsung.',
      'Untuk transaksi manual, pilih pool dan nominalnya, dan pratinjau posisi langsung dihitung.'],
    polish: ['Detail', 'Tema gelap dan terang · Bahasa Indonesia dan English.',
      'Dan detailnya: tema gelap dan terang, serta seluruh dasbor dalam Bahasa Indonesia atau Inggris.'],

    outroTag: 'Mesin copy-LP · Robinhood Chain',
    specs: [['Mesin', 'Node.js · ethers v6 · Uniswap v3 / v4'], ['Dasbor', 'React 19 · HeroUI · Tailwind CSS v4'], ['Grafik', 'Recharts · lightweight-charts'], ['Operasional', 'pm2 di VPS · Bot Telegram · notifikasi ntfy']],
    outroExtra: 'Mode simulasi sejak awal — mode live hanya kalau kamu menyalakannya.',
    outroVo: 'Quiver berjalan di Node.js dengan ethers, dasbor React, dan bot Telegram. Dihosting sendiri, dalam mode simulasi sampai kamu memutuskan untuk live.',
    note: 'Alamat wallet dan nama target di video ini disensor.',
  },
};
