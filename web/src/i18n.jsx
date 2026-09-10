// Dwibahasa Indonesia / Inggris.
//
// Teks Indonesia dipakai langsung sebagai kunci. Konsekuensinya: kalau sebuah
// terjemahan terlewat, yang muncul tetap kalimat Indonesia yang benar — bukan kunci
// mentah seperti "settings.wallet.title" atau teks kosong. Untuk dua bahasa, itu
// menghilangkan seluruh kelas bug "kunci tidak ketemu".
//
// Sisipan nilai: t('Tahap {n} dari 2', { n: 1 }).
import { createContext, useContext, useEffect, useState } from 'react';
import { I18nProvider as AriaI18n } from '@heroui/react';

export const LOCALES = { id: 'Indonesia', en: 'English' };

// Dipakai juga oleh fmt.js untuk memformat angka dan waktu tanpa harus
// mengoper locale ke setiap pemanggilan.
let current = 'id';
const listeners = new Set();
export const getLocale = () => current;
export function setLocale(l) {
  current = LOCALES[l] ? l : 'id';
  try { localStorage.setItem('lpcopy-lang', current); } catch { /* abaikan */ }
  document.documentElement.lang = current;
  listeners.forEach((f) => f(current));
}
export function initLocale() {
  let l = null;
  try { l = localStorage.getItem('lpcopy-lang'); } catch { /* abaikan */ }
  if (!l) l = (navigator.language || 'id').toLowerCase().startsWith('id') ? 'id' : 'en';
  setLocale(l);
}

