'use strict';
// Panen fee otomatis: mode klaim (fee ditarik lalu sisi memecoin-nya dijual), compound
// untuk posisi v3, buku fee yang mengganti taksiran harga klaim dengan hasil jual
// sesungguhnya, dan sinyal "target mulai rajin panen".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { ADDR, ABI, TOPIC } = require('../src/chain');
const m = require('../src/v3math');
const coder = ethers.AbiCoder.defaultAbiCoder();
const ME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), POOL = '0x' + '33'.repeat(32);
const TARGET = '0x' + '44'.repeat(20), POOL3 = '0x' + '55'.repeat(20);

// Klaim mengirim 150000 memecoin + 150000 USDG ke wallet kita (dibaca dari receipt).
const transfer = (token, amount = 150000n) => ({ address: token,
  topics: [TOPIC.transfer, ethers.zeroPadValue(ADDR.poolManager, 32), ethers.zeroPadValue(ME, 32)],
  data: coder.encode(['uint256'], [amount]) });

function fixture({ venue = 'v4' } = {}) {
  const store = new Store(':memory:');
  const state = { owner: ME, fee0: 150000n, fee1: 150000n, notes: [] };
  const receipt = { status: '0x1', logs: [transfer(TOKEN), transfer(ADDR.usdg)], gasUsed: '0x100', effectiveGasPrice: '0x2', blockNumber: '0x10' };
  const rpc = {
    ethCallMany: async (calls) => (calls.length === 9
      ? [10n * m.Q128, 10n * m.Q128, 0n, 0n, 0n, 0n, 1_000_000n, 0n, 0n].map((n) => coder.encode(['uint256'], [n]))
      : calls.map(() => coder.encode(['address'], [state.owner]))),
    // unclaimedV3 membaca fee lewat eth_call collect() yang dikumpulkan rpc.batch.
    batch: async () => [{ result: coder.encode(['uint256', 'uint256'], [state.fee0, state.fee1]) }],
    call: async () => receipt,
  };
  const chain = {
    slot0V4: async () => ({ tick: 0, sqrtPriceX96: m.Q96 }),
    slot0V3: async () => ({ tick: 0, sqrtPriceX96: m.Q96 }),
    poolLiquidity: async () => 1n,
    tokens: async (list) => list.map((address) => ({ address, decimals: 6, symbol: address === ADDR.usdg ? 'USDG' : 'MEME' })),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0 + amount1) / 1e6, kind: 'usd' }),
  };
  const e = new Engine({ store, rpc, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  e.exec.address = () => ME;
  e.exec.ensureAllowance = async () => [];
  e.topUpGas = async () => {};
  e.poolKeyOf = async () => ({ currency0: TOKEN, currency1: ADDR.usdg, fee: 3000, tickSpacing: 60, hooks: ADDR.native });
  e.positions.sync = async () => {};
  e.positions.markSlotFor = async () => ({ sqrtPriceX96: m.Q96, tick: 0 });
  const kabar = [];
  e.onNotify = (msg, detail) => kabar.push({ msg, detail });
  const id = e.positions.record({ venue, poolRef: venue === 'v4' ? POOL : POOL3, token0: TOKEN, token1: ADDR.usdg,
    fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: '1000000',
    amount0: '5000000', amount1: '5000000', valueQuote: 10, quoteSymbol: 'USDG' },
  { tokenId: '123', target: TARGET });
  const sent = [];
  e.exec.send = async (tx, options) => {
    sent.push({ tx, ...options });
    const hash = '0x' + String(sent.length).padStart(64, '0');
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), options.kind, 'pending', JSON.stringify(options.detail));
    return hash;
  };
  e.exec.waitReceipt = async (hash) => {
    store.run('UPDATE txs SET status=? WHERE hash=?', 'sukses', hash);
    return { ok: true, receipt };
  };
  // Penjualan sisa/fee diwakili: yang diuji di sini antreannya, bukan swap-nya.
  const dijual = [];
  e.sellToken = async (item) => { dijual.push(item); return 'jual MEME'; };
  return { e, store, state, sent, dijual, kabar, id,
    pos: () => store.get('SELECT * FROM positions WHERE id=?', id), c: e.compound };
}

