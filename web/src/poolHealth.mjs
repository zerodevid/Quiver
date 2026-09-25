// Heuristic thresholds, not a prediction. Missing data never means healthy.
const finite = (v) => v != null && Number.isFinite(Number(v));
// gmgn: profil token dari OpenAPI GMGN (/api/gmgn/token) — undefined kalau API
// key belum diisi (tidak dinilai), { error } kalau sedang gagal (dicatat sebagai
// data kurang), atau objek dengan `security`/`stat`/`dev` (lihat src/gmgn.js).
export function poolHealth({ pool = {}, pair, holders, open = [], gmgn, now = Date.now() }) {
  const signals = [], missing = [];
  const add = (level, key, values = {}) => signals.push({ level, key, values });
  const marketOk = pair && !pair.error && pair.base?.address?.toLowerCase() === pool.baseToken?.toLowerCase() && pair.fetchedAt && now - pair.fetchedAt <= 120000;
  if (!marketOk) missing.push('Data pasar belum tersedia atau sudah kedaluwarsa.');
  else {
    const change = pair.priceChange || {};
    if (!finite(change.h24) || !finite(pair.liquidityUsd)) missing.push('Data harga 24 jam atau likuiditas belum lengkap.');
    for (const [window, severe, warn] of [['h24', -50, -20], ['h1', -20, -10]]) {
      if (finite(change[window]) && change[window] <= warn) {
        const usdMove = finite(pair.priceUsd) ? Math.abs(pair.priceUsd * change[window] / 100) : null;
        const value = Math.abs(change[window]).toFixed(1);
        add(change[window] <= severe ? 'risk' : 'warn',
          usdMove != null
            ? (window === 'h24' ? 'Harga turun {value}% (≈{usd}) dalam 24 jam.' : 'Harga turun {value}% (≈{usd}) dalam 1 jam.')
            : (window === 'h24' ? 'Harga turun {value}% dalam 24 jam.' : 'Harga turun {value}% dalam 1 jam.'),
          usdMove != null ? { value, usd: usdMove } : { value });
      }
    }
    if (finite(pair.liquidityUsd) && pair.liquidityUsd < 50000) add(pair.liquidityUsd < 10000 ? 'risk' : 'warn', 'Likuiditas hanya ${value}; transaksi besar dapat menggeser harga.', { value: Math.round(pair.liquidityUsd) });
    if (pair.liquidityUsd > 0 && pair.fdv / pair.liquidityUsd > 100) add('warn', 'FDV {value}× likuiditas pool; valuasi jauh lebih besar dari likuiditas.', { value: Math.round(pair.fdv / pair.liquidityUsd) });
    const buys = finite(pair.txns?.h24?.buys) ? Number(pair.txns.h24.buys) : null, sells = finite(pair.txns?.h24?.sells) ? Number(pair.txns.h24.sells) : null;
    if (finite(buys) && finite(sells) && buys + sells >= 20 && sells / (buys + sells) >= 0.7) add('warn', '{value}% transaksi 24 jam adalah jual (jumlah transaksi, bukan nilai jual).', { value: Math.round(sells / (buys + sells) * 100) });
    if (pair.pairCreatedAt > 0 && now >= pair.pairCreatedAt && now - pair.pairCreatedAt < 86400000) add('warn', 'Pool berumur kurang dari 24 jam; riwayat masih pendek.');
  }
  if (!finite(pool.fee)) missing.push('Fee pool belum tersedia.');
  if (pool.fee >= 0x800000) add('warn', 'Fee dinamis; biaya swap dapat berubah.');
  else if (finite(pool.fee) && pool.fee >= 30000) add('warn', 'Fee swap {value}% per transaksi.', { value: (pool.fee / 10000).toFixed(2) });
  if (pool.hooks && !/^0x0{40}$/i.test(pool.hooks)) add('warn', 'Pool memakai hook; perilaku kontrak tambahan belum diverifikasi.');
  const holdersOk = holders && !holders.error && Array.isArray(holders.items) && holders.items.every((h) => finite(h.percent) && typeof h.address === 'string') && holders.token === pool.baseToken?.toLowerCase() && holders.fetchedAt && now - (holders.snapshotAt || holders.fetchedAt) <= 1200000;
  let eligible = [], top10 = null, largest = null;
  if (!holdersOk) missing.push('Data holder belum tersedia atau sudah kedaluwarsa; dominasi belum dapat dinilai.');
  else {
    eligible = holders.items.filter((h) => !['pool_manager', 'burn'].includes(h.kind) && h.address !== pool.pool_ref?.toLowerCase());
    largest = eligible[0]?.percent ?? null;
    if (eligible.length >= 10 || !holders.hasMore) top10 = eligible.slice(0, 10).reduce((s, h) => s + h.percent, 0);
    if (largest >= 10) add(largest >= 20 ? 'risk' : 'warn', 'Satu alamat non-infrastruktur memegang {value}% suplai.', { value: largest.toFixed(1) });
    if (top10 >= 40) add(top10 >= 60 ? 'risk' : 'warn', '10 alamat non-infrastruktur terbesar memegang {value}% suplai.', { value: top10.toFixed(1) });
    if (holders.holderCount == null || top10 == null) missing.push('Jumlah holder atau cakupan 10 alamat terbesar belum lengkap.');
    if (holders.holderCount != null && holders.holderCount < 100) add('warn', 'Baru {value} alamat memiliki token ini.', { value: holders.holderCount });
  }
  // Sinyal GMGN: keamanan kontrak dan perilaku dev/trader yang tidak terlihat dari
  // harga maupun daftar holder. Aturannya dipisah ke gmgnSignals() karena dipakai
  // juga oleh titik indikator di daftar posisi — dua tempat yang menilai token yang
  // sama tidak boleh memakai ambang yang berbeda.
  const gm = gmgn && !gmgn.error && gmgn.enabled !== false && (gmgn.address == null || gmgn.address === pool.baseToken?.toLowerCase()) ? gmgn : null;
  if (gmgn && !gm) missing.push('Data GMGN belum tersedia; keamanan kontrak belum dinilai.');
  // Konsentrasi top-10 versi GMGN hanya dipakai kalau daftar holder kita sendiri
  // tidak ada, supaya tidak dihitung dua kali.
  if (gm) for (const s of gmgnSignals(gm, { skipTop10: holdersOk }).signals) signals.push(s);
  const out = open.filter((p) => p.inRange === false).length;
  if (out) add('warn', '{value} posisi bot di luar rentang dan tidak menghasilkan fee swap.', { value: out });
  const cost = open.reduce((s, p) => s + (p.costUsd || 0), 0), pnl = open.reduce((s, p) => s + (p.pnlUsd || 0), 0);
  if (cost > 0 && pnl / cost <= -0.2) add('warn', 'PnL posisi terbuka {value}% dari modal.', { value: (pnl / cost * 100).toFixed(1) });
  const status = signals.some((s) => s.level === 'risk') ? 'risk' : signals.length ? 'warn' : missing.length ? 'unknown' : 'healthy';
  return { status, signals, missing, holdersOk: !!holdersOk, eligible, largest, top10, gmgnOk: !!gm };
}

