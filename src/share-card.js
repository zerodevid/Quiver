'use strict';
// Kartu bagikan (share card): gambar PnL siap tempel ke X/Telegram, seperti yang
// dipunyai Based bot atau GMGN. Tiga jenis kartu dengan bingkai yang sama:
//   position  satu posisi LP: pasangan, PnL, harga masuk/keluar, fee, umur
//   total     seluruh portofolio: total PnL, win rate, fee, posisi terbaik
//   daily     satu hari: PnL terealisasi hari itu, posisi yang ditutup
//
// Digambar di server sebagai SVG lalu dirasterkan resvg — bukan di browser — supaya
// dasbor dan bot Telegram mengirim gambar yang persis sama dari satu sumber desain.
// Huruf Inter dibawa sendiri (public/fonts/*.ttf, empat bobot statis dari berkas
// variabel yang dipakai dasbor) karena VPS tidak punya font sistem; lebar teks untuk
// chip dan judul dihitung dari tabel advance glyph (src/inter-advances.json) —
// resvg tidak punya API pengukur teks, dan SVG tidak punya tata letak mengalir.
// Kartu selalu gelap supaya konsisten di linimasa siapa pun.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const ADV = require('./inter-advances.json');
const { tr, localeContext } = require('./telegram-i18n');

const W = 1200, H = 630, PAD = 56, SCALE = 2;
const C = {
  bg0: '#101416', bg1: '#191F22', text: '#F4F6F5', muted: '#A0AAA9', faint: '#84908F',
  line: 'rgba(255,255,255,0.09)', gold: '#D9AE45', amber: '#FBBF24',
  up: '#4ADE80', down: '#F87171', flat: '#C4C7D0',
};
const HIDDEN = '••••';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const FONTS = ['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => path.join(FONT_DIR, `Inter-${w}.ttf`));
const MARK = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-white.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const CHAIN_ICON = fs.readFileSync(path.join(__dirname, '..', 'public', 'robinhood-chain.jpg')).toString('base64');
// Maskot rubah di kolom kanan, ekspresinya mengikuti PnL (public/mascots/*.png, PNG
// transparan, tinggi 900 px — dirender ±620 px pada skala 2×). Dimuat sekali per proses.
const MASCOT = Object.fromEntries(['flex', 'profit', 'loss', 'neutral'].map((m) => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'mascots', `${m}.png`));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  return [m, { href: `data:image/png;base64,${png.toString('base64')}`, w, h }];
}));
// flex: untung besar (≥ FLEX_PCT% dari modal); profit/loss: arah PnL; neutral: nol / belum ada data.
const FLEX_PCT = 20;
const mood = (pnl, pnlPct) => (pnl > 0.005 ? (pnlPct >= FLEX_PCT ? 'flex' : 'profit') : pnl < -0.005 ? 'loss' : 'neutral');
// Kolom kanan dipakai maskot: teks hero berhenti di sini.
const MASCOT_X = 850;
const QUOTE = new Set(['USDG', 'WETH', 'ETH', 'USDC', 'USDT']);

// ---- format angka, sama persis dengan web/src/fmt.js ----------------------------
const loc = () => (localeContext.getStore() === 'en' ? 'en-US' : 'id-ID');
const usd = (v, d = 2) => (v == null || Number.isNaN(v) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(loc(), { maximumFractionDigits: d }));
function price(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  const dot = (s) => s.replace('.', loc() === 'id-ID' ? ',' : '.');
  if (p >= 1e9) return dot(p.toExponential(2));
  if (p >= 1e6) return p.toLocaleString(loc(), { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(loc(), { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(loc(), { maximumSignificantDigits: 3 });
  return dot(p.toExponential(2));
}
const age = (h) => (h == null ? '—'
  : h < 1 ? tr('{0} mnt', [Math.round(h * 60)])
    : h < 24 ? tr('{0} jam', [h.toFixed(1)])
      : tr('{0} hari', [(h / 24).toFixed(1)]));
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString(loc(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ() }) : '—');
const fmtDayOnly = (ts) => new Date(ts).toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ() });
const fmtDay = (ts) => new Date(ts).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ() });
const sign = (v) => (v > 0.005 ? C.up : v < -0.005 ? C.down : C.flat);
// Harga dari sqrtPriceX96 / tick — salinan fmt.js.
function sqrtPrice(sqrtX96, dec0, dec1, quoteSide) {
  if (!sqrtX96) return null;
  const r = Number(sqrtX96) / 2 ** 96;
  const p1per0 = r * r * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}
