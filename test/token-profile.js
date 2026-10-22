'use strict';
const assert = require('node:assert/strict');
const { profileVerdict } = require('../src/tokenrisk');
const { DEFAULTS, validateRules } = require('../src/policy');

const off = { require_socials: false, block_honeypot: false, max_tax_pct: 0, require_verified_contract: false, min_holders: 0 };
const sec = (o = {}) => ({ honeypot: false, openSource: true, buyTaxPct: 0, sellTaxPct: 0, ...o });
const gm = (o = {}, links = { website: 'https://x.io' }) => ({ enabled: true, holderCount: 500, links, security: sec(o) });
const ds = (info) => ({ pairs: [{ websites: [], socials: [], ...info }] });

// defaults are off and validated
const f0 = DEFAULTS.filters;
assert.equal(f0.require_socials, false);
assert.equal(f0.min_holders, 0);
assert.equal(validateRules({ filters: { max_tax_pct: 120 } }).error?.includes('antara'), true);
assert.equal(validateRules({ filters: { block_honeypot: true, min_holders: 20 } }).rules.filters.min_holders, 20);

// everything off, or nothing read: never blocks
assert.equal(profileVerdict({ ds: ds({}), gmgn: gm({ honeypot: true }) }, off), null);
assert.equal(profileVerdict({}, { ...off, block_honeypot: true, require_socials: true, min_holders: 5 }), null);
assert.equal(profileVerdict({ gmgn: { enabled: false } }, { ...off, block_honeypot: true }), null);
assert.equal(profileVerdict({ gmgn: { enabled: true, error: 'x' } }, { ...off, block_honeypot: true }), null);

// honeypot, tax, unverified source, holders: only a proven bad value rejects
assert.match(profileVerdict({ gmgn: gm({ honeypot: true }) }, { ...off, block_honeypot: true }), /honeypot/);
assert.equal(profileVerdict({ gmgn: gm({ honeypot: null }) }, { ...off, block_honeypot: true }), null);
assert.match(profileVerdict({ gmgn: gm({ sellTaxPct: 30 }) }, { ...off, max_tax_pct: 10 }), /pajak token 30\.0%/);
assert.equal(profileVerdict({ gmgn: gm({ sellTaxPct: 5 }) }, { ...off, max_tax_pct: 10 }), null);
assert.match(profileVerdict({ gmgn: gm({ openSource: false }) }, { ...off, require_verified_contract: true }), /belum terverifikasi/);
assert.equal(profileVerdict({ gmgn: gm({ openSource: null }) }, { ...off, require_verified_contract: true }), null);
assert.match(profileVerdict({ gmgn: { ...gm(), holderCount: 8 } }, { ...off, min_holders: 50 }), /8 holder/);
assert.equal(profileVerdict({ gmgn: { ...gm(), holderCount: null } }, { ...off, min_holders: 50 }), null);

// socials: DexScreener links or GMGN links satisfy it; both readable and empty rejects
const need = { ...off, require_socials: true };
assert.match(profileVerdict({ ds: ds({}), gmgn: gm({}, {}) }, need), /tidak punya website/);
assert.match(profileVerdict({ ds: ds({}) }, need), /tidak punya website/);
assert.equal(profileVerdict({ ds: ds({ websites: ['https://a.io'] }) }, need), null);
assert.equal(profileVerdict({ ds: ds({ socials: [{ type: 'twitter', url: 'https://x.com/a' }] }), gmgn: gm({}, {}) }, need), null);
assert.equal(profileVerdict({ ds: ds({}), gmgn: gm({}, { twitter: 'https://x.com/a' }) }, need), null);
// DexScreener has not indexed the token and GMGN is off: unknown, let through
assert.equal(profileVerdict({ ds: { error: 'x' }, gmgn: { enabled: false } }, need), null);
console.log('token-profile ok');
