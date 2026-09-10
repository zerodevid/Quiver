# lpcopy — copy-LP untuk Robinhood Chain

Mencermin posisi likuiditas (LP) Uniswap **v4 dan v3** dari satu atau banyak wallet
target di Robinhood Chain (chainId 4663), dengan dashboard untuk memantau dan menyetel
semuanya. Default-nya **mode simulasi** — tidak mengirim transaksi sampai kamu
menyalakannya sendiri.

```
./lp                       # jalankan mesin + dashboard (http://127.0.0.1:8799)
./lp scout 0xABC… [blok]   # periksa sebuah wallet sebelum dicopy
./lp add 0xABC… "label"    # tambah target dari terminal
./lp list                  # daftar target
```

## Di mana jalannya

**Produksi: VPS Singapore** (`ssh singapore`), sebagai proses pm2 `lpcopy`.
Dasbor: URL tunnel kamu sendiri (lewat cloudflared tunnel, butuh token akses).

```bash
ssh singapore
pm2 status lpcopy          # status
pm2 restart lpcopy         # restart
pm2 logs lpcopy --lines 50 # log
pm2 stop lpcopy            # hentikan
```

Kenapa Singapore, bukan zeroserver: latensi RPC **281ms stabil** vs **465ms sangat
berayun** (346–731ms) di zeroserver, dan DNS-nya bersih — zeroserver kena hijack
Telkomsel yang sama seperti Mac. Kestabilan lebih penting daripada angka rata-rata.

**Deploy ulang setelah edit di Mac.** Kirim kode saja; `config.json`, `data/`, dan
`logs/` hidup di server (config berisi token akses, data berisi kursor blok — kalau
ikut ter-push, kursor mundur dan aksi lama dinilai ulang).

```bash
cd ~/lpcopy
rsync -az --exclude node_modules --exclude data --exclude logs --exclude config.json \
  src public package.json README.md lp singapore:~/lpcopy/
ssh singapore 'pm2 restart lpcopy'
```

**Token akses** ada di `~/lpcopy/config.json` di server (`server.auth_token`, chmod 600).
Dasbor ini bisa menyalakan mode LIVE dan menutup posisi, jadi ia tidak boleh terbuka
tanpa token begitu diekspos — token kosong = gerbang mati (hanya aman untuk 127.0.0.1).

## Cara kerjanya

**Deteksi lewat event, bukan decode transaksi.** Target contoh (`0xe1d7…3e79`) memakai
tiga jalur sekaligus: PositionManager langsung, `V4UtilsRouter` (layanan otomasi
ber-role `AUTOMATION_OPERATOR`), dan UniversalRouter. Kalau bot membaca calldata, ia
harus mengejar setiap router baru selamanya. Semua jalur itu bermuara ke event yang
sama, jadi itulah yang dipantau:

| Venue | Sumber | Cara mengenali pemilik |
|---|---|---|
| Uniswap v4 | `PoolManager.ModifyLiquidity` | `salt` event = `tokenId` PositionManager → `ownerOf` |
| Uniswap v3 | `NPM.IncreaseLiquidity` / `DecreaseLiquidity` | `tokenId` terindeks → `ownerOf` |
| keduanya | `Transfer` ERC-721 | posisi berpindah/dibakar |

Alamat yang terpakai (semua diverifikasi di chain):

```
PoolManager v4    0x8366a39cc670b4001a1121b8f6a443a643e40951
PositionManager   0x58daec3116aae6d93017baaea7749052e8a04fa7
NPM v3            0x73991a25c818bf1f1128deaab1492d45638de0d3
UniversalRouter   0x8876789976decbfcbbbe364623c63652db8c0904
Permit2           0x000000000022d473030f116ddee9f6b43ac78ba3
USDG (6 desimal)  0x5fc5360d0400a0fd4f2af552add042d716f1d168
WETH9             0x0bd7d308f8e1639fab988df18a8011f41eacad73
```

## Tabel posisi

Tiap baris: lambang pasangan, chip venue + tokenId, umur, modal, nilai, fee total
(sudah ditarik + belum diklaim, rinciannya di tooltip), PnL, DPR, rentang harga, dan
waktu. Ada ringkasan di kepala panel dan baris total di kaki tabel.

