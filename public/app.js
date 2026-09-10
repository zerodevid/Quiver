'use strict';
// Kalau ada error JS, jangan biarkan halaman kosong tanpa penjelasan.
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && e.reason.message || String(e.reason)));
function showFatal(msg) {
  if (document.getElementById('fatalBanner')) return;
  const d = document.createElement('div');
  d.id = 'fatalBanner';
  d.className = 'alert alert-danger position-fixed bottom-0 end-0 m-3';
  d.style.zIndex = 2000; d.style.maxWidth = '28rem';
  d.innerHTML = '<div class="fw-bold mb-1">Tampilan gagal dimuat</div><div class="small mb-2"></div>'
    + '<button class="btn btn-sm btn-danger" onclick="location.reload()">Muat ulang</button>';
  d.querySelector('.small').textContent = msg;
  document.body.appendChild(d);
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (p, opts) => (await fetch(p, opts)).json();
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const usd = (v, d = 2) => (v == null ? '—' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
const ago = (ts) => {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return Math.round(s) + ' dtk';
  if (s < 3600) return Math.round(s / 60) + ' mnt';
  if (s < 86400) return (s / 3600).toFixed(1) + ' jam';
  return (s / 86400).toFixed(1) + ' hari';
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cls = (v) => (v > 0 ? 'text-green' : v < 0 ? 'text-red' : '');

// ---- tema -----------------------------------------------------------------
const theme = {
  get() { return document.documentElement.getAttribute('data-bs-theme') || 'light'; },
  set(t) {
    document.documentElement.setAttribute('data-bs-theme', t);
    try { localStorage.setItem('lpcopy-theme', t); } catch (e) { /* abaikan */ }
    for (const b of [$('#btnTheme'), $('#btnThemeMobile')]) {
      const ic = b && b.querySelector('i');
      if (ic) ic.className = t === 'dark' ? 'ti ti-sun' : 'ti ti-moon';
    }
    // ApexCharts tidak ikut variabel CSS, jadi temanya harus dioper manual.
    if (equityChart) equityChart.updateOptions(chartTheme(t), false, false);
  },
  toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); },
  init() {
    this.set(this.get());
    $('#btnTheme').onclick = () => this.toggle();
    const tm = $('#btnThemeMobile'); if (tm) tm.onclick = () => this.toggle();
    // Ikuti tema sistem selama pengguna belum memilih sendiri.
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('lpcopy-theme')) this.set(e.matches ? 'dark' : 'light');
      });
    } catch (e) { /* abaikan */ }
  },
};
function chartTheme(t) {
  const dark = t === 'dark';
  return {
    theme: { mode: dark ? 'dark' : 'light' },
    chart: { background: 'transparent' },
    grid: { strokeDashArray: 0, borderColor: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)' },
    tooltip: { theme: dark ? 'dark' : 'light', x: { format: 'dd MMM HH:mm' } },
    // xaxis/yaxis DIGANTI seluruhnya oleh updateOptions, bukan digabung — jadi
    // konfigurasi aslinya (type datetime, format label) harus ikut disertakan di sini.
    // Tanpa ini sumbu waktu berubah jadi angka epoch mentah saat tema diganti.
    xaxis: {
      type: 'datetime',
      labels: { datetimeUTC: false, style: { colors: dark ? '#9aa4b2' : '#667382' } },
    },
    yaxis: {
      labels: {
        formatter: (v) => '$' + Number(v).toFixed(0),
        style: { colors: dark ? '#9aa4b2' : '#667382' },
      },
    },
  };
}

// ---- label ----------------------------------------------------------------
const AKSI = {
  increase: ['Tambah likuiditas', 'bg-blue-lt'], decrease: ['Kurangi likuiditas', 'bg-orange-lt'],
  custody_out: ['Titip ke otomasi', 'bg-secondary-lt'], custody_in: ['Kembali dari otomasi', 'bg-secondary-lt'],
  transfer_in: ['Terima posisi', 'bg-secondary-lt'], transfer_out: ['Kirim posisi', 'bg-orange-lt'],
  mint: ['Buka posisi', 'bg-blue-lt'], collect: ['Klaim fee', 'bg-green-lt'],
};
const KEPUTUSAN = {
  copy: ['Disalin', 'bg-green-lt'], dry: ['Simulasi', 'bg-blue-lt'],
  skip: ['Dilewati', 'bg-secondary-lt'], error: ['Gagal', 'bg-red-lt'],
};
const TXKIND = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi', burn: 'Tutup posisi',
  approve_erc20: 'Izin token', approve_permit2: 'Izin Permit2', zap_swap: 'Tukar (zap)',
  bridge_swap: 'Tukar kas', wrap_eth: 'Bungkus ETH', unwrap_weth: 'Buka WETH',
};
const TXSTATUS = { sukses: ['Sukses', 'bg-green-lt'], pending: ['Menunggu', 'bg-yellow-lt'], gagal: ['Gagal', 'bg-red-lt'] };
const lbl = (map, k) => { const v = map[k]; return v ? `<span class="badge ${v[1]}">${v[0]}</span>` : `<span class="badge bg-secondary-lt">${esc(k || '—')}</span>`; };
const emptyRow = (cols, title, sub = '') => `<tr><td colspan="${cols}"><div class="empty py-4">
  <p class="empty-title">${title}</p>${sub ? `<p class="empty-subtitle text-secondary">${sub}</p>` : ''}</div></td></tr>`;

