import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, Modal, Input, toast } from '@heroui/react';
import { ArrowDownUp, ArrowRight, Brush, Check, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, CircleCheck, CircleX, Clock, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import { PageHeader, Notice, Loading, KV, Panel, Empty, Refreshing, TxHash } from '../components/ui';
import TokenIcon, { TokenSym } from '../components/TokenIcon';
import { usd, num, pct, short, ago, TXSTATUS } from '../fmt';
import { useI18n } from '../i18n';

const PORSI = [['25%', '25%'], ['50%', '50%'], ['75%', '75%'], ['semua', 'Maks']];
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

// Satu baris token di pemilih: lambang, simbol (+ penanda "manual"), alamat singkat,
// saldo dan nilainya di kanan.
function TokenRow({ x, onPick, disabled }) {
  const { t } = useI18n();
  return (
    <button type="button" disabled={disabled} onClick={() => onPick(x.address)}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-default disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent">
      <TokenIcon address={x.address} symbol={x.symbol} size={30} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{x.symbol}</span>
          {x.custom && <span className="rounded bg-default px-1.5 py-px text-[0.6875rem] font-medium text-muted">{t('manual')}</span>}
        </span>
        <span className="mono block truncate text-xs text-muted">{x.native ? 'native' : short(x.address)}</span>
      </span>
      <span className="shrink-0 text-end">
        <span className={`num block text-sm ${x.amount > 0 ? 'font-medium' : 'text-muted'}`}>{num(x.amount, 6)}</span>
        {x.usd != null && x.amount > 0 && <span className="num block text-xs text-muted">{usd(x.usd)}</span>}
      </span>
    </button>
  );
}

// Pemilih token ala dompet: tombolnya cukup lambang + simbol, dialognya punya kotak
// cari yang juga menerima alamat 0x… — token yang belum dikenal bisa ditambahkan
// dari situ tanpa harus pernah jadi posisi dulu.
function TokenPicker({ value, onChange, list, all, exclude, side, onImport }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cek, setCek] = useState(null);   // hasil /api/address untuk alamat yang ditempel
  const [tambah, setTambah] = useState(false);
  const cur = all.find((x) => x.address === value);
  const qq = q.trim().toLowerCase();

  const shown = useMemo(() => (qq
    ? list.filter((x) => x.symbol.toLowerCase().includes(qq) || x.address.includes(qq))
    : list), [list, qq]);
  // Alamat yang ditempel tapi tidak ada di daftar sisi ini. Kalau tokennya sudah
  // dikenal (mis. saldo kosong di sisi "dari"), tidak perlu ditanyakan ke chain.
  const known = isAddr(qq) ? all.find((x) => x.address === qq) : null;
  const perluCek = isAddr(qq) && !shown.length && !known;

  useEffect(() => {
    setCek(null);
    if (!perluCek) return;
    let alive = true;
    setCek({ loading: true });
    get(`/api/address?a=${qq}`).then((r) => { if (alive) setCek(r); }).catch((e) => alive && setCek({ error: e.message }));
    return () => { alive = false; };
  }, [qq, perluCek]);

  const tutup = () => { setOpen(false); setQ(''); setCek(null); };
  const pilih = (a) => { onChange(a); tutup(); };
  const impor = async () => {
    setTambah(true);
    const ok = await onImport(qq, side);
    setTambah(false);
    if (ok) tutup();
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t(side === 'from' ? 'Token yang ditukar' : 'Token yang diterima')}
        className="flex h-10 max-w-40 shrink-0 items-center gap-2 rounded-full border border-border bg-surface pl-1.5 pr-2.5 transition-colors hover:bg-default">
        {cur ? (
          <><TokenIcon address={cur.address} symbol={cur.symbol} size={26} />
            <span className="truncate font-semibold">{cur.symbol}</span></>
        ) : <span className="pl-2 text-sm font-medium">{t('Pilih token')}</span>}
        <ChevronDown className="size-4 shrink-0 text-muted" />
      </button>

      <Modal isOpen={open} onOpenChange={(o) => { if (!o) tutup(); }}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog className="w-[min(24rem,calc(100vw-2rem))]">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{t(side === 'from' ? 'Tukar dari' : 'Tukar ke')}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-3 text-foreground">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <Input autoFocus variant="secondary" className="w-full pl-9" value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder={t('Cari simbol atau tempel alamat 0x…')} aria-label={t('Cari token')} />
                </div>

                {!qq && side === 'to' && (
                  <div className="flex flex-wrap gap-1.5">
                    {all.filter((x) => x.isQuote).map((x) => (
                      <button key={x.address} type="button" disabled={x.address === exclude} onClick={() => pilih(x.address)}
                        className={`flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-3 text-sm font-medium transition-colors disabled:opacity-40 ${x.address === value
                          ? 'border-accent bg-accent/10' : 'border-border hover:bg-default'}`}>
                        <TokenIcon address={x.address} symbol={x.symbol} size={22} />{x.symbol}
                      </button>
                    ))}
                  </div>
                )}

                <div className="-mx-1 max-h-[22rem] overflow-y-auto">
                  {shown.map((x) => (
                    <TokenRow key={x.address} x={x} onPick={pilih} disabled={x.address === exclude} />
                  ))}

                  {!shown.length && known && (
                    <div className="px-2.5 py-6 text-center text-sm text-muted">
                      {t('{s} sudah ada di daftar, tapi saldonya kosong — tidak bisa dijadikan sumber swap.', { s: known.symbol })}
                    </div>
                  )}
                  {!shown.length && perluCek && (
                    cek?.loading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted"><Spinner size="sm" color="current" />{t('Memeriksa alamat…')}</div>
                    ) : cek?.kind === 'token' ? (
                      <div className="flex items-center gap-3 rounded-md border border-border p-3">
                        <TokenIcon address={qq} symbol={cek.symbol} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{cek.symbol}</span>
                          <span className="block truncate text-xs text-muted">{cek.name || short(qq)}</span>
                        </span>
                        <Button size="sm" onPress={impor} isPending={tambah}><Plus className="size-4" />{t('Tambahkan')}</Button>
                      </div>
                    ) : cek ? (
                      <div className="px-2.5 py-6 text-center text-sm text-danger">
                        {cek.error || (cek.kind === 'wallet' ? t('Itu alamat wallet, bukan token.') : t('Kontrak ini bukan token ERC-20.'))}
                      </div>
                    ) : null
                  )}
                  {!shown.length && !isAddr(qq) && (
                    <div className="px-2.5 py-6 text-center text-sm text-muted">
                      {qq.startsWith('0x') ? t('Alamat belum lengkap — 0x diikuti 40 karakter.') : t('Tidak ada yang cocok. Tempel alamat kontraknya untuk menambahkan token baru.')}
                    </div>
                  )}
                </div>

                {!qq && (
                  <p className="text-xs text-muted">
                    {t(side === 'from'
                      ? 'Hanya token yang ada saldonya. Token lain bisa ditambahkan dengan menempel alamat kontraknya.'
                      : 'Token yang tidak ada di daftar bisa ditambahkan dengan menempel alamat kontraknya.')}
                  </p>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

// Panel saldo di samping kartu swap: apa saja yang ada di wallet bot, nilainya, dan
// token manual (yang bisa dihapus lagi). Klik baris = pakai sebagai sisi "dari".
const PER_HAL = 8;
// Bernilai = ada harga dan nilainya minimal satu sen; sisanya (tanpa harga / debu)
// dikumpulkan di bawah supaya aset yang berarti tidak tenggelam di antara memecoin.
const bernilai = (x) => x.usd != null && x.usd >= 0.01;

function Holdings({ tokens, dari, onUse, onRemove, onImport, harga, onRetryHarga }) {
  const { t } = useI18n();
  const [addr, setAddr] = useState('');
  const [kirim, setKirim] = useState(false);
  const [sapu, setSapu] = useState(false);
  const [hal, setHal] = useState(0);
  const rows = useMemo(() => tokens.filter((x) => x.amount > 0 || x.custom)
    .sort((a, b) => (bernilai(b) - bernilai(a)) || (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount), [tokens]);
  const total = rows.reduce((s, x) => s + (x.usd || 0), 0);
  const adaHarga = rows.some((x) => x.usd != null);
  const nBernilai = rows.filter(bernilai).length;
  const nHal = Math.max(1, Math.ceil(rows.length / PER_HAL));
  const halIni = Math.min(hal, nHal - 1);
  const dari0 = halIni * PER_HAL;
  const tampil = rows.slice(dari0, dari0 + PER_HAL);
  const a = addr.trim().toLowerCase();

  const tambah = async () => {
    setKirim(true);
    const ok = await onImport(a, 'panel');
    setKirim(false);
    if (ok) setAddr('');
  };

  // Memasukkan memecoin yang nganggur di wallet ke antrean jual otomatis. Tidak
  // mengirim transaksi apa pun di sini: yang menjual tetap antreannya, dengan batas
  // rugi yang sama. Debu di bawah ambang sengaja tidak diantrekan.
  const sapuSisa = async () => {
    setSapu(true);
    const r = await post('/api/leftovers/sweep', {});
    setSapu(false);
    if (r.error) return toast.danger(r.error, { timeout: 12000 });
    if (r.queued?.length) {
      return toast.success(t('{n} token masuk antrean jual', { n: r.queued.length }), {
        description: r.queued.map((x) => x.label).join(', '), timeout: 12000,
      });
    }
    return toast.warning(t('Tidak ada sisa yang layak dijual'), {
      description: r.skipped?.length
        ? t('{n} token dilewat: {w}', { n: r.skipped.length, w: r.skipped.slice(0, 3).map((x) => `${x.label} — ${x.why}`).join(' · ') })
        : t('Wallet cuma berisi aset kuotasi dan token posisi yang masih terbuka.'),
      timeout: 14000,
    });
  };

  return (
    <Panel title="Aset di wallet" desc="Klik baris untuk menukarnya."
      action={(
        <span className="flex items-center gap-2">
          {harga === 'muat' && <Refreshing loading text="Memuat harga…" />}
          {harga === 'gagal' && (
            <Button size="sm" variant="ghost" onPress={onRetryHarga} className="text-danger">
              <RefreshCw className="size-3.5" />{t('Harga gagal — coba lagi')}
            </Button>
          )}
          {adaHarga && <span className="num text-sm font-semibold">{usd(total)}</span>}
          <Button size="sm" variant="outline" onPress={sapuSisa} isPending={sapu}>
            <Brush className="size-3.5" />{t('Sapu sisa')}
          </Button>
        </span>
      )} bodyClass="p-0">
      {rows.length ? (
        <div className="divide-y divide-border">
          {tampil.map((x, i) => (
            <div key={x.address}>
            {/* pembatas kelompok: baris pertama yang tidak bernilai */}
            {harga !== 'muat' && nBernilai > 0 && dari0 + i === nBernilai && (
              <div className="border-b border-border bg-default/40 px-4 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted">
                {t('Tanpa nilai ({n})', { n: rows.length - nBernilai })}
              </div>
            )}
            <div className={`group flex items-center gap-3 px-4 py-2.5 text-sm ${x.address === dari ? 'bg-accent/5' : ''}`}>
              <button type="button" disabled={!(x.amount > 0)} onClick={() => onUse(x.address)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
                <TokenIcon address={x.address} symbol={x.symbol} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <TokenSym address={x.address} symbol={x.symbol} className="truncate font-medium" />
                    {x.custom && <span className="rounded bg-default px-1.5 py-px text-[0.6875rem] font-medium text-muted">{t('manual')}</span>}
                  </span>
                  <span className="num block truncate text-xs text-muted">
                    {x.priceUsd != null ? usd(x.priceUsd, x.priceUsd < 1 ? 6 : 2) : harga === 'muat' ? '…' : t('tanpa harga')}
                  </span>
                </span>
                <span className="shrink-0 text-end">
                  <span className={`num block ${x.amount > 0 ? 'font-medium' : 'text-muted'}`}>{num(x.amount, 6)}</span>
                  <span className="num block text-xs text-muted">{x.usd != null ? usd(x.usd) : ''}</span>
                </span>
              </button>
              {x.custom && (
                <Button size="sm" variant="ghost" isIconOnly aria-label={t('Hapus dari daftar')} onPress={() => onRemove(x)}
                  className="-mr-2 size-7 text-muted">
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            </div>
          ))}
        </div>
      ) : <div className="p-4"><Empty title="Wallet kosong" /></div>}

      {nHal > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted">
          <span className="num">{t('{a}–{b} dari {n}', { a: dari0 + 1, b: Math.min(dari0 + PER_HAL, rows.length), n: rows.length })}</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Sebelumnya')} isDisabled={halIni === 0}
              onPress={() => setHal(halIni - 1)} className="size-7"><ChevronLeft className="size-4" /></Button>
            <span className="num min-w-10 text-center">{halIni + 1} / {nHal}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Berikutnya')} isDisabled={halIni >= nHal - 1}
              onPress={() => setHal(halIni + 1)} className="size-7"><ChevronRight className="size-4" /></Button>
          </span>
        </div>
      )}

      {/* input token manual */}
      <form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); if (isAddr(a)) tambah(); }}>
        <Input variant="secondary" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t('Tambah token: alamat 0x…')}
          aria-label={t('Alamat token')} className="mono min-w-0 flex-1 text-xs" />
        <Button type="submit" size="sm" variant="outline" className="h-9" isDisabled={!isAddr(a)} isPending={kirim}>
          <Plus className="size-4" />{t('Tambah')}
        </Button>
      </form>
    </Panel>
  );
}

// Swap manual terakhir, dari tabel txs. Baris lama (sebelum token & jumlah ikut
// dicatat) hanya punya nilai USD-nya.
const STATUS_ICON = { sukses: CircleCheck, pending: Clock, gagal: CircleX };
// Nama DEX dari Kyber datang mentah ("uniswapv3", "uniswap-v4"); rapikan yang dikenal saja.
const dexName = (s) => String(s).replace(/^uniswap-?v(\d)$/i, 'Uniswap v$1').replace(/^kyberswap.*/i, 'KyberSwap');
const STATUS_CLS = {
  sukses: 'bg-success/10 text-success', pending: 'bg-warning/10 text-warning', gagal: 'bg-danger/10 text-danger',
};

function SwapRow({ x }) {
  const { t } = useI18n();
  const d = x.detail || {};
  const st = TXSTATUS[x.status];
  const Ikon = STATUS_ICON[x.status] || Clock;
  const cls = STATUS_CLS[x.status] || 'bg-default text-muted';
  // Selisih nilai: berapa persen yang hilang (atau didapat) antara nilai masuk dan keluar.
  const selisih = d.usdIn > 0 && d.usdOut != null ? ((d.usdOut - d.usdIn) / d.usdIn) * 100 : null;
  const meta = [
    (d.usdIn != null && d.usdOut != null) ? <span key="usd" className="num">{usd(d.usdIn)} → {usd(d.usdOut)}</span>
      : (d.usdIn ?? d.usdOut) != null && <span key="usd" className="num">≈ {usd(d.usdIn ?? d.usdOut)}</span>,
    selisih != null && Math.abs(selisih) >= 0.05 && (
      <span key="pct" className={`num ${selisih < -1 ? 'text-danger' : selisih > 0 ? 'text-success' : ''}`}>{pct(selisih, 2)}</span>
    ),
    d.dex && <span key="dex" className="truncate">{t('lewat {d}', { d: dexName(d.dex) })}</span>,
    x.gasUsd != null && <span key="gas" className="num">{t('gas {v}', { v: usd(x.gasUsd, x.gasUsd < 0.01 ? 4 : 2) })}</span>,
  ].filter(Boolean);
  const Chip = () => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${cls}`}>
      <Ikon className="size-3" />{t(st?.[0] || x.status)}
    </span>
  );

  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm">
      {/* pasangan lambang: token dijual di depan, token diterima menyusul di belakangnya */}
      <span className="mt-0.5 flex shrink-0 items-center">
        <TokenIcon address={d.tokenIn} symbol={d.symbolIn} size={28} />
        <TokenIcon address={d.tokenOut} symbol={d.symbolOut} size={28} className="-ml-2" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium">
          {d.symbolIn ? (
            <>
              <span className="whitespace-nowrap"><span className="num">{num(d.amountIn, 6)}</span> <TokenSym address={d.tokenIn} symbol={d.symbolIn} /></span>
              <ArrowRight className="size-3.5 shrink-0 text-muted" />
              <span className="whitespace-nowrap">
                {d.amountOut > 0 ? <><span className="num">{num(d.amountOut, 6)}</span> </> : null}<TokenSym address={d.tokenOut} symbol={d.symbolOut} />
              </span>
            </>
          ) : <span className="num">{usd(d.usdIn)} → {usd(d.usdOut)}</span>}
        </div>
        {meta.length > 0 && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            {meta.map((m, i) => <span key={m.key} className="flex items-center gap-1.5">{i > 0 && <span aria-hidden="true">·</span>}{m}</span>)}
          </div>
        )}
        {x.status === 'gagal' && x.error && (
          <div className="mt-1 flex items-start gap-1 text-xs text-danger">
            <TriangleAlert className="mt-px size-3 shrink-0" /><span className="line-clamp-2 break-words">{x.error}</span>
          </div>
        )}
        {/* di HP: hash & waktu pindah ke bawah supaya kolom kanan tidak menyempit */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted sm:hidden">
          <Chip /><TxHash hash={x.hash} /><span aria-hidden="true">·</span><span className="tabular-nums">{ago(x.ts)}</span>
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        <Chip />
        <span className="flex items-center gap-2 text-xs text-muted">
          <TxHash hash={x.hash} /><span aria-hidden="true">·</span><span className="tabular-nums" title={new Date(x.ts).toLocaleString()}>{ago(x.ts)}</span>
        </span>
      </div>
    </div>
  );
}

function Riwayat() {
  const { t } = useI18n();
  const { data, loading } = usePoll('/api/manual/swaps', 15000);
  const list = data?.swaps || [];
  const ringkas = list.reduce((a, x) => {
    if (x.status === 'sukses') a.n += 1;
    const v = x.detail?.usdIn ?? x.detail?.usdOut;
    if (x.status === 'sukses' && v != null) a.usd += v;
    return a;
  }, { n: 0, usd: 0 });
  return (
    <Panel title="Swap terakhir" desc="Dari halaman ini maupun bot Telegram."
      action={list.length ? (
        <span className="flex items-center gap-2 text-xs text-muted">
          <Refreshing loading={loading} />
          <span className="num">{t('{n} sukses', { n: ringkas.n })}</span>
          {ringkas.usd > 0 && <><span aria-hidden="true">·</span><span className="num font-medium text-foreground">{usd(ringkas.usd)}</span></>}
          <a href="#activity" className="inline-flex items-center gap-1 text-accent hover:underline">{t('Semua')}<ChevronRight className="size-3" /></a>
        </span>
      ) : null} bodyClass="p-0">
      {list.length ? (
        <div className="divide-y divide-border">
          {list.map((x) => <SwapRow key={x.hash} x={x} />)}
        </div>
      ) : <div className="p-4"><Empty title="Belum ada swap" sub="Swap yang dikirim dari halaman ini atau bot Telegram muncul di sini." /></div>}
    </Panel>
  );
}

export default function Swap() {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [tokens, setTokens] = useState(null);
  const [harga, setHarga] = useState('muat');   // 'muat' | 'ok' | 'gagal'
  const [dari, setDari] = useState('');
  const [ke, setKe] = useState('');
  const [jumlah, setJumlah] = useState('');
  const [kutip, setKutip] = useState(null);
  const [ambil, setAmbil] = useState(false);
  const [konfirm, setKonfirm] = useState(false);
  const [kirim, setKirim] = useState(false);
  const [hasil, setHasil] = useState(null);
  const [balikKurs, setBalikKurs] = useState(false);
  const seq = useRef(0);
  const muatSeq = useRef(0);

  // Saldo dulu (cepat, langsung dari chain), harga USD menyusul — DexScreener bisa
  // lambat dan halaman tidak perlu menunggunya.
  const pasang = (list) => {
    setTokens(list);
    // Pilihan awal: aset dengan saldo terbesar, ditukar ke aset kuotasi yang BERBEDA.
    // Kalau sisi "ke" dipilih tanpa melihat sisi "dari", keduanya bisa jatuh ke token
    // yang sama (USDG punya saldo terbesar dan juga kuotasi bawaan) — halaman lalu
    // diam tanpa kutipan dan tanpa penjelasan.
    const d0 = list.find((x) => x.amount > 0)?.address || '';
    const k0 = list.find((x) => x.isQuote && x.address !== d0)?.address
      || list.find((x) => x.address !== d0)?.address || '';
    setDari((v) => v || d0);
    setKe((v) => v || k0);
  };
  const muat = async () => {
    const mine = ++muatSeq.current;
    const d = await get('/api/manual/tokens');
    if (mine !== muatSeq.current) return d.tokens || [];
    pasang(d.tokens || []);
    muatHarga(d.tokens || [], mine);
    return d.tokens || [];
  };
  // Harga menyusul lewat endpoint sendiri — tidak membaca ulang saldo, jadi RPC
  // yang sedang dibatasi tidak ikut menghapus semua harga.
  const muatHarga = async (list, mine = muatSeq.current) => {
    const addrs = list.filter((x) => x.amount > 0 || x.isQuote || x.custom).map((x) => x.address);
    if (!addrs.length) return setHarga('ok');
    setHarga('muat');
    const r = await post('/api/manual/prices', { addresses: addrs });
    if (mine !== muatSeq.current) return undefined;
    if (r.error || !r.prices) return setHarga('gagal');
    setTokens((cur) => (cur || []).map((x) => {
      if (!(x.address in r.prices)) return x;
      const priceUsd = r.prices[x.address];
      return { ...x, priceUsd, usd: priceUsd != null ? x.amount * priceUsd : null };
    }));
    return setHarga('ok');
  };
  useEffect(() => { muat(); }, []);

  const byAddr = useMemo(() => new Map((tokens || []).map((x) => [x.address, x])), [tokens]);
  const tDari = byAddr.get(dari);
  const tKe = byAddr.get(ke);
  const punya = useMemo(() => (tokens || []).filter((x) => x.amount > 0), [tokens]);
  const siap = dari && ke && dari !== ke && String(jumlah).trim() !== '';

  // Kutipan diambil sendiri setiap pilihan berubah; balasan basi dibuang.
  useEffect(() => {
    setKonfirm(false);
    if (!siap) { setKutip(null); return; }
    const mine = ++seq.current;
    setAmbil(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/swap/quote', { tokenIn: dari, tokenOut: ke, amount: jumlah });
      if (mine !== seq.current) return;
      setKutip(r); setAmbil(false);
    }, 450);
    return () => clearTimeout(id);
  }, [dari, ke, jumlah, siap]);

  const balik = () => { setDari(ke); setKe(dari); setJumlah(''); };

  // Token dari alamat yang ditempel. Yang saldonya kosong tidak bisa jadi sumber
  // swap, jadi di sisi "dari" (dan panel) ia dipasang di sisi "ke" saja.
  const impor = async (address, side) => {
    const r = await post('/api/manual/tokens/add', { address });
    if (r.error) { toast.danger(r.error); return false; }
    const list = await muat();
    const tk = list.find((x) => x.address === address);
    const sym = tk?.symbol || r.token?.symbol || short(address);
    if (side !== 'to' && tk?.amount > 0) {
      if (address === ke) setKe(dari);
      setDari(address);
      toast.success(t('{s} ditambahkan', { s: sym }));
    } else {
      if (address === dari) setDari(ke);
      setKe(address);
      toast.success(side === 'to' ? t('{s} ditambahkan', { s: sym })
        : t('{s} ditambahkan — saldonya kosong, jadi dipasang sebagai token tujuan', { s: sym }));
    }
    return true;
  };
  const hapus = async (x) => {
    await post('/api/manual/tokens/remove', { address: x.address });
    // Token yang dihapus bisa hilang dari daftar; pilihan kosong diisi ulang
    // dengan bawaan oleh muat().
    if (x.address === ke) setKe('');
    if (x.address === dari) setDari('');
    muat();
  };
  const pakai = (a) => {
    if (a === ke) setKe(dari);
    setDari(a); setJumlah('');
  };

  const tukar = async () => {
    setKirim(true);
    const r = await post('/api/manual/swap', { tokenIn: dari, tokenOut: ke, amount: jumlah });
    setKirim(false); setKonfirm(false);
    if (r.error) return toast.danger(r.error);
    setHasil(r);
    toast.success(t('Swap selesai'));
    muat(); reloadStatus();
  };

  const dry = status?.mode?.dry_run !== false;
  const header = <PageHeader group="Aksi" title="Swap"
    desc="Menukar aset lewat agregator Kyber — rute yang sama dipakai bot untuk zap dan menjual memecoin sisa." />;

  if (tokens === null) return (<>{header}<Loading /></>);

  if (hasil) {
    return (
      <>
        {header}
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t('Swap selesai')}</div>
              <div className="mt-1 text-muted">{hasil.note}</div>
              {hasil.dex && <div className="text-sm text-muted">{t('lewat {d}', { d: hasil.dex })}</div>}
              <div className="mono mt-2 text-sm text-muted">{hasil.tx}</div>
            </div>
            <Button variant="outline" onPress={() => { setHasil(null); setJumlah(''); }}>{t('Tukar lagi')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  // Tidak ada satu pun aset bersaldo: kartu swap-nya tidak bisa dipakai sama sekali,
  // jadi lebih jujur menjelaskan kenapa daripada memajang field kosong.
  if (!punya.length) {
    return (
      <>
        {header}
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <div>
              <div className="font-medium">{t('Belum ada aset yang bisa ditukar')}</div>
              <p className="mt-1 text-sm text-muted">
                {t('Wallet bot kosong. Isi dengan ETH atau USDG dulu — alamatnya ada di Pengaturan.')}
              </p>
            </div>
            <Button variant="outline" onPress={() => { location.hash = 'settings'; }}>{t('Buka Pengaturan')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  const usdIn = kutip && !kutip.error ? kutip.usdIn : (tDari?.priceUsd != null && Number(jumlah) > 0 ? Number(jumlah) * tDari.priceUsd : null);
  const kurs = kutip && !kutip.error && kutip.amountIn > 0 && kutip.amountOut > 0
    ? (balikKurs ? `1 ${kutip.symbolOut} = ${num(kutip.amountIn / kutip.amountOut, 6)} ${kutip.symbolIn}`
      : `1 ${kutip.symbolIn} = ${num(kutip.amountOut / kutip.amountIn, 6)} ${kutip.symbolOut}`)
    : null;
  const minOut = kutip && !kutip.error && kutip.slippageBps != null ? kutip.amountOut * (1 - kutip.slippageBps / 10000) : null;

  return (
    <>
      {header}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] xl:gap-6">
        {/* kolom kiri: kartu swap */}
        <div className="flex min-w-0 flex-col gap-3">
          {dry && (
            <Notice status="warning" title={t('Mode simulasi')}>
              {t('Kutipan tetap diambil, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau menukar.')}
            </Notice>
          )}

          <Card className="gap-0! p-2!">
            {/* dari */}
            <div className="rounded-md bg-default/50 p-4">
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span className="font-medium">{t('Dari')}</span>
                {tDari && <span>{t('Saldo')} <span className="num">{num(tDari.amount, 6)}</span></span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <input value={jumlah} onChange={(e) => setJumlah(e.target.value)} placeholder="0" inputMode="decimal"
                  aria-label={t('Jumlah yang ditukar')}
                  className="num h-10 min-w-0 flex-1 bg-transparent text-[1.75rem] font-semibold tracking-tight outline-none placeholder:text-muted/60" />
                <TokenPicker side="from" value={dari} onChange={setDari} list={punya} all={tokens} exclude={ke} onImport={impor} />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="num text-xs text-muted">{usdIn != null ? `≈ ${usd(usdIn)}` : ''}</span>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {PORSI.map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setJumlah(v)}
                      className={`h-6 rounded-md border px-2 text-xs font-medium transition-colors ${jumlah === v
                        ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-foreground'}`}>{t(label)}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* pembalik */}
            <div className="relative z-10 -my-2.5 flex justify-center">
              <Button size="sm" variant="outline" isIconOnly aria-label={t('Balik arah')} onPress={balik}
                isDisabled={!(tKe?.amount > 0)}
                className="size-9 rounded-lg! border-4! border-surface! bg-default">
                <ArrowDownUp className="size-4" />
              </Button>
            </div>

            {/* ke */}
            <div className="rounded-md bg-default/50 p-4">
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span className="font-medium">{t('Ke')}</span>
                {tKe && <span>{t('Saldo')} <span className="num">{num(tKe.amount, 6)}</span></span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className={`num flex h-10 min-w-0 flex-1 items-center truncate text-[1.75rem] font-semibold tracking-tight ${kutip?.amountOut != null ? '' : 'text-muted/60'}`}>
                  {ambil ? <Spinner size="sm" /> : kutip?.amountOut != null ? num(kutip.amountOut, 6) : '0'}
                </div>
                <TokenPicker side="to" value={ke} onChange={setKe} list={tokens} all={tokens} exclude={dari} onImport={impor} />
              </div>
              <div className="num mt-3 h-4 text-xs text-muted">{kutip?.usdOut != null && !ambil ? `≈ ${usd(kutip.usdOut)}` : ''}</div>
            </div>
          </Card>

          {siap && kutip?.error && <Notice status="danger" title={t('Tidak bisa dikutip')}>{kutip.error}</Notice>}

          {kutip && !kutip.error && (
            <Card className="gap-0! px-4! py-1.5!">
              <div className="divide-y divide-border">
                {kurs && (
                  <KV label="Kurs">
                    <button type="button" onClick={() => setBalikKurs((v) => !v)} title={t('Balik kurs')}
                      className="inline-flex items-center gap-1 hover:text-accent">{kurs}<ArrowDownUp className="size-3 text-muted" /></button>
                  </KV>
                )}
                <KV label="Dikirim">{num(kutip.amountIn, 6)} {kutip.symbolIn}</KV>
                <KV label="Diterima">{num(kutip.amountOut, 6)} {kutip.symbolOut}</KV>
                {minOut != null && (
                  <KV label="Minimal diterima">
                    {num(minOut, 6)} {kutip.symbolOut}
                    <span className="font-normal text-muted"> · {t('slippage {p}%', { p: num(kutip.slippageBps / 100, 2) })}</span>
                  </KV>
                )}
                <KV label="Nilai">{usd(kutip.usdIn)} → {usd(kutip.usdOut)}</KV>
                <KV label="Biaya rute"><span className={kutip.tooLossy ? 'text-danger' : kutip.lossBps > 300 ? 'text-warning' : ''}>
                  {kutip.lossBps != null ? `${num(kutip.lossBps / 100, 2)}%` : '—'}</span></KV>
                {kutip.dex && <KV label="Lewat"><span className="font-normal text-muted">{kutip.dex}</span></KV>}
              </div>
            </Card>
          )}

          {kutip?.tooLossy && (
            <div className="flex items-start gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{t('Rute ini rugi {a}%, di atas batas {b}%. Kecilkan jumlahnya, atau naikkan batas di Aturan → Keluar posisi.', {
                a: num(kutip.lossBps / 100, 1), b: num(kutip.maxLossBps / 100, 1),
              })}</span>
            </div>
          )}

          {dry ? (
            <Button size="lg" variant="outline" className="w-full" onPress={() => { location.hash = 'settings'; }}>{t('Nyalakan LIVE dulu')}</Button>
          ) : !konfirm ? (
            <Button size="lg" className="w-full" isDisabled={!kutip || !!kutip.error || kutip.tooLossy} onPress={() => setKonfirm(true)}>
              {t('Tukar')}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
              <div className="text-sm text-muted">
                {num(kutip.amountIn, 6)} {kutip.symbolIn} → ±{num(kutip.amountOut, 6)} {kutip.symbolOut}
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" onPress={tukar} isPending={kirim}>{t('Ya, tukar sekarang')}</Button>
                <Button variant="outline" onPress={() => setKonfirm(false)}>{t('Batal')}</Button>
              </div>
            </div>
          )}
        </div>

        {/* kolom kanan: saldo + riwayat */}
        <div className="flex min-w-0 flex-col gap-4">
          <Holdings tokens={tokens} dari={dari} onUse={pakai} onRemove={hapus} onImport={impor}
            harga={harga} onRetryHarga={() => muatHarga(tokens || [])} />
          <Riwayat />
        </div>
      </div>
    </>
  );
}