**Logo token**: Blockscout menyimpan `icon_url` tiap token, tapi Blockscout membalas
403 dari server (Cloudflare memeriksa sidik jari TLS — header apa pun tidak menolong),
sementara CDN gambarnya sendiri bisa diakses. Karena aset kuotasi (USDG/WETH/ETH)
selalu menjadi salah satu dari setiap pasangan, logo ketiganya diunduh sekali ke
`web/public/tokens/` dan disajikan dari server sendiri — jadi setiap baris pasti punya
minimal satu logo asli, tanpa permintaan ke pihak ketiga. Memecoin memang tidak punya
logo di mana pun, jadi memakai lambang yang dibangkitkan dari alamatnya (warna selalu
sama untuk alamat yang sama).

## Kolom rentang

Menampilkan rentang **harga** posisi (mis. `0,00032 – 0,00201 USDG`), bar sumbu
logaritmik dengan penanda harga sekarang, dan jarak ke tepi terdekat
(`di dalam · 27% ke tepi atas`) — yaitu berapa persen harga harus bergerak sebelum
posisi berhenti menghasilkan fee. Sebelumnya kolom ini hanya menampilkan lebar dalam
persen, yang tidak memberi tahu di harga berapa posisi bekerja.

Arahnya ditentukan `quoteSide`: kalau aset kuotasi berada di token0 (mis. pool
USDG/MEME), harga token spekulatif adalah **kebalikan** dari tick — `tickLower` justru
menghasilkan harga tertinggi. Diverifikasi dengan membandingkan dua susunan pool yang
setara: keduanya menghasilkan angka yang sama.

## Riset wallet (tab **Wallet**)

Buka wallet mana pun → total profit, win rate, fee, rata-rata modal, kalender profit
harian, posisi berjalan, dan seluruh riwayat posisi. Semua disimpan di SQLite
(`wallets`, `wpositions`, `wevents`, `wprices`), jadi membuka ulang tidak memanggil chain.
Tombol ⟳ memindai ulang; opsi **Semua riwayat** memindai sejak awal chain (~10 menit
untuk ~150 posisi, sekali saja).

Dibandingkan dengan LP Agent untuk `0x4876…80a0` (seluruh riwayat): posisi ditutup
145 vs 146, win rate 81,55% vs 82,39%, fee $2.620,46 vs $2,62k, rata-rata modal
$591,91 vs $589,08. API LP Agent sendiri tidak bisa dipakai — dijaga Cloudflare,
403 bahkan untuk browser sungguhan.

**Cara menghitungnya — dan kenapa bukan dari Transfer token.** Versi pertama menghitung
modal/hasil dari Transfer ERC20 di tiap transaksi. Itu gagal pada **rebalance otomatis**:
router menutup posisi lama dan membuka yang baru dalam satu unlock, flash accounting
PoolManager me-netting dananya, dan **tidak ada Transfer sama sekali** — 42 posisi
terbaca "hasil = modal, fee nol", dan win rate jatuh ke 57%. Versi sekarang membaca
state pool dan posisi **di blok sebelum tiap kejadian** lewat node arsip:
- pokok = dari L, rentang, dan `sqrtPriceX96` saat itu
- fee = `L × (feeGrowthInside − feeGrowthInsideLast) / 2^128` saat itu

Keduanya eksak (fee hasil metode ini identik sampai digit terakhir dengan
"token keluar − pokok" pada transaksi yang tidak ter-netting). Kejadian **klaim fee**
(delta likuiditas nol) juga dihitung — versi awal melewatinya dan kehilangan
$6,68 fee pada satu posisi.

**Node arsip: hanya `rpc.ordofi.network`** (`archive: true` di config). Endpoint resmi
membalas "metadata is not found" untuk blok lampau, publicnode 403. Tanpa node arsip,
mesin jatuh ke cadangan: harga dari event Swap terdekat (bisa meleset untuk memecoin)
+ jumlah dari Transfer, dengan pengaman bahwa pokok tidak boleh melebihi yang diterima.

