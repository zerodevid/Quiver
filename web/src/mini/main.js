// Quiver di dalam Telegram — mini app.
//
// Tampilannya sengaja dibuat sama dengan dasbor: token warna, ukuran huruf, bentuk
// kartu, chip, dan susunan angka di layar Ringkasan/Posisi/Aktivitas mengikuti
// web/src/pages/*.jsx. Yang berbeda cuma bentuk layarnya — satu kolom untuk HP, dengan
// bilah tab di bawah, karena ini dibuka di dalam aplikasi chat.
//
// Layar ini tidak memakai React/HeroUI seperti dasbor: ia dibuka di jaringan seluler
// dan yang diminta cuma tiga layar. Bundel terpisah (~20 KB) terbuka seketika; kalau ia
// ikut memuat dasbor, tiap ketukan tombol di bot berarti menunggu 300 KB dulu.
//
// Ia juga tidak mengimpor apa pun dari web/src: entri 'mini' di vite.config.js harus
// berdiri sendiri supaya seluruh potongannya bernama mini-*, dan hanya nama itulah yang
// dibukakan gerbang token di server (server.js: MINI_PUBLIC). Karena itu pembantu kecil
// (usd, APR, label aksi) ditulis ulang di sini — kembarannya ada di web/src/fmt.js, dan
// kalau yang di sana berubah, yang di sini ikut diubah tangan.
//
// Data: semua dari /api/* yang sama dengan dasbor. Tidak ada perhitungan sendiri di
// sini kecuali yang memang dihitung dasbor di browser (APR, fee vs IL).
import './style.css';

const tg = window.Telegram?.WebApp || null;

