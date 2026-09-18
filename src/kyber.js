'use strict';
const { ensureChain } = require('./networks');
// Swap lewat agregator KyberSwap.
//
// Kenapa tidak langsung ke pool: diuji 2026-09-11 dengan simulasi eth_call dari wallet
// bot, dari 14 pool ETH/USDG hanya 2 yang menerima swap lewat UniversalRouter — sisanya
// ditolak hook-nya sendiri (WrappedError dari beforeSwap). Sebagian besar pool memecoin
// juga menolak (revert kosong di dalam callback). Kyber merutekan lintas SEMUA DEX dan
// pool di chain ini, dan jalurnya sudah terbukti di wallet yang sama oleh bot
// robinhood-lp. Jalur pool langsung tetap ada sebagai cadangan di engine.
//
// Calldata Kyber tidak bisa dibaca, jadi setiap swap melewati 4 pengaman sebelum dikirim
// (diadaptasi dari robinhood-lp-bot/src/chain/kyber.ts):
//   1. routerAddress hasil build HARUS sama dengan router yang di-whitelist; tx.to selalu
//      alamat whitelist itu, tidak pernah alamat dari API.
//   2. nilai ETH yang ikut dikirim == amountIn untuk ETH native, selain itu 0.
//   3. amountIn hasil build == amountIn yang diminta (tidak bisa belanja lebih).
//   4. amountOut hasil build >= kutipan − slippage (tidak bergeser saat di-encode).
const { ethers } = require('ethers');

const DEFAULT_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'; // MetaAggregationRouterV2 (terverifikasi di chain 4663)
const API_BASE = 'https://aggregator-api.kyberswap.com';          // + /<chain>/api/v1, chain = profil.kyberPath
const ZERO = '0x0000000000000000000000000000000000000000';       // native = currency 0x0 (sama di semua chain)
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';        // sentinel Kyber untuk ETH native
const HEADERS = { 'x-client-id': 'quiver' };
const IF_ERC20 = new ethers.Interface([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
]);

const kTok = (t) => (String(t).toLowerCase() === ZERO ? NATIVE : t);
// MetaAggregationRouterV2: dua pintu masuk, keduanya membawa SwapDescriptionV2 —
// diverifikasi dari calldata build sungguhan (2026-09-13: selector 0xe21fd0e9).
const DESC = 'tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit)';
const IF_ROUTER = new ethers.Interface([
  `function swap(tuple(address callTarget,address approveTarget,bytes targetData,${DESC} desc,bytes clientData) execution)`,
  `function swapSimpleMode(address caller,${DESC} desc,bytes executorData,bytes clientData)`,
]);
const sameTok = (a, b) => String(a).toLowerCase() === String(kTok(b)).toLowerCase();

class Kyber {
  constructor({ exec, rpc, cfg, chain, log }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.chain = ensureChain(chain); this.log = log || (() => {});
  }
  router() { return ethers.getAddress(this.cfg.swap?.kyber_router || DEFAULT_ROUTER); }
  api() { return this.cfg.swap?.kyber_api || `${API_BASE}/${this.chain?.kyberPath || 'robinhood'}/api/v1`; }
  enabled() { return this.cfg.swap?.kyber !== false; }