function tickPrice(tick, dec0, dec1, quoteSide) {
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}

// Zona waktu pembaca (nama IANA) untuk tanggal di kartu; diset per render.
let tz = null;
const TZ = () => tz || undefined;

// ---- primitif SVG ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Lebar teks dari tabel advance (bobot 500 & 600 tersedia; bobot lain memakai 600).
function measure(s, size, weight = 500) {
  const tab = ADV[String(weight)] || ADV['600'];
  let w = 0;
  for (const ch of String(s)) w += tab[ch] ?? 0.6;
  return w * size;
}
// `base` 'middle' meniru textBaseline canvas: garis dasar diturunkan ~0,36 em.
function txt(s, x, y, { size = 16, weight = 400, color = C.text, anchor = 'start', base = 'alphabetic', spans = '' } = {}) {
  const yy = base === 'middle' ? y + size * 0.36 : y;
  return `<text x="${x}" y="${yy}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}${spans}</text>`;
}
function chip(s, x, y, { color = C.muted, fill = 'rgba(255,255,255,0.06)' } = {}) {
  const w = measure(s, 17, 500) + 24, h = 32;
  return { w, svg: `<rect x="${x}" y="${y - h / 2}" width="${w.toFixed(1)}" height="${h}" rx="8" fill="${fill}"/>` + txt(s, x + 12, y, { size: 17, weight: 500, color, base: 'middle' }) };
}