// Aturan GMGN saja, dipakai panel Kesehatan pool dan titik indikator di daftar
// posisi. `graded` menjawab pertanyaan yang berbeda dari daftar sinyal: apakah ada
// cukup data untuk berkata "tidak ada tanda bahaya" sama sekali. Banyak token di
// chain ini hanya terisi sebagian di GMGN (rug/insider null) — diam bukan berarti
// aman, dan itu yang membedakan titik hijau dari titik abu-abu.
export function gmgnSignals(gm, { skipTop10 = false } = {}) {
  const signals = [];
  const add = (level, key, values = {}) => signals.push({ level, key, values });
  const sec = gm?.security || {};
  if (sec.honeypot === true) add('risk', 'GMGN menandai token ini honeypot: bisa dibeli, tidak bisa dijual.');
  for (const [k, label] of [['sellTaxPct', 'Pajak jual {value}% di kontrak (GMGN).'], ['buyTaxPct', 'Pajak beli {value}% di kontrak (GMGN).']]) {
    if (finite(sec[k]) && sec[k] >= 3) add(sec[k] >= 10 ? 'risk' : 'warn', label, { value: Number(sec[k]).toFixed(1) });
  }
  if (finite(sec.rugPct) && sec.rugPct >= 20) add(sec.rugPct >= 50 ? 'risk' : 'warn', 'Skor risiko rug {value}% menurut GMGN.', { value: Math.round(sec.rugPct) });
  if (sec.washTrading === true) add('warn', 'GMGN mendeteksi wash trading pada token ini.');
  if (sec.creatorSold === true || gm?.dev?.status === 'sell') add('warn', 'Dev/pembuat token sudah menjual pegangannya (GMGN).');
  if (finite(sec.insiderPct) && sec.insiderPct >= 20) add(sec.insiderPct >= 40 ? 'risk' : 'warn', 'Wallet yang dicurigai orang dalam memegang {value}% suplai (GMGN).', { value: Number(sec.insiderPct).toFixed(1) });
  const bundler = finite(sec.bundlerVolPct) ? sec.bundlerVolPct : gm?.stat?.bundlerVolPct;
  if (finite(bundler) && bundler >= 30) add('warn', '{value}% volume berasal dari bundler bot (GMGN).', { value: Math.round(bundler) });
  const rat = finite(sec.ratVolPct) ? sec.ratVolPct : gm?.stat?.ratVolPct;
  if (finite(rat) && rat >= 30) add('warn', '{value}% volume berasal dari rat trader / orang dalam (GMGN).', { value: Math.round(rat) });
  if (sec.openSource === false) add('warn', 'Kode kontrak belum diverifikasi (GMGN).');
  if (sec.ownerRenounced === false) add('warn', 'Kepemilikan kontrak belum dilepas; owner masih bisa mengubah kontrak (GMGN).');
  const t10 = finite(sec.top10Pct) ? sec.top10Pct : gm?.stat?.top10Pct;
  if (!skipTop10 && finite(t10) && t10 >= 40) add(t10 >= 60 ? 'risk' : 'warn', '10 wallet terbesar memegang {value}% suplai (GMGN).', { value: Number(t10).toFixed(1) });
  // Cukup dinilai kalau GMGN benar-benar menjawab soal kontraknya: honeypot dan
  // pajak adalah dua kolom yang terisi untuk hampir semua token yang dia kenal.
  const graded = sec.honeypot != null && (finite(sec.buyTaxPct) || finite(sec.sellTaxPct) || sec.openSource != null);
  const level = signals.some((s) => s.level === 'risk') ? 'risk' : signals.length ? 'warn' : graded ? 'ok' : 'unknown';
  return { signals, graded, level };
}
