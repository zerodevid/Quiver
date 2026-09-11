'use strict';
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
const { ADDR } = require('./chain');

const DEFAULT_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'; // MetaAggregationRouterV2 (terverifikasi di chain 4663)
const DEFAULT_API = 'https://aggregator-api.kyberswap.com/robinhood/api/v1';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';        // sentinel Kyber untuk ETH native
const HEADERS = { 'x-client-id': 'quiver' };
const IF_ERC20 = new ethers.Interface([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
]);

const kTok = (t) => (String(t).toLowerCase() === ADDR.native ? NATIVE : t);

class Kyber {
  constructor({ exec, rpc, cfg, log }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.log = log || (() => {});
  }
  router() { return ethers.getAddress(this.cfg.swap?.kyber_router || DEFAULT_ROUTER); }
  api() { return this.cfg.swap?.kyber_api || DEFAULT_API; }
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

  // Rugi rute dalam bps menurut nilai USD Kyber sendiri (fee pool + dampak harga).
  static lossBps(q) {
    if (!q?.usdIn || !q?.usdOut || q.usdIn <= 0) return null;
    return ((q.usdIn - q.usdOut) / q.usdIn) * 10_000;
  }

  /**
   * Swap exact-in. Mengembalikan { hash, amountOut, quote } — amountOut diukur dari
   * selisih saldo, bukan dari kutipan. null kalau Kyber tidak bisa merutekan (pemanggil
   * boleh pakai cadangan). Melempar galat kalau pengaman gagal atau batas rugi terlampaui
   * — tidak pernah diam-diam mengirim sesuatu yang tidak aman.
   */
  async swap(tokenIn, tokenOut, amountIn, { slippageBps = 150, maxLossBps = null, kind = 'kyber_swap', detail = null } = {}) {
    if (!this.enabled() || amountIn <= 0n) return null;
    const me = this.exec.address();
    const nativeIn = String(tokenIn).toLowerCase() === ADDR.native;
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
        const r = await this.attempt(tokenIn, tokenOut, amountIn, { slippageBps: slip, maxLossBps, kind, detail, me, nativeIn });
        if (r || attempt === 2) return r;
      } catch (e) {
        lastErr = e;
        // Hanya harga basi yang layak diulang; gerbang keamanan & batas rugi tidak.
        if (!/Return amount is not enough|not enough|slippage|revert/i.test(e.message) || /router Kyber tidak cocok|nilai ETH tx|menyimpang|rugi/.test(e.message)) throw e;
        this.log(`swap Kyber percobaan ${attempt + 1} tertolak harga basi — kutipan ulang, toleransi ${(Math.min(slippageBps * (attempt + 2), maxLossBps || slippageBps * 3) / 100).toFixed(1)}%`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr || new Error('swap Kyber gagal setelah 3 percobaan');
  }

  async attempt(tokenIn, tokenOut, amountIn, { slippageBps, maxLossBps, kind, detail, me, nativeIn }) {
    // Rute kadang "tidak ditemukan" sesaat walau beberapa detik kemudian ada — coba 3 kali.
    let q = null, built = null;
    for (let i = 0; i < 3 && !built; i++) {
      q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q) built = await this.build(q.routeSummary, me, slippageBps);
      if (!built && i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    if (!q || !built) return null;

    const loss = Kyber.lossBps(q);
    if (maxLossBps != null && loss != null && loss > maxLossBps) {
      const e = new Error(`rute Kyber rugi ${(loss / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%) — $${q.usdIn?.toFixed(2)} → $${q.usdOut?.toFixed(2)}`);
      // Angkanya ikut dibawa supaya peringatan "sisa belum terjual" bisa menampilkan
      // nilai token vs yang bisa ditarik tanpa mengurai teks galat.
      e.loss = { lossBps: loss, maxLossBps, usdIn: q.usdIn ?? null, usdOut: q.usdOut ?? null, dex: q.dex || null };
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
    if (!rc.ok) throw new Error(`swap Kyber gagal (${hash})`);
    const after = await outBal();
    return { hash, amountOut: after > before ? after - before : 0n, quote: q, receipt: rc.receipt };
  }
}

module.exports = { Kyber, KYBER_NATIVE: NATIVE, DEFAULT_ROUTER };
