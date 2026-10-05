'use strict';
// QA test 13 Sep: every case here is derived from a REAL production failure (the
// decisions/txs/logs tables of lpcopy & lpcopy2) or from a gap found during the audit of the
// entry/exit flow. Only the outer boundaries are faked (RPC, chain, Kyber); the engine,
// executor, and kyber logic is the real code.
//
// Run: node test/qa-entry-exit.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Engine } = require('../src/engine');
const { Executor } = require('../src/executor');
const { Kyber } = require('../src/kyber');
const { Compound } = require('../src/compound');
const { Chain } = require('../src/pools');
const { Store } = require('../src/db');
const { ADDR, ABI, TOPIC } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native, WETH = ADDR.weth;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const IF_NPM = new ethers.Interface(ABI.npmV3);
const pad = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const addrTopic = (a) => '0x' + a.slice(2).padStart(64, '0');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// ---- executor with a fake RPC --------------------------------------------
function executor({ estimate, send, count = () => '0x5', landed = () => null, fees = true } = {}) {
  const logs = [];
  const store = new Store(':memory:');
  const rpc = {
    call: async (method, params) => {
      if (method === 'eth_getTransactionCount') return count();
      if (method === 'eth_estimateGas') return estimate(params[0]);
      if (method === 'eth_sendRawTransaction') return send(params[0]);
      if (method === 'eth_getTransactionByHash') return landed(params[0]);
      return null;
    },
  };
  const ex = new Executor({ rpc, store, chain: null, cfg: { gas: {} }, log: (s) => logs.push(s) });
  const w = ethers.Wallet.createRandom();
  ex.loadWallet = () => w;
  if (fees) ex.gasFees = async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  ex.retryWaits = [0, 0];
  ex.txLanded = async (h, tries) => !!(await rpc.call('eth_getTransactionByHash', [h]));
  return { ex, logs, store };
}
const nonceOf = (raw) => ethers.Transaction.from(raw).nonce;