**Batas getLogs per endpoint** (`max_log_blocks`): ordofi menggantung ~60 detik lalu
membalas "network is busy" untuk rentang 40rb blok, sedangkan endpoint resmi menjawab
query terfilter alamat untuk **900rb blok dalam 0,34 detik**. Itulah kenapa enumerasi
memakai potongan 1 juta blok dan ordofi dibatasi 3.000 blok (cukup untuk mesin copy yang
cuma memindai blok terbaru).

## Yang bisa disetel

Semua ada di dashboard (tab **Aturan**), bisa global maupun **per wallet target**.

**Ukuran posisi** — `mirror` (likuiditas identik dengan target), `pct` (persen dari
target), `multiplier` (kelipatan, boleh > 1), atau `fixed_quote` (modal tetap tiap
posisi, dalam USD atau ETH). Semua tetap tunduk pada batas per posisi, batas eksposur
total, dan anggaran harian — kalau kena batas, ukuran dipotong proporsional, bukan
dibatalkan.

**Rentang harga** — `exact` (sama persis), `recenter` (lebar sama, dipusatkan ke harga
sekarang), `scale` (lebar dikali faktor), `width_pct` (lebar tetap ±X% dari harga
sekarang), `full` (full range). Semua dibulatkan ke `tickSpacing` pool.

**Posisi satu sisi** — kalau rentang target seluruhnya di atas/bawah harga sekarang,
posisi itu isinya satu token saja (praktis sebuah limit order). Pilihannya: tetap salin,
lewati, atau geser ke harga sekarang.

**Auto-swap — dua tingkat.** Pool di chain ini tidak selalu berkuotasi USDG: dari 5.901
pool v4 baru dalam ~12 jam, **50% berkuotasi ETH native** dan hanya 26,8% USDG (WETH 4,3%).
Kas yang cuma ada di satu aset akan memblokir separuh peluang, jadi ada dua tingkat:

1. **Jembatan kas** (`ensureQuoteAsset`) — memastikan kita memegang aset kuotasi pool
   yang dituju. ETH native ↔ WETH lewat `deposit()`/`withdraw()` (1:1, tanpa slippage);
   USDG ↔ ETH lewat pool ETH/USDG terdalam. Contoh nyata: menukar $10 USDG→ETH di pool
   terdalam menggeser harga cuma **0,007 bps**, $1.000 pun cuma 0,74 bps.
2. **Zap di dalam pool** — menukar sebagian aset kuotasi menjadi token spekulatifnya,
   lalu **menghitung ulang ukuran dari saldo nyata** setelah swap (lebih tahan slippage
   daripada memakai angka rencana).

Keduanya dibatasi slippage dan dampak harga; swap yang menggeser harga melebihi batas
ditolak, bukan dipaksakan.

**Kenapa jembatan boleh lewat pool ber-hook padahal LP tidak.** Semua 16 pool ETH/USDG
di chain ini memakai hook (fee `8388608` = flag dynamic-fee). Untuk *swap* itu jauh lebih
aman daripada untuk *LP*: swap bersifat atomik dan dijaga `amountOutMinimum` — hook tidak
bisa menahan dana kita, paling buruk transaksinya revert. Yang berbahaya adalah hook pada
pool tempat kita menaruh likuiditas, karena bisa memblokir `beforeRemoveLiquidity` dan
mengunci modal. Karena itu saringan "tolak hook" berlaku untuk LP, sengaja tidak untuk
jembatan.

**Keluar** — ikut keluar saat target keluar (penuh atau proporsional), plus pemicu
mandiri: di luar rentang selama N menit, stop loss, take profit, umur maksimum.

**Saringan** — tolak pool v4 ber-hook (hook bisa memblokir penarikan), umur pool minimum,
nilai minimum posisi target, batas jumlah posisi, jeda antar salinan di pool yang sama,
daftar hitam/putih token, aset kuotasi yang diizinkan, venue yang diizinkan.

## Menyalakan mode live

1. Simpan private key wallet (**bukan** wallet utama):
   ```
   mkdir -p ~/.lpcopy && echo "0xKUNCI" > ~/.lpcopy/key && chmod 600 ~/.lpcopy/key
   ```
   Bot menolak jalan kalau izin file-nya lebih longgar dari 600.
