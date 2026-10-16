'use strict';
// Platform billing for the open-LP service: a flat fee per action, priced in USD, charged in
// the chain's native coin. This module is the accounting layer — pure fee math plus the ledger
// writes. Moving the money (a native transfer to the treasury) is done by the engine, which
// calls chargeFee after an action lands; see Engine#chargeFee.
//
// Why flat USD per action (not a % of the swap): it is predictable for the user, matches how
// competitors price it, and does not touch the aggregator's output. Collect/add/compound are
// free on purpose — those only harvest the user's own money.
//
// Config lives at the config ROOT (superadmin-owned, read-only to accounts — see tenants.js):
//   fees: { enabled: true, schedule: { open: 0.15, close: 0.15, tp_sl: 0.20, rebalance: 0.25 } }
//   treasury: { <chain>: { address: '0x…', referral: '0x…' } }
// A missing schedule entry falls back to DEFAULT_FEES_USD; 0 (or fees.enabled === false, or no
// treasury address for the chain) means the action is free.

const { ethers } = require('ethers');

// USD, undercutting the reference competitor (which charges 0.20/0.20/0.25/0.30) to compete.
// Admin-configurable via cfg.fees.schedule; these are only the defaults.
const DEFAULT_FEES_USD = { open: 0.15, close: 0.15, tp_sl: 0.20, rebalance: 0.25 };
// Actions that are always free regardless of config — documented so the UI and the engine agree.
const FREE_ACTIONS = new Set(['collect', 'add', 'compound']);
// Fraction of the open+close fee credited to the referrer (the rest is the platform's).
const DEFAULT_REFERRAL_SHARE = 0.25;

// The fee for an action in USD. 0 when billing is off, the action is free, or the schedule
// entry is 0. Unknown actions are free (never guess a charge).
function feeUsd(cfg, action) {
  if (!cfg || cfg.fees?.enabled === false) return 0;
  if (FREE_ACTIONS.has(action)) return 0;
  const sched = cfg.fees?.schedule || {};
  const v = sched[action] ?? DEFAULT_FEES_USD[action];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// USD fee -> native wei at the given native/USD price. Null when the price is missing or the
// fee is 0, so the caller charges nothing rather than guessing an amount.
function feeNativeWei(usd, nativeUsd) {
  const price = Number(nativeUsd);
  if (!(usd > 0) || !(price > 0)) return null;
  // 18-decimal native assumed (ETH/BNB/…); round to wei.
  return BigInt(Math.round((usd / price) * 1e18));
}

// The treasury (and optional referral vault) address for a chain, or null when none is set —
// in which case the action is free, since there is nowhere to send the fee.
function treasuryFor(cfg, chain) {
  const t = cfg?.treasury?.[chain];
  const address = t && typeof t.address === 'string' && ethers.isAddress(t.address) ? ethers.getAddress(t.address) : null;
  if (!address) return null;
  const referral = t.referral && ethers.isAddress(t.referral) ? ethers.getAddress(t.referral) : null;
  return { address, referral };
}

function referralShare(cfg) {
  const v = Number(cfg?.fees?.referral_share);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_REFERRAL_SHARE;
}

// Record one fee in the ledger. `native`/`ref_native` are bigint wei (stored as decimal text).
function recordFee(store, chain, { action, positionId = null, usd = 0, native = null, treasury = null, tx = null, status = 'paid', referrer = null, refNative = null }) {
  store.run(
    'INSERT INTO platform_fee(chain, ts, action, position_id, usd, native, treasury, tx, status, referrer, ref_native) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    chain, Date.now(), action, positionId, usd, native == null ? null : native.toString(), treasury,
    tx, status, referrer, refNative == null ? null : refNative.toString());
}

// Totals for the admin fee page: paid USD, count, and the outstanding debt in USD.
function feeSummary(store, chain = null) {
  const where = chain ? ' WHERE chain=?' : '';
  const args = chain ? [chain] : [];
  const paid = store.get(`SELECT COALESCE(SUM(usd),0) AS usd, COUNT(*) AS n FROM platform_fee${where}${where ? ' AND' : ' WHERE'} status='paid'`, ...args);
  const debt = store.get(`SELECT COALESCE(SUM(usd),0) AS usd, COUNT(*) AS n FROM platform_fee${where}${where ? ' AND' : ' WHERE'} status='debt'`, ...args);
  return { paidUsd: paid.usd, paidCount: paid.n, debtUsd: debt.usd, debtCount: debt.n };
}

module.exports = {
  DEFAULT_FEES_USD, FREE_ACTIONS, DEFAULT_REFERRAL_SHARE,
  feeUsd, feeNativeWei, treasuryFor, referralShare, recordFee, feeSummary,
};
