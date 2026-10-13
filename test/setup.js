'use strict';
// Test the initial setup (src/setup.js): the config builder, the .env writer, and the wizard
// as a real server — setup code, wallet creation, through to files written
// and its port released again for the dashboard.
//
// Run: node test/setup.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupNeeded, setupBlocked, upsertEnv, buildConfig, applySetup, cleanEndpoint, runSetup } = require('../src/setup');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const ROOT = path.join(__dirname, '..');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-setup-'));

// Typical wizard answers: Robinhood only, simulation, one target.
const answer = (extra = {}) => ({
  display: { currency: 'IDR' },
  secrets: { authToken: 'token-dasbor-yang-panjang', ...(extra.secrets || {}) },
  capital: { dry_run: true, fixed_quote_usd: 12, max_quote_per_position_usd: 20, max_total_exposure_usd: 60, daily_budget_usd: 60, ...(extra.capital || {}) },
  chains: extra.chains || {
    robinhood: { enabled: true, endpoints: [{ url: 'https://robinhood-rpc.publicnode.com', max_batch: 40, no_logs: true }] },
    bsc: { enabled: false },
  },
  targets: extra.targets || [{ chain: 'robinhood', address: '0x' + '11'.repeat(20), label: 'target satu' }],
  wallet: extra.wallet || null,
  solanaWallet: extra.solanaWallet || null,
});

