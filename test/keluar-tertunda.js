'use strict';
// Uji: posisi yang likuiditasnya nol di chain tanpa tercatat tutup TIDAK dibukukan $0
// kalau hasilnya bisa ditemukan.
//
// Kasus nyata (12 Sep): #45 ($110) ditarik manual lewat Uniswap → sinkron melihat
// likuiditas 0 → ditutup dengan out_quote 0 = "rugi $110", padahal 112 USDG masuk wallet.
// Kasus kedua: tx keluar bot terkirim, receipt gagal dibaca (RPC tumbang) → posisi
// tetap terbuka → sinkron berikutnya menutupnya $0 dengan cara yang sama.
//
// Jalankan: node test/keluar-tertunda.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Positions } = require('../src/positions');
const { ADDR, TOPIC } = require('../src/chain');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const ME = '0x' + '11'.repeat(20);
const TX = '0x' + 'c1'.repeat(32), TX_OLD = '0x' + 'c0'.repeat(32);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const sqrt = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));
const xfer = (token, from, to, v) => ({ address: token, topics: [TOPIC.transfer, pad(from), pad(to)], data: hex(v) });
// receipt tarik: 112 USDG (+ MEME opsional) masuk ke wallet
const receipt = ({ usdg = 112_000_000n, meme = 0n, status = '0x1' } = {}) => ({
  status, gasUsed: '0x0', effectiveGasPrice: '0x0',
  logs: [xfer(ADDR.usdg, ADDR.poolManager, ME, usdg), ...(meme ? [xfer(MEME, ADDR.poolManager, ME, meme)] : [])],
});
const modLog = (tokenId, delta, txHash, block) => ({
  address: ADDR.poolManager, topics: [TOPIC.modifyLiquidity, POOL, pad(ME)], transactionHash: txHash, blockNumber: '0x' + block.toString(16),
  data: '0x' + [hex(0).slice(2), hex(0).slice(2), hex(BigInt.asUintN(256, delta)).slice(2), hex(tokenId).slice(2)].join(''),
});

