// Heuristic thresholds, not a prediction. Missing data never means healthy.
const finite = (v) => v != null && Number.isFinite(Number(v));
export function poolHealth({ pool = {}, pair, holders, open = [], now = Date.now() }) {
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
  const out = open.filter((p) => p.inRange === false).length;
  if (out) add('warn', '{value} posisi bot di luar rentang dan tidak menghasilkan fee swap.', { value: out });
  const cost = open.reduce((s, p) => s + (p.costUsd || 0), 0), pnl = open.reduce((s, p) => s + (p.pnlUsd || 0), 0);
  if (cost > 0 && pnl / cost <= -0.2) add('warn', 'PnL posisi terbuka {value}% dari modal.', { value: (pnl / cost * 100).toFixed(1) });
  const status = signals.some((s) => s.level === 'risk') ? 'risk' : signals.length ? 'warn' : missing.length ? 'unknown' : 'healthy';
  return { status, signals, missing, holdersOk: !!holdersOk, eligible, largest, top10 };
}
