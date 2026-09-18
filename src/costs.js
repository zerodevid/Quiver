'use strict';
// Ongkos jalan sebuah posisi: gas yang terbakar dan selisih swap ("slippage"),
// dipisah antara saat MEMBUKA dan saat MENUTUP.
//
// Kenapa perlu: PnL posisi cuma membandingkan modal dengan hasil. Yang tidak
// terlihat di situ adalah biaya untuk sampai ke sana — beberapa transaksi gas
// (approve, zap, mint, burn, jual sisa) dan selisih tiap swap antara nilai yang
// masuk dan yang keluar. Di chain ini gas satu posisi ~$0,3 dan selisih swap bisa
// $0,4–1 per posisi: pada posisi $100 itu sekitar 1%, cukup untuk membalik posisi
// yang "untung tipis" menjadi rugi. Angkanya dipisah open/close supaya terbaca
// bagian mana yang mahal.
//
// Semua diturunkan dari tabel `txs` yang sudah ada — tidak ada kolom baru:
//   gas   = gas_used × gas_price (termasuk transaksi yang REVERT: gasnya tetap terbakar)
//   slip  = usdIn − usdOut dari kutipan Kyber yang disimpan di detail tiap swap
//           (fee pool + dampak harga + geseran harga saat eksekusi)
//
// Transaksi ditautkan ke posisi lewat detail yang memang sudah ditulis mesin
// (position / recorded / plan.positionId / positionSales), lewat tx_open & tx_close
// posisinya, dan lewat keputusan yang menaut ke posisi. Transaksi pembantu — approve,
// wrap/unwrap, zap, isi gas — tidak menyebut nomor posisi apa pun, jadi ia diikutkan
// ke transaksi BERTUAN pertama sesudahnya (approve selalu mendahului swap/mint yang
// membutuhkannya, dalam alur yang sama). Itu taksiran, bukan bukti: ongkos yang
// tampil ditandai sebagai perkiraan.

// Fase menurut jenis transaksi. Yang tidak ada di sini (approve, wrap, isi gas)
// mewarisi fase transaksi bertuan pertama sesudahnya.
const OPEN_KIND = new Set(['mint', 'increase']);
const CLOSE_KIND = new Set(['burn', 'decrease', 'sell_leftover']);
// Transaksi pembantu: tidak pernah jadi jangkar, selalu ikut yang sesudahnya.
const HELPER_KIND = new Set(['approve_erc20', 'approve_permit2', 'approve_kyber', 'approve_router',
  'wrap_eth', 'unwrap_weth', 'gas_topup', 'zap_swap', 'bridge_swap']);
// Batas waktu pembantu boleh diikutkan ke transaksi sesudahnya. Satu alur masuk
// (approve → zap → approve → mint) selesai dalam hitungan detik sampai menit;
// approve yatim dari alur yang batal tidak boleh dibebankan ke posisi lain.
const HELPER_GAP_MS = 15 * 60_000;

const parse = (d) => { try { return JSON.parse(d || '{}') || {}; } catch { return {}; } };
const empty = () => ({ gasUsd: 0, slipUsd: 0, routeUsd: 0, execUsd: 0, txN: 0 });
const emptyCost = () => ({
  open: empty(), close: empty(), lain: empty(),
  gasUsd: 0, slipUsd: 0, routeUsd: 0, execUsd: 0, totalUsd: 0, txN: 0, hashes: [],
});

const gasEthOf = (t) => (t.gas_used && t.gas_price ? Number(BigInt(t.gas_used) * BigInt(t.gas_price)) / 1e18 : 0);
// Gas dalam USD: yang dibukukan saat receipt (harga ETH saat itu) kalau ada,
// selain itu dihitung dengan harga ETH sekarang — tx lama belum menyimpannya.
const gasUsdOf = (t, ethUsd) => (t.gas_quote != null ? Number(t.gas_quote) : gasEthOf(t) * ethUsd);

