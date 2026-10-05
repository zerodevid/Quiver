// Quiver inside Telegram — the mini app.
//
// Its look is deliberately the same as the dashboard: colour tokens, font sizes, card
// shapes, chips, and the arrangement of figures on the Summary/Positions/Activity screens follow
// web/src/pages/*.jsx. Only the shape of the screen differs — a single column for phones, with
// a tab bar at the bottom, because this is opened inside a chat app.
//
// These screens do not use React/HeroUI like the dashboard: it is opened on a mobile network
// and only three screens are wanted. A separate bundle (~20 KB) opens instantly; if it
// also loaded the dashboard, every tap of a button in the bot would mean waiting for 300 KB first.
//
// It also imports nothing from web/src: the 'mini' entry in vite.config.js must
// stand alone so that all its chunks are named mini-*, and only that name is
// opened by the token gate on the server (server.js: MINI_PUBLIC). Because of that the small helpers
// (usd, APR, action labels) are rewritten here — their twins are in web/src/fmt.js, and
// if the ones there change, these must be changed by hand.
//
// Data: all from the same /api/* as the dashboard. There is no computation of its own
// here except what the dashboard itself computes in the browser (APR, fee vs IL).
import './style.css';

const tg = window.Telegram?.WebApp || null;

// ---- helpers ------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nf = (v, d = 2) => Math.abs(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : ''}${nf(v, d)}`);
// Value redaction (the same as the dashboard, see web/src/privacy.js): ONE switch for
// everything — the `display.hide_values` config on the server, read via /api/overview.
// The eye icon in the header writes there too, so a dashboard open on a laptop follows.
// The +/− sign is also covered — even a "loss" is already a leak.
const MASK = '$•••••';
let localRedaction = null;   // the choice being saved to the server; null = follow the server
const redacted = () => (localRedaction != null ? localRedaction
  : S.ov && 'hideValues' in S.ov ? !!S.ov.hideValues
    : (() => { try { return localStorage.getItem('lpcopy-privacy-default') === '1'; } catch { return false; } })());
async function toggleRedaction() {
  const next = !redacted();
  localRedaction = next;
  image();
  try {
    await api('/api/settings/display', { hide_values: next });
    if (S.ov) S.ov.hideValues = next;
    try { localStorage.setItem('lpcopy-privacy-default', next ? '1' : '0'); } catch { /* abaikan */ }
  } catch (e) {
    notify(`Sensor gagal disimpan: ${e.message}`);
  }
  localRedaction = null;
  image();
}
const usd = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : redacted() ? MASK : `${v < 0 ? '−' : ''}$${nf(v, d)}`);
const sgn = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : redacted() ? MASK : `${v < 0 ? '−' : '+'}$${nf(v, d)}`);
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

// Fee APR — the same formula as fmt.js: weighted by capital AND age, so a large
// position just opened does not pull its average down.
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

// Human-readable names for the contents of the actions/decisions tables — the same as the dashboard (fmt.js).
const ACTIONS = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi likuiditas',
  collect: 'Klaim fee', claim: 'Target panen fee', claim_fees: 'Klaim fee', compound: 'Auto-compound',
  reentry: 'Buka lagi (harga mendekat)', transfer_in: 'Terima posisi', transfer_out: 'Kirim posisi',
  custody_out: 'Titip ke otomasi', custody_in: 'Kembali dari otomasi',
};
const DECISIONS = { copy: ['Disalin', 'ok'], dry: ['Simulasi', 'acc'], skip: ['Dilewati', ''], error: ['Gagal', 'bad'] };

