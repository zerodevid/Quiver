'use strict';
// Tests: swap aggregators (src/aggregators/*, src/swaprouter.js) and their settings routes.
//
// What must hold: each adapter speaks its API correctly (signing, native-token sentinel,
// parameters) and maps the reply into one quote shape; nothing is sent unless the router is
// whitelisted, the amounts match, the approval is exact and the eth_call dry run passes;
// best-route mode executes the highest quote and falls through to the next one only when no
// tokens can have moved; settings save keys without ever returning them whole.
//
// Run: node test/aggregators.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Okx, sign } = require('../src/aggregators/okx');
const { Lifi } = require('../src/aggregators/lifi');
const { ZeroX } = require('../src/aggregators/zerox');
const { OneInch } = require('../src/aggregators/oneinch');
const { OpenOcean } = require('../src/aggregators/openocean');
const { SwapRouter } = require('../src/swaprouter');
const { ADDR } = require('../src/chain');
const { build } = require('../src/networks');

const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const OTHER = '0x' + '99'.repeat(20);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const hex32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const KEYS = { okx: { api_key: 'k', secret_key: 's3cret', passphrase: 'p' }, zerox: { api_key: 'zx' }, oneinch: { api_key: 'oi' }, openocean: { api_key: 'oo' } };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

// Fake wallet + RPC shared by every adapter test. `o` shapes the chain side.
function chainWorld(o = {}) {
  const sent = [], calls = [];
  const exec = {
    address: () => ME,
    send: async (tx, meta) => { sent.push({ tx, meta }); return '0x' + String(sent.length).padStart(64, 'a'); },
    waitReceipt: async () => (o.reverted ? { ok: false } : {
      ok: true, receipt: { logs: [{ address: MEME, topics: [XFER, topicAddr(OTHER), topicAddr(o.receiver ?? ME)], data: hex32(o.got ?? 5000n) }] },
    }),
    balances: async () => new Map([[MEME, 0n]]),
    noteTx: () => {},
  };
  const rpc = {
    ethCallMany: async () => [hex32(o.allowance ?? 0n)],
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (o.simRevert) throw new Error('execution reverted');
      return o.simRaw ?? hex32(o.simOut ?? 5000n);
    },
  };
  return { exec, rpc, sent, calls };
}
// One adapter against a fake API: `reply(url, headers)` returns the JSON body.
function adapter(Cls, reply, o = {}) {
  const w = chainWorld(o);
  const http = [];
  const fetch = async (url, init) => {
    http.push({ url: String(url), headers: init.headers });
    const r = reply(new URL(url), init.headers);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  const cfg = { aggregators: { ...KEYS, ...(o.agg || {}) } };
  const a = new Cls({ exec: w.exec, rpc: w.rpc, cfg, chain: o.chain, log: () => {}, fetch, minGapMs: 0 });
  return { a, http, ...w };
}

// ---- canned API replies -------------------------------------------------------
const okxRouter = Okx.ROUTERS[4663][0];
const okxReply = (o = {}) => (u) => {
  const rr = {
    fromTokenAmount: String(o.fromAmount ?? 1000n), toTokenAmount: String(o.out ?? 5000n),
    fromToken: { tokenUnitPrice: '1', decimal: '6' }, toToken: { tokenUnitPrice: '0.0002', decimal: '0', isHoneyPot: !!o.honeypot },
    dexRouterList: [{ dexProtocol: { dexName: 'Uniswap V4' } }],
  };
  if (u.pathname.endsWith('/quote')) return { body: { code: '0', data: [rr] } };
  return { body: { code: '0', data: [{ routerResult: rr, tx: { to: o.to ?? okxRouter, from: ME, data: '0xabcdef', value: o.value ?? '0', minReceiveAmount: String(o.min ?? 4950n) } }] } };
};

(async () => {
  console.log('adapters:');

  await t('OKX: HMAC signature over timestamp + method + path?query', async () => {
    const { a, http } = adapter(Okx, okxReply());
    await a.quote(ADDR.native, MEME, 10n ** 15n);
    const c = http[0], u = new URL(c.url);
    assert.equal(u.searchParams.get('chainIndex'), '4663');
    assert.equal(u.searchParams.get('fromTokenAddress'), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    const want = crypto.createHmac('sha256', 's3cret').update(c.headers['OK-ACCESS-TIMESTAMP'] + 'GET' + u.pathname + u.search).digest('base64');
    assert.equal(c.headers['OK-ACCESS-SIGN'], want);
    assert.equal(sign({ secret: 'x', timestamp: 't', method: 'GET', path: '/p' }), crypto.createHmac('sha256', 'x').update('tGET/p').digest('base64'));
  });

  await t('OKX: happy path — exact approve, dry run, send to router, output measured', async () => {
    const { a, sent, calls } = adapter(Okx, okxReply());
    const r = await a.swap(ADDR.usdg, MEME, 1000n);
    assert.equal(r.amountOut, 5000n);
    assert.equal(r.quote.aggregator, 'okx');
    assert.equal(r.quote.dex, 'OKX: Uniswap V4');
    const [approve, swap] = sent;
    assert.ok(approve.tx.data.includes(Okx.APPROVE[4663].slice(2)));
    assert.ok(approve.tx.data.endsWith(hex32(1000n).slice(2)), 'approval is exactly amountIn');
    assert.equal(swap.tx.to.toLowerCase(), okxRouter);
    assert.equal(swap.meta.detail.aggregator, 'okx');
    assert.ok(calls.some((c) => c.method === 'eth_call' && c.params[0].from === ME));
  });

  await t('guards: unknown router, wrong amount, ETH value, low minimum — nothing sent', async () => {
    for (const [o, re] of [[{ to: OTHER }, /tidak dikenal/], [{ fromAmount: 999n }, /jumlah bayar/], [{ value: '5' }, /nilai ETH/], [{ min: 10n }, /minimum terima/]]) {
      const w = adapter(Okx, okxReply(o), { allowance: 10n ** 30n });
      await assert.rejects(w.a.swap(ADDR.usdg, MEME, 1000n), re);
      assert.equal(w.sent.length, 0, String(re));
    }
  });

  await t('dry run reverts / returns too little; output paid elsewhere; honeypot', async () => {
    let w = adapter(Okx, okxReply(), { allowance: 10n ** 30n, simRevert: true });
    await assert.rejects(w.a.swap(ADDR.usdg, MEME, 1000n), /simulasi/);
    assert.equal(w.sent.length, 0);
    w = adapter(Okx, okxReply(), { allowance: 10n ** 30n, simOut: 10n });
    await assert.rejects(w.a.swap(ADDR.usdg, MEME, 1000n), /simulasi OKX: hasil/);
    w = adapter(Okx, okxReply(), { allowance: 10n ** 30n, receiver: OTHER });
    await assert.rejects(w.a.swap(ADDR.usdg, MEME, 1000n), /tidak masuk ke wallet kita/);
    w = adapter(Okx, okxReply({ honeypot: true }));
    assert.equal(await w.a.quote(ADDR.usdg, MEME, 1000n), null);
  });

  await t('rate limit: retried once, then a 60 s cooldown', async () => {
    let n = 0;
    const { a } = adapter(Okx, () => { n++; return { body: { code: '50011', msg: 'Too Many Requests' } }; });
    assert.equal(await a.quote(ADDR.usdg, MEME, 1n), null);
    assert.equal(n, 2);
    assert.equal(await a.quote(ADDR.usdg, MEME, 2n), null);
    assert.equal(n, 2, 'no request during the cooldown');
  });

  await t('LI.FI: keyless, native as 0x0, Diamond whitelist, approval must be the Diamond', async () => {
    const diamond = Lifi.ROUTERS[4663][0];
    const reply = (appr) => (u) => ({ body: {
      tool: 'nordstern', toolDetails: { name: 'Nordstern Finance' },
      action: { fromAmount: u.searchParams.get('fromAmount') },
      estimate: { fromAmount: u.searchParams.get('fromAmount'), toAmount: '5000', toAmountMin: '4950', approvalAddress: appr, fromAmountUSD: '10', toAmountUSD: '9.9' },
      transactionRequest: { to: diamond, from: ME, data: '0x1234', value: '0x0' },
    } });
    const w = adapter(Lifi, reply(diamond), { agg: { lifi: {} } });
    assert.equal(w.a.enabled(), true, 'no key needed');
    const q = await w.a.quote(ADDR.native, MEME, 1000n);
    assert.equal(q.amountOut, 5000n);
    assert.equal(q.dex, 'LI.FI: Nordstern Finance');
    assert.equal(new URL(w.http[0].url).searchParams.get('fromToken'), ADDR.native);
    assert.equal(w.http[0].headers['x-lifi-api-key'], undefined);
    const r = await w.a.swap(ADDR.usdg, MEME, 1000n);
    assert.equal(r.amountOut, 5000n);
    assert.ok(w.sent[0].tx.data.includes(diamond.slice(2)), 'approve to the Diamond');
    const bad = adapter(Lifi, reply(OTHER), { agg: { lifi: {} } });
    await assert.rejects(bad.a.swap(ADDR.usdg, MEME, 1000n), /bukan Diamond/);
    assert.equal(bad.sent.length, 0);
  });

  await t('0x: key header, v2, AllowanceHolder as router and spender', async () => {
    const ah = ZeroX.ROUTERS[4663][0];
    const w = adapter(ZeroX, (u, h) => {
      assert.equal(h['0x-api-key'], 'zx'); assert.equal(h['0x-version'], 'v2');
      return { body: { liquidityAvailable: true, buyAmount: '5000', minBuyAmount: '4950', sellAmount: u.searchParams.get('sellAmount'),
        route: { fills: [{ source: 'Uniswap_V4' }] }, issues: { allowance: { spender: ah } },
        transaction: { to: ah, data: '0x99', value: '0' } } };
    });
    const r = await w.a.swap(ADDR.usdg, MEME, 1000n);
    assert.equal(r.amountOut, 5000n);
    assert.ok(w.sent[0].tx.data.includes(ah.slice(2)));
    assert.equal(adapter(ZeroX, () => ({ body: {} }), { agg: { zerox: {} } }).a.enabled(), false, 'off without a key');
    const none = adapter(ZeroX, () => ({ body: { liquidityAvailable: false } }));
    assert.equal(await none.a.quote(ADDR.usdg, MEME, 1000n), null);
  });

  await t('1inch: Bearer key; no API minimum, so the dry-run amount decides', async () => {
    const router = OneInch.ROUTERS[4663][0];
    const reply = () => ({ body: { dstAmount: '5000', protocols: [[[{ name: 'UNISWAP_V3' }]]], tx: { to: router, from: ME, data: '0x42', value: '0' } } });
    let w = adapter(OneInch, reply);
    assert.equal((await w.a.quote(ADDR.usdg, MEME, 1000n)).dex, '1inch: UNISWAP_V3');
    assert.equal(w.http[0].headers.Authorization, 'Bearer oi');
    assert.equal((await w.a.swap(ADDR.usdg, MEME, 1000n)).amountOut, 5000n);
    w = adapter(OneInch, reply, { simOut: 100n, allowance: 10n ** 30n });
    await assert.rejects(w.a.swap(ADDR.usdg, MEME, 1000n), /simulasi 1inch/);
    assert.equal(w.sent.length, 0);
  });

  await t('OpenOcean: pro host with apikey header, raw amounts', async () => {
    const router = OpenOcean.ROUTERS[4663][0];
    const w = adapter(OpenOcean, (u, h) => {
      assert.equal(u.host, 'open-api-pro.openocean.finance'); assert.equal(h.apikey, 'oo');
      assert.equal(u.searchParams.get('amountDecimals'), '1000');
      return { body: { code: 200, data: { inAmount: '1000', outAmount: '5000', minOutAmount: '4950', to: router, data: '0x77', value: '0', dexes: [{ dexCode: 'UniV3', swapAmount: '1' }] } } };
    });
    assert.equal((await w.a.swap(ADDR.usdg, MEME, 1000n)).amountOut, 5000n);
  });

  await t('every adapter is on for Robinhood and BSC, off for an unknown chain', async () => {
    for (const C of [Okx, Lifi, ZeroX, OneInch, OpenOcean]) {
      assert.equal(adapter(C, () => ({ body: {} })).a.enabled(), true, `${C.name} 4663`);
      assert.equal(adapter(C, () => ({ body: {} }), { chain: build('bsc') }).a.enabled(), true, `${C.name} 56`);
      assert.equal(adapter(C, () => ({ body: {} }), { chain: { ...build('bsc'), CHAIN_ID: 999 } }).a.blocker(), 'chain ini belum didukung');
    }
  });

  console.log('\nSwapRouter:');
  // Stub aggregators: quote amount, swap behaviour.
  const stub = (id, amount, behaviour = 'ok') => {
    const s = { id, label: id.toUpperCase(), swaps: 0, enabled: () => true, blocker: () => null, supportsChain: () => true,
      quote: async () => (amount == null ? null : { amountOut: amount, aggregator: id }),
      swap: async () => {
        s.swaps++;
        if (behaviour === 'ok') return { hash: `0x${id}`, quote: { aggregator: id } };
        if (behaviour === 'none') return null;
        const e = new Error(behaviour);
        if (behaviour === 'loss') e.loss = { lossBps: 900 };
        if (behaviour === 'reverted') { e.reverted = true; e.txHash = '0xr'; }
        if (behaviour === 'pending') e.pending = true;
        if (behaviour === 'landed') e.txHash = '0xl';
        throw e;
      } };
    return s;
  };
  const routerOf = (adapters, agg = {}) => new SwapRouter({ cfg: { aggregators: agg }, adapters, log: () => {} });

  await t('best mode: the highest quote executes; ties go to the configured order', async () => {
    const k = stub('kyber', 100n), o = stub('okx', 130n), l = stub('lifi', 120n);
    const r = routerOf([k, o, l]);
    assert.equal((await r.quote(ADDR.usdg, MEME, 1n)).aggregator, 'okx');
    assert.equal((await r.swap(ADDR.usdg, MEME, 1n)).hash, '0xokx');
    assert.equal(k.swaps + l.swaps, 0);
    const tie = routerOf([stub('kyber', 5n), stub('okx', 5n)], { order: ['okx', 'kyber'] });
    assert.equal((await tie.quote(ADDR.usdg, MEME, 1n)).aggregator, 'okx');
  });

  await t('best mode: falls through on no-route / loss / revert, in quote order', async () => {
    const o = stub('okx', 130n, 'none'), l = stub('lifi', 120n, 'loss'), z = stub('zerox', 110n, 'reverted'), k = stub('kyber', 100n);
    const r = await routerOf([k, o, l, z]).swap(ADDR.usdg, MEME, 1n);
    assert.equal(r.hash, '0xkyber');
    assert.deepEqual([o.swaps, l.swaps, z.swaps, k.swaps], [1, 1, 1, 1]);
  });

  await t('scan: one row per aggregator in order — ok, noroute and off with the reason', async () => {
    const off = { ...stub('okx', 1n), enabled: () => false, blocker: () => 'butuh API key' };
    const rows = await routerOf([stub('kyber', 100n), off, stub('lifi', null)]).scan(ADDR.usdg, MEME, 1n);
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [['kyber', 'ok'], ['okx', 'off'], ['lifi', 'noroute']]);
    assert.equal(rows[1].blocker, 'butuh API key');
    assert.equal(rows[0].q.amountOut, 100n);
  });

  await t('only: swaps through the chosen aggregator alone, never falls back', async () => {
    const k = stub('kyber', 100n), o = stub('okx', 130n, 'loss'), l = stub('lifi', 120n);
    const r = routerOf([k, o, l]);
    assert.equal((await r.swap(ADDR.usdg, MEME, 1n, { only: 'lifi' })).hash, '0xlifi');
    assert.equal(k.swaps + o.swaps, 0);
    await assert.rejects(r.swap(ADDR.usdg, MEME, 1n, { only: 'okx' }), (e) => !!e.loss);
    assert.equal(k.swaps + l.swaps, 1);
    const off = { ...stub('zerox', 1n), enabled: () => false, blocker: () => 'dimatikan' };
    await assert.rejects(routerOf([k, off]).swap(ADDR.usdg, MEME, 1n, { only: 'zerox' }), /tidak aktif/);
    await assert.rejects(r.swap(ADDR.usdg, MEME, 1n, { only: 'nope' }), /tidak dikenal/);
  });

  await t('Swap page quote: auto = best route inside the loss limit; a chosen one is shown as is', async () => {
    const { Manual } = require('../src/manual');
    const q = (out, usdOut) => ({ amountOut: BigInt(out), usdIn: 100, usdOut, dex: 'x' });
    const rows = [
      { id: 'kyber', label: 'Kyber', state: 'ok', q: q(100e6, 90), ms: 5 },       // most output, 10% loss
      { id: 'okx', label: 'OKX', state: 'ok', q: q(95e6, 99), ms: 6 },           // 1% loss
      { id: 'lifi', label: 'LI.FI', state: 'off', blocker: 'butuh API key', q: null, ms: null },
      { id: 'zerox', label: '0x', state: 'noroute', q: null, ms: 7 },
    ];
    const fake = { engine: { kyber: { scan: async () => rows }, ethUsd: 2500,
      rulesFrom: () => ({ exit: { sell_max_loss_bps: 300 }, swap: { max_slippage_bps: 100 } }) },
    chain: { tokens: async (l) => l.map(() => ({ symbol: 'X', decimals: 6 })), QUOTES: {} } };
    const quote = (aggregator) => Manual.prototype.quoteSwap.call(fake, { tokenIn: ME, tokenOut: MEME, amountRaw: 100n, aggregator });
    const auto = await quote('auto');
    assert.equal(auto.chosen, 'okx');
    assert.equal(auto.tooLossy, false);
    assert.deepEqual(auto.routes.map((r) => [r.id, r.state, r.best]), [['kyber', 'ok', false], ['okx', 'ok', true], ['lifi', 'off', false], ['zerox', 'noroute', false]]);
    assert.ok(!auto.routes.some((r) => 'q' in r), 'raw quotes stay on the server');
    const kyber = await quote('kyber');
    assert.equal(kyber.chosen, 'kyber');
    assert.equal(kyber.tooLossy, true);
    assert.match((await quote('lifi')).error, /butuh API key/);
    assert.match((await quote('zerox')).error, /tidak menemukan rute/);
    fake.engine.kyber.scan = async () => rows.map((r) => ({ ...r, state: 'noroute', q: null }));
    assert.match((await quote('auto')).error, /Tidak ada agregator/);
  });

  await t('never a second swap after a tx that may have moved tokens', async () => {
    for (const b of ['pending', 'landed']) {
      const k = stub('kyber', 100n);
      await assert.rejects(routerOf([stub('okx', 130n, b), k]).swap(ADDR.usdg, MEME, 1n));
      assert.equal(k.swaps, 0, b);
    }
  });

  await t('all fail: the loss error wins (engine can try a direct pool); no quotes: null', async () => {
    await assert.rejects(routerOf([stub('okx', 130n, 'guard failed'), stub('lifi', 120n, 'loss')]).swap(ADDR.usdg, MEME, 1n), (e) => !!e.loss);
    assert.equal(await routerOf([stub('okx', null), stub('lifi', null)]).swap(ADDR.usdg, MEME, 1n), null);
  });

  await t('order mode: tried in the configured order without comparing', async () => {
    const k = stub('kyber', 100n, 'none'), o = stub('okx', 130n), l = stub('lifi', 999n);
    const r = routerOf([k, o, l], { mode: 'order', order: ['kyber', 'okx', 'lifi'] });
    assert.equal((await r.swap(ADDR.usdg, MEME, 1n)).hash, '0xokx');
    assert.equal(l.swaps, 0);
    assert.equal((await r.quote(ADDR.usdg, MEME, 1n)).aggregator, 'kyber');
  });

  await t('switched-off aggregators are neither quoted nor used', async () => {
    const o = stub('okx', 999n); o.enabled = () => false;
    assert.equal((await routerOf([stub('kyber', 1n), o]).swap(ADDR.usdg, MEME, 1n)).hash, '0xkyber');
    assert.equal(o.swaps, 0);
  });

  console.log('\nsettings routes:');
  const { createSettingsRoutes } = require('../src/settings');
  const { applyEnv } = require('../src/env');
  const routesWith = (env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-agg-'));
    const cfg = { server: { port: 1 }, chain: { endpoints: [] }, aggregators: { lifi: { enabled: false } } };
    applyEnv(cfg, env);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{}');
    const chain = build('robinhood');
    const engine = { dryRun: () => true, exec: { address: () => ME }, chain };
    engine.kyber = new SwapRouter({ exec: engine.exec, rpc: {}, cfg, chain, log: () => {} });
    const r = createSettingsRoutes({ engine, cfg, cfgPath, chain, store: { setState() {}, getState: () => null }, rpc: { stats: () => [] }, log: () => {}, readBody: async (req) => req.__body });
    const call = (k, body) => r[k]({ __body: body, headers: {} }, new URL('http://x/'), {});
    return { call, cfg, cfgPath, engine };
  };

  await t('save mode, order, switch and keys; keys come back masked only; applied live', async () => {
    const w = routesWith();
    let r = await w.call('POST /api/settings/aggregators', { mode: 'order', order: ['okx', 'kyber', 'lifi', 'zerox', 'oneinch', 'openocean'] });
    assert.equal(r.aggregators.mode, 'order');
    assert.equal(r.aggregators.order[0], 'okx');
    r = await w.call('POST /api/settings/aggregators', { id: 'zerox', keys: { api_key: 'zx-secret-key-123' } });
    const zx = r.aggregators.items.find((x) => x.id === 'zerox');
    assert.equal(zx.active, true);
    assert.ok(!JSON.stringify(r).includes('zx-secret-key-123'), 'key must not come back whole');
    assert.equal(zx.fields[0].masked, 'zx-s••••');
    assert.equal(w.engine.kyber.byId.get('zerox').enabled(), true, 'live without restart');
    r = await w.call('POST /api/settings/aggregators', { id: 'lifi', enabled: true });
    assert.equal(r.aggregators.items.find((x) => x.id === 'lifi').active, true);
    r = await w.call('POST /api/settings/aggregators', { id: 'zerox', keys: { api_key: '' } });
    assert.equal(r.aggregators.items.find((x) => x.id === 'zerox').blocker, 'butuh API key');
    const disk = JSON.parse(fs.readFileSync(w.cfgPath, 'utf8'));
    assert.equal(disk.aggregators.mode, 'order');
    assert.equal(disk.aggregators.zerox.api_key, undefined);
    assert.match((await w.call('POST /api/settings/aggregators', { mode: 'x' })).error, /best atau order/);
    assert.match((await w.call('POST /api/settings/aggregators', { id: 'nope' })).error, /tidak dikenal/);
  });

  await t('keys from .env: shown as such, cannot be edited, never written to config.json', async () => {
    const w = routesWith({ OKX_API_KEY: 'ek', OKX_SECRET_KEY: 'es', OKX_API_PASSPHRASE: 'ep' });
    const okx = (await w.call('POST /api/settings/aggregators', {})).aggregators.items.find((x) => x.id === 'okx');
    assert.equal(okx.active, true);
    assert.equal(okx.fields.find((f) => f.name === 'api_key').fromEnv, 'OKX_API_KEY');
    assert.match((await w.call('POST /api/settings/aggregators', { id: 'okx', keys: { api_key: 'x' } })).error, /OKX_API_KEY/);
    const disk = fs.readFileSync(w.cfgPath, 'utf8');
    assert.ok(!/"ek"|"es"|"ep"/.test(disk), 'env secrets leaked into config.json');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
