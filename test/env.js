'use strict';
// Secrets via .env: loaded, override config.json, and are never written
// back to config.json. Run: node test/env.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv, loadDotEnv, applyEnv, cfgForDisk, writeCfg, envName } = require('../src/env');
const { createSettingsRoutes } = require('../src/settings');

const tests = [];
const test = (n, f) => tests.push([n, f]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-env-'));
const TG = '123456789:AAHrahasiaBotTelegramYangPanjangSekali';
const baseCfg = () => ({
  server: { port: 1, auth_token: 'token-lama-di-config' },
  telegram: { bot_token: null, chat_ids: ['42'] },
  notify: { ntfy_topic: null },
  chain: { endpoints: [
    { url: 'https://rpc.publik.test' },
    { url: 'https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}', headers: { 'x-api-key': '${RPC_KEY}' } },
  ] },
  gas: { price_multiplier: 1.5 },
});
// Test variables must not leak between tests through process.env.
const withEnv = (vars, f) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = f(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);   // async test: restore when done
  restore();
  return r;
};

test('parseEnv: quotes, comments, export, blank lines', () => {
  const v = parseEnv([
    '# komentar', '', 'A=1', 'export B=dua', "C='a # bukan komentar'", 'D="baris\\nbaru"',
    'E=nilai   # komentar ujung', 'F=', 'bukan baris', ' G = spasi ',
  ].join('\n'));
  assert.deepStrictEqual(v, { A: '1', B: 'dua', C: 'a # bukan komentar', D: 'baris\nbaru', E: 'nilai', F: '', G: 'spasi' });
});

test('loadDotEnv: does not overwrite variables already set, empty ones skipped', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, 'UJI_ENV_A=dari-berkas\nUJI_ENV_B=dari-berkas\nUJI_ENV_C=\n', { mode: 0o600 });
  withEnv({ UJI_ENV_A: 'dari-shell', UJI_ENV_B: null, UJI_ENV_C: null }, () => {
    const r = loadDotEnv(f);
    assert.strictEqual(process.env.UJI_ENV_A, 'dari-shell');
    assert.strictEqual(process.env.UJI_ENV_B, 'dari-berkas');
    assert.strictEqual(process.env.UJI_ENV_C, undefined);
    assert.deepStrictEqual(r.keys, ['UJI_ENV_B'], 'only names actually loaded are reported');
    assert.deepStrictEqual(r.external, ['UJI_ENV_A'], 'ones that lose to an outside variable are reported separately');
  });
});

test('loadDotEnv: refuses a private key in a file with loose permissions', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, `LPCOPY_PRIVATE_KEY=0x${'1'.repeat(64)}\n`);
  fs.chmodSync(f, 0o644);
  withEnv({ LPCOPY_PRIVATE_KEY: null }, () => {
    assert.throws(() => loadDotEnv(f), /chmod 600/);
    assert.strictEqual(process.env.LPCOPY_PRIVATE_KEY, undefined, 'the key must not be loaded');
  });
  // without a private key: just flagged loosely, still loaded
  fs.writeFileSync(f, 'UJI_ENV_D=x\n');
  withEnv({ UJI_ENV_D: null }, () => { assert.strictEqual(loadDotEnv(f).loose, true); });
});

test('loadDotEnv: file missing = fine', () => {
  assert.deepStrictEqual(loadDotEnv(path.join(tmp(), 'tidak-ada')), { file: null, keys: [], external: [] });
});

test('applyEnv: .env mengalahkan config.json, ${NAMA} di RPC terisi', () => {
  const cfg = baseCfg();
  const meta = applyEnv(cfg, {
    LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, ALCHEMY_KEY: 'kunciAlchemy123', RPC_KEY: 'kunciHeader',
  });
  assert.strictEqual(cfg.server.auth_token, 'token-dari-env');
  assert.strictEqual(cfg.telegram.bot_token, TG);
  assert.strictEqual(cfg.notify.ntfy_topic, null, 'a variable not filled in changes nothing');
  assert.strictEqual(cfg.chain.endpoints[1].url, 'https://robinhood-mainnet.g.alchemy.com/v2/kunciAlchemy123');
  assert.strictEqual(cfg.chain.endpoints[1].headers['x-api-key'], 'kunciHeader');
  assert.deepStrictEqual(meta.missing, []);
  assert.strictEqual(envName(cfg, 'telegram.bot_token'), 'LPCOPY_TELEGRAM_BOT_TOKEN');
  assert.strictEqual(envName(cfg, 'notify.ntfy_topic'), null);
  assert.ok(!JSON.stringify(cfg).includes('__'), 'the .env notes must not get serialised');
});

