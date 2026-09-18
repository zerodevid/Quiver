'use strict';
const { ensureChain } = require('./networks');
// Deteksi aksi LP wallet target.
//
// Kenapa lewat event, bukan decode transaksi: target contoh (0xe1d7…3e79) memakai
// V4UtilsRouter (layanan otomasi berperan AUTOMATION_OPERATOR) untuk sebagian besar
// posisinya, plus PositionManager langsung, plus UniversalRouter. Decode calldata
// berarti mengejar setiap router baru selamanya. Event PoolManager/NPM adalah
// muara yang sama untuk semuanya.
//
// Rantai identifikasi v4: ModifyLiquidity.salt == tokenId PositionManager,
// lalu tokenId -> pemilik lewat ownerOf/Transfer. Diverifikasi di chain.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { computePoolId } = require('./pools');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const asAddr = (topic) => ('0x' + topic.slice(-40)).toLowerCase();
const i24 = (v) => Number(BigInt.asIntN(24, v));
const i256 = (v) => BigInt.asIntN(256, v);

class Watcher {
  constructor({ rpc, store, chain, log, cfg }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.cfg = cfg;
    this.network = chain.network;
    // Router yang hanya menukar token; tx target ke sini bukan aksi LP.
    this.swapRouters = new Set([chain.ADDR.dexRouter, chain.ADDR.universalRouter].filter(Boolean).map((a) => a.toLowerCase()));
    // Alamat NPM -> kunci venue v3 ('v3', 'pancakev3', …) — satu chain bisa punya lebih dari satu.
    this.npmVenue = new Map(chain.venues.map((v) => [String(v.npmV3).toLowerCase(), v.key]));
    this.owners = new Map();   // `${venue}:${tokenId}` -> owner
    this.v4Info = new Map();   // tokenId -> {poolKey, poolId, tickLower, tickUpper}
    this.unsupported = new Map(); // sender -> jumlah, untuk transparansi di dashboard
    this.unsupportedSender = new Map(); // txHash -> sender ModifyLiquidity di rentang ini, untuk pesan peringatan
    this.isContract = new Map();  // alamat -> punya bytecode?
  }

