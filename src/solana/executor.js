'use strict';
// Pengirim transaksi Solana: satu-satunya tempat kunci dipakai.
//
// Adapter venue mengembalikan GRUP instruksi ({instructions, signers, lookupTables});
// di sini tiap grup jadi satu transaksi v0: harga compute (biaya prioritas) dari fee
// terkini akun-akun yang ditulis, batas compute dari simulasi, ditandatangani wallet +
// penanda tangan sementara (keypair posisi / mint NFT), lalu dikirim dan disiarkan ulang
// sampai terkonfirmasi atau blockhash-nya kedaluwarsa. Grup dijalankan berurutan: yang
// berikutnya bergantung pada yang sebelumnya (buat akun → isi likuiditas).
//
// Biaya tiap transaksi dibukukan ke tabel txs dalam USD pada harga SOL saat itu —
// sama dengan gas_quote di EVM, supaya halaman biaya dan PnL bersih tetap berlaku.
const {
  PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { loadKeypair, keyFileOf } = require('./wallet');
const { WSOL } = require('../networks');

const CB_PROGRAM = ComputeBudgetProgram.programId.toBase58();
const MAX_CU = 1_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SolanaExecutor {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.kp = undefined;
    this.txSeq = 0;          // naik tiap tx terkonfirmasi — penanda kas basi (engine.cash)
    this.minedBlock = 0;     // slot tx terakhir
    this.lutCache = new Map();
    this.ethUsd = () => null;
  }

  // ---- dompet -----------------------------------------------------------------
  loadWallet() {
    if (this.kp !== undefined && this.kp !== null) return this.kp;
    this.kp = loadKeypair(this.cfg);
    return this.kp;
  }
  address() { let k; try { k = this.loadWallet(); } catch { k = null; } return k ? k.publicKey.toBase58() : null; }
  resetWallet() { this.kp = undefined; }
  keyPath() { return keyFileOf(this.cfg); }

  // Saldo: 'SOL' = lamport native; mint lain = jumlah semua akun token wallet untuk
  // mint itu (SPL + Token-2022). wSOL dilaporkan terpisah di bawah mint WSOL.
  async balances(mints = null) {
    const owner = this.address();
    const out = new Map();
    if (!owner) return out;
    const pk = new PublicKey(owner);
    const [lamports, a, b] = await Promise.all([
      this.rpc.run((c) => c.getBalance(pk, 'confirmed')),
      this.rpc.run((c) => c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID })),
      this.rpc.run((c) => c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM_ID })),
    ]);
    out.set('SOL', BigInt(lamports));
    for (const { account } of [...a.value, ...b.value]) {
      const info = account.data?.parsed?.info;
      if (!info) continue;
      const amt = BigInt(info.tokenAmount?.amount || '0');
      out.set(info.mint, (out.get(info.mint) || 0n) + amt);
    }
    if (mints) for (const m of mints) if (!out.has(m)) out.set(m, 0n);
    return out;
  }

  // Cadangan SOL untuk biaya transaksi + sewa akun (posisi DLMM ~0,06 SOL, ATA ~0,002)
  // — tidak pernah dipakai sebagai modal posisi.
  gasReserveCached() { return BigInt(this.cfg.gas?.native_reserve_lamports ?? 150_000_000); }
  async gasReserve() { return this.gasReserveCached(); }

  // ---- biaya prioritas -----------------------------------------------------------
  // microLamport per CU: persentil ke-75 fee prioritas terkini untuk akun-akun yang
  // ditulis transaksi ini, diapit batas config.
  async cuPrice(writable) {
    const g = this.cfg.gas || {};
    const lo = Number(g.min_cu_price_micro ?? 10_000), hi = Number(g.max_cu_price_micro ?? 2_000_000);
    try {
      const fees = await this.rpc.run((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128).map((k) => new PublicKey(k)) }));
      const xs = fees.map((f) => f.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
      const p75 = xs.length ? xs[Math.floor(xs.length * 0.75)] : lo;
      return Math.max(lo, Math.min(hi, Math.round(p75 * Number(g.price_multiplier ?? 1.2))));
    } catch { return lo; }
  }

  async luts(addrs) {
    const out = [];
    for (const a of addrs || []) {
      if (!this.lutCache.has(a)) {
        const r = await this.rpc.run((c) => c.getAddressLookupTable(new PublicKey(a)));
        if (r.value) this.lutCache.set(a, r.value);
      }
      if (this.lutCache.has(a)) out.push(this.lutCache.get(a));
    }
    return out;
  }

  async compile(ixs, luts, blockhash, cuLimit, cuPrice) {
    const payer = new PublicKey(this.address());
    const pre = [];
    if (cuLimit) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (cuPrice) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...pre, ...ixs] }).compileToV0Message(luts);
    return new VersionedTransaction(msg);
  }

  // Tanda tangan dengan wallet + penanda tangan tambahan yang memang diminta pesan.
  sign(tx, extra = []) {
    const need = new Set(tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()));
    const signers = [this.loadWallet(), ...extra].filter((s, i, a) => need.has(s.publicKey.toBase58()) && a.findIndex((x) => x.publicKey.equals(s.publicKey)) === i);
    tx.sign(signers);
    return tx;
  }

  // Satu grup -> tx terkonfirmasi. {ok, hash, fee, cu, error}
  async sendGroup(group, { kind, detail = null }) {
    const kp = this.loadWallet();
    if (!kp) throw new Error('wallet Solana belum diisi');
    const ixs = (group.instructions || []).filter((ix) => ix.programId.toBase58() !== CB_PROGRAM);
    if (!ixs.length) return { ok: true, hash: null, skipped: true };
    const luts = await this.luts(group.lookupTables);
    const writable = [...new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))];
    const cuPrice = await this.cuPrice(writable);
    let { blockhash, lastValidBlockHeight } = await this.rpc.run((c) => c.getLatestBlockhash('confirmed'));

    // Simulasi dulu: galat program ketahuan sebelum membayar biaya apa pun, dan
    // unitsConsumed menentukan batas compute (+20% ruang).
    const simTx = this.sign(await this.compile(ixs, luts, blockhash, MAX_CU, cuPrice), group.signers);
    const sim = await this.rpc.run((c) => c.simulateTransaction(simTx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }));
    if (sim.value.err) {
      const logs = (sim.value.logs || []).slice(-6).join(' | ');
      throw new Error(`simulasi ${kind} gagal: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs.slice(0, 400)}` : ''}`);
    }
    const cuLimit = Math.min(MAX_CU, Math.ceil((sim.value.unitsConsumed || 200_000) * 1.2) + 20_000);
    const tx = this.sign(await this.compile(ixs, luts, blockhash, cuLimit, cuPrice), group.signers);
    return this.sendSigned(tx, { kind, detail, lastValidBlockHeight });
  }

  // Transaksi yang sudah jadi (swap Jupiter) — cukup ditandatangani wallet.
  async sendVersioned(tx, { kind, detail = null, lastValidBlockHeight = null }) {
    if (!this.loadWallet()) throw new Error('wallet Solana belum diisi');
    this.sign(tx);
    if (!lastValidBlockHeight) lastValidBlockHeight = (await this.rpc.run((c) => c.getLatestBlockhash('confirmed'))).lastValidBlockHeight;
    return this.sendSigned(tx, { kind, detail, lastValidBlockHeight });
  }

  async sendSigned(tx, { kind, detail, lastValidBlockHeight }) {
    const raw = tx.serialize();
    const hash = require('bs58').default.encode(tx.signatures[0]);
    this.store.run('INSERT OR REPLACE INTO txs(chain,hash,ts,kind,status,detail) VALUES(?,?,?,?,?,?)',
      this.chain.network, hash, Date.now(), kind, 'terkirim', detail ? JSON.stringify(detail) : null);
    // Kirim ke SEMUA endpoint yang boleh mengirim (siaran lebih luas = masuk lebih cepat),
    // lalu siarkan ulang tiap 2 detik sampai terkonfirmasi atau blockhash habis.
    const blast = () => Promise.allSettled(this.rpc.order({ send: true }).map((e) =>
      e.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })));
    const first = await blast();
    if (first.every((r) => r.status === 'rejected')) {
      const why = String(first[0].reason?.message || first[0].reason).slice(0, 300);
      this.store.run('UPDATE txs SET status=?, error=? WHERE hash=?', 'gagal', why, hash);
      throw new Error(`kirim ${kind} ditolak semua endpoint: ${why}`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      await sleep(2000);
      let st = null;
      try { st = (await this.rpc.run((c) => c.getSignatureStatuses([hash], { searchTransactionHistory: false }))).value[0]; } catch { /* tanya lagi */ }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return this.settle(hash, st);
      }
      let height = 0;
      try { height = await this.rpc.run((c) => c.getBlockHeight('confirmed')); } catch { /* tanya lagi */ }
      if (lastValidBlockHeight && height > lastValidBlockHeight) {
        // Blockhash habis: satu kali lagi cek riwayat (bisa saja masuk di detik terakhir).
        try {
          const late = (await this.rpc.run((c) => c.getSignatureStatuses([hash], { searchTransactionHistory: true }))).value[0];
          if (late && late.confirmationStatus) return this.settle(hash, late);
        } catch { /* anggap kedaluwarsa */ }
        this.store.run('UPDATE txs SET status=?, error=? WHERE hash=?', 'gagal', 'blockhash kedaluwarsa (tidak masuk)', hash);
        return { ok: false, hash, expired: true };
      }
      blast().catch(() => {});
    }
    this.store.run('UPDATE txs SET status=?, error=? WHERE hash=?', 'gagal', 'batas tunggu konfirmasi habis', hash);
    return { ok: false, hash, timeout: true };
  }

  async settle(hash, st) {
    const ok = !st.err;
    let fee = null, cu = null, meta = null;
    // Node yang tertinggal bisa menjawab null tepat sesudah konfirmasi: diulang sebentar.
    // meta dipakai untuk biaya DAN hasil swap sesungguhnya (deltas).
    for (let i = 0; i < 5 && !meta; i++) {
      try {
        const tx = await this.rpc.run((c) => c.getTransaction(hash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
        meta = tx?.meta || null;
      } catch { /* tanya lagi */ }
      if (!meta) await sleep(800);
    }
    fee = meta?.fee ?? null; cu = meta?.computeUnitsConsumed ?? null;
    const sol = this.ethUsd();
    const feeUsd = fee != null && sol > 0 ? (fee / LAMPORTS_PER_SOL) * sol : null;
    // Kolom gas mengikuti rumus EVM di seluruh dasbor (gas_used × gas_price / 1e18 =
    // biaya dalam koin native): gas_used = biaya dalam lamport, gas_price = 1e9, sehingga
    // hasilnya tepat biaya dalam SOL. Compute unit disimpan di detail.
    this.store.run('UPDATE txs SET status=?, gas_used=?, gas_price=?, gas_quote=COALESCE(?,gas_quote), error=? WHERE hash=?',
      ok ? 'sukses' : 'gagal', fee, fee != null ? '1000000000' : null, feeUsd, ok ? null : JSON.stringify(st.err).slice(0, 300), hash);
    if (cu != null) this.noteTx(hash, { computeUnits: cu });
    this.txSeq++;
    this.minedBlock = Math.max(this.minedBlock, st.slot || 0);
    return { ok, hash, fee, cu, meta, slot: st.slot, error: ok ? null : st.err };
  }

  // Simulasi saja (mode simulasi dengan wallet): tiap grup disusun & disimulasikan,
  // tanpa tanda tangan dan tanpa kirim. Grup berikutnya bergantung pada yang pertama
  // (buat akun → isi), jadi hanya grup pertama yang wajib lolos; hasilnya dilaporkan.
  async simulateGroups(groups) {
    const g = groups.find((x) => (x.instructions || []).length);
    if (!g) return { ok: true, cu: 0 };
    const ixs = g.instructions.filter((ix) => ix.programId.toBase58() !== CB_PROGRAM);
    const luts = await this.luts(g.lookupTables);
    const { blockhash } = await this.rpc.run((c) => c.getLatestBlockhash('confirmed'));
    const tx = await this.compile(ixs, luts, blockhash, MAX_CU, 10_000);
    const r = await this.rpc.run((c) => c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }));
    if (r.value.err) return { ok: false, error: `${JSON.stringify(r.value.err)} — ${(r.value.logs || []).slice(-3).join(' | ').slice(0, 300)}` };
    return { ok: true, cu: r.value.unitsConsumed, groups: groups.length };
  }

  // Jalankan semua grup berurutan; berhenti di grup pertama yang gagal.
  async sendGroups(groups, { kind, detail = null }) {
    const hashes = [];
    let last = null;
    for (let i = 0; i < groups.length; i++) {
      const r = await this.sendGroup(groups[i], { kind: groups.length > 1 ? `${kind}${i ? `_${i + 1}` : ''}` : kind, detail });
      if (r.skipped) continue;
      hashes.push(r.hash);
      last = r;
      if (!r.ok) return { ok: false, hashes, last, failedAt: i };
    }
    return { ok: true, hashes, last };
  }

  noteTx(hash, patch) {
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', hash);
      if (!row) return;
      let d = {}; try { d = JSON.parse(row.detail || '{}') || {}; } catch { d = {}; }
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, ...patch }), hash);
    } catch { /* catatan tambahan tidak boleh menggagalkan transaksi */ }
  }

  // Selisih saldo wallet per mint dalam satu transaksi (dari meta tx). SOL native
  // (lamport) di bawah kunci 'SOL' — sudah termasuk biaya dan sewa akun.
  deltas(meta) {
    const owner = this.address();
    const out = new Map();
    if (!meta || !owner) return out;
    const add = (m, v) => out.set(m, (out.get(m) || 0n) + v);
    for (const b of meta.preTokenBalances || []) if (b.owner === owner) add(b.mint, -BigInt(b.uiTokenAmount.amount));
    for (const b of meta.postTokenBalances || []) if (b.owner === owner) add(b.mint, BigInt(b.uiTokenAmount.amount));
    // akun pertama = pembayar = wallet kita
    if (meta.preBalances && meta.postBalances) add('SOL', BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]));
    return out;
  }
}

module.exports = { SolanaExecutor, WSOL };