// ---- pembantu ------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nf = (v, d = 2) => Math.abs(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : ''}${nf(v, d)}`);
const usd = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : ''}$${nf(v, d)}`);
const sgn = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : '+'}$${nf(v, d)}`);
const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : '+'}${nf(v, d)}%`);
const tone = (v) => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : '');
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const dur = (h) => {
  if (h == null) return '—';
  if (h >= 48) return `${Math.round(h / 24)} hari`;
  if (h >= 1) return `${Math.round(h)} jam`;
  return `${Math.max(1, Math.round(h * 60))} menit`;
};
const ago = (ts) => (ts ? `${dur((Date.now() - ts) / 3600000)} lalu` : '—');
const pairOf = (p) => `${p.symbol0 || '?'}/${p.symbol1 || '?'}`;
const feeTier = (fee) => (fee == null ? '—' : `${nf(fee / 10000, 2).replace(/,00$/, '')}%`);

// APR fee — rumus yang sama dengan fmt.js: tertimbang modal DAN umur, supaya posisi
// besar yang baru dibuka tidak menarik turun rata-ratanya.
function aprOf(rows) {
  let fee = 0, base = 0;
  for (const p of rows || []) {
    if (p.syncing || !(p.costUsd > 0) || !(p.ageHours >= 2)) continue;
    fee += (p.feeUsd || 0) + (p.claimedUsd || 0);
    base += p.costUsd * (p.ageHours / 8760);
  }
  return base > 0 ? (fee / base) * 100 : null;
}
const aprText = (v) => (v == null ? '—' : v >= 1000 ? '999+%' : `${num(v, Math.abs(v) < 10 ? 1 : 0)}%`);
const sum = (rows, pick) => (rows || []).reduce((a, r) => a + (pick(r) || 0), 0);

// Nama manusiawi untuk isi tabel actions/decisions — sama dengan dasbor (fmt.js).
const AKSI = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi likuiditas',
  collect: 'Klaim fee', claim: 'Target panen fee', claim_fees: 'Klaim fee', compound: 'Auto-compound',
  reentry: 'Buka lagi (harga mendekat)', transfer_in: 'Terima posisi', transfer_out: 'Kirim posisi',
  custody_out: 'Titip ke otomasi', custody_in: 'Kembali dari otomasi',
};
const KEPUTUSAN = { copy: ['Disalin', 'ok'], dry: ['Simulasi', 'acc'], skip: ['Dilewati', ''], error: ['Gagal', 'bad'] };

// Tanda Quiver (web/src/components/Logo.jsx) — disalin sebagai path supaya tidak ada
// permintaan berkas kedua yang harus ikut dibukakan gerbang.
const LOGO = `<svg class="logo" viewBox="0 0 264 48" role="img" aria-label="Quiver"><g fill="currentColor" fill-rule="evenodd">
<path d="M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0Z"/><path d="M43 11L51 3L73 24L51 46L43 38L56 24Z"/>
<path d="M99 9C88 9 82 15 82 24S88 39 99 39C102 39 105 38 107 37L113 43L118 38L112 32C114 30 115 27 115 24C115 15 109 9 99 9ZM99 15C105 15 108 18 108 24S105 33 99 33S89 30 89 24S93 15 99 15Z M120 10H127V27C127 31 130 33 134 33S141 31 141 27V10H148V27C148 35 143 39 134 39S120 35 120 27Z M154 10H161V38H154Z M166 10H174L183 31L192 10H200L187 38H179Z M204 10H229V16H211V21H227V27H211V32H229V38H204Z M234 10H250C258 10 262 14 262 20C262 24 260 27 256 28L264 38H255L248 29H241V38H234ZM241 16V23H249C253 23 255 22 255 20S253 16 249 16Z"/>
</g></svg>`;

// ---- jembatan ke Telegram -------------------------------------------------
const haptic = (kind = 'light') => {
  try {
    if (kind === 'ok') tg?.HapticFeedback?.notificationOccurred('success');
    else if (kind === 'err') tg?.HapticFeedback?.notificationOccurred('error');
    else tg?.HapticFeedback?.impactOccurred(kind);
  } catch { /* klien lama tanpa haptic */ }
};
const konfirmasi = (pesan) => new Promise((resolve) => {
  if (tg?.showConfirm) tg.showConfirm(pesan, (ok) => resolve(!!ok));
  else resolve(window.confirm(pesan));
});
const beritahu = (pesan) => { if (tg?.showAlert) tg.showAlert(pesan); else window.alert(pesan); };
const bukaLuar = (url) => { if (tg?.openLink) tg.openLink(url); else window.open(url, '_blank', 'noopener'); };

// ---- API -----------------------------------------------------------------
// Tiket sesi dari /api/tg/auth. Dikirim sebagai Bearer, bukan diandalkan lewat cookie:
// di Telegram Web halaman ini berada dalam iframe milik web.telegram.org, dan cookie
// SameSite=Lax memang tidak ikut terkirim dari sana.
let tiket = null;
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(tiket ? { authorization: `Bearer ${tiket}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401) throw new Error('Sesi mini app kedaluwarsa. Tutup lalu buka lagi dari bot.');
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  if (j.error) throw new Error(j.error);
  return j;
}
// Lambang token dipasang lewat <img>, dan <img> tidak bisa membawa header — jadi
// tiketnya ikut di query. Server hanya menerimanya untuk rute gambar ini.
const iconSrc = (addr) => (addr && tiket ? `/api/icon?a=${encodeURIComponent(addr)}&t=${tiket}` : null);

// ---- keadaan --------------------------------------------------------------
const S = {
  tab: 'ringkasan',
  ov: null, pf: null, pos: null, act: null,
  range: '7d',              // rentang grafik pertumbuhan (Segmented di dasbor)
  filter: 'all',            // saringan daftar posisi: all | in | out
  detail: null,             // id posisi yang sedang dibuka
  memuat: false, galat: null, sibuk: false,
};
let timer = null;

const RANGES = [['24h', '24 jam'], ['7d', '7 hari'], ['30d', '30 hari'], ['all', 'Semua']];

// ---- potongan tampilan ----------------------------------------------------
// Lencana mode, persis aturan dasbor (App.jsx modeOf): dijeda abu, drawdown kuning,
// simulasi biru, LIVE merah dan berdenyut — satu-satunya keadaan yang memindahkan uang.
function modeBadge(m) {
  if (!m) return '';
  const [teks, warna] = m.paused ? ['Dijeda', 'muted']
    : m.drawdown?.tripped ? ['Drawdown', 'warn']
      : m.dry_run ? ['Simulasi', 'acc'] : ['Live', 'down'];
  const hidup = !m.paused && !m.dry_run;
  return `<span class="mode ${warna}"><span class="pulse">${hidup ? '<i></i>' : ''}<b></b></span>${teks}</span>`;
}