2. Isi wallet itu dengan USDG dan sedikit ETH untuk gas.
3. Di dashboard, ubah badge **SIMULASI → LIVE** (atau `mode.dry_run: false` di
   `config.json`).

Transaksi pertama untuk tiap token akan menambah 2 transaksi izin (ERC20 → Permit2,
lalu Permit2 → PositionManager). Itu sekali saja per token.

## RPC: tiga endpoint, dirutekan per metode

`eth_getLogs` dan `eth_call` tidak dilayani sama baiknya oleh endpoint yang sama, jadi
kolam RPC memilih endpoint berdasarkan metode yang dipanggil, lalu menyebar beban ke
yang paling senggang (menghajar satu endpoint terus-menerus persis yang memicu 429).

| Endpoint | eth_call | eth_getLogs | Catatan |
|---|---|---|---|
| `robinhood-rpc.publicnode.com` | ~93 ms | **ditolak** | tercepat; getLogs di luar ~10 blok terakhir dijawab "Archive requests require a personal token" |
| `rpc.mainnet.chain.robinhood.com` | ~250 ms | ya | resmi; membalas 429 kalau dihajar beruntun |
| `rpc.ordofi.network` | ~232 ms | ya (lambat, ~4,5 s) | cadangan penuh |

Yang **tidak** dipakai, sudah diuji: `robinhood.drpc.org` (tier gratis cuma melayani
`eth_chainId`; `eth_call`, `eth_getLogs`, bahkan `eth_blockNumber` semuanya ditolak —
kelihatan hidup dan cepat kalau cuma dites dengan chainId), `rpc.arrowrpc.com` (mati),
`robinhoodchain.blockscout.com/api/eth-rpc` (di balik Cloudflare).

**Watcher memakai `rpc.getLogs` paralel, bukan satu batch.** Menyatukan tiga query
pemindaian ke dalam satu batch JSON-RPC memang hemat satu round-trip, tapi kalau satu
sub-query ditolak upstream karena kapasitas, seluruh siklus gagal tanpa kesempatan
pindah endpoint — dan mengecilkan rentang tidak menolong kalau penolakannya bukan soal
ukuran. Tiga panggilan terpisah masing-masing dapat failover.

**Kursor blok memakai kepala TERENDAH** di antara semua endpoint (`safeHead`). Endpoint
bisa berbeda 10–20 blok; kalau kursor dimajukan ke kepala endpoint tercepat sementara
`getLogs` dilayani endpoint yang tertinggal, blok di antaranya hilang selamanya karena
kursor sudah terlanjur lewat.

## Catatan teknis yang mahal ditemukan

- **DNS `rpc.mainnet.chain.robinhood.com` dibajak ISP** (Telkomsel) ke portal
  `internetbaik.telkomsel.com`, sehingga TLS gagal. `src/rpc.js` menyelesaikannya lewat
  DoH 1.1.1.1 lalu menyematkan IP ke koneksi sambil mempertahankan SNI asli. Node ≥20
  memanggil `lookup` dengan `{all:true}`, jadi callback-nya **harus** mengembalikan array
  — kalau tidak, errornya `ERR_INVALID_IP_ADDRESS: undefined`.
- **Router RPC Vercel milik user (`robinhood-rpc-router.vercel.app`) sudah mati**
  (`DEPLOYMENT_DISABLED` / Payment required). Sekarang endpoint resmi yang dipakai.
- **`eth_getLogs` bisa timeout diam-diam.** Versi pertama `scout` menelan kegagalan query
  dan melaporkan "wallet tidak punya posisi" padahal punya 50+. Sekarang setiap kegagalan
  memecah rentang secara rekursif (`getLogsSafe`), dan kalau tetap gagal ia dilempar.
- **Encoding v4 dicocokkan dengan calldata asli di chain**, bukan dari ingatan:
  `0x020d` = MINT_POSITION + SETTLE_PAIR, `0x020d14` menambahkan SWEEP untuk ETH native,
  `0x0111` = DECREASE + TAKE_PAIR. Encoder mint diuji lewat `eth_estimateGas` memakai
  `from` seorang LP nyata dan berhasil (gas 279.108).