test('mode klaim menarik fee dan mengantre sisi memecoin ke aset kuotasi', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true, mode: 'claim', sellFee: true, minUsd: 0.2 });
    f.store.run('UPDATE positions SET fees_quote=? WHERE id=?', 0.3, f.id);
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'claim_fees');
    // Fee kedua sisi dibukukan di harga klaim…
    assert.equal(f.pos().claimed_quote, 0.3);
    assert.equal(f.pos().fees_quote, 0);
    // …dan HANYA sisi memecoin yang masuk buku fee + antrean jual.
    const buku = f.store.all('SELECT * FROM fee_leftovers');
    assert.equal(buku.length, 1);
    assert.equal(buku[0].token, TOKEN);
    assert.equal(buku[0].amount, '150000');
    assert.equal(buku[0].est_quote, 0.15);
    assert.equal(f.dijual.length, 1);
    assert.equal(f.dijual[0].token, TOKEN);
    assert.equal(f.dijual[0].quote, ADDR.usdg);
    assert.equal(f.dijual[0].kind, 'fee');
    assert.match(f.kabar.at(-1).msg, /panen fee posisi #/);
  } finally { f.store.db.close(); }
});

test('fee di bawah minimum tidak diklaim', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true, mode: 'claim', minUsd: 5 });
    f.store.run('UPDATE positions SET fees_quote=? WHERE id=?', 0.3, f.id);
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /minimum klaim/);
  } finally { f.store.db.close(); }
});

test('klaim manual tidak menjual apa pun kecuali diminta', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id);
    assert.equal(f.dijual.length, 0);
    assert.equal(f.store.all('SELECT * FROM fee_leftovers').length, 0);
    await f.e.claimFees(f.id, { sell: true });
    assert.equal(f.dijual.length, 1);
  } finally { f.store.db.close(); }
});

test('hasil jual fee menggantikan taksiran harga klaim, juga sesudah posisi ditutup', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id, { sell: false });
    assert.equal(f.pos().claimed_quote, 0.3);
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '150000', estQuote: 0.15 });
    // Laku $0,05 saja, bukan $0,15: taksirannya diganti hasil sesungguhnya.
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 150000n, quoteToken: ADDR.usdg,
      amountOut: '50000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().claimed_quote - 0.2) < 1e-9);
    assert.equal(f.store.get("SELECT amount FROM fee_leftovers").amount, '0');
    // Posisi tertutup: markClosed sudah melipat claimed_quote ke out_quote, jadi
    // koreksi berikutnya harus mengenai keduanya.
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '100000', estQuote: 0.1 });
    f.e.positions.markClosed(f.id, { out0: '0', out1: '0', outQuote: 1, txHash: null, exitSqrt: null });
    const sebelum = f.pos().out_quote;
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 100000n, quoteToken: ADDR.usdg,
      amountOut: '20000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().out_quote - (sebelum - 0.08)) < 1e-9);
  } finally { f.store.db.close(); }
});

test('memecoin fee yang hilang dari wallet berhenti memakai taksiran harga klaim', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id, { sell: false });
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '150000', estQuote: 0.15 });
    // Dijual di DEX lain / dikirim keluar: saldo wallet tinggal nol.
    f.e.positions.rpc = { ethCallMany: async (calls) => calls.map(() => coder.encode(['uint256'], [0n])) };
    f.e.positions.poolLiquidityOf = async () => 1n;
    await f.e.positions.refreshLeftovers(3000, ME);
    assert.equal(f.store.get('SELECT amount FROM fee_leftovers').amount, '0', 'buku fee ditutup');
    // Dinilai di harga pool sekarang (sama dengan harga klaim pada fixture ini).
    assert.ok(Math.abs(f.pos().claimed_quote - 0.3) < 1e-9);
  } finally { f.store.db.close(); }
});

