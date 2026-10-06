'use strict';
// Setup page — a single file, rendered by the server, without a build.
//
// The reason is the same as the sign-in page in server.js: when this page is needed,
// `npm ci --prefix web && npm run build --prefix web` has not necessarily ever run.
// So no React, no imports, no second asset request — only the design language is
// followed (Inter, flat bordered cards, light/dark theme from
// localStorage 'lpcopy-theme').
//
// Bilingual with exactly the same pattern as the dashboard (web/src/i18n.jsx): the Indonesian
// sentence is used as the key, the EN map below translates it. A missed translation
// = a correct Indonesian sentence, not a raw key. The DIFFERENCE from the dashboard:
// here the default is ENGLISH, because someone who has just installed may not be able to
// read Indonesian. The choice is stored in the same localStorage key
// ('lpcopy-lang'), so the dashboard continues with the language chosen in the wizard.
//
// The JS inside deliberately avoids template literals so this file stays easy to read
// as a single Node template literal (no ${…} that must be escaped).

const MARK = '<svg width="132" height="24" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 48" role="img" aria-label="QUIVER"><g fill="currentColor" fill-rule="evenodd"><path d="M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0ZM43 11L51 3L73 24L51 46L43 38L56 24Z"/><path d="M99 9C88 9 82 15 82 24S88 39 99 39C102 39 105 38 107 37L113 43L118 38L112 32C114 30 115 27 115 24C115 15 109 9 99 9ZM99 15C105 15 108 18 108 24S105 33 99 33S89 30 89 24S93 15 99 15Z M120 10H127V27C127 31 130 33 134 33S141 31 141 27V10H148V27C148 35 143 39 134 39S120 35 120 27Z M154 10H161V38H154Z M166 10H174L183 31L192 10H200L187 38H179Z M204 10H229V16H211V21H227V27H211V32H229V38H204Z M234 10H250C258 10 262 14 262 20C262 24 260 27 256 28L264 38H255L248 29H241V38H234ZM241 16V23H249C253 23 255 22 255 20S253 16 249 16Z"/></g></svg>';

const CSS = `
:root{color-scheme:light;--bg:oklch(.975 .003 286);--surface:#fff;--sunken:oklch(.985 .002 286);--fg:oklch(.2 .006 286);--muted:oklch(.5 .006 286);--border:oklch(.885 .004 286);--field-border:oklch(.7 .005 286);--accent:oklch(.55 .175 257);--accent-fg:#fff;--danger:oklch(.545 .185 27);--ok:oklch(.52 .14 155);--gold:#B8892A}
:root.dark{color-scheme:dark;--bg:oklch(.165 .005 286);--surface:oklch(.215 .006 286);--sunken:oklch(.19 .005 286);--fg:oklch(.94 .004 286);--muted:oklch(.66 .006 286);--border:oklch(.29 .006 286);--field-border:oklch(.45 .006 286);--accent:oklch(.68 .16 256);--accent-fg:oklch(.15 .02 256);--danger:oklch(.71 .175 22);--ok:oklch(.72 .15 155);--gold:#D9AE45}
*{box-sizing:border-box}
html{font-size:15px;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;align-items:flex-start;justify-content:center;padding:2.5rem 1rem 4rem;background:var(--bg);color:var(--fg);font:400 1rem/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(60rem 30rem at 50% -10%,color-mix(in oklab,var(--gold) 9%,transparent),transparent 70%)}
.shell{width:100%;max-width:41rem;background:var(--surface);border:1px solid var(--border);border-radius:.875rem;box-shadow:0 1px 2px rgb(0 0 0/.04),0 16px 48px -16px rgb(0 0 0/.14);overflow:hidden}
.dark .shell{box-shadow:0 1px 0 rgb(255 255 255/.03) inset,0 24px 60px -24px rgb(0 0 0/.6)}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.125rem 1.5rem;border-bottom:1px solid var(--border);background:var(--sunken)}
.top .mark{display:flex;align-items:center;gap:.625rem;color:var(--fg);min-width:0}
.top .mark b{font-size:.75rem;font-weight:500;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}
.top .kanan{display:flex;align-items:center;gap:.875rem;flex:none}
.lang{display:flex;border:1px solid var(--border);border-radius:.375rem;overflow:hidden}
.lang button{height:1.5rem;padding:0 .4375rem;border:0;border-radius:0;background:transparent;color:var(--muted);font-size:.6875rem;font-weight:600;letter-spacing:.03em}
.lang button+button{border-left:1px solid var(--border)}
.lang button[aria-pressed=true]{background:var(--accent);color:var(--accent-fg)}
.lang button:hover:not([aria-pressed=true]){background:color-mix(in oklab,var(--fg) 6%,transparent);color:var(--fg)}
.dots{display:flex;align-items:center;gap:.375rem}
.dots i{width:.5rem;height:.5rem;border-radius:50%;background:var(--border);transition:background .2s,transform .2s}
.dots i.done{background:color-mix(in oklab,var(--accent) 45%,var(--border))}
.dots i.now{background:var(--accent);transform:scale(1.25)}
@media (max-width:26rem){.top .mark b{display:none}}
.pane{padding:1.75rem 1.5rem 1.5rem;animation:in .25s cubic-bezier(.2,.7,.2,1) both}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.pane{animation:none}}
h2{margin:0 0 .25rem;font-size:1.0625rem;font-weight:600;letter-spacing:-.01em}
.lede{margin:0 0 1.25rem;color:var(--muted);font-size:.8438rem;line-height:1.5;text-wrap:pretty}
.row{margin-bottom:1rem}
.row:last-child{margin-bottom:0}
label{display:block;font-size:.8125rem;font-weight:500;margin-bottom:.375rem}
.hint{margin:.375rem 0 0;color:var(--muted);font-size:.75rem;line-height:1.45}
.hint code,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:color-mix(in oklab,var(--fg) 6%,transparent);padding:.05rem .3rem;border-radius:.25rem}
input,select{width:100%;height:2.5rem;padding:0 .75rem;border:1px solid var(--field-border);border-radius:.375rem;background:var(--surface);color:var(--fg);font:inherit;font-size:.9063rem;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 20%,transparent)}
input[type=checkbox],input[type=radio]{width:auto;height:auto;margin:0;accent-color:var(--accent)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
@media (max-width:30rem){.two{grid-template-columns:1fr}}
.pick{display:flex;gap:.625rem;align-items:flex-start;padding:.75rem;border:1px solid var(--border);border-radius:.5rem;margin-bottom:.5rem;cursor:pointer;transition:border-color .12s,background .12s}
.pick:hover{background:var(--sunken)}
.pick.on{border-color:var(--accent);background:color-mix(in oklab,var(--accent) 6%,var(--surface))}
.pick input{margin-top:.2rem}
.pick .t{display:block;font-size:.875rem;font-weight:500}
.pick .d{display:block;color:var(--muted);font-size:.7813rem;line-height:1.45;margin-top:.125rem}
.box{border:1px solid var(--border);border-radius:.5rem;padding:.875rem;margin-bottom:.75rem;background:var(--sunken)}
.box>h3{margin:0 0 .25rem;font-size:.875rem;font-weight:600;display:flex;align-items:center;gap:.5rem}
.box .sub{color:var(--muted);font-size:.75rem;margin:0 0 .75rem}
.ep{display:flex;align-items:center;gap:.5rem;padding:.4375rem 0;border-top:1px dashed var(--border);font-size:.8125rem}
.ep:first-of-type{border-top:0}
.ep .h{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem}
.ep .r{font-size:.7188rem;color:var(--muted);flex:none;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ep .r.ok{color:var(--ok)}.ep .r.bad{color:var(--danger)}
.tag{font-size:.6875rem;color:var(--muted);border:1px solid var(--border);border-radius:.25rem;padding:0 .25rem;flex:none}
button{border:1px solid var(--field-border);border-radius:.375rem;background:var(--surface);color:var(--fg);font:inherit;font-size:.8125rem;height:2rem;padding:0 .75rem;cursor:pointer;transition:background .12s,border-color .12s,filter .12s}
button:hover:not(:disabled){background:var(--sunken)}
button:disabled{opacity:.5;cursor:default}
button.p{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600;height:2.375rem;padding:0 1.125rem}
button.p:hover:not(:disabled){filter:brightness(1.07);background:var(--accent)}
button.sm{height:1.75rem;padding:0 .5rem;font-size:.75rem}
.trow{display:grid;grid-template-columns:7rem 1fr 8rem 2rem;gap:.5rem;margin-bottom:.5rem}
@media (max-width:34rem){.trow{grid-template-columns:1fr 2.5rem}.trow>select,.trow>input:nth-of-type(1){grid-column:1/-1}}
.nav{display:flex;align-items:center;gap:.75rem;padding:1rem 1.5rem;border-top:1px solid var(--border);background:var(--sunken)}
.nav .sp{flex:1}
.msg{font-size:.8125rem;line-height:1.4;padding:.625rem .75rem;border-radius:.375rem;margin-bottom:1rem;display:none}
.msg.bad{display:block;border:1px solid color-mix(in oklab,var(--danger) 30%,transparent);background:color-mix(in oklab,var(--danger) 8%,var(--surface))}
.msg.good{display:block;border:1px solid color-mix(in oklab,var(--ok) 30%,transparent);background:color-mix(in oklab,var(--ok) 8%,var(--surface))}
.sum{border:1px solid var(--border);border-radius:.5rem;overflow:hidden}
.sum div{display:flex;gap:1rem;padding:.5rem .75rem;border-top:1px solid var(--border);font-size:.8125rem}
.sum div:first-child{border-top:0}
.sum b{flex:none;width:9.5rem;font-weight:500;color:var(--muted)}
.sum span{flex:1;min-width:0;overflow-wrap:anywhere}
.warn{border-left:2px solid var(--gold);padding-left:.75rem;color:var(--muted);font-size:.7813rem;line-height:1.5;margin:1rem 0 0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.spin{display:inline-block;width:.75rem;height:.75rem;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-.1rem}
@keyframes sp{to{transform:rotate(360deg)}}
`;