const segmented = (nama, nilai, opsi) => `<div class="seg">${opsi.map(([v, teks, n]) =>
  `<button data-seg="${nama}" data-v="${v}" class="${v === nilai ? 'on' : ''}">${esc(teks)}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;

const iconPair = (p) => {
  const one = (addr, sym) => {
    const src = iconSrc(addr);
    const huruf = esc((sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?');
    return src
      ? `<img src="${src}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${huruf}'}))">`
      : `<span>${huruf}</span>`;
  };
  return `<span class="icons">${one(p.token0, p.symbol0)}${one(p.token1, p.symbol1)}</span>`;
};

// Status rentang sebuah posisi, dengan kata dan warna yang sama dengan tabel dasbor.
const rangeMeta = (p) => (p.syncing ? '<span class="muted">menyinkronkan…</span>'
  : p.inRange == null ? ''
    : `<span class="${p.inRange ? 'up' : 'warn'}"><span class="dot"></span> ${p.inRange ? 'in-range' : 'di luar'}</span>`);

const kartuStat = (label, nilai, kelas, sub, badge) => `
  <div class="card">
    <div class="figrow"><span class="label">${esc(label)}</span>${badge || ''}</div>
    <div class="figure sm num ${kelas || ''}">${nilai}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;

// Kurva pertumbuhan. Titik yang kasnya belum terbaca (net = null) dilewati, bukan
// digambar sebagai nol — sesaat setelah restart itu akan terlihat seperti anjlok.
function chart(series, key) {
  const pts = (series || []).filter((r) => r[key] != null).map((r) => [r.ts, r[key]]);
  if (pts.length < 2) return '<div class="empty">Riwayatnya belum cukup untuk digambar.</div>';
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0);
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const W = 300, H = 130;
  const X = (t) => ((t - x0) / (x1 - x0 || 1)) * W;
  const Y = (v) => H - ((v - y0) / (y1 - y0)) * H;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ');
  const naik = ys[ys.length - 1] >= 0;
  const warna = naik ? 'var(--success)' : 'var(--danger)';
  const nol = Y(0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${d} L${W} ${nol.toFixed(1)} L0 ${nol.toFixed(1)} Z" fill="${warna}"></path>
    <line class="zero" x1="0" y1="${nol.toFixed(1)}" x2="${W}" y2="${nol.toFixed(1)}"></line>
    <path class="line" d="${d}" stroke="${warna}"></path>
  </svg>`;
}

// ---- layar: Ringkasan -----------------------------------------------------
function layarRingkasan() {
  const ov = S.ov;
  if (!ov) return skeleton();
  const pf = S.pf, now = pf?.now, st = pf?.stats;
  const s = ov.summary;
  const open = S.pos?.positions || [];
  const nilai = now?.value ?? ov.wallet?.value ?? null;
  const net = now?.netPnl ?? ov.wallet?.netPnl ?? null;
  const pnl = now?.pnl ?? (s.realizedUsd + s.unrealizedUsd);
  const modal = now?.capitalNet ?? now?.capital ?? null;

  // Kesehatan LP dari daftar posisi yang sama dengan layar Posisi — bukan dari
  // ringkasan mesin, supaya dua angka untuk hal yang sama tidak pernah berbeda.
  const inRangeN = open.filter((x) => x.inRange).length;
  const outUsd = sum(open.filter((x) => x.inRange === false), (x) => x.valueUsd);
  const feeOpen = sum(open, (x) => (x.feeUsd || 0) + (x.claimedUsd || 0));
  const ilRows = open.filter((x) => x.ilUsd != null);
  const ilOpen = ilRows.length ? sum(ilRows, (x) => x.ilUsd) : null;
  const apr = aprOf(open);

  const key = net != null ? 'net' : 'pnl';
  const seri = pf?.series || [];
  const akhir = [...seri].reverse().find((r) => r[key] != null)?.[key] ?? null;
  const awal = pf?.baseline?.[key] ?? seri.find((r) => r[key] != null)?.[key] ?? null;
  const delta = akhir != null && awal != null ? akhir - awal : null;
  const ex = pf?.extremes?.[key] || null;

  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Ringkasan</h1></div>

    <div class="card">
      <div class="label">Total portofolio</div>
      <div class="figure num">${usd(nilai)}</div>
      <div class="sub">${now?.cash
    ? `kas ${usd(now.cash.usd)} · di posisi ${usd(now.positionsUsd + now.feeUsd)}${(now.leftoverUsd || 0) > 0.005 ? ` · sisa token ${usd(now.leftoverUsd)}` : ''}`
    : 'hanya posisi — saldo kas tidak terbaca'}</div>
      <div class="divide">
        <div class="figrow">
          <span class="label">${net != null ? 'PnL bersih' : 'Total PnL'}</span>
          ${modal > 0 ? `<span class="aside num ${tone(net ?? pnl)}">${pct(((net ?? pnl) / modal) * 100, 2)}</span>` : ''}
        </div>
        <div class="figure num ${tone(net ?? pnl)}">${usd(net ?? pnl)}</div>
        <div class="sub">${net != null
    ? `modal ${usd(modal)} · PnL posisi ${usd(pnl)}`
    : `terealisasi ${usd(now?.realizedUsd ?? s.realizedUsd)} · berjalan ${usd(now?.unrealizedUsd ?? s.unrealizedUsd)}`}</div>
      </div>
    </div>

    <div class="grid2">
      ${kartuStat('Fee terkumpul', usd(s.feeUsd), s.feeUsd > 0.005 ? 'up' : '',
    s.costUsd > 0 ? `${num((s.feeUsd / s.costUsd) * 100, 2)}% dari modal · belum diklaim` : 'belum diklaim',
    apr == null ? '' : `<span class="chip ok" style="margin-left:auto">APR ${aprText(apr)}</span>`)}
      ${kartuStat('Fee vs IL', ilOpen == null ? '—' : usd(feeOpen + ilOpen), ilOpen == null ? '' : tone(feeOpen + ilOpen),
    ilOpen == null ? 'IL belum terhitung' : `fee ${usd(feeOpen)} · IL ${usd(ilOpen)}`)}
      ${kartuStat('Posisi in-range', open.length ? `${inRangeN}/${open.length}` : '—',
    !open.length ? '' : inRangeN === open.length ? 'up' : 'warn',
    !open.length ? 'belum ada posisi terbuka'
      : outUsd > 0.005 ? `${usd(outUsd)} di luar rentang — tidak menghasilkan fee` : 'semua posisi menghasilkan fee')}
      ${kartuStat('Win rate', st?.winRatePct != null ? `${num(st.winRatePct, 0)}%` : '—',
    st?.winRatePct == null ? '' : st.winRatePct >= 50 ? 'up' : 'down',
    !st ? '' : st.closedCount
      ? `${st.wins} menang · ${st.losses} kalah${st.flat ? ` · ${st.flat} impas` : ''} · rata-rata ${usd(st.avgPnl)}`
      : 'belum ada posisi ditutup')}
    </div>

    <div class="card pad0">
      <div class="panel-head"><h2>Pertumbuhan portofolio</h2></div>
      <div style="padding:0.75rem 1rem 0">
        ${segmented('range', S.range, RANGES)}
        <div class="figrow" style="margin-top:0.75rem">
          <span class="figure sm num ${tone(delta)}">${sgn(delta)}</span>
          <span class="sub" style="margin:0">${S.range === 'all' ? 'sejak awal' : `dalam ${RANGES.find((r) => r[0] === S.range)[1].toLowerCase()}`}</span>
        </div>
        ${ex ? `<div class="sub">tertinggi ${usd(ex.hi)} · penurunan terdalam ${usd(-Math.abs(ex.dd))}</div>` : ''}
      </div>
      <div style="padding:0.25rem 0.5rem 0.75rem">${chart(seri, key)}</div>
    </div>

    <div class="btns">
      <button class="act" data-do="pause">${ov.mode.paused ? 'Lanjutkan salin' : 'Jeda salin'}</button>
      <button class="act" data-do="dasbor">Dasbor penuh</button>
    </div>

    <div class="card">
      <div class="kv"><span class="k">Wallet bot</span><span class="v mono">${esc(short(ov.mode.wallet))}</span></div>
      <div class="kv"><span class="k">Chain</span><span class="v">${esc(ov.chain?.label || '—')}</span></div>
      <div class="kv"><span class="k">Sinkron terakhir</span><span class="v">${esc(ago(ov.lastSync))}</span></div>
      <div class="kv"><span class="k">Harga ${esc(ov.chain?.nativeSymbol || 'ETH')}</span><span class="v num">${usd(ov.chain?.ethUsd)}</span></div>
    </div>
    <p class="sub" style="text-align:center">${ov.mode.dry_run
    ? 'Mode simulasi: bot menghitung semuanya tapi tidak mengirim transaksi.'
    : 'Mode LIVE: transaksi dikirim ke chain memakai dana wallet.'}</p>`;
}

// ---- layar: Posisi --------------------------------------------------------
function barisPosisi(p) {
  return `<button class="row" data-pos="${p.id}">
    ${iconPair(p)}
    <div class="l">
      <div class="pair">${esc(pairOf(p))}</div>
      <div class="meta">
        <span style="text-transform:uppercase">${esc(p.venue || '')}</span><span class="sep">·</span>
        <span class="num">${feeTier(p.fee)}</span><span class="sep">·</span>${rangeMeta(p)}
      </div>
    </div>
    <div class="r">
      <div class="num ${tone(p.pnlUsd)}" style="font-weight:600">${sgn(p.pnlUsd)}</div>
      <div class="xs muted num">${usd(p.valueUsd)}</div>
    </div>
  </button>`;
}

function layarPosisi() {
  if (!S.pos) return skeleton();
  const semua = S.pos.positions || [];
  const inN = semua.filter((p) => p.inRange).length;
  const outN = semua.filter((p) => p.inRange === false).length;
  const open = S.filter === 'in' ? semua.filter((p) => p.inRange)
    : S.filter === 'out' ? semua.filter((p) => p.inRange === false) : semua;
  const tutup = (S.pos.closed || []).slice(0, 15);
  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Posisi</h1></div>
    <div class="card pad0">
      <div class="panel-head">
        <h2>Posisi terbuka (${semua.length})</h2>
      </div>
      <div style="padding:0.75rem 1rem 0">
        ${segmented('filter', S.filter, [['all', 'Semua', semua.length], ['in', 'In-range', inN], ['out', 'Di luar', outN]])}
      </div>
      <div class="sub" style="padding:0.625rem 1rem 0.25rem">
        Nilai <span class="num" style="color:var(--foreground)">${usd(sum(semua, (p) => p.valueUsd))}</span> ·
        Fee <span class="num" style="color:var(--foreground)">${usd(sum(semua, (p) => p.feeUsd))}</span> ·
        PnL <span class="num ${tone(sum(semua, (p) => p.pnlUsd))}">${sgn(sum(semua, (p) => p.pnlUsd))}</span>
      </div>
      ${open.length ? open.map(barisPosisi).join('') : '<div class="empty">Tidak ada posisi di saringan ini.</div>'}
      <div class="panel-foot">Diperbarui ${esc(ago(S.pos.syncedAt))}</div>
    </div>
    ${tutup.length ? `
      <div class="card pad0">
        <div class="panel-head"><h2>Sudah ditutup</h2></div>
        ${tutup.map((p) => `
          <div class="row flat zebra">
            ${iconPair(p)}
            <div class="l">
              <div class="pair">${esc(pairOf(p))}</div>
              <div class="meta"><span>${esc(ago(p.closed_ts))}</span><span class="sep">·</span><span>modal ${usd(p.costUsd)}</span></div>
            </div>
            <div class="r">
              <div class="num ${tone(p.pnlUsd)}" style="font-weight:600">${sgn(p.pnlUsd)}</div>
              <div class="xs muted num">${pct(p.pnlPct)}</div>
            </div>
          </div>`).join('')}
      </div>` : ''}`;
}

// Detail satu posisi + tombol yang memindahkan uang.
function layarDetail() {
  const p = (S.pos?.positions || []).find((x) => x.id === S.detail);
  if (!p) return '<div class="empty">Posisi ini sudah tidak terbuka.</div>';
  const sim = S.ov?.mode?.dry_run;
  const apr = aprOf([p]);
  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="card">
      <div style="display:flex;align-items:center;gap:0.625rem">
        ${iconPair(p)}
        <div class="l" style="min-width:0">
          <div class="pair" style="font-size:1.0625rem;font-weight:600">${esc(pairOf(p))}</div>
          <div class="meta">
            <span style="text-transform:uppercase">${esc(p.venue || '')}</span><span class="sep">·</span>
            <span class="num">${feeTier(p.fee)}</span><span class="sep">·</span>${rangeMeta(p)}
          </div>
        </div>
      </div>
      <div class="divide">
        <div class="figrow">
          <span class="label">PnL</span>
          <span class="aside num ${tone(p.pnlUsd)}">${pct(p.pnlPct)}</span>
        </div>
        <div class="figure num ${tone(p.pnlUsd)}">${sgn(p.pnlUsd)}</div>
        <div class="sub">nilai ${usd(p.valueUsd)} · modal ${usd(p.costUsd)} · umur ${esc(dur(p.ageHours))}</div>
      </div>
    </div>
    <div class="card">
      <div class="kv"><span class="k">Fee belum diklaim</span><span class="v num ${p.feeUsd > 0.005 ? 'up' : ''}">${usd(p.feeUsd)}${apr != null ? ` <span class="xs muted">APR ${aprText(apr)}</span>` : ''}</span></div>
      ${p.ilUsd != null ? `<div class="kv"><span class="k">Kerugian tak permanen</span><span class="v num ${tone(p.ilUsd)}">${usd(p.ilUsd)}</span></div>` : ''}
      <div class="kv"><span class="k">Disalin dari</span><span class="v">${esc(p.targetLabel || short(p.target) || 'manual')}</span></div>
      <div class="kv"><span class="k">NFT</span><span class="v num">#${esc(p.token_id ?? p.id)}</span></div>
      <div class="kv"><span class="k">Dibuka</span><span class="v">${esc(ago(p.opened_ts))}</span></div>
    </div>
    <div class="btns">
      <button class="act" data-do="klaim" data-id="${p.id}" ${sim || !(p.feeUsd > 0) ? 'disabled' : ''}>Klaim fee</button>
      <button class="act danger" data-do="tutup" data-id="${p.id}" ${sim ? 'disabled' : ''}>Tutup posisi</button>
    </div>
    <div class="btns"><button class="act" data-do="dasbor-posisi" data-id="${p.id}">Buka di dasbor</button></div>
    ${sim ? '<p class="sub" style="text-align:center">Mode simulasi: tombol yang mengirim transaksi dimatikan.</p>' : ''}`;
}

// ---- layar: Aktivitas -----------------------------------------------------
function layarAktivitas() {
  if (!S.act) return skeleton();
  const rows = (S.act.activity || []).slice(0, 40);
  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Aktivitas</h1></div>
    ${rows.length ? `<div class="card pad0">${rows.map((a) => {
    const k = KEPUTUSAN[a.verdict] || null;
    return `<div class="row flat zebra">
        <div class="l">
          <div class="pair">${esc(AKSI[a.kind] || a.kind)}${a.symbol0 ? ` <span class="muted">·</span> ${esc(`${a.symbol0}/${a.symbol1}`)}` : ''}</div>
          <div class="meta"><span>${esc(ago(a.ts))}</span><span class="sep">·</span><span>${esc(a.targetLabel || short(a.target))}</span></div>
          ${a.reason ? `<div class="xs muted" style="margin-top:0.25rem">${esc(a.reason)}</div>` : ''}
        </div>
        <div class="r">${k ? `<span class="chip ${k[1]}">${esc(k[0])}</span>` : ''}</div>
      </div>`;
  }).join('')}</div>` : '<div class="empty">Belum ada aktivitas target yang tercatat.</div>'}`;
}

const skeleton = () => `<div class="card"><div class="skel" style="height:0.875rem;width:40%"></div>
  <div class="skel" style="height:1.75rem;width:65%;margin-top:0.625rem"></div>
  <div class="skel" style="height:3.5rem;margin-top:0.875rem"></div></div>
  <div class="grid2">${'<div class="card"><div class="skel" style="height:2.75rem"></div></div>'.repeat(4)}</div>`;

// ---- kerangka & penggambaran ---------------------------------------------
const IKON = {
  ringkasan: '<path d="M3 13h4l3 7 4-16 3 9h4"/>',
  posisi: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
  aktivitas: '<path d="M4 6h16M4 12h16M4 18h10"/>',
};
const JUDUL = { ringkasan: 'Ringkasan', posisi: 'Posisi', aktivitas: 'Aktivitas' };

function gambar() {
  const app = $('#app');
  if (!app.firstChild) {
    app.append(el(`<header class="top">${LOGO}<span id="chip"></span><span class="right"><span id="spin"></span></span></header>`));
    app.append(el('<main id="view"></main>'));
    app.append(el(`<nav class="tabs">${Object.keys(JUDUL).map((k) =>
      `<button data-tab="${k}"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${IKON[k]}</svg>${JUDUL[k]}</button>`).join('')}</nav>`));
  }
  $('#chip').innerHTML = modeBadge(S.ov?.mode);
  $('#spin').innerHTML = S.memuat || S.sibuk ? '<span class="spin"></span>' : '';
  for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('on', b.dataset.tab === S.tab);
  $('nav.tabs').style.display = S.detail ? 'none' : '';
  $('#view').innerHTML = S.detail ? layarDetail()
    : S.tab === 'posisi' ? layarPosisi()
      : S.tab === 'aktivitas' ? layarAktivitas()
        : layarRingkasan();
}

// ---- data -----------------------------------------------------------------
async function muat({ diam = false } = {}) {
  if (!diam) S.memuat = true;
  gambar();
  try {
    // Ringkasan memakai daftar posisi juga (in-range, fee vs IL, APR) — sama seperti
    // halaman Ringkasan dasbor, supaya angkanya tidak pernah beda dengan layar Posisi.
    if (S.tab === 'ringkasan' || S.detail) {
      const [ov, pf, pos] = await Promise.all([
        api('/api/overview'),
        api(`/api/portfolio?range=${S.range}`).catch(() => null),
        api('/api/positions'),
      ]);
      S.ov = ov; S.pos = pos; if (pf) S.pf = pf;
    }
    if (S.tab === 'posisi') {
      const [ov, pos] = await Promise.all([api('/api/overview'), api('/api/positions')]);
      S.ov = ov; S.pos = pos;
    }
    if (S.tab === 'aktivitas') S.act = await api('/api/activity?limit=40');
    S.galat = null;
  } catch (e) {
    S.galat = e.message;
  } finally {
    S.memuat = false;
    gambar();
  }
}

// Penyegaran berkala hanya selagi mini app-nya terlihat: Telegram membiarkan halaman
// hidup di latar, dan memoll terus dari sana cuma membakar baterai dan kuota RPC.
function jadwal() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !S.sibuk) muat({ diam: true }); }, 20000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) muat({ diam: true }); });