(async () => {
  console.log('\nkapan pemasangan dijalankan');
  await t('config.json missing -> wizard', () => {
    const d = tmpdir();
    assert.equal(setupNeeded({ cfgPath: path.join(d, 'config.json'), env: {} }), true);
  });
  await t('config.json exists -> normal boot (an old instance is not dragged in)', () => {
    const d = tmpdir();
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, '{}');
    assert.equal(setupNeeded({ cfgPath: p, env: {} }), false);
  });
  await t('can be forced via `lp setup` and LPCOPY_SETUP=1', () => {
    const d = tmpdir();
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, '{}');
    assert.equal(setupNeeded({ cfgPath: p, cmd: 'setup', env: {} }), true);
    assert.equal(setupNeeded({ cfgPath: p, env: { LPCOPY_SETUP: '1' } }), true);
  });

  await t('config lost on an instance that already holds data -> wizard REFUSED', () => {
    const d = tmpdir();
    fs.mkdirSync(path.join(d, 'data'));
    fs.writeFileSync(path.join(d, 'data', 'lpcopy.db'), 'pura-pura database');
    const cfgPath = path.join(d, 'config.json');
    const message = setupBlocked({ root: d, cfgPath });
    assert.match(message || '', /config yang hilang/i);
    // But if it is explicitly requested, the wizard may still run.
    assert.equal(setupBlocked({ root: d, cfgPath, requested: true }), null);
  });
  await t('a truly fresh install (without a database) is not blocked', () => {
    const d = tmpdir();
    assert.equal(setupBlocked({ root: d, cfgPath: path.join(d, 'config.json') }), null);
  });
  await t('config still exists -> nothing is blocked', () => {
    const d = tmpdir();
    const cfgPath = path.join(d, 'config.json');
    fs.writeFileSync(cfgPath, '{}');
    fs.mkdirSync(path.join(d, 'data'));
    fs.writeFileSync(path.join(d, 'data', 'lpcopy.db'), 'x');
    assert.equal(setupBlocked({ root: d, cfgPath }), null);
  });

  console.log('\npenulis .env');
  await t('an existing value is replaced in place, comments stay', () => {
    const initial = '# catatan penting\nLPCOPY_AUTH_TOKEN=\n\n# lain\nALCHEMY_KEY=lama\n';
    const out = upsertEnv(initial, { LPCOPY_AUTH_TOKEN: 'baru', ALCHEMY_KEY: 'kunci2' });
    assert.match(out, /# catatan penting/);
    assert.match(out, /^LPCOPY_AUTH_TOKEN=baru$/m);
    assert.match(out, /^ALCHEMY_KEY=kunci2$/m);
    assert.doesNotMatch(out, /lama/);
  });
  await t('a variable that does not exist yet is appended at the end', () => {
    const out = upsertEnv('LPCOPY_AUTH_TOKEN=x\n', { LPCOPY_NTFY_TOPIC: 'quiver-abc' });
    assert.match(out, /^LPCOPY_NTFY_TOPIC=quiver-abc$/m);
  });
  await t('an empty field does not delete the old value', () => {
    const out = upsertEnv('LPCOPY_GMGN_API_KEY=simpan-aku\n', { LPCOPY_GMGN_API_KEY: '', LPCOPY_AUTH_TOKEN: null });
    assert.match(out, /^LPCOPY_GMGN_API_KEY=simpan-aku$/m);
  });
  await t('a token containing $& or spaces stays intact', () => {
    const tok = 'a$&b c"d';
    const out = upsertEnv('LPCOPY_AUTH_TOKEN=\n', { LPCOPY_AUTH_TOKEN: tok });
    const { parseEnv } = require('../src/env');
    assert.equal(parseEnv(out).LPCOPY_AUTH_TOKEN, tok);
  });
  await t('a line `export KEY=` is also recognised', () => {
    const out = upsertEnv('export ALCHEMY_KEY=lama\n', { ALCHEMY_KEY: 'baru' });
    assert.match(out, /^ALCHEMY_KEY=baru$/m);
    assert.doesNotMatch(out, /lama/);
  });

  console.log('\npenyusun config');
  await t('chains not chosen are switched off, the chosen ones use the wizard endpoint', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: answer() });
    assert.equal(cfg.chains.bsc.enabled, false);
    assert.equal(cfg.chains.robinhood.enabled, true);
    assert.deepEqual(cfg.chains.robinhood.chain.endpoints.map((e) => e.url), ['https://robinhood-rpc.publicnode.com']);
    assert.equal(cfg.chains.robinhood.chain.endpoints[0].no_logs, true);
  });
  await t('capital limits & simulation mode are written to every active chain', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: answer({ chains: { robinhood: { enabled: true, endpoints: [{ url: 'https://a.contoh/rpc' }] }, bsc: { enabled: true, endpoints: [{ url: 'https://b.contoh/rpc' }] } } }),
    });
    for (const k of ['robinhood', 'bsc']) {
      assert.equal(cfg.chains[k].mode.dry_run, true, k);
      assert.equal(cfg.chains[k].rules.sizing.mode, 'fixed_quote', k);
      assert.equal(cfg.chains[k].rules.sizing.fixed_quote_usd, 12, k);
      assert.equal(cfg.chains[k].rules.sizing.max_total_exposure_usd, 60, k);
    }
  });
  await t('targets go into their own chain, lower-case', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: answer({
        chains: { robinhood: { enabled: true, endpoints: [{ url: 'https://a.contoh/rpc' }] }, bsc: { enabled: true, endpoints: [{ url: 'https://b.contoh/rpc' }] } },
        targets: [{ chain: 'bsc', address: '0x' + 'AB'.repeat(20), label: 'di bsc' }],
      }),
    });
    assert.equal(cfg.chains.robinhood.targets.length, 0);
    assert.equal(cfg.chains.bsc.targets[0].address, '0x' + 'ab'.repeat(20));
    assert.equal(cfg.chains.bsc.targets[0].label, 'di bsc');
  });
  await t('Solana: default endpoints, base58 target kept as typed, a 0x address refused there', () => {
    const SOL_T = '6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD';
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: answer({
        chains: { robinhood: { enabled: false }, bsc: { enabled: false }, solana: { enabled: true } },
        targets: [{ chain: 'solana', address: SOL_T, label: 'dlmm' }],
      }),
    });
    assert.equal(cfg.chains.solana.enabled, true);
    assert.ok(cfg.chains.solana.chain.endpoints.length > 0, 'template endpoints kept');
    assert.equal(cfg.chains.solana.targets[0].address, SOL_T, 'base58 is case-sensitive');
    assert.throws(() => buildConfig({
      template: TEMPLATE,
      answers: answer({ chains: { robinhood: { enabled: false }, bsc: { enabled: false }, solana: { enabled: true } }, targets: [{ chain: 'solana', address: '0x' + 'ab'.repeat(20) }] }),
    }), /tidak valid/);
    const flags = buildConfig({
      template: TEMPLATE,
      answers: answer({ chains: { robinhood: { enabled: false }, bsc: { enabled: false }, solana: { enabled: true, endpoints: [{ url: 'https://s.contoh/rpc', no_gpa: true, no_history: true }] } } }),
    });
    assert.deepEqual(flags.chains.solana.chain.endpoints[0], { url: 'https://s.contoh/rpc', no_gpa: true, no_history: true });
  });
  await t('a target already in the old config is not duplicated', () => {
    const base = JSON.parse(JSON.stringify(TEMPLATE));
    base.chains.robinhood.targets = [{ address: '0x' + '11'.repeat(20), label: 'lama' }];
    const cfg = buildConfig({ template: TEMPLATE, base, answers: answer() });
    assert.equal(cfg.chains.robinhood.targets.length, 1);
    assert.equal(cfg.chains.robinhood.targets[0].label, 'lama');
  });
  await t('secrets do not go into config.json — its field is emptied', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: answer({ secrets: { authToken: 'rahasia-panjang-sekali', telegramToken: '123:abc', ntfyTopic: 'quiver-x', gmgnKey: 'gm', publicUrl: 'https://lp.uji-saya.test' } }),
    });
    const caption = JSON.stringify(cfg);
    assert.equal(cfg.server.auth_token, null);
    assert.equal(cfg.telegram.bot_token, null);
    assert.equal(cfg.notify.ntfy_topic, null);
    assert.equal(cfg.gmgn.api_key, null);
    assert.equal(cfg.server.public_url, null);
    for (const r of ['rahasia-panjang-sekali', '123:abc', 'quiver-x', 'lp.uji-saya.test']) assert.ok(!caption.includes(r), `${r} bocor ke config`);
  });
  await t('Alchemy: endpoint at the front, its key stays ${ALCHEMY_KEY}', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: answer({ secrets: { authToken: 'token-dasbor-yang-panjang', alchemyKey: 'kunci-rahasia' } }) });
    const first = cfg.chains.robinhood.chain.endpoints[0];
    assert.match(first.url, /robinhood-mainnet\.g\.alchemy\.com\/v2\/\$\{ALCHEMY_KEY\}$/);
    assert.ok(!JSON.stringify(cfg).includes('kunci-rahasia'));
  });
  await t('every setup leaves its timestamp', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: answer() });
    assert.ok(cfg.setup.completed_ts > 0);
  });
  await t('without a chain / without RPC / a nonsense address rejected before anything is written', () => {
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: answer({ chains: { robinhood: { enabled: false }, bsc: { enabled: false } } }) }), /minimal satu chain/i);
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: answer({ chains: { robinhood: { enabled: true, endpoints: [] }, bsc: { enabled: false } } }) }), /endpoint RPC/i);
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: answer({ targets: [{ chain: 'robinhood', address: 'bukan-alamat' }] }) }), /tidak valid/i);
  });
  await t('an http RPC URL to another machine is rejected, to localhost is allowed', () => {
    assert.throws(() => cleanEndpoint({ url: 'http://rpc.contoh.com' }), /https/);
    assert.equal(cleanEndpoint({ url: 'http://127.0.0.1:8545' }).url, 'http://127.0.0.1:8545');
  });

  console.log('\nwriting files');
  await t('config 600, .env 600, key 600 — and config.json is written last', () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const pk = '0x' + '42'.repeat(32);
      const r = applySetup({
        root: d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env'),
        answers: answer({ secrets: { authToken: 'token-dasbor-yang-panjang', ntfyTopic: 'quiver-abc' }, wallet: { privateKey: pk, mnemonic: 'kata kata rahasia' } }),
      });
      const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
      assert.equal(mode(path.join(d, 'config.json')), '600');
      assert.equal(mode(path.join(d, '.env')), '600');
      assert.equal(mode(path.join(home, '.lpcopy', 'key')), '600');
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', 'key'), 'utf8'), pk);
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', 'key.mnemonic'), 'utf8'), 'kata kata rahasia');
      assert.match(fs.readFileSync(path.join(d, '.env'), 'utf8'), /^LPCOPY_NTFY_TOPIC=quiver-abc$/m);
      assert.equal(r.wallet.address, new (require('ethers').Wallet)(pk).address.toLowerCase());
    } finally { process.env.HOME = originalHome; }
  });
  await t('the old key is backed up, not overwritten', () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      fs.mkdirSync(path.join(home, '.lpcopy'), { recursive: true });
      fs.writeFileSync(path.join(home, '.lpcopy', 'key'), '0x' + '11'.repeat(32), { mode: 0o600 });
      applySetup({
        root: d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env'),
        answers: answer({ wallet: { privateKey: '0x' + '42'.repeat(32) } }),
      });
      const bak = fs.readdirSync(path.join(home, '.lpcopy')).filter((f) => f.startsWith('key.bak-'));
      assert.equal(bak.length, 1);
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', bak[0]), 'utf8'), '0x' + '11'.repeat(32));
    } finally { process.env.HOME = originalHome; }
  });

  await t('Solana key: written base58 with mode 600 next to the EVM key; an old different key is backed up', () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58').default || require('bs58');
      const old = Keypair.generate(), kp = Keypair.generate();
      fs.mkdirSync(path.join(home, '.lpcopy'), { recursive: true });
      fs.writeFileSync(path.join(home, '.lpcopy', 'solana-key'), bs58.encode(old.secretKey), { mode: 0o600 });
      const r = applySetup({
        root: d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env'),
        answers: answer({ solanaWallet: { secret: JSON.stringify([...kp.secretKey]) } }),
      });
      const file = path.join(home, '.lpcopy', 'solana-key');
      assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
      assert.equal(fs.readFileSync(file, 'utf8'), bs58.encode(kp.secretKey), 'a JSON array is stored as base58');
      assert.equal(r.solanaWallet.address, kp.publicKey.toBase58());
      const bak = fs.readdirSync(path.join(home, '.lpcopy')).filter((f) => f.startsWith('solana-key.bak-'));
      assert.equal(bak.length, 1);
    } finally { process.env.HOME = originalHome; }
  });

  console.log('\nbilingual wizard page');
  await t('the default is English, and the choice is shared with the dashboard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'setup-page.js'), 'utf8');
    assert.match(src, /return 'en';/, 'the wizard\'s default language must be English');
    assert.match(src, /localStorage\.setItem\('lpcopy-lang'/, "the language choice must be stored under the same key as the dashboard");
    assert.match(src, /<html lang="en">/);
  });
  await t('every translated text has an English entry', () => {
    // A guard in the same spirit as web/check-keys.py: if a new sentence is later
    // wrapped in t() but no translation is added, the English UI would slip in an
    // Indonesian sentence — this test is what catches it.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'setup-page.js'), 'utf8');
    const js = src.slice(src.indexOf('const JS = '), src.indexOf('const SETUP_PAGE'));
    const dict = new Set();
    for (const m of js.matchAll(/^\s*"((?:\\.|[^"])*)":\s*"/gm)) dict.add(m[1].replace(/\\\$/g, '$'));
    const used = new Set();
    for (const m of js.matchAll(/\bt\(\s*'((?:\\.|[^'])*)'/g)) used.add(m[1].replace(/\\'/g, "'").replace(/\\\$/g, '$'));
    for (const m of js.matchAll(/\bt\([^)]*?\?\s*'((?:\\.|[^'])*)'\s*:\s*'((?:\\.|[^'])*)'/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of js.matchAll(/pick\('[a-z]+',\s*'((?:\\.|[^'])*)',\s*'((?:\\.|[^'])*)'\)/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of /var TITLES = \[([^\]]*)\]/.exec(js)[1].matchAll(/'([^']*)'/g)) used.add(m[1]);
    for (const m of js.matchAll(/return '([A-Z][^']{10,})';/g)) used.add(m[1]);
    assert.ok(dict.size > 100, `dictionary too small (${dict.size})`);
    // 'Telegram' is the same in both languages — no entry needed.
    const short = [...used].filter((x) => x && x !== 'Telegram' && !dict.has(x));
    assert.deepEqual(short, [], `tanpa terjemahan Inggris: ${short.join(' | ').slice(0, 300)}`);
  });

  console.log('\nwizard sebagai server');
  await t('wrong code rejected, the right code opens /state, finish writes & releases the port', async () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const originalHome = process.env.HOME;
    const port = 8900 + Math.floor(Math.random() * 90);
    process.env.HOME = home;
    process.env.LPCOPY_SETUP_PORT = String(port);
    process.env.LPCOPY_SETUP_HOST = '127.0.0.1';
    const cfgPath = path.join(d, 'config.json');
    try {
      const finished = runSetup({ root: d, cfgPath, envPath: path.join(d, '.env'), log: () => {} });
      const code = fs.readFileSync(path.join(d, 'data', 'setup-code.txt'), 'utf8').trim();
      const url = (p) => `http://127.0.0.1:${port}${p}`;
      const get = (p, passcode) => fetch(url(p), { headers: { 'x-setup-code': passcode } });
      const post = (p, body, passcode) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-code': passcode }, body: JSON.stringify(body) });

      const page = await fetch(url('/'));
      assert.equal(page.status, 200);
      assert.match(await page.text(), /pemasangan/i);

      assert.equal((await get('/api/setup/state', 'salah123')).status, 401);
      const st = await (await get('/api/setup/state', code)).json();
      assert.equal(st.ok, true);
      assert.equal(st.chains.length, Object.keys(require('../src/networks').NETWORKS).length);
      assert.ok(st.chains.find((c) => c.key === 'solana' && c.kind === 'solana' && c.endpoints.length > 0), 'Solana offered with its default endpoints');
      assert.ok(st.suggestToken.length >= 20);
      assert.ok(st.chains[0].endpoints.length > 0);

      const w = await (await post('/api/setup/wallet', { mode: 'generate' }, code)).json();
      assert.match(w.wallet.address, /^0x[0-9a-f]{40}$/);
      const replyText = JSON.stringify(w);
      assert.ok(!/[0-9a-f]{64}/.test(replyText), 'the private key was sent to the browser');

      const r = await (await post('/api/setup/finish', {
        display: { currency: 'IDR' },
        secrets: { authToken: 'token-dasbor-yang-panjang' },
        capital: { dry_run: true, fixed_quote_usd: 12 },
        chains: { robinhood: { enabled: true, endpoints: [{ ref: 0 }] }, bsc: { enabled: false } },
        targets: [],
      }, code)).json();
      assert.equal(r.ok, true);
      assert.equal(r.address, w.wallet.address);

      await finished;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.equal(cfg.chains.robinhood.enabled, true);
      assert.equal(cfg.chains.bsc.enabled, false);
      assert.equal(cfg.chains.robinhood.chain.endpoints[0].url, TEMPLATE.chains.robinhood.chain.endpoints[0].url);
      assert.equal(process.env.LPCOPY_AUTH_TOKEN, 'token-dasbor-yang-panjang');
      assert.ok(!fs.existsSync(path.join(d, 'data', 'setup-code.txt')), 'the setup code must be deleted after finishing');
      // The port must really be free: the dashboard server binds it a moment later.
      const check = require('node:http').createServer(() => {});
      await new Promise((res, rej) => { check.once('error', rej); check.listen(port, '127.0.0.1', res); });
      await new Promise((res) => check.close(res));
    } finally {
      process.env.HOME = originalHome;
      delete process.env.LPCOPY_SETUP_PORT;
      delete process.env.LPCOPY_SETUP_HOST;
      delete process.env.LPCOPY_AUTH_TOKEN;
    }
  });

  // ---- restore from a backup (the wizard's second path) ----
  console.log('\nrestore from a backup');
  const { ethers } = require('ethers');
  const { Store } = require('../src/db');
  const { createBackup } = require('../src/backup');
  const { applyRestore } = require('../src/setup');
  // Backup from "another machine": foreign absolute path, old token in the file, LIVE, RPC ${RAHASIA_RPC}.
  const makeBackup = async () => {
    const d = tmpdir();
    const cfgPath = path.join(d, 'config.json');
    const cfg = JSON.parse(JSON.stringify(TEMPLATE));
    cfg.server = { ...cfg.server, port: 20180, auth_token: 'token-lama-mesin-asal' };
    cfg.db = { path: '/home/orang-lain/lpcopy/data/lpcopy.db' };
    cfg.wallet = { key_file: '/home/orang-lain/.lpcopy/key' };
    cfg.mode = { dry_run: false };
    cfg.chains.robinhood.chain.endpoints.unshift({ url: 'https://rpc.contoh.test/v2/${RAHASIA_RPC}' });
    cfg.chains.robinhood.rules = { ...(cfg.chains.robinhood.rules || {}), marker: 'dari-cadangan' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const dbPath = path.join(d, 'lpcopy.db');
    const store = new Store(dbPath);
    for (let i = 0; i < 4; i++) store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,quote_symbol,liquidity)
      VALUES('v4','0xp',?,'0xa','0xb',-1,1,'closed',1,10,'USDG','0')`, String(i));
    const wallet = ethers.Wallet.createRandom();
    const b = await createBackup({ parts: { config: true, db: true, wallet: true }, cfgPath, db: store.db, dbPath, wallet, password: 'password-kuat', meta: { instance: 'asal' } });
    store.db.close();
    return { backup: JSON.parse(JSON.stringify(b)), address: wallet.address.toLowerCase() };
  };
  const newEngine = () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    return { d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env') };
  };
  const src = await makeBackup();
  const safe = async (fn) => {
    const originalHome = process.env.HOME;
    const home = tmpdir();
    process.env.HOME = home;
    try { return await fn(home); } finally {
      process.env.HOME = originalHome;
      delete process.env.LPCOPY_AUTH_TOKEN; delete process.env.RAHASIA_RPC; delete process.env.LAIN_LAIN;
    }
  };

  await t('complete: this machine\'s config, database & wallet installed, always simulation', () => safe(async (home) => {
    const m = newEngine();
    const r = await applyRestore({ root: m.d, cfgPath: m.cfgPath, envPath: m.envPath, backup: src.backup, parts: { db: true, wallet: true },
      password: 'password-kuat', token: 'token-baru-mesin-ini', port: 8911, env: { RAHASIA_RPC: 'k123', LAIN_LAIN: 'x' } });
    const cfg = JSON.parse(fs.readFileSync(m.cfgPath, 'utf8'));
    assert.equal(cfg.server.port, 8911);
    assert.equal(cfg.server.auth_token, null, 'the origin machine\'s token is not carried over');
    assert.equal(cfg.mode.dry_run, true);
    assert.equal(cfg.db.path, 'data/lpcopy.db', 'a foreign path falls back to the default');
    assert.equal(cfg.wallet.key_file, '~/.lpcopy/key');
    assert.equal(cfg.chains.robinhood.rules.marker, 'dari-cadangan');
    assert.ok(cfg.setup.restored_from);
    const env = fs.readFileSync(m.envPath, 'utf8');
    assert.match(env, /^LPCOPY_AUTH_TOKEN=token-baru-mesin-ini$/m);
    assert.match(env, /^RAHASIA_RPC=k123$/m);
    assert.ok(!/LAIN_LAIN/.test(env), 'a variable not referenced by the config must not be written');
    const s2 = new Store(path.join(m.d, 'data', 'lpcopy.db'));
    assert.equal(s2.get('SELECT COUNT(*) n FROM positions').n, 4);
    s2.db.close();
    const key = fs.readFileSync(path.join(home, '.lpcopy', 'key'), 'utf8').trim();
    assert.equal(new ethers.Wallet(key).address.toLowerCase(), src.address);
    assert.equal(r.wallet.address, src.address);
  }));

  await t('wrong keystore password: not a single file is written', () => safe(async (home) => {
    const m = newEngine();
    await assert.rejects(applyRestore({ root: m.d, cfgPath: m.cfgPath, envPath: m.envPath, backup: src.backup, parts: { db: true, wallet: true },
      password: 'salah-salah', token: 'token-baru-mesin-ini', port: 8911 }), /Password keystore salah/);
    for (const f of [m.cfgPath, m.envPath, path.join(m.d, 'data', 'lpcopy.db'), path.join(m.d, 'data', 'lpcopy.db.restore-pending'), path.join(home, '.lpcopy', 'key')]) {
      assert.ok(!fs.existsSync(f), `${f} tertulis`);
    }
  }));

  await t('without a database/wallet, short token, nonsense port, a file without config', () => safe(async () => {
    const m = newEngine();
    const base = { root: m.d, cfgPath: m.cfgPath, envPath: m.envPath, backup: src.backup, token: 'token-baru-mesin-ini', port: 8911 };
    await assert.rejects(applyRestore({ ...base, token: 'pendek' }), /minimal 12/);
    await assert.rejects(applyRestore({ ...base, port: 99999 }), /Port dasbor/);
    await assert.rejects(applyRestore({ ...base, backup: { ...src.backup, parts: { db: src.backup.parts.db } } }), /tidak berisi pengaturan/);
    assert.ok(!fs.existsSync(m.cfgPath));
    await applyRestore(base);   // settings only
    assert.ok(fs.existsSync(m.cfgPath));
    assert.ok(!fs.existsSync(path.join(m.d, 'data', 'lpcopy.db')), 'the database was not requested');
  }));

  await t('via the wizard server: inspect names the missing variable, restore releases the port', () => safe(async () => {
    const m = newEngine();
    const port = 8900 + Math.floor(Math.random() * 90);
    process.env.LPCOPY_SETUP_PORT = String(port);
    process.env.LPCOPY_SETUP_HOST = '127.0.0.1';
    try {
      const finished = runSetup({ root: m.d, cfgPath: m.cfgPath, envPath: m.envPath, log: () => {} });
      const code = fs.readFileSync(path.join(m.d, 'data', 'setup-code.txt'), 'utf8').trim();
      const post = (p, body, passcode = code) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-code': passcode }, body: JSON.stringify(body) }).then((r) => r.json());
      assert.match((await post('/api/setup/restore', { backup: src.backup }, 'salah123')).error, /Kode pemasangan salah/);
      const ins = await post('/api/setup/restore/inspect', { config: src.backup.parts.config.json });
      assert.deepEqual(ins.envVars.filter((v) => !v.set).map((v) => v.name), ['RAHASIA_RPC']);
      assert.equal(ins.backupPort, 20180);
      const r = await post('/api/setup/restore', { backup: src.backup, parts: { db: true }, token: 'token-baru-mesin-ini', port });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.restored, true);
      assert.equal(r.samePort, true);
      await finished;
      assert.equal(JSON.parse(fs.readFileSync(m.cfgPath, 'utf8')).server.port, port);
    } finally {
      delete process.env.LPCOPY_SETUP_PORT;
      delete process.env.LPCOPY_SETUP_HOST;
    }
  }));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
