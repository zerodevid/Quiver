'use strict';
// Rahasia lewat .env: dimuat, mengalahkan config.json, dan tidak pernah tertulis
// balik ke config.json. Jalankan: node test/env.js
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
// Variabel uji tidak boleh bocor antar-uji lewat process.env.
const withEnv = (vars, f) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = f(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);   // uji async: pulihkan setelah selesai
  restore();
  return r;
};

test('parseEnv: kutip, komentar, export, baris kosong', () => {
  const v = parseEnv([
    '# komentar', '', 'A=1', 'export B=dua', "C='a # bukan komentar'", 'D="baris\\nbaru"',
    'E=nilai   # komentar ujung', 'F=', 'bukan baris', ' G = spasi ',
  ].join('\n'));
  assert.deepStrictEqual(v, { A: '1', B: 'dua', C: 'a # bukan komentar', D: 'baris\nbaru', E: 'nilai', F: '', G: 'spasi' });
});

test('loadDotEnv: tidak menimpa variabel yang sudah diset, yang kosong dilewati', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, 'UJI_ENV_A=dari-berkas\nUJI_ENV_B=dari-berkas\nUJI_ENV_C=\n', { mode: 0o600 });
  withEnv({ UJI_ENV_A: 'dari-shell', UJI_ENV_B: null, UJI_ENV_C: null }, () => {
    const r = loadDotEnv(f);
    assert.strictEqual(process.env.UJI_ENV_A, 'dari-shell');
    assert.strictEqual(process.env.UJI_ENV_B, 'dari-berkas');
    assert.strictEqual(process.env.UJI_ENV_C, undefined);
    assert.deepStrictEqual(r.keys, ['UJI_ENV_B'], 'hanya nama yang benar-benar dimuat yang dilaporkan');
    assert.deepStrictEqual(r.external, ['UJI_ENV_A'], 'yang kalah oleh variabel dari luar dilaporkan terpisah');
  });
});

test('loadDotEnv: menolak kunci privat di berkas yang izinnya longgar', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, `LPCOPY_PRIVATE_KEY=0x${'1'.repeat(64)}\n`);
  fs.chmodSync(f, 0o644);
  withEnv({ LPCOPY_PRIVATE_KEY: null }, () => {
    assert.throws(() => loadDotEnv(f), /chmod 600/);
    assert.strictEqual(process.env.LPCOPY_PRIVATE_KEY, undefined, 'kunci tidak boleh termuat');
  });
  // tanpa kunci privat: cukup ditandai longgar, tetap dimuat
  fs.writeFileSync(f, 'UJI_ENV_D=x\n');
  withEnv({ UJI_ENV_D: null }, () => { assert.strictEqual(loadDotEnv(f).loose, true); });
});

test('loadDotEnv: berkas tidak ada = tidak apa-apa', () => {
  assert.deepStrictEqual(loadDotEnv(path.join(tmp(), 'tidak-ada')), { file: null, keys: [], external: [] });
});

test('applyEnv: .env mengalahkan config.json, ${NAMA} di RPC terisi', () => {
  const cfg = baseCfg();
  const meta = applyEnv(cfg, {
    LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, ALCHEMY_KEY: 'kunciAlchemy123', RPC_KEY: 'kunciHeader',
  });
  assert.strictEqual(cfg.server.auth_token, 'token-dari-env');
  assert.strictEqual(cfg.telegram.bot_token, TG);
  assert.strictEqual(cfg.notify.ntfy_topic, null, 'variabel yang tidak diisi tidak mengubah apa pun');
  assert.strictEqual(cfg.chain.endpoints[1].url, 'https://robinhood-mainnet.g.alchemy.com/v2/kunciAlchemy123');
  assert.strictEqual(cfg.chain.endpoints[1].headers['x-api-key'], 'kunciHeader');
  assert.deepStrictEqual(meta.missing, []);
  assert.strictEqual(envName(cfg, 'telegram.bot_token'), 'LPCOPY_TELEGRAM_BOT_TOKEN');
  assert.strictEqual(envName(cfg, 'notify.ntfy_topic'), null);
  assert.ok(!JSON.stringify(cfg).includes('__'), 'catatan .env tidak boleh ikut terserialisasi');
});

test('applyEnv: variabel RPC yang tidak ada dilaporkan, URL dibiarkan', () => {
  const cfg = baseCfg();
  const meta = applyEnv(cfg, {});
  assert.deepStrictEqual(meta.missing.sort(), ['ALCHEMY_KEY', 'RPC_KEY']);
  assert.match(cfg.chain.endpoints[1].url, /\$\{ALCHEMY_KEY\}/);
});

test('cfgForDisk: rahasia dari .env tidak ikut tertulis, perubahan lain tetap', () => {
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, ALCHEMY_KEY: 'kunciAlchemy123', RPC_KEY: 'kunciHeader' });
  cfg.gas.price_multiplier = 2;                      // perubahan biasa dari dasbor
  cfg.telegram.chat_ids.push('77');                  // chat baru tersambung
  // daftar RPC diubah dari dasbor: urutan dibalik + endpoint baru. Endpoint lama
  // membawa URL yang sudah terisi (seperti rute POST /api/settings/rpc).
  cfg.chain.endpoints = [cfg.chain.endpoints[1], cfg.chain.endpoints[0], { url: 'https://baru.test' }];
  const disk = JSON.stringify(cfgForDisk(cfg));
  for (const rahasia of ['token-dari-env', TG, 'kunciAlchemy123', 'kunciHeader']) assert.ok(!disk.includes(rahasia), `${rahasia} bocor ke disk`);
  const d = JSON.parse(disk);
  assert.strictEqual(d.server.auth_token, 'token-lama-di-config', 'nilai asli berkas dikembalikan');
  assert.strictEqual(d.telegram.bot_token, null);
  assert.strictEqual(d.gas.price_multiplier, 2);
  assert.deepStrictEqual(d.telegram.chat_ids, ['42', '77']);
  assert.strictEqual(d.chain.endpoints[0].url, 'https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}');
  assert.strictEqual(d.chain.endpoints[0].headers['x-api-key'], '${RPC_KEY}');
  assert.strictEqual(d.chain.endpoints[2].url, 'https://baru.test');
  // objek di memori tetap memakai nilai .env
  assert.strictEqual(cfg.telegram.bot_token, TG);
});

