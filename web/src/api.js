// API client. The server is on the same origin; authentication goes through an HttpOnly cookie.
// 401 = token expired/rotated -> reload so the server shows the sign-in page.
async function req(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { location.reload(); throw new Error('tidak berwenang'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.error) body.error = `HTTP ${r.status}`;
  return body;
}
export const get = (p) => req(p);
export const post = (p, data) => req(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}),
});