// ---- navigasi -------------------------------------------------------------
function route() {
  const page = (location.hash || '#ringkasan').slice(1);
  const menu = document.getElementById('sidebar-menu');
  if (menu && menu.classList.contains('show') && window.bootstrap) window.bootstrap.Collapse.getOrCreateInstance(menu).hide();
  $$('section[data-page]').forEach((s) => { s.hidden = s.dataset.page !== page; });
  $$('#mainNav .nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + page));
  refresh(page);
}
window.addEventListener('hashchange', route);

// ---- rentang visual -------------------------------------------------------
function rangeBar(lo, hi, cur) {
  if (lo == null || hi == null) return '';
  const span = hi - lo;
  const padSpan = span * 0.6;
  const min = lo - padSpan, max = hi + padSpan;
  const p = (t) => Math.max(0, Math.min(100, ((t - min) / (max - min)) * 100));
  const nowP = cur == null ? null : p(cur);
  return `<div class="range-bar" title="tick ${lo} … ${hi}${cur != null ? ' | sekarang ' + cur : ''}">
    <div class="band" style="left:${p(lo)}%;width:${p(hi) - p(lo)}%"></div>
    ${nowP == null ? '' : `<div class="now" style="left:${nowP}%"></div>`}
  </div>`;
}
const widthPct = (lo, hi) => ((1.0001 ** (hi - lo) - 1) * 100);

// ---- ringkasan ------------------------------------------------------------
let equityChart = null;
async function loadOverview() {
  const d = await api('/api/overview');
  const badge = $('#modeBadge');
  badge.textContent = d.mode.paused ? 'Dijeda' : (d.mode.dry_run ? 'Simulasi' : 'Live');
  badge.className = 'badge ' + (d.mode.paused ? 'bg-secondary-lt' : d.mode.dry_run ? 'bg-blue-lt' : 'bg-red-lt');
  $('#walletBadge').textContent = d.mode.wallet ? short(d.mode.wallet) : 'belum ada';
  $('#btnPause').innerHTML = d.mode.paused
    ? '<i class="ti ti-player-play me-1"></i>Lanjutkan'
    : '<i class="ti ti-player-pause me-1"></i>Jeda';
  $('#btnPause').onclick = async () => { await post('/api/mode', { paused: !d.mode.paused }); loadOverview(); };

  const s = d.summary;
  $('#kExposure').textContent = usd(s.exposureUsd);
  $('#kExposureSub').textContent = `${s.openCount} posisi · ${s.inRange} in-range`;
  $('#kFees').textContent = usd(s.feeUsd);
  $('#kFees').className = 'kpi-value num ' + (s.feeUsd > 0 ? 'text-green' : '');
  $('#kFeesSub').textContent = s.costUsd > 0 ? `${((s.feeUsd / s.costUsd) * 100).toFixed(2)}% dari modal` : 'belum diklaim';
  $('#kPnl').textContent = usd(s.unrealizedUsd);
  $('#kPnl').className = 'kpi-value num ' + cls(s.unrealizedUsd);
  $('#kReal').textContent = usd(s.realizedUsd);
  $('#kReal').className = 'kpi-value num ' + cls(s.realizedUsd);

  $('#mHead').textContent = d.chain.head.toLocaleString('id-ID');
  $('#mLag').innerHTML = d.chain.lag < 60
    ? `<span class="status-dot bg-green"></span>${d.chain.lag} blok`
    : `<span class="status-dot bg-yellow"></span>${d.chain.lag.toLocaleString('id-ID')} blok`;
  const T = d.totals || { actions: d.stats.actions, would: d.stats.copied, skipped: d.stats.skipped };
  $('#mActions').textContent = T.actions.toLocaleString('id-ID');
  $('#mCopied').textContent = `${T.would} / ${T.skipped}`;
  $('#mEth').textContent = usd(d.chain.ethUsd);
  $('#mRpc').innerHTML = d.rpc.map((r) => `<span title="${esc(r.host)}">${r.lastMs}ms</span>${r.cooling ? '<span class="text-yellow">*</span>' : ''}`).join(' · ');
  const err = $('#mError');
  if (d.stats.lastError) { err.classList.remove('d-none'); err.textContent = 'Error terakhir: ' + d.stats.lastError; }
  else err.classList.add('d-none');

  $('#tblSkip').innerHTML = d.skipReasons.map((r) => `<tr><td class="reason">${esc(r.reason)}</td><td class="text-end text-secondary num w-1">${r.n}</td></tr>`).join('') || emptyRow(2, 'Belum ada yang dilewati');

  const tx = await api('/api/txs');
  $('#tblTx').innerHTML = tx.txs.slice(0, 8).map((t) => `<tr>
    <td>${lbl(TXSTATUS, t.status)}</td>
    <td>${esc(TXKIND[t.kind] || t.kind)}</td>
    <td class="text-secondary mono">${short(t.hash)}</td>
    <td class="text-end text-secondary">${ago(t.ts)} lalu</td></tr>`).join('') || emptyRow(4, 'Belum ada transaksi', 'Mode simulasi tidak mengirim transaksi.');

  const series = d.equity.map((e) => [e.ts, e.total_quote]);
  const box = $('#chartEquity');
  const kosong = series.length < 2 || series.every(([, v]) => !v);
  if (kosong) {
    if (equityChart) { equityChart.destroy(); equityChart = null; }
    box.innerHTML = `<div class="empty h-100 py-4">
      <p class="empty-title">Belum ada riwayat nilai</p>
      <p class="empty-subtitle text-secondary">Grafik terisi setelah bot membuka posisi. Nilai dicatat tiap 5 menit.</p></div>`;
    return;
  }
  if (!equityChart) {
    box.innerHTML = '';
    equityChart = new ApexCharts(box, {
      chart: { type: 'line', height: '100%', toolbar: { show: false }, zoom: { enabled: false },
        animations: { enabled: false }, fontFamily: 'inherit', parentHeightOffset: 0 },
      series: [{ name: 'Nilai', data: series }],
      dataLabels: { enabled: false },
      stroke: { width: 2, curve: 'straight' },
      fill: { type: 'solid', opacity: 1 },
      markers: { size: 0 },
      colors: ['#206bc4'],
      legend: { show: false },
      ...chartTheme(theme.get()),
    });
    equityChart.render();
  } else equityChart.updateSeries([{ name: 'Nilai', data: series }]);
}

// ---- posisi ---------------------------------------------------------------
async function loadPositions() {
  const d = await api('/api/positions');
  $('#posMeta').textContent = `${d.positions.length} posisi`;
  $('#tblPositions').innerHTML = d.positions.map((p) => `<tr>
    <td><div class="d-flex flex-column">
      <span class="fw-bold">${esc(p.symbol0)}/${esc(p.symbol1)}</span>
      <span class="text-secondary small">${p.venue} · fee ${(p.fee / 10000).toFixed(2)}%
        ${p.inRange ? '<span class="badge bg-green-lt ms-1">in-range</span>' : '<span class="badge bg-orange-lt ms-1">di luar</span>'}</span>
    </div></td>
    <td style="min-width:9rem">${rangeBar(p.tick_lower, p.tick_upper, p.curTick)}
      <span class="text-secondary small num">lebar ${widthPct(p.tick_lower, p.tick_upper).toFixed(0)}%</span></td>
    <td class="text-end num">${usd(p.valueUsd)}<div class="text-secondary small">modal ${usd(p.costUsd)}</div></td>
    <td class="text-end num text-green">${usd(p.feeUsd)}</td>
    <td class="text-end num ${cls(p.pnlUsd)}">${usd(p.pnlUsd)}<div class="small">${pct(p.pnlPct)}</div></td>
    <td class="text-end num ${cls(p.ilUsd)}">${p.ilUsd == null ? '—' : usd(p.ilUsd)}</td>
    <td class="cell-narrow text-secondary">${p.ageHours < 24 ? p.ageHours.toFixed(1) + ' jam' : (p.ageHours / 24).toFixed(1) + ' hr'}</td>
    <td class="text-secondary mono">${short(p.target)}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-close="${p.id}">Tutup</button></td>
  </tr>`).join('') || emptyRow(9, 'Belum ada posisi terbuka', 'Posisi muncul di sini setelah bot menyalin LP dari wallet target.');
  $$('[data-close]').forEach((b) => b.onclick = async () => {
    if (!confirm('Tutup posisi ini sekarang?')) return;
    const r = await post('/api/positions/close', { id: Number(b.dataset.close) });
    alert(r.error ? 'Gagal: ' + r.error : 'Terkirim: ' + r.tx);
    loadPositions();
  });
  $('#tblClosed').innerHTML = d.closed.map((c) => {
    const pnl = (c.out_quote || 0) - (c.cost_quote || 0);
    return `<tr><td class="mono">${esc(c.token_id || '')}</td>
      <td class="text-end num">${usd(c.cost_quote)}</td>
      <td class="text-end num">${usd(c.out_quote)}</td>
      <td class="text-end num ${cls(pnl)}">${usd(pnl)}</td>
      <td class="text-secondary">${ago(c.closed_ts)} lalu</td></tr>`;
  }).join('') || emptyRow(5, 'Belum ada posisi tertutup');
}

// ---- aturan ---------------------------------------------------------------
const SCHEMA = [
  { group: 'Ukuran posisi', icon: 'ti-ruler', fields: [
    { path: 'sizing.mode', label: 'Cara menentukan ukuran', type: 'select', options: [
      ['mirror', 'Sama persis dengan target'], ['pct', 'Persen dari target'],
      ['multiplier', 'Kelipatan dari target'], ['fixed_quote', 'Nominal tetap']],
      help: 'mirror = likuiditas identik; pct/multiplier = skala; nominal tetap = modal sama tiap posisi' },
    { path: 'sizing.pct', label: 'Persen dari target (%)', type: 'number', step: 1, when: (r) => r.sizing.mode === 'pct' },
    { path: 'sizing.multiplier', label: 'Kelipatan', type: 'number', step: 0.1, when: (r) => r.sizing.mode === 'multiplier' },
    { path: 'sizing.fixed_quote_usd', label: 'Nominal tetap (USD)', type: 'number', step: 5, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi USDG' },
    { path: 'sizing.fixed_quote_eth', label: 'Nominal tetap (ETH)', type: 'number', step: 0.005, when: (r) => r.sizing.mode === 'fixed_quote',
      help: 'dipakai di pool berkuotasi ETH/WETH' },
    { path: 'sizing.min_quote_usd', label: 'Minimum per posisi (USD)', type: 'number', step: 1 },
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
    { path: 'exit.out_of_range_minutes', label: 'Tutup kalau di luar rentang selama (menit, 0=mati)', type: 'number', step: 5 },
    { path: 'exit.stop_loss_pct', label: 'Stop loss (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.take_profit_pct', label: 'Take profit (%, 0=mati)', type: 'number', step: 1 },
    { path: 'exit.max_age_hours', label: 'Umur maksimum (jam, 0=mati)', type: 'number', step: 1 },
  ] },
  { group: 'Saringan', icon: 'ti-filter', fields: [
    { path: 'filters.allow_hooks', label: 'Izinkan pool v4 dengan hook', type: 'bool', help: 'Hook bisa memblokir penarikan — default: tolak' },
    { path: 'filters.min_target_quote_usd', label: 'Abaikan posisi target di bawah (USD)', type: 'number', step: 5 },
    { path: 'filters.max_open_positions', label: 'Maksimum posisi terbuka', type: 'number', step: 1 },
    { path: 'filters.cooldown_seconds', label: 'Jeda antar salinan di pool sama (detik)', type: 'number', step: 5 },
    { path: 'filters.quote_whitelist', label: 'Aset kuotasi diizinkan', type: 'list' },
    { path: 'filters.venues', label: 'Venue diizinkan', type: 'list' },
    { path: 'filters.token_blacklist', label: 'Daftar hitam token (alamat, pisah koma)', type: 'list' },
    { path: 'filters.token_whitelist', label: 'Daftar putih token (kosong = semua)', type: 'list' },
  ] },
];
const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const put = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let c = o; for (const k of ks) c = (c[k] = c[k] || {}); c[last] = v; };

function renderRules(container, rules, idPrefix) {
  container.innerHTML = SCHEMA.map((g) => `
    <h4 class="mt-3 mb-2" data-group="${g.group}"><i class="ti ${g.icon} me-1"></i>${g.group}</h4>
    <div class="row g-2">
      ${g.fields.map((f) => {
        const v = dig(rules, f.path);
        const id = idPrefix + f.path.replace(/\./g, '_');
        let input;
        if (f.type === 'select') input = `<select class="form-select" id="${id}" data-path="${f.path}" data-type="select">${f.options.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        else if (f.type === 'bool') input = `<label class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" id="${id}" data-path="${f.path}" data-type="bool" ${v ? 'checked' : ''}><span class="form-check-label">${v ? 'aktif' : 'mati'}</span></label>`;
        else if (f.type === 'list') input = `<input class="form-control mono" id="${id}" data-path="${f.path}" data-type="list" value="${esc((v || []).join(', '))}">`;
        else input = `<input class="form-control num" type="number" step="${f.step || 1}" id="${id}" data-path="${f.path}" data-type="number" value="${v ?? 0}">`;
        return `<div class="col-md-6 col-xl-4" data-field="${f.path}"><label class="form-label" for="${id}">${f.label}</label>${input}
          ${f.help ? `<div class="form-hint">${f.help}</div>` : ''}</div>`;
      }).join('')}
    </div>`).join('');
  container.querySelectorAll('[data-type="bool"]').forEach((el) => el.onchange = () => {
    el.nextElementSibling.textContent = el.checked ? 'aktif' : 'mati';
  });
  // Sembunyikan field yang tidak berlaku untuk mode yang sedang dipilih. Nilainya tetap
  // ada di DOM (dan ikut tersimpan), jadi kembali ke mode lama tidak kehilangan setelan.
  const apply = () => {
    const cur = collectRules(container);
    for (const g of SCHEMA) {
      for (const f of g.fields) {
        if (!f.when) continue;
        const wrap = container.querySelector(`[data-field="${f.path}"]`);
        if (wrap) wrap.classList.toggle('d-none', !f.when(cur));
      }
      // sembunyikan judul grup kalau semua isinya tersembunyi
      const head = container.querySelector(`[data-group="${g.group}"]`);
      const row = head && head.nextElementSibling;
      if (head && row) {
        const anyVisible = [...row.children].some((c) => !c.classList.contains('d-none'));
        head.classList.toggle('d-none', !anyVisible);
      }
    }
  };
  container.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('change', apply);
    el.addEventListener('input', apply);
  });
  apply();
}
function collectRules(container) {
  const out = {};
  container.querySelectorAll('[data-path]').forEach((el) => {
    const t = el.dataset.type;
    let v;
    if (t === 'bool') v = el.checked;
    else if (t === 'number') v = Number(el.value);
    else if (t === 'list') v = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    else v = el.value;
    put(out, el.dataset.path, v);
  });
  return out;
}
async function loadRules() {
  const d = await api('/api/rules');
  renderRules($('#rulesForm'), d.rules, 'g_');
  $('#btnSaveRules').onclick = async () => {
    const r = await post('/api/rules', { rules: collectRules($('#rulesForm')) });
    $('#rulesStatus').textContent = r.ok ? 'tersimpan ' + new Date().toLocaleTimeString('id-ID') : 'gagal';
  };
}

// ---- target ---------------------------------------------------------------
async function loadTargets() {
  const d = await api('/api/targets');
  $('#targetList').innerHTML = d.targets.map((t, i) => `
    <div class="card mb-3">
      <div class="card-header">
        <div class="d-flex align-items-center gap-2 w-100">
          <label class="form-check form-switch m-0">
            <input class="form-check-input" type="checkbox" data-toggle-target="${t.address}" ${t.enabled ? 'checked' : ''}>
          </label>
          <div class="flex-fill">
            <div class="fw-bold">${esc(t.label || 'tanpa label')}</div>
            <div class="text-secondary mono small">${t.address}</div>
          </div>
          <div class="text-end">
            <div class="text-secondary small">${t.actions} aksi · ${t.copied} disalin</div>
            <div class="text-secondary small">${t.openPositions} posisi kita · ${usd(t.openCostQuote)}</div>
          </div>
          <button class="btn btn-sm btn-outline-secondary" data-edit="${i}"><i class="ti ti-adjustments"></i> Aturan</button>
          <button class="btn btn-sm btn-outline-danger" data-del="${t.address}"><i class="ti ti-trash"></i></button>
        </div>
      </div>
      <div class="card-body d-none" data-rules="${i}">
        <div class="alert alert-info">Aturan khusus wallet ini. Kalau tidak diubah, dipakai aturan default.</div>
        <div data-rules-form="${i}"></div>
        <div class="text-end mt-3">
          <button class="btn btn-outline-secondary" data-reset="${t.address}">Pakai default</button>
          <button class="btn btn-primary" data-save="${t.address}" data-idx="${i}">Simpan</button>
        </div>
      </div>
    </div>`).join('') || '<div class="card"><div class="card-body text-secondary">Belum ada wallet target.</div></div>';

  $$('[data-toggle-target]').forEach((el) => el.onchange = () => post('/api/targets/toggle', { address: el.dataset.toggleTarget, enabled: el.checked }));
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Hapus wallet ini dari daftar?')) return;
    await post('/api/targets/delete', { address: b.dataset.del }); loadTargets();
  });
  $$('[data-edit]').forEach((b) => b.onclick = () => {
    const i = b.dataset.edit;
    const body = $(`[data-rules="${i}"]`);
    body.classList.toggle('d-none');
    if (!body.classList.contains('d-none') && !body.dataset.built) {
      renderRules($(`[data-rules-form="${i}"]`), d.targets[i].rulesResolved, `t${i}_`);
      body.dataset.built = '1';
    }
  });
  $$('[data-save]').forEach((b) => b.onclick = async () => {
    await post('/api/targets/rules', { address: b.dataset.save, rules: collectRules($(`[data-rules-form="${b.dataset.idx}"]`)) });
    b.textContent = 'Tersimpan';
    setTimeout(() => { b.textContent = 'Simpan'; }, 1500);
  });
  $$('[data-reset]').forEach((b) => b.onclick = async () => {
    await post('/api/targets/rules', { address: b.dataset.reset, rules: null }); loadTargets();
  });
  $('#btnAddTarget').onclick = async () => {
    const r = await post('/api/targets', { address: $('#newAddr').value.trim(), label: $('#newLabel').value.trim() || null });
    if (r.error) return alert(r.error);
    $('#newAddr').value = ''; $('#newLabel').value = ''; loadTargets();
  };
}

// ---- aktivitas ------------------------------------------------------------
async function loadActivity() {
  const d = await api('/api/activity?limit=200');
  const f = $('#filterVerdict').value;
  const rows = d.activity.filter((a) => !f || a.verdict === f);
  const vb = { copy: 'bg-green-lt', dry: 'bg-azure-lt', skip: 'bg-secondary-lt', error: 'bg-red-lt' };
  $('#tblActivity').innerHTML = rows.map((a) => `<tr>
    <td class="text-secondary cell-narrow">${ago(a.ts)} lalu</td>
    <td class="mono text-secondary">${short(a.target)}</td>
    <td>${lbl(AKSI, a.kind)} <span class="text-secondary small ms-1">${esc(a.venue)}</span></td>
    <td>${a.symbol0 ? esc(a.symbol0) + '/' + esc(a.symbol1) : '<span class="text-secondary">—</span>'}</td>
    <td style="min-width:8rem">${rangeBar(a.tick_lower, a.tick_upper, null)}
      <span class="text-secondary small">${a.tick_lower != null ? widthPct(a.tick_lower, a.tick_upper).toFixed(0) + '%' : ''}</span></td>
    <td class="text-end num">${a.value_quote == null ? '—' : (a.quote_symbol === 'ETH' ? a.value_quote.toFixed(4) + ' Ξ' : usd(a.value_quote))}</td>
    <td>${lbl(KEPUTUSAN, a.verdict)}
        <div class="text-secondary small reason mt-1" title="${esc(a.reason)}">${esc(a.reason || '')}</div></td>
    <td class="mono text-secondary">${a.decision_tx ? short(a.decision_tx) : ''}</td>
  </tr>`).join('') || emptyRow(8, 'Belum ada aktivitas', 'Gerakan LP wallet target akan muncul di sini begitu terdeteksi.');
  $('#filterVerdict').onchange = loadActivity;
}

// ---- scout ----------------------------------------------------------------
let scoutTimer = null;
async function pollScout(addr) {
  const d = await api('/api/scout?address=' + addr);
  $('#scoutProg').style.width = (d.progress || 0) + '%';
  if (d.status === 'jalan') return;
  clearInterval(scoutTimer); scoutTimer = null;
  $('#scoutProgWrap').classList.add('d-none');
  $('#btnScout').disabled = false;
  if (d.status === 'gagal') { $('#scoutResult').innerHTML = `<div class="alert alert-danger">Gagal: ${esc(d.error)}</div>`; return; }
  const r = d.result;
  const pairs = Object.entries(r.pairs).sort((a, b) => b[1].valueUsd - a[1].valueUsd);
  $('#scoutResult').innerHTML = `
  <div class="row row-deck row-cards">
    <div class="col-sm-6 col-lg-3"><div class="card"><div class="card-body">
      <div class="subheader">Nilai posisi hidup</div><div class="h2 mb-0 num">${usd(r.totalValueUsd)}</div>
      <div class="text-secondary">${r.positionsAlive} posisi</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="card"><div class="card-body">
      <div class="subheader">Fee belum diklaim</div><div class="h2 mb-0 num text-green">${usd(r.totalUnclaimedFeeUsd)}</div>
      <div class="text-secondary">${r.feeRatioPct.toFixed(2)}% dari nilai</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="card"><div class="card-body">
      <div class="subheader">Sedang in-range</div><div class="h2 mb-0 num">${r.inRangePct.toFixed(0)}%</div>
      <div class="text-secondary">median umur ${r.medianAgeHours.toFixed(1)} jam</div></div></div></div>
    <div class="col-sm-6 col-lg-3"><div class="card"><div class="card-body">
      <div class="subheader">Ukuran & rentang khas</div><div class="h2 mb-0 num">${usd(r.medianPositionUsd, 0)}</div>
      <div class="text-secondary">lebar median ${r.medianWidthPct.toFixed(0)}%</div></div></div></div>
  </div>
  <div class="row row-cards mt-1">
    <div class="col-lg-5"><div class="card">
      <div class="card-header"><h3 class="card-title">Pasangan yang dipakai</h3></div>
      <div class="table-responsive"><table class="table table-vcenter card-table">
        <thead><tr><th>Pasangan</th><th class="text-end">Posisi</th><th class="text-end">Nilai</th><th class="text-end">Fee</th></tr></thead>
        <tbody>${pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="text-end">${v.n}</td>
          <td class="text-end num">${usd(v.valueUsd, 0)}</td><td class="text-end num text-green">${usd(v.feeUsd)}</td></tr>`).join('')}</tbody>
      </table></div></div></div>
    <div class="col-lg-7"><div class="card">
      <div class="card-header"><h3 class="card-title">Posisi hidup</h3>
        <div class="card-actions text-secondary small">jendela ${(r.scannedBlocks / 1e6).toFixed(1)} juta blok · ${r.positionsClosed} posisi dilepas</div></div>
      <div class="table-responsive"><table class="table table-vcenter card-table">
        <thead><tr><th>Pasangan</th><th>Rentang</th><th class="text-end">Nilai</th><th class="text-end">Fee</th><th class="text-end">Umur</th></tr></thead>
        <tbody>${r.positions.filter((p) => Number(p.liquidity) > 0).sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 25).map((p) => `<tr>
          <td>${esc(p.symbol0)}/${esc(p.symbol1)} ${p.inRange ? '<span class="badge bg-green-lt">in</span>' : '<span class="badge bg-orange-lt">luar</span>'}</td>
          <td style="min-width:8rem">${rangeBar(p.tickLower, p.tickUpper, p.curTick)}<span class="text-secondary small">${p.widthPct.toFixed(0)}%</span></td>
          <td class="text-end num">${usd(p.valueUsd, 0)}</td>
          <td class="text-end num text-green">${usd(p.feeUsd)}</td>
          <td class="text-end text-secondary">${p.ageHours == null ? '—' : p.ageHours.toFixed(1) + 'j'}</td></tr>`).join('')}</tbody>
      </table></div></div></div>
  </div>
  <div class="mt-3"><button class="btn btn-primary" id="btnAddFromScout">Tambahkan wallet ini sebagai target</button></div>`;
  $('#btnAddFromScout').onclick = async () => {
    await post('/api/targets', { address: addr, label: 'dari scout' });
    location.hash = '#target';
  };
}
function setupScout() {
  $('#btnScout').onclick = async () => {
    const addr = $('#scoutAddr').value.trim().toLowerCase();
    const r = await post('/api/scout', { address: addr, blocks: Number($('#scoutBlocks').value) });
    if (r.error) return alert(r.error);
    $('#btnScout').disabled = true;
    $('#scoutProgWrap').classList.remove('d-none');
    $('#scoutResult').innerHTML = '';
    scoutTimer = setInterval(() => pollScout(addr), 1200);
  };
}

// ---- riset wallet ---------------------------------------------------------
let wTimer = null;
const kFmt = (v) => (Math.abs(v) >= 1000 ? '$' + (v / 1000).toFixed(2) + 'k' : usd(v));

async function loadWalletList() {
  const d = await api('/api/wallets');
  if (!d.wallets.length) { $('#wRecent').innerHTML = ''; return; }
  $('#wRecent').innerHTML = '<div class="text-secondary small mb-1">Sudah pernah dipindai:</div>'
    + d.wallets.map((w) => `<button class="btn btn-sm btn-outline-secondary me-1 mb-1" data-w="${w.address}">
        <span class="mono">${short(w.address)}</span><span class="text-secondary ms-1">· ${w.positions_n} posisi ·
        <span class="${cls(w.stats.totalProfitUsd)}">${usd(w.stats.totalProfitUsd || 0)}</span></span></button>`).join('');
  $$('[data-w]').forEach((b) => b.onclick = () => { $('#wAddr').value = b.dataset.w; $('#btnWLoad').click(); });
}

function profitCalendar(daily) {
  const days = Object.keys(daily).sort();
  if (!days.length) return '<div class="text-secondary">Belum ada posisi tertutup di jendela ini.</div>';
  // tampilkan bulan dari posisi tertutup terakhir
  const last = new Date(days[days.length - 1] + 'T00:00:00');
  const y = last.getFullYear(), mo = last.getMonth();
  const first = new Date(y, mo, 1), lastDay = new Date(y, mo + 1, 0).getDate();
  const namaBulan = first.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
  for (let d = 1; d <= lastDay; d++) {
    const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const v = daily[key];
    cells += `<div class="border rounded p-2 text-center" style="min-height:3.6rem">
      <div class="text-secondary small">${d}</div>
      ${v == null ? '' : `<div class="small fw-bold ${cls(v)}">${usd(v)}</div>`}</div>`;
  }
  const prefix = `${y}-${String(mo + 1).padStart(2, '0')}`;
  const total = Object.entries(daily).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
  return `<div class="d-flex justify-content-between align-items-center mb-2">
      <strong>${namaBulan}</strong><span class="text-secondary">Total bulan ini ${usd(total)}</span></div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:.35rem">
      ${['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'].map((n) => `<div class="text-secondary small text-center">${n}</div>`).join('')}
      ${cells}</div>`;
}

const posRow = (p, isOpen) => `<tr>
  <td>
    <div class="fw-bold">${esc(p.symbol0)} / ${esc(p.symbol1)}</div>
    <div><span class="badge bg-secondary-lt">v4</span> <span class="text-secondary small mono">#${esc(p.token_id)}</span>
    ${p.incomplete ? '<span class="badge bg-yellow-lt ms-1" title="Sebagian riwayat di luar jendela pindai — modal awal tidak lengkap">parsial</span>' : ''}</div>
  </td>
  <td class="text-secondary cell-narrow">${p.ageHours == null ? '—' : (p.ageHours < 24 ? p.ageHours.toFixed(2) + 'j' : (p.ageHours / 24).toFixed(1) + 'hr')}</td>
  <td class="text-end num">${usd(p.invested_q)}</td>
  ${isOpen ? `<td class="text-end num">${usd(p.live_value_q)}</td>` : ''}
  <td class="text-end num text-green">${usd(p.feeShown)}<div class="small text-secondary">${p.feePct == null ? '' : p.feePct.toFixed(2) + '%'}</div></td>
  <td class="text-end num ${cls(p.pnl_q)}">${usd(p.pnl_q)}<div class="small">${p.pnlPct == null ? '' : pct(p.pnlPct, 2)}</div></td>
  <td class="text-end num ${cls(p.dprPct)}">${p.dprPct == null ? '—' : (Math.abs(p.dprPct) >= 1000 ? (p.dprPct / 1000).toFixed(2) + 'k%' : p.dprPct.toFixed(2) + '%')}</td>
  <td style="min-width:8rem">${rangeBar(p.tick_lower, p.tick_upper, null)}
    <span class="text-secondary small">${p.tick_lower != null ? widthPct(p.tick_lower, p.tick_upper).toFixed(0) + '%' : ''}</span></td>
  <td class="text-secondary cell-narrow">${isOpen
    ? (p.in_range === 1 ? '<span class="badge bg-green-lt">in-range</span>' : p.in_range === 0 ? '<span class="badge bg-orange-lt">di luar</span>' : 'berjalan')
    : ago(p.closed_ts) + ' lalu'}</td>
</tr>`;

// ---- status pindai wallet ----
let wCurrent = null;        // alamat yang sedang ditampilkan
let wRendered = null;       // lastScanTs data yang sudah digambar (hindari gambar ulang tiap poll)

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span>${label || ''}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; delete btn.dataset.html; }
  }
}