// ---- aksi -----------------------------------------------------------------
async function jalankan(nama, id) {
  const p = (S.pos?.positions || []).find((x) => x.id === Number(id));
  if (nama === 'dasbor') return bukaLuar(`${location.origin}/`);
  if (nama === 'dasbor-posisi') return bukaLuar(`${location.origin}/#positions/${id}`);
  if (nama === 'pause') {
    const jeda = !S.ov?.mode?.paused;
    if (!await konfirmasi(jeda
      ? 'Jeda penyalinan? Posisi target baru tidak diikuti. Posisi yang sudah terbuka tetap dijaga.'
      : 'Lanjutkan penyalinan?')) return;
    return kirim(() => api('/api/mode', { paused: jeda }), jeda ? 'Penyalinan dijeda' : 'Penyalinan dilanjutkan');
  }
  if (nama === 'klaim') {
    if (!await konfirmasi(`Klaim fee posisi ${pairOf(p || {})} (${usd(p?.feeUsd)})?`)) return;
    return kirim(() => api('/api/positions/claim', { id: Number(id) }), 'Fee diklaim');
  }
  if (nama === 'tutup') {
    if (!await konfirmasi(`Tutup posisi ${pairOf(p || {})}?\n\nSeluruh likuiditas ditarik dan fee ikut diklaim. Hasil saat ini ${sgn(p?.pnlUsd)}.`)) return;
    return kirim(() => api('/api/positions/close', { id: Number(id) }), 'Posisi ditutup', () => { S.detail = null; });
  }
}

