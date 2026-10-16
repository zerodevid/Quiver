'use strict';
// Multi-user accounts: first-user bootstrap, invite-only registration, login, sessions,
// suspension, password changes and resets, and the retyped-password lockout.
//
// Run: node test/auth.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Auth, AuthError, hashPassword, verifyPassword } = require('../src/auth');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAILED ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const rejectsCode = (p, code) => assert.rejects(p, (e) => e instanceof AuthError && e.code === code);
const fresh = () => new Auth(new Store(':memory:'));
const withRoot = async () => { const a = fresh(); const root = await a.register({ username: 'root', password: 'password1' }); return { a, root }; };

(async () => {
  await t('password hash verifies and rejects', async () => {
    const h = await hashPassword('correct horse');
    assert.ok(await verifyPassword('correct horse', h));
    assert.ok(!(await verifyPassword('wrong', h)));
    assert.ok(!(await verifyPassword('x', 'garbage')));
  });

  await t('hashing does not block the event loop', async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 1);
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => hashPassword('pw' + i)));
    clearInterval(iv);
    assert.ok(ticks > 0, 'timers ran while hashing');
  });

  await t('first account is superadmin without invite, later ones need one', async () => {
    const a = fresh();
    const root = await a.register({ username: 'Root', password: 'password1' });
    assert.equal(root.role, 'superadmin');
    assert.equal(root.username, 'root');
    await rejectsCode(a.register({ username: 'bob', password: 'password1' }), 'invite');
    await rejectsCode(a.register({ username: 'bob', password: 'password1', invite: 'nope' }), 'invite');
  });

  await t('without a valid invite, sign-up does not reveal taken usernames', async () => {
    const { a } = await withRoot();
    await rejectsCode(a.register({ username: 'root', password: 'password1', invite: 'nope' }), 'invite');
    await rejectsCode(a.register({ username: 'root', password: 'password1', invite: a.createInvite(1) }), 'taken');
  });

  await t('invite is single-use (also under concurrent sign-ups) and stored hashed', async () => {
    const { a, root } = await withRoot();
    const code = a.createInvite(root.id);
    assert.ok(!a.store.all('SELECT code_hash FROM invites').some((r) => r.code_hash === code));
    const results = await Promise.allSettled([
      a.register({ username: 'bob', password: 'password1', invite: code }),
      a.register({ username: 'eve', password: 'password1', invite: code }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'invite');
    assert.equal(a.userCount(), 2);
  });

  await t('two concurrent first sign-ups make exactly one superadmin', async () => {
    const a = fresh();
    const results = await Promise.allSettled([
      a.register({ username: 'one', password: 'password1' }),
      a.register({ username: 'two', password: 'password1' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(a.store.get("SELECT COUNT(*) n FROM users WHERE role='superadmin'").n, 1);
  });

  await t('expired and revoked invites are refused', async () => {
    const { a, root } = await withRoot();
    const old = a.createInvite(root.id, -1000);
    await rejectsCode(a.register({ username: 'bob', password: 'password1', invite: old }), 'invite');
    const code = a.createInvite(root.id);
    assert.ok(a.revokeInvite(a.listInvites()[0].id));
    await rejectsCode(a.register({ username: 'bob', password: 'password1', invite: code }), 'invite');
  });

  await t('validates username, password and duplicates; reserved names refused', async () => {
    const a = fresh();
    await rejectsCode(a.register({ username: 'a b', password: 'password1' }), 'username');
    await rejectsCode(a.register({ username: 'token', password: 'password1' }), 'username');
    await rejectsCode(a.register({ username: 'root', password: 'short' }), 'password');
    await rejectsCode(a.register({ username: 'root', password: 'x'.repeat(300) }), 'password');
    await a.register({ username: 'root', password: 'password1' });
    await rejectsCode(a.register({ username: 'ROOT', password: 'password1', invite: a.createInvite(1) }), 'taken');
  });

  await t('login, session lookup and logout', async () => {
    const { a } = await withRoot();
    assert.equal(await a.login('root', 'bad'), null);
    assert.equal(await a.login('ghost', 'password1'), null);
    const u = await a.login('Root', 'password1');
    assert.ok(u);
    const sid = a.createSession(u.id);
    assert.equal(a.userBySession(sid).id, u.id);
    assert.equal(a.userBySession('nope'), null);
    a.destroySession(sid);
    assert.equal(a.userBySession(sid), null);
  });

  await t('expired session is rejected', async () => {
    const { a, root } = await withRoot();
    const sid = a.createSession(root.id);
    a.store.run('UPDATE sessions SET expires_at = 1');
    assert.equal(a.userBySession(sid), null);
  });

  await t('suspending a user kills sessions and blocks login; superadmin is protected', async () => {
    const { a, root } = await withRoot();
    const bob = await a.register({ username: 'bob', password: 'password1', invite: a.createInvite(root.id) });
    const sid = a.createSession(bob.id);
    a.setStatus(bob.id, 'suspended');
    assert.equal(a.userBySession(sid), null);
    assert.equal(await a.login('bob', 'password1'), null);
    a.setStatus(bob.id, 'active');
    assert.ok(await a.login('bob', 'password1'));
    assert.throws(() => a.setStatus(root.id, 'suspended'), (e) => e.code === 'forbidden');
  });

  await t('retyped password locks after 5 wrong attempts', async () => {
    const { a, root } = await withRoot();
    for (let i = 0; i < 5; i++) assert.equal(await a.confirmPassword(root.id, 'wrong'), 'wrong');
    assert.equal(await a.confirmPassword(root.id, 'password1'), 'locked', 'even the right password waits out the lock');
  });

  await t('changing the password keeps this session and ends the others', async () => {
    const { a, root } = await withRoot();
    const here = a.createSession(root.id);
    const other = a.createSession(root.id);
    await rejectsCode(a.changePassword(root.id, 'wrong', 'newpassword1', here), 'wrong');
    await rejectsCode(a.changePassword(root.id, 'password1', 'short', here), 'password');
    await a.changePassword(root.id, 'password1', 'newpassword1', here);
    assert.ok(a.userBySession(here));
    assert.equal(a.userBySession(other), null);
    assert.equal(await a.login('root', 'password1'), null);
    assert.ok(await a.login('root', 'newpassword1'));
  });

  await t('superadmin reset gives a one-time temporary password and signs the account out', async () => {
    const { a, root } = await withRoot();
    const bob = await a.register({ username: 'bob', password: 'password1', invite: a.createInvite(root.id) });
    const sid = a.createSession(bob.id);
    const temp = await a.resetPassword(bob.id);
    assert.ok(temp.length >= 12);
    assert.equal(a.userBySession(sid), null);
    assert.equal(await a.login('bob', 'password1'), null);
    assert.ok(await a.login('bob', temp));
    await rejectsCode(a.resetPassword(root.id), 'forbidden');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