// Layout uses bounded text widths so large values and long labels stay within the card.
function fit(s, width, size, weight = 500) {
  if (measure(s, size, weight) <= width) return String(s);
  const chars = Array.from(String(s));
  while (chars.length && measure(chars.join('') + '…', size, weight) > width) chars.pop();
  return chars.join('') + '…';
}
function fitted(s, x, y, width, options = {}) {
  const size = options.size || 16, weight = options.weight || 500;
  return txt(fit(s, width, size, weight), x, y, { ...options, size, weight });
}
function frame(tint, right, body, mascot) {
  const context = right.replace(' · Robinhood Chain', '');
  // Maskot mengisi ruang antara garis kepala (y=100) dan kotak statistik (y=421), rata kanan.
  const m = MASCOT[mascot], mh = 312, mw = Math.round((m.w / m.h) * mh);
  const mx = W - PAD + 8 - mw, my = 104;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>
  <radialGradient id="glow" cx="${mx + mw / 2}" cy="${my + mh / 2}" r="${mh * 0.95}" gradientUnits="userSpaceOnUse"><stop stop-color="${tint}" stop-opacity="0.16"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient>
  <clipPath id="chain-icon"><circle cx="948" cy="582" r="10"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect x="0" y="0" width="${W}" height="3" fill="${tint}"/>
<svg x="${PAD}" y="45" width="154" height="28" viewBox="0 0 264 48">${MARK}</svg>
${txt(context, W - PAD, 61, { size: 17, weight: 500, color: C.muted, anchor: 'end', base: 'middle' })}
<line x1="${PAD}" y1="100" x2="${W - PAD}" y2="100" stroke="${C.line}"/>
<image x="938" y="572" width="20" height="20" clip-path="url(#chain-icon)" href="data:image/jpeg;base64,${CHAIN_ICON}"/>
${txt('Robinhood Chain', 970, 583, { size: 17, weight: 500, color: C.muted, base: 'middle' })}
<image x="${mx}" y="${my}" width="${mw}" height="${mh}" href="${m.href}"/>
${body}
</svg>`;
}

function title(s, chips, x0 = PAD) {
  const y = 154;
  const active = chips.filter(([label]) => label);
  const chipWidth = active.reduce((sum, [label]) => sum + measure(label, 17, 500) + 34, 0);
  const available = W - PAD - x0 - chipWidth - 22;
  const text = fit(s, Math.max(120, available), 32, 600);
  let x = x0 + measure(text, 32, 600) + 22;
  let out = txt(text, x0, y, { size: 32, weight: 600, base: 'middle' });
  for (const [label, style] of active) {
    const c = chip(label, x, y, style); out += c.svg; x += c.w + 10;
  }
  return out;
}
// Angka besar lalu angka kedua di sebelahnya (dolar ↔ persen), keduanya berhenti sebelum
// kolom maskot; ukuran menyusut kalau angkanya panjang.
function hero({ label, big, bigColor, side, sub, subColor = C.muted }) {
  const room = MASCOT_X - PAD;
  const sideSize = side ? Math.min(40, (room * 0.4) / Math.max(measure(side, 1, 600), 1)) : 0;
  const sideW = side ? measure(side, sideSize, 600) + 22 : 0;
  const size = Math.min(108, (room - sideW) / Math.max(measure(big, 1, 700), 1));
  let out = txt(label, PAD, 226, { size: 18, weight: 500, color: C.muted });
  out += txt(big, PAD - 3, 336, { size, weight: 700, color: bigColor });
  if (side) out += txt(side, PAD - 3 + measure(big, size, 700) + 22, 336, { size: sideSize, weight: 600, color: bigColor });
  if (sub) out += fitted(sub, PAD, 383, room, { size: 19, color: subColor });
  return out;
}
function statsRow(cols, footer) {
  const y = 421, cw = (W - PAD * 2) / cols.length;
  let out = `<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="124" rx="12" fill="#FFFFFF" fill-opacity="0.025" stroke="${C.line}"/>`;
  cols.forEach(([label, value, o = {}], i) => {
    const cx = PAD + cw * i + 20, width = cw - 40;
    if (i) out += `<line x1="${PAD + cw * i}" y1="${y + 24}" x2="${PAD + cw * i}" y2="${y + 100}" stroke="${C.line}"/>`;
    out += fitted(label, cx, y + 30, width, { size: 16, color: C.muted });
    const size = Math.min(29, width / Math.max(measure(value, 1, 600), 1));
    out += txt(value, cx, y + 70, { size, weight: 600, color: o.color || C.text });
    if (o.extra) out += fitted(o.extra[0], cx, y + 100, width, { size: 15, color: o.extra[1] });
  });
  if (footer) out += fitted(footer, PAD, 588, 850, { size: 15, color: C.faint });
  return out;
}
// Lambang token: logo bulat (PNG/JPEG/GIF yang tersimpan di server), atau lingkaran
// berwarna dengan inisial — rona dari alamat, sama dengan TokenIcon di dasbor.
function hue(addr = '') {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}
function token(icon, { address, symbol }, x, y, r, id) {
  const ring = `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${C.bg0}" stroke-width="3"/>`;
  if (icon && /^image\/(png|jpeg|gif)$/.test(icon.ctype)) {
    return `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>`
      + `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.bg1}"/>`
      + `<image x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice" href="data:${icon.ctype};base64,${icon.buf.toString('base64')}"/>` + ring;
  }
  const initials = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${hue((address || '').toLowerCase())}, 45%, 55%)"/>`
    + txt(initials, x, y + 1, { size: Math.round(r * 0.8), weight: 600, color: '#fff', anchor: 'middle', base: 'middle' }) + ring;
}