const EN = {
  // ---- jual sisa memecoin ----
  'Jual memecoin sisa setelah keluar': 'Sell leftover memecoin after exit',
  'Token yang diterima saat menutup posisi dijual balik ke USDG/ETH lewat agregator Kyber': 'Tokens received when closing a position are sold back to USDG/ETH via the Kyber aggregator',
  'Batas rugi jual sisa (bps)': 'Max loss when selling leftovers (bps)',
  'Fee pool + dampak harga. Di atas batas ini token disimpan dan dicoba lagi nanti': 'Pool fee + price impact. Above this limit the tokens are kept and retried later',
  // ---- pembaruan riset wallet ----
  'menghitung ulang posisi {done} / {total}': 'recomputing positions {done} / {total}',
  'mencari posisi baru sejak pindai terakhir': 'looking for new positions since the last scan',
  'Perbarui': 'Refresh',
  'Diperbarui {when} · blok {from}–{to}': 'Updated {when} · blocks {from}–{to}',
  'Diperbarui otomatis saat wallet ini beraksi, dan saat dibuka bila lebih dari 5 menit.': 'Updates automatically when this wallet acts, and on open if older than 5 minutes.',
  'Pembaruan otomatis gagal: {e} — dicoba lagi sebentar lagi.': 'Automatic update failed: {e} — retrying shortly.',
  // ---- navigasi & kerangka ----
  'Pemantauan': 'Monitoring',
  'Copy': 'Copy',
  'Riset': 'Research',
  'Sistem': 'System',
  'Ringkasan': 'Overview',
  'Posisi': 'Positions',
  'Aktivitas': 'Activity',
  'Target': 'Targets',
  'Aturan': 'Rules',
  'Wallet': 'Wallet',
  'Scout': 'Scout',
  'Pengaturan': 'Settings',
  'Mode': 'Mode',
  'Simulasi': 'Simulation',
  'Live': 'Live',
  'Dijeda': 'Paused',
  'belum ada': 'none yet',
  'Jeda': 'Pause',
  'Lanjutkan': 'Resume',
  'Ganti tema': 'Toggle theme',
  'Menu': 'Menu',
  'Bahasa': 'Language',
  'lpcopy · cermin posisi likuiditas Uniswap v3/v4 · Robinhood Chain (4663)':
    'lpcopy · mirrors Uniswap v3/v4 liquidity positions · Robinhood Chain (4663)',
  'Memuat…': 'Loading…',
  'Belum ada data': 'No data yet',
  'Cari': 'Search',
  'Cari…': 'Search…',
  'Tidak ada yang cocok': 'Nothing matches',
  'Coba kata kunci lain.': 'Try a different search term.',
  '{n} baris': '{n} rows',
  '{n} dari {total} baris': '{n} of {total} rows',
  'Baris {a}–{b} dari {n}': 'Rows {a}–{b} of {n}',
  'Sebelumnya': 'Previous',
  'Berikutnya': 'Next',

  // ---- ringkasan ----
  'Eksposur terbuka': 'Open exposure',
  'Fee terkumpul': 'Fees earned',
  'PnL belum terealisasi': 'Unrealised PnL',
  'PnL terealisasi': 'Realised PnL',
  '{n} posisi · {r} in-range': '{n} positions · {r} in range',
  '{p}% dari modal': '{p}% of capital',
  'belum diklaim': 'unclaimed',
  'nilai + fee − modal': 'value + fees − capital',
  'dari posisi tertutup': 'from closed positions',
  'Nilai portofolio': 'Portfolio value',
  'Belum ada riwayat nilai': 'No value history yet',
  'Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit.':
    'The chart fills in once the bot opens a position. Value is recorded every 5 minutes.',
  'Kesehatan mesin': 'Engine health',
  'Blok terkini': 'Latest block',
  'Tertinggal': 'Behind',
  '{n} blok': '{n} blocks',
  'Aksi terdeteksi': 'Actions detected',
  'Disalin / dilewati': 'Copied / skipped',
  'Harga ETH': 'ETH price',
  'Latensi RPC': 'RPC latency',
  'Error terakhir': 'Last error',
  'Alasan terbanyak dilewati': 'Most common skip reasons',
  'Belum ada yang dilewati': 'Nothing skipped yet',
  'Transaksi terakhir': 'Recent transactions',
  'Belum ada transaksi': 'No transactions yet',
  'Mode simulasi tidak mengirim transaksi.': 'Simulation mode does not send transactions.',
  'Diperbarui {t}': 'Updated {t}',

  // ---- posisi ----
  'Posisi LP milik bot — nilai, fee, dan PnL diperbarui dari chain tiap 30 detik.':
    'The bot’s own LP positions — value, fees and PnL refreshed from chain every 30 seconds.',
  'Posisi terbuka ({n})': 'Open positions ({n})',
  'Posisi terbuka': 'Open positions',
  'Posisi berjalan': 'Live positions',
  'Riwayat posisi': 'Position history',
  'Posisi tertutup': 'Closed positions',
  'Pasangan': 'Pair',
  'Rentang harga': 'Price range',
  'Nilai': 'Value',
  'Fee': 'Fees',
  'PnL': 'PnL',
  'IL': 'IL',
  'Umur': 'Age',
  'Modal': 'Capital',
  'Hasil': 'Proceeds',
  'Ditutup': 'Closed',
  'Dibuka': 'Opened',
  'Tutup': 'Close',
  'modal {v}': 'capital {v}',
  'in-range': 'in range',
  'di luar': 'out of range',
  'Belum ada posisi terbuka': 'No open positions yet',
  'Posisi muncul di sini setelah bot menyalin LP dari wallet target.':
    'Positions appear here once the bot copies an LP from a target wallet.',
  'Belum ada posisi tertutup': 'No closed positions yet',
  'Tutup posisi ini sekarang?': 'Close this position now?',
  'Gagal: {e}': 'Failed: {e}',
  'Terkirim: {tx}': 'Sent: {tx}',
  'lebar {w}%': 'width {w}%',

  // ---- aktivitas ----
  'Setiap gerakan LP wallet target dan keputusan bot atasnya.':
    'Every LP move by target wallets and the bot’s decision on it.',
  'Semua keputusan': 'All decisions',
  'Disalin': 'Copied',
  'Dilewati': 'Skipped',
  'Gagal': 'Failed',
  'Waktu': 'Time',
  'Aksi': 'Action',
  'Keputusan': 'Decision',
  'Belum ada aktivitas': 'No activity yet',
  'Gerakan LP wallet target akan muncul di sini begitu terdeteksi.':
    'Target wallet LP moves show up here as soon as they are detected.',
  'Tambah likuiditas': 'Add liquidity',
  'Kurangi likuiditas': 'Remove liquidity',
  'Titip ke otomasi': 'Handed to automation',
  'Kembali dari otomasi': 'Back from automation',
  'Terima posisi': 'Received position',
  'Kirim posisi': 'Sent position',
  'Buka posisi': 'Open position',
  'Klaim fee': 'Claim fees',
  'Menunggu': 'Pending',
  'Sukses': 'Success',
  'Tambah likuiditas ': 'Add liquidity ',
  'Kurangi': 'Reduce',
  'Tutup posisi': 'Close position',
  'Izin token': 'Token approval',
  'Izin Permit2': 'Permit2 approval',
  'Tukar (zap)': 'Swap (zap)',
  'Tukar kas': 'Bridge swap',
  'Bungkus ETH': 'Wrap ETH',
  'Buka WETH': 'Unwrap WETH',

  // ---- target ----
  'Wallet yang posisi LP-nya dicermin. Klik sebuah wallet untuk melihat PnL, posisi berjalan, dan riwayat posisinya.':
    'Wallets whose LP positions are mirrored. Click a wallet to see its PnL, live positions and position history.',
  'Tambah wallet': 'Add wallet',
  'Alamat': 'Address',
  'Label (opsional)': 'Label (optional)',
  'mis. LP pro #1': 'e.g. LP pro #1',
  'Tambah': 'Add',
  'Aturan default dipakai sampai kamu setel sendiri per wallet.':
    'Default rules apply until you set per-wallet rules.',
  'Alamat harus 0x diikuti 40 karakter hex.': 'Address must be 0x followed by 40 hex characters.',
  'Belum ada wallet target': 'No target wallets yet',
  'Tambahkan alamat di sebelah kiri, atau dari halaman Wallet setelah memeriksa kinerjanya.':
    'Add an address on the left, or from the Wallet page after checking its performance.',
  'Wallet ditambahkan': 'Wallet added',
  'Tanpa label': 'Unlabelled',
  'aturan sendiri': 'own rules',
  'Belum pernah dipindai — buka untuk melihat PnL': 'Never scanned — open to see PnL',
  '{v} PnL · win {w}% · {n} posisi ditutup': '{v} PnL · {w}% win rate · {n} closed positions',
  '{a} aksi · {c} disalin': '{a} actions · {c} copied',
  '{n} posisi kita · {v}': '{n} of our positions · {v}',
  'Hapus': 'Delete',
  'Hapus {name} dari daftar target?': 'Remove {name} from the target list?',
  'Buka detail': 'Open detail',
  'Aturan khusus wallet ini. Selama tidak diubah, aturan default yang dipakai.':
    'Rules specific to this wallet. Until changed, the default rules apply.',
  'Pakai default': 'Use defaults',
  'Simpan aturan': 'Save rules',
  'Aturan wallet ini tersimpan': 'Rules for this wallet saved',
  'Kembali ke aturan default': 'Back to default rules',
  'Semua target': 'All targets',
  'Wallet ini tidak ada di daftar target': 'This wallet is not in the target list',
  'Mungkin sudah dihapus. Kembali ke daftar target.': 'It may have been removed. Go back to the target list.',
  'Ubah nama': 'Rename',
  'Simpan': 'Save',
  'Batal': 'Cancel',
  'Nama diperbarui': 'Name updated',
  'Salin alamat': 'Copy address',
  'Alamat tersalin': 'Address copied',
  'Sedang dicopy': 'Being copied',
  'Dimatikan': 'Disabled',
  'Aktifkan target': 'Enable target',
  'Disalin / simulasi': 'Copied / simulated',
  'Posisi kita terbuka': 'Our open positions',
  'Modal di posisi kita': 'Capital in our positions',
  'Aturan wallet ini': 'Rules for this wallet',
  'Kinerja LP wallet ini': 'This wallet’s LP performance',

  // ---- aturan ----
  'Aturan default': 'Default rules',
  'Berlaku untuk semua target yang tidak punya aturan sendiri.':
    'Applies to every target that has no rules of its own.',
  'Aturan tersimpan': 'Rules saved',
  'Gagal menyimpan': 'Save failed',

  // ---- wallet / riset ----
  'PnL, fee, dan seluruh riwayat posisi LP wallet mana pun — dihitung langsung dari chain.':
    'PnL, fees and the full LP position history of any wallet — computed straight from chain.',
  'Alamat wallet': 'Wallet address',
  'Jendela pindai': 'Scan window',
  'Buka': 'Open',
  'Pindai ulang': 'Rescan',
  'Pindai sekarang': 'Scan now',
  'Pernah dipindai:': 'Previously scanned:',
  '{n} posisi': '{n} positions',
  '~7 jam': '~7 hours',
  '~12 jam': '~12 hours',
  '~1 hari': '~1 day',
  '~3 hari': '~3 days',
  '~7 hari': '~7 days',
  'Semua riwayat': 'Full history',
  'Sekali dipindai, data disimpan — membuka lagi tidak memanggil chain.':
    'Scanned once, the data is stored — opening it again does not call the chain.',
  'Wallet ini belum ada di database.': 'This wallet is not in the database yet.',
  'Memuat data wallet…': 'Loading wallet data…',
  'Mengambil riwayat wallet dari chain': 'Fetching wallet history from chain',
  'Menyiapkan pemindaian…': 'Preparing scan…',
  'Tahap 1 dari 2 — mencari posisi di chain ({p}%)': 'Step 1 of 2 — finding positions on chain ({p}%)',
  'Tahap 2 dari 2 — menghitung posisi {done} / {total}': 'Step 2 of 2 — computing position {done} / {total}',
  'Memperbarui dari chain — {phase}': 'Refreshing from chain — {phase}',
  'Wallet yang aktif bisa butuh beberapa menit (tiap posisi dibaca state-nya di blok kejadian). Halaman ini boleh ditinggal — hasilnya disimpan dan tinggal dibuka lagi.':
    'An active wallet can take a few minutes (each position is read at the block of its event). You can leave this page — the result is stored and can be reopened later.',
  'Pindai gagal': 'Scan failed',
  '{e} — coba pindai ulang.': '{e} — try rescanning.',
  'Total profit (tertutup)': 'Total profit (closed)',
  'Posisi ditutup': 'Closed positions',
  'Win rate': 'Win rate',
  'Rata-rata modal': 'Average capital',
  'Fee didapat': 'Fees earned',
  'Laba per posisi': 'Profit per position',
  'Nilai posisi terbuka': 'Open position value',
  'Terbaik / terburuk': 'Best / worst',
  'Belum terealisasi': 'Unrealised',
  'Jadikan target': 'Make a target',
  'Sudah jadi target': 'Already a target',
  'Ditambahkan sebagai target': 'Added as a target',
  'dari riset wallet': 'from wallet research',
  '{n} posisi riwayatnya terpotong jendela pindai — tidak ikut dihitung. Perluas jendela untuk melengkapinya.':
    '{n} positions have history cut off by the scan window — excluded from the stats. Widen the window to complete them.',
  'Riwayat profit harian': 'Daily profit history',
  'Belum ada posisi tertutup di jendela ini': 'No closed positions in this window',
  'Total bulan ini': 'This month',
  'Bulan sebelumnya': 'Previous month',
  'Bulan berikutnya': 'Next month',
  'Posisi berjalan ({n})': 'Live positions ({n})',
  'Riwayat posisi ({n})': 'Position history ({n})',
  'Tidak ada posisi berjalan': 'No live positions',
  'Posisi / pool': 'Position / pool',
  'Fee total': 'Total fees',
  'uPnL': 'uPnL',
  'DPR': 'DPR',
  'parsial': 'partial',
  'Sebagian riwayat di luar jendela pindai': 'Part of the history is outside the scan window',
  'sudah ditarik {c} · belum diklaim {u}': 'withdrawn {c} · unclaimed {u}',
  'Total nilai': 'Total value',
  'Fee ditarik': 'Fees withdrawn',
  'Fee belum diklaim': 'Unclaimed fees',
  'nilai': 'value',
  'modal': 'capital',
  'fee': 'fees',
  'Total {n} posisi': 'Total {n} positions',
  'Pokok & fee dibaca dari state pool dan posisi tepat di blok tiap kejadian (node arsip). Posisi yang dibuka-tutup tanpa ada swap di rentangnya tercatat impas, bukan kalah.':
    'Principal and fees are read from pool and position state exactly at the block of each event (archive node). A position opened and closed with no swap inside its range is recorded as break-even, not a loss.',

  // rentang harga
  'Rentang {lo} – {hi}{q} per {b}': 'Range {lo} – {hi}{q} per {b}',
  'Harga masuk {p}': 'Entry price {p}',
  'Harga kini {p}{m}': 'Current price {p}{m}',
  'Harga keluar {p}{m}': 'Exit price {p}{m}',
  'Lebar {w}% ({x}×) · tick {lo} … {hi}': 'Width {w}% ({x}×) · ticks {lo} … {hi}',
  'masuk {p}': 'entry {p}',
  'keluar ': 'exit ',
  'di dalam · {n}% ke tepi bawah': 'in range · {n}% to lower edge',
  'di dalam · {n}% ke tepi atas': 'in range · {n}% to upper edge',
  'di luar · {n}% di bawah': 'out · {n}% below',
  'di luar · {n}% di atas': 'out · {n}% above',
  'harga masuk': 'entry price',
  'harga kini': 'current price',
  'harga keluar': 'exit price',

  // ---- scout ----
  'Potret cepat posisi yang sedang hidup: ukuran, lebar rentang, dan fee yang belum diklaim.':
    'A quick snapshot of live positions: size, range width and unclaimed fees.',
  'Periksa': 'Check',
  'Nilai posisi hidup': 'Live position value',
  '{n} posisi hidup': '{n} live positions',
  'Sedang in-range': 'Currently in range',
  'median umur {h} jam': 'median age {h} hours',
  'Ukuran & rentang khas': 'Typical size & range',
  'lebar median {w}%': 'median width {w}%',
  '{p}% dari nilai': '{p}% of value',
  'Posisi hidup': 'Live positions',
  '{n} posisi dilepas dalam jendela ini': '{n} positions released in this window',
  'Tidak ada posisi hidup': 'No live positions',
  'in': 'in',
  'luar': 'out',
  'Progres': 'Progress',

  // ---- pengaturan ----
  'Wallet & mode': 'Wallet & mode',
  'RPC': 'RPC',
  'Gas': 'Gas',
  'Notifikasi': 'Notifications',
  'Mesin': 'Engine',
  'Keamanan': 'Security',
  'Bagian pengaturan': 'Settings sections',
  'Wallet bot': 'Bot wallet',
  'Pakai wallet khusus bot, jangan wallet utama. Kunci privat disimpan di server':
    'Use a dedicated bot wallet, not your main one. The private key is stored on the server at',
  'dan tidak pernah ditampilkan lagi.': 'and is never shown again.',
  'Izin berkas kunci': 'Key file permissions',
  '600 · aman': '600 · safe',
  '{p} · terlalu longgar': '{p} · too permissive',
  'Belum ada wallet terpasang. Bot hanya bisa berjalan dalam mode simulasi.':
    'No wallet installed. The bot can only run in simulation mode.',
  'Mode: {m}': 'Mode: {m}',
  'Bot memutuskan dan mencatat, tapi tidak mengirim transaksi.':
    'The bot decides and records, but sends no transactions.',
  'Bot mengirim transaksi sungguhan dari wallet di atas.':
    'The bot sends real transactions from the wallet above.',
  'ketik LIVE': 'type LIVE',
  'Nyalakan LIVE': 'Turn on LIVE',
  'Kembali ke simulasi': 'Back to simulation',
  'Mode LIVE menyala': 'LIVE mode on',
  'Matikan mode LIVE dulu untuk mengganti wallet.': 'Turn off LIVE mode before changing the wallet.',
  'Impor kunci privat': 'Import private key',
  '0x… (64 karakter hex)': '0x… (64 hex characters)',
  'Impor': 'Import',
  'Buat wallet baru': 'Create a new wallet',
  'Kunci dibuat di server. Frasa pemulihan disimpan di sebelah berkas kunci.':
    'The key is generated on the server. The recovery phrase is stored next to the key file.',
  'Buat wallet': 'Create wallet',
  'Wallet {a} terpasang': 'Wallet {a} installed',
  'Wallet baru {a} dibuat': 'New wallet {a} created',
  'Ganti kunci yang sudah ada — kunci lama dipindah ke berkas cadangan, tidak dihapus':
    'Replace the existing key — the old key is moved to a backup file, not deleted',
  'Lepas wallet': 'Detach wallet',
  'ketik alamat wallet untuk konfirmasi': 'type the wallet address to confirm',
  'Lepas': 'Detach',
  'Wallet dilepas, kunci dicadangkan': 'Wallet detached, key backed up',
  'Endpoint RPC': 'RPC endpoints',
  'Permintaan dibagi otomatis: getLogs hanya ke endpoint yang sanggup, pembacaan state lampau hanya ke endpoint arsip, sisanya ke yang paling senggang. Perubahan berlaku tanpa restart.':
    'Requests are routed automatically: getLogs only to endpoints that support it, historical state reads only to archive endpoints, everything else to the least busy one. Changes take effect without a restart.',
  'tanpa getLogs': 'no getLogs',
  'getLogs ≤ {n} blok': 'getLogs ≤ {n} blocks',
  'getLogs penuh': 'full getLogs',
  'arsip': 'archive',
  'API key': 'API key',
  '{n} panggilan · {e} err': '{n} calls · {e} err',
  'istirahat': 'cooling down',
  'Ubah': 'Edit',
  'Uji': 'Test',
  'Tanpa getLogs': 'No getLogs',
  'Batas rentang getLogs': 'getLogs range limit',
  '0 = tanpa batas': '0 = no limit',
  'Node arsip': 'Archive node',
  'Hapus endpoint ini?': 'Delete this endpoint?',
  'Endpoint diperbarui': 'Endpoint updated',
  'Endpoint dihapus': 'Endpoint deleted',
  'Endpoint ditambahkan dan langsung dipakai': 'Endpoint added and in use immediately',
  'Tambah endpoint': 'Add endpoint',
  'URL': 'URL',
  'Kalau API key bagian dari URL (mis. Alchemy, Ankr), tempel URL lengkapnya — tetap disamarkan di tampilan.':
    'If the API key is part of the URL (e.g. Alchemy, Ankr), paste the full URL — it stays masked in the interface.',
  'Autentikasi': 'Authentication',
  'Tanpa header / key di URL': 'No header / key in URL',
  'Header x-api-key': 'x-api-key header',
  'Header Authorization: Bearer': 'Authorization: Bearer header',
  'Header lain…': 'Other header…',
  'Nama header': 'Header name',
  'mis. x-token': 'e.g. x-token',
  'Uji dulu': 'Test first',
  'Tidak bisa dipakai': 'Not usable',
  'Bendera yang akan dipasang:': 'Flags that will be set:',
  'Berlaku untuk transaksi berikutnya, tanpa restart.': 'Applies to the next transaction, without a restart.',
  'Pengali harga gas': 'Gas price multiplier',
  'Harga gas jaringan × angka ini. 1,5 = 50% di atas harga saat itu.':
    'Network gas price × this number. 1.5 = 50% above the current price.',
  'Priority fee (gwei)': 'Priority fee (gwei)',
  'Batas gas per transaksi': 'Gas limit per transaction',
  'Cadangan ETH untuk gas': 'ETH reserved for gas',
  'ETH sebanyak ini tidak pernah dipakai untuk LP maupun swap.':
    'This much ETH is never used for LP or swaps.',
  'Pengaturan gas tersimpan': 'Gas settings saved',
  'Kabar tiap posisi disalin atau ditutup, lewat ntfy.sh. Pasang aplikasi ntfy di HP lalu langganan topik yang sama.':
    'A notification whenever a position is copied or closed, via ntfy.sh. Install the ntfy app and subscribe to the same topic.',
  'Topik ntfy': 'ntfy topic',
  'Siapa pun yang tahu nama topiknya bisa membaca notifikasinya — pakai nama yang sulit ditebak. Kosongkan untuk mematikan.':
    'Anyone who knows the topic name can read the notifications — use a hard-to-guess name. Leave empty to disable.',
  'Topik tersimpan': 'Topic saved',
  'Kirim uji': 'Send test',
  'Notifikasi uji terkirim': 'Test notification sent',
  'Berlaku setelah bot di-restart (pm2 restart lpcopy).': 'Takes effect after the bot restarts (pm2 restart lpcopy).',
  'Interval pindai (ms)': 'Scan interval (ms)',
  'Seberapa sering blok baru diperiksa.': 'How often new blocks are checked.',
  'Blok per pindai': 'Blocks per scan',
  'Maks 3.000 — batas getLogs endpoint arsip.': 'Max 3,000 — the archive endpoint’s getLogs limit.',
  'Sinkron posisi (detik)': 'Position sync (seconds)',
  'Harga ETH cadangan (USD)': 'Fallback ETH price (USD)',
  'Dipakai hanya kalau harga dari pool ETH/USDG gagal dibaca.':
    'Used only if the price from the ETH/USDG pool cannot be read.',
  'Ambil harga ETH dari chain': 'Read ETH price from chain',
  'Tersimpan — restart bot supaya berlaku': 'Saved — restart the bot for it to take effect',
  'Dasbor ini bisa menyalakan LIVE dan menutup posisi, jadi dilindungi token akses.':
    'This dashboard can turn on LIVE mode and close positions, so it is protected by an access token.',
  'Ganti token akses': 'Rotate access token',
  'Token lama langsung tidak berlaku; perangkat lain harus masuk ulang. Browser ini tetap masuk.':
    'The old token stops working immediately; other devices must sign in again. This browser stays signed in.',
  'Buat token baru': 'Generate new token',
  'Ganti token akses? Perangkat lain harus masuk ulang.': 'Rotate the access token? Other devices must sign in again.',
  'Token baru — simpan sekarang, tidak akan ditampilkan lagi':
    'New token — save it now, it will not be shown again',
  'Salin': 'Copy',
  'Tersalin': 'Copied',

  // ---- skema aturan ----
  'Ukuran posisi': 'Position size',
  'Cara menentukan ukuran': 'How size is decided',
  'Sama persis dengan target': 'Exactly the same as the target',
  'Persen dari target': 'Percent of the target',
  'Kelipatan dari target': 'Multiple of the target',
  'Nominal tetap': 'Fixed amount',
  'mirror = likuiditas identik; pct/multiplier = skala; nominal tetap = modal sama tiap posisi':
    'mirror = identical liquidity; pct/multiplier = scaled; fixed = same capital every position',
  'Persen dari target (%)': 'Percent of the target (%)',
  'Kelipatan': 'Multiplier',
  'Nominal tetap (USD)': 'Fixed amount (USD)',
  'dipakai di pool berkuotasi USDG': 'used in USDG-quoted pools',
  'Nominal tetap (ETH)': 'Fixed amount (ETH)',
  'dipakai di pool berkuotasi ETH/WETH': 'used in ETH/WETH-quoted pools',
  'Minimum per posisi (USD)': 'Minimum per position (USD)',
  'Maksimum per posisi (USD)': 'Maximum per position (USD)',
  'Batas eksposur total (USD)': 'Total exposure cap (USD)',
  'Anggaran per hari (USD)': 'Daily budget (USD)',
  'Cara menentukan rentang': 'How the range is decided',
  'Lebar sama, dipusatkan harga kini': 'Same width, centred on the current price',
  'Lebar dikali faktor': 'Width times a factor',
  'Lebar tetap ±%': 'Fixed width ±%',
  'Full range': 'Full range',
  'Faktor lebar': 'Width factor',
  'Lebar ±%': 'Width ±%',
  'Lebar minimum (tick)': 'Minimum width (ticks)',
  'Posisi satu sisi': 'One-sided positions',
  'Kalau rentang di luar harga kini': 'When the range is outside the current price',
  'Tetap salin (jadi limit order)': 'Copy anyway (acts as a limit order)',
  'Lewati': 'Skip',
  'Geser ke harga kini': 'Shift to the current price',
  'Rentang yang seluruhnya di atas/bawah harga = posisi satu token saja':
    'A range entirely above/below the price holds only one token',
  'Batas nominal satu sisi (USD)': 'One-sided amount cap (USD)',
  'Auto-swap': 'Auto-swap',
  'Tukar otomatis kalau token kurang': 'Swap automatically when a token is short',
  'Slippage maksimum (bps)': 'Maximum slippage (bps)',
  'Dampak harga maksimum (bps)': 'Maximum price impact (bps)',
  'Keluar': 'Exit',
  'Ikut keluar saat target keluar': 'Exit when the target exits',
  'Ikut menarik sebagian (proporsional)': 'Mirror partial withdrawals (proportional)',
  'Tutup kalau di luar rentang selama (menit, 0=mati)': 'Close if out of range for (minutes, 0=off)',
  'Stop loss (%, 0=mati)': 'Stop loss (%, 0=off)',
  'Take profit (%, 0=mati)': 'Take profit (%, 0=off)',
  'Umur maksimum (jam, 0=mati)': 'Maximum age (hours, 0=off)',
  'Saringan': 'Filters',
  'Izinkan pool v4 dengan hook': 'Allow v4 pools with hooks',
  'Hook bisa memblokir penarikan — default: tolak': 'A hook can block withdrawals — default: refuse',
  'Abaikan posisi target di bawah (USD)': 'Ignore target positions below (USD)',
  'Maksimum posisi terbuka': 'Maximum open positions',
  'Jeda antar salinan di pool sama (detik)': 'Cooldown between copies in the same pool (seconds)',
  'Aset kuotasi diizinkan': 'Allowed quote assets',
  'Venue diizinkan': 'Allowed venues',
  'Daftar hitam token (alamat, pisah koma)': 'Token blacklist (addresses, comma separated)',
  'Daftar putih token (kosong = semua)': 'Token whitelist (empty = all)',

  // ---- alasan keputusan dari mesin ----
  // Kalimatnya dirangkai di server dengan nilai yang disisipkan, jadi diterjemahkan
  // per potongan: bagian tetapnya diganti, angka/alamat/pesan RPC dibiarkan apa adanya.
  'tidak ada cermin posisi yang cocok': 'no matching mirrored position',
  'posisi dititipkan ke kontrak otomasi — bukan sinyal keluar':
    'position handed to an automation contract — not an exit signal',
  'posisi dikembalikan dari kontrak otomasi': 'position returned from the automation contract',
  'target menerima posisi dari wallet lain — tidak dicermin':
    'target received a position from another wallet — not mirrored',
  'target memindahkan posisinya': 'target moved its position away',
  'target sedang dimatikan': 'target is disabled',
  'bot sedang dijeda': 'bot is paused',
  'ikut-keluar dimatikan': 'exit-following is off',
  'aksi lampau — mesin sedang mati saat itu': 'past action — the engine was down at the time',
  'tanpa wallet': 'no wallet',
  'tutup penuh': 'fully closed',
  'kurangi': 'reduced',

  // ---- potongan alasan (pengganti sebagian) ----
  '@simulasi GAGAL:': 'simulation FAILED:',
  '@simulasi OK': 'simulation OK',
  '@jenis aksi': 'action type',
  '@tidak dicermin': 'not mirrored',
  '@cooldown pool': 'pool cooldown',
  '@posisi target cuma': 'target position is only',
  '@pool baru': 'pool is only',
  '@menit': 'minutes old',
  '@fee tier': 'fee tier',
  '@di atas batas': 'above the limit',
  '@pool memakai hook': 'pool uses hook',
  '@(hook bisa mengunci penarikan)': '(a hook can lock withdrawals)',
  '@posisi satu sisi': 'one-sided position',
  '@dan aturannya lewati': 'and the rule says skip',
  '@dipotong oleh': 'capped by',
  '@batas per posisi': 'per-position cap',
  '@sisa jatah eksposur total': 'remaining total exposure',
  '@sisa anggaran harian': 'remaining daily budget',
  '@habis': 'exhausted',
  '@hasilnya': 'result is',
  '@(< minimum': '(< minimum',
  '@menambah posisi': 'adding to position',
  '@kas kurang untuk jembatan: butuh': 'not enough cash to bridge: need',
  '@punya': 'have',
  '@saldo kurang untuk zap: butuh': 'not enough balance to zap: need',
  '@kosong — tidak ada kas untuk dijembatani': 'is empty — no cash to bridge',
  '@jembatan menggeser harga': 'bridging would move the price',
  '@(batas': '(limit',
  '@ukuran dipangkas ke saldo nyata': 'size trimmed to the real balance',
  '@zap beli token0': 'zap buy token0',
  '@zap beli token1': 'zap buy token1',
  '@gagal': 'failed',
  '@nilai posisi terbaca': 'position value read',
  '@pool tanpa aset kuotasi yang dikenal (USDG/ETH)': 'pool has no known quote asset (USDG/ETH)',
  '@token masuk daftar hitam': 'token is blacklisted',
  '@token di luar daftar putih': 'token is not on the whitelist',
  '@jumlah posisi terbuka sudah mentok': 'open position limit reached',
  '@state pool tidak terbaca': 'pool state unreadable',
  '@venue': 'venue',
  '@dimatikan': 'disabled',

  // ---- waktu ----
  '{n} dtk lalu': '{n} sec ago',
  '{n} mnt lalu': '{n} min ago',
  '{n} jam lalu': '{n} hr ago',
  '{n} hari lalu': '{n} days ago',
  '{n} dtk': '{n} sec',
  '{n} mnt {s} dtk': '{n} min {s} sec',
  '{n} mnt': '{n} min',
  '{n} jam': '{n} hr',
  '{n} hari': '{n} days',
  ' j': ' h',
  ' hr': ' d',
};