  // Kutipan rute terbaik. null kalau tidak ada rute (pemanggil boleh memakai cadangan).
  async quote(tokenIn, tokenOut, amountIn) {
    const u = new URL(`${this.api()}/routes`);
    u.searchParams.set('tokenIn', kTok(tokenIn));
    u.searchParams.set('tokenOut', kTok(tokenOut));
    u.searchParams.set('amountIn', amountIn.toString());
    u.searchParams.set('gasInclude', 'true');
    try {
      const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.code !== 0 || !j?.data?.routeSummary) return null;
      const rs = j.data.routeSummary;
      return {
        routeSummary: rs, routerAddress: j.data.routerAddress,
        amountOut: BigInt(rs.amountOut),
        usdIn: Number(rs.amountInUsd) || null, usdOut: Number(rs.amountOutUsd) || null,
        dex: [...new Set((rs.route || []).flat().map((h) => h.exchange))].join('+'),
      };
    } catch { return null; }
  }

  async build(routeSummary, sender, slippageBps) {
    try {
      const r = await fetch(`${this.api()}/route/build`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: slippageBps, source: 'quiver', enableGasEstimation: false }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.code !== 0 || !j?.data?.data) return null;
      return j.data;
    } catch { return null; }
  }

  // Isi calldata yang dikembalikan API: ke mana hasil swap dikirim, token apa, berapa
  // yang dibayar, dan minimum yang diterima. null kalau bentuknya tidak dikenal —
  // calldata yang tidak bisa dibaca tidak pernah dikirim.
  static inspect(data) {
    let p;
    try { p = IF_ROUTER.parseTransaction({ data }); } catch { return null; }
    if (!p) return null;
    const d = p.name === 'swap' ? p.args[0].desc : p.args[1];
    return { fn: p.name, srcToken: d.srcToken, dstToken: d.dstToken, dstReceiver: d.dstReceiver, amount: BigInt(d.amount), minReturn: BigInt(d.minReturnAmount) };
  }

  // Rugi rute dalam bps (fee pool + dampak harga), menurut nilai USD Kyber sendiri.
  //
  // `ref` = pembanding independen dari pemanggil, dipakai untuk sisi yang TIDAK dihargai
  // Kyber: { usdIn, usdPerOut, outDecimals }. Ini bukan hiasan. Kyber mengembalikan
  // amountInUsd/amountOutUsd kosong justru pada memecoin tipis yang paling butuh gerbang
  // batas rugi, dan dulu itu membuat fungsi ini mengembalikan null — sementara gerbangnya
  // menulis `loss != null && loss > batas`, jadi gerbang dilewati DIAM-DIAM. Diukur
  // 17 Sep 2026 atas 244 swap sejak modal mulai dicatat: 223 swap yang punya harga USD
  // meleset +0,4% dari taksiran harga tutup, 21 swap tanpa harga USD meleset −33,6%
  // (−$105; −$100 di antaranya dari satu posisi, #82, yang gerbangnya sempat menolak
  // berkali-kali di 42–57% lalu lolos begitu satu kutipan datang tanpa harga USD).
  //
  // Saat menjual sisa, sisi keluar SELALU bisa dinilai sendiri — token keluarnya aset
  // kuotasi — jadi satu sisi saja dari Kyber sudah cukup untuk mengukur.
  static routeLoss(q, ref = null) {
    if (!q) return null;
    const usdIn = (q.usdIn ?? ref?.usdIn) || null;
    const usdOut = q.usdOut ?? (ref?.usdPerOut != null && ref?.outDecimals != null
      ? (Number(q.amountOut) / 10 ** ref.outDecimals) * ref.usdPerOut
      : null);
    if (!(usdIn > 0) || usdOut == null) return null;
    return { bps: ((usdIn - usdOut) / usdIn) * 10_000, usdIn, usdOut };
  }
  static lossBps(q, ref = null) { return Kyber.routeLoss(q, ref)?.bps ?? null; }

  /**
   * Swap exact-in. Mengembalikan { hash, amountOut, quote } — amountOut diukur dari
   * selisih saldo, bukan dari kutipan. null kalau Kyber tidak bisa merutekan (pemanggil
   * boleh pakai cadangan). Melempar galat kalau pengaman gagal atau batas rugi terlampaui
   * — tidak pernah diam-diam mengirim sesuatu yang tidak aman.
   */
  async swap(tokenIn, tokenOut, amountIn, { slippageBps = 150, maxLossBps = null, kind = 'kyber_swap', detail = null, ref = null, requireLoss = false } = {}) {
    if (!this.enabled() || amountIn <= 0n) return null;
    const me = this.exec.address();
    const nativeIn = String(tokenIn).toLowerCase() === ZERO;
    // Kutipan Kyber cepat basi pada memecoin yang bergerak kencang: minOut sudah
    // terkunci di dalam calldata, jadi harga yang bergeser lebih dari slippage membuat
    // tx ditolak "Return amount is not enough". Ambil kutipan baru dan ulangi.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Toleransi dinaikkan bertahap HANYA saat mengulang: 1x, 2x, 3x. Percobaan
      // pertama tetap ketat supaya harga wajar tidak dikorbankan; pelonggaran hanya
      // dipakai kalau harga memang sedang bergerak cepat. Batas rugi rute (maxLossBps)
      // tidak ikut dilonggarkan, jadi rute yang buruk tetap ditolak.
      const slip = Math.min(slippageBps * (attempt + 1), maxLossBps || slippageBps * 3);
      try {
        const r = await this.attempt(tokenIn, tokenOut, amountIn, { slippageBps: slip, maxLossBps, kind, detail, me, nativeIn, ref, requireLoss });
        if (r || attempt === 2) return r;
      } catch (e) {
        lastErr = e;
        // Hanya harga basi yang layak diulang; gerbang keamanan & batas rugi tidak. Swap
        // yang REVERT di chain juga diulang (kutipan basi, #154 12 Sep: zap batal padahal
        // detik berikutnya rute yang sama lolos) — revert tidak memindahkan token apa pun.
        // Yang TIDAK pernah diulang: receipt belum terbaca (tx-nya mungkin masih masuk).
        if (e.pending) throw e;
        if (!(e.reverted || /Return amount is not enough|not enough|slippage|revert/i.test(e.message)) || /router Kyber tidak cocok|nilai ETH tx|menyimpang|rugi/.test(e.message)) throw e;
        this.log(`swap Kyber percobaan ${attempt + 1} tertolak harga basi — kutipan ulang, toleransi ${(Math.min(slippageBps * (attempt + 2), maxLossBps || slippageBps * 3) / 100).toFixed(1)}%`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr || new Error('swap Kyber gagal setelah 3 percobaan');
  }

  async attempt(tokenIn, tokenOut, amountIn, { slippageBps, maxLossBps, kind, detail, me, nativeIn, ref = null, requireLoss = false }) {
    // Rute kadang "tidak ditemukan" sesaat walau beberapa detik kemudian ada — coba 3 kali.
    let q = null, built = null;
    for (let i = 0; i < 3 && !built; i++) {
      q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q) built = await this.build(q.routeSummary, me, slippageBps);
      if (!built && i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    if (!q || !built) return null;

    const loss = Kyber.routeLoss(q, ref);
    // Tidak terukur = tidak dikirim, untuk pemanggil yang memintanya (penjualan otomatis).
    // "Tidak tahu ruginya berapa" bukan alasan sah membuang token tanpa batas; yang tidak
    // terukur masuk antrean coba-ulang dan dikabarkan, bukan dieksekusi buta.
    if (maxLossBps != null && requireLoss && !loss) {
      throw new Error('rugi rute tidak terukur (Kyber tanpa harga USD dan tanpa pembanding) — tidak dijual');
    }
    if (maxLossBps != null && loss && loss.bps > maxLossBps) {
      const e = new Error(`rute Kyber rugi ${(loss.bps / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%) — $${loss.usdIn.toFixed(2)} → $${loss.usdOut.toFixed(2)}`);
      // Angkanya ikut dibawa supaya peringatan "sisa belum terjual" bisa menampilkan
      // nilai token vs yang bisa ditarik tanpa mengurai teks galat.
      e.loss = { lossBps: loss.bps, maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut, dex: q.dex || null };
      throw e;
    }

    // ---- pengaman ----
    if (ethers.getAddress(built.routerAddress) !== this.router()) {
      throw new Error(`router Kyber tidak cocok: ${built.routerAddress} ≠ whitelist`);
    }
    const value = BigInt(built.transactionValue ?? '0');
    if (value !== (nativeIn ? amountIn : 0n)) throw new Error(`nilai ETH tx Kyber janggal: ${value}, seharusnya ${nativeIn ? amountIn : 0n}`);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (BigInt(built.amountIn) !== amountIn || BigInt(built.amountOut) < minOut) {
      throw new Error(`hasil build Kyber menyimpang (masuk ${built.amountIn}, keluar ${built.amountOut} < ${minOut})`);
    }
    // 5. Angka di atas cuma klaim API tentang dirinya sendiri. Yang dieksekusi adalah
    //    calldata-nya: dibaca dan dicocokkan — penerima hasil = wallet kita, token benar,
    //    jumlah bayar = amountIn, minimum terima ≥ kutipan − 2× slippage (build memakai
    //    amountOut-nya sendiri sebagai dasar minReturn). API yang berubah/dibajak tidak
    //    bisa mengarahkan hasil ke alamat lain atau mengosongkan minReturn.
    const cd = Kyber.inspect(built.data);
    if (!cd) throw new Error('calldata Kyber tidak dikenali — tidak dikirim');
    if (String(cd.dstReceiver).toLowerCase() !== String(me).toLowerCase()) throw new Error(`calldata Kyber janggal: penerima ${cd.dstReceiver} bukan wallet kita`);
    if (!sameTok(cd.srcToken, tokenIn) || !sameTok(cd.dstToken, tokenOut)) throw new Error(`calldata Kyber janggal: token ${cd.srcToken}→${cd.dstToken}`);
    if (cd.amount !== amountIn) throw new Error(`calldata Kyber janggal: jumlah bayar ${cd.amount} ≠ ${amountIn}`);
    const floor = (q.amountOut * BigInt(Math.max(0, 10_000 - 2 * slippageBps))) / 10_000n;
    if (cd.minReturn < floor) throw new Error(`calldata Kyber janggal: minimum terima ${cd.minReturn} < ${floor}`);

    // Izin token masuk: tepat sejumlah amountIn, langsung ke router whitelist.
    if (!nativeIn) {
      const [a] = await this.rpc.ethCallMany([{ to: tokenIn, data: IF_ERC20.encodeFunctionData('allowance', [me, this.router()]) }]);
      if (!a || BigInt(a) < amountIn) {
        const h = await this.exec.send({ to: tokenIn, data: IF_ERC20.encodeFunctionData('approve', [this.router(), amountIn]) }, { kind: 'approve_kyber' });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`izin token untuk Kyber gagal (${h})`);
      }
    }

    const outBal = async () => (await this.exec.balances([tokenOut])).get(String(tokenOut).toLowerCase()) || 0n;
    const before = await outBal();
    const tx = { to: this.router(), data: built.data, value: value.toString(), gasMul: 2 };
    const hash = await this.exec.send(tx, { kind, detail: { ...(detail || {}), dex: q.dex, usdIn: q.usdIn, usdOut: q.usdOut } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) {
      const e = new Error(`swap Kyber ${hash} belum terkonfirmasi setelah 90 detik`);
      e.pending = true; e.txHash = hash;
      throw e;
    }
    if (!rc.ok) { const e = new Error(`swap Kyber gagal (${hash})`); e.reverted = true; e.txHash = hash; throw e; }
    // Hasil dibaca dari log Transfer di receipt (pasti milik tx ini). Selisih saldo
    // hanya cadangan (ETH native): node yang tertinggal satu blok pernah memberi 0 —
    // dan 0 itu lalu tercatat sebagai "sisa terjual $0". Tidak terbaca = null, pemanggil
    // memakai kutipan Kyber sebagai taksiran, bukan nol.
    let amountOut = null;
    if (String(tokenOut).toLowerCase() !== ZERO) {
      const TOPIC_XFER = ethers.id('Transfer(address,address,uint256)');
      let v = 0n;
      for (const l of rc.receipt?.logs || []) {
        if (String(l.address).toLowerCase() !== String(tokenOut).toLowerCase() || l.topics[0] !== TOPIC_XFER || l.topics.length !== 3) continue;
        if (('0x' + l.topics[2].slice(-40)).toLowerCase() === String(me).toLowerCase()) v += BigInt(l.data);
        if (('0x' + l.topics[1].slice(-40)).toLowerCase() === String(me).toLowerCase()) v -= BigInt(l.data);
      }
      if (v > 0n) amountOut = v;
    }
    if (amountOut == null) {
      const after = await outBal();
      amountOut = after > before ? after - before : null;
    }
    // Yang benar-benar diterima vs yang dikutip — geseran harga saat eksekusi
    // (slippage murni, di luar fee rute). Dicatat di barisnya sendiri supaya
    // ongkos tiap posisi bisa menyebut angkanya, bukan cuma menaksir.
    if (amountOut != null && q.amountOut > 0n) {
      const slipBps = Number(((q.amountOut - amountOut) * 10_000n) / q.amountOut);
      this.exec.noteTx(hash, {
        quotedOut: q.amountOut.toString(), gotOut: amountOut.toString(), slipBps,
        // Nilai USD geserannya, memakai harga sisi keluar dari kutipan yang sama.
        execSlipUsd: q.usdOut != null ? (q.usdOut * slipBps) / 10_000 : null,
      });
    }
    return { hash, amountOut, quote: q, receipt: rc.receipt };
  }
}

module.exports = { Kyber, KYBER_NATIVE: NATIVE, DEFAULT_ROUTER };