const fase = (j) => {
  if (!j) return '';
  if (j.phase === 'transfer') return `Tahap 1 dari 2 — mencari posisi di chain (${j.progress || 0}%)`;
  if (j.phase === 'posisi') return `Tahap 2 dari 2 — menghitung posisi ${j.done || 0} / ${j.total || '?'}`;
  return 'Menyiapkan pemindaian…';
};
const lama = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' dtk' : Math.floor(s / 60) + ' mnt ' + (s % 60) + ' dtk'; };

// Kartu progres. Total progres gabungan: tahap 1 = 0-30%, tahap 2 = 30-100%.
function progressCard(j, { compact = false } = {}) {
  const pctAll = !j ? 2 : j.phase === 'transfer' ? Math.round((j.progress || 0) * 0.3)
    : j.phase === 'posisi' ? 30 + Math.round((j.progress || 0) * 0.7) : 2;
  const el = j && j.startedAt ? lama(Date.now() - j.startedAt) : '';
  const bar = `<div class="progress progress-sm mt-2"><div class="progress-bar" style="width:${Math.max(3, pctAll)}%"></div></div>`;
  if (compact) {
    return `<div class="alert alert-info d-flex align-items-center gap-3 mb-3" id="wProgBanner">
      <span class="spinner-border spinner-border-sm"></span>
      <div class="flex-fill"><div>Memperbarui dari chain — ${esc(fase(j))} <span class="text-secondary">· ${el}</span></div>${bar}</div></div>`;
  }
  return `<div class="card"><div class="card-body py-4">
    <div class="d-flex align-items-center gap-3">
      <span class="spinner-border text-primary"></span>
      <div class="flex-fill">
        <div class="fw-bold">Mengambil riwayat wallet dari chain</div>
        <div class="text-secondary">${esc(fase(j))}${el ? ' · ' + el : ''}</div>
        ${bar}
      </div>
    </div>
    <div class="text-secondary small mt-3">Wallet yang aktif bisa butuh beberapa menit (tiap posisi dibaca state-nya di blok kejadian).
      Halaman ini boleh ditinggal — hasilnya disimpan dan tinggal dibuka lagi nanti.</div>
  </div></div>`;
}