// The Quiver mark (web/src/components/Logo.jsx) — copied as a path so there is no
// second file request that would also have to be opened by the gate.
const LOGO = `<svg class="logo" viewBox="0 0 264 48" role="img" aria-label="Quiver"><g fill="currentColor" fill-rule="evenodd">
<path d="M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0Z"/><path d="M43 11L51 3L73 24L51 46L43 38L56 24Z"/>
<path d="M99 9C88 9 82 15 82 24S88 39 99 39C102 39 105 38 107 37L113 43L118 38L112 32C114 30 115 27 115 24C115 15 109 9 99 9ZM99 15C105 15 108 18 108 24S105 33 99 33S89 30 89 24S93 15 99 15Z M120 10H127V27C127 31 130 33 134 33S141 31 141 27V10H148V27C148 35 143 39 134 39S120 35 120 27Z M154 10H161V38H154Z M166 10H174L183 31L192 10H200L187 38H179Z M204 10H229V16H211V21H227V27H211V32H229V38H204Z M234 10H250C258 10 262 14 262 20C262 24 260 27 256 28L264 38H255L248 29H241V38H234ZM241 16V23H249C253 23 255 22 255 20S253 16 249 16Z"/>
</g></svg>`;

// ---- bridge to Telegram -------------------------------------------------
const haptic = (kind = 'light') => {
  try {
    if (kind === 'ok') tg?.HapticFeedback?.notificationOccurred('success');
    else if (kind === 'err') tg?.HapticFeedback?.notificationOccurred('error');
    else tg?.HapticFeedback?.impactOccurred(kind);
  } catch { /* klien lama tanpa haptic */ }
};
const confirmation = (msg) => new Promise((resolve) => {
  if (tg?.showConfirm) tg.showConfirm(msg, (ok) => resolve(!!ok));
  else resolve(window.confirm(msg));
});
const notify = (msg) => { if (tg?.showAlert) tg.showAlert(msg); else window.alert(msg); };
const openExternal = (url) => { if (tg?.openLink) tg.openLink(url); else window.open(url, '_blank', 'noopener'); };