- **Layout storage PoolManager**: mapping `_pools` di slot 6; di dalamnya `+1/+2`
  feeGrowthGlobal, `+3` likuiditas, `+4` ticks, `+6` positions. Diverifikasi karena
  likuiditas hasil baca storage identik dengan `getPositionLiquidity(tokenId)`.
  Ini yang membuat **fee belum diklaim bisa dihitung eksak**, bukan ditaksir.
- **Rumus `feeGrowthAbove` gampang terbalik.** Kalau `tickCurrent < tickUpper`,
  nilainya `upper.feeGrowthOutside` — *bukan* `global − outside`. Salah arah membuat
  hasilnya membungkus jadi angka 10^48.
- **Perpindahan NFT posisi ≠ target keluar.** Layanan otomasi yang dipakai target
  *menitipkan* NFT posisi ke routernya lalu mengembalikannya di transaksi yang sama.
  Terlihat jelas di dashboard: tiap `increase` selalu diapit `transfer_out` +
  `transfer_in`. Kalau itu dibaca sebagai "target keluar", di mode live bot akan
  menutup posisi yang masih hidup. Sekarang perpindahan ke/dari sebuah **kontrak**
  diklasifikasikan `custody_out`/`custody_in` dan tidak memicu apa pun; hanya
  perpindahan ke alamat biasa yang dihitung sebagai pelepasan.
- **Aksi lampau tidak dieksekusi di mode live.** Kalau mesin mati beberapa jam lalu
  hidup lagi, aksi yang tertinggal dinilai ulang — tapi di mode LIVE yang lebih tua
  dari `stale_action_seconds` (default 300) otomatis dilewat. Sinyal LP basi bukan
  sinyal.
- **Encoding swap v4 juga dicocokkan dengan chain**: actions `0x060c0f`
  (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL). Diverifikasi dengan membangun ulang
  sebuah swap nyata memakai encoder kita — parameternya keluar **identik byte-per-byte**.
- **WETH9 di chain ini proxy EIP-1967** (impl `0xc6b81b429797e0f555440b70cd99e032d7ae947e`).
  Mencari selektor `deposit()`/`withdraw()` di bytecode proxy akan gagal — harus dicek di
  implementasinya. Simulasi wrap berhasil (gas 58.498).
- **Node arsip tidak tersedia**, jadi nilai posisi selalu dihitung pada harga sekarang.
  Untuk keperluan menyalin itu justru benar — kita membuka posisi sekarang, bukan dulu.
- Harga ETH diturunkan sendiri dari pool ETH/USDG di chain ini (16 pool ditemukan lewat
  event `Initialize` yang mengindeks kedua currency). Hasilnya $2.479,07 vs $2.477,42
  menurut Blockscout — selisih 0,07%.

## Batasan yang perlu diketahui

- **Pool v4 dengan hook tidak dicermin** secara default. Hook bisa menolak penarikan.
  Bisa dinyalakan di saringan kalau kamu paham risikonya.
- LP yang dibuat lewat kontrak hook (mis. `DopplerHookInitializer` milik launchpad)
  tidak punya NFT sehingga kepemilikannya tidak bisa ditelusuri — jumlahnya ditampilkan
  di API `overview.unsupportedSenders` supaya kamu tahu apa yang terlewat.
- Swap dan mint masih **dua transaksi terpisah**. UniversalRouter di chain ini mendukung
  `V4_POSITION_MANAGER_CALL` (0x14), jadi versi atomik satu transaksi mungkin — belum dibuat.
- Fee v3 dibaca dengan mensimulasikan `collect` lewat `eth_call`; butuh wallet terisi
  supaya simulasinya jalan.
- `scout` hanya melihat sejauh jendela pindainya. Posisi yang dibuka sebelum jendela
  tidak terhitung, dan angka itu ditampilkan apa adanya di rapor.

## Dwibahasa (Indonesia / Inggris)

Pemilih bahasa ada di kaki sidebar; pilihannya disimpan di browser, dan bahasa awal
mengikuti pengaturan sistem. Angka dan tanggal ikut berubah — Indonesia memakai koma
desimal (`$0,00`, `59.451.560`), Inggris memakai titik (`$0.00`, `59,451,416`).

