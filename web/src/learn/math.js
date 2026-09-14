import { breakEven } from '../breakeven.js';

// Model edukasi satu posisi concentrated liquidity. Harga dalam satuan manusia:
// quote per 1 base. Entry dan modal tetap supaya contoh di teks bisa dicocokkan.
export const ENTRY = 100;
export const CAPITAL = 100;

export function simulation({ lo, hi, current, fees = 0, costs = 0, capital = CAPITAL }) {
  const valid = [lo, hi, current, fees, costs, capital].every(Number.isFinite)
    && lo > 0 && hi > lo && current > 0 && capital > 0 && fees >= 0 && costs >= 0;
  if (!valid) throw new Error('Invalid simulation inputs');

  const a = Math.sqrt(lo), b = Math.sqrt(hi);
  // Jumlah token untuk likuiditas L pada harga tertentu; di luar range harga dijepit
  // ke tepi sehingga posisi berisi satu token saja.
  const amounts = (price, L) => {
    const s = Math.sqrt(Math.max(lo, Math.min(hi, price)));
    return { base: L * (1 / s - 1 / b), quote: L * (s - a) };
  };
  const unit = amounts(ENTRY, 1);
  const liquidity = capital / (unit.base * ENTRY + unit.quote);
  const initial = amounts(ENTRY, liquidity);

  const evaluate = (price) => {
    const inventory = amounts(price, liquidity);
    const principal = inventory.base * price + inventory.quote;
    const hold = initial.base * price + initial.quote;
    const lp = principal + fees - costs;
    return { price, ...inventory, principal, hold, lp, pnl: lp - capital, il: principal - hold };
  };

  // BEP memakai rumus yang sama dengan dasbor: desimal 0, token1 sebagai quote, tick
  // diturunkan dari harga. Biaya dimasukkan ke modal yang harus kembali.
  const tick = (p) => Math.log(p) / Math.log(1.0001);
  const bep = breakEven({
    status: 'open', inRange: false, quoteSide: 1, dec0: 0, dec1: 0,
    tick_lower: tick(lo), tick_upper: tick(hi), liquidity,
    cost_quote: capital + costs, fee0: 0, fee1: fees,
  });

  return { ...evaluate(current), initial, liquidity, bep, evaluate };
}