// ---- kartu posisi -----------------------------------------------------------------
// p: baris dari GET /api/position; icons: { token0, token1 } hasil icons.read().
function positionSvg(p, { hideAmounts = false, icons = {} } = {}) {
  const closed = p.status === 'closed';
  const pEntry = sqrtPrice(p.entrySqrt, p.dec0, p.dec1, p.quoteSide);
  const pNow = closed ? sqrtPrice(p.exitSqrt, p.dec0, p.dec1, p.quoteSide)
    : p.curSqrt ? sqrtPrice(p.curSqrt, p.dec0, p.dec1, p.quoteSide)
      : p.curTick != null ? tickPrice(p.curTick, p.dec0, p.dec1, p.quoteSide) : null;
  const quote = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const base = p.quoteSide === 0 ? p.symbol1 : p.symbol0;
  const move = pEntry != null && pNow != null ? (pNow / pEntry - 1) * 100 : null;
  // Fee yang benar-benar diperoleh: sudah diklaim + (kalau masih terbuka) yang belum.
  const feeUsd = (p.claimedUsd || 0) + (closed ? 0 : (p.feeUsd || 0));
  const status = closed ? tr('Ditutup') : p.empty ? tr('Likuiditas kosong') : p.inRange == null ? tr('belum tersinkron') : p.inRange ? 'in-range' : tr('di luar rentang');
  const pair = `${p.symbol0 || '?'} / ${p.symbol1 || '?'}`;
  const y = 154;
  let body = token(icons.token0, { address: p.token0, symbol: p.symbol0 }, PAD + 26, y, 26, 'c0')
    + token(icons.token1, { address: p.token1, symbol: p.symbol1 }, PAD + 64, y, 26, 'c1');
  body += title(pair, [
    [p.fee != null ? tr('fee {0}%', [num(p.fee / 10000, 2)]) : null],
    [status, closed ? {} : p.inRange ? { color: C.up, fill: 'rgba(74,222,128,0.12)' } : { color: C.amber, fill: 'rgba(251,191,36,0.13)' }],
  ], PAD + 108);
  body += hero({
    label: 'PnL', big: p.pnlPct == null ? '—' : pct(p.pnlPct, 2), bigColor: sign(p.pnlUsd),
    side: hideAmounts ? null : usd(p.pnlUsd),
    sub: hideAmounts ? tr('Nominal disembunyikan')
      : tr('{0} modal › {1} {2}', [usd(p.costUsd), usd(closed ? p.outUsd : (p.valueUsd || 0) + (p.feeUsd || 0)), tr(closed ? 'hasil keluar' : 'nilai + fee')]),
    subColor: hideAmounts ? C.faint : C.muted,
  });
  // Harga dinyatakan sebagai pasangan (OPAI/USDG), bukan dolar: itu satuan pool-nya.
  const unit = quote ? ` · ${base}/${quote}` : '';
  body += statsRow([
    [tr('Harga masuk') + unit, price(pEntry)],
    [tr(closed ? 'Harga keluar' : 'Harga sekarang') + unit, price(pNow), { extra: move != null ? [pct(move, 1), sign(move)] : null }],
    [tr('Fee diperoleh'), hideAmounts ? HIDDEN : usd(feeUsd), { color: C.up }],
    [tr(closed ? 'Ditahan' : 'Umur'), age(p.ageHours)],
  ], closed ? `${fmtDate(p.opened_ts)} › ${fmtDate(p.closed_ts)}` : tr('masuk {0}', [fmtDate(p.opened_ts)]));
  return frame(sign(p.pnlUsd), `Uniswap ${String(p.venue || '').toUpperCase()} · Robinhood Chain`, body, mood(p.pnlUsd, p.pnlPct));
}

// ---- kartu total portofolio -------------------------------------------------------
// now/stats: bentuk yang sama dengan /api/portfolio; since: posisi pertama dibuka.
function totalSvg({ now, stats, since }, { hideAmounts = false } = {}) {
  const pnlPct = now.capital > 0 ? (now.pnl / now.capital) * 100 : null;
  const wr = stats?.winRatePct;
  const body = title(tr('Total PnL'), [
    [tr('{0} posisi terbuka', [now.openCount || 0])],
    [stats?.closedCount ? tr('{0} ditutup', [stats.closedCount]) : null],
  ]) + hero({
    label: 'PnL', bigColor: sign(now.pnl),
    big: hideAmounts ? (pnlPct == null ? HIDDEN : pct(pnlPct, 2)) : usd(now.pnl),
    side: hideAmounts || pnlPct == null ? null : pct(pnlPct, 2),
    sub: hideAmounts ? tr('Nominal disembunyikan') : tr('terealisasi {0} · berjalan {1}', [usd(now.realizedUsd), usd(now.unrealizedUsd)]),
    subColor: hideAmounts ? C.faint : C.muted,
  }) + statsRow([
    [tr('Total portofolio'), hideAmounts ? HIDDEN : usd(now.value)],
    [tr('Win rate'), wr == null ? '—' : `${num(wr, 0)}%`, { color: wr == null ? C.text : wr >= 50 ? C.up : C.down,
      extra: stats?.closedCount ? [tr('{0} menang · {1} kalah', [stats.wins, stats.losses]), C.muted] : null }],
    [tr('Fee terkumpul'), hideAmounts ? HIDDEN : usd(now.feeUsd), { color: C.up }],
    [tr('Posisi terbaik'), stats?.best == null ? '—' : hideAmounts ? HIDDEN : usd(stats.best), { color: sign(stats?.best) }],
  ], since ? tr('sejak {0} · {1}', [fmtDayOnly(since), fmtDate(Date.now())]) : fmtDate(Date.now()));
  return frame(sign(now.pnl), tr('Seluruh portofolio') + ' · Robinhood Chain', body, mood(now.pnl, pnlPct));
}

