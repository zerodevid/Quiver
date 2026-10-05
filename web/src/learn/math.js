import { breakEven } from '../breakeven.js';

// Educational model of a single concentrated liquidity position. Prices in human units:
// quote per 1 base. Entry and capital are fixed so the examples in the text can be matched.
export const ENTRY = 100;
export const CAPITAL = 100;

export function simulation({ lo, hi, current, fees = 0, costs = 0, capital = CAPITAL }) {
  const valid = [lo, hi, current, fees, costs, capital].every(Number.isFinite)
    && lo > 0 && hi > lo && current > 0 && capital > 0 && fees >= 0 && costs >= 0;
  if (!valid) throw new Error('Invalid simulation inputs');

  const a = Math.sqrt(lo), b = Math.sqrt(hi);
  // Token amounts for liquidity L at a given price; outside the range the price is clamped
  // to the edge so the position holds just one token.
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

  // BEP uses the same formula as the dashboard: 0 decimals, token1 as quote, tick
  // derived from the price. Costs are added to the capital that has to come back.
  const tick = (p) => Math.log(p) / Math.log(1.0001);
  const bep = breakEven({
    status: 'open', inRange: false, quoteSide: 1, dec0: 0, dec1: 0,
    tick_lower: tick(lo), tick_upper: tick(hi), liquidity,
    cost_quote: capital + costs, fee0: 0, fee1: fees,
  });

  return { ...evaluate(current), initial, liquidity, bep, evaluate };
}