// Ongkos swap dalam USD, dua bagian yang berbeda asalnya:
//   route = kutipan masuk − kutipan keluar (fee pool + dampak harga rute)
//   exec  = kutipan keluar − yang benar-benar diterima (geseran harga saat eksekusi)
// Negatif (dapat lebih banyak dari taksiran) dibiarkan apa adanya — menolkannya
// membuat total ongkos selalu terlihat lebih mahal dari kenyataan.
function swapCostOf(d) {
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0);
  const route = d.usdIn != null && d.usdOut != null ? num(d.usdIn) - num(d.usdOut) : 0;
  return { route, exec: num(d.execSlipUsd) };
}

class Costs {
  constructor(store, network = 'robinhood') { this.store = store; this.network = network; this.cache = null; }

  // Dihitung sekali untuk SEMUA posisi lalu di-cache: tabel posisi dipoll tiap
  // beberapa detik dan menghitung per posisi berarti memindai txs berulang kali.
  // Cache batal begitu ada transaksi baru/berubah (jumlah baris + waktu terakhir).
  map(ethUsd) {
    const sig = this.store.get('SELECT COUNT(*) n, COALESCE(MAX(ts),0) last, COALESCE(SUM(gas_used),0) gas FROM txs WHERE chain=?', this.network);
    // Harga ETH dibulatkan ke dolar penuh: ia hanya dipakai untuk transaksi lama yang
    // belum menyimpan gas dalam USD, jadi tidak perlu menghitung ulang tiap sen.
    const key = `${sig?.n}:${sig?.last}:${sig?.gas}:${Math.round(ethUsd || 0)}`;
    if (this.cache?.key === key) return this.cache.map;
    const map = this.compute(ethUsd || 0);
    this.cache = { key, map };
    return map;
  }

  of(id, ethUsd) { return this.map(ethUsd).get(id) || emptyCost(); }

