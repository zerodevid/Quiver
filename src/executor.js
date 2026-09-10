'use strict';
// Pembangun & pengirim transaksi. Menandatangani sendiri lalu kirim lewat RpcPool
// (tidak memakai JsonRpcProvider ethers karena transport kita perlu penyematan IP
// hasil DoH untuk menembus pembajakan DNS ISP).
//
// Encoding v4 di sini dicocokkan dengan calldata asli milik target di chain
// (tx 0x1283eeab… : actions 0x0111 = DECREASE_LIQUIDITY + TAKE_PAIR), bukan tebakan.
const { ethers } = require('ethers');
const fs = require('node:fs');
const { ADDR, ABI, ACT, CMD, SENTINEL, CHAIN_ID } = require('./chain');
const m = require('./v3math');

const coder = ethers.AbiCoder.defaultAbiCoder();
const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_ERC20 = new ethers.Interface(ABI.erc20);
const IF_PERMIT2 = new ethers.Interface(ABI.permit2);
const IF_UR = new ethers.Interface(ABI.universalRouter);

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const isNative = (a) => !a || /^0x0+$/.test(a);
const PK_TUPLE = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

function actionsHex(list) {
  return '0x' + list.map((a) => a.toString(16).padStart(2, '0')).join('');
}

class Executor {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    this.log = log || console.log;
    this.wallet = null;
    this.nonce = null;
    this.approved = new Set();
  }

  // ---- dompet -------------------------------------------------------------
  loadWallet() {
    if (this.wallet) return this.wallet;
    let pk = process.env.LPCOPY_PRIVATE_KEY || null;
    const f = this.cfg.wallet?.key_file;
    if (!pk && f && fs.existsSync(f.replace('~', process.env.HOME))) {
      const p = f.replace('~', process.env.HOME);
      const st = fs.statSync(p);
      if ((st.mode & 0o077) !== 0) throw new Error(`izin ${p} terlalu longgar — jalankan: chmod 600 ${p}`);
      pk = fs.readFileSync(p, 'utf8').trim();
    }
    if (!pk) return null;
    this.wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    return this.wallet;
  }
  address() { let w; try { w = this.loadWallet(); } catch { w = null; } return w ? w.address.toLowerCase() : null; }

  // Dipanggil setelah kunci diganti dari halaman Pengaturan.
  resetWallet() { this.wallet = null; this.nonce = null; this.approved.clear(); }

  keyPath() {
    const f = this.cfg.wallet?.key_file || '~/.lpcopy/key';
    return f.replace(/^~/, process.env.HOME);
  }

  // ---- pengiriman transaksi ----------------------------------------------
  async gasFees() {
    const gp = BigInt(await this.rpc.call('eth_gasPrice'));
    const mult = BigInt(Math.round((this.cfg.gas?.price_multiplier ?? 1.5) * 100));
    return { maxFeePerGas: (gp * mult) / 100n, maxPriorityFeePerGas: BigInt(this.cfg.gas?.priority_wei ?? 10_000_000) };
  }

  async estimateGas(tx) {
    const params = { from: this.address(), to: tx.to, data: tx.data };
    if (tx.value) params.value = '0x' + BigInt(tx.value).toString(16);
    const g = await this.rpc.call('eth_estimateGas', [params]);
    return BigInt(g);
  }

  // Simulasi murni: kembalikan {ok, error} tanpa mengirim apa pun.
  async simulate(tx) {
    try {
      const gas = await this.estimateGas(tx);
      return { ok: true, gas: gas.toString() };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 400) };
    }
  }

  async send(tx, { kind = 'lain', detail = null } = {}) {
    const w = this.loadWallet();
    if (!w) throw new Error('tidak ada kunci privat — mode kirim butuh wallet');
    const from = w.address;
    // Nonce dibaca ulang dari chain SETIAP kirim, bukan hanya sekali. Wallet ini bisa
    // dipakai program lain (bot robinhood-lp di server yang sama); nonce yang disimpan
    // di memori langsung basi begitu program itu mengirim satu transaksi.
    const pending = parseInt(await this.rpc.call('eth_getTransactionCount', [from, 'pending']), 16);
    this.nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
    const fees = await this.gasFees();
    let gasLimit;
    // gasMul: pengali batas gas. Default 1,3x; swap agregator butuh 2x karena router
    // menjalankan swap lewat panggilan tingkat rendah yang estimasinya kurang.
    const mul = BigInt(Math.round((tx.gasMul || 1.3) * 10));
    try { gasLimit = (await this.estimateGas(tx)) * mul / 10n; }
    catch (e) { throw new Error(`estimasi gas gagal (transaksi kemungkinan akan revert): ${e.message}`); }
    const capGas = BigInt(this.cfg.gas?.max_gas_limit ?? 4_000_000);
    if (gasLimit > capGas) gasLimit = capGas;

    const req = {
      chainId: CHAIN_ID, type: 2, to: tx.to, data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      nonce: this.nonce, gasLimit, ...fees,
    };
    const raw = await w.signTransaction(req);
    let hash;
    try {
      hash = await this.rpc.call('eth_sendRawTransaction', [raw]);
    } catch (e) {
      this.nonce = null;  // paksa sinkron ulang nonce di percobaan berikutnya
      throw e;
    }
    this.nonce++;
    this.store.run('INSERT OR REPLACE INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)',
      hash, Date.now(), kind, 'pending', detail ? JSON.stringify(detail) : null);
    return hash;
  }

  async waitReceipt(hash, timeoutMs = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await this.rpc.call('eth_getTransactionReceipt', [hash]);
      if (r) {
        const ok = BigInt(r.status) === 1n;
        this.store.run('UPDATE txs SET status=?, gas_used=?, gas_price=? WHERE hash=?',
          ok ? 'sukses' : 'gagal', parseInt(r.gasUsed, 16), r.effectiveGasPrice || null, hash);
        return { ok, receipt: r };
      }
      await new Promise((s) => setTimeout(s, 700));
    }
    return { ok: false, timeout: true };
  }

  // ---- izin token ---------------------------------------------------------
  // v4 PositionManager menarik token lewat Permit2: perlu ERC20.approve(permit2)
  // sekali, lalu permit2.approve(token, posm). v3 NPM menarik langsung.
  async ensureAllowance(token, { forV4 }) {
    if (isNative(token)) return [];
    const owner = this.address();
    const key = `${token}|${forV4 ? 'v4' : 'v3'}`;
    if (this.approved.has(key)) return [];
    const txs = [];
    if (forV4) {
      const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, ADDR.permit2]) }]);
      if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
        txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [ADDR.permit2, MAX_UINT256]), kind: 'approve_erc20' });
      }
      const [a2] = await this.rpc.ethCallMany([{ to: ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('allowance', [owner, token, ADDR.posmV4]) }]);
      let need = true;
      if (a2 && a2 !== '0x') {
        try {
          const d = IF_PERMIT2.decodeFunctionResult('allowance', a2);
          need = BigInt(d[0]) < MAX_UINT160 / 2n || BigInt(d[1]) < BigInt(Math.floor(Date.now() / 1000) + 86400);
        } catch { need = true; }
      }
      if (need) {
        txs.push({ to: ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('approve', [token, ADDR.posmV4, MAX_UINT160, MAX_UINT48]), kind: 'approve_permit2' });
      }
    } else {
      const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, ADDR.npmV3]) }]);
      if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
        txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [ADDR.npmV3, MAX_UINT256]), kind: 'approve_erc20' });
      }
    }
    if (!txs.length) this.approved.add(key);
    return txs;
  }

  // Izin untuk UniversalRouter (swap) — juga lewat Permit2.
  async ensureRouterAllowance(token) {
    if (isNative(token)) return [];
    const owner = this.address();
    const key = `${token}|ur`;
    if (this.approved.has(key)) return [];
    const txs = [];
    const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, ADDR.permit2]) }]);
    if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
      txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [ADDR.permit2, MAX_UINT256]), kind: 'approve_erc20' });
    }
    const [a2] = await this.rpc.ethCallMany([{ to: ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('allowance', [owner, token, ADDR.universalRouter]) }]);
    let need = true;
    if (a2 && a2 !== '0x') {
      try {
        const d = IF_PERMIT2.decodeFunctionResult('allowance', a2);
        need = BigInt(d[0]) < MAX_UINT160 / 2n || BigInt(d[1]) < BigInt(Math.floor(Date.now() / 1000) + 86400);
      } catch { need = true; }
    }
    if (need) txs.push({ to: ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('approve', [token, ADDR.universalRouter, MAX_UINT160, MAX_UINT48]), kind: 'approve_permit2' });
    if (!txs.length) this.approved.add(key);
    return txs;
  }

  // ---- saldo --------------------------------------------------------------
  async balances(tokens) {
    const owner = this.address();
    if (!owner) return new Map();
    const out = new Map();
    const erc = tokens.filter((t) => !isNative(t));
    if (tokens.some(isNative)) {
      out.set(ADDR.native, BigInt(await this.rpc.call('eth_getBalance', [owner, 'latest'])));
    }
    if (erc.length) {
      const res = await this.rpc.ethCallMany(erc.map((t) => ({ to: t, data: IF_ERC20.encodeFunctionData('balanceOf', [owner]) })));
      erc.forEach((t, i) => out.set(t.toLowerCase(), res[i] && res[i] !== '0x' ? BigInt(res[i]) : 0n));
    }
    return out;
  }

  // ---- v4: bangun calldata ------------------------------------------------
  buildV4Mint(plan, deadlineSec) {
    const pk = plan.poolKey;
    const owner = this.address();
    const params = [
      coder.encode([PK_TUPLE, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
        [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
          plan.tickLower, plan.tickUpper, plan.liquidity, plan.amount0Max, plan.amount1Max, owner, '0x']),
      coder.encode(['address', 'address'], [pk.currency0, pk.currency1]),
    ];
    const acts = [ACT.MINT_POSITION, ACT.SETTLE_PAIR];
    let value = 0n;
    if (isNative(pk.currency0)) {
      value = BigInt(plan.amount0Max);
      acts.push(ACT.SWEEP);
      params.push(coder.encode(['address', 'address'], [pk.currency0, owner]));
    }
    const unlockData = coder.encode(['bytes', 'bytes[]'], [actionsHex(acts), params]);
    return {
      to: ADDR.posmV4,
      data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]),
      value: value.toString(),
    };
  }

  // Tambah likuiditas ke posisi yang sudah ada: actions 0x000d (INCREASE + SETTLE_PAIR),
  // pola yang sama dipakai LP lain di chain ini.
  buildV4Increase(plan, deadlineSec) {
    const pk = plan.poolKey;
    const owner = this.address();
    const acts = [ACT.INCREASE_LIQUIDITY, ACT.SETTLE_PAIR];
    const params = [
      coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
        [plan.tokenId, plan.liquidity, plan.amount0Max, plan.amount1Max, '0x']),
      coder.encode(['address', 'address'], [pk.currency0, pk.currency1]),
    ];
    let value = 0n;
    if (isNative(pk.currency0)) {
      value = BigInt(plan.amount0Max);
      acts.push(ACT.SWEEP);
      params.push(coder.encode(['address', 'address'], [pk.currency0, owner]));
    }
    const unlockData = coder.encode(['bytes', 'bytes[]'], [actionsHex(acts), params]);
    return { to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]), value: value.toString() };
  }

  buildV3Increase(plan, deadlineSec) {
    return {
      to: ADDR.npmV3,
      data: IF_NPM.encodeFunctionData('increaseLiquidity', [[
        plan.tokenId, plan.amount0Max, plan.amount1Max, plan.amount0Min || 0, plan.amount1Min || 0, deadlineSec,
      ]]),
      value: '0',
    };
  }

  buildV4Decrease(plan, deadlineSec) {
    const pk = plan.poolKey;
    const owner = this.address();
    const full = plan.full;
    const acts = full ? [ACT.BURN_POSITION, ACT.TAKE_PAIR] : [ACT.DECREASE_LIQUIDITY, ACT.TAKE_PAIR];
    const params = [];
    if (full) {
      params.push(coder.encode(['uint256', 'uint128', 'uint128', 'bytes'],
        [plan.tokenId, plan.amount0Min || 0, plan.amount1Min || 0, '0x']));
    } else {
      params.push(coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
        [plan.tokenId, plan.liquidity, plan.amount0Min || 0, plan.amount1Min || 0, '0x']));
    }
    params.push(coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, owner]));
    const unlockData = coder.encode(['bytes', 'bytes[]'], [actionsHex(acts), params]);
    return { to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]), value: '0' };
  }

  // ---- v3 -----------------------------------------------------------------
  buildV3Mint(plan, deadlineSec) {
    const owner = this.address();
    return {
      to: ADDR.npmV3,
      data: IF_NPM.encodeFunctionData('mint', [[
        plan.token0, plan.token1, plan.fee, plan.tickLower, plan.tickUpper,
        plan.amount0Max, plan.amount1Max, plan.amount0Min || 0, plan.amount1Min || 0,
        owner, deadlineSec,
      ]]),
      value: '0',
    };
  }
  buildV3Decrease(plan, deadlineSec) {
    const owner = this.address();
    const calls = [
      IF_NPM.encodeFunctionData('decreaseLiquidity', [[plan.tokenId, plan.liquidity, plan.amount0Min || 0, plan.amount1Min || 0, deadlineSec]]),
      IF_NPM.encodeFunctionData('collect', [[plan.tokenId, owner, MAX_UINT160 >> 32n, MAX_UINT160 >> 32n]]),
    ];
    if (plan.full) calls.push(IF_NPM.encodeFunctionData('burn', [plan.tokenId]));
    return { to: ADDR.npmV3, data: IF_NPM.encodeFunctionData('multicall', [calls]), value: '0' };
  }

  // ---- swap lewat UniversalRouter ----------------------------------------
  // v4: V4_SWAP -> SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL
  buildSwapV4(poolKey, zeroForOne, amountIn, amountOutMin, deadlineSec) {
    const acts = actionsHex([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]);
    const inCur = zeroForOne ? poolKey.currency0 : poolKey.currency1;
    const outCur = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const params = [
      coder.encode([`tuple(${PK_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
        [[[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, amountOutMin, '0x']]),
      coder.encode(['address', 'uint256'], [inCur, amountIn]),
      coder.encode(['address', 'uint256'], [outCur, amountOutMin]),
    ];
    const input = coder.encode(['bytes', 'bytes[]'], [acts, params]);
    const commands = '0x' + CMD.V4_SWAP.toString(16).padStart(2, '0');
    return {
      to: ADDR.universalRouter,
      data: IF_UR.encodeFunctionData('execute', [commands, [input], deadlineSec]),
      value: isNative(inCur) ? String(amountIn) : '0',
    };
  }

  // v3: V3_SWAP_EXACT_IN(recipient, amountIn, amountOutMin, path, payerIsUser)
  buildSwapV3(tokenIn, tokenOut, fee, amountIn, amountOutMin, deadlineSec) {
    const owner = this.address();
    const path = ethers.concat([tokenIn, ethers.toBeHex(fee, 3), tokenOut]);
    const input = coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [owner, amountIn, amountOutMin, path, true]);
    const commands = '0x' + CMD.V3_SWAP_EXACT_IN.toString(16).padStart(2, '0');
    return {
      to: ADDR.universalRouter,
      data: IF_UR.encodeFunctionData('execute', [commands, [input], deadlineSec]),
      value: '0',
    };
  }

  // ---- bungkus/buka bungkus ETH ------------------------------------------
  // Lewat kontrak WETH9 langsung: deposit() tidak butuh izin apa pun, dan tidak ada
  // slippage — kurs selalu 1:1. Lebih murah dan lebih pasti daripada lewat router.
  buildWrapEth(amountWei) {
    const IF = new ethers.Interface(['function deposit() payable']);
    return { to: ADDR.weth, data: IF.encodeFunctionData('deposit'), value: String(amountWei) };
  }
  buildUnwrapWeth(amountWei) {
    const IF = new ethers.Interface(['function withdraw(uint256 wad)']);
    return { to: ADDR.weth, data: IF.encodeFunctionData('withdraw', [amountWei]), value: '0' };
  }

  deadline(sec = 300) { return Math.floor(Date.now() / 1000) + sec; }
}

module.exports = { Executor, isNative, actionsHex };