// ---- page body --------------------------------------------------------
const BODY = `
<main class="shell">
  <div class="top">
    <div class="mark">${MARK}<b id="kicker">pemasangan</b></div>
    <div class="kanan">
      <div class="dots" id="dots"></div>
      <div class="lang" id="lang" role="group" aria-label="Language"></div>
    </div>
  </div>

  <div class="pane" id="pane">
    <div class="msg" id="msg"></div>
    <div id="body"></div>
  </div>

  <div class="nav">
    <button id="back" type="button">Kembali</button>
    <div class="sp"></div>
    <span id="step" style="color:var(--muted);font-size:.75rem"></span>
    <button id="next" class="p" type="button">Lanjut</button>
  </div>
</main>`;

const JS = `
// ---- bilingual ------------------------------------------------------
var EN = {
  "pemasangan": "setup",
  "Quiver — pemasangan": "Quiver — setup",
  "Kembali": "Back",
  "Lanjut": "Next",
  "Simpan & nyalakan": "Save & start",
  "Mulai": "Start",
  "Akses dasbor": "Dashboard access",
  "Wallet bot": "Bot wallet",
  "Chain & RPC": "Chains & RPC",
  "Pemberitahuan": "Notifications",
  "Modal & target": "Capital & targets",
  "Periksa & simpan": "Review & save",

  "Selamat datang di Quiver": "Welcome to Quiver",
  "Beberapa langkah untuk menyiapkan wallet, token akses, chain, dan batas modal. Semuanya bisa diubah lagi nanti dari halaman Pengaturan.": "A few steps to set up the wallet, access token, chains and capital limits. All of it can be changed later from the Settings page.",
  "Kode pemasangan": "Setup code",
  "8 karakter": "8 characters",
  "Tercetak di terminal tempat Quiver dijalankan. Lupa? <code>cat data/setup-code.txt</code> — atau <code>pm2 logs</code> kalau jalan di bawah pm2.": "Printed in the terminal where Quiver was started. Lost it? <code>cat data/setup-code.txt</code> — or <code>pm2 logs</code> when running under pm2.",
  "— dolar saja —": "— dollars only —",

  "Token akses dasbor": "Dashboard access token",
  "Dasbor ini bisa memindahkan dana, jadi ia selalu dikunci token. Token disimpan di <code>.env</code> (mode 600), bukan di config.json.": "This dashboard can move funds, so it is always locked behind a token. The token is stored in <code>.env</code> (mode 600), not in config.json.",
  "Token": "Token",
  "Buat acak lagi": "Generate another",
  "— minimal 12 karakter. Simpan di pengelola kata sandi; ia tidak bisa dilihat lagi dari dasbor.": "— at least 12 characters. Keep it in a password manager; it cannot be read back from the dashboard.",
  "Alamat dasbor dari luar (opsional)": "External dashboard address (optional)",
  "Isi kalau dasbor dibuka lewat tunnel (cloudflared). Dipakai tombol <em>Mini app</em> di bot Telegram — Telegram hanya menerima https.": "Fill this in if the dashboard is reached through a tunnel (cloudflared). Used by the <em>Mini app</em> button in the Telegram bot — Telegram only accepts https.",
  "Mata uang pendamping": "Secondary currency",
  "Ditempel kecil di samping angka dolar di dasbor (≈ Rp20,3 jt). Angka utamanya tetap dolar.": "Shown small beside dollar amounts on the dashboard (≈ Rp20.3M). The headline figure stays in dollars.",

  "Wallet yang menandatangani transaksi bot. Kunci privatnya disimpan di <code>{p}</code> dengan mode 600 dan tidak pernah dikirim balik ke peramban.": "The wallet that signs the bot transactions. Its private key is stored in <code>{p}</code> with mode 600 and is never sent back to the browser.",
  "Kunci sudah diatur lewat <code>LPCOPY_PRIVATE_KEY</code> di .env — langkah ini dilewati saja, berkas kunci tidak dipakai.": "The key is already set through <code>LPCOPY_PRIVATE_KEY</code> in .env — skip this step, the key file is not used.",
  "Buat wallet baru": "Create a new wallet",
  "Dibuatkan di server ini. Frasa pemulihannya ditulis ke berkas di samping kuncinya — jangan lewat peramban.": "Generated on this server. Its recovery phrase is written to a file next to the key, never through the browser.",
  "Impor kunci privat": "Import a private key",
  "Tempel kunci privat 64 hex dari wallet yang sudah ada. Pakai wallet khusus bot, bukan wallet utama.": "Paste a 64-hex private key from an existing wallet. Use a dedicated bot wallet, not your main one.",
  "Nanti saja": "Not now",
  "Bot jalan mode simulasi. Wallet bisa dipasang kapan saja dari Pengaturan.": "The bot runs in simulation. A wallet can be installed at any time from Settings.",
  "Kunci privat": "Private key",
  "Periksa & pakai": "Check & use",
  "Buat wallet": "Create wallet",
  "Lanjut tanpa wallet": "Continue without a wallet",
  "Frasa pemulihan akan ditulis ke <code>{p}.mnemonic</code> saat pemasangan disimpan. Salin ke tempat aman lalu hapus berkasnya.": "The recovery phrase will be written to <code>{p}.mnemonic</code> when setup is saved. Copy it somewhere safe, then delete the file.",
  "Sudah ada berkas kunci di mesin ini. Kalau wallet diganti, yang lama dipindah ke berkas cadangan bertanggal — tidak ada yang terhapus.": "A key file already exists on this machine. If the wallet is replaced, the old one is moved to a dated backup — nothing is deleted.",
  "Wallet siap: {a}": "Wallet ready: {a}",

  "Satu proses menjalankan semua chain yang dinyalakan. Endpoint bawaan di bawah ini publik dan gratis; uji dulu supaya ketahuan mana yang sanggup <code>getLogs</code> rentang besar.": "One process runs every enabled chain. The default endpoints below are public and free; test them to see which ones handle large <code>getLogs</code> ranges.",
  "arsip": "archive",
  "tanpa logs": "no logs",
  "logs {n}": "logs {n}",
  "Uji": "Test",
  "Tambah": "Add",
  "Alchemy API key (opsional)": "Alchemy API key (optional)",
  "kosongkan kalau tidak pakai": "leave empty if unused",
  "Disimpan sebagai <code>ALCHEMY_KEY</code> di .env, dan endpoint Alchemy ditaruh paling depan untuk chain yang mendukungnya. URL di config cuma memuat <code>\${ALCHEMY_KEY}</code> — kuncinya tidak ikut kalau config dibagikan.": "Stored as <code>ALCHEMY_KEY</code> in .env, with an Alchemy endpoint placed first on every chain that has one. The config URL only holds <code>\${ALCHEMY_KEY}</code>, so the key does not travel with a shared config.",

  "Semuanya opsional — boleh dilewati dan diisi nanti dari Pengaturan.": "All optional — skip them and fill them in later from Settings.",
  "Token bot Telegram": "Telegram bot token",
  "Buat bot lewat <code>@BotFather</code>. Chat yang boleh memakainya disambungkan belakangan: dasbor memberi kode, lalu kirim <code>/start &lt;kode&gt;</code> ke bot itu.": "Create a bot through <code>@BotFather</code>. The chats allowed to use it are connected afterwards: the dashboard hands out a code, then you send <code>/start &lt;code&gt;</code> to that bot.",
  "Topik ntfy.sh": "ntfy.sh topic",
  "Notifikasi ke HP tanpa akun. Pakai nama topik yang sulit ditebak — siapa pun yang tahu namanya bisa ikut membacanya.": "Phone notifications without an account. Pick a hard-to-guess topic name — anyone who knows it can read along.",
  "API key GMGN": "GMGN API key",
  "Untuk lilin harga versi GMGN di tab Chart. Kosong = pakai GeckoTerminal saja.": "For GMGN price candles in the Chart tab. Empty = GeckoTerminal only.",

  "Batas modal & target": "Capital limits & targets",
  "Angka dolar per chain yang dinyalakan. Semuanya bisa diubah per target di halaman Aturan.": "Dollar amounts, applied to every enabled chain. All of them can be overridden per target on the Rules page.",
  "Mode simulasi": "Simulation mode",
  "Bot menghitung dan mencatat keputusan, tapi tidak mengirim transaksi. Mulailah dari sini.": "The bot evaluates and records decisions but sends no transactions. Start here.",
  "Mode LIVE": "LIVE mode",
  "Transaksi sungguhan dengan dana sungguhan sejak detik pertama.": "Real transactions with real funds from the first second.",
  "Butuh wallet — pasang dulu di langkah Wallet.": "Requires a wallet — install one in the Wallet step first.",
  "Nilai per entry (USD)": "Value per entry (USD)",
  "Diisi = ukuran tetap tiap posisi.": "Filled in = a fixed size for every position.",
  "Maks per posisi (USD)": "Max per position (USD)",
  "Maks total terpakai (USD)": "Max total exposure (USD)",
  "Budget harian (USD)": "Daily budget (USD)",
  "Wallet target yang ditiru": "Target wallets to copy",
  "nama": "name",
  "hapus": "remove",
  "+ Tambah wallet": "+ Add wallet",
  "Boleh kosong — target juga bisa dicari dan ditambahkan dari halaman Target setelah bot jalan.": "May stay empty — targets can also be researched and added from the Targets page once the bot is running.",

  "Periksa lalu simpan": "Review, then save",
  "Cara memasang": "How to set up",
  "Pasang baru": "Fresh install",
  "Wallet, token, chain, dan batas modal diisi langkah demi langkah.": "Wallet, token, chains and capital limits, step by step.",
  "Pulihkan dari cadangan": "Restore from backup",
  "Pakai berkas cadangan dari Pengaturan → Cadangan di instance lain: pengaturan, dan kalau ada, basis data serta wallet.": "Use a backup file from Settings → Backup on another instance: its settings and, when included, its database and wallet.",
  "Pilih berkas cadangan (.json) yang diunduh dari Pengaturan → Cadangan. Bot menyala dalam mode simulasi; LIVE dinyalakan lagi dari dasbor.": "Choose the backup file (.json) downloaded from Settings → Backup. The bot starts in simulation mode; switch LIVE back on from the dashboard.",
  "Berkas cadangan": "Backup file",
  "Dibuat": "Created",
  "Instance": "Instance",
  "Isi": "Contents",
  "pengaturan": "settings",
  "basis data": "database",
  "wallet": "wallet",
  "Basis data": "Database",
  "{n} posisi ({o} terbuka)": "{n} positions ({o} open)",
  "Riwayat posisi, transaksi, ekuitas, dan riset target. Tanpa ini bot mulai dengan riwayat kosong.": "Position history, transactions, equity and target research. Without it the bot starts with an empty history.",
  "Kunci sudah diatur lewat <code>LPCOPY_PRIVATE_KEY</code> di .env — bagian ini dilewati.": "The key is already set through <code>LPCOPY_PRIVATE_KEY</code> in .env — this part is skipped.",
  "Keystore terenkripsi; dibuka dengan password yang dipakai saat mencadangkan.": "Encrypted keystore; opened with the password used when backing up.",
  "Password keystore": "Keystore password",
  "Token baru untuk mesin ini, disimpan di .env.": "A new token for this machine, stored in .env.",
  "Port dasbor": "Dashboard port",
  "Di instance asal: {p}.": "On the original instance: {p}.",
  "Port yang sedang dipakai halaman ini pasti bebas.": "The port this page is using is guaranteed to be free.",
  "Variabel .env yang dirujuk RPC": ".env variables used by RPC",
  "URL RPC di config memakai nilai ini dari .env, dan mesin ini belum punya. Boleh dikosongkan — endpoint-nya gagal sampai diisi.": "RPC URLs in the config take these values from .env, and this machine does not have them yet. They may stay empty — those endpoints fail until filled in.",
  "Kalau instance asal masih jalan dengan wallet yang sama, matikan dulu — dua bot di satu wallet saling bertabrakan, dan bot Telegram yang sama hanya bisa dipakai satu instance.": "If the original instance is still running with the same wallet, stop it first — two bots on one wallet collide, and one Telegram bot can only serve one instance.",
  "Pulihkan & nyalakan": "Restore & start",
  "Memulihkan…": "Restoring…",
  "Pilih berkas cadangan dulu.": "Choose a backup file first.",
  "Isi password keystore, atau hapus centang Wallet.": "Enter the keystore password, or untick Wallet.",
  "Port dasbor harus angka 1–65535.": "The dashboard port must be a number from 1 to 65535.",
  "Cadangan sudah dipulihkan{w}. Bot menyala dalam mode simulasi — halaman ini pindah sendiri ke dasbor begitu siap.": "The backup is restored{w}. The bot starts in simulation mode — this page moves to the dashboard on its own once it is ready.",
  "Berkas cadangan bukan JSON yang valid.": "The backup file is not valid JSON.",
  "Bukan berkas cadangan Quiver.": "This is not a Quiver backup file.",
  "Berkas cadangan ini tidak berisi pengaturan — pasang baru, lalu pulihkan sisanya dari Pengaturan → Cadangan.": "This backup has no settings — do a fresh install, then restore the rest from Settings → Backup.",
  "Password keystore salah, atau keystore di berkas cadangan rusak.": "Wrong keystore password, or the keystore in the backup file is damaged.",
  "Versi berkas cadangan lebih baru dari bot ini — perbarui bot dulu.": "This backup was made by a newer version — update the bot first.",
  "Basis data di berkas cadangan rusak (hash tidak cocok).": "The database in the backup file is damaged (hash mismatch).",
  "Berkas basis data bukan milik Quiver (tabel positions/state tidak ada).": "The database file is not a Quiver database (positions/state tables missing).",
  "Setelah disimpan, berkas ditulis dan bot langsung menyala di proses ini — tidak perlu restart.": "Once saved, the files are written and the bot starts in this very process — no restart needed.",
  "Chain": "Chains",
  "Wallet": "Wallet",
  "Mode": "Mode",
  "Batas": "Limits",
  "Target": "Targets",
  "Mata uang": "Currency",
  "Berkas": "Files",
  "{n} RPC": "{n} RPC",
  "dari LPCOPY_PRIVATE_KEY": "from LPCOPY_PRIVATE_KEY",
  "berkas kunci yang sudah ada": "the existing key file",
  "belum ada — simulasi": "none yet — simulation",
  "SIMULASI": "SIMULATION",
  "{n} wallet": "{n} wallet(s)",
  "token diisi": "token set",
  "dolar saja": "dollars only",
  "bawaan": "defaults",
  "{v}/entry": "{v}/entry",
  "maks {v}": "max {v}",
  "{v}/hari": "{v}/day",
  "<b>Mode LIVE.</b> Begitu tombol di bawah ditekan, bot boleh mengirim transaksi dengan dana sungguhan. Kalau ragu, kembali dan pilih simulasi — menyalakan LIVE dari dasbor butuh dua klik saja.": "<b>LIVE mode.</b> The moment the button below is pressed, the bot may send transactions with real funds. If in doubt, go back and choose simulation — switching to LIVE from the dashboard takes two clicks.",

  "Tempel kode pemasangan dulu.": "Paste the setup code first.",
  "Token akses minimal 12 karakter — ini satu-satunya kunci dasbor.": "The access token needs at least 12 characters — it is the only lock on the dashboard.",
  "Alamat dasbor harus diawali https:// (Telegram menolak http).": "The dashboard address must start with https:// (Telegram rejects http).",
  "Tekan tombol di atas dulu untuk membuat atau memeriksa wallet-nya.": "Press the button above first to create or check the wallet.",
  "Chain yang dinyalakan butuh minimal satu endpoint RPC.": "An enabled chain needs at least one RPC endpoint.",
  "Pilih minimal satu chain.": "Choose at least one chain.",
  "Alamat target ke-{n} bukan alamat 0x yang sah.": "Target address #{n} is not a valid 0x address.",
  "URL RPC harus https.": "The RPC URL must be https.",
  "Menulis berkas…": "Writing files…",

  "Menyalakan Quiver…": "Starting Quiver…",
  "Berkas sudah ditulis{w}. Mesin tiap chain sedang dipanaskan — halaman ini pindah sendiri ke dasbor begitu siap.": "The files are written{w}. Each chain engine is warming up — this page moves to the dashboard on its own once it is ready.",
  ", wallet {a} terpasang": ", wallet {a} installed",
  "menunggu dasbor di {u}": "waiting for the dashboard at {u}",
  "Dasbor belum menjawab. Lihat log di terminal, lalu buka {u} sendiri.": "The dashboard is not answering yet. Check the terminal log, then open {u} yourself.",

  // Messages from the server (setup.js, settings.js probeRpc) — translated via ts().
  "Kode pemasangan salah. Lihat terminal tempat Quiver dijalankan, atau jalankan: cat data/setup-code.txt": "Wrong setup code. Check the terminal where Quiver was started, or run: cat data/setup-code.txt",
  "terlalu banyak percobaan — tunggu 5 menit": "too many attempts — wait 5 minutes",
  "Kunci privat harus 64 karakter hex (boleh diawali 0x).": "The private key must be 64 hex characters (0x prefix optional).",
  "Kunci privat tidak valid.": "Invalid private key.",
  "Mode LIVE butuh wallet — pasang wallet dulu di langkah Wallet.": "LIVE mode needs a wallet — install one in the Wallet step first.",
  "chain tidak dikenal": "unknown chain",
  "endpoint tidak dikenal": "unknown endpoint",
  "URL RPC kosong": "empty RPC URL",
  "rute tidak ada": "no such route",
  "balasan server tidak terbaca": "the server reply could not be read",
  "JSON tidak terbaca": "unreadable JSON",
  "badan permintaan kebesaran": "request body too large",
  "Tidak bisa dihubungi": "Cannot be reached",
  "eth_blockNumber ditolak": "eth_blockNumber refused",
  "getLogs rentang besar ✓": "getLogs large range ✓",
  "getLogs hanya rentang kecil": "getLogs small ranges only",
  "arsip ✓": "archive ✓",
  "bukan arsip": "not an archive node",
  "URL tidak valid": "invalid URL",
  "host tidak diizinkan": "host not allowed",
  "alamat link-local tidak diizinkan": "link-local addresses are not allowed",
  "host mengarah ke alamat link-local": "the host resolves to a link-local address",
  "Wallet Solana (opsional)": "Solana wallet (optional)",
  "Dibuatkan di server ini; kunci tidak lewat peramban.": "Generated on this server; the key never passes through the browser.",
  "Hanya dipakai kalau chain Solana dinyalakan. Kunci ed25519 terpisah dari wallet EVM di atas, disimpan di <code>{p}</code> dengan mode 600.": "Only used when the Solana chain is enabled. A separate ed25519 key from the EVM wallet above, stored in <code>{p}</code> with mode 600.",
  "Tanpa wallet Solana": "No Solana wallet",
  "Buat wallet Solana baru": "Create a new Solana wallet",
  "Impor kunci Solana": "Import a Solana key",
  "Tempel kunci base58 dari Phantom/Solflare, atau larik JSON dari solana-keygen.": "Paste the base58 key from Phantom/Solflare, or the JSON array from solana-keygen.",
  "Kunci Solana": "Solana key",
  "Pakai kunci Solana": "Use Solana key",
  "Buat wallet Solana": "Create Solana wallet",
  "Wallet Solana siap: {a}": "Solana wallet ready: {a}",
  "Kunci Solana sudah diatur lewat <code>LPCOPY_SOLANA_PRIVATE_KEY</code> di .env.": "The Solana key is already set through <code>LPCOPY_SOLANA_PRIVATE_KEY</code> in .env.",
  "Sudah ada berkas kunci Solana di mesin ini; kalau diganti, yang lama dicadangkan.": "A Solana key file already exists on this machine; if replaced, the old one is backed up.",
  "Kunci Solana harus base58 (ekspor Phantom/Solflare) atau larik JSON solana-keygen.": "The Solana key must be base58 (Phantom/Solflare export) or a solana-keygen JSON array.",
  "Mode LIVE di Solana butuh wallet Solana — pasang dulu di langkah Wallet.": "LIVE mode on Solana needs a Solana wallet — install one in the Wallet step first.",
  "Alamat target ke-{n} bukan alamat Solana (base58) yang sah.": "Target address #{n} is not a valid Solana (base58) address.",
  "tanpa getProgramAccounts": "no getProgramAccounts",
  "tanpa riwayat": "no history",
  "baca akun ✓": "account reads ✓",
  "baca akun ✗": "account reads ✗",
  "getProgramAccounts ✓": "getProgramAccounts ✓",
  "getProgramAccounts ✗": "getProgramAccounts ✗",
  "riwayat ✓": "history ✓",
  "riwayat ✗": "history ✗",
  "Wallet Solana": "Solana wallet",
  "berkas kunci Solana yang sudah ada": "the existing Solana key file",
  "dari LPCOPY_SOLANA_PRIVATE_KEY": "from LPCOPY_SOLANA_PRIVATE_KEY"
};

// Default English; a choice that was ever stored (here or in the dashboard) wins.
var LANG = (function () {
  try { var l = localStorage.getItem('lpcopy-lang'); if (l === 'id' || l === 'en') return l; } catch (e) { /* mode privat */ }
  return 'en';
})();
function t(s, v) {
  var o = (LANG === 'en' && EN[s]) ? EN[s] : s;
  if (v) for (var k in v) o = o.split('{' + k + '}').join(v[k]);
  return o;
}
// Text that comes from the server is always Indonesian. Exactly matching text is translated via
// the dictionary; the rest (RPC test summaries joined with ' · ', messages with inserted values)
// is patched per fragment — enough for sentences that only appear here.
function ts(s) {
  if (!s) return '';
  if (LANG !== 'en') return s;
  if (EN[s]) return EN[s];
  var o = s.split(' · ').map(function (x) { return EN[x] || x; }).join(' · ');
  return o
    .replace('Chain salah (', 'Wrong chain (').replace(', harusnya ', ', expected ')
    .replace(': belum ada endpoint RPC.', ': no RPC endpoint yet.')
    .replace('URL RPC tidak valid: ', 'Invalid RPC URL: ')
    .replace('URL RPC harus https: ', 'The RPC URL must be https: ')
    .replace('Alamat target tidak valid: ', 'Invalid target address: ');
}
// The same localStorage key as the dashboard (web/src/i18n.jsx), so the language
// chosen here is reused as soon as the dashboard opens.
function setLang(l) {
  LANG = (l === 'id' ? 'id' : 'en');
  try { localStorage.setItem('lpcopy-lang', LANG); } catch (e) { /* mode privat */ }
  document.documentElement.lang = LANG;
  document.title = t('Quiver — pemasangan');
  render();
}

var S = {
  code: '', st: null, i: 0,
  display: { currency: 'IDR' },
  secrets: { authToken: '', publicUrl: '', telegramToken: '', ntfyTopic: '', gmgnKey: '', alchemyKey: '' },
  wallet: { mode: 'generate', address: null },
  solWallet: { mode: 'none', address: null },
  chains: {},
  capital: { dry_run: true, fixed_quote_usd: '', min_quote_usd: '', max_quote_per_position_usd: '', max_total_exposure_usd: '', daily_budget_usd: '' },
  targets: [],
  // Restore path: a backup file from Settings → Backup replaces all the steps.
  flow: 'new',
  r: { backup: null, name: '', size: 0, parts: { db: true, wallet: true }, password: '', port: '', env: {}, envVars: [], backupPort: null }
};
var TITLES = ['Mulai', 'Akses dasbor', 'Wallet bot', 'Chain & RPC', 'Pemberitahuan', 'Modal & target', 'Periksa & simpan'];
var TITLES_R = ['Mulai', 'Pulihkan dari cadangan'];
var $ = function (s) { return document.querySelector(s); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

function say(kind, text) {
  var m = $('#msg');
  m.className = 'msg' + (kind ? ' ' + kind : '');
  m.innerHTML = text || '';
  if (kind) m.scrollIntoView({ block: 'nearest' });
}

function api(path, body) {
  return fetch('/api/setup/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-setup-code': S.code },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) { return r.json().catch(function () { return { error: t('balasan server tidak terbaca') }; }); });
}

// ---- panel ---------------------------------------------------------
function paneMulai() {
  return '<h2>' + t('Selamat datang di Quiver') + '</h2>'
    + '<p class="lede">' + t('Beberapa langkah untuk menyiapkan wallet, token akses, chain, dan batas modal. Semuanya bisa diubah lagi nanti dari halaman Pengaturan.') + '</p>'
    + '<div class="row"><label for="code">' + t('Kode pemasangan') + '</label>'
    + '<input id="code" class="mono" autofocus autocomplete="off" spellcheck="false" placeholder="' + t('8 karakter') + '" value="' + esc(S.code) + '">'
    + '<p class="hint">' + t('Tercetak di terminal tempat Quiver dijalankan. Lupa? <code>cat data/setup-code.txt</code> — atau <code>pm2 logs</code> kalau jalan di bawah pm2.') + '</p></div>'
    + '<div class="row"><label>' + t('Cara memasang') + '</label>'
    + pilihFlow('new', 'Pasang baru', 'Wallet, token, chain, dan batas modal diisi langkah demi langkah.')
    + pilihFlow('restore', 'Pulihkan dari cadangan', 'Pakai berkas cadangan dari Pengaturan → Cadangan di instance lain: pengaturan, dan kalau ada, basis data serta wallet.')
    + '</div>';
}
function pilihFlow(v, judul, ket) {
  return '<label class="pick' + (S.flow === v ? ' on' : '') + '"><input type="radio" name="flow" value="' + v + '"' + (S.flow === v ? ' checked' : '') + '>'
    + '<span><span class="t">' + t(judul) + '</span><span class="d">' + t(ket) + '</span></span></label>';
}
function selCurrency() {
  // Currency names come from the server in two languages (fx.js CURRENCIES/_EN); the ISO
  // code is the reference, the name is only a label.
  var o = '<option value="">' + t('— dolar saja —') + '</option>';
  for (var i = 0; i < S.st.currencies.length; i++) {
    var c = S.st.currencies[i];
    var nama = (LANG === 'en' && c.nameEn) ? c.nameEn : c.name;
    o += '<option value="' + c.code + '"' + (c.code === S.display.currency ? ' selected' : '') + '>' + esc(c.code + ' · ' + nama) + '</option>';
  }
  return '<select id="cur">' + o + '</select>';
}

function paneKeamanan() {
  return '<h2>' + t('Token akses dasbor') + '</h2>'
    + '<p class="lede">' + t('Dasbor ini bisa memindahkan dana, jadi ia selalu dikunci token. Token disimpan di <code>.env</code> (mode 600), bukan di config.json.') + '</p>'
    + '<div class="row"><label for="tok">' + t('Token') + '</label>'
    + '<input id="tok" class="mono" autocomplete="off" spellcheck="false" value="' + esc(S.secrets.authToken) + '">'
    + '<p class="hint"><button type="button" class="sm" id="gen">' + t('Buat acak lagi') + '</button> ' + t('— minimal 12 karakter. Simpan di pengelola kata sandi; ia tidak bisa dilihat lagi dari dasbor.') + '</p></div>'
    + '<div class="row"><label for="pub">' + t('Alamat dasbor dari luar (opsional)') + '</label>'
    + '<input id="pub" placeholder="https://lp.contoh.com" value="' + esc(S.secrets.publicUrl) + '">'
    + '<p class="hint">' + t('Isi kalau dasbor dibuka lewat tunnel (cloudflared). Dipakai tombol <em>Mini app</em> di bot Telegram — Telegram hanya menerima https.') + '</p></div>'
    + '<div class="row"><label for="cur">' + t('Mata uang pendamping') + '</label>' + selCurrency()
    + '<p class="hint">' + t('Ditempel kecil di samping angka dolar di dasbor (≈ Rp20,3 jt). Angka utamanya tetap dolar.') + '</p></div>';
}

function paneWallet() {
  var w = S.wallet;
  var pick = function (v, judul, ket) {
    return '<label class="pick' + (w.mode === v ? ' on' : '') + '"><input type="radio" name="wm" value="' + v + '"' + (w.mode === v ? ' checked' : '') + '>'
      + '<span><span class="t">' + t(judul) + '</span><span class="d">' + t(ket) + '</span></span></label>';
  };
  return '<h2>' + t('Wallet bot') + '</h2>'
    + '<p class="lede">' + t('Wallet yang menandatangani transaksi bot. Kunci privatnya disimpan di <code>{p}</code> dengan mode 600 dan tidak pernah dikirim balik ke peramban.', { p: esc(S.st.paths.key) }) + '</p>'
    + (S.st.existing.privateKeyFromEnv ? '<p class="warn">' + t('Kunci sudah diatur lewat <code>LPCOPY_PRIVATE_KEY</code> di .env — langkah ini dilewati saja, berkas kunci tidak dipakai.') + '</p>' : '')
    + pick('generate', 'Buat wallet baru', 'Dibuatkan di server ini. Frasa pemulihannya ditulis ke berkas di samping kuncinya — jangan lewat peramban.')
    + pick('import', 'Impor kunci privat', 'Tempel kunci privat 64 hex dari wallet yang sudah ada. Pakai wallet khusus bot, bukan wallet utama.')
    + pick('none', 'Nanti saja', 'Bot jalan mode simulasi. Wallet bisa dipasang kapan saja dari Pengaturan.')
    + '<div class="row" id="pkrow" style="display:' + (w.mode === 'import' ? 'block' : 'none') + '">'
    + '<label for="pk">' + t('Kunci privat') + '</label><input id="pk" type="password" class="mono" autocomplete="off" spellcheck="false" placeholder="0x…"></div>'
    + '<div class="row"><button type="button" id="mk">' + t(w.mode === 'import' ? 'Periksa & pakai' : w.mode === 'generate' ? 'Buat wallet' : 'Lanjut tanpa wallet') + '</button>'
    + '<span id="addr" class="hint mono" style="display:inline-block;margin-left:.5rem">' + (w.address ? '✓ ' + esc(w.address) : '') + '</span></div>'
    + (w.address && w.mode === 'generate' ? '<p class="warn">' + t('Frasa pemulihan akan ditulis ke <code>{p}.mnemonic</code> saat pemasangan disimpan. Salin ke tempat aman lalu hapus berkasnya.', { p: esc(S.st.paths.key) }) + '</p>' : '')
    + (S.st.existing.key ? '<p class="warn">' + t('Sudah ada berkas kunci di mesin ini. Kalau wallet diganti, yang lama dipindah ke berkas cadangan bertanggal — tidak ada yang terhapus.') + '</p>' : '')
    + paneSolWallet();
}

// The Solana key is separate (ed25519): only needed when the Solana chain is enabled.
function paneSolWallet() {
  if (!S.st.chains.some(function (c) { return c.kind === 'solana'; })) return '';
  var w = S.solWallet;
  var pick = function (v, judul, ket) {
    return '<label class="pick' + (w.mode === v ? ' on' : '') + '"><input type="radio" name="swm" value="' + v + '"' + (w.mode === v ? ' checked' : '') + '>'
      + '<span><span class="t">' + t(judul) + '</span><span class="d">' + t(ket) + '</span></span></label>';
  };
  return '<h3 style="margin-top:1.5rem">' + t('Wallet Solana (opsional)') + '</h3>'
    + '<p class="hint">' + t('Hanya dipakai kalau chain Solana dinyalakan. Kunci ed25519 terpisah dari wallet EVM di atas, disimpan di <code>{p}</code> dengan mode 600.', { p: esc(S.st.paths.solanaKey || '~/.lpcopy/solana-key') }) + '</p>'
    + (S.st.existing.solanaKeyFromEnv ? '<p class="warn">' + t('Kunci Solana sudah diatur lewat <code>LPCOPY_SOLANA_PRIVATE_KEY</code> di .env.') + '</p>' : '')
    + pick('none', 'Tanpa wallet Solana', 'Bot jalan mode simulasi. Wallet bisa dipasang kapan saja dari Pengaturan.')
    + pick('generate', 'Buat wallet Solana baru', 'Dibuatkan di server ini; kunci tidak lewat peramban.')
    + pick('import', 'Impor kunci Solana', 'Tempel kunci base58 dari Phantom/Solflare, atau larik JSON dari solana-keygen.')
    + '<div class="row" style="display:' + (w.mode === 'import' ? 'block' : 'none') + '">'
    + '<label for="spk">' + t('Kunci Solana') + '</label><input id="spk" type="password" class="mono" autocomplete="off" spellcheck="false" placeholder="base58…"></div>'
    + (w.mode !== 'none' ? '<div class="row"><button type="button" id="smk">' + t(w.mode === 'import' ? 'Pakai kunci Solana' : 'Buat wallet Solana') + '</button>'
      + '<span class="hint mono" style="display:inline-block;margin-left:.5rem">' + (w.address ? '✓ ' + esc(w.address) : '') + '</span></div>' : '')
    + (S.st.existing.solanaKey ? '<p class="warn">' + t('Sudah ada berkas kunci Solana di mesin ini; kalau diganti, yang lama dicadangkan.') + '</p>' : '');
}

function paneChain() {
  var h = '<h2>' + t('Chain & RPC') + '</h2><p class="lede">' + t('Satu proses menjalankan semua chain yang dinyalakan. Endpoint bawaan di bawah ini publik dan gratis; uji dulu supaya ketahuan mana yang sanggup <code>getLogs</code> rentang besar.') + '</p>';
  for (var i = 0; i < S.st.chains.length; i++) {
    var c = S.st.chains[i], st = S.chains[c.key];
    h += '<div class="box"><h3><label style="display:flex;gap:.5rem;align-items:center;margin:0;font-weight:600">'
      + '<input type="checkbox" data-ch="' + c.key + '"' + (st.enabled ? ' checked' : '') + '> ' + esc(c.label) + '</label>'
      + (c.chainId != null ? '<span class="tag">id ' + c.chainId + '</span>' : '') + '<span class="tag">' + esc(c.nativeSymbol) + '</span></h3>';
    if (st.enabled) {
      for (var j = 0; j < st.eps.length; j++) {
        var e = st.eps[j];
        h += '<div class="ep"><input type="checkbox" data-use="' + c.key + ':' + j + '"' + (e.use ? ' checked' : '') + '>'
          + '<span class="h" title="' + esc(e.url) + '">' + esc(e.host) + '</span>'
          + (e.archive ? '<span class="tag">' + t('arsip') + '</span>' : '')
          + (e.no_logs ? '<span class="tag">' + t('tanpa logs') + '</span>' : '')
          + (e.max_log_blocks ? '<span class="tag">' + t('logs {n}', { n: e.max_log_blocks }) + '</span>' : '')
          + (e.no_gpa ? '<span class="tag">' + t('tanpa getProgramAccounts') + '</span>' : '')
          + (e.no_history ? '<span class="tag">' + t('tanpa riwayat') + '</span>' : '')
          + '<button type="button" class="sm" data-test="' + c.key + ':' + j + '">' + t('Uji') + '</button>'
          + '<span class="r ' + (e.res ? e.resKind : '') + '" id="r-' + c.key + '-' + j + '">' + esc(e.res ? ts(e.res) : '') + '</span></div>';
      }
      h += '<div class="ep" style="gap:.5rem"><input class="h" style="height:1.75rem;font-size:.75rem" placeholder="https://rpc-lain.contoh/…" data-add="' + c.key + '">'
        + '<button type="button" class="sm" data-addbtn="' + c.key + '">' + t('Tambah') + '</button></div>';
    }
    h += '</div>';
  }
  h += '<div class="row"><label for="alc">' + t('Alchemy API key (opsional)') + '</label>'
    + '<input id="alc" class="mono" autocomplete="off" spellcheck="false" placeholder="' + t('kosongkan kalau tidak pakai') + '" value="' + esc(S.secrets.alchemyKey) + '">'
    + '<p class="hint">' + t('Disimpan sebagai <code>ALCHEMY_KEY</code> di .env, dan endpoint Alchemy ditaruh paling depan untuk chain yang mendukungnya. URL di config cuma memuat <code>\${ALCHEMY_KEY}</code> — kuncinya tidak ikut kalau config dibagikan.') + '</p></div>';
  return h;
}

function paneNotif() {
  return '<h2>' + t('Pemberitahuan') + '</h2><p class="lede">' + t('Semuanya opsional — boleh dilewati dan diisi nanti dari Pengaturan.') + '</p>'
    + '<div class="row"><label for="tg">' + t('Token bot Telegram') + '</label>'
    + '<input id="tg" type="password" class="mono" autocomplete="off" placeholder="123456:ABC-…" value="' + esc(S.secrets.telegramToken) + '">'
    + '<p class="hint">' + t('Buat bot lewat <code>@BotFather</code>. Chat yang boleh memakainya disambungkan belakangan: dasbor memberi kode, lalu kirim <code>/start &lt;kode&gt;</code> ke bot itu.') + '</p></div>'
    + '<div class="row"><label for="ntfy">' + t('Topik ntfy.sh') + '</label>'
    + '<input id="ntfy" autocomplete="off" placeholder="quiver-abc123" value="' + esc(S.secrets.ntfyTopic) + '">'
    + '<p class="hint">' + t('Notifikasi ke HP tanpa akun. Pakai nama topik yang sulit ditebak — siapa pun yang tahu namanya bisa ikut membacanya.') + '</p></div>'
    + '<div class="row"><label for="gmgn">' + t('API key GMGN') + '</label>'
    + '<input id="gmgn" type="password" class="mono" autocomplete="off" value="' + esc(S.secrets.gmgnKey) + '">'
    + '<p class="hint">' + t('Untuk lilin harga versi GMGN di tab Chart. Kosong = pakai GeckoTerminal saja.') + '</p></div>';
}

function paneModal() {
  var punyaWallet = !!S.wallet.address || S.st.existing.key || S.st.existing.privateKeyFromEnv;
  var c = S.capital;
  var h = '<h2>' + t('Batas modal & target') + '</h2><p class="lede">' + t('Angka dolar per chain yang dinyalakan. Semuanya bisa diubah per target di halaman Aturan.') + '</p>'
    + '<label class="pick' + (c.dry_run ? ' on' : '') + '"><input type="radio" name="dry" value="1"' + (c.dry_run ? ' checked' : '') + '>'
    + '<span><span class="t">' + t('Mode simulasi') + '</span><span class="d">' + t('Bot menghitung dan mencatat keputusan, tapi tidak mengirim transaksi. Mulailah dari sini.') + '</span></span></label>'
    + '<label class="pick' + (!c.dry_run ? ' on' : '') + '"><input type="radio" name="dry" value="0"' + (!c.dry_run ? ' checked' : '') + (punyaWallet ? '' : ' disabled') + '>'
    + '<span><span class="t">' + t('Mode LIVE') + '</span><span class="d">' + t(punyaWallet ? 'Transaksi sungguhan dengan dana sungguhan sejak detik pertama.' : 'Butuh wallet — pasang dulu di langkah Wallet.') + '</span></span></label>'
    + '<div class="two" style="margin-top:1rem">'
    + '<div class="row"><label for="fq">' + t('Nilai per entry (USD)') + '</label><input id="fq" inputmode="decimal" placeholder="' + esc(S.st.capital.fixed_quote_usd) + '" value="' + esc(c.fixed_quote_usd) + '"><p class="hint">' + t('Diisi = ukuran tetap tiap posisi.') + '</p></div>'
    + '<div class="row"><label for="mq">' + t('Maks per posisi (USD)') + '</label><input id="mq" inputmode="decimal" placeholder="' + esc(S.st.capital.max_quote_per_position_usd) + '" value="' + esc(c.max_quote_per_position_usd) + '"></div>'
    + '<div class="row"><label for="mt">' + t('Maks total terpakai (USD)') + '</label><input id="mt" inputmode="decimal" placeholder="' + esc(S.st.capital.max_total_exposure_usd) + '" value="' + esc(c.max_total_exposure_usd) + '"></div>'
    + '<div class="row"><label for="db">' + t('Budget harian (USD)') + '</label><input id="db" inputmode="decimal" placeholder="' + esc(S.st.capital.daily_budget_usd) + '" value="' + esc(c.daily_budget_usd) + '"></div>'
    + '</div>'
    + '<div class="row"><label>' + t('Wallet target yang ditiru') + '</label>';
  var aktif = S.st.chains.filter(function (x) { return S.chains[x.key].enabled; });
  for (var i = 0; i < S.targets.length; i++) {
    var tg = S.targets[i], opt = '';
    for (var j = 0; j < aktif.length; j++) opt += '<option value="' + aktif[j].key + '"' + (tg.chain === aktif[j].key ? ' selected' : '') + '>' + esc(aktif[j].label.split(' ')[0]) + '</option>';
    h += '<div class="trow"><select data-tc="' + i + '">' + opt + '</select>'
      + '<input class="mono" data-ta="' + i + '" placeholder="' + (chainKind(tg.chain) === 'solana' ? 'base58…' : '0x…') + '" value="' + esc(tg.address) + '">'
      + '<input data-tl="' + i + '" placeholder="' + t('nama') + '" value="' + esc(tg.label) + '">'
      + '<button type="button" class="sm" data-tx="' + i + '" title="' + t('hapus') + '">✕</button></div>';
  }
  h += '<button type="button" class="sm" id="addt">' + t('+ Tambah wallet') + '</button>'
    + '<p class="hint">' + t('Boleh kosong — target juga bisa dicari dan ditambahkan dari halaman Target setelah bot jalan.') + '</p></div>';
  return h;
}

function paneRingkas() {
  var baris = function (k, v) { return '<div><b>' + t(k) + '</b><span>' + v + '</span></div>'; };
  var chs = [], tgt = 0;
  for (var i = 0; i < S.st.chains.length; i++) {
    var c = S.st.chains[i], st = S.chains[c.key];
    if (!st.enabled) continue;
    var n = st.eps.filter(function (e) { return e.use; }).length;
    chs.push(esc(c.label) + ' (' + t('{n} RPC', { n: n }) + ')');
  }
  tgt = S.targets.filter(function (x) { return x.address; }).length;
  var batas = [
    S.capital.fixed_quote_usd ? t('{v}/entry', { v: '$' + esc(S.capital.fixed_quote_usd) }) : null,
    S.capital.max_total_exposure_usd ? t('maks {v}', { v: '$' + esc(S.capital.max_total_exposure_usd) }) : null,
    S.capital.daily_budget_usd ? t('{v}/hari', { v: '$' + esc(S.capital.daily_budget_usd) }) : null
  ].filter(Boolean).join(' · ');
  var h = '<h2>' + t('Periksa lalu simpan') + '</h2><p class="lede">' + t('Setelah disimpan, berkas ditulis dan bot langsung menyala di proses ini — tidak perlu restart.') + '</p>'
    + '<div class="sum">'
    + baris('Chain', chs.join(', ') || '—')
    + baris('Wallet', S.wallet.address ? '<span class="mono">' + esc(S.wallet.address) + '</span>' : (S.st.existing.privateKeyFromEnv ? t('dari LPCOPY_PRIVATE_KEY') : (S.st.existing.key ? t('berkas kunci yang sudah ada') : t('belum ada — simulasi'))))
    + (S.chains.solana && S.chains.solana.enabled ? baris('Wallet Solana', S.solWallet.address ? '<span class="mono">' + esc(S.solWallet.address) + '</span>' : (S.st.existing.solanaKeyFromEnv ? t('dari LPCOPY_SOLANA_PRIVATE_KEY') : (S.st.existing.solanaKey ? t('berkas kunci Solana yang sudah ada') : t('belum ada — simulasi')))) : '')
    + baris('Mode', S.capital.dry_run ? t('SIMULASI') : '<b style="color:var(--danger)">LIVE</b>')
    + baris('Batas', batas || t('bawaan'))
    + baris('Target', tgt ? t('{n} wallet', { n: tgt }) : '—')
    + baris('Telegram', S.secrets.telegramToken ? t('token diisi') : '—')
    + baris('Mata uang', S.display.currency || t('dolar saja'))
    + baris('Berkas', '<span class="mono">' + esc(S.st.paths.config) + '</span><br><span class="mono">' + esc(S.st.paths.env) + '</span>')
    + '</div>';
  if (!S.capital.dry_run) h += '<p class="warn">' + t('<b>Mode LIVE.</b> Begitu tombol di bawah ditekan, bot boleh mengirim transaksi dengan dana sungguhan. Kalau ragu, kembali dan pilih simulasi — menyalakan LIVE dari dasbor butuh dua klik saja.') + '</p>';
  return h;
}

function mb(n) { return n < 1e6 ? Math.max(1, Math.round(n / 1e3)) + ' KB' : (n / 1e6).toFixed(1) + ' MB'; }
function panePulih() {
  var R = S.r, b = R.backup;
  var h = '<h2>' + t('Pulihkan dari cadangan') + '</h2>'
    + '<p class="lede">' + t('Pilih berkas cadangan (.json) yang diunduh dari Pengaturan → Cadangan. Bot menyala dalam mode simulasi; LIVE dinyalakan lagi dari dasbor.') + '</p>'
    + '<div class="row"><label for="rf">' + t('Berkas cadangan') + '</label>'
    + '<input id="rf" type="file" accept=".json,application/json" style="height:auto;padding:.5rem">'
    + (R.name ? '<p class="hint mono">' + esc(R.name) + ' · ' + mb(R.size) + '</p>' : '') + '</div>';
  if (!b) return h;
  var P = b.parts || {};
  var isi = [P.config ? t('pengaturan') : null, P.db ? t('basis data') : null, P.wallet ? t('wallet') : null].filter(Boolean).join(', ');
  var baris = function (k, v) { return '<div><b>' + t(k) + '</b><span>' + v + '</span></div>'; };
  h += '<div class="sum" style="margin-bottom:1rem">'
    + baris('Dibuat', esc(new Date(b.createdAt).toLocaleString(LANG === 'id' ? 'id-ID' : 'en-US')))
    + baris('Instance', '<span class="mono">' + esc(b.instance || '—') + '</span>' + (b.chains && b.chains.length ? ' · ' + esc(b.chains.join(', ')) : ''))
    + baris('Isi', isi || '—')
    + '</div>';
  if (!P.config) return h;
  var cek = function (k, judul, ket) {
    return '<label class="pick' + (R.parts[k] ? ' on' : '') + '"><input type="checkbox" data-part="' + k + '"' + (R.parts[k] ? ' checked' : '') + '>'
      + '<span><span class="t">' + judul + '</span><span class="d">' + ket + '</span></span></label>';
  };
  if (P.db) {
    var st = P.db.stats || {};
    h += cek('db', t('Basis data') + ' <span class="tag">' + t('{n} posisi ({o} terbuka)', { n: st.positions == null ? '?' : st.positions, o: st.open == null ? '?' : st.open }) + ' · ' + mb(P.db.bytes || 0) + '</span>',
      t('Riwayat posisi, transaksi, ekuitas, dan riset target. Tanpa ini bot mulai dengan riwayat kosong.'));
  }
  if (P.wallet) {
    h += cek('wallet', t('Wallet') + ' <span class="tag mono">' + esc(P.wallet.address) + '</span>',
      S.st.existing.privateKeyFromEnv ? t('Kunci sudah diatur lewat <code>LPCOPY_PRIVATE_KEY</code> di .env — bagian ini dilewati.')
        : t('Keystore terenkripsi; dibuka dengan password yang dipakai saat mencadangkan.'));
    if (R.parts.wallet && !S.st.existing.privateKeyFromEnv) {
      h += '<div class="row"><label for="rpw">' + t('Password keystore') + '</label><input id="rpw" type="password" autocomplete="off" value="' + esc(R.password) + '"></div>';
    }
  }
  h += '<div class="two" style="margin-top:1rem">'
    + '<div class="row"><label for="tok">' + t('Token akses dasbor') + '</label>'
    + '<input id="tok" class="mono" autocomplete="off" spellcheck="false" value="' + esc(S.secrets.authToken) + '">'
    + '<p class="hint"><button type="button" class="sm" id="gen">' + t('Buat acak lagi') + '</button> ' + t('Token baru untuk mesin ini, disimpan di .env.') + '</p></div>'
    + '<div class="row"><label for="port">' + t('Port dasbor') + '</label>'
    + '<input id="port" inputmode="numeric" value="' + esc(R.port) + '">'
    + '<p class="hint">' + (R.backupPort && String(R.backupPort) !== String(R.port) ? t('Di instance asal: {p}.', { p: esc(R.backupPort) }) + ' ' : '') + t('Port yang sedang dipakai halaman ini pasti bebas.') + '</p></div>'
    + '</div>';
  var kurang = R.envVars.filter(function (v) { return !v.set; });
  if (kurang.length) {
    h += '<div class="box"><h3>' + t('Variabel .env yang dirujuk RPC') + '</h3><p class="sub">' + t('URL RPC di config memakai nilai ini dari .env, dan mesin ini belum punya. Boleh dikosongkan — endpoint-nya gagal sampai diisi.') + '</p>';
    for (var i = 0; i < kurang.length; i++) {
      var n = kurang[i].name;
      h += '<div class="row"><label for="env-' + esc(n) + '" class="mono">' + esc(n) + '</label><input id="env-' + esc(n) + '" data-env="' + esc(n) + '" type="password" class="mono" autocomplete="off" value="' + esc(R.env[n] || '') + '"></div>';
    }
    h += '</div>';
  }
  h += '<p class="warn">' + t('Kalau instance asal masih jalan dengan wallet yang sama, matikan dulu — dua bot di satu wallet saling bertabrakan, dan bot Telegram yang sama hanya bisa dipakai satu instance.') + '</p>';
  return h;
}

var PANES = [paneMulai, paneKeamanan, paneWallet, paneChain, paneNotif, paneModal, paneRingkas];
var PANES_R = [paneMulai, panePulih];
function panes() { return S.flow === 'restore' ? PANES_R : PANES; }
function titles() { return S.flow === 'restore' ? TITLES_R : TITLES; }

// ---- frame -------------------------------------------------------------
function render() {
  var d = '';
  var PS = panes();
  for (var i = 0; i < PS.length; i++) d += '<i class="' + (i === S.i ? 'now' : i < S.i ? 'done' : '') + '"></i>';
  $('#dots').innerHTML = d;
  $('#lang').innerHTML = ['en', 'id'].map(function (l) {
    return '<button type="button" data-lang="' + l + '" aria-pressed="' + (LANG === l) + '">' + l.toUpperCase() + '</button>';
  }).join('');
  $('#kicker').textContent = t('pemasangan');
  $('#step').textContent = t(titles()[S.i]) + ' · ' + (S.i + 1) + '/' + PS.length;
  $('#body').innerHTML = PS[S.i]();
  $('#back').textContent = t('Kembali');
  $('#back').style.visibility = S.i === 0 ? 'hidden' : 'visible';
  $('#next').textContent = S.i === PS.length - 1 ? t(S.flow === 'restore' ? 'Pulihkan & nyalakan' : 'Simpan & nyalakan') : t('Lanjut');
  var f = $('#body').querySelector('input:not([type=checkbox]):not([type=radio]),select');
  if (f && S.i > 0) f.focus();
}

// Mounted ONCE. render() only replaces the innerHTML of #body, the element itself stays,
// so a listener attached here survives — and does not pile up on each render (one
// click of "Add wallet" used to add as many as the number of renders that had happened).
function wire() {
  var b = $('#body');
  b.addEventListener('input', function (e) {
    var el = e.target, id = el.id;
    if (id === 'code') S.code = el.value.trim();
    else if (id === 'cur') S.display.currency = el.value;
    else if (id === 'tok') S.secrets.authToken = el.value.trim();
    else if (id === 'pub') S.secrets.publicUrl = el.value.trim();
    else if (id === 'alc') S.secrets.alchemyKey = el.value.trim();
    else if (id === 'tg') S.secrets.telegramToken = el.value.trim();
    else if (id === 'ntfy') S.secrets.ntfyTopic = el.value.trim();
    else if (id === 'gmgn') S.secrets.gmgnKey = el.value.trim();
    else if (id === 'fq') S.capital.fixed_quote_usd = el.value.trim();
    else if (id === 'mq') S.capital.max_quote_per_position_usd = el.value.trim();
    else if (id === 'mt') S.capital.max_total_exposure_usd = el.value.trim();
    else if (id === 'db') S.capital.daily_budget_usd = el.value.trim();
    else if (id === 'rpw') S.r.password = el.value;
    else if (id === 'port') S.r.port = el.value.trim();
    else if (el.dataset.env) S.r.env[el.dataset.env] = el.value.trim();
    else if (el.dataset.ta != null) S.targets[+el.dataset.ta].address = el.value.trim();
    else if (el.dataset.tl != null) S.targets[+el.dataset.tl].label = el.value.trim();
  });
  b.addEventListener('change', function (e) {
    var el = e.target;
    if (el.name === 'flow') { S.flow = el.value; render(); }
    else if (el.id === 'rf') bacaCadangan(el.files && el.files[0]);
    else if (el.dataset.part) { S.r.parts[el.dataset.part] = el.checked; render(); }
    else if (el.name === 'wm') { S.wallet.mode = el.value; S.wallet.address = null; render(); }
    else if (el.name === 'swm') { S.solWallet.mode = el.value; S.solWallet.address = null; if (el.value === 'none') api('solana-wallet', { mode: 'none' }); render(); }
    else if (el.name === 'dry') { S.capital.dry_run = el.value === '1'; render(); }
    else if (el.dataset.ch) { S.chains[el.dataset.ch].enabled = el.checked; render(); }
    else if (el.dataset.use) { var p = el.dataset.use.split(':'); S.chains[p[0]].eps[+p[1]].use = el.checked; }
    else if (el.dataset.tc != null) S.targets[+el.dataset.tc].chain = el.value;
  });
  b.addEventListener('click', function (e) {
    var el = e.target.closest('button');
    if (!el) return;
    if (el.id === 'gen') { S.secrets.authToken = acak(); render(); }
    else if (el.id === 'mk') pasangWallet(el);
    else if (el.id === 'smk') pasangSolWallet(el);
    else if (el.id === 'addt') { S.targets.push({ chain: aktifPertama(), address: '', label: '' }); render(); }
    else if (el.dataset.tx != null) { S.targets.splice(+el.dataset.tx, 1); render(); }
    else if (el.dataset.addbtn) tambahEp(el.dataset.addbtn);
    else if (el.dataset.test) ujiEp(el.dataset.test, el);
  });
  $('#lang').addEventListener('click', function (e) {
    var el = e.target.closest('button');
    if (el) setLang(el.dataset.lang);
  });
}

function acak() {
  var a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode.apply(null, a)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
function aktifPertama() {
  for (var i = 0; i < S.st.chains.length; i++) if (S.chains[S.st.chains[i].key].enabled) return S.st.chains[i].key;
  return S.st.chains[0].key;
}

function pasangWallet(btn) {
  var mode = S.wallet.mode;
  if (mode === 'none') { S.wallet.address = null; return next(); }
  btn.disabled = true;
  var badan = { mode: mode };
  if (mode === 'import') badan.privateKey = ($('#pk') || {}).value || '';
  api('wallet', badan).then(function (r) {
    btn.disabled = false;
    if (r.error) return say('bad', esc(ts(r.error)));
    S.wallet.address = r.wallet ? r.wallet.address : null;
    say('good', t('Wallet siap: {a}', { a: '<span class="mono">' + esc(S.wallet.address) + '</span>' }));
    render();
  });
}

function pasangSolWallet(btn) {
  var mode = S.solWallet.mode;
  btn.disabled = true;
  var badan = { mode: mode };
  if (mode === 'import') badan.secret = ($('#spk') || {}).value || '';
  api('solana-wallet', badan).then(function (r) {
    btn.disabled = false;
    if (r.error) return say('bad', esc(ts(r.error)));
    S.solWallet.address = r.wallet ? r.wallet.address : null;
    say('good', t('Wallet Solana siap: {a}', { a: '<span class="mono">' + esc(S.solWallet.address || '') + '</span>' }));
    render();
  });
}
function chainKind(key) {
  for (var i = 0; i < S.st.chains.length; i++) if (S.st.chains[i].key === key) return S.st.chains[i].kind || 'evm';
  return 'evm';
}

function tambahEp(ck) {
  var inp = $('#body').querySelector('[data-add="' + ck + '"]');
  var u = (inp.value || '').trim();
  if (!u) return;
  if (!/^https:\\/\\//.test(u) && !/^http:\\/\\/(localhost|127\\.0\\.0\\.1)/.test(u)) return say('bad', t('URL RPC harus https.'));
  S.chains[ck].eps.push({ url: u, host: (function () { try { return new URL(u).hostname; } catch (e) { return u; } })(), use: true, max_batch: 40 });
  say('', '');
  render();
}

function ujiEp(k, btn) {
  var p = k.split(':'), ck = p[0], i = +p[1], e = S.chains[ck].eps[i];
  var out = $('#r-' + ck + '-' + i);
  out.className = 'r';
  out.innerHTML = '<span class="spin"></span>';
  btn.disabled = true;
  api('rpc', { chain: ck, endpoint: e.ref != null && !e.url ? { ref: e.ref } : { url: e.url } }).then(function (r) {
    btn.disabled = false;
    if (r.error) { e.res = r.error; e.resKind = 'bad'; }
    else {
      e.res = r.summary;
      e.resKind = r.usable ? 'ok' : 'bad';
      // The flag suggested by the test is used directly — exactly what the
      // Settings page does after the Test button.
      if (r.suggest) {
        e.no_logs = !!r.suggest.no_logs; e.max_log_blocks = r.suggest.max_log_blocks || 0; e.archive = !!r.suggest.archive;
        if (r.suggest.no_gpa != null) e.no_gpa = !!r.suggest.no_gpa;
        if (r.suggest.no_history != null) e.no_history = true;
      }
    }
    render();
  });
}

// ---- moving between steps -------------------------------------------------------
function periksa() {
  if (S.i === 0) {
    if (!S.code) return 'Tempel kode pemasangan dulu.';
    return null;
  }
  if (S.flow === 'restore') {
    var R = S.r;
    if (!R.backup) return 'Pilih berkas cadangan dulu.';
    if (!R.backup.parts.config) return 'Berkas cadangan ini tidak berisi pengaturan — pasang baru, lalu pulihkan sisanya dari Pengaturan → Cadangan.';
    if (R.parts.wallet && R.backup.parts.wallet && !S.st.existing.privateKeyFromEnv && !R.password) return 'Isi password keystore, atau hapus centang Wallet.';
    if (S.secrets.authToken.length < 12) return 'Token akses minimal 12 karakter — ini satu-satunya kunci dasbor.';
    if (!/^\\d+$/.test(R.port) || +R.port < 1 || +R.port > 65535) return 'Port dasbor harus angka 1–65535.';
    return null;
  }
  if (S.i === 1) {
    if (S.secrets.authToken.length < 12) return 'Token akses minimal 12 karakter — ini satu-satunya kunci dasbor.';
    if (S.secrets.publicUrl && !/^https:\\/\\/[^ ]+$/.test(S.secrets.publicUrl)) return 'Alamat dasbor harus diawali https:// (Telegram menolak http).';
    return null;
  }
  if (S.i === 2) {
    if (S.wallet.mode !== 'none' && !S.wallet.address && !S.st.existing.privateKeyFromEnv) return 'Tekan tombol di atas dulu untuk membuat atau memeriksa wallet-nya.';
    return null;
  }
  if (S.i === 3) {
    var ada = 0;
    for (var k in S.chains) {
      if (!S.chains[k].enabled) continue;
      ada++;
      if (!S.chains[k].eps.filter(function (e) { return e.use; }).length) return 'Chain yang dinyalakan butuh minimal satu endpoint RPC.';
    }
    if (!ada) return 'Pilih minimal satu chain.';
    return null;
  }
  if (S.i === 5) {
    for (var i = 0; i < S.targets.length; i++) {
      var a = S.targets[i].address;
      if (a && chainKind(S.targets[i].chain) === 'solana') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return t('Alamat target ke-{n} bukan alamat Solana (base58) yang sah.', { n: i + 1 });
      } else if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) return t('Alamat target ke-{n} bukan alamat 0x yang sah.', { n: i + 1 });
    }
    return null;
  }
  return null;
}

function next() {
  var err = periksa();
  if (err) return say('bad', esc(t(err)));
  say('', '');
  if (S.i === 0 && !S.st) return muat();
  if (S.i === panes().length - 1) return S.flow === 'restore' ? pulihkan() : simpan();
  S.i++;
  render();
}

function muat() {
  $('#next').disabled = true;
  api('state').then(function (r) {
    $('#next').disabled = false;
    if (r.error) return say('bad', esc(ts(r.error)));
    S.st = r;
    if (!S.secrets.authToken) S.secrets.authToken = r.suggestToken;
    if (S.display.currency === 'IDR' && r.display) S.display.currency = r.display.currency == null ? '' : r.display.currency;
    for (var i = 0; i < r.chains.length; i++) {
      var c = r.chains[i];
      S.chains[c.key] = {
        enabled: c.enabled,
        eps: c.endpoints.map(function (e) {
          return { ref: e.ref, url: e.secret ? null : e.url, host: e.host, use: true, no_logs: e.no_logs, max_log_blocks: e.max_log_blocks, archive: e.archive, max_batch: e.max_batch, no_gpa: e.no_gpa, no_history: e.no_history };
        })
      };
    }
    if (r.wallet) { S.wallet.mode = r.wallet.mode; S.wallet.address = r.wallet.address; }
    if (r.solanaWallet) { S.solWallet.mode = r.solanaWallet.mode; S.solWallet.address = r.solanaWallet.address; }
    if (!S.r.port) S.r.port = String(r.server.port);
    S.i = 1;
    render();
  }).catch(function (e) { $('#next').disabled = false; say('bad', esc(String(e))); });
}

function simpan() {
  $('#next').disabled = true;
  $('#back').disabled = true;
  say('good', '<span class="spin"></span> ' + t('Menulis berkas…'));
  var chains = {};
  for (var k in S.chains) {
    var st = S.chains[k];
    if (!st.enabled) { chains[k] = { enabled: false }; continue; }
    chains[k] = {
      enabled: true,
      endpoints: st.eps.filter(function (e) { return e.use; }).map(function (e) {
        if (e.ref != null && !e.url) return { ref: e.ref, no_logs: e.no_logs, archive: e.archive, max_log_blocks: e.max_log_blocks, no_gpa: e.no_gpa, no_history: e.no_history };
        return { url: e.url, max_batch: e.max_batch || 40, no_logs: !!e.no_logs, archive: !!e.archive, max_log_blocks: e.max_log_blocks || 0, no_gpa: !!e.no_gpa, no_history: !!e.no_history };
      })
    };
  }
  api('finish', {
    display: { currency: S.display.currency || null },
    secrets: S.secrets,
    capital: S.capital,
    chains: chains,
    targets: S.targets.filter(function (x) { return x.address; })
  }).then(function (r) {
    if (r.error) { $('#next').disabled = false; $('#back').disabled = false; return say('bad', esc(ts(r.error))); }
    tunggu(r);
  }).catch(function (e) { $('#next').disabled = false; $('#back').disabled = false; say('bad', esc(String(e))); });
}

// The file is read in the browser (preview without uploading); the server is only asked about the
// config part: which .env variables it references that do not exist on this machine.
function bacaCadangan(f) {
  var R = S.r;
  R.backup = null; R.name = ''; R.size = 0; R.envVars = []; R.backupPort = null;
  if (!f) return render();
  f.text().then(function (txt) {
    var b;
    try { b = JSON.parse(txt); } catch (e) { throw new Error(t('Berkas cadangan bukan JSON yang valid.')); }
    if (!b || b.format !== 'quiver-backup' || !b.parts) throw new Error(t('Bukan berkas cadangan Quiver.'));
    R.backup = b; R.name = f.name; R.size = f.size;
    R.parts = { db: !!b.parts.db, wallet: !!b.parts.wallet };
    if (!b.parts.config) { say('bad', esc(t('Berkas cadangan ini tidak berisi pengaturan — pasang baru, lalu pulihkan sisanya dari Pengaturan → Cadangan.'))); return render(); }
    say('', '');
    return api('restore/inspect', { config: b.parts.config.json }).then(function (r) {
      if (r.error) return say('bad', esc(ts(r.error)));
      R.envVars = r.envVars || [];
      R.backupPort = r.backupPort;
      render();
    });
  }).catch(function (e) { say('bad', esc(e.message || String(e))); render(); });
}

function pulihkan() {
  var R = S.r;
  $('#next').disabled = true;
  $('#back').disabled = true;
  say('good', '<span class="spin"></span> ' + t('Memulihkan…'));
  var env = {};
  for (var k in R.env) if (R.env[k]) env[k] = R.env[k];
  api('restore', {
    backup: R.backup, parts: R.parts, password: R.parts.wallet ? R.password : '',
    token: S.secrets.authToken, port: +R.port, env: env
  }).then(function (r) {
    if (r.error) { $('#next').disabled = false; $('#back').disabled = false; return say('bad', esc(ts(r.error))); }
    tunggu(r);
  }).catch(function (e) { $('#next').disabled = false; $('#back').disabled = false; say('bad', esc(String(e))); });
}

// The setup server stops a moment after the files are written; once /api/setup/ping no
// longer answers {setup:true}, whatever listens on that port is already the dashboard. The destination
// address is built from the browser's hostname (not the host in the config) so it stays correct
// through a tunnel, and the port from the freshly written config.
function tunggu(r) {
  var tujuan = r.samePort ? '/' : location.protocol + '//' + location.hostname + ':' + r.port + '/';
  var ping = r.samePort ? '/api/setup/ping' : tujuan + 'api/setup/ping';
  var w = r.address ? t(', wallet {a} terpasang', { a: '<span class="mono">' + esc(r.address) + '</span>' }) : '';
  $('#body').innerHTML = '<h2>' + t('Menyalakan Quiver…') + '</h2>'
    + '<p class="lede">' + t(r.restored ? 'Cadangan sudah dipulihkan{w}. Bot menyala dalam mode simulasi — halaman ini pindah sendiri ke dasbor begitu siap.' : 'Berkas sudah ditulis{w}. Mesin tiap chain sedang dipanaskan — halaman ini pindah sendiri ke dasbor begitu siap.', { w: w }) + '</p>'
    + '<p class="hint" id="tunggu"><span class="spin"></span> ' + t('menunggu dasbor di {u}', { u: esc(tujuan) }) + '</p>';
  $('#next').style.display = 'none';
  $('#back').style.display = 'none';
  var mulai = Date.now();
  var tik = setInterval(function () {
    // Another port = another origin: the fetch is certain to be rejected by CORS, so there we only
    // wait briefly then move on — it is the dashboard that answers, not us.
    if (!r.samePort) {
      if (Date.now() - mulai > 4000) { clearInterval(tik); location.href = tujuan; }
      return;
    }
    fetch(ping, { cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j.setup) { clearInterval(tik); location.href = tujuan; } })
      .catch(function () {
        // The port is changing hands from the wizard to the dashboard — not necessarily a failure.
        if (Date.now() - mulai > 60000) {
          clearInterval(tik);
          $('#tunggu').innerHTML = t('Dasbor belum menjawab. Lihat log di terminal, lalu buka {u} sendiri.', { u: '<a href="' + esc(tujuan) + '">' + esc(tujuan) + '</a>' });
        }
      });
  }, 1500);
}

// Enter = the step's primary button, not always "Continue": in the add-RPC field it
// adds the endpoint, in the private key field it checks the wallet.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if (e.target.dataset.add) return tambahEp(e.target.dataset.add);
  if (e.target.id === 'pk') return pasangWallet($('#mk'));
  if (e.target.id === 'spk') return pasangSolWallet($('#smk'));
  next();
});
wire();
$('#next').addEventListener('click', next);
$('#back').addEventListener('click', function () { if (S.i > 0) { S.i--; say('', ''); render(); } });
// The effective language is also stored even if its button was not touched, so the dashboard opens
// with the same language as the one just read here.
setLang(LANG);
`;

const SETUP_PAGE = () => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quiver — setup</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="robots" content="noindex,nofollow">
<script>try{var t=localStorage.getItem('lpcopy-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}</script>
<style>${CSS}</style></head>
<body>${BODY}
<script>${JS}</script>
</body></html>`;

module.exports = { SETUP_PAGE };