  compute(ethUsd) {
    const store = this.store;
    const out = new Map();
    const bucket = (id) => {
      let c = out.get(id);
      if (!c) { c = emptyCost(); out.set(id, c); }
      return c;
    };
    const positions = store.all('SELECT id, token_id, venue, pool_ref, tx_open, tx_close FROM positions WHERE chain=?', this.network);
    if (!positions.length) return out;
    const byOpenTx = new Map(), byCloseTx = new Map(), byToken = new Map();
    for (const p of positions) {
      if (p.tx_open) byOpenTx.set(p.tx_open, p.id);
      if (p.tx_close) byCloseTx.set(p.tx_close, p.id);
      if (p.token_id) byToken.set(`${p.venue}:${p.token_id}`, p.id);
    }
    const byDecision = new Map(store.all('SELECT tx_hash, position_id FROM decisions WHERE position_id IS NOT NULL AND tx_hash IS NOT NULL')
      .map((d) => [d.tx_hash, d.position_id]));
    const txs = store.all('SELECT hash, ts, kind, status, gas_used, gas_price, gas_quote, detail FROM txs WHERE chain=? ORDER BY ts', this.network);

    // 1) jangkar: transaksi yang jelas milik posisi tertentu
    const anchor = new Array(txs.length).fill(null);   // {ids:[], phase}
    txs.forEach((t, i) => {
      if (HELPER_KIND.has(t.kind)) return;
      const d = parse(t.detail);
      const ids = [];
      if (Number.isInteger(d.position)) ids.push(d.position);
      if (Number.isInteger(d.recorded)) ids.push(d.recorded);
      if (Number.isInteger(d.plan?.positionId)) ids.push(d.plan.positionId);
      if (byOpenTx.has(t.hash)) ids.push(byOpenTx.get(t.hash));
      if (byCloseTx.has(t.hash)) ids.push(byCloseTx.get(t.hash));
      if (byDecision.has(t.hash)) ids.push(byDecision.get(t.hash));
      if (d.plan?.tokenId != null) {
        const hit = byToken.get(`${d.plan.venue || 'v4'}:${d.plan.tokenId}`);
        if (hit) ids.push(hit);
      }
      // Satu penjualan sisa bisa menutup beberapa posisi sekaligus: ongkosnya dibagi rata.
      for (const s of d.positionSales || []) if (Number.isInteger(s.position)) ids.push(s.position);
      const uniq = [...new Set(ids)];
      if (!uniq.length) return;
      // Klaim fee, compound, swap manual: ongkos posisi ini juga, tapi bukan ongkos
      // membuka maupun menutup — dikumpulkan terpisah supaya dua angka utamanya bersih.
      const phase = OPEN_KIND.has(t.kind) ? 'open' : CLOSE_KIND.has(t.kind) ? 'close' : 'lain';
      anchor[i] = { ids: uniq, phase };
    });

    // 2a) zap yang SUDAH disebut namanya oleh mint/tambah — bukti, bukan taksiran.
    //     Mint yang membawa daftar `zapped.hashes` berarti zap-nya persis itu; zap lain
    //     di pool yang sama (mis. percobaan masuk yang batal) BUKAN ongkos posisi ini.
    const zapOwner = new Map();
    const mintTellsZaps = new Map();
    txs.forEach((t, i) => {
      if (!anchor[i] || (t.kind !== 'mint' && t.kind !== 'increase')) return;
      const z = parse(t.detail).zapped;
      mintTellsZaps.set(t.hash, !!z);
      for (const h of z?.hashes || []) zapOwner.set(h, { ids: anchor[i].ids, phase: 'open' });
    });

    // 2b) pembantu (approve/wrap/zap/isi gas) ikut jangkar pertama SESUDAHNYA — approve
    //     selalu mendahului swap/mint yang membutuhkannya, dalam alur yang sama.
    for (let i = txs.length - 1; i >= 0; i--) {
      if (anchor[i] || !HELPER_KIND.has(txs[i].kind)) continue;
      const own = zapOwner.get(txs[i].hash);
      if (own) { anchor[i] = { ...own }; continue; }
      for (let j = i + 1; j < txs.length; j++) {
        if (!anchor[j]) continue;
        if (txs[j].ts - txs[i].ts > HELPER_GAP_MS) break;
        if (txs[i].kind === 'zap_swap') {
          // Zap hanya menempel pada mint/tambah yang sesungguhnya, di pool yang sama,
          // dan hanya kalau mint itu TIDAK menyebutkan daftar zap-nya sendiri (kalau
          // zap ini miliknya, namanya pasti ada di daftar itu). Tanpa ketiganya, zap
          // dari percobaan masuk yang BATAL ikut terbebankan ke posisi berikutnya.
          if (txs[j].kind !== 'mint' && txs[j].kind !== 'increase') continue;
          const zapPool = parse(txs[i].detail).pool;
          const anchorPool = parse(txs[j].detail).pool || parse(txs[j].detail).plan?.poolRef;
          if (zapPool && anchorPool && zapPool !== anchorPool) break;
          if (mintTellsZaps.get(txs[j].hash)) break;
        }
        anchor[i] = { ids: anchor[j].ids, phase: anchor[j].phase };
        break;
      }
    }

    // 3) jumlahkan
    txs.forEach((t, i) => {
      const a = anchor[i];
      if (!a) return;
      const gasUsd = gasUsdOf(t, ethUsd);
      const d = parse(t.detail);
      const sw = swapCostOf(d);
      const share = a.ids.length;
      for (const id of a.ids) {
        const c = bucket(id);
        const b = c[a.phase] || c.lain;
        b.gasUsd += gasUsd / share;
        b.routeUsd += sw.route / share;
        b.execUsd += sw.exec / share;
        b.slipUsd += (sw.route + sw.exec) / share;
        b.txN += 1 / share;
        c.hashes.push(t.hash);
      }
    });
    for (const c of out.values()) {
      for (const ph of ['open', 'close', 'lain']) {
        c.gasUsd += c[ph].gasUsd; c.slipUsd += c[ph].slipUsd;
        c.routeUsd += c[ph].routeUsd; c.execUsd += c[ph].execUsd; c.txN += c[ph].txN;
        c[ph].txN = Math.round(c[ph].txN);
      }
      c.txN = Math.round(c.txN);
      c.totalUsd = c.gasUsd + c.slipUsd;
    }
    return out;
  }
}

module.exports = { Costs, swapCostOf };