// Satu jalur untuk semua tombol yang mengirim transaksi: kunci tombolnya, tunggu
// jawabannya, lalu tarik ulang datanya. Tanpa kunci, ketukan kedua saat jaringan
// lambat mengirim perintah yang sama dua kali.
async function kirim(fn, pesanSukses, sesudah) {
  if (S.sibuk) return;
  S.sibuk = true; gambar();
  for (const b of document.querySelectorAll('button.act')) b.disabled = true;
  try {
    const r = await fn();
    haptic('ok');
    if (sesudah) sesudah();
    beritahu(r.note ? `${pesanSukses}. ${r.note}` : `${pesanSukses}.`);
  } catch (e) {
    haptic('err');
    beritahu(e.message);
  } finally {
    S.sibuk = false;
    await muat({ diam: true });
  }
}

// ---- interaksi ------------------------------------------------------------
document.addEventListener('click', (ev) => {
  const seg = ev.target.closest('[data-seg]');
  if (seg) {
    haptic('light');
    if (seg.dataset.seg === 'range') { S.range = seg.dataset.v; gambar(); return muat({ diam: true }); }
    S.filter = seg.dataset.v;
    return gambar();
  }
  const tab = ev.target.closest('nav.tabs button');
  if (tab) {
    haptic('light');
    S.tab = tab.dataset.tab; S.detail = null; S.galat = null;
    backButton();
    gambar();
    return muat({ diam: true });
  }
  const row = ev.target.closest('[data-pos]');
  if (row) {
    haptic('light');
    S.detail = Number(row.dataset.pos);
    backButton();
    window.scrollTo(0, 0);
    return gambar();
  }
  const btn = ev.target.closest('[data-do]');
  if (btn) return jalankan(btn.dataset.do, btn.dataset.id);
});