test('writeCfg: berkas 600 dan bebas rahasia', () => {
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_TELEGRAM_BOT_TOKEN: TG });
  const f = path.join(tmp(), 'config.json');
  writeCfg(f, cfg);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(TG));
});

// ---- halaman Pengaturan ------------------------------------------------------
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

test('pengaturan: kolom dari .env dikunci, dasbor diberi tahu dari mana', async () => {
  const dir = tmp();
  const cfg = baseCfg();
  applyEnv(cfg, { LPCOPY_AUTH_TOKEN: 'token-dari-env', LPCOPY_TELEGRAM_BOT_TOKEN: TG, LPCOPY_NTFY_TOPIC: 'topik-rahasia', LPCOPY_GMGN_API_KEY: 'gmgnKeyRahasia123' });
  const { call, cfgPath } = routes(cfg, dir);
  const g = await call('GET /api/settings');
  assert.strictEqual(g.telegram.fromEnv, 'LPCOPY_TELEGRAM_BOT_TOKEN');
  assert.strictEqual(g.notify.fromEnv, 'LPCOPY_NTFY_TOPIC');
  assert.strictEqual(g.gmgn.fromEnv, 'LPCOPY_GMGN_API_KEY');
  assert.ok(g.gmgn.hasKey && !JSON.stringify(g).includes('gmgnKeyRahasia123'), 'API key GMGN tidak boleh sampai ke browser');
  assert.match((await call('POST /api/settings/gmgn', { api_key: 'lain12345' })).error, /LPCOPY_GMGN_API_KEY/);
  assert.strictEqual(g.authFromEnv, 'LPCOPY_AUTH_TOKEN');
  assert.ok(!JSON.stringify(g).includes(TG), 'token bot tidak boleh sampai ke browser');
  assert.match((await call('POST /api/settings/telegram', { bot_token: '987654321:AAHtokenLainYangPanjangSekaliAbc' })).error, /LPCOPY_TELEGRAM_BOT_TOKEN/);
  assert.match((await call('POST /api/settings/token/rotate')).error, /LPCOPY_AUTH_TOKEN/);
  assert.match((await call('POST /api/settings/notify', { ntfy_topic: 'lain' })).error, /LPCOPY_NTFY_TOPIC/);
  assert.strictEqual(cfg.telegram.bot_token, TG, 'token tidak berubah');
  // pengaturan lain tetap bisa disimpan, dan menyimpannya tidak membocorkan rahasia
  const r = await call('POST /api/settings/telegram', { notify: { info: true } });
  assert.ok(r.ok, JSON.stringify(r));
  const disk = fs.readFileSync(cfgPath, 'utf8');
  for (const rahasia of ['token-dari-env', TG, 'topik-rahasia', 'gmgnKeyRahasia123']) assert.ok(!disk.includes(rahasia), `${rahasia} bocor ke config.json`);
  assert.strictEqual(JSON.parse(disk).telegram.notify.info, true);
});

test('pengaturan: API key GMGN disimpan ke config.json, ditampilkan tersamar, bisa dilepas', async () => {
  const dir = tmp();
  const cfg = baseCfg();
  const { call, cfgPath } = routes(cfg, dir);
  assert.match((await call('POST /api/settings/gmgn', { api_key: 'x y' })).error, /tidak dikenali/);
  const r = await call('POST /api/settings/gmgn', { api_key: '  gmgn_abcdef123456  ' });
  assert.ok(r.ok && r.gmgn.hasKey && r.gmgn.key.startsWith('gmgn_a') && !r.gmgn.key.includes('123456'), JSON.stringify(r));
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).gmgn.api_key, 'gmgn_abcdef123456');
  assert.match((await call('POST /api/settings/gmgn/test')).error, /pasar/i, 'tanpa modul pasar dijelaskan');
  const rm = await call('POST /api/settings/gmgn', { api_key: '' });
  assert.ok(rm.ok && !rm.gmgn.hasKey);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).gmgn.api_key, null);
});

test('pengaturan: kunci privat dari .env menonaktifkan ganti/lepas wallet', async () => {
  const dir = tmp();
  await withEnv({ LPCOPY_PRIVATE_KEY: `0x${'2'.repeat(64)}` }, async () => {
    const { call } = routes(baseCfg(), dir);
    const g = await call('GET /api/settings');
    assert.strictEqual(g.wallet.fromEnv, 'LPCOPY_PRIVATE_KEY');
    assert.strictEqual(g.wallet.hasKey, true);
    for (const k of ['POST /api/settings/wallet/generate', 'POST /api/settings/wallet/import', 'POST /api/settings/wallet/remove']) {
      assert.match((await call(k, { privateKey: `0x${'3'.repeat(64)}`, replace: true })).error, /LPCOPY_PRIVATE_KEY/, k);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'key')), 'berkas kunci tidak boleh dibuat');
  });
});

(async () => {
  let ok = 0, bad = 0;
  for (const [n, f] of tests) {
    try { await f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.message); }
  }
  console.log(`\n${ok} lulus, ${bad} gagal`);
  process.exit(bad ? 1 : 0);
})();