Kamusnya di `web/src/i18n.jsx` dan memakai **teks Indonesia sebagai kunci**. Alasannya:
kalau sebuah terjemahan terlewat, yang muncul tetap kalimat Indonesia yang benar — bukan
kunci mentah atau teks kosong. Untuk dua bahasa, itu menghapus seluruh kelas bug
"kunci tidak ketemu".

Alasan keputusan dari mesin (`decisions.reason`) dirangkai di server dengan nilai yang
disisipkan, jadi diterjemahkan per potongan lewat `reason()`; angka, alamat, dan pesan
error RPC dibiarkan apa adanya karena memang bukan kalimat kita.

Dua pemeriksaan yang dipakai saat mengembangkan (keduanya bersih):

```bash
cd web && python3 check-keys.py   # setiap t('…') di kode ada padanannya di kamus
cd web && python3 audit-i18n.py   # render tiap halaman di kedua bahasa, cari teks yang identik
```

## Tampilan (React + HeroUI v3)

Sumbernya di `web/` (Vite + React 19 + HeroUI v3 + Tailwind v4 + lucide-react + recharts),
hasil build di `web/dist` yang disajikan `src/server.js`. Kalau `web/dist` belum ada,
server jatuh ke tampilan lama di `public/`.

```bash
cd web && npm install      # sekali
npx vite                   # dev, API diproksikan ke 127.0.0.1:8799
npx vite build             # build (deploy.sh melakukannya otomatis)
```

Catatan HeroUI **v3** (bukan v2/NextUI): API-nya compound (`Card.Header`, `Select.Trigger`,
`Table.Content`), tanpa Provider, tema gelap lewat class `dark` di `<html>`, React 19 +
Tailwind v4 wajib. Dokumentasi untuk agen: `https://heroui.com/react/llms-full.txt`.
Semua sudut diturunkan dari `--radius` (diset 0,375rem supaya lebih klasik; tombol bawaannya
berbentuk pil). Halaman dimuat terpisah (`React.lazy`) — beban awal 79 KB gzip.

Cache: `/assets/*` hasil Vite bernama-hash -> `private, immutable` (browser menyimpan,
Cloudflare tidak, karena ada di balik gerbang token); `index.html` selalu `no-store`.

## Struktur

```
src/chain.js      alamat kontrak, ABI, konstanta Actions/Commands
src/rpc.js        kolam RPC + DoH pinning + failover + antrean
src/db.js         skema SQLite
src/v3math.js     matematika tick/likuiditas (diuji dgn vektor resmi Uniswap)
src/pools.js      state pool, metadata token, harga ETH, umur pool
src/fees.js       fee belum diklaim dari storage PoolManager
src/watcher.js    deteksi aksi LP target
src/policy.js     mesin aturan: ukuran, rentang, saringan
src/executor.js   pembangun & pengirim transaksi
src/positions.js  sinkron posisi, PnL, IL, pemicu keluar
src/scout.js      rapor wallet kandidat
src/engine.js     orkestrator
src/server.js     API + penyaji dashboard
web/              tampilan React + HeroUI v3 (sumber); web/dist = hasil build
public/           tampilan lama (Tabler) — cadangan kalau web/dist belum dibuild
```

## Uji edge case

`node test/edge.js` menjalankan 21 skenario berisiko lewat mesin asli (policy,
engine, watcher) dengan chain dan pengiriman transaksi dipalsukan — jadi bisa
dijalankan kapan saja tanpa menyentuh dana. Yang diuji antara lain: target
menambah ke posisi yang sudah dicermin, penarikan sebagian, NFT dipindahkan,
penitipan ke kontrak otomasi, pool berhook, semua batas (jumlah posisi,
eksposur, jeda, minimum), posisi satu sisi, saldo kurang, aksi ganda, dan
antrean jual memecoin sisa.

Untuk menguji transaksi NYATA dari wallet target tanpa mengirim apa pun, lihat
catatan di commit "dry-run cermin Bang GE": kode bot dijalankan apa adanya tetapi
setiap `exec.send` dicegat dan dieksekusi berantai lewat `eth_simulateV1` pada
satu blok yang dikunci, sehingga swap → mint → burn → jual sisa saling melihat
perubahan state.