// ---- API -----------------------------------------------------------------
// Session ticket from /api/tg/auth. Sent as a Bearer, not relied on via a cookie:
// on Telegram Web this page sits inside an iframe owned by web.telegram.org, and
// SameSite=Lax cookies are indeed not sent from there.
let ticket = null;
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(ticket ? { authorization: `Bearer ${ticket}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401) throw new Error('Sesi mini app kedaluwarsa. Tutup lalu buka lagi dari bot.');
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  if (j.error) throw new Error(j.error);
  return j;
}
// Token icons are attached via <img>, and <img> cannot carry headers — so the
// ticket rides in the query. The server only accepts it for this image route.
const iconSrc = (addr) => (addr && ticket ? `/api/icon?a=${encodeURIComponent(addr)}&t=${ticket}` : null);

// ---- state --------------------------------------------------------------
const S = {
  tab: 'ringkasan',
  ov: null, pf: null, pos: null, act: null,
  range: '7d',              // growth chart range (Segmented on the dashboard)
  filter: 'all',            // position list filter: all | in | out
  detail: null,             // id of the position currently open
  loading: false, galat: null, busy: false,
};
let timer = null;

const RANGES = [['24h', '24 jam'], ['7d', '7 hari'], ['30d', '30 hari'], ['all', 'Semua']];

// ---- view pieces ----------------------------------------------------
// Mode badge, exactly the dashboard's rule (App.jsx modeOf): paused grey, drawdown yellow,
// simulation blue, LIVE red and pulsing — the only state that moves money.
function modeBadge(m) {
  if (!m) return '';
  const [text, color] = m.paused ? ['Dijeda', 'muted']
    : m.drawdown?.tripped ? ['Drawdown', 'warn']
      : m.dry_run ? ['Simulasi', 'acc'] : ['Live', 'down'];
  const alive = !m.paused && !m.dry_run;
  return `<span class="mode ${color}"><span class="pulse">${alive ? '<i></i>' : ''}<b></b></span>${text}</span>`;
}

const segmented = (name, worth, opsi) => `<div class="seg">${opsi.map(([v, text, n]) =>
  `<button data-seg="${name}" data-v="${v}" class="${v === worth ? 'on' : ''}">${esc(text)}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;

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

// A position's range status, with the same words and colours as the dashboard table.
const rangeMeta = (p) => (p.syncing ? '<span class="muted">menyinkronkan…</span>'
  : p.inRange == null ? ''
    : `<span class="${p.inRange ? 'up' : 'warn'}"><span class="dot"></span> ${p.inRange ? 'in-range' : 'di luar'}</span>`);

const statCard = (label, worth, cls, sub, badge) => `
  <div class="card">
    <div class="figrow"><span class="label">${esc(label)}</span>${badge || ''}</div>
    <div class="figure sm num ${cls || ''}">${worth}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;

// Growth curve. Points whose cash has not been read yet (net = null) are skipped, not
// drawn as zero — right after a restart that would look like a plunge.
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
  const up = ys[ys.length - 1] >= 0;
  const color = up ? 'var(--success)' : 'var(--danger)';
  const nol = Y(0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${d} L${W} ${nol.toFixed(1)} L0 ${nol.toFixed(1)} Z" fill="${color}"></path>
    <line class="zero" x1="0" y1="${nol.toFixed(1)}" x2="${W}" y2="${nol.toFixed(1)}"></line>
    <path class="line" d="${d}" stroke="${color}"></path>
  </svg>`;
}

// ---- screen: Summary -----------------------------------------------------
function summaryScreen() {
  const ov = S.ov;
  if (!ov) return skeleton();
  const pf = S.pf, now = pf?.now, st = pf?.stats;
  const s = ov.summary;
  const open = S.pos?.positions || [];
  const worth = now?.value ?? ov.wallet?.value ?? null;
  const net = now?.netPnl ?? ov.wallet?.netPnl ?? null;
  const pnl = now?.pnl ?? (s.realizedUsd + s.unrealizedUsd);
  const cap = now?.capitalNet ?? now?.capital ?? null;

  // LP health from the same position list as the Positions screen — not from the
  // engine summary, so two figures for the same thing never differ.
  const inRangeN = open.filter((x) => x.inRange).length;
  const outUsd = sum(open.filter((x) => x.inRange === false), (x) => x.valueUsd);
  const feeOpen = sum(open, (x) => (x.feeUsd || 0) + (x.claimedUsd || 0));
  const ilRows = open.filter((x) => x.ilUsd != null);
  const ilOpen = ilRows.length ? sum(ilRows, (x) => x.ilUsd) : null;
  const apr = aprOf(open);

  const key = net != null ? 'net' : 'pnl';
  const seri = pf?.series || [];
  const end = [...seri].reverse().find((r) => r[key] != null)?.[key] ?? null;
  const initial = pf?.baseline?.[key] ?? seri.find((r) => r[key] != null)?.[key] ?? null;
  const delta = end != null && initial != null ? end - initial : null;
  const ex = pf?.extremes?.[key] || null;

  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Ringkasan</h1></div>

    <div class="card">
      <div class="label">Total portofolio</div>
      <div class="figure num">${usd(worth)}</div>
      <div class="sub">${now?.cash
    ? `kas ${usd(now.cash.usd)} · di posisi ${usd(now.positionsUsd + now.feeUsd)}${(now.leftoverUsd || 0) > 0.005 ? ` · sisa token ${usd(now.leftoverUsd)}` : ''}`
    : 'hanya posisi — saldo kas tidak terbaca'}</div>
      <div class="divide">
        <div class="figrow">
          <span class="label">${net != null ? 'PnL bersih' : 'Total PnL'}</span>
          ${cap > 0 ? `<span class="aside num ${tone(net ?? pnl)}">${pct(((net ?? pnl) / cap) * 100, 2)}</span>` : ''}
        </div>
        <div class="figure num ${tone(net ?? pnl)}">${usd(net ?? pnl)}</div>
        <div class="sub">${net != null
    ? `modal ${usd(cap)} · PnL posisi ${usd(pnl)}`
    : `terealisasi ${usd(now?.realizedUsd ?? s.realizedUsd)} · berjalan ${usd(now?.unrealizedUsd ?? s.unrealizedUsd)}`}</div>
      </div>
    </div>

    <div class="grid2">
      ${statCard('Fee terkumpul', usd(s.feeUsd), s.feeUsd > 0.005 ? 'up' : '',
    s.costUsd > 0 ? `${num((s.feeUsd / s.costUsd) * 100, 2)}% dari modal · belum diklaim` : 'belum diklaim',
    apr == null ? '' : `<span class="chip ok" style="margin-left:auto">APR ${aprText(apr)}</span>`)}
      ${statCard('Fee vs IL', ilOpen == null ? '—' : usd(feeOpen + ilOpen), ilOpen == null ? '' : tone(feeOpen + ilOpen),
    ilOpen == null ? 'IL belum terhitung' : `fee ${usd(feeOpen)} · IL ${usd(ilOpen)}`)}
      ${statCard('Posisi in-range', open.length ? `${inRangeN}/${open.length}` : '—',
    !open.length ? '' : inRangeN === open.length ? 'up' : 'warn',
    !open.length ? 'belum ada posisi terbuka'
      : outUsd > 0.005 ? `${usd(outUsd)} di luar rentang — tidak menghasilkan fee` : 'semua posisi menghasilkan fee')}
      ${statCard('Win rate', st?.winRatePct != null ? `${num(st.winRatePct, 0)}%` : '—',
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

// ---- screen: Positions --------------------------------------------------------
function positionRow(p) {
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

function positionsScreen() {
  if (!S.pos) return skeleton();
  const every = S.pos.positions || [];
  const inN = every.filter((p) => p.inRange).length;
  const outN = every.filter((p) => p.inRange === false).length;
  const open = S.filter === 'in' ? every.filter((p) => p.inRange)
    : S.filter === 'out' ? every.filter((p) => p.inRange === false) : every;
  const close = (S.pos.closed || []).slice(0, 15);
  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Posisi</h1></div>
    <div class="card pad0">
      <div class="panel-head">
        <h2>Posisi terbuka (${every.length})</h2>
      </div>
      <div style="padding:0.75rem 1rem 0">
        ${segmented('filter', S.filter, [['all', 'Semua', every.length], ['in', 'In-range', inN], ['out', 'Di luar', outN]])}
      </div>
      <div class="sub" style="padding:0.625rem 1rem 0.25rem">
        Nilai <span class="num" style="color:var(--foreground)">${usd(sum(every, (p) => p.valueUsd))}</span> ·
        Fee <span class="num" style="color:var(--foreground)">${usd(sum(every, (p) => p.feeUsd))}</span> ·
        PnL <span class="num ${tone(sum(every, (p) => p.pnlUsd))}">${sgn(sum(every, (p) => p.pnlUsd))}</span>
      </div>
      ${open.length ? open.map(positionRow).join('') : '<div class="empty">Tidak ada posisi di saringan ini.</div>'}
      <div class="panel-foot">Diperbarui ${esc(ago(S.pos.syncedAt))}</div>
    </div>
    ${close.length ? `
      <div class="card pad0">
        <div class="panel-head"><h2>Sudah ditutup</h2></div>
        ${close.map((p) => `
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

// Detail of one position + the buttons that move money.
function detailScreen() {
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
      ${p.target ? `<div class="kv"><span class="k">Hasil dia</span><span class="v">${p.mirror
    ? `<span class="num ${tone(p.mirror.pnlUsd)}">${sgn(p.mirror.pnlUsd)}</span> <span class="xs muted num">${pct(p.mirror.pnlPct)}</span>${p.mirror.stale ? ' <span class="xs muted">masih terbuka</span>' : ''}`
    : '<span class="muted">wallet belum dipindai</span>'}</span></div>` : ''}
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

// ---- screen: Activity -----------------------------------------------------
function activityScreen() {
  if (!S.act) return skeleton();
  const rows = (S.act.activity || []).slice(0, 40);
  return `
    ${S.galat ? `<div class="err">${esc(S.galat)}</div>` : ''}
    <div class="pagehead"><div class="group">Pemantauan</div><h1>Aktivitas</h1></div>
    ${rows.length ? `<div class="card pad0">${rows.map((a) => {
    const k = DECISIONS[a.verdict] || null;
    return `<div class="row flat zebra">
        <div class="l">
          <div class="pair">${esc(ACTIONS[a.kind] || a.kind)}${a.symbol0 ? ` <span class="muted">·</span> ${esc(`${a.symbol0}/${a.symbol1}`)}` : ''}</div>
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

// ---- frame & drawing ---------------------------------------------
const ICON = {
  ringkasan: '<path d="M3 13h4l3 7 4-16 3 9h4"/>',
  posisi: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
  aktivitas: '<path d="M4 6h16M4 12h16M4 18h10"/>',
};
const JUDUL = { ringkasan: 'Ringkasan', posisi: 'Posisi', aktivitas: 'Aktivitas' };
// Eye icon (lucide eye / eye-off), the same as the redaction button on the dashboard.
const EYE = '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>';
const EYE_CLOSED = '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>';

function image() {
  const app = $('#app');
  if (!app.firstChild) {
    app.append(el(`<header class="top">${LOGO}<span id="chip"></span><span class="right"><span id="spin"></span><button id="eye" type="button" class="eye"></button></span></header>`));
    app.append(el('<main id="view"></main>'));
    app.append(el(`<nav class="tabs">${Object.keys(JUDUL).map((k) =>
      `<button data-tab="${k}"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>${JUDUL[k]}</button>`).join('')}</nav>`));
  }
  $('#chip').innerHTML = modeBadge(S.ov?.mode);
  $('#spin').innerHTML = S.loading || S.busy ? '<span class="spin"></span>' : '';
  const sensor = redacted();
  const eye = $('#eye');
  eye.setAttribute('aria-pressed', String(sensor));
  eye.setAttribute('aria-label', sensor ? 'Tampilkan nilai' : 'Sensor nilai');
  eye.innerHTML = `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${sensor ? EYE_CLOSED : EYE}</svg>`;
  for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('on', b.dataset.tab === S.tab);
  $('nav.tabs').style.display = S.detail ? 'none' : '';
  $('#view').innerHTML = S.detail ? detailScreen()
    : S.tab === 'posisi' ? positionsScreen()
      : S.tab === 'aktivitas' ? activityScreen()
        : summaryScreen();
}

// ---- data -----------------------------------------------------------------
async function load({ silent = false } = {}) {
  if (!silent) S.loading = true;
  image();
  try {
    // The Summary uses the position list too (in-range, fee vs IL, APR) — the same as
    // the dashboard's Summary page, so the figures never differ from the Positions screen.
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
    S.loading = false;
    image();
  }
}

// Periodic refresh only while the mini app is visible: Telegram keeps the page
// alive in the background, and polling from there just burns battery and RPC quota.
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !S.busy) load({ silent: true }); }, 20000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ silent: true }); });

// ---- actions -----------------------------------------------------------------
async function run(name, id) {
  const p = (S.pos?.positions || []).find((x) => x.id === Number(id));
  if (name === 'dasbor') return openExternal(`${location.origin}/`);
  if (name === 'dasbor-posisi') return openExternal(`${location.origin}/#positions/${id}`);
  if (name === 'pause') {
    const pause = !S.ov?.mode?.paused;
    if (!await confirmation(pause
      ? 'Jeda penyalinan? Posisi target baru tidak diikuti. Posisi yang sudah terbuka tetap dijaga.'
      : 'Lanjutkan penyalinan?')) return;
    return sendOrig(() => api('/api/mode', { paused: pause }), pause ? 'Penyalinan dijeda' : 'Penyalinan dilanjutkan');
  }
  if (name === 'klaim') {
    if (!await confirmation(`Klaim fee posisi ${pairOf(p || {})} (${usd(p?.feeUsd)})?`)) return;
    return sendOrig(() => api('/api/positions/claim', { id: Number(id) }), 'Fee diklaim');
  }
  if (name === 'tutup') {
    if (!await confirmation(`Tutup posisi ${pairOf(p || {})}?\n\nSeluruh likuiditas ditarik dan fee ikut diklaim. Hasil saat ini ${sgn(p?.pnlUsd)}.`)) return;
    return sendOrig(() => api('/api/positions/close', { id: Number(id) }), 'Posisi ditutup', () => { S.detail = null; });
  }
}

// A single path for all buttons that send transactions: lock the button, wait for
// the answer, then refetch the data. Without the lock, a second tap when the network is
// slow sends the same command twice.
async function sendOrig(fn, successMessage, after) {
  if (S.busy) return;
  S.busy = true; image();
  for (const b of document.querySelectorAll('button.act')) b.disabled = true;
  try {
    const r = await fn();
    haptic('ok');
    if (after) after();
    notify(r.note ? `${successMessage}. ${r.note}` : `${successMessage}.`);
  } catch (e) {
    haptic('err');
    notify(e.message);
  } finally {
    S.busy = false;
    await load({ silent: true });
  }
}

// ---- interaction ------------------------------------------------------------
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#eye')) { haptic('light'); return toggleRedaction(); }
  const seg = ev.target.closest('[data-seg]');
  if (seg) {
    haptic('light');
    if (seg.dataset.seg === 'range') { S.range = seg.dataset.v; image(); return load({ silent: true }); }
    S.filter = seg.dataset.v;
    return image();
  }
  const tab = ev.target.closest('nav.tabs button');
  if (tab) {
    haptic('light');
    S.tab = tab.dataset.tab; S.detail = null; S.galat = null;
    backButton();
    image();
    return load({ silent: true });
  }
  const row = ev.target.closest('[data-pos]');
  if (row) {
    haptic('light');
    S.detail = Number(row.dataset.pos);
    backButton();
    window.scrollTo(0, 0);
    return image();
  }
  const btn = ev.target.closest('[data-do]');
  if (btn) return run(btn.dataset.do, btn.dataset.id);
});

