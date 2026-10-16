// The signed-in account (GET /api/auth/me), fetched once per page load and shared.
// { user: {id, username, role, status, legacy} | null, multiUser: boolean }
import { useEffect, useState } from 'react';
import { get } from './api';

let cached = null;
let pending = null;
const load = () => (pending ||= get('/api/auth/me').then((d) => (cached = d?.error ? { user: null, multiUser: false } : d)));

export function useMe() {
  const [me, setMe] = useState(cached);
  useEffect(() => { if (!cached) load().then(setMe).catch(() => {}); }, []);
  return me;
}

// A regular account in multi-user mode: shared infrastructure (RPC, Telegram bot, backups…)
// belongs to the superadmin, so those parts of the dashboard are hidden.
export const isRegular = (me) => !!me?.user && me.user.role !== 'superadmin';
export const isSuperadmin = (me) => me?.user?.role === 'superadmin';
// The platform operator on a multi-user server: its dashboard is the admin console, not the LP
// pages. A single-user deployment signed in with the server token keeps the full LP dashboard.
export const isOperator = (me) => isSuperadmin(me) && !!me.multiUser && !me.legacy;
