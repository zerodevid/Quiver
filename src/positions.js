'use strict';
const { ensureChain } = require('./networks');
// Sinkronisasi posisi milik kita: nilai sekarang, fee terkumpul, PnL, dan
// pemicu keluar mandiri (di luar rentang, stop loss, take profit, umur).
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { computePoolId, priceUsable } = require('./pools');
const { unclaimedV4, unclaimedV3 } = require('./fees');
const m = require('./v3math');
const { usdPerQuote } = require('./policy');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_POOL3 = new ethers.Interface(ABI.poolV3);

class Positions {
  constructor({ rpc, store, chain, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.live = [];      // hasil sinkron terakhir, dipakai dashboard
    this.farStreak = new Map();   // id posisi -> berapa sinkron berturut-turut harganya terlalu jauh dari rentang
    this.lastSync = 0;
    this.syncing = null; // sinkron yang sedang berjalan, dipakai bersama
    this.markWarned = new Set();   // posisi yang harga pool-nya sudah dilaporkan gila
  }

  open() {
    return this.store.all("SELECT * FROM positions WHERE chain=? AND status='open'", this.chain.network);
  }

  // Catat posisi baru hasil mint kita
  // entrySqrt: harga pool saat mint — dipakai halaman detail untuk menandai titik masuk.
  record(plan, { tokenId, txHash, target, cost0, cost1, costQuote, openedTs, entrySqrt }) {
    const r = this.store.run(
      `INSERT INTO positions
       (chain,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
        target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open,entry_sqrt,last_sync)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.chain.network, plan.venue, tokenId ?? null, plan.poolRef, plan.token0, plan.token1, plan.fee ?? null,
      plan.tickSpacing ?? null, plan.poolKey?.hooks ?? null, plan.tickLower, plan.tickUpper,
      plan.liquidity, target ?? null, plan.mirrorOf ?? null, 'open', openedTs ?? Date.now(),
      String(cost0 ?? plan.amount0), String(cost1 ?? plan.amount1), costQuote ?? plan.valueQuote,
      plan.quoteSymbol, txHash ?? null, entrySqrt != null ? String(entrySqrt) : null, Date.now());
    return Number(r.lastInsertRowid);
  }

  // Hasil penarikan DITAMBAHKAN ke catatan: out0/out1/out_quote menampung semua yang
  // pernah keluar dari posisi (tarik sebagian + tutup), dan memecoin sisa yang belum
  // terjual ikut bertambah — jadi PnL = out_quote − cost_quote tetap benar berapa kali
  // pun posisi ditarik sebagian sebelum ditutup.
  // `left`: memecoin yang ikut keluar dan belum dijual — {token, amount, quote}; nilai
  // quote-nya (di harga tutup) sudah termasuk dalam outQuote.
  #addProceeds(id, { out0, out1, outQuote, left }) {
    const prev = this.store.get('SELECT out0, out1, left_token, left_amount FROM positions WHERE id=?', id) || {};
    const sum = (a, b) => (BigInt(a || '0') + BigInt(b ?? 0)).toString();
    const sameLeft = left && (!prev.left_token || prev.left_token === left.token);
    this.store.run(
      `UPDATE positions SET out0=?, out1=?, out_quote=COALESCE(out_quote,0)+?,
         left_token=COALESCE(?, left_token), left_amount=?, left_quote=COALESCE(left_quote,0)+? WHERE id=?`,
      sum(prev.out0, out0), sum(prev.out1, out1), outQuote ?? 0,
      sameLeft ? left.token : null, sameLeft ? sum(prev.left_amount, left.amount) : (prev.left_amount || '0'),
      sameLeft ? (left.quote || 0) : 0, id);
  }

  #noteProceeds(txHash, key, { out0, out1, outQuote }) {
    if (!txHash) return;
    const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
    const detail = JSON.parse(tx?.detail || '{}');
    detail[key] = { amount0: String(out0 ?? 0), amount1: String(out1 ?? 0), quote: outQuote ?? 0 };
    this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
  }

  markClosed(id, { out0, out1, outQuote, txHash, exitSqrt, left = null }) {
    // Pagar terakhir: hasil DIJUMLAHKAN, jadi menutup posisi yang sudah tertutup =
    // hasilnya dobel (lp3 #220, $150 → $300). Pemanggil yang balapan harus gagal di sini.
    const st = this.store.get('SELECT status FROM positions WHERE id=?', id)?.status;
    if (st !== 'open') throw new Error(`posisi #${id} sudah ${st ?? 'tidak ada'} — hasil tutup tidak dibukukan ulang`);
    this.#addProceeds(id, { out0, out1, outQuote, left });
    this.store.run(
      `UPDATE positions SET status='closed', closed_ts=?, out_quote=out_quote + COALESCE(claimed_quote,0), tx_close=?, exit_sqrt=?, liquidity='0' WHERE id=?`,
      Date.now(), txHash ?? null, exitSqrt != null ? String(exitSqrt) : null, id);
    this.#noteProceeds(txHash, 'closeProceeds', { out0, out1, outQuote });
  }

  // Tarik sebagian: posisi tetap terbuka dengan likuiditas sisa, hasilnya dicatat
  // seperti hasil tutup. Selama masih terbuka, PnL-nya = nilai kini + fee + yang sudah
  // ditarik − modal (lihat sync/summary).
  markDecreased(id, { liquidity, out0, out1, outQuote, txHash, left = null }) {
    this.#addProceeds(id, { out0, out1, outQuote, left });
    this.store.run('UPDATE positions SET liquidity=? WHERE id=?', String(liquidity), id);
    this.#noteProceeds(txHash, 'decreaseProceeds', { out0, out1, outQuote });
  }

  // ---- memecoin sisa: dari "dinilai harga tutup" ke "hasil jual sesungguhnya" ----
  // Posisi yang menyimpan memecoin sisa dari tutupnya, urut tertua (FIFO).
  leftoverRows(token = null) {
    return this.store.all(`SELECT id, token0, token1, pool_ref, venue, quote_symbol, left_token, left_amount, left_quote, out_quote,
        entry_sqrt, exit_sqrt, liquidity, cost0, cost1, tick_lower, tick_upper
      FROM positions WHERE chain=? AND left_token IS NOT NULL AND left_amount != '0'${token ? ' AND left_token=?' : ''} ORDER BY closed_ts, id`,
    this.chain.network, ...(token ? [String(token).toLowerCase()] : []));
  }

  // Dipanggil setelah token sisa terjual (otomatis maupun dari halaman Swap): hasil
  // jual dialokasikan FIFO ke posisi-posisi yang menyimpannya, dan out_quote tiap
  // posisi dikoreksi — taksiran harga tutup diganti hasil yang benar-benar diterima.
  // `posId` membatasi ke satu posisi (penjualan otomatis tahu asalnya).
  recordLeftoverSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const rows = this.leftoverRows(token).filter((r) => posId == null || r.id === posId);
    if (!rows.length) return [];
    const sold = BigInt(amount);
    if (sold <= 0n) return [];
    // Hasil dalam USD: dari jumlah aset kuotasi yang diterima kalau dikenal, kalau tidak
    // dari taksiran USD Kyber.
    const qt = String(quoteToken || '').toLowerCase();
    const q = this.chain.quoteSideOf(qt, qt);
    const gotUsd = q && amountOut != null
      ? (Number(BigInt(amountOut)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1)
      : (usdOut || 0);
    let rem = sold;
    const done = [];
    for (const r of rows) {
      if (rem <= 0n) break;
      const left = BigInt(r.left_amount || '0');
      const take = left < rem ? left : rem;
      rem -= take;
      const frac = Number(take) / Number(left);
      const share = gotUsd * (Number(take) / Number(sold));
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const gotQuote = share / k;
      const closeQuote = (r.left_quote || 0) * frac;
      this.store.run('UPDATE positions SET out_quote = out_quote - ? + ?, left_quote = left_quote - ?, left_amount=? WHERE id=?',
        closeQuote, gotQuote, closeQuote, (left - take).toString(), r.id);
      done.push({ id: r.id, take, closeQuote, gotQuote });
      this.log(`posisi #${r.id}: sisa terjual, hasil ${r.quote_symbol} ${gotQuote.toFixed(2)} menggantikan taksiran tutup ${closeQuote.toFixed(2)}`);
    }
    if (txHash && done.length) {
      const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
      const detail = JSON.parse(tx?.detail || '{}');
      detail.positionSales = done.map((r) => ({ position: r.id, amount: r.take.toString(),
        closeQuote: r.closeQuote, gotQuote: r.gotQuote }));
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
    }
    return done;
  }

  // ---- memecoin dari fee yang sudah diklaim -------------------------------
  // Klaim fee mengembalikan DUA token: aset kuotasi (langsung uang) dan memecoin
  // (belum tentu). recordFeeClaim membukukan keduanya ke claimed_quote di harga pool
  // saat klaim; sisi memecoin-nya dicatat di sini sampai benar-benar terjual, lalu
  // taksiran itu diganti hasil jual sesungguhnya. Tanpa buku ini, fee $40 yang baru
  // laku $9 sesudah dampak harga tetap tercatat $40 selamanya.
  noteFeeLeftover({ posId, token, amount, estQuote, txHash = null }) {
    if (!(BigInt(amount) > 0n)) return null;
    const r = this.store.run('INSERT INTO fee_leftovers(chain,position_id,ts,token,amount,est_quote,tx_hash) VALUES(?,?,?,?,?,?,?)',
      this.chain.network, posId, Date.now(), String(token).toLowerCase(), String(amount), estQuote || 0, txHash);
    return Number(r.lastInsertRowid);
  }

  // Baris fee yang belum terjual, berbentuk SAMA dengan leftoverRows (left_token/
  // left_amount/left_quote) supaya valueLeftover dan leftoverQuote bisa dipakai apa
  // adanya untuk menilainya. Urut tertua dulu (FIFO).
  feeLeftoverRows(token = null, posId = null) {
    return this.store.all(`SELECT f.id AS fee_id, f.position_id AS id, f.ts AS fee_ts, f.est_quote AS left_quote,
        f.token AS left_token, f.amount AS left_amount,
        p.token0, p.token1, p.pool_ref, p.venue, p.quote_symbol, p.status, p.out_quote, p.claimed_quote,
        p.entry_sqrt, p.exit_sqrt, p.liquidity, p.cost0, p.cost1, p.tick_lower, p.tick_upper
      FROM fee_leftovers f JOIN positions p ON p.id=f.position_id
      WHERE f.chain=? AND f.amount != '0'${token ? ' AND f.token=?' : ''}${posId != null ? ' AND f.position_id=?' : ''}
      ORDER BY f.ts, f.id`,
    this.chain.network, ...(token ? [String(token).toLowerCase()] : []), ...(posId != null ? [posId] : []));
  }

  // Dipanggil setelah memecoin fee terjual. Mengembalikan berapa banyak dari `amount`
  // yang memang berasal dari buku fee — sisanya milik buku sisa penutupan dan
  // diserahkan ke recordLeftoverSale oleh pemanggil. Fee dialokasikan lebih dulu
  // karena klaim selalu mendahului penutupan posisi yang sama.
  recordFeeSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const rows = this.feeLeftoverRows(token, posId);
    let rem = BigInt(amount);
    if (!rows.length || rem <= 0n) return { consumed: 0n, done: [] };
    const qt = String(quoteToken || '').toLowerCase();
    const q = this.chain.quoteSideOf(qt, qt);
    const gotUsd = q && amountOut != null
      ? (Number(BigInt(amountOut)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1)
      : (usdOut || 0);
    const total = BigInt(amount);
    const done = [];
    for (const r of rows) {
      if (rem <= 0n) break;
      const left = BigInt(r.left_amount || '0');
      if (left <= 0n) continue;
      const take = left < rem ? left : rem;
      rem -= take;
      const frac = Number(take) / Number(left);
      const share = gotUsd * (Number(take) / Number(total));
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const gotQuote = share / k;
      const estQuote = (r.left_quote || 0) * frac;
      // Posisi yang sudah ditutup: markClosed sudah melipat claimed_quote ke out_quote,
      // jadi koreksinya harus mengenai keduanya — kalau tidak, PnL posisi tertutup
      // tetap memakai taksiran harga klaim.
      this.store.run(`UPDATE positions SET claimed_quote = COALESCE(claimed_quote,0) - ? + ?,
          out_quote = out_quote + CASE WHEN status='closed' THEN ? ELSE 0 END WHERE id=?`,
      estQuote, gotQuote, gotQuote - estQuote, r.id);
      this.store.run('UPDATE fee_leftovers SET amount=?, est_quote=? WHERE id=?',
        (left - take).toString(), (r.left_quote || 0) - estQuote, r.fee_id);
      done.push({ id: r.id, take, estQuote, gotQuote });
      this.log(`posisi #${r.id}: fee terjual, hasil ${r.quote_symbol} ${gotQuote.toFixed(2)} menggantikan taksiran klaim ${estQuote.toFixed(2)}`);
    }
    if (txHash && done.length) {
      const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
      const detail = JSON.parse(tx?.detail || '{}');
      detail.feeSales = done.map((r) => ({ position: r.id, amount: r.take.toString(),
        estQuote: r.estQuote, gotQuote: r.gotQuote }));
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
    }
    return { consumed: BigInt(amount) - rem, done };
  }

  // Satu penjualan token, dibagi ke dua buku yang mungkin memuatnya: fee yang sudah
  // diklaim tapi belum terjual, lalu sisa penutupan posisi. Fee didahulukan karena
  // klaim selalu mendahului penutupan posisi yang sama. Hasil penjualan dibagi
  // proporsional menurut jumlah yang diambil tiap buku — kalau tidak, satu penjualan
  // mengoreksi dua kolom dengan hasil penuh yang sama.
  recordTokenSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const sold = BigInt(amount);
    const fee = this.recordFeeSale({ posId, token, amount: sold, quoteToken, amountOut, usdOut, ethUsd, txHash });
    const rest = sold - (fee?.consumed || 0n);
    if (rest <= 0n) return { fee, leftover: [] };
    const bagian = (x) => (x == null ? null : x * Number(rest) / Number(sold));
    const leftover = this.recordLeftoverSale({ posId, token, amount: rest, quoteToken, txHash,
      amountOut: amountOut != null ? (BigInt(amountOut) * rest / sold).toString() : null,
      usdOut: bagian(usdOut ?? null), ethUsd });
    return { fee, leftover };
  }

  // Nilai memecoin sisa yang masih dipegang, di harga pool SEKARANG. Dibaca tiap
  // sinkron bersama kas; hasilnya dipakai summary() supaya total portofolio tidak
  // "anjlok" begitu posisi tutup lalu "melonjak" begitu sisanya terjual.
  async refreshLeftovers(ethUsd, wallet = null) {
    let rows = this.leftoverRows();
    let usd = 0, closeUsd = 0;
    const items = [];
    // Token yang ternyata sudah tidak ada di wallet (dijual lewat DEX lain, dikirim
    // keluar) tidak boleh terus dinilai: kekurangannya dianggap terealisasi di harga
    // kini, seperti perlakuan riset wallet terhadap transfer keluar tanpa hasil.
    // Memecoin fee yang sudah diklaim ikut diperiksa: saldonya di wallet yang sama,
    // dan kalau ia hilang di luar bot, claimed_quote-nya juga harus berhenti memakai
    // taksiran harga klaim.
    let feeRows = wallet ? this.feeLeftoverRows() : [];
    if ((rows.length || feeRows.length) && wallet) {
      const toksL = [...new Set([...rows.map((r) => r.left_token), ...feeRows.map((r) => r.left_token)])];
      const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const bals = await this.rpc.ethCallMany(toksL.map((t) => ({ to: t, data: IF.encodeFunctionData('balanceOf', [wallet]) })));
      let changed = false;
      for (let i = 0; i < toksL.length; i++) {
        if (!bals[i] || bals[i] === '0x') continue;
        const bal = BigInt(bals[i]);
        const mine = rows.filter((r) => r.left_token === toksL[i]);
        const mineFee = feeRows.filter((r) => r.left_token === toksL[i]);
        const jumlah = (list) => list.reduce((a, r) => a + BigInt(r.left_amount), 0n);
        const total = jumlah(mine) + jumlah(mineFee);
        if (bal >= total) continue;
        let gone = total - bal;
        // Kekurangannya dibebankan ke buku fee dulu, urutan yang sama dengan
        // recordTokenSale — supaya satu token yang ada di dua buku tidak pernah
        // dihitung dua kali.
        const ambilFee = jumlah(mineFee) < gone ? jumlah(mineFee) : gone;
        if (ambilFee > 0n) {
          const val = await this.valueLeftover(mineFee, ambilFee, ethUsd);
          this.log(`fee ${toksL[i].slice(0, 10)}… berkurang di luar bot (${ambilFee} satuan) — dianggap terjual $${val.toFixed(2)}`);
          this.recordFeeSale({ token: toksL[i], amount: ambilFee, quoteToken: null, usdOut: val, ethUsd });
          gone -= ambilFee;
          changed = true;
        }
        if (gone > 0n && mine.length) {
          const val = await this.valueLeftover(mine, gone, ethUsd);
          this.log(`token sisa ${toksL[i].slice(0, 10)}… berkurang di luar bot (${gone} satuan) — dianggap terjual $${val.toFixed(2)}`);
          this.recordLeftoverSale({ token: toksL[i], amount: gone, quoteToken: null, usdOut: val, ethUsd });
          changed = true;
        }
      }
      if (changed) { rows = this.leftoverRows(); feeRows = this.feeLeftoverRows(); }
    }
    if (rows.length) {
      const v4 = [...new Set(rows.filter((r) => !this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))];
      const slots = new Map(), liqs = new Map();
      if (v4.length) {
        const [ss, ls] = await Promise.all([this.chain.slot0V4Many(v4), this.chain.poolLiquidityMany(v4).catch(() => [])]);
        v4.forEach((id, i) => { slots.set(id, ss[i]); liqs.set(id, ls[i] ?? 0n); });
      }
      for (const a of new Set(rows.filter((r) => this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))) {
        try { slots.set(a, await this.chain.slot0V3(a)); liqs.set(a, await this.poolLiquidityOf('v3', a)); } catch { /* dinilai harga tutup */ }
      }
      const toks = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]))]);
      const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
      for (const r of rows) {
        const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
        // token sisa dinilai dengan harga penilai, bukan harga pool yang mungkin sudah kosong
        const mk = await this.markFor(r, slots.get(r.pool_ref), liqs.get(r.pool_ref));
        const v = this.leftoverQuote(r, BigInt(r.left_amount), mk ? { sqrtPriceX96: mk.sqrt } : null, dec);
        // harga pool tidak terbaca: pakai nilai tutup supaya tidak hilang dari ekuitas
        const now = (v ?? (r.left_quote || 0)) * k;
        usd += now; closeUsd += (r.left_quote || 0) * k;
        items.push({ id: r.id, token: r.left_token, amount: r.left_amount, usd: now });
      }
    }
    this.leftoverVal = { usd, closeUsd, items, ts: Date.now() };
    return this.leftoverVal;
  }

  // Harga penilai untuk baris posisi r, diberi slot0 `s` dan likuiditas aktif pool-nya:
  // harga pool sendiri kalau layak; kalau tidak, pool lain yang memuat pasangan yang
  // sama; terakhir, harga posisi sendiri saat keluar/masuk (usang, tapi berhingga dan
  // masuk akal — lebih baik daripada 1e17× harga wajar dari pool yang sudah disapu kosong).
  // Balikan { sqrt, ref } — ref null = harga pool sendiri, 'exit'/'entry', atau pool_ref acuan.
  async markFor(r, s, poolLiq) {
    if (!s) return null;
    // Harga pool yang lolos priceUsable pun bisa gila: pool berlikuiditas 1 wei sesudah
    // rug / satu swap liar menaruh harga 1e9× harga wajar tanpa menyentuh tepi tick —
    // dasbor pernah menunjukkan "milyaran dolar". Batas: harga penilai tidak boleh lebih
    // dari MARK_RATIO_MAX× (atau kurang dari 1/MARK_RATIO_MAX×) pembandingnya: harga
    // masuk posisi, atau — kalau itu tidak tercatat — tepi rentang posisi yang terdekat.
    // Memecoin memang bisa 100× atau −99%, tapi 1000× dalam umur satu posisi bukan
    // sesuatu yang layak dipercaya dari satu pool tipis.
    const own = Positions.entrySqrtOf(r) ? BigInt(Positions.entrySqrtOf(r)) : null;
    const hasRange = r.tick_lower != null && r.tick_upper != null;
    const sa = hasRange ? m.getSqrtRatioAtTick(r.tick_lower) : null;
    const sb = hasRange ? m.getSqrtRatioAtTick(r.tick_upper) : null;
    const nearEdge = (x) => (x < sa ? sa : x > sb ? sb : x);   // di dalam rentang: dirinya sendiri
    const ratioOk = (x, ref) => {
      const hi = x > ref ? x : ref, lo = x > ref ? ref : x;
      // rasio harga = (sqrt_hi/sqrt_lo)^2 ; dibandingkan tanpa float
      return lo > 0n && hi * hi < lo * lo * BigInt(Positions.MARK_RATIO_MAX);
    };
    const sane = (x) => {
      if (x == null) return true;
      if (own) return ratioOk(x, own);
      if (hasRange) return ratioOk(x, nearEdge(x));
      return true;
    };
    if (priceUsable(s, poolLiq ?? 0n) && sane(s.sqrtPriceX96)) return { sqrt: s.sqrtPriceX96, ref: null };
    const alt = await this.chain.markSqrtForPair(r.token0, r.token1, r.pool_ref);
    if (alt && sane(alt.sqrtPriceX96)) return { sqrt: alt.sqrtPriceX96, ref: alt.poolRef };
    // Harga sendiri (keluar / pool mentah) bisa juga gila atau di batas tick — kalau
    // rentang posisi diketahui, diapit ke tepinya: harga terakhir yang dilalui posisi ini.
    const clamp = (x) => (hasRange && !sane(x) ? nearEdge(x) : x);
    if (r.exit_sqrt) {
      const ex = clamp(BigInt(r.exit_sqrt));
      if (sane(ex)) return { sqrt: ex, ref: 'exit' };
    }
    // Harga pool tidak dipercaya (gila, atau pool tanpa likuiditas aktif) dan posisi
    // punya rentang: tepi rentang yang terdekat, BUKAN harga masuk. Di luar rentang
    // komposisi posisi sudah beku — seluruhnya satu sisi — dan tepi adalah harga
    // terakhir yang sungguh mengubahnya; berapa pun harga lari sesudah itu, isinya
    // tetap sama. Harga masuk bisa jauh di luar rentang (posisi tangga dipasang di
    // bawah pasar), dan menilai token hasil konversi di harga itu = keadaan yang
    // mustahil: kalau harga masih di sana, posisi tidak akan memegang token itu.
    // lp3 2026-09-19: WIN rug 1e10×, 4 posisi tangga modal $310 terbaca $1.229 dan
    // grafik melonjak +$1.187 palsu selama dua jam.
    if (hasRange) {
      const edge = nearEdge(s.sqrtPriceX96);
      if (edge !== s.sqrtPriceX96) {
        if (!sane(s.sqrtPriceX96) && !this.markWarned.has(r.id)) {
          this.markWarned.add(r.id);
          this.log(`harga pool posisi #${r.id} ${s.sqrtPriceX96 > (own ?? edge) ? '>' : '< 1/'}${Positions.MARK_RATIO_MAX}× harga masuk — dinilai di tepi rentang`);
        }
        return { sqrt: edge, ref: 'edge' };
      }
      // di dalam rentang tapi pool tak layak dibaca: harga ini masih yang terbaik
      if (sane(edge)) return { sqrt: edge, ref: null };
    }
    if (own) {
      if (!this.markWarned.has(r.id)) {
        this.markWarned.add(r.id);
        this.log(`harga pool posisi #${r.id} ${s.sqrtPriceX96 > own ? '>' : '< 1/'}${Positions.MARK_RATIO_MAX}× harga masuk — dinilai di harga masuk`);
      }
      return { sqrt: own, ref: 'entry' };
    }
    return { sqrt: s.sqrtPriceX96, ref: null };
  }

  // Baca harga pool posisi r lalu pilih harga penilainya; bentuknya slot0 supaya bisa
  // langsung dioper ke valueInQuote. null kalau harga pool tidak terbaca sama sekali.
  async markSlotFor(r) {
    const s = this.chain.isV3Venue(r.venue) ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref);
    const mk = await this.markFor(r, s, await this.poolLiquidityOf(r.venue, r.pool_ref));
    return mk ? { sqrtPriceX96: mk.sqrt, tick: s.tick, ref: mk.ref, poolSqrt: s.sqrtPriceX96 } : null;
  }

  // Likuiditas aktif pool (v3 lewat kontrak pool, v4 lewat PoolManager); 0n kalau tak terbaca.
  async poolLiquidityOf(venue, poolRef) {
    try {
      if (this.chain.isV3Venue(venue)) {
        const [wl] = await this.rpc.ethCallMany([{ to: poolRef, data: IF_POOL3.encodeFunctionData('liquidity') }]);
        return wl && wl !== '0x' ? BigInt(wl) : 0n;
      }
      return await this.chain.poolLiquidity(poolRef);
    } catch { return 0n; }
  }

  // Nilai `amt` token sisa baris r (satuan aset kuotasi) di harga slot0 `s`; null kalau tak terbaca.
  leftoverQuote(r, amt, s, dec) {
    if (!s) return null;
    const side = r.left_token === r.token0 ? 0 : 1;
    const v = this.chain.valueInQuote({
      sqrtPriceX96: s.sqrtPriceX96, amount0: side === 0 ? amt : 0n, amount1: side === 1 ? amt : 0n,
      dec0: dec.get(r.token0) ?? 18, dec1: dec.get(r.token1) ?? 18, token0: r.token0, token1: r.token1,
    });
    return v ? v.value : null;
  }

  // Nilai USD `amt` satuan token sisa, dinilai lewat pool posisi pertama yang menyimpannya.
  async valueLeftover(rows, amt, ethUsd) {
    const r = rows[0];
    let s = null;
    try { s = this.chain.isV3Venue(r.venue) ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref); } catch { s = null; }
    const mk = await this.markFor(r, s, await this.poolLiquidityOf(r.venue, r.pool_ref));
    const toks = await this.chain.tokens([r.token0, r.token1]);
    const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
    const v = this.leftoverQuote(r, amt, mk ? { sqrtPriceX96: mk.sqrt } : null, dec);
    const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
    if (v != null) return v * k;
    // harga tidak terbaca: proporsional dari nilai tutup
    const total = rows.reduce((a, x) => a + BigInt(x.left_amount), 0n);
    return rows.reduce((a, x) => a + (x.left_quote || 0), 0) * k * Number(amt) / Number(total);
  }

  // Harga masuk untuk posisi yang dicatat sebelum kolom entry_sqrt ada: diturunkan
  // balik dari jumlah token yang disetor. Di dalam rentang, amount1 = L·(√P − √A),
  // jadi √P = √A + amount1/L. Semua token di satu sisi = harga di luar rentang saat
  // mint; batas rentangnya yang dipakai.
  static get MARK_RATIO_MAX() { return 1000; }

  static entrySqrtOf(r) {
    if (r.entry_sqrt) return r.entry_sqrt;
    try {
      const L = BigInt(r.liquidity || '0'), c0 = BigInt(r.cost0 || '0'), c1 = BigInt(r.cost1 || '0');
      if (L <= 0n || r.tick_lower == null || r.tick_upper == null) return null;
      const a = m.getSqrtRatioAtTick(r.tick_lower), b = m.getSqrtRatioAtTick(r.tick_upper);
      if (c1 === 0n) return c0 > 0n ? a.toString() : null;
      if (c0 === 0n) return b.toString();
      const p = a + (c1 * m.Q96) / L;
      return (p < a ? a : p > b ? b : p).toString();
    } catch { return null; }
  }

  // ---- sinkronisasi -------------------------------------------------------
  // Sinkron atas permintaan pengguna: tombol "Perbarui" di tabel dasbor.
  //
  // Kalau sinkron sedang berjalan, permintaan ini menumpang yang itu — menekan
  // tombol lima kali tidak boleh berarti lima putaran eth_call, dan hasilnya toh
  // dibaca beberapa milidetik yang lalu. Yang TIDAK boleh menumpang adalah sinkron
  // sesudah transaksi mendarat (claim, compound): di sana angka lama pasti salah,
  // jadi pemanggilnya memakai sync() langsung dan selalu membaca ulang.
  resync(ethUsd) {
    if (!this.syncing) this.syncing = this.sync(ethUsd).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async sync(ethUsd) {
    const rows = this.open();
    if (!rows.length) { this.live = []; this.lastSync = Date.now(); return []; }

    // 1. likuiditas terkini
    const v4 = rows.filter((r) => r.venue === 'v4' && r.token_id);
    const v3 = rows.filter((r) => this.chain.isV3Venue(r.venue) && r.token_id);
    const liqCalls = [
      ...v4.map((r) => ({ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.token_id)]) })),
      ...v3.map((r) => ({ to: this.chain.npmFor(r.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(r.token_id)]) })),
    ];
    // Panggilan yang GAGAL (RPC error, balasan kosong) TIDAK boleh dibaca sebagai nol:
    // nol berarti "likuiditas habis" dan engine menutup posisinya di database tanpa
    // transaksi apa pun. Pernah terjadi saat endpoint sedang rusak — #45 ($110) dicatat
    // tutup dengan hasil $0 padahal di chain masih utuh. Gagal = pakai angka terakhir
    // yang tersimpan, dan posisi ditandai belum tersinkron (bukan kosong).
    const liqRes = await this.rpc.ethCallMany(liqCalls);
    const liqBy = new Map();
    const liqStale = new Set();
    const keepOld = (r) => { liqBy.set(r.id, BigInt(r.liquidity || '0')); liqStale.add(r.id); };
    v4.forEach((r, i) => {
      const w = liqRes[i];
      if (w && w !== '0x') liqBy.set(r.id, BigInt(w)); else keepOld(r);
    });
    v3.forEach((r, i) => {
      const w = liqRes[v4.length + i];
      let L = null;
      if (w && w !== '0x') { try { L = BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { L = null; } }
      if (L != null) liqBy.set(r.id, L); else keepOld(r);
    });

    // 2. state pool — harga DAN likuiditas aktif. Likuiditas nol berarti harganya
    //    tidak bisa dipercaya (lihat markSqrtForPair), jadi dibaca bersamaan.
    const poolIds = [...new Set(rows.filter((r) => r.venue === 'v4').map((r) => r.pool_ref))];
    // Likuiditas yang gagal dibaca tidak boleh menjatuhkan sinkron: dianggap 0 → jatuh
    // ke pool acuan / harga sendiri, yang aman.
    const [slots, poolLiq] = poolIds.length
      ? await Promise.all([this.chain.slot0V4Many(poolIds), this.chain.poolLiquidityMany(poolIds).catch(() => [])]) : [[], []];
    const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
    const poolLiqBy = new Map(poolIds.map((id, i) => [id, poolLiq[i] ?? 0n]));
    for (const r of rows.filter((x) => this.chain.isV3Venue(x.venue))) {
      if (slotBy.has(r.pool_ref) || !r.pool_ref) continue;
      slotBy.set(r.pool_ref, await this.chain.slot0V3(r.pool_ref));
      poolLiqBy.set(r.pool_ref, await this.poolLiquidityOf('v3', r.pool_ref));
    }

    const markBy = new Map();
    for (const r of rows) {
      const mk = await this.markFor(r, slotBy.get(r.pool_ref), poolLiqBy.get(r.pool_ref));
      if (mk) markBy.set(r.id, mk);
    }

    // 3. fee belum diklaim
    const curTick = new Map([...slotBy.entries()].filter(([, s]) => s).map(([k, s]) => [k, s.tick]));
    const feeItems = v4.map((r) => ({ poolId: r.pool_ref, tickLower: r.tick_lower, tickUpper: r.tick_upper, tokenId: r.token_id }));
    const feesV4 = feeItems.length ? await unclaimedV4(this.chain, feeItems, curTick, this.rpc) : [];
    const owner = this.store.getState('wallet_address');
    const feeBy = new Map();
    v4.forEach((r, i) => feeBy.set(r.id, feesV4[i] || { fee0: 0n, fee1: 0n }));
    // v3 dikelompokkan per venue: tiap venue punya NPM sendiri (Uniswap v3 vs PancakeSwap v3).
    if (owner) {
      for (const venue of new Set(v3.map((r) => r.venue))) {
        const group = v3.filter((r) => r.venue === venue);
        const fees = await unclaimedV3(this.chain, group.map((r) => BigInt(r.token_id)), owner, this.chain.npmFor(venue), this.rpc);
        group.forEach((r, i) => feeBy.set(r.id, fees[i] || { fee0: 0n, fee1: 0n }));
      }
    }
    for (const r of v3) if (!feeBy.has(r.id)) feeBy.set(r.id, { fee0: 0n, fee1: 0n });

    // 4. metadata token
    const toks = new Set();
    for (const r of rows) { if (r.token0) toks.add(r.token0); if (r.token1) toks.add(r.token1); }
    const metas = await this.chain.tokens([...toks]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    const out = [];
    const prevLive = new Map((this.live || []).map((p) => [p.id, p]));
    for (const r of rows) {
      const s = slotBy.get(r.pool_ref);
      const L = liqBy.get(r.id) ?? BigInt(r.liquidity || '0');
      const d0 = metaBy.get(r.token0)?.decimals ?? 18;
      const d1 = metaBy.get(r.token1)?.decimals ?? 18;
      const f = feeBy.get(r.id) || { fee0: 0n, fee1: 0n };
      let amount0 = 0n, amount1 = 0n, valueQuote = null, feeQuote = null, inRange = null;
      if (s && L > 0n) {
        const a = m.getSqrtRatioAtTick(r.tick_lower), b = m.getSqrtRatioAtTick(r.tick_upper);
        const amt = m.amountsForLiquidity(s.sqrtPriceX96, a, b, L);
        amount0 = amt.amount0; amount1 = amt.amount1;
        inRange = m.sideOfRange(s.tick, r.tick_lower, r.tick_upper) === 'both';
      }
      // Komposisi token (amount0/1) mengikuti harga pool sendiri — itulah yang benar-
      // benar keluar saat ditarik. Tapi NILAINYA dalam kuotasi memakai harga penilai.
      const mark = markBy.get(r.id);
      if (s && mark) {
        const v = this.chain.valueInQuote({ sqrtPriceX96: mark.sqrt, amount0, amount1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (v) valueQuote = v.value;
        const vf = this.chain.valueInQuote({ sqrtPriceX96: mark.sqrt, amount0: f.fee0, amount1: f.fee1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (vf) feeQuote = vf.value;
      }
      if (f.unknown) feeQuote = r.fees_quote ?? null;   // fee tidak terbaca: angka terakhir, bukan nol
      // Pagar nominal: fee tak berhingga atau > 10× modal (+$100) bukan rezeki, tapi
      // perhitungan yang rusak (slot fee salah baca, harga gila) — pakai angka terakhir.
      if (feeQuote != null && (!Number.isFinite(feeQuote) || feeQuote > Math.max(r.cost_quote || 0, 1) * 10 + 100)) {
        if (!this.markWarned.has(`fee:${r.id}`)) { this.markWarned.add(`fee:${r.id}`); this.log(`fee posisi #${r.id} terbaca ${feeQuote} — tidak masuk akal, pakai angka terakhir`); }
        feeQuote = Number.isFinite(r.fees_quote) ? r.fees_quote : 0;
      }
      if (valueQuote != null && !Number.isFinite(valueQuote)) valueQuote = null;
      const kind = this.chain.quoteSideOf(r.token0, r.token1)?.kind || 'usd';
      const toUsd = (x) => (x == null ? null : (kind === 'eth' ? x * ethUsd : x));
      const costUsd = toUsd(r.cost_quote) ?? 0;
      // Harga tidak terbaca (RPC) ≠ posisi bernilai $0. Dulu nilainya 0 → PnL −100% →
      // stop loss (kalau disetel) menutup posisi sungguhan di harga pasar, dan kurva
      // ekuitas anjlok sesaat. Pakai nilai terakhir yang diketahui dan tandai basi;
      // pemicu berbasis PnL tidak dinilai dari angka basi.
      const withdrawnUsd0 = toUsd(r.out_quote) ?? 0;
      const valueStale = valueQuote == null && L > 0n;
      const valUsd = valueQuote != null ? toUsd(valueQuote)
        : L > 0n ? (prevLive.get(r.id)?.valueUsd ?? Math.max(0, costUsd - withdrawnUsd0)) : 0;
      const feeUsd = toUsd(feeQuote) ?? 0;
      const claimedUsd = toUsd(r.claimed_quote) ?? 0;
      // out_quote posisi terbuka = hasil tarik sebagian yang sudah di wallet
      const withdrawnUsd = toUsd(r.out_quote) ?? 0;
      const pnlUsd = valUsd + feeUsd + claimedUsd + withdrawnUsd - costUsd;

      // HODL: kalau modal awal dibiarkan sebagai token, berapa nilainya sekarang?
      // Selisihnya = impermanent loss.
      let hodlUsd = null;
      if (s && mark) {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: mark.sqrt, amount0: BigInt(r.cost0 || '0'), amount1: BigInt(r.cost1 || '0'),
          dec0: d0, dec1: d1, token0: r.token0, token1: r.token1,
        });
        if (v) hodlUsd = toUsd(v.value);
      }

      this.store.run('UPDATE positions SET liquidity=?, fees_quote=?, last_sync=? WHERE id=?',
        L.toString(), feeQuote ?? 0, Date.now(), r.id);

      out.push({
        ...r, liquidity: L.toString(),
        symbol0: metaBy.get(r.token0)?.symbol || '?', symbol1: metaBy.get(r.token1)?.symbol || '?',
        dec0: d0, dec1: d1,
        // Sisi kuotasi menentukan arah harga yang ditampilkan di UI.
        quoteSide: this.chain.quoteSideOf(r.token0, r.token1)?.side ?? null,
        amount0: amount0.toString(), amount1: amount1.toString(),
        fee0: f.fee0.toString(), fee1: f.fee1.toString(),
        curTick: s?.tick ?? null, inRange,
        curSqrt: s?.sqrtPriceX96 != null ? s.sqrtPriceX96.toString() : null,
        // Harga penilai kalau berbeda dari harga pool (pool tidak layak dinilai):
        // sqrt-nya dan dari mana ('entry' atau pool_ref pool acuan).
        markSqrt: mark && mark.ref ? mark.sqrt.toString() : null,
        markRef: mark?.ref ?? null,
        entrySqrt: Positions.entrySqrtOf(r),
        valueUsd: valUsd, feeUsd, claimedUsd, withdrawnUsd, costUsd, pnlUsd,
        pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
        ilUsd: hodlUsd != null ? valUsd - hodlUsd : null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        // Kosong hanya kalau chain BENAR-BENAR menjawab nol — bukan karena gagal dibaca.
        empty: L === 0n && !liqStale.has(r.id),
        liqStale: liqStale.has(r.id),
        valueStale,
      });
    }
    this.live = out;
    this.lastSync = Date.now();
    return out;
  }

  // Pastikan likuiditas posisi memang nol di chain sebelum ditutup di database.
  // Dibaca ulang lewat satu panggilan tersendiri (bukan hasil sinkron terakhir): nol
  // dari sinkron bisa datang dari node yang tertinggal/rusak, dan menutup posisi
  // berdasarkan itu berarti $110 hilang dari pembukuan tanpa transaksi. Gagal baca
  // = belum pasti = false.
  //
  // Posisi yang BARU dibuka (< 15 menit): node yang tertinggal (ordofi bisa ribuan blok)
  // belum mengenal mint-nya dan menjawab likuiditas 0 — dua kali berturut-turut kalau
  // kebetulan dua-duanya jatuh ke node itu. Menutupnya berarti posisi hidup tercatat
  // tutup $0 dan tidak pernah diadopsi lagi (tokenId-nya sudah "dikenal"). Jadi node yang
  // menjawab harus sekaligus menunjukkan receipt mint-nya, dalam satu batch.
  async confirmEmpty(pos) {
    try {
      const call = pos.venue === 'v4'
        ? { to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(pos.token_id)]) }
        : { to: this.chain.npmFor(pos.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(pos.token_id)]) };
      if (Date.now() - (pos.opened_ts || 0) < 15 * 60_000) {
        if (!pos.tx_open || !this.rpc.batch) return false;
        const [cr, rr] = await this.rpc.batch([
          { method: 'eth_call', params: [call, 'latest'] },
          { method: 'eth_getTransactionReceipt', params: [pos.tx_open] },
        ]);
        if (!rr || rr.error || !rr.result || !cr || cr.error || !cr.result || cr.result === '0x') return false;
        const L0 = pos.venue === 'v4' ? BigInt(cr.result) : BigInt(IF_NPM.decodeFunctionResult('positions', cr.result)[7]);
        return L0 === 0n;
      }
      const [w] = await this.rpc.ethCallMany([call]);
      if (!w || w === '0x') return false;
      const L = pos.venue === 'v4' ? BigInt(w) : BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]);
      return L === 0n;
    } catch { return false; }
  }

  // Posisi yang perlu ditutup karena aturan mandiri (bukan karena target keluar).
  // `rules`: objek aturan, atau fungsi (posisi) -> aturan. Engine memakai fungsi supaya
  // aturan keluar PER TARGET (stop loss, take profit, umur, di luar rentang) berlaku —
  // form aturan per-target menampilkannya, dan dulu diam-diam diabaikan.
  exitTriggers(rules) {
    const now = Date.now();
    const outs = [];
    for (const p of this.live) {
      const e = (typeof rules === 'function' ? rules(p) : rules).exit;
      if (p.empty) { outs.push({ pos: p, reason: 'likuiditas sudah nol di chain' }); continue; }
      // Nilai/likuiditas basi (RPC gagal): stop loss, take profit, dan di-luar-rentang tidak
      // boleh dinilai dari angka lama — tunggu sinkron yang terbaca.
      if (p.valueStale || p.liqStale) continue;
      if (e.stop_loss_pct > 0 && p.pnlPct <= -Math.abs(e.stop_loss_pct)) {
        outs.push({ pos: p, reason: `stop loss ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.take_profit_pct > 0 && p.pnlPct >= e.take_profit_pct) {
        outs.push({ pos: p, reason: `take profit ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.max_age_hours > 0 && p.ageHours >= e.max_age_hours) {
        outs.push({ pos: p, reason: `umur ${p.ageHours.toFixed(1)} jam` }); continue;
      }
      // Terlalu jauh dari rentang: modalnya menganggur (tidak menghasilkan fee) dan
      // harganya belum tentu kembali. Dua sinkron berturut-turut (~1 menit) supaya sumbu
      // sesaat tidak menutup posisi; kalau target masih di dalam, mesin membukanya lagi
      // begitu harga mendekat (reenter_within_pct).
      const far = e.out_of_range_pct > 0 && p.inRange === false && p.curTick != null
        ? m.distanceFromRangePct(p.curTick, p.tick_lower, p.tick_upper) : 0;
      if (far > e.out_of_range_pct) {
        const n = (this.farStreak.get(p.id) || 0) + 1;
        this.farStreak.set(p.id, n);
        if (n >= 2) {
          outs.push({ pos: p, kind: 'oor', reason: `di luar rentang ${far >= 1000 ? '999+' : far.toFixed(0)}% dari harga (batas ${e.out_of_range_pct}%)` });
          continue;
        }
      } else this.farStreak.delete(p.id);
      if (e.out_of_range_minutes > 0 && p.inRange === false) {
        const since = Number(this.store.getState(`oor:${p.id}`, 0)) || 0;
        if (!since) this.store.setState(`oor:${p.id}`, now);
        else if (now - since >= e.out_of_range_minutes * 60000) {
          outs.push({ pos: p, kind: 'oor', reason: `di luar rentang ${Math.round((now - since) / 60000)} menit` });
        }
      } else if (p.inRange) {
        this.store.setState(`oor:${p.id}`, 0);
      }
    }
    return outs;
  }

  // Ringkasan posisi terbuka.
  //
  // Jumlah dan eksposur DIHITUNG DARI DB, bukan dari cache `live`. Cache itu hanya
  // disegarkan tiap 30 detik; kalau dipakai sebagai sumber, posisi yang baru saja
  // dibuka tidak terhitung — dan batas "maksimum posisi terbuka" serta "eksposur
  // total" bisa ditembus beberapa kali berturut-turut oleh target yang cepat,
  // persis batas yang dipasang untuk membatasi kerugian.
  summary(ethUsd) {
    const liveById = new Map(this.live.map((p) => [p.id, p]));
    const rows = this.store.all("SELECT id, cost_quote, out_quote, quote_symbol, claimed_quote FROM positions WHERE chain=? AND status='open'", this.chain.network)
      .filter((r) => !liveById.get(r.id)?.empty);
    let val = 0, fee = 0, cost = 0, withdrawn = 0;
    for (const r of rows) {
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const c = (r.cost_quote || 0) * k;
      cost += c;
      // hasil tarik sebagian sudah di wallet (ikut kas), tapi modalnya masih utuh di
      // cost_quote — tanpa ini posisi yang ditarik sebagian terbaca rugi sebesar tarikannya
      withdrawn += (r.out_quote || 0) * k;
      const l = liveById.get(r.id);
      if (l) { val += l.valueUsd || 0; fee += l.feeUsd || 0; }
      else val += Math.max(0, c - (r.out_quote || 0) * k);   // belum tersinkron: sisa modal sebagai taksiran nilai
    }
    const open = rows.map((r) => liveById.get(r.id)).filter(Boolean).filter((p) => !p.empty);
    const closed = this.store.all("SELECT cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed'", this.chain.network);
    let realized = rows.reduce((sum, r) => sum + (r.claimed_quote || 0) * usdPerQuote(r.quote_symbol, ethUsd, this.chain), 0);
    for (const c of closed) {
      const k = usdPerQuote(c.quote_symbol, ethUsd, this.chain);
      realized += ((c.out_quote || 0) - (c.cost_quote || 0)) * k;
    }
    // Memecoin sisa yang belum dijual: out_quote posisinya masih memakai harga tutup,
    // selisih ke harga kini adalah PnL yang belum terealisasi.
    const lo = this.leftoverVal || { usd: 0, closeUsd: 0 };
    return {
      openCount: rows.length, exposureUsd: val, costUsd: cost, feeUsd: fee,
      unrealizedUsd: val + fee + withdrawn - cost + (lo.usd - lo.closeUsd), realizedUsd: realized,
      leftoverUsd: lo.usd, leftoverCloseUsd: lo.closeUsd,
      inRange: open.filter((p) => p.inRange).length,
    };
  }
}

module.exports = { Positions };
