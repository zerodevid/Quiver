// API client. The server is on the same origin; authentication goes through an HttpOnly cookie.
// 401 = token expired/rotated -> reload so the server shows the sign-in page.
import { getScope, isAllChains, getChainFilter } from './chain';

// All-chains view: these routes are merged across chains by the server (src/allchains.js), so on
// the aggregate pages they are sent without a chain. The app status and alert feed always are.
const MERGED = /^\/api\/(positions|positions\/sync|portfolio|activity|txs|monitor\/market|gmgn\/tokens)(\?|$)/;
const NEVER_SCOPED = /^\/api\/(overview|chains|chain\/select|feed)(\?|$)/;
let mergedPage = false;
// App sets this per page: true on the pages that show every chain together.
export const setMergedPage = (on) => { mergedPage = !!on; };

// Add ?chain=<key> unless the path already names one.
export const withChain = (path, key) => {
  if (!key || /[?&]chain=/.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}chain=${encodeURIComponent(key)}`;
};
const withParam = (path, k, v) => `${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;
const scoped = (path) => {
  if (!isAllChains() || /[?&]chain=/.test(path)) return path;
  // the chain filter of the combined view (which chains are summed)
  const merged = /^\/api\/overview(\?|$)/.test(path) || (mergedPage && MERGED.test(path));
  if (merged) return getChainFilter().length ? withParam(path, 'chains', getChainFilter().join(',')) : path;
  if (NEVER_SCOPED.test(path)) return path;
  return withChain(path, getScope());
};

async function req(path, opts = {}) {
  const r = await fetch(scoped(path), { credentials: 'same-origin', ...opts });
  if (r.status === 401) { location.reload(); throw new Error('tidak berwenang'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.error) body.error = `HTTP ${r.status}`;
  return body;
}
export const get = (p) => req(p);
export const post = (p, data) => req(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}),
});
