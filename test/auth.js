'use strict';
// Multi-user accounts: first-user bootstrap, invite-only registration, login, sessions, suspension.
//
// Run: node test/auth.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Auth, AuthError, hashPassword, verifyPassword } = require('../src/auth');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAILED ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof AuthError && e.code === code);
const fresh = () => new Auth(new Store(':memory:'));

t('password hash verifies and rejects', () => {
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});

t('first account is superadmin without invite, later ones need one', () => {
  const a = fresh();
  const root = a.register({ username: 'Root', password: 'password1' });
  assert.equal(root.role, 'superadmin');
  assert.equal(root.username, 'root');
  throwsCode(() => a.register({ username: 'bob', password: 'password1' }), 'invite');
  throwsCode(() => a.register({ username: 'bob', password: 'password1', invite: 'nope' }), 'invite');
});

t('invite is single-use and stored hashed', () => {
  const a = fresh();
  const root = a.register({ username: 'root', password: 'password1' });
  const code = a.createInvite(root.id);
  assert.ok(!a.store.all('SELECT code_hash FROM invites').some((r) => r.code_hash === code));
  const bob = a.register({ username: 'bob', password: 'password1', invite: code });
  assert.equal(bob.role, 'user');
  throwsCode(() => a.register({ username: 'eve', password: 'password1', invite: code }), 'invite');
});

t('expired and revoked invites are refused', () => {
  const a = fresh();
  const root = a.register({ username: 'root', password: 'password1' });
  const old = a.createInvite(root.id, -1000);
  throwsCode(() => a.register({ username: 'bob', password: 'password1', invite: old }), 'invite');
  const code = a.createInvite(root.id);
  assert.ok(a.revokeInvite(a.listInvites()[0].id));
  throwsCode(() => a.register({ username: 'bob', password: 'password1', invite: code }), 'invite');
});

t('validates username, password and duplicates', () => {
  const a = fresh();
  throwsCode(() => a.register({ username: 'a b', password: 'password1' }), 'username');
  throwsCode(() => a.register({ username: 'root', password: 'short' }), 'password');
  a.register({ username: 'root', password: 'password1' });
  throwsCode(() => a.register({ username: 'ROOT', password: 'password1' }), 'taken');
});

t('login, session lookup and logout', () => {
  const a = fresh();
  a.register({ username: 'root', password: 'password1' });
  assert.equal(a.login('root', 'bad'), null);
  assert.equal(a.login('ghost', 'password1'), null);
  const u = a.login('Root', 'password1');
  assert.ok(u);
  const sid = a.createSession(u.id);
  assert.equal(a.userBySession(sid).id, u.id);
  assert.equal(a.userBySession('nope'), null);
  a.destroySession(sid);
  assert.equal(a.userBySession(sid), null);
});

t('expired session is rejected', () => {
  const a = fresh();
  const u = a.register({ username: 'root', password: 'password1' });
  const sid = a.createSession(u.id);
  a.store.run('UPDATE sessions SET expires_at = 1');
  assert.equal(a.userBySession(sid), null);
});

t('suspending a user kills sessions and blocks login; superadmin is protected', () => {
  const a = fresh();
  const root = a.register({ username: 'root', password: 'password1' });
  const bob = a.register({ username: 'bob', password: 'password1', invite: a.createInvite(root.id) });
  const sid = a.createSession(bob.id);
  a.setStatus(bob.id, 'suspended');
  assert.equal(a.userBySession(sid), null);
  assert.equal(a.login('bob', 'password1'), null);
  a.setStatus(bob.id, 'active');
  assert.ok(a.login('bob', 'password1'));
  throwsCode(() => a.setStatus(root.id, 'suspended'), 'forbidden');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