// ---- kartu PnL harian ---------------------------------------------------------------
// day 'YYYY-MM-DD'; rows: posisi yang ditutup hari itu [{symbol0,symbol1,pnl,cost}];
// total/count dari kalender (daftar posisi tertutup bisa terpotong); monthTotal: PnL bulan itu.
function dailySvg({ day, rows, total: totalIn, count, monthTotal }, { hideAmounts = false } = {}) {
  const total = totalIn ?? rows.reduce((a, r) => a + r.pnl, 0);
  const ts = new Date(day + 'T12:00:00').getTime();
  const wins = rows.filter((r) => r.pnl > 0.005).length, losses = rows.filter((r) => r.pnl < -0.005).length;
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const dayPct = cost > 0 ? (total / cost) * 100 : null;
  const best = rows.reduce((a, r) => (a == null || r.pnl > a.pnl ? r : a), null);
  const worst = rows.reduce((a, r) => (a == null || r.pnl < a.pnl ? r : a), null);
  // Cukup token spekulatifnya: "USDG/OPAI" terlalu panjang untuk satu kolom.
  const nameOf = (r) => (r ? ` · ${QUOTE.has(r.symbol0) ? r.symbol1 || '?' : r.symbol0 || '?'}` : '');
  const val = (r) => (r ? (hideAmounts ? (r.cost > 0 ? pct((r.pnl / r.cost) * 100, 1) : HIDDEN) : usd(r.pnl)) : '—');
  const body = title(fmtDay(ts), [[tr('{0} posisi ditutup', [count ?? rows.length])]]) + hero({
    label: tr('PnL terealisasi'), bigColor: sign(total),
    big: hideAmounts ? (dayPct == null ? HIDDEN : pct(dayPct, 2)) : usd(total),
    side: hideAmounts || dayPct == null ? null : pct(dayPct, 2),
    sub: tr('{0} menang · {1} kalah', [wins, losses]) + (hideAmounts || !(cost > 0) ? '' : ` · ${tr('modal diputar {0}', [usd(cost)])}`),
  }) + statsRow([
    [tr('Posisi terbaik') + nameOf(best), val(best), { color: sign(best?.pnl) }],
    [tr('Posisi terburuk') + nameOf(worst), val(worst), { color: sign(worst?.pnl) }],
    [tr('Win rate'), rows.length ? `${num((wins / rows.length) * 100, 0)}%` : '—', { color: !rows.length ? C.text : wins / rows.length >= 0.5 ? C.up : C.down }],
    [tr('Bulan ini'), hideAmounts ? HIDDEN : usd(monthTotal), { color: sign(monthTotal) }],
  ], tr('PnL terealisasi dari posisi yang ditutup pada {0}', [fmtDayOnly(ts)]));
  return frame(sign(total), tr('PnL harian') + ' · Robinhood Chain', body, mood(total, dayPct));
}

// Pilih kartu dan gambar. lang 'id'|'en'; timeZone nama IANA (mis. 'Asia/Jakarta').
function svgOf(kind, data, opts = {}) {
  return localeContext.run(opts.lang === 'en' ? 'en' : 'id', () => {
    tz = opts.timeZone || null;
    try {
      if (kind === 'position') return positionSvg(data, opts);
      if (kind === 'total') return totalSvg(data, opts);
      if (kind === 'daily') return dailySvg(data, opts);
      throw new Error(`jenis kartu tidak dikenal: ${kind}`);
    } finally { tz = null; }
  });
}
function renderPng(svg) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * SCALE },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return Buffer.from(r.render().asPng());
}
const render = (kind, data, opts) => renderPng(svgOf(kind, data, opts));

// Teks pendamping (caption Telegram / teks Web Share) — angka mengikuti bahasa.
function caption(kind, data, lang) {
  return localeContext.run(lang === 'en' ? 'en' : 'id', () => {
    if (kind === 'position') return `${data.symbol0 || '?'} / ${data.symbol1 || '?'} ${data.pnlPct == null ? '' : pct(data.pnlPct, 2)} · Quiver`;
    if (kind === 'total') return `${tr('Total PnL')} ${usd(data.now.pnl)} · Quiver`;
    return `PnL ${data.day}: ${usd(data.total ?? data.rows.reduce((a, r) => a + r.pnl, 0))} · Quiver`;
  });
}

module.exports = { svgOf, renderPng, render, caption, W, H, SCALE };