test('applyEnv: an RPC variable that does not exist is reported, the URL is left', () => {
  const cfg = baseCfg();
  const meta = applyEnv(cfg, {});
  assert.deepStrictEqual(meta.missing.sort(), ['ALCHEMY_KEY', 'RPC_KEY']);
  assert.match(cfg.chain.endpoints[1].url, /\$\{ALCHEMY_KEY\}/);
});

test('cfgForDisk: secrets from .env are not written, other changes stay', () => {
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, ALCHEMY_KEY: 'kunciAlchemy123', RPC_KEY: 'kunciHeader' });
  cfg.gas.price_multiplier = 2;                      // an ordinary change from the dashboard
  cfg.telegram.chat_ids.push('77');                  // new chat connected
  // RPC list changed from the dashboard: order reversed + a new endpoint. The old endpoint
  // carries the already-filled URL (like the POST /api/settings/rpc route).
  cfg.chain.endpoints = [cfg.chain.endpoints[1], cfg.chain.endpoints[0], { url: 'https://baru.test' }];
  const disk = JSON.stringify(cfgForDisk(cfg));
  for (const secret of ['token-dari-env', TG, 'kunciAlchemy123', 'kunciHeader']) assert.ok(!disk.includes(secret), `${secret} bocor ke disk`);
  const d = JSON.parse(disk);
  assert.strictEqual(d.server.auth_token, 'token-lama-di-config', 'the file\'s original value is restored');
  assert.strictEqual(d.telegram.bot_token, null);
  assert.strictEqual(d.gas.price_multiplier, 2);
  assert.deepStrictEqual(d.telegram.chat_ids, ['42', '77']);
  assert.strictEqual(d.chain.endpoints[0].url, 'https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}');
  assert.strictEqual(d.chain.endpoints[0].headers['x-api-key'], '${RPC_KEY}');
  assert.strictEqual(d.chain.endpoints[2].url, 'https://baru.test');
  // the in-memory object keeps using the .env value
  assert.strictEqual(cfg.telegram.bot_token, TG);
});

test('writeCfg: file 600 and free of secrets', () => {
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_TELEGRAM_BOT_TOKEN: TG });
  const f = path.join(tmp(), 'config.json');
  writeCfg(f, cfg);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(TG));
});

// ---- Settings page ------------------------------------------------------
function routes(cfg, dir) {
  const cfgPath = path.join(dir, 'config.json');
  const logs = [];
  const r = createSettingsRoutes({
    cfg, cfgPath, log: (m) => logs.push(m), readBody: async (req) => req.__body,
    store: { setState() {}, getState: () => null },
    rpc: { stats: () => [], reconfigure() {} },
    engine: {
      dryRun: () => true, paused: () => false, drawdownStatus: () => ({ enabled: false, pct: 0, peakUsd: null, tripped: false }),
      freshCash: async () => null, ethUsd: 2500, positions: { summary: () => ({ exposureUsd: 0, leftoverUsd: 0, feeUsd: 0 }) },
      exec: { address: () => null, keyPath: () => path.join(dir, 'key'), resetWallet() {} },
    },
    telegram: null,
  });
  const call = (key, body = {}) => r[key]({ __body: body, headers: {} }, new URL('http://x/'), {});
  return { call, cfgPath, logs };
}

