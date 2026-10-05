'use strict';
const { ensureChain } = require('./networks');
// Transaction builder & sender. Signs itself then sends through the RpcPool
// (does not use ethers' JsonRpcProvider because our transport needs DoH IP pinning
// to get through ISP DNS hijacking).
//
// The v4 encoding here is matched against the target's real calldata on chain
// (tx 0x1283eeab… : actions 0x0111 = DECREASE_LIQUIDITY + TAKE_PAIR), not a guess.
const { ethers } = require('ethers');
const fs = require('node:fs');
const { ABI, ACT, CMD, SENTINEL } = require('./chain');
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
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    this.log = log || console.log;
    this.wallet = null;
    this.nonce = null;
    this.approved = new Set();
    // Marker of the last tx recorded as landed in a block (see waitReceipt): how many times
    // it has happened, and at which block. A cached balance reader (engine.cash)
    // compares its count to know its read has gone stale.
    this.txSeq = 0;
    this.minedBlock = 0;
    // The v4 swap params shape that this chain's router accepts — see buildSwapV4.
    // null = not yet proven; the pool picker simulates both shapes.
    this.v4Layout = null;
  }

  // ---- wallet -------------------------------------------------------------
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

  // Called after the key is replaced from the Settings page.
  resetWallet() { this.wallet = null; this.nonce = null; this.approved.clear(); }

  keyPath() {
    const f = this.cfg.wallet?.key_file || '~/.lpcopy/key';
    return f.replace(/^~/, process.env.HOME);
  }

  // ---- sending transactions ----------------------------------------------
  // maxFeePerGas = gasPrice × multiplier, BUT never below 2× the latest block's base
  // fee. eth_gasPrice from a lagging endpoint (ordofi can be 2k blocks
  // behind) gives a stale price; when the base fee spikes, the transaction is rejected
  // "max fee per gas less than block base fee" — happened on the 2026-09-12 14:39 entry.
  async gasFees() {
    const [gpr, blk] = await this.rpc.batch([
      { method: 'eth_gasPrice' }, { method: 'eth_getBlockByNumber', params: ['latest', false] },
    ]);
    if (!gpr || gpr.error || !gpr.result) throw new Error(`eth_gasPrice: ${gpr?.error?.message || 'tidak ada balasan'}`);
    const gp = BigInt(gpr.result);
    const mult = BigInt(Math.round((this.cfg.gas?.price_multiplier ?? 1.5) * 100));
    const prio = BigInt(this.cfg.gas?.priority_wei ?? 10_000_000);
    let maxFeePerGas = (gp * mult) / 100n;
    const base = blk?.result?.baseFeePerGas ? BigInt(blk.result.baseFeePerGas) : 0n;
    if (base * 2n + prio > maxFeePerGas) maxFeePerGas = base * 2n + prio;
    // A chain whose base fee is always 0 (BSC): the effective gas price of a type-2 tx = its tip alone,
    // so the tip must be as high as the gas price the network asks for — a tip of 0.01 gwei will
    // never be included by BSC validators (minimum ~0.1 gwei).
    const legacy = !!this.chain?.legacyGasPricing;
    // Upper bound (gas.max_fee_gwei, default 10 gwei ≈ 100× this chain's normal price). Without
    // this, a single endpoint reporting a nonsense eth_gasPrice/baseFee makes maxFee ×
    // gas limit exceed the balance: ALL txs are rejected "insufficient funds" — including exit
    // txs — and the dynamic gas reserve spikes (gas top-up swaps USDG to ETH). If the
    // real base fee is above the limit, the tx would not land anyway: thrown with a
    // message pointing to the setting.
    const cap = Executor.maxFeeCap(this.cfg);
    if (maxFeePerGas > cap) {
      if (base + prio > cap) throw new Error(`harga gas ${Executor.gwei(base)} gwei di atas batas gas.max_fee_gwei (${Executor.gwei(cap)}) — naikkan batasnya kalau memang sedang mahal`);
      maxFeePerGas = cap;
    }
    const tip = legacy ? maxFeePerGas : prio;
    this.lastFees = { maxFeePerGas, maxPriorityFeePerGas: tip, ts: Date.now() };
    return { maxFeePerGas, maxPriorityFeePerGas: tip };
  }
  static maxFeeCap(cfg) {
    const g = Number(cfg?.gas?.max_fee_gwei);
    return BigInt(Math.round((Number.isFinite(g) && g > 0 ? g : 10) * 1e9));
  }
  static gwei(wei) { return String(Number((Number(wei) / 1e9).toPrecision(4))); }

  // Native ETH reserve that must not be used as capital: the reserve from the config,
  // or — if the gas price is currently high — the cost of ONE heaviest transaction (maximum
  // gas limit × maxFeePerGas), whichever is larger. With a fixed reserve of 0.002 ETH,
  // a base fee spike makes ETH entries (which use all ETH above the reserve)
  // get rejected "insufficient funds for gas * price + value", and what is worse:
  // EXIT transactions are also not sent. The gas price is cached for 30 seconds.
  async gasReserve() {
    try {
      if (!(this.lastFees && Date.now() - this.lastFees.ts < 30_000)) await this.gasFees();
    } catch { /* gas price unreadable: use the last known one / the fixed fallback */ }
    return this.gasReserveCached();
  }

  // Synchronous version for callers that cannot wait (the manual page): the last
  // known gas price (≤ 10 minutes), otherwise the fixed reserve.
  gasReserveCached() {
    const fixed = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    const f = this.lastFees && Date.now() - this.lastFees.ts < 600_000 ? this.lastFees : null;
    if (!f) return fixed;
    const dyn = BigInt(this.cfg.gas?.max_gas_limit ?? 4_000_000) * f.maxFeePerGas;
    return dyn > fixed ? dyn : fixed;
  }

  async estimateGas(tx) {
    const params = { from: this.address(), to: tx.to, data: tx.data };
    if (tx.value) params.value = '0x' + BigInt(tx.value).toString(16);
    const g = await this.rpc.call('eth_estimateGas', [params]);
    return BigInt(g);
  }

  // Pure simulation: return {ok, error} without sending anything.
  async simulate(tx) {
    try {
      const gas = await this.estimateGas(tx);
      return { ok: true, gas: gas.toString() };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 400) };
    }
  }

  send(tx, options = {}) {
    // Auto-compound, manual actions and the copier share one signer/nonce.
    const run = (this.sendQueue || Promise.resolve()).then(() => this.sendTransaction(tx, options));
    this.sendQueue = run.catch(() => {});
    return run;
  }

  // A revert because of PRICE (stale quote, slippage) is a legitimate answer — repeating the estimate
  // in the next second does not change it; the caller layer (Kyber) re-quotes.
  static priceRevert(msg) {
    return /return amount|not enough|slippage|too little|too much requested|maximum ?amount|minimum ?amount|price ?slippage|insufficient ?output/i.test(String(msg || ''));
  }

  async sendTransaction(tx, { kind = 'lain', detail = null, guard = null } = {}) {
    if (guard && !guard()) throw new Error('transaksi otomatis dibatalkan karena pengaturan berubah');
    const w = this.loadWallet();
    if (!w) throw new Error('tidak ada kunci privat — mode kirim butuh wallet');
    const from = w.address;
    const waits = this.retryWaits || [1500, 3000];
    // gasMul: gas limit multiplier. Default 1.3x; an aggregator swap needs 2x because the router
    // runs the swap through low-level calls whose estimate falls short.
    const mul = BigInt(Math.round((tx.gasMul || 1.3) * 10));
    const capGas = BigInt(this.cfg.gas?.max_gas_limit ?? 4_000_000);
    // An estimate that reverts RIGHT AFTER an approval/zap is often not a real revert: the RPC pool
    // switched to an endpoint lagging several blocks (ordofi can be thousands of blocks) and
    // there the new allowance/balance does not exist yet. Four v3 mints on 11–12 Sep failed "STF" two seconds
    // after the approval — and the zap token was then sold at a loss. Retried after a pause first.
    let gasLimit;
    for (let i = 0; ; i++) {
      try { gasLimit = (await this.estimateGas(tx)) * mul / 10n; break; }
      catch (e) {
        if (i >= waits.length || Executor.priceRevert(e.message)) {
          throw new Error(`estimasi gas gagal (transaksi kemungkinan akan revert): ${e.message}`);
        }
        this.log(`estimasi gas ${kind} gagal (${String(e.message).slice(0, 80)}) — mungkin node tertinggal, coba lagi`);
        await new Promise((r) => setTimeout(r, waits[i]));
      }
    }
    if (gasLimit > capGas) gasLimit = capGas;

    // "nonce too low" = that nonce has already been USED on chain by another tx (this wallet is also
    // used by other bots, or the nonce was read from a lagging node). A tx we signed
    // with that nonce will never land, so it is safe to re-sign with a new
    // nonce — EXCEPT if the tx that used that nonce turns out to be our own from an earlier
    // attempt (resent by the caller): that is checked first, so there is no double mint.
    for (let attempt = 0; ; attempt++) {
      // The nonce is re-read from the chain on EVERY send, not just once. This wallet can be
      // used by other programs (the robinhood-lp bot on the same server); a nonce stored
      // in memory goes stale the moment that program sends a single transaction.
      const pending = parseInt(await this.rpc.call('eth_getTransactionCount', [from, 'pending']), 16);
      this.nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
      const fees = await this.gasFees();
      const req = {
        chainId: this.chain.CHAIN_ID, type: 2, to: tx.to, data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        nonce: this.nonce, gasLimit, ...fees,
      };
      const raw = await w.signTransaction(req);
      if (guard && !guard()) throw new Error('transaksi otomatis dibatalkan karena pengaturan berubah');
      // The hash of a signed transaction is certain, before it is sent anywhere.
      // This is what distinguishes "really failed" from "landed but the answer was lost".
      const hash0 = ethers.keccak256(raw);
      let hash;
      try {
        hash = this.rpc.sendRaw ? await this.rpc.sendRaw(raw) : await this.rpc.call('eth_sendRawTransaction', [raw]);
      } catch (e) {
        // A send is broadcast to several endpoints. If the FIRST broadcast already landed,
        // later attempts answer "nonce too low"/"already known" — and that used to be
        // treated as a failure, although the transaction succeeded. The result was fatal: a position
        // really open on chain but never recorded by the bot (happened on the
        // first copy, 2026-09-10: the $200 mint succeeded, recorded as an error).
        // So: ask the chain first before giving up.
        const landed = await this.txLanded(hash0);
        if (!landed) {
          e.txHash = hash0;   // a retrying caller can be sure this tx really did not land
          const nonceLow = /nonce too low|nonce has already been used|invalid nonce|nonce.{0,20}(too small|expired)/i.test(e.message);
          if (!nonceLow) {
            // The nonce is NOT released: this tx may still land later (all endpoints
            // timed out although one accepted it). The next send uses the same nonce,
            // so at most one of the two can land.
            this.recentUnlanded = [...(this.recentUnlanded || []), { hash: hash0, nonce: req.nonce, ts: Date.now() }].slice(-10);
            throw e;
          }
          const mine = await this.priorLanded(req.nonce);
          if (mine) {
            const err = new Error(`nonce ${req.nonce} sudah dipakai transaksi kita sebelumnya ${mine.slice(0, 12)}… yang ternyata masuk — tidak dikirim ulang`);
            err.priorLanded = mine;
            this.nonce = null;
            throw err;
          }
          this.nonce = null;
          if (attempt >= 2) throw e;
          this.log(`kirim ${kind}: ${String(e.message).slice(0, 80)} — nonce disinkron ulang, kirim lagi`);
          await new Promise((r) => setTimeout(r, waits[Math.min(attempt, waits.length - 1)] || 0));
          continue;
        }
        this.log(`kirim dijawab galat (${String(e.message).slice(0, 60)}) tetapi transaksi ${hash0.slice(0, 12)}… SUDAH masuk — dilanjutkan`);
        hash = hash0;
      }
      this.nonce = req.nonce + 1;
      this.store.run('INSERT OR REPLACE INTO txs(chain,hash,ts,kind,status,detail) VALUES(?,?,?,?,?,?)',
        this.chain.network, hash, Date.now(), kind, 'pending', detail ? JSON.stringify(detail) : null);
      return hash;
    }
  }

  // Did our tx that was thought not to have landed, with this nonce, actually land?
  async priorLanded(nonce) {
    const cands = (this.recentUnlanded || []).filter((x) => x.nonce === nonce && Date.now() - x.ts < 30 * 60_000);
    for (const c of cands) if (await this.txLanded(c.hash, 2)) return c.hash;
    return null;
  }

  // Is a transaction with this hash already known to the chain? Given a few seconds because
  // the endpoint that answers can differ from the one that received the broadcast.
  async txLanded(hash, tries = 6) {
    // a small tries is used by tests so they are fast; production uses the default.
    for (let i = 0; i < tries; i++) {
      try {
        const tx = await this.rpc.call('eth_getTransactionByHash', [hash]);
        if (tx) return true;
      } catch { /* endpoint sedang bermasalah: coba lagi */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }

  async waitReceipt(hash, timeoutMs = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      // An endpoint being down (429/500) does not mean the transaction failed: keep
      // asking until the time limit. A single RPC error used to be thrown straight to the caller,
      // which assumed the tx failed while it was actually landing.
      let r = null;
      try { r = await this.rpc.call('eth_getTransactionReceipt', [hash]); }
      catch (e) { this.log(`receipt ${hash.slice(0, 12)}… belum terbaca (${String(e.message).slice(0, 80)}) — coba lagi`); }
      if (r) {
        const ok = BigInt(r.status) === 1n;
        const gasUsed = parseInt(r.gasUsed, 16);
        const gasPrice = r.effectiveGasPrice || null;
        // Gas in USD is locked at the ETH PRICE AT THAT TIME. Computing it later from
        // today's price makes the cost of old positions move along with ETH.
        const eth = typeof this.ethUsd === 'function' ? this.ethUsd() : null;
        const gasQuote = eth > 0 && gasPrice ? (Number(BigInt(gasUsed) * BigInt(gasPrice)) / 1e18) * eth : null;
        this.store.run('UPDATE txs SET status=?, gas_used=?, gas_price=?, gas_quote=COALESCE(?,gas_quote) WHERE hash=?',
          ok ? 'sukses' : 'gagal', gasUsed, gasPrice, gasQuote, hash);
        // A failure burns gas too: the ETH balance changes, the cached cash goes stale as well.
        this.txSeq++;
        this.minedBlock = Math.max(this.minedBlock, parseInt(r.blockNumber, 16) || 0);
        return { ok, receipt: r };
      }
      await new Promise((s) => setTimeout(s, 700));
    }
    return { ok: false, timeout: true };
  }

  // An addition to the note of an already recorded tx (the JSON detail is merged, not
  // overwritten). Used by swaps to write the actual result vs the quote —
  // that figure is only known after the receipt, when the row already exists.
  noteTx(hash, patch) {
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', hash);
      if (!row) return;
      let d = {};
      try { d = JSON.parse(row.detail || '{}') || {}; } catch { d = {}; }
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, ...patch }), hash);
    } catch { /* an extra note must not fail the transaction */ }
  }

  // ---- token allowances ---------------------------------------------------
  // The v4 PositionManager pulls tokens via Permit2: needs ERC20.approve(permit2)
  // once, then permit2.approve(token, posm). The v3 NPM pulls directly.
  async ensureAllowance(token, { forV4, venue = 'v3' }) {
    if (isNative(token)) return [];
    const owner = this.address();
    const npm = this.chain.npmFor(venue);
    const key = `${token}|${forV4 ? 'v4' : venue}`;
    if (this.approved.has(key)) return [];
    const txs = [];
    if (forV4) {
      const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, this.chain.ADDR.permit2]) }]);
      if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
        txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [this.chain.ADDR.permit2, MAX_UINT256]), kind: 'approve_erc20' });
      }
      const [a2] = await this.rpc.ethCallMany([{ to: this.chain.ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('allowance', [owner, token, this.chain.ADDR.posmV4]) }]);
      let need = true;
      if (a2 && a2 !== '0x') {
        try {
          const d = IF_PERMIT2.decodeFunctionResult('allowance', a2);
          need = BigInt(d[0]) < MAX_UINT160 / 2n || BigInt(d[1]) < BigInt(Math.floor(Date.now() / 1000) + 86400);
        } catch { need = true; }
      }
      if (need) {
        txs.push({ to: this.chain.ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('approve', [token, this.chain.ADDR.posmV4, MAX_UINT160, MAX_UINT48]), kind: 'approve_permit2' });
      }
    } else {
      const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, npm]) }]);
      if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
        txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [npm, MAX_UINT256]), kind: 'approve_erc20' });
      }
    }
    if (!txs.length) this.approved.add(key);
    return txs;
  }

  // Allowance for the UniversalRouter (swap) — also via Permit2.
  async ensureRouterAllowance(token) {
    if (isNative(token)) return [];
    const owner = this.address();
    const key = `${token}|ur`;
    if (this.approved.has(key)) return [];
    const txs = [];
    const [a1] = await this.rpc.ethCallMany([{ to: token, data: IF_ERC20.encodeFunctionData('allowance', [owner, this.chain.ADDR.permit2]) }]);
    if (!a1 || BigInt(a1) < MAX_UINT256 / 2n) {
      txs.push({ to: token, data: IF_ERC20.encodeFunctionData('approve', [this.chain.ADDR.permit2, MAX_UINT256]), kind: 'approve_erc20' });
    }
    const [a2] = await this.rpc.ethCallMany([{ to: this.chain.ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('allowance', [owner, token, this.chain.ADDR.universalRouter]) }]);
    let need = true;
    if (a2 && a2 !== '0x') {
      try {
        const d = IF_PERMIT2.decodeFunctionResult('allowance', a2);
        need = BigInt(d[0]) < MAX_UINT160 / 2n || BigInt(d[1]) < BigInt(Math.floor(Date.now() / 1000) + 86400);
      } catch { need = true; }
    }
    if (need) txs.push({ to: this.chain.ADDR.permit2, data: IF_PERMIT2.encodeFunctionData('approve', [token, this.chain.ADDR.universalRouter, MAX_UINT160, MAX_UINT48]), kind: 'approve_permit2' });
    if (!txs.length) this.approved.add(key);
    return txs;
  }

  // ---- balances -----------------------------------------------------------
  async balances(tokens, block = 'latest') {
    const owner = this.address();
    if (!owner) return new Map();
    const out = new Map();
    const erc = tokens.filter((t) => !isNative(t));
    if (tokens.some(isNative)) {
      out.set(this.chain.ADDR.native, BigInt(await this.rpc.call('eth_getBalance', [owner, block])));
    }
    if (erc.length) {
      const res = await this.rpc.ethCallMany(erc.map((t) => ({ to: t, data: IF_ERC20.encodeFunctionData('balanceOf', [owner]) })), block);
      erc.forEach((t, i) => {
        if (!res[i] || !/^0x[0-9a-fA-F]{64}$/.test(res[i])) {
          throw new Error(`gagal membaca saldo token ${t} dari RPC`);
        }
        out.set(t.toLowerCase(), BigInt(res[i]));
      });
    }
    return out;
  }

  // ---- v4: build calldata ------------------------------------------------
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
      to: this.chain.ADDR.posmV4,
      data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]),
      value: value.toString(),
    };
  }

  // Add liquidity to an existing position.
  //
  // INCREASE_LIQUIDITY also CASHES OUT the fees already accumulated in that position: each
  // token's delta = fee − what is deposited. If the fee in one token is larger than its deposit
  // (a position out of range: a one-sided deposit, the fee on the other side positive),
  // that delta is POSITIVE — and SETTLE_PAIR (_getFullDebt) reverts DeltaNotNegative. 0x000d
  // (INCREASE + SETTLE_PAIR) used to be used; an "add to position" entry like that always failed,
  // although the zap had already been paid for. CLOSE_CURRENCY pays if negative and takes
  // if positive, so both are safe; the excess native ETH is swept back.
  buildV4Increase(plan, deadlineSec) {
    const pk = plan.poolKey;
    const owner = this.address();
    const acts = [ACT.INCREASE_LIQUIDITY, ACT.CLOSE_CURRENCY, ACT.CLOSE_CURRENCY];
    const params = [
      coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
        [plan.tokenId, plan.liquidity, plan.amount0Max, plan.amount1Max, '0x']),
      coder.encode(['address'], [pk.currency0]),
      coder.encode(['address'], [pk.currency1]),
    ];
    let value = 0n;
    if (isNative(pk.currency0)) {
      value = BigInt(plan.amount0Max);
      acts.push(ACT.SWEEP);
      params.push(coder.encode(['address', 'address'], [pk.currency0, owner]));
    }
    const unlockData = coder.encode(['bytes', 'bytes[]'], [actionsHex(acts), params]);
    return { to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]), value: value.toString() };
  }

  buildV3Increase(plan, deadlineSec) {
    return {
      to: this.chain.npmFor(plan.venue),
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
    return { to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlockData, deadlineSec]), value: '0' };
  }

  buildV4Collect(plan, deadlineSec) {
    return this.buildV4Decrease({ ...plan, liquidity: '0', full: false, amount0Min: 0, amount1Min: 0 }, deadlineSec);
  }

  // Fixed liquidity + TAKE_PAIR only: accrued fees fund the increase atomically.
  // A token deficit reverts; there is no SETTLE, Permit2 pull, or native deposit.
  buildV4Compound(plan, deadlineSec) {
    const pk = plan.poolKey;
    const params = [
      coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
        [plan.tokenId, plan.liquidity, plan.amount0Max, plan.amount1Max, '0x']),
      coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, this.address()]),
    ];
    const unlock = coder.encode(['bytes', 'bytes[]'], [actionsHex([ACT.INCREASE_LIQUIDITY, ACT.TAKE_PAIR]), params]);
    return { to: this.chain.ADDR.posmV4, value: '0', data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlock, deadlineSec]) };
  }

  // v3 has no "increase from fees" like v4: the fees must be withdrawn first. A single
  // NPM multicall does both in ONE transaction — collect sends the fees to the
  // wallet, increaseLiquidity pulls them back via transferFrom (so the NPM needs an
  // ERC20 allowance for both tokens). What does not fit the LP ratio stays in the wallet.
  buildV3Compound(plan, deadlineSec) {
    const owner = this.address();
    const calls = [
      IF_NPM.encodeFunctionData('collect', [[plan.tokenId, owner, MAX_UINT160 >> 32n, MAX_UINT160 >> 32n]]),
      IF_NPM.encodeFunctionData('increaseLiquidity', [[plan.tokenId, plan.amount0Max, plan.amount1Max,
        plan.amount0Min || 0, plan.amount1Min || 0, deadlineSec]]),
    ];
    return { to: this.chain.npmFor(plan.venue), data: IF_NPM.encodeFunctionData('multicall', [calls]), value: '0' };
  }

  buildV3Collect(plan) {
    return { to: this.chain.npmFor(plan.venue), value: '0', data: IF_NPM.encodeFunctionData('collect',
      [[plan.tokenId, this.address(), (1n << 128n) - 1n, (1n << 128n) - 1n]]) };
  }

  // ---- v3 -----------------------------------------------------------------
  buildV3Mint(plan, deadlineSec) {
    const owner = this.address();
    return {
      to: this.chain.npmFor(plan.venue),
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
    return { to: this.chain.npmFor(plan.venue), data: IF_NPM.encodeFunctionData('multicall', [calls]), value: '0' };
  }

  // ---- swap via the UniversalRouter ----------------------------------------
  // v4: V4_SWAP -> SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL
  //
  // `layout` = the shape of IV4Router.ExactInputSingleParams the router uses. There are TWO
  // in circulation: 'limit' (old) carries `uint160 sqrtPriceLimitX96` between
  // amountOutMinimum and hookData, 'plain' (v4-periphery late 2024) drops it.
  // v4-periphery reads params via raw calldata offsets, not abi.decode, so
  // the wrong shape never gives a message: the swap reverts with NO data at
  // all. Measured 2026-09-24 on Robinhood Chain: the 'plain' shape reverted 0x on 12
  // different pools, 'limit' passed simulation on all of them — which is why the zap fallback via a
  // direct pool always ended in "all pools refuse the swap". The shape is not guessed
  // from the chain name; the pool picker (swappool.js) simulates both then
  // remembers the accepted one via rememberV4Layout.
  buildSwapV4(poolKey, zeroForOne, amountIn, amountOutMin, deadlineSec, layout = this.v4Layout || 'limit') {
    const acts = actionsHex([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]);
    const inCur = zeroForOne ? poolKey.currency0 : poolKey.currency1;
    const outCur = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const key = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
    // Price limit = the end of the legal range for its direction (without a limit of its own). An old
    // router that ignores it is not harmed; one that honours it needs a legal value.
    const limit = zeroForOne ? m.MIN_SQRT_RATIO + 1n : m.MAX_SQRT_RATIO - 1n;
    const params = [
      layout === 'limit'
        ? coder.encode([`tuple(${PK_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)`],
          [[key, zeroForOne, amountIn, amountOutMin, limit, '0x']])
        : coder.encode([`tuple(${PK_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
          [[key, zeroForOne, amountIn, amountOutMin, '0x']]),
      coder.encode(['address', 'uint256'], [inCur, amountIn]),
      coder.encode(['address', 'uint256'], [outCur, amountOutMin]),
    ];
    const input = coder.encode(['bytes', 'bytes[]'], [acts, params]);
    const commands = '0x' + CMD.V4_SWAP.toString(16).padStart(2, '0');
    return {
      to: this.chain.ADDR.universalRouter,
      data: IF_UR.encodeFunctionData('execute', [commands, [input], deadlineSec]),
      value: isNative(inCur) ? String(amountIn) : '0',
    };
  }

  // The shapes that must be tried when simulating a v4 swap: the proven one if
  // already known, otherwise both (a single eth_call batch, not guesswork).
  v4SwapLayouts() { return this.v4Layout ? [this.v4Layout] : ['limit', 'plain']; }
  rememberV4Layout(layout) {
    if (!layout || this.v4Layout === layout) return;
    this.v4Layout = layout;
    this.log(`swap v4 lewat router: bentuk params '${layout}'${layout === 'limit' ? ' (lama, dengan sqrtPriceLimit)' : ' (baru)'}`);
  }

  // v3: V3_SWAP_EXACT_IN(recipient, amountIn, amountOutMin, path, payerIsUser)
  buildSwapV3(tokenIn, tokenOut, fee, amountIn, amountOutMin, deadlineSec) {
    const owner = this.address();
    const path = ethers.concat([tokenIn, ethers.toBeHex(fee, 3), tokenOut]);
    const input = coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [owner, amountIn, amountOutMin, path, true]);
    const commands = '0x' + CMD.V3_SWAP_EXACT_IN.toString(16).padStart(2, '0');
    return {
      to: this.chain.ADDR.universalRouter,
      data: IF_UR.encodeFunctionData('execute', [commands, [input], deadlineSec]),
      value: '0',
    };
  }

  // ---- wrap/unwrap ETH ------------------------------------------
  // Directly via the WETH9 contract: deposit() needs no allowance, and there is no
  // slippage — the rate is always 1:1. Cheaper and more certain than via the router.
  buildWrapEth(amountWei) {
    const IF = new ethers.Interface(['function deposit() payable']);
    return { to: this.chain.ADDR.weth, data: IF.encodeFunctionData('deposit'), value: String(amountWei) };
  }
  buildUnwrapWeth(amountWei) {
    const IF = new ethers.Interface(['function withdraw(uint256 wad)']);
    return { to: this.chain.ADDR.weth, data: IF.encodeFunctionData('withdraw', [amountWei]), value: '0' };
  }

  deadline(sec = 300) { return Math.floor(Date.now() / 1000) + sec; }
}

module.exports = { Executor, isNative, actionsHex };
