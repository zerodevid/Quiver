// Isi wallet mana pun (target, wallet riset): token apa saja yang dipegang dan
// berapa saldonya. Melengkapi riset LP — posisi menceritakan cara dia bermain,
// portofolio menceritakan apa yang sedang dia pegang di luar posisi (hasil tutup
// yang belum dijual, token yang sedang ditimbun, kas ETH/USDG yang siap dipakai).
//
// Chain tidak punya "daftar token milik alamat X", jadi kandidatnya dirakit dari:
//   - aset kuotasi (ETH, USDG, WETH) — selalu dicek;
//   - token dari posisi LP yang pernah dia buka (tabel wpositions);
//   - semua token yang pernah dikenal bot (tabel tokens);
//   - log Transfer ERC-20 yang `to`-nya wallet ini (pindai bertahap, seperti
//     Manual.seenTokens untuk wallet bot).
// Lalu saldonya dibaca sekali dalam satu batch, dan hanya yang bersaldo yang dikembalikan.
const { ethers } = require('ethers');
const { ADDR, QUOTES, TOPIC, ABI } = require('./chain');
const { getLogsSafe } = require('./scout');

const IF_ERC20 = new ethers.Interface(ABI.erc20);
const lc = (t) => String(t || '').toLowerCase();
const isNative = (t) => lc(t) === ADDR.native;
// Jendela pindai pertama mengikuti bawaan riset wallet: 900 ribu blok (~1 hari).
const FIRST_WINDOW = 900_000;
// Pindai log paling cepat tiap 5 menit per wallet — getLogs adalah panggilan RPC
// yang paling berat, dan halaman detail target di-poll berulang.
const RESCAN_MS = 5 * 60_000;

class Holdings {
  constructor({ rpc, store, chain, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
  }

  // Token ERC-20 yang pernah MASUK ke wallet — dari log Transfer. Blok yang sudah
  // dilihat disimpan di state, jadi setelah pindai pertama tiap pemanggilan hanya
  // membaca blok baru. Kalau RPC gagal, daftar lama tetap dipakai.
  async seenTokens(wallet) {
    const key = `held_seen:${wallet}`;
    let st = { block: 0, ts: 0, tokens: [] };
    try { st = { ...st, ...JSON.parse(this.store.getState(key, '{}')) }; } catch { /* mulai dari nol */ }
    if (st.block && Date.now() - st.ts < RESCAN_MS) return st.tokens;
    try {
      const head = await this.rpc.blockNumber();
      const lo = st.block ? st.block + 1 : Math.max(0, head - FIRST_WINDOW);
      if (head >= lo) {
        const logs = await getLogsSafe(this.rpc, { topics: [TOPIC.transfer, null, ethers.zeroPadValue(wallet, 32)] }, lo, head);
        const set = new Set(st.tokens);
        // Transfer ERC-721 punya topik yang sama tapi tokenId-nya di topics[3];
        // ERC-20 memakai data untuk jumlahnya.
        for (const l of logs) if (l.topics.length === 3 && l.address) set.add(lc(l.address));
        st = { block: head, ts: Date.now(), tokens: [...set].slice(-300) };
        this.store.setState(key, JSON.stringify(st));
      }
    } catch (e) { this.log(`pindai token ${wallet}: ${e.message}`); }
    return st.tokens;
  }

  // Saldo `tokens` milik `owner` dalam satu batch (ETH native lewat eth_getBalance).
  async balances(owner, tokens) {
    const out = new Map();
    const erc = tokens.filter((t) => !isNative(t));
    if (tokens.some(isNative)) out.set(ADDR.native, BigInt(await this.rpc.call('eth_getBalance', [owner, 'latest'])));
    if (erc.length) {
      const res = await this.rpc.ethCallMany(erc.map((t) => ({ to: t, data: IF_ERC20.encodeFunctionData('balanceOf', [owner]) })));
      erc.forEach((t, i) => out.set(lc(t), res[i] && res[i] !== '0x' && res[i].length <= 66 ? BigInt(res[i]) : 0n));
    }
    return out;
  }

  // Daftar token bersaldo milik wallet, dengan metadata. ETH selalu ikut (kas),
  // token lain hanya kalau saldonya > 0.
  async of(wallet) {
    const w = lc(wallet);
    const set = new Set([ADDR.native, ADDR.usdg, ADDR.weth]);
    for (const r of this.store.all('SELECT DISTINCT token0, token1 FROM wpositions WHERE wallet=?', w)) {
      if (r.token0) set.add(lc(r.token0));
      if (r.token1) set.add(lc(r.token1));
    }
    for (const a of await this.seenTokens(w)) set.add(a);
    for (const r of this.store.all('SELECT address FROM tokens')) if (r.address) set.add(lc(r.address));
    const list = [...set];
    const bal = await this.balances(w, list);
    const keep = list.filter((a) => isNative(a) || (bal.get(a) || 0n) > 0n);
    // Metadata token yang bersaldo tapi belum dikenal dibaca dari chain (dan tersimpan).
    const metas = await this.chain.tokens(keep);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [lc(t.address), t]));
    return keep.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = bal.get(a) || 0n;
      const dec = meta.decimals ?? (QUOTES[a]?.decimals ?? 18);
      return {
        address: a, symbol: meta.symbol || QUOTES[a]?.symbol || a.slice(0, 8), name: meta.name || null, decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!QUOTES[a], native: isNative(a),
      };
    });
  }
}

module.exports = { Holdings };
