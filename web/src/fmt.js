import { chainInfo, ETHERSCAN } from './chain';
import { getLocale, translate as t } from './i18n';
import { isHidden, MASK } from './privacy';

// All number & time formats follow the language in use:
// Indonesian uses a decimal comma (0,00201), English uses a dot (0.00201).
const loc = () => (getLocale() === 'en' ? 'en-US' : 'id-ID');
export const locale = loc;   // used by other pages to format dates

const rawUsd = (v, d = 2) => (v == null || Number.isNaN(v)) ? '—'
  : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d });
// Value redaction (privacy.js): the minus sign is also covered — even a "loss" is already a leak.
// Without redaction: only for sample figures that are not our money (the preview in Settings).
export const plainUsd = rawUsd;
export const usd = (v, d = 2) => (v == null || Number.isNaN(v) || !isHidden() ? rawUsd(v, d) : '$' + MASK);
// Large figures that only need a glance (volume, liquidity, MCap). Above
// a million, the 'k' unit stops helping — "$3200.00k" has to be computed before it
// reads as three million.
export const kUsd = (v) => {
  const a = Math.abs(v);
  if (!(a >= 1000)) return rawUsd(v);   // public figures: not subject to redaction (privacy.js)
  const [d, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
  return (v < 0 ? '−$' : '$') + (a / d).toFixed(2) + unit;
};
export const pct = (v, d = 1) => (v == null ? '—'
  : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
export const num = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(loc(), { maximumFractionDigits: d }));
// Position ids: EVM NFT ids are short numbers and stay as they are; Solana position
// addresses (32–44 base58 characters) are shortened like wallet addresses.
export const shortId = (id) => (id == null ? '' : String(id).length > 12 ? short(String(id)) : String(id));
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
// The block explorer of the chain being shown (Blockscout / BscScan use the same /tx
// and /address paths) — the transaction links in the position history and activity.
export const txHref = (hash) => (hash ? `${chainInfo().explorer}/tx/${hash}` : null);
// Solscan calls the address page /account/, EVM explorers /address/.
export const addrHref = (a) => (a ? `${chainInfo().explorer}/${chainInfo().kind === 'solana' ? 'account' : 'address'}/${a}` : null);
// A wallet's LP portfolio on LPAgent — an external reference for our research figures.
// LPAgent is originally a Solana (Meteora) LP analytics tool: no chain parameter = Solana.
export const lpagentHref = (a) => (!a ? null : chainInfo().kind === 'solana' ? `https://app.lpagent.io/portfolio?address=${a}`
  : `https://app.lpagent.io/portfolio?address=${a}&chain=${chainInfo().key === 'bsc' ? 'BSC' : 'ROBINHOOD'}`);
// This chain's block explorer name for link labels (Solscan / BscScan / Blockscout).
export const explorerName = () => { const e = chainInfo().explorer || ''; return /solscan/.test(e) ? 'Solscan' : /bscscan/.test(e) ? 'BscScan' : 'Blockscout'; };
// A wallet's holdings across chains on DeBank: tokens, DeFi positions, and their value on all chains
// at once — what cannot be seen from this dashboard (one chain at a time).
// DeBank is EVM-only: on Solana the link is not shown.
export const debankHref = (a) => (a && chainInfo().kind !== 'solana' ? `https://debank.com/profile/${a}` : null);
// This chain's Etherscan (robin.etherscan.io on Robinhood) — its tx/token/NFT index
// differs from Blockscout, so a wallet that is empty there often reads here.
export const etherscanHref = (a) => (a && ETHERSCAN[chainInfo().key] ? `${ETHERSCAN[chainInfo().key]}/address/${a}` : null);
export const tone = (v) => (v > 0.005 ? 'text-success' : v < -0.005 ? 'text-danger' : '');
export const widthPct = (lo, hi) => (1.0001 ** (hi - lo) - 1) * 100;

// --- fee yield -------------------------------------------------------
// A question the "Fee" column cannot answer alone: a $2,000 position that has
// earned $12 in 5 days, and a $300 position that has earned $1.40 in 6 hours —
// which is better? Annualising the fee against capital equalises
// the two, and that is the figure LPs use to compare positions, pools,
// and range widths.
//
// A young age makes the figure explode ($0.10 in 2 minutes = tens of thousands of percent),
// so under two hours there is no APR at all — better silent than giving a
// figure that would be read as a promise. Above 999% the figure is also clipped (aprText):
// what is told is not "4,812%", but "this position is still too young".
export function apr(feeUsd, costUsd, ageHours) {
  if (!(costUsd > 0) || !(ageHours >= 2) || !(feeUsd > 0.005)) return null;
  return (feeUsd / costUsd) * (8760 / ageHours) * 100;
}
// Position fee = unclaimed + already withdrawn to the wallet. Using only
// the unclaimed would make a diligently harvesting position look unproductive.
export const feeApr = (p) => (!p || p.syncing ? null : apr((p.feeUsd || 0) + (p.claimedUsd || 0), p.costUsd, p.ageHours));
// Combined APR of several positions: weighted by capital AND age (one large position
// just opened must not pull the average down as if it had long sat idle).
export function aprOf(rows) {
  let fee = 0, base = 0;
  for (const p of rows || []) {
    if (p.syncing || !(p.costUsd > 0) || !(p.ageHours >= 2)) continue;
    fee += (p.feeUsd || 0) + (p.claimedUsd || 0);
    base += p.costUsd * (p.ageHours / 8760);
  }
  return base > 0 ? (fee / base) * 100 : null;
}
// Without a "+" sign: APR is not a change, so no direction is needed. Clipped like
// the distance to the range edge — "+4,812%" only means "this position is still very young".
export const aprText = (v) => (v == null ? '—' : v >= 1000 ? '999+%' : `${num(v, Math.abs(v) < 10 ? 1 : 0)}%`);

// A token price can be 0.00000032 up to 4,200 — so use significant digits, not
// a fixed number of decimals (0.00 tells nothing).
export function price(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  // Above one billion the full figure (337,815,857,900,711…) only breaks the width of
  // the table column; scientific notation is more honest for a junk token price like that.
  if (p >= 1e9) return p.toExponential(2).replace('.', loc() === 'id-ID' ? ',' : '.');
  if (p >= 1e6) return p.toLocaleString(loc(), { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(loc(), { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(loc(), { maximumSignificantDigits: 3 });
  return p.toExponential(2).replace('.', loc() === 'id-ID' ? ',' : '.');
}

// Token amount: from the smallest unit on chain to the display unit, then formatted
// with significant digits — a token can have 6 decimals (USDG) or 18 (most of the rest).
export const qty = (raw, dec) => (raw == null ? null : Number(BigInt(String(raw))) / 10 ** (dec ?? 18));
export const fmtQty = (v) => (v == null || !Number.isFinite(v) ? '—'
  : isHidden() ? MASK
  : v >= 1e6 ? v.toLocaleString(loc(), { maximumFractionDigits: 0 })
    : v.toLocaleString(loc(), { maximumSignificantDigits: v >= 1000 ? 6 : 4 }));

// Price from sqrtPriceX96 (the pool state stored per event).
export function sqrtPrice(sqrtX96, dec0, dec1, quoteSide) {
  if (!sqrtX96) return null;
  const r = Number(sqrtX96) / 2 ** 96;
  const p1per0 = r * r * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}

// Price of the speculative token in the pool's quote asset, from the tick number.
// quoteSide 0 = token0 is the quote -> token1's price is the inverse of the tick.
export function tickPrice(tick, dec0, dec1, quoteSide) {
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
}
export function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t('{n} dtk lalu', { n: Math.max(1, Math.round(s)) });
  if (s < 3600) return t('{n} mnt lalu', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} jam lalu', { n: (s / 3600).toFixed(1) });
  return t('{n} hari lalu', { n: (s / 86400).toFixed(1) });
}
export const age = (h) => (h == null ? '—'
  : h < 1 ? t('{n} mnt', { n: Math.round(h * 60) })
    : h < 24 ? t('{n} jam', { n: h.toFixed(1) })
      : t('{n} hari', { n: (h / 24).toFixed(1) }));
export const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? t('{n} dtk', { n: s }) : t('{n} mnt {s} dtk', { n: Math.floor(s / 60), s: s % 60 });
};

// Labels used repeatedly in several tables. The second value = chip colour.
export const ACTIONS = {
  increase: ['Tambah likuiditas', 'accent'], decrease: ['Kurangi likuiditas', 'warning'], claim_fees: ['Klaim fee', 'success'], compound: ['Auto-compound', 'success'],
  custody_out: ['Titip ke otomasi', 'default'], custody_in: ['Kembali dari otomasi', 'default'],
  transfer_in: ['Terima posisi', 'default'], transfer_out: ['Kirim posisi', 'warning'],
  mint: ['Buka posisi', 'accent'], collect: ['Klaim fee', 'success'], claim: ['Target panen fee', 'default'],
  reentry: ['Buka lagi (harga mendekat)', 'accent'], rebalance: ['Geser rentang', 'default'],
  resize: ['Ubah panjang rentang', 'default'],
};
export const DECISIONS = {
  copy: ['Disalin', 'success'], dry: ['Simulasi', 'accent'], skip: ['Dilewati', 'default'], error: ['Gagal', 'danger'],
};
export const TXKIND = {
  mint: 'Buka posisi', increase: 'Tambah likuiditas', decrease: 'Kurangi', burn: 'Tutup posisi', claim_fees: 'Klaim fee', compound: 'Auto-compound',
  approve_erc20: 'Izin token', approve_permit2: 'Izin Permit2', zap_swap: 'Tukar (zap)',
  bridge_swap: 'Tukar kas', wrap_eth: 'Bungkus ETH', unwrap_weth: 'Buka WETH',
  approve_kyber: 'Izin Kyber', sell_leftover: 'Jual token sisa', swap_manual: 'Swap manual',
};
export const TXSTATUS = { sukses: ['Sukses', 'success'], pending: ['Menunggu', 'warning'], gagal: ['Gagal', 'danger'] };
