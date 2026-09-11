import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, toast } from '@heroui/react';
import { Search, Check, TriangleAlert, Anchor, ArrowRight } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Notice, PriceRange, Empty, KV } from '../components/ui';
import TokenIcon, { TokenPair } from '../components/TokenIcon';
import { usd, num, ago, price, tickPrice, locale } from '../fmt';
import { useI18n } from '../i18n';

// Pilihan cepat rentang: [turun %, naik %, label]. Persennya dalam harga, jadi
// "±50%" benar-benar setengah turun dan setengah naik; "½× – 2×" adalah rentang yang
// dulu tertulis ±100% (dalam tick simetris, dalam harga tidak).
const PRESET = [[5, 5, '±5%'], [10, 10, '±10%'], [25, 25, '±25%'], [50, 50, '±50%'], [50, 100, '½× – 2×']];

// Teks rentang untuk ringkasan & konfirmasi.
const fmtPct = (v) => num(Number(v), 2);
const rentangLabel = (lo, up, full, t) => (full ? t('seluruh rentang')
  : Number(lo) === Number(up) ? `±${fmtPct(lo)}%` : `−${fmtPct(lo)}% / +${fmtPct(up)}%`);

// Satu kotak batas: tanda di depan, persen di belakang, harga hasilnya di bawah.
function Batas({ label, tanda, value, onChange, harga, sym, invalid, disabled, aria }) {
  const { t } = useI18n();
  return (
    <label className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border p-3 transition-colors
      ${invalid ? 'border-danger/60' : 'border-border focus-within:border-accent'} ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-muted">{t(label)}</span>
      <span className="flex items-baseline gap-1">
        <span className="num text-lg font-semibold text-muted">{tanda}</span>
        <input value={value} disabled={disabled} inputMode="decimal" aria-label={t(aria)} placeholder="0"
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
          className="num w-full min-w-0 bg-transparent text-lg font-semibold outline-none placeholder:text-muted/60" />
        <span className="text-lg text-muted">%</span>
      </span>
      <span className="num h-4 truncate text-xs text-muted">{harga != null ? `≈ ${price(harga)}${sym ? ' ' + sym : ''}` : ''}</span>
    </label>
  );
}