  // Apakah alamat ini kontrak? Dipakai untuk membedakan "dititipkan ke router otomasi"
  // dari "benar-benar dilepas ke orang lain".
  async contractCheck(addrs) {
    const need = [...new Set(addrs)].filter((a) => a && !this.isContract.has(a));
    if (!need.length) return;
    const res = await this.rpc.batch(need.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    // Tidak terbaca ≠ "bukan kontrak". Dulu galat RPC dibaca '0x' dan DISIMPAN selamanya:
    // titipan NFT target ke router otomasi terbaca "target melepas posisi", dan bot
    // menutup cermin dari posisi yang masih hidup. Lempar — rentang blok diulang.
    const bad = need.find((a, i) => !res[i] || res[i].error || typeof res[i].result !== 'string');
    if (bad) throw new Error(`eth_getCode ${bad} tidak terbaca dari RPC`);
    need.forEach((a, i) => this.isContract.set(a, res[i].result !== '0x'));
  }

  targets() {
    return this.store.all('SELECT address,label,enabled,rules FROM targets WHERE chain=?', this.network);
  }
  enabledSet() {
    return new Set(this.targets().filter((t) => t.enabled).map((t) => t.address.toLowerCase()));
  }

  // Peringatan sekali per (target, router): target memakai router LP yang posisinya
  // bukan NFT, sehingga tidak bisa dicermin. Tanpa ini, bot terlihat "sehat" padahal buta.
  //
  // Tx ke router SWAP dilewati: agregator bisa merutekan swap lewat pool v4 berhook yang
  // menyeimbangkan likuiditasnya sendiri, dan ModifyLiquidity milik hook itu ikut
  // tercatat di tx target. Itu swap biasa, bukan target pindah ke router LP lain —
  // terjadi pada 0x2debd4c6…4bf7 (target menjual sisa token lewat dagSwapTo).
  async warnIfTargetUnsupported(txHashes, targets) {
    this.warnedUnsupported = this.warnedUnsupported || new Set();
    const ask = txHashes.slice(0, 8);   // cukup sampel; ini jalur langka
    const res = await this.rpc.batch(ask.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    for (const r of res) {
      const tx = r && !r.error ? r.result : null;
      const from = String(tx?.from || '').toLowerCase();
      if (!targets.has(from)) continue;
      const to = String(tx?.to || '').toLowerCase();
      if (this.swapRouters.has(to)) continue;
      const senders = [...new Set((this.unsupportedSender.get(tx.hash) || []))];
      const key = `${from}|${to}`;
      if (this.warnedUnsupported.has(key)) continue;
      this.warnedUnsupported.add(key);
      const msg = `PERHATIAN: target ${from} membuka/mengubah LP lewat router yang posisinya BUKAN NFT PositionManager — aksi seperti itu tidak bisa dicermin bot ini (tx ${tx.hash}, ke ${to}, sender ModifyLiquidity ${senders.join(', ') || '?'})`;
      this.log(msg);
      this.store.log('warn', msg, { target: from, tx: tx.hash, to, senders });
    }
  }

  ownerKey(venue, tokenId) { return `${venue}:${tokenId}`; }

  // Cache ini menampung pemilik SEMUA tokenId yang muncul di log PositionManager seluruh
  // chain, bukan hanya milik target — tanpa batas ia tumbuh sepanjang umur proses menuju
  // max_memory_restart pm2 (restart di tengah transaksi). Yang tertua dibuang; pemilik
  // yang terbuang dibaca ulang lewat ownerOf bila muncul lagi.
  cacheOwner(venue, tokenId, owner) {
    const k = this.ownerKey(venue, tokenId);
    this.owners.delete(k);
    this.owners.set(k, owner);
    if (this.owners.size > (this.maxOwners || 50_000)) {
      let drop = Math.ceil(this.owners.size / 5);
      for (const key of this.owners.keys()) { if (drop-- <= 0) break; this.owners.delete(key); }
    }
  }
  knownOwner(venue, tokenId) { return this.owners.get(this.ownerKey(venue, tokenId)) || null; }

  // Selesaikan tokenId -> pemilik untuk banyak id sekaligus (dengan cache).
  async resolveOwners(venue, tokenIds) {
    const need = [...new Set(tokenIds.map(String))].filter((id) => !this.owners.has(this.ownerKey(venue, id)));
    if (!need.length) return;
    const to = venue === 'v4' ? this.chain.ADDR.posmV4 : this.chain.npmFor(venue);
    const iface = venue === 'v4' ? IF_POSM : IF_NPM;
    // strict: ownerOf yang tidak terbaca (kuota) ≠ revert (NFT dibakar). Tanpa ini aksi
    // likuiditas target tersaring sebagai "bukan milik target" dan hilang selamanya.
    const res = await this.rpc.ethCallMany(need.map((id) => ({ to, data: iface.encodeFunctionData('ownerOf', [BigInt(id)]) })), 'latest', { strict: true });
    need.forEach((id, i) => {
      const w = res[i];
      if (w && w !== '0x' && !/^0x0*$/.test(w)) { this.cacheOwner(venue, id, asAddr(w)); return; }
      // ownerOf revert = NFT sudah dibakar. Kalau burn-nya ada di rentang yang sama, log
      // Transfer sudah mengisi pemiliknya. Kalau burn terjadi SESUDAH rentang ini (target
      // menarik di satu tx lalu membakar di tx berikutnya, sebelum kita sempat membaca),
      // pemilik terakhir yang kita catat dipakai — tanpa ini penarikannya tersaring sebagai
      // "bukan milik target" dan cermin kita baru ditutup belakangan oleh rekonsiliasi.
      const row = this.store.get('SELECT target FROM actions WHERE chain=? AND venue=? AND token_id=? ORDER BY id DESC LIMIT 1', this.network, venue, id);
      if (row?.target) this.cacheOwner(venue, id, String(row.target).toLowerCase());
    });
  }

  // ---- ambil semua log yang relevan di satu rentang blok ------------------
  async fetchRange(fromBlock, toBlock) {
    const hex = (n) => '0x' + n.toString(16);
    const range = { fromBlock: hex(fromBlock), toBlock: hex(toBlock) };
    // SATU query untuk ketiga sumber (alamat & topik boleh berupa daftar; hasilnya
    // dipilah lagi per alamat+topik di bawah). Dulu tiga query terpisah tiap 1,5 detik
    // — dikali dua instance — menghabiskan kuota endpoint gratisan (429 beruntun).
    // Failover antar-endpoint tetap ada di rpc.getLogs, per query.
    //
    // Hanya topik yang kita butuhkan yang diminta. Mengambil SEMUA log NPM ikut
    // menyeret Collect dan Approval (>50% volume) dan itu yang memicu 429 saat mengejar.
    const { ADDR } = this.chain;
    const logs = await this.rpc.getLogs({
      address: [ADDR.poolManager, ADDR.posmV4, ...this.npmVenue.keys()],
      topics: [[TOPIC.modifyLiquidity, TOPIC.transfer, TOPIC.increaseLiq, TOPIC.decreaseLiq]],
      ...range,
    }, { priority: true });
    const modLiq = [], xferV4 = [], npm = [];
    for (const l of logs || []) {
      const a = String(l.address || '').toLowerCase(), t0 = String(l.topics?.[0] || '').toLowerCase();
      if (a === ADDR.poolManager && t0 === TOPIC.modifyLiquidity) modLiq.push(l);
      else if (a === ADDR.posmV4 && t0 === TOPIC.transfer) xferV4.push(l);
      else if (this.npmVenue.has(a) && (t0 === TOPIC.transfer || t0 === TOPIC.increaseLiq || t0 === TOPIC.decreaseLiq)) { l.venue = this.npmVenue.get(a); npm.push(l); }
    }
    return { modLiq: modLiq || [], xferV4: xferV4 || [], npm: npm || [] };
  }

  // ---- olah satu rentang -> daftar aksi ----------------------------------
  async scan(fromBlock, toBlock) {
    // Hanya target yang menyala. Aksi target yang dimatikan tidak dicatat sama sekali —
    // tidak menambah daftar aktivitas dan tidak memicu peringatan di dasbor. Bot memang
    // tidak menyalin apa pun dari target mati, jadi tidak ada sinyal yang hilang.
    //
    // Satu pengecualian: target yang dimatikan tapi masih punya cermin terbuka. Sinyal
    // KELUAR-nya untuk cermin itu tetap diambil (dan hanya itu, disaring di bawah) —
    // mematikan target berarti berhenti menyalin, bukan meninggalkan posisi yang sudah
    // dibuka tanpa diikuti saat target menariknya.
    const enabled = this.enabledSet();
    const exitOnly = this.disabledWithMirrors(enabled);
    const targets = new Set([...enabled, ...exitOnly.keys()]);
    if (!targets.size) return [];
    const { modLiq, xferV4, npm } = await this.fetchRange(fromBlock, toBlock);
    const actions = [];

    // 1. Transfer NFT: perbarui peta kepemilikan lebih dulu supaya mint di tx yang sama terbaca.
    const noteTransfer = (venue, l) => {
      const from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
      const tokenId = BigInt(l.topics[3]).toString();
      this.cacheOwner(venue, tokenId, to);
      if (targets.has(to) && from !== '0x0000000000000000000000000000000000000000') {
        actions.push({ kind: 'transfer_in', venue, tokenId, target: to, counterparty: from, log: l });
      } else if (targets.has(from) && to !== '0x0000000000000000000000000000000000000000') {
        actions.push({ kind: 'transfer_out', venue, tokenId, target: from, counterparty: to, log: l });
      }
      // untuk burn (to = 0x0) simpan pemilik sebelumnya supaya aksi burn tetap terhubung
      if (to === '0x0000000000000000000000000000000000000000') this.cacheOwner(venue, tokenId, from);
    };
    for (const l of xferV4) if (l.topics.length === 4) noteTransfer('v4', l);
    for (const l of npm) if (l.topics[0] === TOPIC.transfer && l.topics.length === 4) noteTransfer(l.venue, l);

    // Target contoh memakai layanan otomasi yang MENITIP NFT posisi ke routernya lalu
    // mengembalikannya di transaksi yang sama. Kalau perpindahan itu dibaca sebagai
    // "target keluar", bot akan menutup posisi yang sebenarnya masih hidup.
    // Aturannya: perpindahan ke/dari sebuah KONTRAK = penitipan, bukan pelepasan.
    if (actions.length) {
      await this.contractCheck(actions.map((a) => a.counterparty));
      for (const a of actions) {
        if (this.isContract.get(a.counterparty)) a.kind = a.kind === 'transfer_out' ? 'custody_out' : 'custody_in';
      }
    }

    // 2. v4 ModifyLiquidity
    const v4Rows = [];
    const unsupportedTx = new Set();
    this.unsupportedSender.clear();
    for (const l of modLiq) {
      const sender = asAddr(l.topics[2]);
      if (sender !== this.chain.ADDR.posmV4) {
        this.unsupported.set(sender, (this.unsupported.get(sender) || 0) + 1);
        // Kepemilikannya tidak lewat NFT PositionManager, jadi tidak bisa dicermin.
        // Kalau yang memakainya ternyata TARGET kita, itu harus berbunyi: artinya
        // target pindah ke router jenis lain dan bot berhenti menyalinnya diam-diam.
        unsupportedTx.add(l.transactionHash);
        this.unsupportedSender.set(l.transactionHash, [...(this.unsupportedSender.get(l.transactionHash) || []), sender]);
        continue;
      }
      const b = ethers.getBytes(l.data);
      const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
      const tickLower = i24(w(0)), tickUpper = i24(w(1));
      const liqDelta = i256(w(2));
      const tokenId = w(3).toString();
      if (liqDelta === 0n) continue; // hanya klaim fee
      v4Rows.push({ l, poolId: l.topics[1], tickLower, tickUpper, liqDelta, tokenId });
    }
    // 2b. Jaring pengaman silang. Aksi transfer/penitipan dan aksi likuiditas datang
    // dari DUA query getLogs terpisah atas rentang yang sama. Kalau query PoolManager
    // gagal sebagian sementara query PositionManager berhasil, perubahan likuiditas
    // hilang diam-diam sementara penitipannya tercatat — persis yang terjadi pada
    // penutupan #2339460 (blok 59601918): custody_out + custody_in tercatat, decrease
    // tidak, sehingga posisi cermin kita tidak akan pernah ikut ditutup.
    // Untuk tiap transaksi yang SUDAH kita ketahui menyangkut target, log
    // ModifyLiquidity-nya diambil langsung dari receipt.
    const seenTx = new Set(v4Rows.map((r) => r.l.transactionHash));
    const needTx = [...new Set(actions.filter((a) => a.venue === 'v4').map((a) => a.log.transactionHash))]
      .filter((h) => !seenTx.has(h));
    if (needTx.length) {
      const rcs = await this.rpc.batch(needTx.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
      // Jaring pengaman yang bolong kalau receipt-nya tidak terbaca: aksi likuiditas
      // target hilang diam-diam sementara kursor maju. Lempar — rentang diulang.
      const miss = rcs.findIndex((r) => !r || r.error || !r.result);
      if (miss >= 0) throw new Error(`receipt ${needTx[miss].slice(0, 12)}… tidak terbaca dari RPC`);
      for (const r of rcs) {
        const rc = r.result;
        for (const l of rc?.logs || []) {
          if (l.address.toLowerCase() !== this.chain.ADDR.poolManager || l.topics[0] !== TOPIC.modifyLiquidity) continue;
          if (asAddr(l.topics[2]) !== this.chain.ADDR.posmV4) continue;
          const b = ethers.getBytes(l.data);
          const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
          const liqDelta = i256(w(2));
          if (liqDelta === 0n) continue;
          v4Rows.push({ l, poolId: l.topics[1], tickLower: i24(w(0)), tickUpper: i24(w(1)), liqDelta, tokenId: w(3).toString() });
          this.log(`aksi likuiditas terselamatkan dari receipt ${l.transactionHash.slice(0, 12)}… (query log tidak memuatnya)`);
        }
      }
    }

    // Siapa pengirim transaksi LP yang tidak didukung itu? Kalau target, beri
    // peringatan keras — sekali per target, supaya log tidak banjir.
    if (unsupportedTx.size) await this.warnIfTargetUnsupported([...unsupportedTx], enabled);

    await this.resolveOwners('v4', v4Rows.map((r) => r.tokenId));

    // 3. v3 NPM increase/decrease
    const v3Rows = [];
    for (const l of npm) {
      const t0 = l.topics[0];
      if (t0 !== TOPIC.increaseLiq && t0 !== TOPIC.decreaseLiq) continue;
      const tokenId = BigInt(l.topics[1]).toString();
      const b = ethers.getBytes(l.data);
      const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
      const liq = w(0), a0 = w(1), a1 = w(2);
      if (liq === 0n) continue;
      v3Rows.push({ l, venue: l.venue, tokenId, liq: t0 === TOPIC.increaseLiq ? liq : -liq, a0, a1 });
    }
    for (const venue of new Set(v3Rows.map((r) => r.venue))) {
      await this.resolveOwners(venue, v3Rows.filter((r) => r.venue === venue).map((r) => r.tokenId));
    }

    // 4. saring yang milik target lalu lengkapi detailnya
    const mineV4 = v4Rows.filter((r) => targets.has(this.knownOwner('v4', r.tokenId) || ''));
    const mineV3 = v3Rows.filter((r) => targets.has(this.knownOwner(r.venue, r.tokenId) || ''));

    const out = [];
    if (mineV4.length) out.push(...await this.enrichV4(mineV4));
    for (const venue of new Set(mineV3.map((r) => r.venue))) {
      out.push(...await this.enrichV3(mineV3.filter((r) => r.venue === venue), venue));
    }
    for (const a of actions) {
      out.push({
        ts: await this.chain.blockTs(parseInt(a.log.blockNumber, 16)),
        block: parseInt(a.log.blockNumber, 16), txHash: a.log.transactionHash,
        logIndex: parseInt(a.log.logIndex, 16), target: a.target, venue: a.venue,
        kind: a.kind, tokenId: a.tokenId,
      });
    }
    out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    if (!exitOnly.size) return out;
    return out.filter((a) => {
      const ids = exitOnly.get(a.target);
      if (!ids) return true;
      return (a.kind === 'decrease' || a.kind === 'transfer_out') && ids.has(String(a.tokenId));
    });
  }

  // target dimatikan -> Set(tokenId posisi target yang masih kita cermin)
  disabledWithMirrors(enabled) {
    const out = new Map();
    const rows = this.store.all(`SELECT p.target, p.mirror_of FROM positions p JOIN targets t ON t.address = p.target AND t.chain = p.chain
      WHERE p.chain=? AND p.status='open' AND p.mirror_of IS NOT NULL AND t.enabled = 0`, this.network);
    for (const r of rows) {
      const a = String(r.target).toLowerCase();
      if (enabled.has(a)) continue;
      if (!out.has(a)) out.set(a, new Set());
      out.get(a).add(String(r.mirror_of));
    }
    return out;
  }

  async enrichV4(rows) {
    // ambil poolKey per tokenId (sekali saja, di-cache)
    const need = rows.filter((r) => !this.v4Info.has(r.tokenId)).map((r) => r.tokenId);
    if (need.length) {
      const res = await this.rpc.ethCallMany(need.map((id) => ({
        to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(id)]),
      })), 'latest', { strict: true });
      need.forEach((id, i) => {
        if (!res[i] || res[i] === '0x') return;
        try {
          const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', res[i]);
          const pk = {
            currency0: d[0].currency0.toLowerCase(), currency1: d[0].currency1.toLowerCase(),
            fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks.toLowerCase(),
          };
          // NFT yang sudah dibakar TIDAK revert — ia mengembalikan poolKey serba nol.
          // Jangan disimpan: poolKey nol membuat aksi tampak sebagai pool 0x0/0x0.
          if (/^0x0+$/.test(pk.currency1) && pk.fee === 0) return;
          this.v4Info.set(id, { poolKey: pk, poolId: computePoolId(d[0]) });
        } catch { /* tidak terbaca: diisi jalur cadangan di bawah */ }
      });
    }
    // Cadangan untuk NFT yang sudah dibakar saat dibaca — target buka-tutup cepat,
    // atau rebalance mint+burn dalam satu tx. poolId ada di event ModifyLiquidity;
    // poolKey-nya dicari dari calldata tx mint atau event Initialize.
    for (const r of rows) {
      if (this.v4Info.has(r.tokenId)) continue;
      try {
        const pk = await this.chain.poolKeyOfId(r.poolId, parseInt(r.l.blockNumber, 16), r.l.transactionHash);
        if (pk && computePoolId(pk).toLowerCase() === r.poolId.toLowerCase()) {
          this.v4Info.set(r.tokenId, { poolKey: pk, poolId: r.poolId });
        }
      } catch (e) { this.log(`poolKey #${r.tokenId} tidak terbaca: ${e.message}`); }
    }
    const outs = [];
    const poolIds = [...new Set(rows.map((r) => r.poolId))];
    const slots = await this.chain.slot0V4Many(poolIds);
    const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
    const allTokens = new Set();
    for (const r of rows) {
      const info = this.v4Info.get(r.tokenId);
      if (info) { allTokens.add(info.poolKey.currency0); allTokens.add(info.poolKey.currency1); }
    }
    const metas = await this.chain.tokens([...allTokens]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    for (const r of rows) {
      const info = this.v4Info.get(r.tokenId);
      const pk = info?.poolKey;
      const s = slotBy.get(r.poolId);
      let amount0 = 0n, amount1 = 0n, valueQuote = null, quoteSymbol = null;
      if (s && pk) {
        const a = m.getSqrtRatioAtTick(r.tickLower), b = m.getSqrtRatioAtTick(r.tickUpper);
        const abs = r.liqDelta < 0n ? -r.liqDelta : r.liqDelta;
        const amt = m.amountsForLiquidity(s.sqrtPriceX96, a, b, abs);
        amount0 = amt.amount0; amount1 = amt.amount1;
        const d0 = metaBy.get(pk.currency0)?.decimals ?? 18;
        const d1 = metaBy.get(pk.currency1)?.decimals ?? 18;
        const v = this.chain.valueInQuote({
          sqrtPriceX96: s.sqrtPriceX96, amount0, amount1, dec0: d0, dec1: d1,
          token0: pk.currency0, token1: pk.currency1,
        });
        if (v) { valueQuote = v.value; quoteSymbol = v.symbol; }
      }
      outs.push({
        ts: await this.chain.blockTs(parseInt(r.l.blockNumber, 16)),
        block: parseInt(r.l.blockNumber, 16), txHash: r.l.transactionHash,
        logIndex: parseInt(r.l.logIndex, 16),
        target: this.knownOwner('v4', r.tokenId), venue: 'v4',
        kind: r.liqDelta > 0n ? 'increase' : 'decrease',
        tokenId: r.tokenId, poolRef: r.poolId, poolKey: pk,
        token0: pk?.currency0, token1: pk?.currency1, fee: pk?.fee,
        tickSpacing: pk?.tickSpacing, hooks: pk?.hooks,
        tickLower: r.tickLower, tickUpper: r.tickUpper,
        liquidity: r.liqDelta.toString(), amount0: amount0.toString(), amount1: amount1.toString(),
        valueQuote, quoteSymbol, slot0: s,
      });
    }
    return outs;
  }

  async enrichV3(rows, venue = 'v3') {
    const npm = this.chain.npmFor(venue);
    const ids = [...new Set(rows.map((r) => r.tokenId))];
    const res = await this.rpc.ethCallMany(ids.map((id) => ({
      to: npm, data: IF_NPM.encodeFunctionData('positions', [BigInt(id)]),
    })), 'latest', { strict: true });
    const posBy = new Map();
    ids.forEach((id, i) => {
      if (!res[i] || res[i] === '0x') return;
      try {
        const d = IF_NPM.decodeFunctionResult('positions', res[i]);
        posBy.set(id, {
          token0: d[2].toLowerCase(), token1: d[3].toLowerCase(), fee: Number(d[4]),
          tickLower: Number(d[5]), tickUpper: Number(d[6]), liquidity: d[7],
        });
      } catch { /* ignore */ }
    });
    const toks = new Set();
    for (const p of posBy.values()) { toks.add(p.token0); toks.add(p.token1); }
    const metas = await this.chain.tokens([...toks]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    const outs = [];
    for (const r of rows) {
      const p = posBy.get(r.tokenId);
      let poolAddr = null, s = null, valueQuote = null, quoteSymbol = null;
      if (p) {
        poolAddr = await this.chain.poolV3Addr(p.token0, p.token1, p.fee, npm);
        if (poolAddr) s = await this.chain.slot0V3(poolAddr);
        if (s) {
          const v = this.chain.valueInQuote({
            sqrtPriceX96: s.sqrtPriceX96, amount0: r.a0, amount1: r.a1,
            dec0: metaBy.get(p.token0)?.decimals ?? 18, dec1: metaBy.get(p.token1)?.decimals ?? 18,
            token0: p.token0, token1: p.token1,
          });
          if (v) { valueQuote = v.value; quoteSymbol = v.symbol; }
        }
      }
      outs.push({
        ts: await this.chain.blockTs(parseInt(r.l.blockNumber, 16)),
        block: parseInt(r.l.blockNumber, 16), txHash: r.l.transactionHash,
        logIndex: parseInt(r.l.logIndex, 16),
        target: this.knownOwner(venue, r.tokenId), venue,
        kind: r.liq > 0n ? 'increase' : 'decrease',
        tokenId: r.tokenId, poolRef: poolAddr,
        token0: p?.token0, token1: p?.token1, fee: p?.fee, tickSpacing: null, hooks: null,
        tickLower: p?.tickLower, tickUpper: p?.tickUpper,
        liquidity: r.liq.toString(), amount0: r.a0.toString(), amount1: r.a1.toString(),
        valueQuote, quoteSymbol, slot0: s,
      });
    }
    return outs;
  }

  // Simpan aksi ke DB; kembalikan yang benar-benar baru (belum pernah tercatat).
  persist(actions) {
    const fresh = [];
    for (const a of actions) {
      const r = this.store.run(
        `INSERT OR IGNORE INTO actions
         (chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
          tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.network, a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId ?? null,
        a.poolRef ?? null, a.token0 ?? null, a.token1 ?? null, a.fee ?? null, a.tickSpacing ?? null,
        a.hooks ?? null, a.tickLower ?? null, a.tickUpper ?? null, a.liquidity ?? null,
        a.amount0 ?? null, a.amount1 ?? null, a.valueQuote ?? null, a.quoteSymbol ?? null);
      if (r.changes) {
        a.id = Number(r.lastInsertRowid);
        fresh.push(a);
      }
    }
    return fresh;
  }
}

module.exports = { Watcher };
