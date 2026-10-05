// Portfolio value redaction: a single switch that covers all our dollar figures
// (balance, capital, PnL, fees, token amounts) — for screen sharing, recording, or
// opening the dashboard in public without showing off the wallet size.
//
// What gets covered lives in the formatters (fmt.js `usd`/`fmtQty`, currency.js `fxText`),
// not in each component: a new figure added later is automatically
// redacted, and no page can forget. Percentages are deliberately left — "+12%"
// does not reveal the capital size, and without it the dashboard loses its substance.
//
// Market data (volume, liquidity, MCap) and target wallet figures go through `kUsd`, and
// are not covered: those are other people's public numbers, not ours.
//
// ONE switch for everything: the eye icon, Settings → Display, and the Telegram mini app
// eye icon all write to the same place — the `display.hide_values` config
// on the server — and every tab/device reads it through the /api/overview poll.
// Pressing the eye on a phone also covers the dashboard open on a laptop.
// The last value is stored in localStorage so the page never briefly
// shows numbers before the first poll arrives.
import { useEffect, useState } from 'react';
import { post } from './api';

const KEY = 'lpcopy-privacy-default';
export const MASK = '•••••';

let hidden = false;
try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* abaikan */ }
let pending = 0;   // stored value that the server has not answered yet
let lastToggle = 0;
// A poll that left before the eye was pressed can arrive after it carrying the old value;
// this pause is longer than one poll round (5 seconds) so it does not flip it back.
const SETTLE_MS = 6000;
const listeners = new Set();

function set(v) {
  v = !!v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* abaikan */ }
  if (v === hidden) return;
  hidden = v;
  listeners.forEach((f) => f(hidden));
}

export const isHidden = () => hidden;
// From the /api/overview poll.
export function setDefaultHidden(v) {
  if (!pending && Date.now() - lastToggle > SETTLE_MS) set(v);
}

// Eye icon: switches immediately in this tab, then is saved to the server for everyone.
// Failed to save -> back to the original state, so what is seen does not lie.
export async function toggleHidden() {
  const next = !hidden;
  set(next);
  pending++;
  lastToggle = Date.now();
  let r;
  try { r = await post('/api/settings/display', { hide_values: next }); }
  catch (e) { r = { error: e.message }; }
  pending--;
  if (r?.error) set(!next);
  return r;
}

// Components are redrawn when redaction is switched on/off.
export function usePrivacy() {
  const [v, setV] = useState(hidden);
  useEffect(() => {
    const f = (x) => setV(x);
    listeners.add(f);
    f(hidden);
    return () => listeners.delete(f);
  }, []);
  return [v, toggleHidden];
}