function loadingCard(text) {
  return `<div class="card"><div class="card-body py-5 text-center text-secondary">
    <span class="spinner-border mb-3"></span><div>${esc(text)}</div></div></div>`;
}

async function startScan(addr) {
  const r = await post('/api/wallet/scan', { address: addr, blocks: Number($('#wBlocks').value) });
  if (r.error) throw new Error(r.error);
}

function pollWallet(addr) {
  if (wTimer) clearInterval(wTimer);
  wTimer = setInterval(() => loadWallet(addr, { poll: true }).catch(() => {}), 2000);
}

async function loadWallet(addr, { poll = false, autoScan = false } = {}) {
  if (!poll) {
    wCurrent = addr; wRendered = null;
    $('#wBody').innerHTML = loadingCard('Memuat data wallet…');
  }
  if (addr !== wCurrent) return;           // pengguna sudah pindah ke wallet lain
  const d = await api('/api/wallet?address=' + addr);
  if (addr !== wCurrent) return;
  if (d.error) { $('#wBody').innerHTML = `<div class="alert alert-danger">${esc(d.error)}</div>`; return; }

  const running = d.job && d.job.status === 'jalan';

  // Belum pernah dipindai & tidak sedang dipindai: langsung mulai, jangan suruh
  // pengguna mencari tombol lain.
  if (!d.found && !running && autoScan) {
    try { await startScan(addr); } catch (e) { $('#wBody').innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`; return; }
    $('#wBody').innerHTML = progressCard({ phase: 'mulai', startedAt: Date.now() });
    $('#wHint').textContent = 'Wallet ini belum ada di database — memindai chain…';
    setBusy($('#btnWScan'), true);
    pollWallet(addr);
    return;
  }

  if (running) {
    setBusy($('#btnWScan'), true);
    if (!wTimer) pollWallet(addr);
    if (!d.found) { $('#wBody').innerHTML = progressCard(d.job); return; }
    // Sudah punya data lama: tetap tampilkan, cukup perbarui banner progres.
    const banner = $('#wProgBanner');
    if (wRendered && banner) { banner.outerHTML = progressCard(d.job, { compact: true }); return; }
  } else {
    if (wTimer) { clearInterval(wTimer); wTimer = null; loadWalletList(); }
    setBusy($('#btnWScan'), false);
    if (d.job && d.job.status === 'gagal') $('#wHint').innerHTML = `<span class="text-red">Pindai gagal: ${esc(d.job.error)}</span> — coba tekan <i class="ti ti-refresh"></i> lagi.`;
    else if (d.found) $('#wHint').textContent = `Dipindai ${ago(d.lastScanTs)} lalu · blok ${(d.scannedFrom || 0).toLocaleString('id-ID')}–${(d.scannedTo || 0).toLocaleString('id-ID')}`;
    // Data tidak berubah sejak terakhir digambar: jangan gambar ulang (menghindari kedip/scroll lompat).
    if (d.found && poll && wRendered === d.lastScanTs) return;
  }
  if (!d.found) {
    $('#wBody').innerHTML = `<div class="card"><div class="card-body text-secondary">Wallet ini belum ada di database.
      <button class="btn btn-sm btn-primary ms-2" id="btnScanNow">Pindai sekarang</button></div></div>`;
    $('#btnScanNow').onclick = () => loadWallet(addr, { autoScan: true });
    return;
  }
  wRendered = d.lastScanTs;
  const s = d.stats;
  $('#wBody').innerHTML = `${running ? progressCard(d.job, { compact: true }) : ''}
  <div class="row row-deck row-cards mb-3">
    <div class="col-lg-4"><div class="card"><div class="card-body">
      <div class="d-flex justify-content-between align-items-start mb-3">
        <div><div class="subheader">Total profit (tertutup)</div>
          <div class="h2 mb-0 num ${cls(s.totalProfitUsd)}">${kFmt(s.totalProfitUsd || 0)}</div></div>
        ${d.isTarget ? '<span class="badge bg-green-lt">Sudah jadi target</span>'
          : `<button class="btn btn-sm btn-outline-primary" id="btnMakeTarget"><i class="ti ti-plus me-1"></i>Jadikan target</button>`}
      </div>
      <div class="datagrid stat-grid">
        <div class="datagrid-item"><div class="datagrid-title">Posisi ditutup</div><div class="datagrid-content num">${s.closedCount || 0}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Win rate</div><div class="datagrid-content num ${(s.winRatePct || 0) >= 50 ? 'text-green' : 'text-red'}">${(s.winRatePct || 0).toFixed(2)}%</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Rata-rata modal</div><div class="datagrid-content num">${usd(s.avgInvestedUsd || 0)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Fee didapat</div><div class="datagrid-content num text-green">${kFmt(s.feeEarnedUsd || 0)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Laba per posisi</div><div class="datagrid-content num ${cls(s.expectedValueUsd)}">${usd(s.expectedValueUsd || 0)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Nilai posisi terbuka</div><div class="datagrid-content num">${usd(s.openValueUsd || 0)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Terbaik / terburuk</div><div class="datagrid-content num"><span class="text-green">${usd(s.bestUsd || 0)}</span> / <span class="text-red">${usd(s.worstUsd || 0)}</span></div></div>
        <div class="datagrid-item"><div class="datagrid-title">Belum terealisasi</div><div class="datagrid-content num ${cls(s.unrealizedUsd)}">${usd(s.unrealizedUsd || 0)}</div></div>
      </div>
      ${s.incompleteCount ? `<div class="alert alert-warning mt-3 mb-0 py-2 small">${s.incompleteCount} posisi riwayatnya terpotong jendela pindai — modal awalnya tidak lengkap, jadi tidak ikut dihitung di statistik. Perluas jendela untuk melengkapinya.</div>` : ''}
    </div></div></div>
    <div class="col-lg-8"><div class="card"><div class="card-header"><h3 class="card-title">Riwayat profit harian</h3></div>
      <div class="card-body">${profitCalendar(d.daily)}</div></div></div>
  </div>

  <div class="card mb-3">
    <div class="card-header"><h3 class="card-title">Posisi berjalan (${d.open.length})</h3>
      <div class="card-actions text-secondary small">nilai ${usd(s.openValueUsd || 0)} · fee belum diklaim ${usd(s.openFeeUsd || 0)}</div></div>
    <div class="table-responsive"><table class="table table-vcenter card-table">
      <thead><tr><th>Posisi/Pool</th><th>Umur</th><th class="text-end">Modal</th><th class="text-end">Nilai</th>
        <th class="text-end">Fee</th><th class="text-end">uPnL</th><th class="text-end">DPR</th><th>Rentang</th><th></th></tr></thead>
      <tbody>${d.open.map((p) => posRow(p, true)).join('') || '<tr><td colspan="9" class="text-secondary">tidak ada posisi berjalan</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="card-header"><h3 class="card-title">Riwayat posisi (${d.closed.length})</h3></div>
    <div class="table-responsive"><table class="table table-vcenter card-table">
      <thead><tr><th>Posisi/Pool</th><th>Umur</th><th class="text-end">Modal</th>
        <th class="text-end">Fee</th><th class="text-end">PnL</th><th class="text-end">DPR</th><th>Rentang</th><th>Ditutup</th></tr></thead>
      <tbody>${d.closed.map((p) => posRow(p, false)).join('') || '<tr><td colspan="8" class="text-secondary">belum ada posisi tertutup</td></tr>'}</tbody>
    </table></div>
  </div>`;

  const bt = $('#btnMakeTarget');
  if (bt) bt.onclick = async () => {
    await post('/api/targets', { address: addr, label: 'dari riset wallet' });
    loadWallet(addr);
  };
}

function setupWallet() {
  const addrOf = () => $('#wAddr').value.trim().toLowerCase();
  const valid = (a) => /^0x[0-9a-f]{40}$/.test(a);
  const check = () => {
    const a = addrOf();
    const ok = !a || valid(a);
    $('#wAddr').classList.toggle('is-invalid', !ok);
    return a && ok;
  };
  $('#wAddr').insertAdjacentHTML('afterend', '<div class="invalid-feedback">Alamat harus 0x diikuti 40 karakter hex.</div>');
  $('#wAddr').addEventListener('input', () => $('#wAddr').classList.remove('is-invalid'));

  $('#btnWLoad').onclick = async () => {
    if (!check()) { $('#wAddr').classList.add('is-invalid'); return; }
    const btn = $('#btnWLoad');
    setBusy(btn, true, 'Memuat…');
    try { await loadWallet(addrOf(), { autoScan: true }); }
    catch (e) { $('#wBody').innerHTML = `<div class="alert alert-danger">Gagal memuat: ${esc(e.message)}</div>`; }
    finally { setBusy(btn, false); }
  };
  $('#btnWScan').onclick = async () => {
    if (!check()) { $('#wAddr').classList.add('is-invalid'); return; }
    const a = addrOf();
    setBusy($('#btnWScan'), true);
    try {
      await startScan(a);
      wCurrent = a;
      if (!wRendered) $('#wBody').innerHTML = progressCard({ phase: 'mulai', startedAt: Date.now() });
      else if (!$('#wProgBanner')) $('#wBody').insertAdjacentHTML('afterbegin', progressCard({ phase: 'mulai', startedAt: Date.now() }, { compact: true }));
      pollWallet(a);
    } catch (e) {
      setBusy($('#btnWScan'), false);
      $('#wHint').innerHTML = `<span class="text-red">${esc(e.message)}</span>`;
    }
  };
  $('#wAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnWLoad').click(); });
}


// ---- pengaturan -----------------------------------------------------------
let setData = null;
let setTab = 'wallet';
let setPending = null;      // pesan yang harus tampil setelah panel digambar ulang

const fmtAmt = (v, d = 4) => (v == null ? '—' : Number(v).toLocaleString('id-ID', { maximumFractionDigits: d }));
const alertBox = (type, msg) => `<div class="alert alert-${type} mb-3">${msg}</div>`;
const fieldRow = (label, input, hint = '') => `<div class="mb-3"><label class="form-label">${label}</label>${input}${hint ? `<div class="form-hint">${hint}</div>` : ''}</div>`;

async function loadSettings(tab) {
  if (tab) setTab = tab;
  $$('#setMenu [data-set]').forEach((a) => a.classList.toggle('active', a.dataset.set === setTab));
  setData = await api('/api/settings');
  ({ wallet: renderSetWallet, rpc: renderSetRpc, gas: renderSetGas, notify: renderSetNotify, loop: renderSetLoop, security: renderSetSecurity }[setTab])();
  if (setPending && $('#setMsg')) { flash($('#setMsg'), setPending[0], setPending[1]); setPending = null; }
}

function flash(el, type, msg) {
  el.innerHTML = alertBox(type, esc(msg));
  if (type === 'success') setTimeout(() => { if (el.isConnected && el.innerHTML.includes(esc(msg))) el.innerHTML = ''; }, 6000);
}

// -- wallet & mode --
function renderSetWallet() {
  const w = setData.wallet, m = setData.mode;
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Wallet bot</h3>
    <p class="text-secondary mb-4">Pakai wallet khusus untuk bot, jangan wallet utama. Kunci privat disimpan di server
      (<span class="mono">${esc(w.keyFile)}</span>) dan tidak pernah ditampilkan lagi.</p>
    <div id="setMsg"></div>
    ${w.address ? `
      <div class="datagrid mb-4">
        <div class="datagrid-item"><div class="datagrid-title">Alamat</div><div class="datagrid-content mono">${esc(w.address)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Izin berkas kunci</div><div class="datagrid-content">
          ${w.perms === '600' ? '<span class="badge bg-green-lt">600 · aman</span>' : `<span class="badge bg-red-lt">${esc(w.perms || '?')} · terlalu longgar</span>`}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">ETH</div><div class="datagrid-content num">${fmtAmt(w.balances?.eth, 6)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">USDG</div><div class="datagrid-content num">${fmtAmt(w.balances?.usdg, 2)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">WETH</div><div class="datagrid-content num">${fmtAmt(w.balances?.weth, 6)}</div></div>
        <div class="datagrid-item"><div class="datagrid-title">Cadangan kunci lama</div><div class="datagrid-content num">${w.backups}</div></div>
      </div>` : alertBox('secondary', 'Belum ada wallet terpasang. Bot hanya bisa berjalan dalam mode simulasi.')}

    <div class="hr-text">Mode</div>
    <div class="d-flex align-items-center justify-content-between mb-4">
      <div>
        <div class="fw-medium">${m.dry_run ? 'Simulasi' : 'Live'}</div>
        <div class="text-secondary small">${m.dry_run ? 'Bot memutuskan dan mencatat, tapi tidak mengirim transaksi.' : 'Bot mengirim transaksi sungguhan dari wallet di atas.'}</div>
      </div>
      ${m.dry_run
        ? `<div class="d-flex gap-2"><input class="form-control" id="liveConfirm" placeholder="ketik LIVE" style="width:9rem" ${w.address ? '' : 'disabled'}>
           <button class="btn btn-danger" id="btnLiveOn" ${w.address ? '' : 'disabled'}>Nyalakan LIVE</button></div>`
        : `<button class="btn btn-outline-secondary" id="btnLiveOff">Kembali ke simulasi</button>`}
    </div>

    <div class="hr-text">Ganti wallet</div>
    ${!m.dry_run ? alertBox('warning', 'Matikan mode LIVE dulu untuk mengganti wallet.') : `
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="fw-medium mb-1">Impor kunci privat</div>
        <input type="password" class="form-control mono mb-2" id="impKey" placeholder="0x… (64 karakter hex)" autocomplete="off">
        <button class="btn btn-outline-primary" id="btnImport">Impor</button>
      </div>
      <div class="col-lg-6">
        <div class="fw-medium mb-1">Buat wallet baru</div>
        <div class="text-secondary small mb-2">Kunci dibuat di server. Frasa pemulihan disimpan di sebelah berkas kunci.</div>
        <button class="btn btn-outline-primary" id="btnGenerate">Buat wallet</button>
      </div>
    </div>
    <label class="form-check mt-3"><input class="form-check-input" type="checkbox" id="replaceKey">
      <span class="form-check-label">Ganti kunci yang sudah ada <span class="text-secondary">(kunci lama dipindah ke berkas cadangan, tidak dihapus)</span></span></label>
    ${w.address ? `<div class="mt-4 pt-3 border-top">
      <div class="fw-medium mb-1">Lepas wallet</div>
      <div class="d-flex gap-2"><input class="form-control mono" id="rmConfirm" placeholder="ketik alamat wallet untuk konfirmasi">
      <button class="btn btn-outline-danger" id="btnRemove">Lepas</button></div></div>` : ''}`}`;

  const msg = $('#setMsg');
  const act = async (url, body, okText) => {
    const r = await post(url, body);
    if (r.error) return flash(msg, 'danger', r.error);
    setPending = ['success', okText(r)];
    loadOverview(); loadSettings();
  };
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('btnLiveOn', () => act('/api/settings/live', { live: true, confirm: $('#liveConfirm').value.trim() }, () => 'Mode LIVE menyala.'));
  on('btnLiveOff', () => act('/api/settings/live', { live: false }, () => 'Kembali ke mode simulasi.'));
  on('btnImport', () => act('/api/settings/wallet/import', { privateKey: $('#impKey').value, replace: $('#replaceKey').checked },
    (r) => { $('#impKey').value = ''; return `Wallet ${r.address} terpasang.${r.backup ? ' Kunci lama dicadangkan: ' + r.backup : ''}`; }));
  on('btnGenerate', () => act('/api/settings/wallet/generate', { replace: $('#replaceKey').checked },
    (r) => `Wallet baru ${r.address} dibuat. Frasa pemulihan: ${r.mnemonicFile} di server.`));
  on('btnRemove', () => act('/api/settings/wallet/remove', { confirm: $('#rmConfirm').value.trim() },
    (r) => `Wallet dilepas. Kunci dicadangkan: ${r.backup}`));
}

// -- RPC --
const capBadges = (e) => [
  e.no_logs ? '<span class="badge bg-secondary-lt">tanpa getLogs</span>'
    : e.max_log_blocks ? `<span class="badge bg-yellow-lt">getLogs ≤ ${Number(e.max_log_blocks).toLocaleString('id-ID')} blok</span>`
    : '<span class="badge bg-green-lt">getLogs penuh</span>',
  e.archive ? '<span class="badge bg-blue-lt">arsip</span>' : '',
  e.secret ? '<span class="badge bg-secondary-lt"><i class="ti ti-key me-1"></i>API key</span>' : '',
].join(' ');

function renderSetRpc() {
  const list = setData.rpc;
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Endpoint RPC</h3>
    <p class="text-secondary mb-4">Permintaan dibagi otomatis: <b>getLogs</b> hanya ke endpoint yang sanggup, pembacaan
      state lampau hanya ke endpoint <b>arsip</b>, sisanya ke yang paling senggang. Perubahan berlaku tanpa restart.</p>
    <div id="setMsg"></div>
    <div class="table-responsive mb-4"><table class="table table-vcenter">
      <thead><tr><th>Endpoint</th><th>Kemampuan</th><th class="text-end">Latensi</th><th class="text-end">Panggilan/err</th><th class="w-1"></th></tr></thead>
      <tbody>${list.map((e) => `<tr data-row="${e.id}">
        <td style="word-break:break-all"><div class="mono">${esc(e.url)}</div>${e.headers ? `<div class="small text-secondary mono">${Object.entries(e.headers).map(([k, v]) => esc(k + ': ' + v)).join(', ')}</div>` : ''}
          <div class="small text-secondary d-none" data-test="${e.id}"></div></td>
        <td>${capBadges(e)}</td>
        <td class="text-end num text-nowrap">${e.lastMs ? e.lastMs + ' ms' : '—'}${e.cooling ? '<div><span class="badge bg-yellow-lt">istirahat</span></div>' : ''}</td>
        <td class="text-end num text-secondary text-nowrap">${e.calls.toLocaleString('id-ID')} / ${e.errors}</td>
        <td class="text-nowrap">
          <button class="btn btn-sm btn-icon btn-ghost-secondary" data-edit-rpc="${e.id}" title="Ubah bendera" aria-label="Ubah"><i class="ti ti-pencil"></i></button>
          <button class="btn btn-sm btn-icon btn-ghost-secondary" data-test-rpc="${e.id}" title="Uji endpoint" aria-label="Uji"><i class="ti ti-activity-heartbeat"></i></button>
          <button class="btn btn-sm btn-icon btn-ghost-danger" data-del-rpc="${e.id}" title="Hapus" aria-label="Hapus"><i class="ti ti-trash"></i></button></td>
      </tr>
      <tr class="d-none" data-editor="${e.id}"><td colspan="5" class="bg-body-tertiary">
        <div class="row g-3 align-items-end">
          <div class="col-md-3"><label class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" data-f="no_logs" ${e.no_logs ? 'checked' : ''}><span class="form-check-label">Tanpa getLogs</span></label></div>
          <div class="col-md-3"><label class="form-label">Batas rentang getLogs</label><input class="form-control num" type="number" data-f="max_log_blocks" value="${e.max_log_blocks || 0}"><div class="form-hint">0 = tanpa batas</div></div>
          <div class="col-md-2"><label class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" data-f="archive" ${e.archive ? 'checked' : ''}><span class="form-check-label">Arsip</span></label></div>
          <div class="col-md-2"><label class="form-label">Batch</label><input class="form-control num" type="number" data-f="max_batch" value="${e.max_batch}"></div>
          <div class="col-md-2"><button class="btn btn-primary w-100" data-save-rpc="${e.id}">Simpan</button></div>
        </div></td></tr>`).join('')}</tbody></table></div>

    <div class="hr-text">Tambah endpoint</div>
    <div class="row g-3">
      <div class="col-lg-7">${fieldRow('URL', '<input class="form-control mono" id="newRpcUrl" placeholder="https://…">', 'Kalau API key-nya bagian dari URL (mis. Alchemy, Ankr), tempel URL lengkapnya di sini — tetap disamarkan di tampilan.')}</div>
      <div class="col-lg-5">${fieldRow('Autentikasi', `<select class="form-select" id="newRpcAuth">
          <option value="none">Tanpa header / key di URL</option>
          <option value="x-api-key">Header x-api-key</option>
          <option value="bearer">Header Authorization: Bearer</option>
          <option value="custom">Header lain…</option></select>`)}</div>
      <div class="col-lg-5 d-none" id="newRpcHName">${fieldRow('Nama header', '<input class="form-control mono" id="newRpcHeader" placeholder="mis. x-token">')}</div>
      <div class="col-lg-7 d-none" id="newRpcKeyWrap">${fieldRow('API key', '<input type="password" class="form-control mono" id="newRpcKey" autocomplete="off">')}</div>
    </div>
    <div id="newRpcResult" class="mb-3"></div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-secondary" id="btnRpcTest">Uji dulu</button>
      <button class="btn btn-primary" id="btnRpcAdd" disabled>Tambah</button>
    </div>`;

  const msg = $('#setMsg');
  const current = () => setData.rpc.map((e) => ({
    id: e.id, no_logs: e.no_logs, max_log_blocks: e.max_log_blocks, archive: e.archive, max_batch: e.max_batch,
  }));
  const saveList = async (endpoints, okText) => {
    const r = await post('/api/settings/rpc', { endpoints });
    if (r.error) return flash(msg, 'danger', r.error);
    setData.rpc = r.rpc; renderSetRpc(); flash($('#setMsg'), 'success', okText);
  };

  $$('[data-edit-rpc]').forEach((b) => b.onclick = () => $(`[data-editor="${b.dataset.editRpc}"]`).classList.toggle('d-none'));
  $$('[data-save-rpc]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.saveRpc);
    const ed = $(`[data-editor="${id}"]`);
    const list = current().map((e) => (e.id !== id ? e : {
      id, no_logs: ed.querySelector('[data-f="no_logs"]').checked,
      max_log_blocks: Number(ed.querySelector('[data-f="max_log_blocks"]').value) || 0,
      archive: ed.querySelector('[data-f="archive"]').checked,
      max_batch: Number(ed.querySelector('[data-f="max_batch"]').value) || 40,
    }));
    saveList(list, 'Endpoint diperbarui.');
  });
  $$('[data-del-rpc]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.delRpc);
    if (!confirm('Hapus endpoint ini?')) return;
    saveList(current().filter((e) => e.id !== id), 'Endpoint dihapus.');
  });
  $$('[data-test-rpc]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.testRpc, box = $(`[data-test="${id}"]`);
    setBusy(b, true);
    box.classList.remove('d-none'); box.textContent = 'menguji…';
    const r = await post('/api/settings/rpc/test', { id: Number(id) });
    setBusy(b, false);
    box.innerHTML = r.error ? `<span class="text-red">${esc(r.error)}</span>` : `${r.usable ? '<span class="text-green">✓</span>' : '<span class="text-red">✗</span>'} ${esc(r.summary)}`;
  });

  // tambah
  let tested = null;
  const authSel = $('#newRpcAuth');
  const syncAuth = () => {
    const v = authSel.value;
    $('#newRpcKeyWrap').classList.toggle('d-none', v === 'none');
    $('#newRpcHName').classList.toggle('d-none', v !== 'custom');
    tested = null; $('#btnRpcAdd').disabled = true;
  };
  authSel.onchange = syncAuth;
  ['newRpcUrl', 'newRpcKey', 'newRpcHeader'].forEach((i) => $('#' + i).addEventListener('input', () => { tested = null; $('#btnRpcAdd').disabled = true; }));
  const draft = () => {
    const url = $('#newRpcUrl').value.trim();
    const v = authSel.value, key = $('#newRpcKey').value.trim();
    let headers = null;
    if (v === 'x-api-key' && key) headers = { 'x-api-key': key };
    if (v === 'bearer' && key) headers = { authorization: 'Bearer ' + key };
    if (v === 'custom' && key && $('#newRpcHeader').value.trim()) headers = { [$('#newRpcHeader').value.trim()]: key };
    return { url, headers };
  };
  $('#btnRpcTest').onclick = async () => {
    const d = draft();
    if (!d.url) return;
    const b = $('#btnRpcTest'); setBusy(b, true, 'Menguji…');
    const r = await post('/api/settings/rpc/test', d);
    setBusy(b, false);
    if (r.error || !r.usable) {
      $('#newRpcResult').innerHTML = alertBox('danger', esc(r.error || r.summary));
      tested = null; $('#btnRpcAdd').disabled = true; return;
    }
    tested = { ...d, ...r.suggest };
    $('#newRpcResult').innerHTML = alertBox('success', `<div class="fw-medium">${esc(r.summary)}</div>
      <div class="small mt-1">Bendera yang akan dipasang: ${capBadges({ ...r.suggest, secret: !!d.headers })}</div>`);
    $('#btnRpcAdd').disabled = false;
  };
  $('#btnRpcAdd').onclick = () => {
    if (!tested) return;
    saveList([...current(), {
      url: tested.url, headers: tested.headers || undefined,
      no_logs: tested.no_logs, max_log_blocks: tested.max_log_blocks, archive: tested.archive, max_batch: 40,
    }], 'Endpoint ditambahkan dan langsung dipakai.');
  };
}

// -- gas --
function renderSetGas() {
  const g = setData.gas;
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Gas</h3>
    <p class="text-secondary mb-4">Berlaku untuk transaksi berikutnya, tanpa restart.</p>
    <div id="setMsg"></div>
    <div class="row">
      <div class="col-md-6">${fieldRow('Pengali harga gas', `<input class="form-control num" type="number" step="0.1" id="gMult" value="${g.price_multiplier}">`, 'Harga gas jaringan × angka ini. 1,5 = 50% di atas harga saat itu.')}</div>
      <div class="col-md-6">${fieldRow('Priority fee (gwei)', `<input class="form-control num" type="number" step="0.001" id="gPrio" value="${g.priority_gwei}">`)}</div>
      <div class="col-md-6">${fieldRow('Batas gas per transaksi', `<input class="form-control num" type="number" step="100000" id="gLimit" value="${g.max_gas_limit}">`)}</div>
      <div class="col-md-6">${fieldRow('Cadangan ETH untuk gas', `<input class="form-control num" type="number" step="0.001" id="gRes" value="${g.reserve_eth}">`, 'ETH sebanyak ini tidak pernah dipakai untuk LP maupun swap.')}</div>
    </div>
    <button class="btn btn-primary" id="btnGasSave">Simpan</button>`;
  $('#btnGasSave').onclick = async () => {
    const r = await post('/api/settings/gas', {
      price_multiplier: $('#gMult').value, priority_gwei: $('#gPrio').value,
      max_gas_limit: $('#gLimit').value, reserve_eth: $('#gRes').value,
    });
    r.error ? flash($('#setMsg'), 'danger', r.error) : flash($('#setMsg'), 'success', 'Pengaturan gas tersimpan.');
  };
}

// -- notifikasi --
function renderSetNotify() {
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Notifikasi</h3>
    <p class="text-secondary mb-4">Kabar tiap posisi disalin atau ditutup, lewat <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy.sh</a>.
      Pasang aplikasi ntfy di HP lalu langganan topik yang sama.</p>
    <div id="setMsg"></div>
    ${fieldRow('Topik ntfy', `<input class="form-control mono" id="nTopic" value="${esc(setData.notify.ntfy_topic)}" placeholder="mis. lpcopy-rahasia-8x2k">`,
      'Siapa pun yang tahu nama topiknya bisa membaca notifikasinya — pakai nama yang sulit ditebak. Kosongkan untuk mematikan.')}
    <div class="d-flex gap-2"><button class="btn btn-primary" id="btnNSave">Simpan</button>
      <button class="btn btn-outline-secondary" id="btnNTest">Kirim uji</button></div>`;
  $('#btnNSave').onclick = async () => {
    const r = await post('/api/settings/notify', { ntfy_topic: $('#nTopic').value });
    r.error ? flash($('#setMsg'), 'danger', r.error) : flash($('#setMsg'), 'success', 'Topik tersimpan.');
  };
  $('#btnNTest').onclick = async () => {
    const r = await post('/api/settings/notify/test', {});
    r.error ? flash($('#setMsg'), 'danger', r.error) : flash($('#setMsg'), 'success', 'Notifikasi uji terkirim.');
  };
}

// -- mesin --
function renderSetLoop() {
  const l = setData.loop, pr = setData.prices;
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Mesin</h3>
    <p class="text-secondary mb-4">Perubahan di sini berlaku setelah bot di-restart.</p>
    <div id="setMsg"></div>
    <div class="row">
      <div class="col-md-4">${fieldRow('Interval pindai (ms)', `<input class="form-control num" type="number" step="100" id="lPoll" value="${l.poll_ms}">`, 'Seberapa sering blok baru diperiksa.')}</div>
      <div class="col-md-4">${fieldRow('Blok per pindai', `<input class="form-control num" type="number" step="100" id="lSpan" value="${l.max_block_span}">`, 'Maks 3.000 — batas getLogs endpoint arsip.')}</div>
      <div class="col-md-4">${fieldRow('Sinkron posisi (detik)', `<input class="form-control num" type="number" step="5" id="lSync" value="${l.sync_seconds}">`)}</div>
      <div class="col-md-6">${fieldRow('Harga ETH cadangan (USD)', `<input class="form-control num" type="number" id="lEth" value="${pr.eth_usd}">`, 'Dipakai hanya kalau harga dari pool ETH/USDG gagal dibaca.')}</div>
      <div class="col-md-6 d-flex align-items-center"><label class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" id="lAuto" ${pr.auto_eth_price ? 'checked' : ''}>
        <span class="form-check-label">Ambil harga ETH dari chain</span></label></div>
    </div>
    <button class="btn btn-primary" id="btnLoopSave">Simpan</button>`;
  $('#btnLoopSave').onclick = async () => {
    const r = await post('/api/settings/loop', {
      poll_ms: $('#lPoll').value, max_block_span: $('#lSpan').value, sync_seconds: $('#lSync').value,
      eth_usd: $('#lEth').value, auto_eth_price: $('#lAuto').checked,
    });
    r.error ? flash($('#setMsg'), 'danger', r.error) : flash($('#setMsg'), 'success', 'Tersimpan. Restart bot supaya berlaku: pm2 restart lpcopy');
  };
}

// -- keamanan --
function renderSetSecurity() {
  $('#setPanel').innerHTML = `
    <h3 class="card-title mb-1">Keamanan</h3>
    <p class="text-secondary mb-4">Dasbor ini bisa menyalakan LIVE dan menutup posisi, jadi dilindungi token akses.</p>
    <div id="setMsg"></div>
    <div class="fw-medium mb-1">Ganti token akses</div>
    <div class="text-secondary small mb-2">Token lama langsung tidak berlaku; semua perangkat lain harus masuk ulang. Browser ini tetap masuk.</div>
    <button class="btn btn-outline-danger" id="btnRotate">Buat token baru</button>
    <div id="newTok" class="mt-3"></div>`;
  $('#btnRotate').onclick = async () => {
    if (!confirm('Ganti token akses? Perangkat lain harus masuk ulang.')) return;
    const r = await post('/api/settings/token/rotate', {});
    if (r.error) return flash($('#setMsg'), 'danger', r.error);
    $('#newTok').innerHTML = `<label class="form-label">Token baru — simpan sekarang, tidak akan ditampilkan lagi</label>
      <div class="input-group"><input class="form-control mono" readonly value="${esc(r.token)}" id="tokVal">
      <button class="btn btn-outline-secondary" id="btnCopyTok">Salin</button></div>`;
    $('#btnCopyTok').onclick = () => { navigator.clipboard?.writeText(r.token); $('#btnCopyTok').textContent = 'Tersalin'; };
  };
}

function setupSettings() {
  $$('#setMenu [data-set]').forEach((a) => a.onclick = (e) => { e.preventDefault(); loadSettings(a.dataset.set); });
}

// ---- loop -----------------------------------------------------------------
async function refresh(page) {
  try {
    await loadOverview();
    if (page === 'posisi') await loadPositions();
    if (page === 'target') await loadTargets();
    if (page === 'aktivitas') await loadActivity();
    if (page === 'aturan' && !$('#rulesForm').dataset.built) { await loadRules(); $('#rulesForm').dataset.built = '1'; }
    if (page === 'wallet' && !$('#wRecent').dataset.built) { await loadWalletList(); $('#wRecent').dataset.built = '1'; }
    if (page === 'pengaturan' && !$('#setPanel').dataset.built) { await loadSettings(); $('#setPanel').dataset.built = '1'; }
  } catch (e) { console.error(e); }
  const fc = $('#footClock'); if (fc) fc.textContent = 'Diperbarui ' + new Date().toLocaleTimeString('id-ID');
}
setupScout();
setupWallet();
setupSettings();
theme.init();
route();
setInterval(() => refresh((location.hash || '#ringkasan').slice(1)), 5000);
