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
    // Penanda tx terakhir yang tercatat masuk blok (lihat waitReceipt): berapa kali
    // sudah terjadi, dan di blok berapa. Pembaca saldo yang di-cache (engine.cash)
    // membandingkan hitungannya untuk tahu bacaannya sudah basi.
    this.txSeq = 0;
    this.minedBlock = 0;
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
  // maxFeePerGas = gasPrice × pengali, TAPI tidak pernah di bawah 2× base fee blok
  // terbaru. eth_gasPrice dari endpoint yang tertinggal (ordofi bisa 2rb blok di
  // belakang) memberi harga basi; saat base fee melonjak, transaksinya ditolak
  // "max fee per gas less than block base fee" — terjadi pada entry 2026-09-12 14:39.
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
    // Batas atas (gas.max_fee_gwei, bawaan 10 gwei ≈ 100× harga normal chain ini). Tanpa
    // ini satu endpoint yang melaporkan eth_gasPrice/baseFee ngawur membuat maxFee ×
    // batas gas melampaui saldo: SEMUA tx ditolak "insufficient funds" — termasuk tx
    // keluar — dan cadangan gas dinamis melonjak (isi gas menukar USDG ke ETH). Kalau
    // base fee sungguhan di atas batas, tx-nya memang tidak akan masuk: dilempar dengan
    // pesan yang menunjuk ke pengaturannya.
    const cap = Executor.maxFeeCap(this.cfg);
    if (maxFeePerGas > cap) {
      if (base + prio > cap) throw new Error(`harga gas ${Executor.gwei(base)} gwei di atas batas gas.max_fee_gwei (${Executor.gwei(cap)}) — naikkan batasnya kalau memang sedang mahal`);
      maxFeePerGas = cap;
    }
    this.lastFees = { maxFeePerGas, maxPriorityFeePerGas: prio, ts: Date.now() };
    return { maxFeePerGas, maxPriorityFeePerGas: prio };
  }
  static maxFeeCap(cfg) {
    const g = Number(cfg?.gas?.max_fee_gwei);
    return BigInt(Math.round((Number.isFinite(g) && g > 0 ? g : 10) * 1e9));
  }
  static gwei(wei) { return String(Number((Number(wei) / 1e9).toPrecision(4))); }

  // Cadangan ETH native yang tidak boleh dipakai sebagai modal: cadangan dari config,
  // atau — kalau harga gas sedang tinggi — biaya SATU transaksi terberat (batas gas
  // maksimum × maxFeePerGas), mana yang lebih besar. Dengan cadangan tetap 0,002 ETH,
  // lonjakan base fee membuat entry ETH (yang memakai seluruh ETH di atas cadangan)
  // ditolak "insufficient funds for gas * price + value", dan yang lebih gawat:
  // transaksi KELUAR ikut tidak terkirim. Harga gas di-cache 30 detik.
  async gasReserve() {
    try {
      if (!(this.lastFees && Date.now() - this.lastFees.ts < 30_000)) await this.gasFees();
    } catch { /* harga gas tidak terbaca: pakai yang terakhir diketahui / cadangan tetap */ }
    return this.gasReserveCached();
  }

  // Versi sinkron untuk pemanggil yang tidak bisa menunggu (halaman manual): harga gas
  // terakhir yang diketahui (≤ 10 menit), selain itu cadangan tetap.
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

  // Simulasi murni: kembalikan {ok, error} tanpa mengirim apa pun.
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

  // Revert karena HARGA (kutipan basi, slippage) memang jawaban sah — mengulang estimasi
  // di detik berikutnya tidak mengubahnya; lapisan pemanggil (Kyber) yang mengutip ulang.
  static priceRevert(msg) {
    return /return amount|not enough|slippage|too little|too much requested|maximum ?amount|minimum ?amount|price ?slippage|insufficient ?output/i.test(String(msg || ''));
  }

  async sendTransaction(tx, { kind = 'lain', detail = null, guard = null } = {}) {
    if (guard && !guard()) throw new Error('transaksi otomatis dibatalkan karena pengaturan berubah');
    const w = this.loadWallet();
    if (!w) throw new Error('tidak ada kunci privat — mode kirim butuh wallet');
    const from = w.address;
    const waits = this.retryWaits || [1500, 3000];
    // gasMul: pengali batas gas. Default 1,3x; swap agregator butuh 2x karena router
    // menjalankan swap lewat panggilan tingkat rendah yang estimasinya kurang.
    const mul = BigInt(Math.round((tx.gasMul || 1.3) * 10));
    const capGas = BigInt(this.cfg.gas?.max_gas_limit ?? 4_000_000);
    // Estimasi yang revert TEPAT SETELAH approval/zap sering bukan revert sungguhan: kolam
    // RPC berpindah ke endpoint yang tertinggal beberapa blok (ordofi bisa ribuan blok) dan
    // di sana izin/saldo barunya belum ada. Empat mint v3 11–12 Sep gagal "STF" dua detik
    // setelah approval — dan token zap-nya lalu dijual rugi. Diulang dengan jeda dulu.
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

    // "nonce too low" = nonce itu sudah TERPAKAI di chain oleh tx lain (wallet ini juga
    // dipakai bot lain, atau nonce dibaca dari node tertinggal). Tx yang kita tandatangani
    // dengan nonce itu tidak akan pernah masuk, jadi aman ditandatangani ulang dengan nonce
    // baru — KECUALI tx yang memakai nonce itu ternyata tx kita sendiri dari percobaan
    // sebelumnya (dikirim ulang oleh pemanggil): itu dicek dulu, supaya tidak mint dua kali.
    for (let attempt = 0; ; attempt++) {
      // Nonce dibaca ulang dari chain SETIAP kirim, bukan hanya sekali. Wallet ini bisa
      // dipakai program lain (bot robinhood-lp di server yang sama); nonce yang disimpan
      // di memori langsung basi begitu program itu mengirim satu transaksi.
      const pending = parseInt(await this.rpc.call('eth_getTransactionCount', [from, 'pending']), 16);
      this.nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
      const fees = await this.gasFees();
      const req = {
        chainId: CHAIN_ID, type: 2, to: tx.to, data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        nonce: this.nonce, gasLimit, ...fees,
      };
      const raw = await w.signTransaction(req);
      if (guard && !guard()) throw new Error('transaksi otomatis dibatalkan karena pengaturan berubah');
      // Hash transaksi yang sudah ditandatangani sudah pasti, sebelum dikirim ke mana pun.
      // Ini yang membedakan "benar-benar gagal" dari "sudah masuk tapi jawabannya hilang".
      const hash0 = ethers.keccak256(raw);
      let hash;
      try {
        hash = this.rpc.sendRaw ? await this.rpc.sendRaw(raw) : await this.rpc.call('eth_sendRawTransaction', [raw]);
      } catch (e) {
        // Pengiriman disiarkan ke beberapa endpoint. Kalau siaran PERTAMA sudah masuk,
        // percobaan berikutnya menjawab "nonce too low"/"already known" — dan dulu itu
        // dianggap kegagalan, padahal transaksinya berhasil. Akibatnya fatal: posisi
        // benar-benar terbuka di chain tapi tidak pernah tercatat bot (terjadi pada
        // salinan pertama, 2026-09-10: mint $200 sukses, dicatat sebagai galat).
        // Jadi: tanya chain dulu sebelum menyerah.
        const landed = await this.txLanded(hash0);
        if (!landed) {
          e.txHash = hash0;   // pemanggil yang mengulang bisa memastikan tx ini memang tidak masuk
          const nonceLow = /nonce too low|nonce has already been used|invalid nonce|nonce.{0,20}(too small|expired)/i.test(e.message);
          if (!nonceLow) {
            // Nonce TIDAK dilepas: tx ini mungkin tetap masuk belakangan (semua endpoint
            // timeout padahal satu menerimanya). Kirim berikutnya memakai nonce yang sama,
            // jadi paling banyak satu dari keduanya yang bisa masuk.
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
      this.store.run('INSERT OR REPLACE INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)',
        hash, Date.now(), kind, 'pending', detail ? JSON.stringify(detail) : null);
      return hash;
    }
  }

  // Tx kita yang tadinya dianggap tidak masuk, dengan nonce ini, ternyata masuk?
  async priorLanded(nonce) {
    const cands = (this.recentUnlanded || []).filter((x) => x.nonce === nonce && Date.now() - x.ts < 30 * 60_000);
    for (const c of cands) if (await this.txLanded(c.hash, 2)) return c.hash;
    return null;
  }

  // Apakah transaksi dengan hash ini sudah dikenal chain? Diberi beberapa detik karena
  // endpoint yang menjawab bisa berbeda dari yang menerima siarannya.
  async txLanded(hash, tries = 6) {
    // tries kecil dipakai uji supaya cepat; produksi memakai bawaannya.
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
      // Endpoint sedang tumbang (429/500) bukan berarti transaksinya gagal: terus
      // tanya sampai batas waktu. Dulu satu galat RPC langsung dilempar ke pemanggil,
      // yang menganggap tx-nya gagal padahal sedang masuk.
      let r = null;
      try { r = await this.rpc.call('eth_getTransactionReceipt', [hash]); }
      catch (e) { this.log(`receipt ${hash.slice(0, 12)}… belum terbaca (${String(e.message).slice(0, 80)}) — coba lagi`); }
      if (r) {
        const ok = BigInt(r.status) === 1n;
        const gasUsed = parseInt(r.gasUsed, 16);
        const gasPrice = r.effectiveGasPrice || null;
        // Gas dalam USD dikunci di HARGA ETH SAAT ITU. Menghitungnya belakangan dari
        // harga hari ini membuat ongkos posisi lama ikut bergerak mengikuti ETH.
        const eth = typeof this.ethUsd === 'function' ? this.ethUsd() : null;
        const gasQuote = eth > 0 && gasPrice ? (Number(BigInt(gasUsed) * BigInt(gasPrice)) / 1e18) * eth : null;
        this.store.run('UPDATE txs SET status=?, gas_used=?, gas_price=?, gas_quote=COALESCE(?,gas_quote) WHERE hash=?',
          ok ? 'sukses' : 'gagal', gasUsed, gasPrice, gasQuote, hash);
        // Gagal pun membakar gas: saldo ETH berubah, kas yang di-cache ikut basi.
        this.txSeq++;
        this.minedBlock = Math.max(this.minedBlock, parseInt(r.blockNumber, 16) || 0);
        return { ok, receipt: r };
      }
      await new Promise((s) => setTimeout(s, 700));
    }
    return { ok: false, timeout: true };
  }

  // Tambahan catatan pada tx yang sudah tercatat (detail JSON digabung, bukan
  // ditimpa). Dipakai swap untuk menuliskan hasil sesungguhnya vs kutipannya —
  // angka itu baru diketahui sesudah receipt, saat barisnya sudah ada.
  noteTx(hash, patch) {
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', hash);
      if (!row) return;
      let d = {};
      try { d = JSON.parse(row.detail || '{}') || {}; } catch { d = {}; }
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, ...patch }), hash);
    } catch { /* catatan tambahan tidak boleh menggagalkan transaksi */ }
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
  async balances(tokens, block = 'latest') {
    const owner = this.address();
    if (!owner) return new Map();
    const out = new Map();
    const erc = tokens.filter((t) => !isNative(t));
    if (tokens.some(isNative)) {
      out.set(ADDR.native, BigInt(await this.rpc.call('eth_getBalance', [owner, block])));
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

  // Tambah likuiditas ke posisi yang sudah ada.
  //
  // INCREASE_LIQUIDITY sekaligus MENCAIRKAN fee yang sudah terkumpul di posisi itu: delta
  // tiap token = fee − yang disetor. Kalau fee di satu token lebih besar dari setorannya
  // (posisi di luar rentang: setoran satu sisi saja, fee di sisi lain positif), delta itu
  // POSITIF — dan SETTLE_PAIR (_getFullDebt) me-revert DeltaNotNegative. Dulu 0x000d
  // (INCREASE + SETTLE_PAIR) dipakai; entry "menambah posisi" seperti itu selalu gagal,
  // padahal zap-nya sudah terbayar. CLOSE_CURRENCY membayar kalau minus dan mengambil
  // kalau plus, jadi keduanya aman; kelebihan ETH native disapu balik.
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
    return { to: ADDR.posmV4, value: '0', data: IF_POSM.encodeFunctionData('modifyLiquidities', [unlock, deadlineSec]) };
  }

  buildV3Collect(plan) {
    return { to: ADDR.npmV3, value: '0', data: IF_NPM.encodeFunctionData('collect',
      [[plan.tokenId, this.address(), (1n << 128n) - 1n, (1n << 128n) - 1n]]) };
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