test('satu penjualan dibagi antara buku fee dan buku sisa penutupan', async () => {
  const f = fixture();
  try {
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '100000', estQuote: 0.1 });
    f.e.positions.markClosed(f.id, { out0: '0', out1: '0', outQuote: 1, txHash: null, exitSqrt: null,
      left: { token: TOKEN, amount: '100000', quote: 0.1 } });
    const out0 = f.pos().out_quote, claimed0 = f.pos().claimed_quote;
    // 200000 token (100000 dari tiap buku) cuma laku 100000 USDG-unit = $0,10, jadi
    // tiap buku menerima $0,05 menggantikan taksiran $0,10-nya.
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 200000n, quoteToken: ADDR.usdg,
      amountOut: '100000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().claimed_quote - (claimed0 - 0.05)) < 1e-9, 'buku fee: taksiran 0,10 jadi hasil 0,05');
    // out_quote menanggung keduanya: koreksi buku fee (posisi sudah tertutup) −0,05
    // dan koreksi sisa penutupan −0,05.
    assert.ok(Math.abs(f.pos().out_quote - (out0 - 0.1)) < 1e-9);
    assert.equal(f.pos().left_amount, '0');
    assert.equal(f.store.get('SELECT amount FROM fee_leftovers').amount, '0');
  } finally { f.store.db.close(); }
});

test('compound v3 memakai multicall collect + increaseLiquidity', async () => {
  const f = fixture({ venue: 'v3' });
  try {
    f.state.fee0 = 5_000_000n; f.state.fee1 = 5_000_000n;
    assert.equal(f.c.status(f.pos()).supported, true);
    f.c.configure(f.id, { enabled: true, mode: 'compound', minUsd: 1 });
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'compound');
    const iface = new ethers.Interface(ABI.npmV3);
    const [calls] = iface.decodeFunctionData('multicall', f.sent[0].tx.data);
    assert.equal(calls.length, 2);
    const collect = iface.decodeFunctionData('collect', calls[0])[0];
    assert.equal(collect[0], 123n);
    assert.equal(collect[1].toLowerCase(), ME);
    const inc = iface.decodeFunctionData('increaseLiquidity', calls[1])[0];
    assert.equal(inc[0], 123n);
    assert.ok(inc[1] > 0n && inc[2] > 0n, 'kedua sisi fee dipakai');
    assert.ok(inc[3] <= inc[1] && inc[4] <= inc[2], 'mins tidak melebihi yang diminta');
    assert.equal(f.store.all('SELECT * FROM compound_runs').length, 1);
  } finally { f.store.db.close(); }
});

test('panen target dicatat, tidak dicermin, dan berbunyi kalau berulang', async () => {
  const f = fixture();
  try {
    f.store.run('INSERT INTO targets(chain,address,enabled,added_ts) VALUES(?,?,1,?)', 'robinhood', TARGET, Date.now());
    f.store.run('UPDATE positions SET mirror_of=? WHERE id=?', '777', f.id);
    const aksi = (i) => {
      const r = f.store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, 'robinhood', Date.now(), 100 + i, '0x' + String(i).padStart(64, '0'), i,
      TARGET, 'v4', 'claim', '777', POOL);
      return f.e.actFromRow(f.store.get('SELECT * FROM actions WHERE id=?', Number(r.lastInsertRowid)));
    };
    for (let i = 1; i <= 2; i++) await f.e.handle(aksi(i));
    assert.equal(f.sent.length, 0, 'klaim target tidak pernah memicu transaksi');
    assert.equal(f.kabar.length, 0, 'sekali-dua kali panen itu biasa');
    const putusan = f.store.all('SELECT * FROM decisions ORDER BY id');
    assert.equal(putusan.length, 2);
    assert.equal(putusan[0].verdict, 'skip');
    assert.match(putusan[1].reason, /panen fee/);
    await f.e.handle(aksi(3));
    assert.equal(f.kabar.length, 1);
    assert.match(f.kabar[0].msg, /3× dalam 24 jam/);
    assert.equal(f.kabar[0].detail.kind, 'target_claim');
    assert.equal(f.kabar[0].detail.positionId, f.id);
    // Didiamkan sesudah berbunyi: panen keempat tidak mengulang kabar yang sama.
    await f.e.handle(aksi(4));
    assert.equal(f.kabar.length, 1);
  } finally { f.store.db.close(); }
});