// Tombol kembali bawaan Telegram, bukan tombol sendiri di dalam halaman: di mini app
// itulah yang dicari orang, dan gestur geser di iOS memakainya juga.
function backButton() {
  const bb = tg?.BackButton;
  if (!bb) return;
  if (S.detail) bb.show(); else bb.hide();
}

// ---- mulai ----------------------------------------------------------------
// Warna dasbor, bukan warna tema Telegram — yang diambil dari Telegram cuma terang
// atau gelapnya. Bilah atas Telegram disamakan dengan latar halaman supaya sambungannya
// tidak terlihat (hex, karena setHeaderColor tidak mengerti oklch).
const BG = { light: '#f7f7f7', dark: '#111113' };
function tema() {
  const gelap = (tg?.colorScheme || 'light') === 'dark';
  document.body.classList.toggle('dark', gelap);
  document.body.classList.toggle('light', !gelap);
  try {
    tg?.setHeaderColor?.(gelap ? BG.dark : BG.light);
    tg?.setBackgroundColor?.(gelap ? BG.dark : BG.light);
  } catch { /* klien lama: biarkan warna bawaannya */ }
}

async function mulai() {
  if (tg) {
    tg.ready();
    tg.expand();
    tg.onEvent('themeChanged', tema);
    tg.BackButton?.onClick(() => { S.detail = null; backButton(); gambar(); });
  }
  tema();
  gambar();

  const initData = tg?.initData || '';
  if (!initData) {
    $('#view').innerHTML = `<div class="empty">Halaman ini dibuka dari dalam Telegram.<br><br>
      Buka bot Quiver lalu tekan tombol <b>Mini app</b> di menunya.</div>`;
    $('nav.tabs').style.display = 'none';
    return;
  }
  try {
    const r = await api('/api/tg/auth', { initData });
    tiket = r.token || null;
  } catch (e) {
    $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>
      <div class="empty">Kirim <b>/start</b> ke bot Quiver dulu, lalu buka lagi mini app ini.</div>`;
    $('nav.tabs').style.display = 'none';
    return;
  }
  await muat();
  jadwal();
}

mulai();