test('settings: fields from .env are locked, the dashboard is told where from', async () => {
  const dir = tmp();
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, LPCOPY_NTFY_TOPIC: 'topik-rahasia', LPCOPY_GMGN_API_KEY: 'gmgnKeyRahasia123' });
  const { call, cfgPath } = routes(cfg, dir);
  const g = await call('GET /api/settings');
  assert.strictEqual(g.telegram.fromEnv, 'LPCOPY_TELEGRAM_BOT_TOKEN');
  assert.strictEqual(g.notify.fromEnv, 'LPCOPY_NTFY_TOPIC');
  assert.strictEqual(g.gmgn.fromEnv, 'LPCOPY_GMGN_API_KEY');
  assert.ok(g.gmgn.hasKey && !JSON.stringify(g).includes('gmgnKeyRahasia123'), 'the GMGN API key must not reach the browser');
  assert.match((await call('POST /api/settings/gmgn', { api_key: 'lain12345' })).error, /LPCOPY_GMGN_API_KEY/);
  assert.strictEqual(g.authFromEnv, 'LPCOPY_AUTH_TOKEN');
  assert.ok(!JSON.stringify(g).includes(TG), 'the bot token must not reach the browser');
  assert.match((await call('POST /api/settings/telegram', { bot_token: '987654321:AAHtokenLainYangPanjangSekaliAbc' })).error, /LPCOPY_TELEGRAM_BOT_TOKEN/);
  assert.match((await call('POST /api/settings/token/rotate')).error, /LPCOPY_AUTH_TOKEN/);
  assert.match((await call('POST /api/settings/notify', { ntfy_topic: 'lain' })).error, /LPCOPY_NTFY_TOPIC/);
  assert.strictEqual(cfg.telegram.bot_token, TG, 'token unchanged');
  // other settings can still be saved, and saving them does not leak secrets
  const r = await call('POST /api/settings/telegram', { notify: { info: true } });
  assert.ok(r.ok, JSON.stringify(r));
  const disk = fs.readFileSync(cfgPath, 'utf8');
  for (const secret of ['token-dari-env', TG, 'topik-rahasia', 'gmgnKeyRahasia123']) assert.ok(!disk.includes(secret), `${secret} bocor ke config.json`);
  assert.strictEqual(JSON.parse(disk).telegram.notify.info, true);
});

test('settings: the GMGN API key is saved to config.json, shown masked, can be detached', async () => {
  const dir = tmp();
  const cfg = baseCfg();
  const { call, cfgPath } = routes(cfg, dir);
  assert.match((await call('POST /api/settings/gmgn', { api_key: 'x y' })).error, /tidak dikenali/);
  const r = await call('POST /api/settings/gmgn', { api_key: '  gmgn_abcdef123456  ' });
  assert.ok(r.ok && r.gmgn.hasKey && r.gmgn.key.startsWith('gmgn_a') && !r.gmgn.key.includes('123456'), JSON.stringify(r));
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).gmgn.api_key, 'gmgn_abcdef123456');
  assert.match((await call('POST /api/settings/gmgn/test')).error, /pasar/i, 'without the market module explained');
  const rm = await call('POST /api/settings/gmgn', { api_key: '' });
  assert.ok(rm.ok && !rm.gmgn.hasKey);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).gmgn.api_key, null);
});

test('settings: a private key from .env disables replace/detach wallet', async () => {
  const dir = tmp();
  await withEnv({ LPCOPY_PRIVATE_KEY: `0x${'2'.repeat(64)}` }, async () => {
    const { call } = routes(baseCfg(), dir);
    const g = await call('GET /api/settings');
    assert.strictEqual(g.wallet.fromEnv, 'LPCOPY_PRIVATE_KEY');
    assert.strictEqual(g.wallet.hasKey, true);
    for (const k of ['POST /api/settings/wallet/generate', 'POST /api/settings/wallet/import', 'POST /api/settings/wallet/remove']) {
      assert.match((await call(k, { privateKey: `0x${'3'.repeat(64)}`, replace: true })).error, /LPCOPY_PRIVATE_KEY/, k);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'key')), 'the key file must not be created');
  });
});

// The default value redaction and the secondary currency share one route; saving one
// must not erase the other.
test('settings: the default value redaction is saved without touching the currency', async () => {
  const dir = tmp();
  const cfg = baseCfg();
  cfg.display = { currency: 'IDR' };
  const { call, cfgPath } = routes(cfg, dir);
  assert.strictEqual((await call('GET /api/settings')).display.hide_values, false);
  const r = await call('POST /api/settings/display', { hide_values: true });
  assert.ok(r.ok && r.hide_values === true, JSON.stringify(r));
  let disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(disk.display, { currency: 'IDR', hide_values: true });
  assert.strictEqual((await call('GET /api/settings')).display.hide_values, true);
  // change currency: redaction stays on
  assert.ok((await call('POST /api/settings/display', { currency: 'EUR' })).ok);
  disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(disk.display, { currency: 'EUR', hide_values: true });
  assert.ok((await call('POST /api/settings/display', { hide_values: false })).ok);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).display.hide_values, false);
});

(async () => {
  let ok = 0, bad = 0;
  for (const [n, f] of tests) {
    try { await f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.message); }
  }
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