(async () => {
  console.log('QA entry/exit flow:\n');

  // ---------------------------------------------------------------- executor
  await t('gas estimate reverting right after an approval (lagging node) is retried, then sent', async () => {
    let n = 0; const raws = [];
    const { ex } = executor({
      estimate: () => { n++; if (n < 3) throw new Error('execution reverted: STF'); return '0x5208'; },
      send: (raw) => { raws.push(raw); return ethers.keccak256(raw); },
    });
    const h = await ex.send({ to: MEME, data: '0x' }, { kind: 'mint' });
    assert.ok(h.startsWith('0x'));
    assert.strictEqual(n, 3, 'two fake reverts, the third passes');
    assert.strictEqual(raws.length, 1);
  });

  await t('an estimate reverting because of PRICE is not retried (the Kyber layer re-quotes)', async () => {
    let n = 0;
    const { ex } = executor({ estimate: () => { n++; throw new Error('execution reverted: Return amount is not enough'); }, send: () => '0x' });
    await assert.rejects(ex.send({ to: MEME, data: '0x' }, { kind: 'zap_swap' }), /estimasi gas gagal.*Return amount/);
    assert.strictEqual(n, 1);
  });

  await t('a real revert still fails after bounded retries', async () => {
    let n = 0;
    const { ex } = executor({ estimate: () => { n++; throw new Error('execution reverted: STF'); }, send: () => '0x' });
    await assert.rejects(ex.send({ to: MEME, data: '0x' }), /estimasi gas gagal/);
    assert.strictEqual(n, 3);
  });

  await t('"nonce too low" (nonce read from a lagging node / another bot on the same wallet) → nonce re-synced, sent', async () => {
    // Case #32, 10 Sep 18:20: "nonce too low: tx: 131 state: 132" → the $200 entry was cancelled.
    let counts = ['0x83', '0x84'], sends = [];
    const { ex } = executor({
      estimate: () => '0x5208',
      count: () => counts.shift() || '0x84',
      send: (raw) => { sends.push(nonceOf(raw)); if (nonceOf(raw) === 131) throw new Error('nonce too low: address x, tx: 131 state: 132'); return ethers.keccak256(raw); },
    });
    const h = await ex.send({ to: MEME, data: '0x' }, { kind: 'mint' });
    assert.ok(h);
    assert.deepStrictEqual(sends, [131, 132]);
    assert.strictEqual(ex.nonce, 133);
  });

  await t('an ordinary send error: the nonce is NOT released — resend uses the same nonce (at most one lands)', async () => {
    const sends = []; let fails = 1;
    const { ex } = executor({
      estimate: () => '0x5208', count: () => '0x7',
      send: (raw) => { sends.push(nonceOf(raw)); if (fails-- > 0) throw new Error('timeout'); return ethers.keccak256(raw); },
    });
    await assert.rejects(ex.send({ to: MEME, data: '0x' }), /timeout/);
    // pending on another node has moved on (the first tx is actually in that node's mempool) — still our nonce
    await ex.send({ to: MEME, data: '0x' });
    assert.deepStrictEqual(sends, [7, 7]);
  });

  await t('nonce used by OUR own tx that was thought not to have landed → not resent (prevents a double mint)', async () => {
    const hashes = []; let first = true; const landedSet = new Set();
    const { ex } = executor({
      estimate: () => '0x5208', count: () => '0x9',
      send: (raw) => {
        const h = ethers.keccak256(raw); hashes.push(h);
        if (first) { first = false; throw new Error('timeout'); }
        throw new Error('nonce too low: tx: 9 state: 10');
      },
      landed: (h) => (landedSet.has(h) ? { hash: h } : null),
    });
    await assert.rejects(ex.send({ to: MEME, data: '0x01' }), /timeout/);
    landedSet.add(hashes[0]);   // the first tx actually landed later
    // a retry tx from the upper layer (plan recomputed → different calldata, same nonce)
    const e = await ex.send({ to: MEME, data: '0x02' }).catch((x) => x);
    assert.ok(e instanceof Error);
    assert.strictEqual(e.priorLanded, hashes[0]);
    assert.strictEqual(hashes.length, 2, 'no third signature');
  });

  // ---------------------------------------------------------------- kyber
  const kyberWith = ({ receipts }) => {
    const sent = [];
    const exec = {
      address: () => ME,
      send: async (tx, meta) => { sent.push(meta.kind); return '0x' + String(sent.length).padStart(64, '0'); },
      waitReceipt: async () => receipts.shift(),
      balances: async () => new Map([[MEME, 0n]]),
    };
    const k = new Kyber({ exec, rpc: { ethCallMany: async () => [pad(10n ** 30n)] }, cfg: {}, log: () => {} });
    k.quote = async () => ({ routeSummary: {}, routerAddress: k.router(), amountOut: 1000n, usdIn: 1, usdOut: 1, dex: 'uji' });
    // real calldata (MetaAggregationRouterV2 swap): the calldata safeguard decodes it
    const DESC = 'tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit)';
    const IFK = new ethers.Interface([`function swap(tuple(address callTarget,address approveTarget,bytes targetData,${DESC} desc,bytes clientData) execution)`]);
    const data = IFK.encodeFunctionData('swap', [[ME, ME, '0x', [USDG, MEME, [], [], [], [], ME, 100n, 980n, 0, '0x'], '0x']]);
    k.build = async () => ({ routerAddress: k.router(), transactionValue: '0', amountIn: '100', amountOut: '1000', data });
    return { k, sent };
  };

  await t('a Kyber swap that REVERTED on chain is retried with a fresh quote (#154 12 Sep: zap cancelled although a route existed)', async () => {
    const { k, sent } = kyberWith({ receipts: [{ ok: false, receipt: {} }, { ok: true, receipt: { logs: [] } }] });
    const r = await k.swap(USDG, MEME, 100n, { slippageBps: 100, kind: 'zap_swap' });
    assert.ok(r && r.hash);
    assert.deepStrictEqual(sent, ['zap_swap', 'zap_swap']);
  });

  await t('a Kyber swap whose receipt is not yet readable is NOT retried (could swap twice)', async () => {
    const { k, sent } = kyberWith({ receipts: [{ ok: false, timeout: true }, { ok: true, receipt: { logs: [] } }] });
    const e = await k.swap(USDG, MEME, 100n, { slippageBps: 100, kind: 'zap_swap' }).catch((x) => x);
    assert.ok(e.pending, e.message);
    assert.deepStrictEqual(sent, ['zap_swap']);
  });

  // ---------------------------------------------------------------- pools.tokens
  await t('token metadata that failed to be read is NOT stored permanently as 18 decimals', async () => {
    const store = new Store(':memory:');
    let bad = true;
    const rpc = { ethCallMany: async (calls, block, opts) => {
      if (bad) { if (opts?.strict) throw new Error('eth_call tidak terbaca dari RPC: 429'); return calls.map(() => null); }
      const IF = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function name() view returns (string)']);
      return calls.map((c) => {
        const sel = c.data.slice(0, 10);
        if (sel === IF.getFunction('decimals').selector) return IF.encodeFunctionResult('decimals', [9]);
        if (sel === IF.getFunction('symbol').selector) return IF.encodeFunctionResult('symbol', ['NUKE']);
        return IF.encodeFunctionResult('name', ['Nuke']);
      });
    } };
    const chain = new Chain(rpc, store, () => {});
    await assert.rejects(chain.tokens([MEME]), /tidak terbaca/);
    assert.strictEqual(store.get('SELECT * FROM tokens WHERE address=?', MEME), undefined);
    bad = false;
    const [tk] = await chain.tokens([MEME]);
    assert.strictEqual(tk.decimals, 9);
    assert.strictEqual(store.get('SELECT decimals FROM tokens WHERE address=?', MEME).decimals, 9);
  });

  // ---------------------------------------------------------------- engine: harness
  function engineWith({ balances = {}, rpc = {}, chain = {} } = {}) {
    const store = new Store(':memory:');
    store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
    const bal = new Map(Object.entries(balances).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
    const baseChain = {
      tokens: async (l) => l.map((a) => ({ address: String(a).toLowerCase(), symbol: a === USDG ? 'USDG' : 'MEME', decimals: a === USDG ? 6 : 18 })),
      token: async (a) => ({ address: a, symbol: a === USDG ? 'USDG' : 'MEME', decimals: a === USDG ? 6 : 18 }),
      quoteSideOf: (t0, t1) => (String(t0).toLowerCase() === USDG ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : String(t1).toLowerCase() === USDG ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
      ethUsd: async () => 2500,
      ...chain,
    };
    const eng = new Engine({ rpc: { ethCallMany: async (c) => c.map(() => null), call: async () => null, ...rpc }, store, chain: baseChain, cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
    eng.ethUsd = 2500;
    eng.exec.address = () => ME;
    eng.exec.balances = async (list) => new Map(list.map((x) => [String(x).toLowerCase(), bal.get(String(x).toLowerCase()) || 0n]));
    eng.notify = () => {};
    return { eng, store, bal };
  }

  await t('entry: a temporary RPC error BEFORE any swap → retried, not "failed to set up the position"', async () => {
    const { eng } = engineWith();
    eng.entryRetryWaits = [0, 0];
    let calls = 0;
    eng.sendEntry = async (plan, act, trace, { resume }) => {
      calls++;
      assert.strictEqual(resume, false, 'no zap yet: the bridge may be re-evaluated');
      if (calls === 1) throw new Error('gagal membaca saldo token 0x5fc5… dari RPC');
      return { txHash: '0xok', positionId: 1 };
    };
    const r = await eng.executeEntry({ poolRef: POOL }, {});
    assert.strictEqual(r.txHash, '0xok');
    assert.strictEqual(calls, 2);
  });

  await t('entry: an error AFTER the zap → retried with resume (without the bridge again), the zap token is not sold', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 500n } });
    eng.entryRetryWaits = [0, 0];
    const seen = [];
    eng.sendEntry = async (plan, act, trace, { resume }) => {
      seen.push(resume);
      if (!trace.zapped) { trace.zapped = { token: MEME, quote: USDG, before: 0n, hashes: [] }; trace.zaps = 1; throw new Error('estimasi gas gagal (transaksi kemungkinan akan revert): execution reverted: STF'); }
      return { txHash: '0xok', positionId: 1 };
    };
    await eng.executeEntry({ poolRef: POOL }, {});
    assert.deepStrictEqual(seen, [false, true]);
    assert.deepStrictEqual(eng.leftovers(), [], 'nothing is queued for sale');
    assert.strictEqual(store.get("SELECT COUNT(*) n FROM logs WHERE msg LIKE '%masuk antrean jual%'").n, 0);
  });

  await t('entry: the mint ALREADY succeeded then booking failed → NO second mint and the zap token is NOT sold', async () => {
    const { eng } = engineWith({ balances: { [MEME]: 500n } });
    eng.entryRetryWaits = [0, 0];
    let calls = 0;
    eng.sendEntry = async (plan, act, trace) => {
      calls++;
      trace.zapped = { token: MEME, quote: USDG, before: 0n, hashes: [] };
      trace.minted = '0xmint';
      const e = new Error('mint 0xmint berhasil tetapi pembukuan tertunda: gagal membaca harga pool');
      e.pendingMint = true; throw e;
    };
    await assert.rejects(eng.executeEntry({ poolRef: POOL }, {}), /pembukuan tertunda/);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('entry: user constraints (insufficient cash, auto-swap off, route loss) are NOT retried', async () => {
    for (const msg of ['kas kurang: butuh 10 USDG', 'kurang 5 unit token0 dan auto-swap dimatikan', 'rute Kyber rugi 11.3% (batas 9.8%)', 'eth_sendRawTransaction: insufficient funds for gas * price + value']) {
      const { eng } = engineWith();
      eng.entryRetryWaits = [0, 0];
      let calls = 0;
      eng.sendEntry = async () => { calls++; throw new Error(msg); };
      await assert.rejects(eng.executeEntry({ poolRef: POOL }, {}));
      assert.strictEqual(calls, 1, msg);
    }
  });

  await t('rescueZap: a quote token (USDG/ETH/WETH) is never queued to be "sold"', async () => {
    for (const q of [USDG, ETH, WETH]) {
      const { eng } = engineWith({ balances: { [q]: 10n ** 18n } });
      await eng.rescueZap({ target: null }, { token: q, quote: MEME, before: 0n }, new Error('x'));
      assert.deepStrictEqual(eng.leftovers(), [], q);
    }
  });

  await t('rescueZap: two failed entries on the same token → the amount is ADDED, not overwritten', async () => {
    const { eng, bal } = engineWith({ balances: { [MEME]: 300n } });
    await eng.rescueZap({ target: null }, { token: MEME, quote: USDG, before: 0n }, new Error('pertama'));
    bal.set(MEME, 800n);   // the second zap buys another 500
    await eng.rescueZap({ target: null }, { token: MEME, quote: USDG, before: 300n }, new Error('kedua'));
    const q = eng.leftovers();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].amount, '800');
  });

  // ---------------------------------------------------------------- orphan zap
  const zapReceipt = (amount) => ({ status: '0x1', logs: [{ address: MEME, topics: [TOPIC.transfer, addrTopic('0x' + '11'.repeat(20)), addrTopic(ME)], data: pad(amount) }] });

  await t('orphan zap (process restarted between zap and mint) → the token is sold back, once only', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 700n }, rpc: { call: async (method) => (method === 'eth_getTransactionReceipt' ? zapReceipt(700n) : null) } });
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xz1',?,'zap_swap','pending',?)", Date.now() - 10 * 60_000,
      JSON.stringify({ pool: POOL, buy: MEME, pay: USDG, target: TARGET }));
    assert.strictEqual(await eng.recoverStrandedZaps(), 1);
    const q = eng.leftovers();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].token, MEME); assert.strictEqual(q[0].quote, USDG); assert.strictEqual(q[0].amount, '700');
    assert.strictEqual(await eng.recoverStrandedZaps(), 0, 'ditandai ditangani');
    assert.strictEqual(eng.leftovers().length, 1);
  });

  await t('a zap followed by a mint in the same pool is NOT considered orphan', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 700n }, rpc: { call: async () => zapReceipt(700n) } });
    const ts = Date.now() - 10 * 60_000;
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xz2',?,'zap_swap','sukses',?)", ts, JSON.stringify({ pool: POOL, buy: MEME, pay: USDG }));
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xm2',?,'mint','sukses',?)", ts + 5000, JSON.stringify({ pool: POOL }));
    assert.strictEqual(await eng.recoverStrandedZaps(), 0);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('a zap whose mint REVERTED and was not yet rescued (process died before rescue) is still sold back', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 700n }, rpc: { call: async () => zapReceipt(700n) } });
    const ts = Date.now() - 10 * 60_000;
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xz5',?,'zap_swap','sukses',?)", ts, JSON.stringify({ pool: POOL, buy: MEME, pay: USDG }));
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xm5',?,'mint','gagal',?)", ts + 5000, JSON.stringify({ pool: POOL }));
    assert.strictEqual(await eng.recoverStrandedZaps(), 1);
  });

  await t('an orphan zap only sells what is STILL in the wallet (part has already been used)', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 200n }, rpc: { call: async () => zapReceipt(700n) } });
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xz3',?,'zap_swap','sukses',?)", Date.now() - 10 * 60_000, JSON.stringify({ pool: POOL, buy: MEME, pay: USDG }));
    await eng.recoverStrandedZaps();
    assert.strictEqual(eng.leftovers()[0].amount, '200');
  });

  await t('a running zap (active entry) is not touched', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 700n }, rpc: { call: async () => zapReceipt(700n) } });
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xz4',?,'zap_swap','sukses',?)", Date.now() - 10 * 60_000, JSON.stringify({ pool: POOL, buy: MEME, pay: USDG }));
    eng.activeEntries = 1;
    assert.strictEqual(await eng.recoverStrandedZaps(), 0);
  });

  // ---------------------------------------------------------------- v3 exit
  let nextTok = 50;
  const v3Pos = (store, over = {}) => Number(store.run(
    `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol)
     VALUES('v3',?,'0x1234','${USDG}','${MEME}',10000,-600,600,?,?,?,'open',?,'0','0',100,'USDG')`,
    String(nextTok++), over.liquidity ?? '1000000', TARGET, over.mirrorOf ?? '777', over.openedTs ?? Date.now() - 3600_000).lastInsertRowid);
  const exitAct = (store, over) => {
    const r = store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,liquidity) VALUES(?,?,?,?,?,?,?,?,?)`,
      Date.now(), 1, '0x' + Math.random().toString(16).slice(2), 1, TARGET, 'v3', 'decrease', over.tokenId, over.liquidity);
    return { id: Number(r.lastInsertRowid), target: TARGET, venue: 'v3', kind: 'decrease', ...over };
  };
  const npmPositions = (liq) => IF_NPM.encodeFunctionResult('positions', [0, ethers.ZeroAddress, USDG, MEME, 10000, -600, 600, liq, 0, 0, 0, 0]);

  await t('v3: target withdraws PARTIALLY → target liquidity read from the v3 NPM (not the v4 PositionManager) → proportional exit', async () => {
    const reads = [];
    const { eng, store } = engineWith({ rpc: { ethCallMany: async (c) => { reads.push(c[0].to); return [npmPositions(900n)]; } } });
    const id = v3Pos(store);
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0xb', note: 'ok' }; };
    await eng.handleExit(exitAct(store, { tokenId: '777', liquidity: '-100' }), eng.rulesFrom(TARGET));
    assert.deepStrictEqual(reads, [ADDR.npmV3]);
    assert.ok(plan, 'must exit');
    assert.strictEqual(plan.full, false, 'the target only withdrew 10%');
    assert.strictEqual(plan.liquidity, '100000');
    assert.strictEqual(plan.positionId, id);
  });

  await t('v3: target decrease+burn in one tx (positions() reverts) → mirror closed fully, not skipped', async () => {
    const { eng, store } = engineWith({ rpc: { ethCallMany: async (c, b, o) => { assert.ok(o?.strict, 'strict required'); return [null]; } } });
    v3Pos(store);
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0xb', note: 'ok' }; };
    await eng.handleExit(exitAct(store, { tokenId: '777', liquidity: '-1000' }), eng.rulesFrom(TARGET));
    assert.ok(plan && plan.full);
  });

  await t('v3: target liquidity unreadable (temporary error) → NOT taken as zero', async () => {
    const { eng, store } = engineWith({ rpc: { ethCallMany: async () => { throw new Error('eth_call tidak terbaca dari RPC: 429'); } } });
    v3Pos(store);
    let called = false;
    eng.executeExitRetry = async () => { called = true; return {}; };
    const orig = global.setTimeout; global.setTimeout = (fn) => orig(fn, 0);
    try { await eng.handleExit(exitAct(store, { tokenId: '777', liquidity: '-100' }), eng.rulesFrom(TARGET)); }
    finally { global.setTimeout = orig; }
    assert.strictEqual(called, false);
    assert.match(store.get('SELECT reason FROM decisions ORDER BY id DESC').reason, /tidak terbaca/);
  });

  await t('exit reconciliation now covers v3 too: target NFT burned (2× revert) → mirror closed; a new mirror (<10 min) is not', async () => {
    const { eng, store } = engineWith({ rpc: { ethCallMany: async (c) => c.map(() => null) } });
    const oldId = v3Pos(store, { mirrorOf: '1' });
    v3Pos(store, { mirrorOf: '2', openedTs: Date.now() - 60_000 });
    const closed = [];
    eng.executeExit = async (plan, pos) => { closed.push(pos.id); return { note: 'ok' }; };
    await eng.reconcileExits();
    assert.deepStrictEqual(closed, [], 'the first observation is not enough');
    await eng.reconcileExits();
    assert.deepStrictEqual(closed, [oldId]);
  });

  // ---------------------------------------------------------------- hanging tx
  await t('a compound that never landed (dropped from the mempool) is flagged failed after 30 min — closing the position is not locked forever', async () => {
    const { eng, store } = engineWith({ rpc: { call: async () => null } });
    const id = v3Pos(store);
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xc1',?,'compound','pending',?)", Date.now() - 31 * 60_000, JSON.stringify({ position: id }));
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xc2',?,'compound','pending',?)", Date.now() - 5 * 60_000, JSON.stringify({ position: id }));
    await new Compound(eng).reconcile();
    assert.strictEqual(store.get("SELECT status FROM txs WHERE hash='0xc1'").status, 'gagal');
    assert.strictEqual(store.get("SELECT status FROM txs WHERE hash='0xc2'").status, 'pending', 'one that is only 5 minutes old is still waited for');
  });

  await t('a fee claim that never landed is flagged failed after 30 min; one still known to the chain is waited for', async () => {
    const known = new Set(['0xk2']);
    const { eng, store } = engineWith({ rpc: { call: async (method, [h]) => (method === 'eth_getTransactionByHash' && known.has(h) ? { hash: h } : null) } });
    const id = v3Pos(store);
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xk1',?,'claim_fees','pending',?)", Date.now() - 40 * 60_000, JSON.stringify({ position: id }));
    store.run("INSERT INTO txs(hash,ts,kind,status,detail) VALUES('0xk2',?,'claim_fees','pending',?)", Date.now() - 40 * 60_000, JSON.stringify({ position: id }));
    await eng.reconcileFeeClaims();
    assert.strictEqual(store.get("SELECT status FROM txs WHERE hash='0xk1'").status, 'gagal');
    assert.strictEqual(store.get("SELECT status FROM txs WHERE hash='0xk2'").status, 'pending');
  });

  // ---------------------------------------------------------------- leftover sale
  await t('selling the same token does not run twice at once; what is held back stays queued', async () => {
    const { eng } = engineWith({ balances: { [MEME]: 1000n, [ETH]: 10n ** 18n } });
    eng.gasReserve = async () => 1n;
    let swaps = 0, release;
    const gate = new Promise((r) => { release = r; });
    eng.kyber.swap = async () => { swaps++; await gate; return { hash: '0xs', amountOut: 1n, quote: { dex: 'uji', usdIn: 1, usdOut: 1 } }; };
    eng.positions.recordLeftoverSale = () => [];
    const a = eng.sellToken({ posId: 1, target: null, token: MEME, quote: USDG, amount: '600' });
    await new Promise((r) => setImmediate(r));
    const b = await eng.sellToken({ posId: 2, target: null, token: MEME, quote: USDG, amount: '400' });
    assert.strictEqual(b, null);
    assert.strictEqual(swaps, 1);
    assert.ok(eng.leftovers().some((x) => x.posId === 2), 'the second item entered the queue');
    release(); await a;
  });

  await t('leftover from an exit tx when the balance is unreadable (RPC) → STILL enters the queue, not lost', async () => {
    const { eng } = engineWith({ balances: { [ETH]: 10n ** 18n } });
    eng.gasReserve = async () => 1n;
    eng.exec.balances = async () => { throw new Error('gagal membaca saldo token dari RPC'); };
    let swaps = 0; eng.kyber.swap = async () => { swaps++; return null; };
    await assert.rejects(eng.sellToken({ posId: 9, target: null, token: MEME, quote: USDG, amount: '1234' }), /belum terjual/);
    assert.strictEqual(swaps, 0);
    const q = eng.leftovers();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].posId, 9); assert.strictEqual(q[0].amount, '1234');
  });

  await t('an unexpected error in one action does not cut off other actions in the same range', async () => {
    const { eng, store } = engineWith();
    eng.head = 0; eng.cursor = 0;
    eng.rpc.allCooling = () => false;
    eng.rpc.safeHead = async () => ({ min: 10, max: 10, spread: 0 });
    const mk = (tokenId) => ({ ts: Date.now(), block: 5, txHash: '0x' + tokenId, logIndex: Number(tokenId), target: TARGET, venue: 'v4', kind: 'increase', tokenId });
    eng.watcher.scan = async () => [mk('1'), mk('2')];
    const handled = [];
    eng.handle = async (a) => { handled.push(a.tokenId); if (a.tokenId === '1') throw new Error('eth_call tidak terbaca dari RPC: 429'); eng.decide(a.id, 'skip', 'ok'); };
    await eng.tick();
    assert.deepStrictEqual(handled, ['1', '2']);
    const d = store.all('SELECT verdict, reason FROM decisions ORDER BY id');
    assert.strictEqual(d.length, 2);
    assert.strictEqual(d[0].verdict, 'error');
  });

  await t('leftover token without a Kyber route (a new pool not yet indexed) → sold directly into its position\'s pool', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 10n ** 21n, [ETH]: 10n ** 18n } });
    eng.gasReserve = async () => 1n;
    const L = 10n ** 24n, sqrtP = m.getSqrtRatioAtTick(0);
    eng.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtP, tick: 0, lpFee: 0 }));
    eng.chain.poolLiquidityMany = async (ids) => ids.map(() => L);
    const id = Number(store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,quote_symbol)
      VALUES('v4','77',?,?,?,3000,60,?,-600,600,'0','closed',?,100,'USDG')`, POOL, USDG, MEME, ADDR.native, Date.now()).lastInsertRowid);
    eng.kyber.swap = async () => null;   // Kyber does not know the route
    eng.exec.ensureRouterAllowance = async () => [];
    eng.exec.deadline = () => 9e9;
    eng.rpc.batch = async (c) => c.map(() => ({ result: '0x' }));   // simulation passes
    const sent = [];
    eng.exec.send = async (tx, meta) => { sent.push(meta); return '0xsellpool'; };
    eng.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [{ address: USDG, topics: [TOPIC.transfer, addrTopic(POOL.slice(0, 42)), addrTopic(ME)], data: pad(990_000n) }] } });
    eng.positions.recordLeftoverSale = () => [];
    const msg = await eng.sellToken({ posId: id, target: null, token: MEME, quote: USDG, amount: String(10n ** 21n) });
    assert.match(msg, /pool v4/);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].kind, 'sell_leftover');
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('sell via a pool: a loss above the limit is rejected (stays queued), a token without a known pool is not tried', async () => {
    const { eng, store } = engineWith({ balances: { [MEME]: 10n ** 21n, [ETH]: 10n ** 18n } });
    eng.gasReserve = async () => 1n;
    eng.kyber.swap = async () => null;
    let sends = 0; eng.exec.send = async () => { sends++; return '0x'; };
    eng.exec.ensureRouterAllowance = async () => [];
    // without a known pool
    await assert.rejects(eng.sellToken({ posId: null, target: null, token: MEME, quote: USDG, amount: '1000' }), /pool langsung juga tidak bisa/);
    assert.strictEqual(sends, 0);
    // pool fee 10% → loss > the 5% limit
    store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks) VALUES(?,?,?,?,?,?,?)`, POOL, 'v4', USDG, MEME, 100000, 200, ADDR.native);
    eng.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 }));
    eng.chain.poolLiquidityMany = async (ids) => ids.map(() => 10n ** 24n);
    eng.rpc.batch = async (c) => c.map(() => ({ result: '0x' }));
    eng.cfg.rules = { exit: { sell_max_loss_bps: 500 } };
    await assert.rejects(eng.sellToken({ posId: null, target: null, token: MEME, quote: USDG, amount: String(10n ** 21n) }), /rugi 10\.\d%/);
    assert.strictEqual(sends, 0);
    assert.strictEqual(eng.leftovers().length, 1, 'stays in the queue');
  });

  await t('gas top-up: without WETH and native ETH < ½ reserve → buy ETH from USDG (12 Sep 14:39: all txs "insufficient funds")', async () => {
    const { eng } = engineWith({ balances: { [ETH]: 5n * 10n ** 14n, [WETH]: 0n, [USDG]: 400_000_000n } });
    eng.gasReserve = async () => 2n * 10n ** 15n;
    const swaps = [];
    eng.kyber.swap = async (a, b, amt, o) => { swaps.push({ a, b, amt, kind: o.kind }); return { hash: '0xg' }; };
    const notes = [];
    await eng.topUpGas(notes);
    assert.strictEqual(swaps.length, 1);
    assert.strictEqual(swaps[0].a, USDG); assert.strictEqual(swaps[0].b, ETH); assert.strictEqual(swaps[0].kind, 'gas_topup');
    // 0.0015 ETH × $2500 × 1.03 ≈ 3.86 USDG
    assert.ok(swaps[0].amt > 3_800_000n && swaps[0].amt < 3_900_000n, String(swaps[0].amt));
    // above ½ of the reserve: does not swap a little at a time
    const { eng: e2 } = engineWith({ balances: { [ETH]: 15n * 10n ** 14n, [USDG]: 400_000_000n } });
    e2.gasReserve = async () => 2n * 10n ** 15n;
    let n2 = 0; e2.kyber.swap = async () => { n2++; return {}; };
    await e2.topUpGas([]);
    assert.strictEqual(n2, 0);
  });

  await t('a gas price spike / nonsense gasPrice from the RPC does NOT make the gas top-up swap hundreds of dollars of USDG', async () => {
    const { eng } = engineWith({ balances: { [ETH]: 0n, [USDG]: 5_000_000_000n } });
    eng.gasReserve = async () => 4_000_000n * 100_000_000_000n;   // 4m gas × 100 gwei = 0.4 ETH
    const swaps = [];
    eng.kyber.swap = async (a, b, amt) => { swaps.push(amt); return { hash: '0xg' }; };
    await eng.topUpGas([]);
    assert.strictEqual(swaps.length, 1);
    assert.ok(swaps[0] <= 25_000_000n, `maks $25, dapat ${swaps[0]}`);
    const c = await eng.spendableCash();
    assert.ok(c.usdg >= 5000 - 25.0001, 'entry cash is only reduced by the bounded gas purchase');
  });

  await t('position size is computed from USDG AFTER the gas top-up (not failing "insufficient cash" because of gas)', async () => {
    const { eng } = engineWith({ balances: { [ETH]: 5n * 10n ** 14n, [USDG]: 200_000_000n } });
    eng.gasReserve = async () => 2n * 10n ** 15n;
    const c = await eng.spendableCash();
    // 0.0015 ETH × 2500 × 1.03 ≈ $3.86 for gas
    assert.ok(Math.abs(c.usdg - (200 - 3.8625)) < 0.01, String(c.usdg));
    const { eng: e2 } = engineWith({ balances: { [ETH]: 3n * 10n ** 15n, [USDG]: 200_000_000n } });
    e2.gasReserve = async () => 2n * 10n ** 15n;
    assert.strictEqual((await e2.spendableCash()).usdg, 200, 'enough gas: USDG intact');
  });

  await t('backfill after restart: a v4 entry is evaluated with the poolKey from the DB, not skipped as "pool data unreadable"', async () => {
    const { eng, store } = engineWith();
    store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,value_quote,quote_symbol)
      VALUES(?,1,'0xbf',1,?,'v4','increase','321',?,?,?,3000,60,?,-600,600,'1000000',400,'USDG')`, Date.now() - 30_000, TARGET, POOL, USDG, MEME, ADDR.native);
    eng.chain.slot0V4 = async () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 });
    let seen;
    eng.handleEntry = async (act) => { seen = act; eng.decide(act.id, 'skip', 'uji'); };
    await eng.backfillDecisions();
    assert.ok(seen, 'aksi dinilai');
    assert.deepStrictEqual(seen.poolKey, { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native });
  });

  await t('a pool price / target value that failed to read at scan time is re-read before evaluating the entry', async () => {
    const { eng } = engineWith({ chain: {
      slot0V4: async () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 }),
      valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18, symbol: 'USDG', kind: 'usd' }),
    } });
    const act = { venue: 'v4', poolRef: POOL, token0: USDG, token1: MEME, tickLower: -600, tickUpper: 600, liquidity: String(10n ** 15n), slot0: null, valueQuote: null };
    await eng.refreshActionState(act);
    assert.ok(act.slot0);
    assert.ok(act.valueQuote > 0, String(act.valueQuote));
  });

  await t('watcher: target decrease then burn in the next tx (ownerOf revert) is still recognised as the target\'s', async () => {
    const { Watcher } = require('../src/watcher');
    const store = new Store(':memory:');
    store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id) VALUES(?,1,'0xa',1,?,'v4','increase','888')`, Date.now(), TARGET);
    const w = new Watcher({ rpc: { ethCallMany: async (c) => c.map(() => null) }, store, chain: {}, log: () => {}, cfg: {} });
    await w.resolveOwners('v4', ['888', '999']);
    assert.strictEqual(w.knownOwner('v4', '888'), TARGET);
    assert.strictEqual(w.knownOwner('v4', '999'), null);
  });

  await t('a WETH-quoted position is valued in dollars like ETH (budget, exposure, realized PnL)', async () => {
    const { usdPerQuote } = require('../src/policy');
    assert.strictEqual(usdPerQuote('WETH', 2500), 2500);
    assert.strictEqual(usdPerQuote('ETH', 2500), 2500);
    assert.strictEqual(usdPerQuote('USDG', 2500), 1);
    const { eng, store } = engineWith();
    store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,status,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol)
      VALUES('v4','1',?,?,?,-60,60,'0','closed',?,?,0.08,0.09,'WETH')`, POOL, WETH, MEME, Date.now() - 1000, Date.now());
    store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,out_quote,quote_symbol)
      VALUES('v4','2',?,?,?,-60,60,'5','open',?,0.04,0,'WETH')`, POOL, WETH, MEME, Date.now() - 1000);
    const sum = eng.positions.summary(2500);
    assert.ok(Math.abs(sum.realizedUsd - 25) < 1e-6, String(sum.realizedUsd));   // (0.09 − 0.08) × 2500
    assert.ok(Math.abs(sum.costUsd - 100) < 1e-6, String(sum.costUsd));
    const spent = store.get("SELECT COALESCE(SUM(cost_quote * CASE WHEN quote_symbol IN ('ETH','WETH') THEN ? ELSE 1 END),0) AS s FROM positions WHERE opened_ts > ?", 2500, Date.now() - 86400_000).s;
    assert.ok(Math.abs(spent - 300) < 1e-6);
  });

  await t('the remaining copy quota (dashboard) uses the same figures as planEntry: 24-hour budget, exposure, slots, cash above the gas reserve', async () => {
    const { eng, store } = engineWith();
    eng.cfg.rules = { sizing: { daily_budget_usd: 500, max_total_exposure_usd: 1000, max_quote_per_position_usd: 200 }, filters: { max_open_positions: 3 } };
    eng.cfg.gas = { native_reserve_wei: String(2n * 10n ** 15n) };
    // opened 2 days ago: exposure yes, daily budget no
    store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,out_quote,quote_symbol)
      VALUES('v4','1',?,?,?,-60,60,'5','open',?,150,0,'USDG')`, POOL, USDG, MEME, Date.now() - 2 * 86400_000);
    store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,out_quote,quote_symbol)
      VALUES('v4','2',?,?,?,-60,60,'5','open',?,0.04,0,'ETH')`, POOL, ETH, MEME, Date.now() - 1000);   // $100 hari ini
    const r = eng.copyRoom({ usdg: 300, eth: 0.012, weth: 0, usd: 330 });
    assert.strictEqual(r.daily.limit, 500); assert.ok(Math.abs(r.daily.used - 100) < 1e-6); assert.ok(Math.abs(r.daily.left - 400) < 1e-6);
    assert.strictEqual(r.exposure.limit, 1000); assert.ok(Math.abs(r.exposure.used - 250) < 1e-6); assert.ok(Math.abs(r.exposure.left - 750) < 1e-6);
    assert.deepStrictEqual(r.slots, { limit: 3, used: 2, left: 1 });
    assert.strictEqual(r.perPositionUsd, 200);
    assert.ok(Math.abs(r.cashUsd - (300 + 0.010 * 2500)) < 1e-6, String(r.cashUsd));   // ETH minus the 0.002 reserve
    assert.strictEqual(eng.copyRoom(null).cashUsd, null);
    // a ceiling exceeded does not go negative
    eng.cfg.rules.sizing.daily_budget_usd = 50;
    assert.strictEqual(eng.copyRoom(null).daily.left, 0);
  });

  await t('policy: "follow partial withdrawal" switched off → a partial withdrawal is ignored (it used to: close fully); a full exit is still followed', async () => {
    const { planExit, rulesFor } = require('../src/policy');
    const rules = rulesFor({ exit: { follow_target: true, follow_partial: false } });
    const pos = { id: 1, venue: 'v4', token_id: '5', liquidity: '1000' };
    assert.strictEqual(planExit({ liquidity: '-100', liquidityBefore: 1000n, tokenId: '9' }, pos, { rules }).verdict, 'skip');
    const full = planExit({ liquidity: '-1000', liquidityBefore: 1000n, tokenId: '9' }, pos, { rules });
    assert.strictEqual(full.verdict, 'copy'); assert.strictEqual(full.plan.full, true);
    const on = planExit({ liquidity: '-100', liquidityBefore: 1000n, tokenId: '9' }, pos, { rules: rulesFor({}) });
    assert.strictEqual(on.plan.liquidity, '100');
  });

  await t('policy: adding to an already mirrored position — not subject to the position count limit, the $ per position limit is computed from the total', async () => {
    const { planEntry, rulesFor } = require('../src/policy');
    const rules = rulesFor({ sizing: { mode: 'mirror', max_quote_per_position_usd: 200, max_total_exposure_usd: 10_000, daily_budget_usd: 10_000, min_quote_usd: 5 },
      filters: { max_open_positions: 3, min_target_quote_usd: 1, allow_hooks: true } });
    const chain = {
      quoteSideOf: (t0) => (t0 === USDG ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
      valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 * (1e12 / m.priceFromSqrt(sqrtPriceX96, 0, 0)) / 1e12, symbol: 'USDG', kind: 'usd' }),
    };
    const slot0 = { sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 };
    const act = { venue: 'v4', token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: String(10n ** 16n), valueQuote: 1000, tokenId: '7', target: TARGET };
    const base = { chain, rules, slot0, dec0: 6, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 3 };
    assert.match(planEntry(act, base).reason, /mentok/);
    const add = planEntry(act, { ...base, existingUsd: 150 });
    assert.strictEqual(add.verdict, 'copy', add.reason);
    assert.ok(add.plan.valueUsd <= 50.01, `remaining room $50, got ${add.plan.valueUsd}`);
    assert.strictEqual(planEntry(act, { ...base, existingUsd: 200 }).verdict, 'skip', 'position is already full');
  });

  await t('policy: a one-sided position is cut by the one-side limit — its reason names that limit, not the "per-position limit"', async () => {
    // Real lpcopy3 case: per-position cap 280, one-side cap 200, the target opens $500 above
    // the price. The reason used to say "per-position cap ($200)" although the per-position cap was 280.
    const { planEntry, rulesFor } = require('../src/policy');
    const rules = rulesFor({ sizing: { mode: 'mirror', max_quote_per_position_usd: 280, max_total_exposure_usd: 10_000, daily_budget_usd: 10_000, min_quote_usd: 5 },
      onesided: { policy: 'copy', max_quote_usd: 200 }, filters: { min_target_quote_usd: 1, allow_hooks: true } });
    const chain = {
      quoteSideOf: (t0) => (t0 === USDG ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
      valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 * (1e12 / m.priceFromSqrt(sqrtPriceX96, 0, 0)) / 1e12, symbol: 'USDG', kind: 'usd' }),
    };
    const slot0 = { sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 };
    const base = { chain, rules, slot0, dec0: 6, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0 };
    // the range is entirely above the current price → only USDG (token0)
    const side = { venue: 'v4', token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, tickLower: 600, tickUpper: 1800, liquidity: String(10n ** 16n), valueQuote: 500, tokenId: '8', target: TARGET };
    const r = planEntry(side, base);
    assert.strictEqual(r.verdict, 'copy', r.reason);
    assert.strictEqual(r.plan.side, 'token0_only');
    assert.ok(Math.abs(r.plan.valueUsd - 200) < 0.01, `dipotong ke $200, dapat ${r.plan.valueUsd}`);
    assert.match(r.reason, /batas satu sisi \(\$200\.00\)/);
    assert.doesNotMatch(r.reason, /batas per posisi/);
    // two sides: the one-side cap does not interfere, the per-position cap 280 is what applies
    const both = { ...side, tickLower: -600, tickUpper: 600 };
    const r2 = planEntry(both, base);
    assert.strictEqual(r2.verdict, 'copy', r2.reason);
    assert.match(r2.reason, /batas per posisi \(\$280\.00\)/);
    assert.ok(Math.abs(r2.plan.valueUsd - 280) < 0.01, `dipotong ke $280, dapat ${r2.plan.valueUsd}`);
  });

  await t('policy: force minimum — below the minimum the position is raised to the forced amount, not skipped', async () => {
    // Owner settings: 10% of the target, minimum $100, maximum $400. The target opens $250 →
    // the computed $25 → it used to always be skipped; with a forced $100 the position enters with $100.
    const { planEntry, rulesFor } = require('../src/policy');
    const chain = {
      quoteSideOf: (t0) => (t0 === USDG ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
      valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 * (1e12 / m.priceFromSqrt(sqrtPriceX96, 0, 0)) / 1e12, symbol: 'USDG', kind: 'usd' }),
    };
    const slot0 = { sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 };
    // valueQuote is only used by the "ignore small targets" filter; the real value is computed from liquidity.
    const act = { venue: 'v4', token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: '8460000000', valueQuote: 250, tokenId: '9', target: TARGET };
    const mk = (sz) => rulesFor({ sizing: { mode: 'pct', pct: 10, min_quote_usd: 100, max_quote_per_position_usd: 400, max_total_exposure_usd: 40_000, daily_budget_usd: 50_000, ...sz },
      filters: { min_target_quote_usd: 1, allow_hooks: true } });
    const ctx = (rules, extra) => ({ chain, rules, slot0, dec0: 6, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0, ...extra });
    // the full value of the target position on this range (without a ceiling), so the expected figure is clear:
    // 10% of it must be below the $100 minimum for this case to mean anything.
    const full = planEntry(act, ctx(mk({ mode: 'mirror', max_quote_per_position_usd: 1e9 }), {})).plan.valueUsd;
    assert.ok(full * 0.1 < 100, `10% of $${full} must be below the minimum`);

    const off = planEntry(act, ctx(mk({}), {}));
    assert.strictEqual(off.verdict, 'skip', 'force off → still skipped');
    assert.match(off.reason, /< minimum/);

    const on = planEntry(act, ctx(mk({ force_min: true, force_min_usd: 100 }), {}));
    assert.strictEqual(on.verdict, 'copy', on.reason);
    assert.ok(Math.abs(on.plan.valueUsd - 100) < 0.01, `dipaksa ke $100, dapat ${on.plan.valueUsd}`);
    assert.match(on.reason, /dipaksa ke \$100\.00/);

    // a forced amount may be below the minimum — that is the owner's choice
    const small = planEntry(act, ctx(mk({ force_min: true, force_min_usd: 40 }), {}));
    assert.ok(Math.abs(small.plan.valueUsd - 40) < 0.01, String(small.plan.valueUsd));

    // the cap still wins: the remaining exposure allowance $60 < forced $100 → skipped, the reason cites the cap
    const narrow = planEntry(act, ctx(mk({ force_min: true, force_min_usd: 100 }), { openExposureUsd: 39_940 }));
    assert.strictEqual(narrow.verdict, 'skip');
    assert.match(narrow.reason, /paksa \$100 tidak muat/);
    assert.match(narrow.reason, /sisa jatah eksposur total tinggal \$60\.00/);

    // above the forced minimum does not interfere, and the per-position cap still cuts
    const large = planEntry({ ...act, liquidity: String(10n ** 12n) }, ctx(mk({ force_min: true, force_min_usd: 100 }), {}));
    assert.strictEqual(large.verdict, 'copy', large.reason);
    assert.ok(Math.abs(large.plan.valueUsd - 400) < 0.01, String(large.plan.valueUsd));
    assert.match(large.reason, /batas per posisi/);
  });

  await t('position adoption: liquidity failed to read → the scan window is NOT advanced, the position is adopted on the next attempt', async () => {
    const IF_POSM = new ethers.Interface(ABI.posmV4);
    let liqOk = false;
    const pk = [USDG, MEME, 3000, 60, ethers.ZeroAddress];
    const info = (-600n & 0xffffffn) << 8n | ((600n & 0xffffffn) << 32n);
    const rpc = {
      blockNumber: async () => 5000,
      getLogs: async (f) => (f.topics[2] ? [{ blockNumber: '0x10', topics: [TOPIC.transfer, addrTopic(ethers.ZeroAddress), addrTopic(ME), pad(42)] }] : []),
      ethCallMany: async (calls) => calls.map((c) => {
        const fn = IF_POSM.parseTransaction({ data: c.data })?.name;
        if (fn === 'ownerOf') return pad(ME);
        if (fn === 'getPoolAndPositionInfo') return IF_POSM.encodeFunctionResult('getPoolAndPositionInfo', [pk, info]);
        if (fn === 'getPositionLiquidity') return liqOk ? pad(10n ** 15n) : null;
        return null;
      }),
    };
    const { eng, store } = engineWith({ rpc });
    eng.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 }));
    eng.chain.valueInQuote = () => ({ value: 10, kind: 'usd', symbol: 'USDG' });
    eng.chain.poolLiquidityMany = async (ids) => ids.map(() => 1n);
    await eng.adoptOwnPositions(ME);
    assert.strictEqual(store.getState('adopt_scanned_to:robinhood', null), null, 'the window is not advanced');
    assert.strictEqual(store.all('SELECT id FROM positions').length, 0);
    liqOk = true;
    await eng.adoptOwnPositions(ME);
    assert.strictEqual(Number(store.getState('adopt_scanned_to:robinhood')), 5000, store.all("SELECT msg FROM logs ORDER BY id DESC LIMIT 2").map((r) => r.msg).join(' | '));
    assert.strictEqual(store.all("SELECT token_id FROM positions").map((r) => r.token_id).join(), '42');
  });

  // ---------------------------------------------------------------- sync & stop
  await t('the sync does not run two rounds at once (double booking when the RPC is slow)', async () => {
    const { eng } = engineWith();
    let running = 0, max = 0, release;
    const gate = new Promise((r) => { release = r; });
    eng.syncPositionsOnce = async () => { running++; max = Math.max(max, running); await gate; running--; };
    const a = eng.syncPositions();
    const b = eng.syncPositions();
    release(); await a; await b;
    assert.strictEqual(max, 1);
  });

  await t('stopping (deploy): waits for the running entry; new entry/exit is refused', async () => {
    const { eng } = engineWith();
    eng.activeEntries = 1;
    let done = false;
    const d = eng.drain(5000).then((ok) => { done = ok; });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(done, false, 'still waiting');
    await assert.rejects(eng.executeEntry({ poolRef: POOL }, {}), /sedang berhenti/);
    await assert.rejects(eng.executeExit({}, { id: 1 }), /sedang berhenti/);
    eng.activeEntries = 0;
    await d;
    assert.strictEqual(done, true);
    await eng.tick();   // does not start a new scan
    assert.strictEqual(eng.busy, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