// st.liq: likuiditas #1 di chain; st.receipts: hash -> receipt|null; st.logs: log ModifyLiquidity
function dunia(st) {
  const store = new Store(':memory:');
  const e = Object.create(Engine.prototype);
  e.store = store; e.cfg = { loop: {} }; e.ethUsd = 2500; e.exiting = new Set(); e.stats = { errors: 0 };
  e.log = () => {}; e.notified = [];
  e.notify = (msg, d) => e.notified.push({ msg, d });
  e.rulesFrom = () => ({ exit: { sell_leftover: false }, swap: {} });
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    token: async (a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 }),
    slot0V4: async () => ({ sqrtPriceX96: sqrt, tick: 0 }),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrt, tick: 0 })),
    poolLiquidity: async () => 1n, poolLiquidityMany: async (ids) => ids.map(() => 1n),
    markSqrtForPair: async () => null,
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 / 1000, kind: 'usd' }),
  };
  e.chain = chain;
  e.rpc = {
    ethCallMany: async (calls) => calls.map((c) => (c.to === ADDR.posmV4 ? hex(st.liq) : hex(0))),
    call: async (m, p) => {
      if (m === 'eth_getTransactionReceipt') { if (st.rpcDown) throw new Error('429'); return st.receipts[p[0]] ?? null; }
      if (m === 'eth_blockNumber') return '0x' + (10_000).toString(16);
      throw new Error('tidak diharapkan: ' + m);
    },
    getLogs: async (f) => {
      st.getLogsCalls = (st.getLogsCalls || 0) + 1;
      if (st.logsDown) throw new Error('semua endpoint tumbang');
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return (st.logs || []).filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
    },
  };
  e.exec = { address: () => ME, balances: async (l) => new Map(l.map((a) => [a, 0n])) };
  e.positions = new Positions({ rpc: e.rpc, store, chain, log: () => {} });
  store.setState('wallet_address', ME);
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,cost1,quote_symbol,liquidity,target,mirror_of)
    VALUES('v4',?,'77',?,?,-100,100,'open',?,110,'110000000','USDG','5000000',?,'99')`, POOL, ADDR.usdg, MEME, Date.now() - 60_000, '0x' + '22'.repeat(20));
  return { e, store, id: Number(r.lastInsertRowid), st };
}
const pos = (d) => d.store.get('SELECT * FROM positions WHERE id=?', d.id);
const txRow = (d, kind, hash, detail) => d.store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), kind, 'pending', JSON.stringify(detail));

(async () => {
  console.log('keluar-tertunda:');

  await t('tarikan manual (tanpa tx bot): hasil dicari dari log ModifyLiquidity, bukan $0', async () => {
    const d = dunia({ liq: 0n, receipts: { [TX]: receipt() }, logs: [modLog(77n, 5_000_000n, TX_OLD, 9000), modLog(77n, -5_000_000n, TX, 9900)] });
    await d.e.positions.sync(2500);
    const [trig] = d.e.positions.exitTriggers({ exit: {} });
    assert.ok(trig?.pos.empty, 'terbaca kosong');
    await d.e.closeEmptyPosition(trig.pos);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX);
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `out_quote ${p.out_quote}`);
    assert.ok(d.e.notified.some((n) => /dicatat dari log ModifyLiquidity/.test(n.msg)));
  });

  await t('log ModifyLiquidity posisi LAIN di pool yang sama diabaikan', async () => {
    const d = dunia({ liq: 0n, receipts: { [TX]: receipt() }, logs: [modLog(78n, -5_000_000n, TX, 9900)], logsDown: false });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, null);
    assert.strictEqual(p.out_quote, 0);
    assert.ok(d.e.notified.some((n) => /tidak ditemukan/.test(n.msg)), 'pemilik dikabari');
  });

  await t('tx keluar bot yang receipt-nya belum terbaca: penutupan DITUNDA, bukan $0', async () => {
    const d = dunia({ liq: 0n, receipts: {} });
    txRow(d, 'burn', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    assert.strictEqual(pos(d).status, 'open');
    assert.strictEqual(d.st.getLogsCalls || 0, 0, 'tidak perlu getLogs: tx-nya sudah diketahui');
    // receipt akhirnya terbaca → dibukukan dari receipt
    d.st.receipts[TX] = receipt();
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX);
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `out_quote ${p.out_quote}`);
  });

  await t('tarik sebagian yang tidak terbukukan (receipt gagal) dibukukan belakangan oleh bookPendingExits', async () => {
    const d = dunia({ liq: 3_000_000n, receipts: {}, rpcDown: true });
    txRow(d, 'decrease', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();                       // RPC masih tumbang: tidak apa-apa
    assert.strictEqual(pos(d).out_quote, 0);
    d.st.rpcDown = false; d.st.receipts[TX] = receipt({ usdg: 40_000_000n });
    await d.e.bookPendingExits();
    let p = pos(d);
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.liquidity, '3000000');
    assert.ok(Math.abs(p.out_quote - 40) < 1e-6, `out_quote ${p.out_quote}`);
    // tidak dibukukan dua kali
    await d.e.bookPendingExits();
    p = pos(d);
    assert.ok(Math.abs(p.out_quote - 40) < 1e-6, `dobel: ${p.out_quote}`);
    // tx tarik sebagian yang SUDAH dibukukan tidak dipakai lagi untuk menutup: hasil tutup dicari dari log
    d.st.liq = 0n; d.st.logs = [modLog(77n, -3_000_000n, TX_OLD, 9950)]; d.st.receipts[TX_OLD] = receipt({ usdg: 70_000_000n });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX_OLD);
    assert.ok(Math.abs(p.out_quote - 110) < 1e-6, `total out ${p.out_quote}`);
  });

  await t('tx keluar yang revert ditandai gagal dan tidak dibukukan', async () => {
    const d = dunia({ liq: 5_000_000n, receipts: { [TX]: receipt({ status: '0x0' }) } });
    txRow(d, 'burn', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();
    assert.strictEqual(pos(d).status, 'open');
    assert.strictEqual(d.store.get('SELECT status FROM txs WHERE hash=?', TX).status, 'gagal');
  });

  await t('posisi yang sedang dalam proses keluar tidak disentuh', async () => {
    const d = dunia({ liq: 0n, receipts: { [TX]: receipt() } });
    txRow(d, 'burn', TX, { position: d.id });
    d.e.exiting.add(d.id);
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();
    assert.strictEqual(pos(d).status, 'open');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