const DICT = { id: null, en: EN };

// Alasan dari mesin: coba padanan utuh, kalau tidak ada ganti potongan yang dikenal.
// Sisanya (angka, alamat, pesan error RPC) dibiarkan apa adanya — memang bukan
// kalimat kita, dan pesan RPC aslinya berbahasa Inggris.
export function reason(text) {
  if (!text) return text;
  if (current !== 'en') return text;
  if (EN[text]) return EN[text];
  let out = text;
  for (const [k, v] of Object.entries(EN)) {
    if (k[0] !== '@') continue;
    const frag = k.slice(1);
    if (out.includes(frag)) out = out.split(frag).join(v);
  }
  return out;
}

export function translate(text, vars) {
  const table = DICT[current];
  let out = (table && table[text]) || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

// Hook: komponen ikut tergambar ulang saat bahasa diganti.
const Ctx = createContext('id');
export function I18nProvider({ children }) {
  const [locale, setL] = useState(getLocale());
  useEffect(() => {
    const f = (l) => setL(l);
    listeners.add(f);
    return () => listeners.delete(f);
  }, []);
  // AriaI18n menyamakan locale internal React Aria dengan pilihan bahasa di sini,
  // sehingga arah teks dan format bawaannya ikut. Teks yang dibacakan pembaca layar
  // ("sortable column", "sorted by column in descending order") tetap Inggris:
  // React Aria memang tidak mengirim berkas bahasa Indonesia (lihat
  // node_modules/react-aria/dist/private/intl/table/ — tidak ada id-ID), dan itu
  // milik pustaka, bukan kamus kita.
  return (
    <Ctx.Provider value={locale}>
      <AriaI18n locale={locale === 'en' ? 'en-US' : 'id-ID'}>{children}</AriaI18n>
    </Ctx.Provider>
  );
}
export function useI18n() {
  const locale = useContext(Ctx);
  return { t: translate, locale, setLocale };
}
export const t = translate;