// Telegram's built-in back button, not a button of our own inside the page: in a mini app
// that is what people look for, and the swipe gesture on iOS uses it too.
function backButton() {
  const bb = tg?.BackButton;
  if (!bb) return;
  if (S.detail) bb.show(); else bb.hide();
}

// ---- start ----------------------------------------------------------------
// Dashboard colours, not Telegram theme colours — all that is taken from Telegram is light
// or dark. Telegram's top bar is matched to the page background so the join
// is invisible (hex, because setHeaderColor does not understand oklch).
const BG = { light: '#f7f7f7', dark: '#111113' };
function tema() {
  const darkVal = (tg?.colorScheme || 'light') === 'dark';
  document.body.classList.toggle('dark', darkVal);
  document.body.classList.toggle('light', !darkVal);
  try {
    tg?.setHeaderColor?.(darkVal ? BG.dark : BG.light);
    tg?.setBackgroundColor?.(darkVal ? BG.dark : BG.light);
  } catch { /* klien lama: biarkan warna bawaannya */ }
}

async function start() {
  if (tg) {
    tg.ready();
    tg.expand();
    tg.onEvent('themeChanged', tema);
    tg.BackButton?.onClick(() => { S.detail = null; backButton(); image(); });
  }
  tema();
  image();

  const initData = tg?.initData || '';
  if (!initData) {
    $('#view').innerHTML = `<div class="empty">Halaman ini dibuka dari dalam Telegram.<br><br>
      Buka bot Quiver lalu tekan tombol <b>Mini app</b> di menunya.</div>`;
    $('nav.tabs').style.display = 'none';
    return;
  }
  try {
    const r = await api('/api/tg/auth', { initData });
    ticket = r.token || null;
  } catch (e) {
    $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>
      <div class="empty">Kirim <b>/start</b> ke bot Quiver dulu, lalu buka lagi mini app ini.</div>`;
    $('nav.tabs').style.display = 'none';
    return;
  }
  await load();
  schedule();
}

start();
