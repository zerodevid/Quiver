'use strict';
// Telegram deep-link login broker: a code only signs a browser in after the Telegram user who
// opened it confirms; forwarded codes, denials, expiry and request floods are handled.
//
// Run: node test/tg-login.js
const assert = require('node:assert');
const { createLoginBroker, describeUserAgent, TTL_MS, MAX_PER_IP } = require('../src/tg-login');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

function world() {
  let clock = 1_000_000;
  const onboarded = [];
  const broker = createLoginBroker({
    botUsername: () => 'quiver_bot',
    onboard: (from, chatId) => { onboarded.push([from.id, chatId]); return { ok: true, user: { id: 40 + from.id, role: 'user' }, created: false, address: null, name: 'u' + from.id }; },
    now: () => clock,
  });
  return { broker, onboarded, tick: (ms) => { clock += ms; } };
}
const alice = { id: 1 }, mallory = { id: 2 };

console.log('telegram login broker');

t('describes the browser from its User-Agent', () => {
  assert.equal(describeUserAgent(IPHONE), 'Safari · iOS');
  assert.equal(describeUserAgent(MAC_CHROME), 'Chrome · macOS');
  assert.equal(describeUserAgent(WIN_EDGE), 'Edge · Windows');
  assert.equal(describeUserAgent(''), 'Browser');
});

t('a request returns a deep link, a 6-digit match code and a poll secret', () => {
  const { broker } = world();
  const r = broker.request({ ua: IPHONE, ip: '203.0.113.7' });
  assert.match(r.url, /^https:\/\/t\.me\/quiver_bot\?start=login_[0-9a-f]{16}$/);
  assert.match(r.match, /^\d{3} \d{3}$/);
  assert.equal(r.poll.length, 64);
  assert.notEqual(r.poll, r.code);
});

t('no session until the user who opened the code confirms it', () => {
  const { broker, onboarded } = world();
  const r = broker.request({ ua: IPHONE, ip: '203.0.113.7' });
  assert.deepEqual(broker.claim(r.poll), { pending: true });
  assert.deepEqual(broker.describe(r.code, alice), { device: 'Safari · iOS', ip: '203.0.113.7', match: r.match });
  assert.deepEqual(broker.claim(r.poll), { pending: true }, 'opening the link alone signs nothing in');
  assert.equal(onboarded.length, 0);
  assert.equal(broker.authorize(r.code, alice, '1').ok, true);
  assert.deepEqual(broker.claim(r.poll), { userId: 41, name: 'u1', created: false });
  assert.deepEqual(broker.claim(r.poll), { error: 'expired' }, 'the session is handed out once');
});

t('a forwarded code belongs to whoever opened it first', () => {
  const { broker } = world();
  const r = broker.request({ ip: 'x' });
  broker.describe(r.code, mallory);
  assert.match(broker.describe(r.code, alice).error, /akun Telegram lain/);
  assert.match(broker.authorize(r.code, alice, '1').error, /akun Telegram lain/);
  assert.ok(broker.deny(r.code, alice).error, 'nor can they deny it');
});

t('a code cannot be confirmed without being opened (no describe step)', () => {
  const { broker } = world();
  const r = broker.request({ ip: 'x' });
  assert.ok(broker.authorize(r.code, alice, '1').error);
});

t('"Not me" makes the browser get an error, and the code is spent', () => {
  const { broker } = world();
  const r = broker.request({ ip: 'x' });
  broker.describe(r.code, alice);
  assert.deepEqual(broker.deny(r.code, alice), { ok: true });
  assert.ok(broker.authorize(r.code, alice, '1').error);
  assert.match(broker.claim(r.poll).error, /ditolak/);
});

t(`codes expire after ${TTL_MS / 1000}s`, () => {
  const { broker, tick } = world();
  const r = broker.request({ ip: 'x' });
  tick(TTL_MS + 1);
  assert.ok(broker.describe(r.code, alice).error);
  assert.deepEqual(broker.claim(r.poll), { error: 'expired' });
});

t('a wrong or empty poll secret gets nothing', () => {
  const { broker } = world();
  const r = broker.request({ ip: 'x' });
  broker.describe(r.code, alice); broker.authorize(r.code, alice, '1');
  assert.deepEqual(broker.claim(''), { error: 'expired' });
  assert.deepEqual(broker.claim('ff'.repeat(32)), { error: 'expired' });
  assert.deepEqual(broker.claim('é'), { error: 'expired' }, 'any length or encoding is safe to compare');
});

t(`one IP keeps at most ${MAX_PER_IP} live codes; the oldest are dropped`, () => {
  const { broker } = world();
  const first = broker.request({ ip: '198.51.100.1' });
  for (let i = 0; i < 50; i++) broker.request({ ip: '198.51.100.1' });
  broker.request({ ip: '198.51.100.2' });
  assert.equal(broker.size(), MAX_PER_IP + 1);
  assert.ok(broker.describe(first.code, alice).error, 'the oldest code of that IP is gone');
});

t('no bot connected: a clear error instead of a dead link', () => {
  const broker = createLoginBroker({ botUsername: () => null, onboard: () => ({}) });
  assert.match(broker.request().error, /bot belum tersambung/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