// Tombol pilihan cepat. Dipakai untuk nominal dan lebar rentang — keduanya hampir
// selalu diisi dari beberapa nilai yang itu-itu saja, jadi mengetik itu kerja sia-sia.
function Chips({ options, value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" onClick={() => onPick(v)} aria-pressed={value === v}
          className={`num h-8 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors ${value === v
            ? 'border-accent bg-accent/10 text-accent' : 'border-border text-foreground hover:bg-default/60'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Langkah({ n, title, done, children, action }) {
  const { t } = useI18n();
  return (
    <Card className="gap-0! p-0!">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${done ? 'bg-success text-success-foreground' : 'border border-border text-muted'}`}>
            {done ? <Check className="size-3" strokeWidth={3} /> : n}
          </span>
          <h2 className="text-sm font-semibold">{t(title)}</h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

const fee = (p) => (p.dynamicFee ? 'dinamis' : `${num(p.feePct, 2)}%`);

// Jumlah token: memecoin bisa jutaan, ETH bisa 0,0000x — desimal tetap tidak cocok
// untuk keduanya, jadi di bawah 1 memakai angka penting.
const jml = (v) => (v == null ? '—' : v === 0 ? '0' : Math.abs(v) >= 1 ? num(v, Math.abs(v) >= 1000 ? 0 : 4)
  : Number(v).toLocaleString(locale(), { maximumSignificantDigits: 4 }));

// Saldo wallet yang relevan: kas (ETH/USDG/WETH) dan token pasangan pool. Kolom
// "Setelah dibuka" muncul begitu pratinjau untuk pool ini selesai dihitung.
function Saldo({ saldo, pool }) {
  const { t } = useI18n();
  if (!saldo) return null;
  if (saldo.wallet === false) return <p className="text-xs text-muted">{t('Belum ada wallet — saldo tidak bisa dibaca.')}</p>;
  const milikPool = (a) => pool && (a === pool.token0?.toLowerCase() || a === pool.token1?.toLowerCase());
  const rows = saldo.tokens.filter((x) => x.amount > 0 || x.native || milikPool(x.token) || x.sesudah > 0);
  const setelah = rows.some((x) => x.sesudah != null);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Saldo wallet')}</span>
        <span>{t('Kas')} <span className="num font-semibold text-foreground">{usd(saldo.kasUsd)}</span></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {setelah && (
            <thead>
              <tr className="text-[0.6875rem] text-muted">
                <th className="px-3 pt-2 text-start font-normal">{t('Token')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Sekarang')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Setelah dibuka')}</th>
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((x) => (
              <tr key={x.token}>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-2">
                    <TokenIcon address={x.token} symbol={x.symbol} size={18} />
                    <span className="font-medium">{x.symbol}</span>
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-end">
                  {jml(x.amount)}
                  <span className="ms-1.5 text-xs text-muted">{x.usd != null ? usd(x.usd) : ''}</span>
                </td>
                {setelah && (
                  <td className="num px-3 py-1.5 text-end text-muted">
                    ≈ {jml(x.sesudah)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        {t('{e} ETH ditahan untuk gas dan tidak ikut dipakai.', { e: num(saldo.gasReserveEth, 4) })}
      </p>
    </div>
  );
}

const jmlSwap = (n, t) => (!n ? t('tidak perlu') : n === 1 ? t('1 transaksi') : t('{n} transaksi', { n }));

const JENIS = {
  zap: 'Beli {s}',
  jembatan: 'Jembatan kas',
  bungkus: 'Bungkus ETH',
  buka_bungkus: 'Buka bungkus WETH',
};

// Rincian tukar yang akan dijalankan bot sebelum mint, dari simulasi di server
// (manual.simulasiSwap) — urutan dan jumlahnya sama dengan executeEntry.
function AutoSwap({ p }) {
  const { t } = useI18n();
  const sw = p.swaps || [];
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Auto-swap sebelum mint')}</span>
        <span>{jmlSwap(sw.length, t)}</span>
      </div>
      {!sw.length ? (
        <p className="px-3 py-2.5 text-sm text-muted">
          {t('Tidak ada yang ditukar — saldo {a} dan {b} sudah cukup untuk posisi ini.', { a: p.symbol0, b: p.symbol1 })}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {sw.map((s, i) => (
            <li key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="flex size-4 items-center justify-center rounded-full border border-border text-[0.625rem]">{i + 1}</span>
                <span className="font-medium text-foreground">{t(JENIS[s.jenis] || s.jenis, { s: s.ke.symbol })}</span>
                {s.jenis === 'zap' || s.jenis === 'jembatan' ? <span>· Kyber</span> : <span>· {t('1:1, tanpa slippage')}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5">
                  <TokenIcon address={s.dari.token} symbol={s.dari.symbol} size={16} />
                  <span className="num font-medium">{s.taksiran ? '≈ ' : ''}{jml(s.dari.amount)} {s.dari.symbol}</span>
                </span>
                <ArrowRight className="size-3.5 text-muted" />
                <span className="flex items-center gap-1.5">
                  <TokenIcon address={s.ke.token} symbol={s.ke.symbol} size={16} />
                  <span className="num font-medium">{jml(s.ke.amount)} {s.ke.symbol}</span>
                </span>
                {s.dari.usd != null && <span className="num text-xs text-muted">{usd(s.dari.usd)}</span>}
              </div>
              {s.maxLossBps != null && (
                <div className="text-xs text-muted">
                  {t('dibatalkan kalau rugi rute lebih dari {r}%', { r: num(s.maxLossBps / 100, 2) })}
                  {s.taksiran ? ' · ' + t('jumlah pasti dari kutipan Kyber saat eksekusi') : ''}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!!sw.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          {p.swapOn
            ? t('Jumlah yang dijual sudah termasuk ruang slippage {s}%; kelebihannya tetap di wallet.', { s: num(p.slippageBps / 100, 2) })
            : <span className="text-danger">{t('Auto-swap dimatikan di Aturan — pembukaan akan berhenti di langkah pertama.')}</span>}
        </p>
      )}
    </div>
  );
}

function PilihPool({ pools, onPick }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [scan, setScan] = useState(null);     // hasil pindai dari alamat token
  const [semua, setSemua] = useState(false);
  const timer = useRef(null);
  const token = q.trim().toLowerCase();
  const isAlamat = /^0x[0-9a-f]{40}$/.test(token);
  useEffect(() => () => clearInterval(timer.current), []);

  const ambil = async (tok, all) => {
    const d = await get(`/api/manual/pools/scan?token=${tok}${all ? '&all=1' : ''}`);
    setScan({ token: tok, ...d });
    return d;
  };
  const pindai = async () => {
    setScan({ token, status: 'jalan', progress: 0 });
    const r = await post('/api/manual/pools/scan', { token });
    if (r.error) return setScan({ token, status: 'gagal', error: r.error });
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const d = await ambil(token, semua);
      if (d.status !== 'jalan') clearInterval(timer.current);
    }, 1500);
  };
  const gantiSemua = (v) => { setSemua(v); if (scan?.token) ambil(scan.token, v); };

  // Hasil pindai menggantikan daftar hanya selagi kotak cari masih berisi alamat itu.
  const pakaiScan = isAlamat && scan?.token === token && scan.status === 'selesai';
  const hasil = useMemo(() => {
    if (pakaiScan) return scan.pools || [];
    const n = q.trim().toLowerCase();
    return n ? pools.filter((p) => p.pair.toLowerCase().includes(n)) : pools;
  }, [pools, q, pakaiScan, scan]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cari pasangan, atau tempel alamat token')}
          className="h-9 w-full rounded-md border border-field-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent" />
      </div>

      {/* Alamat token: pool-nya dicari langsung dari chain, bukan dari yang sudah dikenal. */}
      {isAlamat && (!scan || scan.token !== token) && (
        <Button size="sm" onPress={pindai}>{t('Cari pool untuk token ini')}</Button>
      )}
      {scan?.token === token && scan.status === 'jalan' && (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{t('Mencari pool di chain… {p}%', { p: scan.progress || 0 })}</div>
      )}
      {scan?.token === token && scan.status === 'gagal' && (
        <Notice status="danger" title={t('Pemindaian gagal')}>{scan.error}</Notice>
      )}
      {pakaiScan && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <span>{t('{n} pool bisa dimasuki dari {total} yang ada', { n: (scan.pools || []).length, total: scan.total })}</span>
          {!!scan.hidden && (
            <button type="button" className="underline underline-offset-2" onClick={() => gantiSemua(!semua)}>
              {semua ? t('Sembunyikan yang kosong') : t('Tampilkan semua')}
            </button>
          )}
        </div>
      )}
      {pakaiScan && !!scan.hidden && !semua && (
        <p className="text-xs text-muted">
          {t('Yang disembunyikan: pool tanpa likuiditas, berfee dinamis, atau tidak dipasangkan USDG/ETH — masuk ke sana sama saja membuang gas.')}
        </p>
      )}

      <div className="max-h-80 overflow-y-auto rounded-md border border-border">
        {!hasil.length ? (
          <div>
            <Empty title={isAlamat ? 'Tidak ada pool Uniswap v3/v4 yang bisa dimasuki' : 'Tidak ada pool yang cocok'}
              sub={isAlamat ? 'Token ini belum punya pool dengan likuiditas yang dipasangkan USDG atau ETH.' : 'Tempel alamat token untuk mencari poolnya langsung dari chain.'} />
            {pakaiScan && scan.lainnya?.length > 0 && (
              <div className="border-t border-border px-3 py-3 text-sm">
                <div className="mb-1.5 font-medium">{t('Diperdagangkan di tempat lain')}</div>
                {scan.lainnya.map((x) => (
                  <div key={x.address || x.name} className="flex justify-between gap-3 py-0.5 text-muted">
                    <span className="truncate"><span className="text-foreground">{x.dex}</span> · {x.name}</span>
                    <span className="num shrink-0">{usd(x.reserveUsd, 0)}</span>
                  </div>
                ))}
                <p className="mt-2 text-xs text-muted">{t('Bot hanya bisa membuka LP di Uniswap v3/v4 (likuiditas terkonsentrasi dengan rentang harga). Pool gaya v2 tidak punya rentang maupun NFT posisi.')}</p>
              </div>
            )}
          </div>
        ) : hasil.map((p) => (
          <button key={p.poolRef} type="button" onClick={() => onPick(p)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-0 hover:bg-default/50">
            <span className="flex min-w-0 items-center gap-2.5">
              <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
              <span className="truncate font-medium">{p.pair}</span>
              <span className="text-[0.6875rem] text-muted uppercase">{p.venue}</span>
              {p.hasHooks && <Anchor className="size-3.5 shrink-0 text-warning" aria-label={t('pool memakai hook')} />}
            </span>
            <span className="flex shrink-0 items-center gap-4 text-xs text-muted">
              <span className="num w-12 text-end">{fee(p)}</span>
              <span className="hidden w-20 text-end sm:inline">{p.kosong === true ? t('kosong') : p.lastTs ? ago(p.lastTs) : '—'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ManualLp() {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [pools, setPools] = useState(null);
  const [rules, setRules] = useState(null);
  const [pool, setPool] = useState(null);
  const [gantiPool, setGantiPool] = useState(false);
  const [nominal, setNominal] = useState('');
  const [turun, setTurun] = useState('25');
  const [naik, setNaik] = useState('25');
  const [full, setFull] = useState(false);
  const [plan, setPlan] = useState(null);      // { preview, warnings } | { error }
  const [hitung, setHitung] = useState(false);
  const [konfirm, setKonfirm] = useState(false);
  const [kirim, setKirim] = useState(false);
  const [hasil, setHasil] = useState(null);
  const [saldo, setSaldo] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    get('/api/manual/pools?limit=200').then((d) => setPools(d.pools || []));
    get('/api/rules').then(setRules);
  }, []);

  // Saldo dibaca sendiri, tidak menunggu pratinjau: pengguna perlu tahu kasnya
  // SEBELUM memilih nominal. Dibaca ulang saat pool berganti (token pasangannya
  // ikut ditampilkan) dan setelah posisi dibuka.
  const muatSaldo = useCallback(async (ref) => {
    const d = await get(`/api/manual/saldo${ref ? `?poolRef=${ref}` : ''}`);
    if (!d.error) setSaldo({ ...d, _ref: ref || null });
  }, []);
  useEffect(() => { muatSaldo(pool?.poolRef); }, [pool?.poolRef, muatSaldo]);

  const usdNum = Number(String(nominal).replace(',', '.'));
  const lo = Number(String(turun).replace(',', '.') || 0), up = Number(String(naik).replace(',', '.') || 0);
  const loBad = !full && !(lo >= 0 && lo < 100);
  const upBad = !full && !(up >= 0 && up <= 100000);
  const kosong = !full && lo === 0 && up === 0;
  const rentangOk = full || (!loBad && !upBad && !kosong);
  const siap = !!pool && Number.isFinite(usdNum) && usdNum > 0 && rentangOk;
  const body = { poolRef: pool?.poolRef, usd: usdNum, ...(full ? { full: true } : { lowerPct: lo, upperPct: up }) };

  // Pratinjau dihitung ulang sendiri setiap pilihan berubah — tidak ada tombol
  // "hitung". Balasan yang datang terlambat dibuang lewat nomor urut.
  useEffect(() => {
    setKonfirm(false);
    if (!siap) { setPlan(null); return; }
    const mine = ++seq.current;
    setHitung(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/lp/plan', body);
      if (mine !== seq.current) return;
      setPlan({ ...r, _ref: body.poolRef }); setHitung(false);
    }, 350);
    return () => { clearTimeout(id); };
  }, [pool?.poolRef, usdNum, lo, up, full, siap]);

  const kas = plan?.preview?.kasUsd ?? saldo?.kasUsd ?? null;
  // Nominal terbesar yang masih lolos semua batas — supaya tombol "Maks" tidak
  // mengantar ke penolakan.
  const maks = useMemo(() => {
    const s = rules?.rules?.sizing;
    if (!s) return null;
    const sisaTotal = s.max_total_exposure_usd - (status?.summary?.exposureUsd || 0);
    const batas = [s.max_quote_per_position_usd, sisaTotal, kas ?? Infinity].filter((x) => Number.isFinite(x));
    const v = Math.floor(Math.min(...batas) * 100) / 100;
    return v > 0 ? v : 0;
  }, [rules, status, kas]);

  const buka = async () => {
    setKirim(true);
    const r = await post('/api/manual/lp/open', body);
    setKirim(false); setKonfirm(false);
    if (r.error) return toast.danger(r.error);
    setHasil(r);
    toast.success(t('Posisi dibuka'));
    reloadStatus();
    muatSaldo(pool?.poolRef);
  };

  const p = plan?.preview;
  // Harga kini (dalam aset kuotasi) dari pratinjau terakhir UNTUK POOL INI — dipakai
  // menampilkan harga tiap batas selagi pengguna mengetik, sebelum pratinjau baru datang.
  const pKini = p && plan._ref === pool?.poolRef ? p : null;
  const hargaKini = pKini ? tickPrice(pKini.curTick, pKini.dec0, pKini.dec1, pKini.quoteSide) : null;
  const symQ = pKini ? (pKini.quoteSide === 0 ? pKini.symbol0 : pKini.symbol1) : null;
  // Pratinjau membawa saldo "setelah dibuka"; selama belum ada, pakai bacaan
  // sendiri — asal untuk pool yang sama, supaya token pasangannya tidak salah.
  const pSiap = pKini && siap && !plan?.error ? pKini : null;
  const saldoTampil = pSiap?.saldo || (saldo && saldo._ref === (pool?.poolRef || null) ? saldo : null);
  const dry = status?.mode?.dry_run !== false;

  if (hasil) {
    return (
      <>
        <PageHeader group="Aksi" title="LP manual" />
        <Card>
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t('Posisi dibuka')}</div>
              <div className="mt-1 text-muted">{hasil.note}</div>
              <div className="mono mt-2 text-sm text-muted">{hasil.tx}</div>
            </div>
            <div className="flex gap-2">
              <Button onPress={() => { location.hash = 'posisi'; }}>{t('Lihat posisi')}</Button>
              <Button variant="outline" onPress={() => { setHasil(null); setNominal(''); }}>{t('Buka satu lagi')}</Button>
            </div>
          </Card.Content>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader group="Aksi" title="LP manual"
        desc="Membuka posisi sendiri, di luar penyalinan target. Jalur eksekusinya sama: kas dijembatani, token ditukar seperlunya, lalu mint." />

      {dry && (
        <Notice status="warning" title={t('Mode simulasi')}>
          {t('Pratinjau tetap dihitung, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau membuka posisi.')}
        </Notice>
      )}

      <div className="mt-4 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <Langkah n={1} title="Pilih pool" done={!!pool}
            action={pool && !gantiPool ? <Button size="sm" variant="outline" onPress={() => setGantiPool(true)}>{t('Ganti')}</Button> : null}>
            {pools === null ? <Spinner /> : pool && !gantiPool ? (
              <div className="flex items-center gap-3">
                <TokenPair token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} size={30} />
                <div className="min-w-0">
                  <div className="text-base font-semibold">{pool.pair}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <span className="uppercase">{pool.venue}</span><span>·</span>
                    <span>{pool.dynamicFee ? t('fee dinamis') : t('fee {p}%', { p: num(pool.feePct, 2) })}</span><span>·</span>
                    {pool.hasHooks && <><span className="text-warning">{t('pakai hook')}</span><span>·</span></>}
                    <span>{pool.lastTs ? t('aksi terakhir {a}', { a: ago(pool.lastTs) }) : t('belum ada aksi terpantau')}</span>
                  </div>
                </div>
              </div>
            ) : (
              <PilihPool pools={pools} onPick={(x) => { setPool(x); setGantiPool(false); }} />
            )}
          </Langkah>

          <Langkah n={2} title="Nominal" done={siap}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xl text-muted">$</span>
                <input value={nominal} onChange={(e) => setNominal(e.target.value.replace(/[^\d.,]/g, ''))}
                  inputMode="decimal" placeholder="0" aria-label={t('Nominal posisi')}
                  className="num h-11 w-44 rounded-md border border-field-border bg-surface px-3 text-xl font-semibold outline-none focus:border-accent" />
              </div>
              {/* "Maks" dihitung dari batas yang benar-benar berlaku, jadi menekannya
                  tidak pernah mengantar ke penolakan. Nilai yang kebetulan sama
                  dengan salah satu pilihan cepat dibuang supaya tidak dobel. */}
              <Chips value={usdNum} onPick={(v) => setNominal(String(v))}
                options={[25, 50, 100, 200].filter((v) => !maks || v < maks).map((v) => [v, `$${v}`])
                  .concat(maks > 0 ? [[maks, t('Maks {v}', { v: usd(maks, 0) })]] : [])} />
              <p className="text-xs text-muted">
                {t('Nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.')}
              </p>
              <Saldo saldo={saldoTampil} pool={pool} />
              {pSiap?.swaps && <AutoSwap p={pSiap} />}
            </div>
          </Langkah>

          <Langkah n={3} title="Rentang harga" done={siap}>
            <div className="flex flex-col gap-3">
              <Chips value={full ? 'full' : PRESET.find(([a, b]) => a === lo && b === up)?.[2]}
                onPick={(v) => {
                  if (v === 'full') return setFull(true);
                  const [a, b] = PRESET.find((x) => x[2] === v);
                  setFull(false); setTurun(String(a)); setNaik(String(b));
                }}
                options={[...PRESET.map(([, , l]) => [l, l]), ['full', t('Seluruh rentang')]]} />
              {/* Batas bebas: mengetik di salah satu kotak otomatis keluar dari "seluruh rentang". */}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Batas label="Batas bawah" aria="Turun sampai (persen)" tanda="−" value={full ? '' : turun} disabled={false}
                  onChange={(v) => { setFull(false); setTurun(v); }} invalid={loBad}
                  harga={hargaKini != null && !full && !loBad ? hargaKini * (1 - lo / 100) : null} sym={symQ} />
                <Batas label="Batas atas" aria="Naik sampai (persen)" tanda="+" value={full ? '' : naik} disabled={false}
                  onChange={(v) => { setFull(false); setNaik(v); }} invalid={upBad}
                  harga={hargaKini != null && !full && !upBad ? hargaKini * (1 + up / 100) : null} sym={symQ} />
              </div>
              {(loBad || upBad || kosong) && (
                <p className="text-xs text-danger">{t(loBad ? 'Batas bawah harus 0 sampai di bawah 100% — turun 100% berarti harga nol.'
                  : upBad ? 'Batas atas maksimal 100.000%.' : 'Isi batas bawah atau batas atas.')}</p>
              )}
              {!full && p && !plan?.error && (Math.abs(p.lowerPct - lo) >= 0.05 || Math.abs(p.upperPct - up) >= 0.05) && (
                <p className="text-xs text-muted">{t('Dibulatkan ke tick pool: −{a}% / +{b}%.', { a: num(p.lowerPct, 2), b: num(p.upperPct, 2) })}</p>
              )}
              <p className="text-xs text-muted">
                {t('Fee hanya mengalir selama harga ada di dalam rentang. Sempit = fee lebih besar tapi lebih cepat keluar; lebar = lebih aman tapi encer.')}
              </p>
              {p && (
                <div className="rounded-md border border-border p-3">
                  <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1}
                    quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />
                </div>
              )}
            </div>
          </Langkah>
        </div>

        {/* pratinjau */}
        <Card className="gap-0! p-0! lg:sticky lg:top-4">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{t('Pratinjau')}</h2>
            {hitung && <Spinner size="sm" />}
          </div>
          <div className="flex flex-col gap-4 p-4">
            {!siap ? (
              <p className="text-sm text-muted">{t('Pilih pool dan isi nominalnya — pratinjau muncul sendiri.')}</p>
            ) : plan?.error ? (
              <Notice status="danger" title={t('Belum bisa dibuka')}>{plan.error}</Notice>
            ) : !p ? <Spinner /> : (
              <>
                <div>
                  <div className="text-xs text-muted">{t('Nilai posisi')}</div>
                  <div className="num text-[1.5rem] leading-tight font-semibold tracking-tight">{usd(p.valueUsd)}</div>
                </div>
                <div className="divide-y divide-border border-y border-border">
                  <KV label={p.symbol0}>{num(Number(p.amount0) / 10 ** p.dec0, 6)}</KV>
                  <KV label={p.symbol1}>{num(Number(p.amount1) / 10 ** p.dec1, 6)}</KV>
                  {p.swaps && <KV label="Auto-swap">{jmlSwap(p.swaps.length, t)}</KV>}
                  <KV label="Kas setelah dibuka">{usd(Math.max(0, p.kasUsd - p.valueUsd))}</KV>
                </div>

                {(plan.warnings || []).map((w) => (
                  <div key={w} className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-sm text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{w}</span>
                  </div>
                ))}

                <p className="text-xs text-muted">
                  {t('Posisi ini tidak mencermin siapa pun — ia tidak akan ikut ditutup saat target keluar.')}
                </p>

                {/* Di mode simulasi tombolnya TIDAK dimatikan begitu saja: tombol mati
                    tanpa jalan keluar cuma bikin user menebak. Ia berubah jadi jalan
                    pintas ke tempat yang bisa mengubah keadaannya. */}
                {dry ? (
                  <Button variant="outline" className="w-full" onPress={() => { location.hash = 'pengaturan'; }}>
                    {t('Nyalakan LIVE dulu')}
                  </Button>
                ) : !konfirm ? (
                  <Button className="w-full" onPress={() => setKonfirm(true)}>
                    {t('Buka posisi {v}', { v: usd(p.valueUsd) })}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
                    <div className="text-sm text-muted">{t('{v} ke {pair}, rentang {r}.', { v: usd(p.valueUsd), pair: p.pair, r: rentangLabel(lo, up, full, t) })}</div>
                    <div className="flex gap-2">
                      <Button className="flex-1" onPress={buka} isPending={kirim}>{t('Ya, buka sekarang')}</Button>
                      <Button variant="outline" onPress={() => setKonfirm(false)}>{t('Batal')}</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
