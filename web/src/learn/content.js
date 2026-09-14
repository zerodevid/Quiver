// Isi buku Belajar LP. Setiap teks punya edisi Indonesia dan Inggris sebagai pasangan
// [id, en]; halaman memilih salah satu lewat locale, bukan lewat kamus i18n, karena
// paragraf panjang tidak cocok dijadikan kunci kamus.
//
// Contoh angka memakai pasangan TOKEN/USDG dengan harga awal 100 dan modal 100 USDG,
// sama dengan simulator (learn/math.js), supaya teks dan grafik bisa dicocokkan.

export const sources = [
  { label: 'Concentrated liquidity', href: 'https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity' },
  { label: 'Range orders', href: 'https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/range-orders' },
  { label: 'LP calculations', href: 'https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/lp-calculations' },
  { label: 'Fees', href: 'https://developers.uniswap.org/docs/get-started/concepts/fees' },
  { label: 'Protocol glossary', href: 'https://developers.uniswap.org/docs/get-started/concepts/glossary' },
  { label: 'Hook warnings', href: 'https://support.uniswap.org/hc/en-us/articles/32402040565133-What-are-hook-warnings' },
];

export const chapters = [
  {
    id: 'start',
    module: ['Dasar', 'Basics'],
    title: ['Menjadi liquidity provider', 'Becoming a liquidity provider'],
    intro: ['Sebelum memilih range, pahami apa yang sebenarnya kamu pegang.', 'Before choosing a range, understand what you actually own.'],
    takeaways: [
      ['Posisi LP adalah klaim atas inventori yang berubah dan fee, bukan jumlah token yang tetap.', 'An LP position is a claim on changing inventory and fees, not a fixed token quantity.'],
      ['Harga di Quiver selalu quote untuk 1 base. Pool ber-quote WETH belum dinyatakan dalam dolar.', 'Quiver prices are always quote per 1 base. WETH-quoted pools are not priced in dollars.'],
      ['Nilai LP dengan membandingkannya terhadap hold dan memegang quote, bukan dari fee saja.', 'Judge an LP against holding and against holding quote, not by fees alone.'],
    ],
    sections: [
      {
        title: ['Modal yang membantu swap', 'Capital that enables swaps'],
        body: [
          'LP menyetor aset ke pool agar pengguna lain bisa menukar token. Posisi memberi hak atas aset yang tersisa dan fee yang terakumulasi. Komposisi aset berubah ketika swap melewati range kamu; jumlah token awal tidak dijamin tetap.',
          'An LP deposits assets into a pool so others can swap. A position represents a claim on remaining assets and accumulated fees. Swaps through your range change that inventory; the original token quantities are not fixed.',
        ],
      },
      {
        title: ['Baca pasangan dari satu arah', 'Read the pair in one direction'],
        body: [
          'Di Quiver, harga TOOLS/USDG berarti USDG untuk 1 TOOLS. TOOLS adalah base; USDG adalah quote. Untuk PIGGY/WETH, harga dalam WETH belum merupakan dolar. Harga quote terhadap USD ikut mengubah nilai dolar. Seluruh contoh buku memakai TOKEN/USDG dengan harga awal 100 dan modal 100 USDG.',
          'In Quiver, TOOLS/USDG means USDG per TOOLS. TOOLS is the base; USDG the quote. PIGGY/WETH prices are in WETH, not dollars. The quote asset’s USD price also affects dollar valuation. Book examples use TOKEN/USDG with an initial price of 100 and capital of 100 USDG.',
        ],
      },
      {
        title: ['Tiga pilihan yang berbeda', 'Three different choices'],
        body: [
          'Hold mempertahankan jumlah token. LP mengubah komposisi sambil berpeluang mendapat fee. Memegang quote mengurangi paparan ke base, tetapi masih membawa risiko quote. Bandingkan ketiganya terhadap tujuan dan jangka waktumu; jangan menilai LP hanya dari fee.',
          'Holding preserves token quantities. LP changes inventory while potentially earning fees. Holding quote reduces base exposure but retains quote risk. Compare these choices against your objective and horizon; fees alone cannot evaluate an LP.',
        ],
      },
    ],
    check: {
      question: ['Harga PIGGY/WETH naik 10%. Pernyataan mana yang pasti benar?', 'The PIGGY/WETH price rises 10%. Which statement is certainly true?'],
      options: [
        ['Nilai dolar PIGGY naik 10%.', 'PIGGY’s dollar value rose 10%.'],
        ['PIGGY naik 10% diukur dalam WETH; nilai dolarnya juga bergantung pada harga WETH.', 'PIGGY rose 10% measured in WETH; its dollar value also depends on WETH’s price.'],
        ['Posisi LP di pool itu untung 10%.', 'An LP position in that pool is up 10%.'],
      ],
      answer: 1,
      explain: [
        'Harga dibaca sebagai quote per base. Jika WETH turun terhadap dolar pada saat yang sama, nilai dolar PIGGY bisa naik lebih sedikit, atau malah turun. PnL LP juga tidak sama dengan perubahan harga.',
        'Price is quote per base. If WETH falls against the dollar at the same time, PIGGY’s dollar value can rise less or even fall. LP PnL also differs from price change.',
      ],
    },
    lab: null,
    refs: [0, 4],
  },
  {
    id: 'range',
    module: ['Dasar', 'Basics'],
    title: ['Range adalah rencana inventori', 'A range is an inventory plan'],
    intro: ['Harga turun: kamu mengumpulkan base. Harga naik: kamu menjual base.', 'Falling prices accumulate base. Rising prices sell base.'],
    takeaways: [
      ['Di bawah range pokok 100% base, di atas range 100% quote, di dalam range berisi keduanya.', 'Below the range principal is 100% base, above it 100% quote, inside it holds both.'],
      ['Posisi out-of-range tidak mendapat fee swap baru. Fee lama tetap milikmu.', 'Out-of-range positions earn no new swap fees. Existing fees remain yours.'],
      ['Batas dibulatkan ke tick pool. Selalu periksa range efektif.', 'Bounds are rounded to pool ticks. Always check the effective range.'],
    ],
    sections: [
      {
        title: ['Di bawah, di dalam, di atas', 'Below, inside, above'],
        body: [
          'Di bawah batas bawah, pokok posisi seluruhnya base. Di dalam range, pokok berisi kedua aset. Di atas batas atas, pokok seluruhnya quote. Saldo fee terpisah masih bisa berisi dua token. Out-of-range menghentikan fee swap baru untuk posisi itu; fee lama tetap milikmu.',
          'Below the lower bound, principal is entirely base. Inside the range, principal holds both assets. Above the upper bound, it is entirely quote. Separate fee balances may still contain both tokens. Out-of-range positions stop earning new swap fees; existing fees remain yours.',
        ],
      },
      {
        title: ['Sempit atau lebar?', 'Narrow or wide?'],
        body: [
          'Range sempit memusatkan likuiditas di sedikit harga, tetapi mudah keluar rentang. Range lebar memberi ruang bergerak lebih besar dan biasanya mengurangi kebutuhan memindah range. Keduanya tetap bisa rugi. Full range juga bukan perlindungan dari token yang jatuh.',
          'Narrow ranges concentrate liquidity across fewer prices but are easier to leave. Wider ranges allow more movement and generally require fewer adjustments. Both can lose money. Full range does not protect against a collapsing token.',
        ],
      },
      {
        title: ['Tick dan pembulatan', 'Ticks and rounding'],
        body: [
          'Batas yang kamu input dibulatkan ke tick yang diizinkan pool. Periksa range efektif setelah pembulatan, terutama untuk range sangat sempit. Harga tampilan yang dibulatkan bisa tampak menyentuh batas, sementara status chain sudah out. Gunakan status sinkron sebagai acuan eksekusi.',
          'Your inputs are rounded to ticks allowed by the pool. Check the effective bounds after rounding, especially for very narrow ranges. A rounded displayed price can appear at the boundary while onchain status is already out. Use synchronized status for execution decisions.',
        ],
      },
    ],
    check: {
      question: ['Harga TOKEN jatuh melewati batas bawah. Apa yang terjadi pada pokok LP?', 'TOKEN falls below the lower bound. What happens to LP principal?'],
      options: [
        ['Otomatis menjadi USDG seperti stop-loss.', 'It automatically becomes USDG, like a stop-loss.'],
        ['Seluruhnya menjadi TOKEN dan fee swap baru berhenti.', 'It becomes entirely TOKEN and new swap fees stop.'],
        ['Pokok hilang seluruhnya saat melewati batas.', 'Principal disappears when price crosses the bound.'],
      ],
      answer: 1,
      explain: [
        'LP membeli base selama harga turun melewati range. Di bawah batas bawah kamu memegang TOKEN dan tetap menanggung perubahan harganya. Batas range bukan proteksi modal.',
        'An LP buys base as price falls through the range. Below the lower bound you hold TOKEN and still bear its price changes. A range bound does not protect capital.',
      ],
    },
    lab: 'dump',
    refs: [0, 2],
  },
  {
    id: 'pnl',
    module: ['Menengah', 'Intermediate'],
    title: ['Fee, PnL, IL, dan BEP', 'Fees, PnL, IL, and break-even'],
    intro: ['Empat angka yang menjawab empat pertanyaan berbeda.', 'Four numbers that answer four different questions.'],
    takeaways: [
      ['PnL membandingkan dengan modal. IL membandingkan dengan hold. Keduanya menjawab pertanyaan berbeda.', 'PnL compares against capital; IL compares against holding. They answer different questions.'],
      ['Fee yang sudah diklaim dihitung satu kali, bukan dua kali.', 'Claimed fees are counted once, never twice.'],
      ['BEP adalah harga, bukan tanggal, dan bisa tidak tercapai tanpa fee tambahan.', 'BEP is a price, not a date, and may be unattainable without further fees.'],
    ],
    sections: [
      {
        title: ['Untung dibanding modal', 'Profit versus capital'],
        body: [
          'Untuk posisi terbuka Quiver: PnL = nilai LP + fee belum diklaim + fee pernah diklaim + penarikan sebagian − modal. Fee yang sudah diklaim tidak boleh dihitung dua kali. Saat ditutup, hasil dan pembukuan sisa token mengikuti catatan aplikasi; lihat riwayat untuk pecahannya. PnL bersih portofolio dapat berbeda karena gas, swap, dan kas di luar posisi.',
          'For an open Quiver position: PnL = LP value + unclaimed fees + previously claimed fees + partial withdrawals − capital. Never count claimed fees twice. Closed proceeds and leftover accounting follow the app’s records; inspect history for the breakdown. Net portfolio PnL can differ due to gas, swaps, and cash outside positions.',
        ],
      },
      {
        title: ['IL bukan persentase harga jatuh', 'IL is not the token’s price decline'],
        body: [
          'Impermanent loss membandingkan pokok LP dengan nilai jika jumlah token awal hanya di-hold pada harga yang sama. LP bisa untung terhadap modal tetapi kalah dari hold. LP juga bisa rugi walaupun fee positif. Menghapus posisi tidak menghapus kerugian ekonomi yang sudah terjadi.',
          'Impermanent loss compares LP principal with holding the original token quantities at the same price. An LP can profit versus capital while underperforming hold, or lose money despite positive fees. Removing liquidity does not erase an economic loss that already exists.',
        ],
      },
      {
        title: ['Cara membaca garis BEP', 'Reading the BEP line'],
        body: [
          'BEP Quiver adalah harga impas perkiraan, bukan perkiraan tanggal. Perhitungannya mengikuti komposisi LP saat harga berubah serta fee dan hasil penarikan yang sudah ada. Gas, slippage, dan fee mendatang belum masuk. Kadang tidak ada harga BEP yang bisa dicapai tanpa fee tambahan: di atas range, pokok quote berhenti bertambah. BEP dapat berubah setelah claim, compound, atau penarikan.',
          'Quiver’s BEP is an estimated break-even price, not a date forecast. It models changing LP inventory and existing fees and proceeds. Gas, slippage, and future fees are excluded. Sometimes no attainable break-even price exists without more fees: above the range, quote principal stops increasing. Claiming, compounding, or withdrawals can change BEP.',
        ],
      },
    ],
    check: {
      question: ['Posisi LP-mu untung terhadap modal. Apakah LP pasti lebih baik daripada hold?', 'Your LP position is profitable versus capital. Did it necessarily beat holding?'],
      options: [
        ['Ya, untung berarti selalu lebih baik.', 'Yes, a profit always means it did better.'],
        ['Belum tentu. Bandingkan dengan nilai hold inventori awal pada harga yang sama.', 'Not necessarily. Compare with holding the initial inventory at the same price.'],
        ['Tidak, LP selalu kalah dari hold.', 'No, an LP always loses to holding.'],
      ],
      answer: 1,
      explain: [
        'Saat harga naik, LP menjual base sehingga bisa untung tetapi tetap tertinggal dari hold. Fee dapat menutup selisih itu, tetapi tidak dijamin.',
        'When price rises, an LP sells base, so it can profit yet trail holding. Fees can close that gap, but not guaranteed.',
      ],
    },
    lab: 'rise',
    refs: [4, 2],
  },
  {
    id: 'scenarios',
    module: ['Menengah', 'Intermediate'],
    title: ['Dari prediksi ke pilihan range', 'From a thesis to a range'],
    intro: ['Contoh harga dinormalisasi ke 100. Ini kerangka eksperimen, bukan sinyal pasar.', 'Prices are normalized to 100. These are experiments, not market signals.'],
    takeaways: [
      ['Tentukan tujuan dulu: fee, akumulasi, atau distribusi. Setelah itu baru pilih range.', 'Set the objective first: fees, accumulation, or distribution. Then choose the range.'],
      ['Range di atas harga menjual base bertahap. Range di bawah harga membeli base bertahap.', 'A range above price sells base gradually; a range below price buys base gradually.'],
      ['Konversi bisa berbalik bila harga kembali melewati range sebelum likuiditas ditarik.', 'Conversions reverse if price recrosses the range before liquidity is withdrawn.'],
    ],
    sections: [
      {
        title: ['Naik: jual bertahap atau tetap ikut naik?', 'Rising: sell gradually or retain upside?'],
        body: [
          'Jika ingin melepas base bertahap, coba range di atas harga, misalnya 110–150: masuk sebagai base dan baru aktif saat harga mencapainya. Jika ingin tetap aktif sekarang, coba 90–140 lalu lihat komposisinya di simulator. LP menjual base saat naik; bila tujuanmu mempertahankan seluruh kenaikan token, bandingkan dengan hold.',
          'To sell base gradually, experiment with an above-market range such as 110–150: it starts as base and activates when price reaches it. To stay active now, try 90–140 and inspect inventory in the lab. LP sells base into a rise; compare holding if your objective is retaining all token upside.',
        ],
      },
      {
        title: ['Sideways: uji lebar terhadap volatilitas', 'Sideways: test width against volatility'],
        body: [
          'Contoh 90–110 mengasumsikan harga sering kembali ke tengah. Uji juga 80–120 untuk melihat trade-off. Pilih horizon terlebih dahulu, amati rentang gerak historis, dan periksa apakah volume benar-benar melewati range. Breakout dapat membatalkan asumsi sideways; siapkan evaluasi, bukan mempersempit range hanya demi APR.',
          'A 90–110 example assumes frequent returns to the middle. Compare 80–120 to see the trade-off. Choose a horizon first, review historical movement, and check whether swaps actually cross your range. A breakout can invalidate the sideways thesis; plan a review rather than tightening solely for APR.',
        ],
      },
      {
        title: ['Turun / dump: pahami apa yang dibeli', 'Falling / dump: understand what you buy'],
        body: [
          'Range 60–90 di bawah harga 100 mulai sebagai quote dan membeli base ketika harga turun melewatinya. Itu hanya sesuai sebagai eksperimen akumulasi jika kamu menerima risiko memegang base setelah breakdown. Jika tujuanmu mengurangi risiko dump, menunggu atau mengurangi paparan bisa lebih sesuai. Batas bawah LP bukan stop-loss: di bawahnya kamu justru memegang base.',
          'A 60–90 range below price 100 starts as quote and buys base as price falls through it. It fits an accumulation experiment only if you accept holding base after a breakdown. Waiting or reducing exposure may better match a risk-reduction objective. An LP lower bound is not a stop-loss: below it you hold base.',
        ],
      },
      {
        title: ['Volatil, breakout, dan reversal', 'Volatility, breakouts, and reversals'],
        body: [
          'Bandingkan range lebar 60–160 dengan modal lebih kecil, beberapa range bertingkat, atau tidak membuka posisi. Jika memakai range untuk jual/beli bertahap, konversi bisa berbalik saat harga kembali melewati range sebelum likuiditas ditarik. Contoh range tidak menentukan hasil; jalur harga, likuiditas aktif, biaya, dan waktu pengelolaan ikut menentukan.',
          'Compare a wide 60–160 range with smaller capital, staggered ranges, or staying out. A staged buy/sell can reverse if price recrosses the range before withdrawal. Bounds alone do not determine results; the price path, active liquidity, costs, and management timing matter.',
        ],
      },
    ],
    check: {
      question: ['Harga sekarang 100 dan kamu ingin menjual TOKEN bertahap bila harga naik. Range mana yang sesuai kerangka itu?', 'Price is 100 and you want to sell TOKEN gradually if it rises. Which range fits that plan?'],
      options: [
        ['60–90', '60–90'],
        ['110–150', '110–150'],
        ['95–105', '95–105'],
      ],
      answer: 1,
      explain: [
        'Range 110–150 dimulai sebagai TOKEN dan menukarnya ke USDG saat harga naik melewatinya. Range 60–90 justru membeli TOKEN saat harga turun.',
        'A 110–150 range starts as TOKEN and converts it to USDG as price rises through it. A 60–90 range buys TOKEN as price falls.',
      ],
    },
    lab: 'sell',
    refs: [1],
  },
  {
    id: 'fees',
    module: ['Lanjutan', 'Advanced'],
    title: ['Fee dan ekonomi pengelolaan', 'Fees and management economics'],
    intro: ['Pendapatan kotor tidak sama dengan hasil bersih.', 'Gross income is not net performance.'],
    takeaways: [
      ['Fee kira-kira = volume relevan × tarif fee LP × pangsa likuiditas aktifmu.', 'Fees ≈ relevant volume × LP fee rate × your active-liquidity share.'],
      ['Fee tier 1% bukan imbal hasil 1%.', 'A 1% fee tier is not a 1% return.'],
      ['Compound dan rebalance punya biaya dan menambah modal yang terpapar.', 'Compounding and rebalancing cost money and increase exposed capital.'],
    ],
    sections: [
      {
        title: ['Model fee yang masuk akal', 'A useful fee model'],
        body: [
          'Perkiraan kasar = volume swap yang relevan × fee bersih untuk LP × pangsa likuiditas aktifmu. Ketiga faktor berubah. Fee pool 1% bukan imbal hasil 1% per hari dan bukan 1% dari modalmu. Fee protokol atau hook dapat mengubah bagian LP; verifikasi pool yang dipilih.',
          'A rough model is relevant swap volume × net LP fee rate × your active-liquidity share. All three change. A 1% pool fee is not a 1% daily return or 1% of your capital. Protocol or hook fees may change the LP share; verify the specific pool.',
        ],
      },
      {
        title: ['Claim dan auto-compound', 'Claiming and auto-compounding'],
        body: [
          'Claim memindahkan fee ke wallet; itu bukan keuntungan baru kedua kalinya. Compound memasukkan fee kembali ke posisi dan menambah modal yang terpapar. Bandingkan tambahan potensi fee dengan gas dan biaya penyeimbangan token. Compound saat pasar turun juga meningkatkan aset yang berisiko.',
          'Claiming moves fees to the wallet; it does not create the same profit twice. Compounding reinvests fees and increases exposed capital. Compare incremental potential fees with gas and token-balancing costs. Compounding during a decline also increases capital at risk.',
        ],
      },
      {
        title: ['Rebalance perlu alasan', 'Rebalancing needs a reason'],
        body: [
          'Memindahkan range biasanya perlu keluar, swap, lalu masuk lagi. Hitung biaya seluruh rangkaian dan perubahan inventori. Hindari mengejar harga setiap candle: strategi seperti itu bisa membeli kembali token lebih mahal setelah sebelumnya dijual LP. Tulis pemicu berdasarkan invalidasi tesis, bukan sekadar warna merah.',
          'Moving a range generally involves removing, swapping, and depositing again. Account for the full sequence and inventory changes. Chasing every candle can buy back tokens at higher prices after the LP sold them. Define triggers based on thesis invalidation, not simply red numbers.',
        ],
      },
    ],
    check: {
      question: ['Apa arti pool dengan fee tier 1%?', 'What does a 1% fee-tier pool mean?'],
      options: [
        ['Modal LP bertambah 1% per hari.', 'LP capital grows 1% per day.'],
        ['Swap membayar sekitar 1% dari jumlah yang ditukar, dibagi di antara likuiditas aktif pada harga itu.', 'Swaps pay about 1% of the amount traded, shared among liquidity active at that price.'],
        ['Setiap posisi dijamin mendapat 1% dari modal per swap.', 'Every position is guaranteed 1% of capital per swap.'],
      ],
      answer: 1,
      explain: [
        'Pendapatanmu bergantung pada volume yang melewati range dan pangsamu terhadap likuiditas aktif. Fee protokol atau hook dapat mengurangi bagian LP.',
        'Your income depends on volume through your range and your share of active liquidity. Protocol or hook fees can reduce the LP share.',
      ],
    },
    lab: 'sideways',
    refs: [3],
  },
  {
    id: 'risk',
    module: ['Lanjutan', 'Advanced'],
    title: ['Risiko dan disiplin copy-LP', 'Risk and copy-LP discipline'],
    intro: ['Strategi yang bagus tetap bergantung pada aset dan eksekusi.', 'A sound strategy still depends on assets and execution.'],
    takeaways: [
      ['Periksa token, hook, dan kedalaman exit sebelum membuka posisi.', 'Check the token, hooks, and exit depth before opening.'],
      ['Posisi salinan berbeda dari target karena latensi, ukuran, gas, dan slippage.', 'A copied position differs from the target because of latency, sizing, gas, and slippage.'],
      ['Stop-loss aplikasi bergantung pada RPC dan transaksi yang berhasil. Harga eksekusi tidak dijamin.', 'App stop-loss depends on RPC and successful transactions; execution price is not guaranteed.'],
    ],
    sections: [
      {
        title: ['Sebelum membuka', 'Before opening'],
        body: [
          'Periksa alamat token, kemampuan menjual, kedalaman exit, konsentrasi holder, kontrol mint/pause/tax, umur pool, dan integrasi hook. Stablecoin bisa depeg. Hook v4 dapat mengubah perilaku swap atau likuiditas; kode yang tidak dipahami bukan jaminan aman hanya karena pool muncul di dashboard.',
          'Check token addresses, sellability, exit depth, holder concentration, mint/pause/tax controls, pool age, and hook integration. Stablecoins can depeg. v4 hooks can change swap or liquidity behavior; being listed in a dashboard does not make unfamiliar code safe.',
        ],
      },
      {
        title: ['Menyalin bukan meniru hasil', 'Copying does not reproduce returns'],
        body: [
          'Target bisa masuk lebih awal, membayar gas berbeda, dan punya modal atau inventori lain. Latensi, pembatasan ukuran, slippage, dan saldo membuat posisi salinan berbeda. Periksa alasan di Aktivitas serta hasil per posisi. Kendali manual berarti kamu mengambil tanggung jawab pengelolaan; pahami aturan sebelum mengaktifkannya.',
          'A target may enter earlier, pay different gas, or hold other capital and inventory. Latency, sizing limits, slippage, and balances make the copy different. Review Activity reasons and position results. Manual control transfers management responsibility to you; understand the rules before enabling it.',
        ],
      },
      {
        title: ['Rencana keluar yang bisa dijalankan', 'An executable exit plan'],
        body: [
          'Tentukan batas modal per posisi, kerugian yang dapat diterima, cadangan gas, serta kondisi keluar. Stop-loss aplikasi bergantung pada pembacaan harga, RPC, dan keberhasilan transaksi; harga eksekusi tidak dijamin. Likuiditas tipis dapat membuat hasil penjualan lebih rendah dari nilai tampilan. Lakukan evaluasi setelah exit, termasuk sisa token.',
          'Define per-position capital, acceptable loss, gas reserves, and exit conditions. App stop-loss depends on price reads, RPC, and successful transactions; execution price is not guaranteed. Thin liquidity can produce sale proceeds below displayed value. Review results after exit, including leftover tokens.',
        ],
      },
    ],
    check: {
      question: ['Target membuka posisi dan bot menyalinnya beberapa detik kemudian. Bagaimana hasilnya dibanding target?', 'A target opens a position and the bot copies it seconds later. How do results compare?'],
      options: [
        ['Identik, karena range-nya sama.', 'Identical, because the range is the same.'],
        ['Bisa berbeda karena harga entry, ukuran, gas, dan slippage berbeda.', 'They can differ due to entry price, size, gas, and slippage.'],
        ['Selalu lebih buruk dari target.', 'Always worse than the target.'],
      ],
      answer: 1,
      explain: [
        'Range yang sama tidak menghasilkan inventori, biaya, dan waktu keluar yang sama. Nilai posisi salinan dari catatannya sendiri.',
        'The same range does not produce the same inventory, costs, or exit timing. Judge a copy by its own records.',
      ],
    },
    lab: null,
    refs: [5],
  },
  {
    id: 'indicators',
    module: ['Praktik Quiver', 'Quiver practice'],
    title: ['Membaca dashboard Quiver', 'Reading the Quiver dashboard'],
    intro: ['Gunakan indikator bersama-sama; satu angka tidak cukup.', 'Read indicators together; one number is not enough.'],
    takeaways: [
      ['Persen entry mengukur perubahan harga token, bukan PnL.', 'Entry percentage measures token price change, not PnL.'],
      ['Jarak ke tepi range bukan probabilitas atau sisa waktu.', 'Distance to a range edge is not a probability or time remaining.'],
      ['Periksa Last synced dan satuan (WETH atau USD) sebelum mengambil keputusan.', 'Check Last synced and units (WETH or USD) before deciding.'],
    ],
    sections: [
      {
        title: ['Bar range dan chart', 'Range bar and chart'],
        body: [
          'Pita menunjukkan batas posisi. Titik terang menunjukkan harga kini; garis masuk menunjukkan harga saat entry. Garis putus-putus kuning adalah BEP saat tersedia. Persen entry adalah perubahan harga token, bukan PnL. Jarak ke tepi mengukur pergerakan untuk menyentuh batas, bukan probabilitas atau hitungan waktu.',
          'The band shows bounds. The bright dot is current price; the entry line marks entry price. The yellow dashed line is BEP when available. Entry percentage measures token price movement, not PnL. Distance to an edge measures movement to a boundary, not probability or time remaining.',
        ],
      },
      {
        title: ['Volume, likuiditas, dan transaksi', 'Volume, liquidity, and transactions'],
        body: [
          'Volume 24 jam memberi konteks aktivitas masa lalu. TVL/likuiditas pool tidak menunjukkan persis berapa likuiditas aktif yang bersaing dengan range kamu. Lonjakan volume, jumlah transaksi, dan fee tinggi bisa berasal dari peristiwa singkat; periksa beberapa jendela waktu dan kualitas token. Jangan mengekstrapolasi satu jam ramai menjadi pendapatan setahun.',
          '24-hour volume gives historical activity context. Pool TVL does not identify the exact active liquidity competing with your range. Volume spikes, transaction counts, and high fees can reflect a brief event; examine multiple windows and token quality. Do not extrapolate one busy hour into a year of income.',
        ],
      },
      {
        title: ['Sinkron, sumber, dan satuan', 'Freshness, sources, and units'],
        body: [
          'Harga chain, lilin GeckoTerminal, dan statistik DexScreener bisa berbeda waktu. Cek Last synced dan gunakan Perbarui jika data tertinggal. PnL target berasal dari posisi target, bukan modal kita. Harga WETH per token harus dibedakan dari USD per token; persentase bisa sama walaupun angka nominal berbeda.',
          'Chain prices, GeckoTerminal candles, and DexScreener statistics may have different timestamps. Check Last synced and refresh stale data. Target PnL belongs to the target’s position, not your capital. Distinguish WETH per token from USD per token; percentages can match while amounts differ.',
        ],
      },
    ],
    check: {
      question: ['Posisi menampilkan entry +12%. Apa artinya?', 'A position shows entry +12%. What does that mean?'],
      options: [
        ['PnL posisi +12%.', 'The position’s PnL is +12%.'],
        ['Harga token berubah +12% sejak entry. PnL bisa berbeda.', 'Token price moved +12% since entry; PnL can differ.'],
        ['Fee terkumpul setara 12% modal.', 'Accrued fees equal 12% of capital.'],
      ],
      answer: 1,
      explain: [
        'Perubahan harga mengubah komposisi LP, sehingga PnL biasanya tidak bergerak sebesar harga. Lihat PnL, fee, dan BEP bersama-sama.',
        'Price moves change LP inventory, so PnL usually does not move one-for-one with price. Read PnL, fees, and BEP together.',
      ],
    },
    lab: null,
    refs: [],
  },
  {
    id: 'routine',
    module: ['Praktik Quiver', 'Quiver practice'],
    title: ['Rutinitas sebelum dan sesudah entry', 'Before and after entry'],
    intro: ['Gunakan pertanyaan ini sebagai jurnal keputusan.', 'Use these questions as a decision journal.'],
    takeaways: [
      ['Tulis tujuan, horizon, dan kondisi invalidasi sebelum entry.', 'Write the objective, horizon, and invalidation before entry.'],
      ['Kembali in-range tidak berarti modal sudah impas.', 'Reentering the range does not mean capital has recovered.'],
      ['Rekonsiliasi hasil terhadap modal dan hold. Pisahkan fee, gas, slippage, dan sisa token.', 'Reconcile against capital and holding; separate fees, gas, slippage, and leftovers.'],
    ],
    sections: [
      {
        title: ['Sebelum entry: tesis dan ukuran', 'Before entry: thesis and sizing'],
        body: [
          'Apa tujuan saya: fee, akumulasi, atau distribusi? Mengapa aset ini layak dipegang jika keluar range? Berapa lama tesis berlaku? Apa yang membatalkannya? Berapa nilai modal jika base turun 50%? Jalankan simulator, lalu cek kembali harga aktual dan range efektif pada LP manual.',
          'Is my objective fees, accumulation, or distribution? Why am I willing to hold this asset outside the range? What is my horizon and invalidation condition? What happens to capital if base falls 50%? Run the lab, then check actual price and effective bounds in Manual LP.',
        ],
      },
      {
        title: ['Saat aktif: ukur, jangan hanya bereaksi', 'While active: measure, do not just react'],
        body: [
          'Pantau status range, PnL total, fee bersih, jarak BEP, freshness data, dan kedalaman pasar. Jika harga keluar, tentukan apakah tesis tetap berlaku sebelum menambah modal atau memindahkan range. Harga kembali in-range tidak otomatis berarti modal sudah impas.',
          'Monitor range status, total PnL, net fees, BEP distance, freshness, and market depth. When price exits, decide whether the thesis still holds before adding capital or moving bounds. Reentering the range does not automatically recover capital.',
        ],
      },
      {
        title: ['Sesudah exit: rekonsiliasi', 'After exit: reconcile'],
        body: [
          'Bandingkan hasil dengan modal dan dengan hold dari inventori awal. Pisahkan fee, gas, slippage, dan sisa token yang belum dijual. Catat kenapa exit berbeda dari rencana. Gunakan riwayat posisi dan PnL bersih portofolio agar fee tinggi tidak menutupi kerugian keseluruhan.',
          'Compare proceeds with capital and holding the initial inventory. Separate fees, gas, slippage, and unsold leftovers. Record why execution differed from the plan. Use position history and net portfolio PnL so high fees do not hide an overall loss.',
        ],
      },
    ],
    check: {
      question: ['Harga kembali ke dalam range setelah sempat keluar ke bawah. Apakah modal otomatis impas?', 'Price reenters the range after dropping below it. Is capital automatically back to even?'],
      options: [
        ['Ya, begitu in-range semuanya pulih.', 'Yes, everything recovers once in range.'],
        ['Tidak otomatis. Periksa PnL total dan jarak ke BEP.', 'Not automatically. Check total PnL and distance to BEP.'],
        ['Ya, asalkan fee sudah diklaim.', 'Yes, as long as fees were claimed.'],
      ],
      answer: 1,
      explain: [
        'Status in-range hanya berarti posisi kembali bisa menerima fee. Nilai pokok tergantung harga saat ini dan inventori yang terkumpul selama turun.',
        'In-range only means the position can earn fees again. Principal value depends on current price and inventory accumulated on the way down.',
      ],
    },
    lab: null,
    refs: [],
  },
];
