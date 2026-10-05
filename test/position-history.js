'use strict';
// Test GET /api/position/history — the history of one bot position for the drawer on the Positions page:
// the transactions that touched it (zap, mint, close, leftover sale) with amounts & values,
// the bot's notes (decision + log lines that mention "#<id>"), and the target side —
// the original position being copied along with THEIR result there.
//
// Run: node test/position-history.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x' + '22'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function world() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-riwayat-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api };
}

const T0 = 1_700_000_000_000;
function positionContent(store) {
  // position #1: USDG/MEME, capital 200 USDG, closed -> 215 USDG (fee 13)
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,target,opened_ts,closed_ts,
    cost0,cost1,cost_quote,out0,out1,out_quote,fees_quote,quote_symbol,tx_open,tx_close)
    VALUES(1,'v4','2452759',?,?,?,3000,'closed',?,?,?,?,?,200,?,?,215.15,13.63,'USDG','0xmint1','0xburn1')`,
  POOL, ADDR.usdg, MEME, TARGET, T0 + 60_000, T0 + 360_000,
  (100n * 10n ** 6n).toString(), (100_000n * 10n ** 18n).toString(),
  (53n * 10n ** 6n).toString(), (614_765n * 10n ** 18n).toString());
  // position #10: another pool, opened much later — must not get mixed into #1's history
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,cost_quote,quote_symbol,tx_open)
    VALUES(10,'v4','9','0x'||?,?,?,'open',?,50,'USDG','0xmint10')`, 'cd'.repeat(32), ADDR.usdg, MEME, T0 + 900_000);

  const tx = (hash, ts, kind, status, detail, gas) => store.run(
    'INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES(?,?,?,?,?,?,?)',
    hash, ts, kind, status, gas ? 100_000 : null, gas ? '1000000000' : null, detail ? JSON.stringify(detail) : null);
  tx('0xzap1', T0 + 30_000, 'zap_swap', 'sukses', { via: 'kyber', pool: POOL, dex: 'uniswap-v4', usdIn: 100, usdOut: 99.2 }, true);
  tx('0xmint1', T0 + 60_000, 'mint', 'sukses', { pool: POOL, target: TARGET, venue: 'v4' }, true);
  tx('0xburn1', T0 + 360_000, 'burn', 'sukses', { position: 1, closeProceeds: { amount0: '53000000', amount1: (614_765n * 10n ** 18n).toString(), quote: 148 } }, true);
  tx('0xsell1', T0 + 400_000, 'sell_leftover', 'sukses', { position: 1, dex: 'kyber', usdIn: 73.7, usdOut: 73.1 }, true);
  tx('0xapprove', T0 + 40_000, 'approve_permit2', 'sukses', null, true);                  // without detail: excluded
  tx('0xzapLain', T0 + 30_000, 'zap_swap', 'sukses', { pool: '0x' + 'cd'.repeat(32) }, true); // another pool: excluded
  tx('0xmint10', T0 + 900_000, 'mint', 'sukses', { pool: '0x' + 'cd'.repeat(32) }, true);

  store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,value_quote,quote_symbol)
    VALUES(1,?,100,'0xtgt',0,?,'v4','mint','777',?,?,?,400,'USDG')`, T0 + 10_000, TARGET, POOL, ADDR.usdg, MEME);
  store.run("INSERT INTO decisions(action_id,ts,verdict,reason,tx_hash,position_id) VALUES(1,?,'copy','ukuran 50% dari target — USDG/MEME $200,00','0xmint1',1)", T0 + 60_000);
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 360_000, 'info', 'LP ditutup: tutup penuh posisi #1 · jual 614,8 rb MEME');
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 361_000, 'warn', 'sisa #10 tidak terukur: rpc 429');   // #10 is not #1
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 362_000, 'info', 'ETH/USD dari chain: $2500');          // does not mention the position
}

(async () => {
  console.log('position history');
  const { store, api } = world();
  positionContent(store);
  const r = await api('GET', '/api/position/history', {}, { id: '1' });

  await t('position #1: summary of capital/proceeds/fee/PnL in USD', () => {
    assert.equal(r.position.symbol0, 'USDG'); assert.equal(r.position.symbol1, 'MEME');
    assert.equal(r.position.costUsd, 200); assert.equal(r.position.outUsd, 215.15);
    assert.equal(r.position.feesUsd, 13.63); assert.ok(Math.abs(r.position.pnlUsd - 15.15) < 1e-9);
  });
  await t('event order: zap -> mint -> close -> leftover sale; approve & another pool are not included', () => {
    assert.deepEqual(r.events.map((e) => e.kind), ['zap_swap', 'mint', 'burn', 'sell_leftover']);
    assert.deepEqual(r.events.map((e) => e.hash), ['0xzap1', '0xmint1', '0xburn1', '0xsell1']);
  });
  await t('mint carries capital amounts & value; close carries proceeds & fee', () => {
    const mint = r.events[1], burn = r.events[2];
    assert.equal(mint.amount0, (100n * 10n ** 6n).toString()); assert.equal(mint.valueUsd, 200);
    assert.equal(mint.reason, 'ukuran 50% dari target — USDG/MEME $200,00'); assert.equal(mint.targetUsd, 400);
    assert.equal(burn.amount0, (53n * 10n ** 6n).toString()); assert.equal(burn.valueUsd, 148); assert.equal(burn.feesUsd, 13.63);
  });
  await t('swap carries USD in/out and the dex; gas computed to USD', () => {
    const zap = r.events[0];
    assert.equal(zap.usdIn, 100); assert.equal(zap.usdOut, 99.2); assert.equal(zap.dex, 'uniswap-v4');
    assert.ok(Math.abs(zap.gasUsd - 0.25) < 1e-9, `gas ${zap.gasUsd}`);   // 100k gas × 1 gwei × $2500
  });
  await t('notes: decision + logs that mention #1, not #10 nor general lines', () => {
    assert.equal(r.notes.length, 2);
    assert.equal(r.notes[0].kind, 'keputusan'); assert.equal(r.notes[0].verdict, 'copy'); assert.equal(r.notes[0].actionKind, 'mint');
    assert.equal(r.notes[1].kind, 'log'); assert.match(r.notes[1].msg, /posisi #1 /);
  });
  await t('a position without a tx in the table (adopted) still has synthetic open/close events', () => {
    store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol)
      VALUES(20,'v3','5','0x'||?,?,?,'closed',?,?,80,90,'USDG')`, 'ef'.repeat(20), ADDR.usdg, MEME, T0, T0 + 1000);
    return api('GET', '/api/position/history', {}, { id: '20' }).then((x) => {
      assert.deepEqual(x.events.map((e) => [e.kind, !!e.synthetic]), [['mint', true], ['burn', true]]);
      assert.equal(x.events[1].valueUsd, null);
    });
  });
  await t('a manual swap is linked via FIFO allocation, including long after the close', async () => {
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', '0xmanual', T0 + 9000000, 'swap_manual', 'sukses', JSON.stringify({
      tokenIn: MEME, tokenOut: ADDR.usdg, symbolIn: 'MEME', symbolOut: 'USDG', amountIn: 100, amountOut: 30,
      positionSales: [{ position: 1, closeQuote: 10, gotQuote: 30 }, { position: 10, closeQuote: 5, gotQuote: 8 }]
    }));
    const x = await api('GET', '/api/position/history', {}, { id: '1' });
    const ev = x.events.find(e => e.hash === '0xmanual');
    assert.equal(ev.swap.amountOut, 30); assert.equal(ev.saleDeltaUsd, 20);
    assert.equal(x.position.closeUsd, 148); assert.equal(x.position.outUsd, 215.15);
  });

  await t('two consecutive positions in the same pool: the neighbour\'s mint/zap does not leak into the history', async () => {
    // #6 and #7 as on lp2: same pool, #7 opened 90 seconds after #6 closed,
    // and before #7 there is a zap that FAILED to continue to the mint (entry cancelled) — it belongs to no one.
    const P2 = '0x' + '77'.repeat(32), T1 = T0 + 5_000_000;
    const pos = (id, opened, closed, txo, txc) => store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,closed_ts,
      cost_quote,out_quote,quote_symbol,tx_open,tx_close) VALUES(?,'v4',?,?,?,?,'closed',?,?,80,80,'USDG',?,?)`, id, String(id * 100), P2, ADDR.usdg, MEME, opened, closed, txo, txc);
    pos(6, T1 + 30_000, T1 + 120_000, '0xmint6', '0xburn6');
    pos(7, T1 + 200_000, T1 + 500_000, '0xmint7', '0xburn7');
    const tx = (hash, ts, kind, detail) => store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, ts, kind, 'sukses', JSON.stringify(detail));
    tx('0xzap6', T1 + 20_000, 'zap_swap', { pool: P2, usdIn: 40, usdOut: 39 });
    tx('0xmint6', T1 + 30_000, 'mint', { pool: P2, recorded: 6 });                                    // old mint: zap estimated
    tx('0xburn6', T1 + 120_000, 'burn', { position: 6, closeProceeds: { amount0: '80000000', amount1: '0', quote: 80 } });
    tx('0xzapBatal', T1 + 150_000, 'zap_swap', { pool: P2, usdIn: 30, usdOut: 29 });   // cancelled entry: no mint after it
    tx('0xmint7', T1 + 200_000, 'mint', { pool: P2, recorded: 7, zapped: { hashes: ['0xzap7'] } });   // new mint: its zap is recorded
    tx('0xzap7', T1 + 190_000, 'zap_swap', { pool: P2, usdIn: 40, usdOut: 39 });
    tx('0xburn7', T1 + 500_000, 'burn', { position: 7, closeProceeds: { amount0: '80000000', amount1: '0', quote: 80 } });
    const h6 = await api('GET', '/api/position/history', {}, { id: '6' });
    assert.deepEqual(h6.events.map((e) => e.hash), ['0xzap6', '0xmint6', '0xburn6']);
    const h7 = await api('GET', '/api/position/history', {}, { id: '7' });
    assert.deepEqual(h7.events.map((e) => e.hash), ['0xzap7', '0xmint7', '0xburn7']);
  });

  // The drawer used to only tell about us. The target side — how much they entered, what they
  // exited with — must be sent along here, not looked up on another page.
  await t('target side: wallet research is used if present, complete with the watched actions', async () => {
    store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,target,mirror_of,opened_ts,closed_ts,
      cost_quote,out_quote,quote_symbol) VALUES(30,'v4','3030',?,?,?,'closed',?,'777',?,?,100,120,'USDG')`,
    POOL, ADDR.usdg, MEME, TARGET, T0 + 20_000, T0 + 300_000);
    store.run(`INSERT INTO wpositions(wallet,venue,token_id,pool_ref,status,invested_q,returned_q,fees_q,pnl_q,opened_ts,closed_ts)
      VALUES(?,'v4','777',?,'closed',400,470,25,70,?,?)`, TARGET, POOL, T0 + 10_000, T0 + 280_000);
    store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,value_quote,quote_symbol,liquidity)
      VALUES(2,?,101,'0xtgtIn',0,?,'v4','increase','777',?,?,?,400,'USDG','1000')`, T0 + 10_000, TARGET, POOL, ADDR.usdg, MEME);
    store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,value_quote,quote_symbol,liquidity)
      VALUES(3,?,102,'0xtgtOut',0,?,'v4','decrease','777',?,?,?,445,'USDG','-1000')`, T0 + 280_000, TARGET, POOL, ADDR.usdg, MEME);
    const x = await api('GET', '/api/position/history', {}, { id: '30' });
    const o = x.position.origin;
    assert.equal(o.tokenId, '777');
    // wallet research: full PnL (fees & leftover tokens included), not the action difference
    assert.equal(o.mirror.costUsd, 400); assert.equal(o.mirror.pnlUsd, 70);
    assert.equal(o.mirror.status, 'closed'); assert.equal(o.mirror.stale, false);
    assert.ok(Math.abs(o.mirror.pnlPct - 17.5) < 1e-9);
    // watched actions: principal only, and they have already exited
    assert.equal(o.watch.inUsd, 400); assert.equal(o.watch.outUsd, 445);
    assert.equal(o.watch.pnlUsd, 45); assert.equal(o.watch.open, false);
  });

  // Manual position / one that existed before the bot: no target side at all,
  // and the drawer must be able to tell it apart from a target not yet researched.
  await t('target side: a position without a target -> empty origin', async () => {
    const x = await api('GET', '/api/position/history', {}, { id: '20' });
    assert.equal(x.position.target, null);
    assert.equal(x.position.origin.mirror, null); assert.equal(x.position.origin.watch, null);
    assert.equal(x.position.origin.targetLabel, null);
  });

  await t('position does not exist -> error', async () => {
    const x = await api('GET', '/api/position/history', {}, { id: '999' });
    assert.equal(x.error, 'posisi tidak ditemukan');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
